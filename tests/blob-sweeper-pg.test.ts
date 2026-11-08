// The blob sweeper on the real tables (FOL-126): marks and runs in Postgres,
// the roots from workspace_revisions and blob_pins, the pin lock on delete,
// the orphan-history cleanup, and the scheduled job's switches. DB-gated.
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { takeTurnsOnLiveDb } from "./live-db-lock.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
takeTurnsOnLiveDb(url);

if (!url) {
  test("the blob sweeper on Postgres (set FOLDRUN_TEST_DATABASE_URL to run)", { skip: "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" }, () => {});
} else {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  const T = `swp${Date.now().toString(36)}`;
  let root: string;
  let n = 0;
  let W: string;
  type M = {
    sweeper: typeof import("../../foldrun-core/src/blob-sweeper.ts");
    blob: typeof import("../../foldrun-core/src/blob-store.ts");
    publish: typeof import("../../foldrun-core/src/publish.ts");
    manifest: typeof import("../../foldrun-core/src/manifest.ts");
    wr: typeof import("../../foldrun-core/src/workspace-revisions.ts");
    store: typeof import("../../foldrun-core/src/store.ts");
    rev: typeof import("../src/revision-store-pg.ts");
    pins: typeof import("../src/blob-pins.ts");
    marks: typeof import("../src/sweep-marks-pg.ts");
    job: typeof import("../src/blob-sweep-job.ts");
    db: typeof import("../src/db.ts");
  };
  let m: M;
  before(async () => {
    m = {
      sweeper: await import("../../foldrun-core/src/blob-sweeper.ts"),
      blob: await import("../../foldrun-core/src/blob-store.ts"),
      publish: await import("../../foldrun-core/src/publish.ts"),
      manifest: await import("../../foldrun-core/src/manifest.ts"),
      wr: await import("../../foldrun-core/src/workspace-revisions.ts"),
      store: await import("../../foldrun-core/src/store.ts"),
      rev: await import("../src/revision-store-pg.ts"),
      pins: await import("../src/blob-pins.ts"),
      marks: await import("../src/sweep-marks-pg.ts"),
      job: await import("../src/blob-sweep-job.ts"),
      db: await import("../src/db.ts"),
    };
    await m.db.migrate();
  });
  after(async () => {
    await m.db.db()?.end();
  });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-swpg-"));
    process.env.FOLDRUN_DATA = root;
    W = `desk${++n}`;
  });
  afterEach(async () => {
    m.wr.setRevisionBackend(null);
    m.wr.resetJournalForTests();
    await m.rev.pgRevisionStore().drop({ tenant: T });
    await m.db.db()!.query(`DELETE FROM blob_sweep_marks WHERE tenant=$1`, [T]);
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.FOLDRUN_DATA;
  });

  const deps = () => ({ blobs: m.blob.fsBlobStore(path.join(root, ".objects")), revisions: m.rev.pgRevisionStore(), pins: m.pins.pgBlobPins() });
  async function put(d: ReturnType<typeof deps>, files: Record<string, string | null>, ws = { tenant: T, workspace: W }) {
    const heads = await m.publish.headsOf(d, ws);
    const cur = await m.publish.manifestsAt(d, ws.tenant, heads);
    const bytes = new Map<string, Buffer>();
    const changes: Record<string, any> = {};
    for (const [p, v] of Object.entries(files)) {
      const was = cur.authored.files[p] ?? cur.state.files[p];
      if (v === null) {
        changes[p] = { op: "delete", base: m.manifest.entryId(was) };
        continue;
      }
      const buf = Buffer.from(v);
      bytes.set(m.manifest.sha256Hex(buf), buf);
      changes[p] = { op: "put", base: was ? m.manifest.entryId(was) : null, sha: m.manifest.sha256Hex(buf), size: buf.length, mode: m.manifest.MODE_FILE };
    }
    return m.publish.publish(d, { ws, opId: `swpg-${Math.random().toString(36).slice(2, 12)}`, by: "t", message: "m", changes, bytesOf: async (s) => bytes.get(s)! });
  }
  const key = (text: string) => m.manifest.blobObjectKey(T, m.manifest.sha256Hex(Buffer.from(text)));
  const exists = async (d: ReturnType<typeof deps>, k: string) => (await d.blobs.head(k)) !== null;
  const opts = (o: Partial<import("../../foldrun-core/src/blob-sweeper.ts").SweepOptions> = {}) => ({ dryRun: false, delayMs: 0, minAgeMs: 0, maxDeletes: 1000, tenants: [T], ...o });
  const tick = () => new Promise((r) => setTimeout(r, 15));

  test("marks: first seen is kept by the database, an existing one keeps its time, clear removes", async () => {
    const marks = m.marks.pgSweepMarks();
    const t1 = await marks.now();
    await marks.put(T, "blob", [{ ref: "a".repeat(64), size: 5 }], t1);
    await tick();
    await marks.put(T, "blob", [{ ref: "a".repeat(64), size: 5 }, { ref: "b".repeat(64), size: 7 }], await marks.now());
    const got = await marks.load(T, "blob");
    assert.equal(got.size, 2);
    assert.equal(got.get("a".repeat(64))!.firstSeen.getTime(), t1.getTime(), "the first time stands");
    assert.equal(got.get("b".repeat(64))!.size, 7);
    assert.equal((await marks.load(T, "manifest")).size, 0);
    await marks.clear(T, "blob", ["a".repeat(64)]);
    assert.equal((await marks.load(T, "blob")).size, 1);
    await marks.recordRun({ dryRun: true } as never);
    assert.ok(await marks.lastRunAt());
  });

  test("the roots come from the revisions and the pins in the database; orphans go after the delay, referenced objects stay", async () => {
    const d = deps();
    const marks = m.marks.pgSweepMarks();
    await put(d, { "memory/keep.md": "keep\n", "memory/gone.md": "gone\n" });
    await put(d, { "memory/gone.md": null });
    await d.blobs.putIfAbsent(key("orphan\n"), Buffer.from("orphan\n"));
    await d.blobs.putIfAbsent(key("pinned\n"), Buffer.from("pinned\n"));
    await d.pins.pinBlobs(T, [m.manifest.sha256Hex(Buffer.from("pinned\n"))], { kind: "publish", id: "swpg-pin" });
    let r = await m.sweeper.sweepBlobs(d, marks, opts());
    assert.equal(r.deleted, 0);
    assert.equal(r.marked, 1, "the orphan; the pinned blob is a root, not a candidate");
    await tick();
    r = await m.sweeper.sweepBlobs(d, marks, opts());
    assert.equal(r.deleted, 1);
    assert.equal(await exists(d, key("orphan\n")), false);
    assert.equal(await exists(d, key("pinned\n")), true, "a live pin protects it");
    assert.equal(await exists(d, key("keep\n")), true);
    assert.equal(await exists(d, key("gone\n")), true, "an older revision still names it");
    await d.pins.release(T, { kind: "publish", id: "swpg-pin" });
    r = await m.sweeper.sweepBlobs(d, marks, opts());
    assert.equal(r.marked, 1, "released: seen unreferenced for the first time");
    await tick();
    r = await m.sweeper.sweepBlobs(d, marks, opts());
    assert.equal(r.deleted, 1, "and after the delay it goes");
    const runs = (await m.db.db()!.query(`SELECT count(*)::int c FROM blob_sweep_runs`)).rows[0].c;
    assert.ok(runs >= 3);
  });

  test("a revision committed since the mark (read by created_at) holds a blob that is about to be deleted", async () => {
    const d = deps();
    const marks = m.marks.pgSweepMarks();
    await put(d, { "memory/a.md": "a\n" });
    await d.blobs.putIfAbsent(key("racy\n"), Buffer.from("racy\n"));
    await m.sweeper.sweepBlobs(d, marks, opts());
    await tick();
    const racing = { ...d.pins, guardDelete: async (t: string, k: any, ref: string, del: () => Promise<void>) => {
      await put(d, { "memory/racy.md": "racy\n" }); // commits, releases its pin
      return d.pins.guardDelete(t, k, ref, del);
    } };
    const r = await m.sweeper.sweepBlobs({ ...d, pins: racing as never }, marks, opts());
    assert.equal(r.deleted, 0);
    assert.equal(await exists(d, key("racy\n")), true);
  });

  test("a deleted account: rows and pins gone, its objects follow after the delay; nothing is deleted when the database holds no revisions", async () => {
    const d = deps();
    const marks = m.marks.pgSweepMarks();
    await put(d, { "memory/g.md": "g\n" });
    await d.revisions.drop({ tenant: T });
    await m.sweeper.sweepBlobs(d, marks, opts());
    await tick();
    const r = await m.sweeper.sweepBlobs(d, marks, opts());
    // other tests' accounts hold revisions only while they run; either the objects went, or the sweeper refused because the database was empty
    assert.ok(r.deleted >= 2 || /holds no revision/.test(r.refused ?? ""), JSON.stringify(r));
    if (!r.refused) assert.equal(await exists(d, key("g\n")), false);
  });

  test("the pg store answers manifestIds (all, and since), anyRevisions and workspaces", async () => {
    const d = deps();
    await put(d, { "memory/a.md": "a\n", "state/s.json": "s" });
    const all = await d.revisions.manifestIds(T);
    assert.ok(all.length >= 2);
    assert.equal((await d.revisions.manifestIds(T, { since: new Date(Date.now() + 60_000) })).length, 0);
    assert.equal((await d.revisions.manifestIds(T, { since: new Date(Date.now() - 60_000) })).length, all.length);
    assert.equal(await d.revisions.anyRevisions(), true);
    assert.ok((await d.revisions.workspaces()).some((w) => w.tenant === T && w.workspace === W));
    assert.deepEqual(await d.revisions.manifestIds("nobody-here"), []);
  });

  test("orphaned history on the real tables: recorded, then removed after the grace; a live workspace is untouched", async () => {
    const d = deps();
    const marks = m.marks.pgSweepMarks();
    m.wr.setRevisionBackend(d, { journal: () => true, read: () => true, sweepMarks: marks, orphanGraceMs: 0 });
    const mk = async (w: string) => {
      fs.mkdirSync(m.store.workspaceDir(T, w), { recursive: true });
      fs.writeFileSync(path.join(m.store.workspaceDir(T, w), "AGENTS.md"), `---\nname: ${w}\n---\n`);
      m.store.writeWorkspaceFile(T, w, "memory/a.md", `${w}\n`, { by: "t" });
      await m.wr.flushRevisions({ tenant: T, workspace: w });
    };
    await mk(W);
    await mk(`${W}-old`);
    fs.rmSync(m.store.workspaceDir(T, `${W}-old`), { recursive: true, force: true });
    const one = await m.wr.cleanOrphanedHistory(marks, { graceMs: 0 });
    // install-wide: other tests' accounts may have rows without folders here too, so count only this account's
    assert.ok(one.marked >= 1);
    assert.ok((await marks.load(T, "workspace")).has(`${W}-old`), "this account's ghost is recorded");
    await tick();
    const two = await m.wr.cleanOrphanedHistory(marks, { graceMs: 0 });
    assert.ok(two.dropped >= 1);
    assert.equal(await d.revisions.head({ tenant: T, workspace: `${W}-old` }), null);
    assert.ok(await d.revisions.head({ tenant: T, workspace: W }));
    assert.equal((await marks.load(T, "workspace")).size, 0, "the record went with the history");
    await m.wr.cleanOrphanedHistory(marks, { graceMs: 0 });
    assert.equal(await d.revisions.head({ tenant: T, workspace: `${W}-old` }), null, "a repeat changes nothing");
    assert.ok(await d.revisions.head({ tenant: T, workspace: W }));
  });

  test("the scheduled job: off by default, a dry run first, not again inside the interval, and 'force' runs it", async () => {
    const saved = { ...process.env };
    try {
      delete process.env.FOLDRUN_BLOB_SWEEP;
      assert.equal(await m.job.runBlobSweep(), null, "off");
      process.env.FOLDRUN_BLOB_SWEEP = "1";
      await m.db.db()!.query(`DELETE FROM blob_sweep_runs`);
      const d = deps();
      await put(d, { "memory/a.md": "a\n" });
      await d.blobs.putIfAbsent(key("jobphan\n"), Buffer.from("jobphan\n"));
      const first = await m.job.runBlobSweep();
      assert.ok(first, "it ran");
      assert.equal(first!.dryRun, true, "dry run until the switch is turned off");
      assert.equal(first!.deleted, 0);
      assert.equal(await m.job.runBlobSweep(), null, "not due again");
      const forced = await m.job.runBlobSweep({ force: true });
      assert.ok(forced);
      assert.equal(await exists(d, key("jobphan\n")), true);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
}
