// A workspace's history follows its folder through a delete and a rename, and
// `state/` keeps a window — on the real tables (FOL-126 fixes, 8 Nov). The
// pins are the real blob_pins, the journal is the real revision_journal.
// DB-gated.
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { takeTurnsOnLiveDb } from "./live-db-lock.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
takeTurnsOnLiveDb(url);

if (!url) {
  test("workspace lifecycle on Postgres (set FOLDRUN_TEST_DATABASE_URL to run)", { skip: "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" }, () => {});
} else {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  const T = `life${Date.now().toString(36)}`;
  let root: string;
  let n = 0;
  let W: string;
  type Mods = Awaited<ReturnType<typeof mods>>;
  async function mods() {
    return {
      store: await import("../../foldrun-core/src/store.ts"),
      wr: await import("../../foldrun-core/src/workspace-revisions.ts"),
      publish: await import("../../foldrun-core/src/publish.ts"),
      blob: await import("../../foldrun-core/src/blob-store.ts"),
      rev: await import("../src/revision-store-pg.ts"),
      pins: await import("../src/blob-pins.ts"),
      jr: await import("../src/journal-pg.ts"),
      db: await import("../src/db.ts"),
      sync: await import("../src/pg-sync.ts"),
    };
  }
  let m: Mods;

  before(async () => {
    m = await mods();
    await m.db.migrate();
  });
  after(async () => {
    await m.sync.closePgSync();
    await m.db.db()?.end();
  });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-lifepg-"));
    process.env.FOLDRUN_DATA = root;
    W = `desk${++n}`;
  });
  afterEach(async () => {
    m.wr.setRevisionBackend(null);
    m.wr.resetJournalForTests();
    await m.rev.pgRevisionStore().drop({ tenant: T });
    m.jr.pgJournalStore().drop(T);
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.FOLDRUN_DATA;
  });

  const pool = () => m.db.db()!;
  const pinsOf = async (holderKind: string, ids: string[]) =>
    (await pool().query(`SELECT count(*)::int AS c FROM blob_pins WHERE tenant=$1 AND holder_kind=$2 AND holder_id = ANY($3::text[])`, [T, holderKind, ids])).rows[0].c as number;

  function backend(retention?: { keep: number; days: number }) {
    const deps = { blobs: m.blob.bounded(m.blob.fsBlobStore(path.join(root, ".objects")), { backoffMs: 1 }), revisions: m.rev.pgRevisionStore(), pins: m.pins.pgBlobPins() };
    m.wr.setRevisionBackend(deps, { journal: () => true, read: () => true, journalStore: m.jr.pgJournalStore(), ...(retention ? { stateRetention: () => retention, retentionEveryMs: 0 } : {}) });
    return deps;
  }
  async function make(w: string, files: Record<string, string>) {
    const dir = m.store.workspaceDir(T, w);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "AGENTS.md"), `---\nname: ${w}\n---\n`);
    for (const [rel, body] of Object.entries(files)) m.store.writeWorkspaceFile(T, w, rel, body, { by: "test" });
    await m.wr.flushRevisions({ tenant: T, workspace: w });
  }
  const revIds = async (deps: ReturnType<typeof backend>, w: string, scope: "workspace" | "state") =>
    (await deps.revisions.revisions({ tenant: T, workspace: w, scope }, { limit: 500 })).map((r) => r.id);

  test("delete: heads, revisions, ops, files and the pins of the revisions go; a new workspace of the name starts empty", async () => {
    const deps = backend();
    await make(W, { "memory/secret.md": "old\n", "state/s.json": "{}" });
    const ids = [...(await revIds(deps, W, "workspace")), ...(await revIds(deps, W, "state"))];
    assert.ok(ids.length >= 2);
    assert.ok((await pinsOf("revision", ids)) >= 2, "each revision pins its manifests");
    await m.store.deleteWorkspaceAsync(T, W);
    const rows = (await pool().query(`SELECT (SELECT count(*) FROM workspace_heads WHERE tenant=$1 AND workspace=$2)::int h, (SELECT count(*) FROM workspace_revisions WHERE tenant=$1 AND workspace=$2)::int r, (SELECT count(*) FROM workspace_ops WHERE tenant=$1 AND workspace=$2)::int o`, [T, W])).rows[0];
    assert.deepEqual(rows, { h: 0, r: 0, o: 0 });
    assert.equal(await pinsOf("revision", ids), 0, "the pins are released, so the objects can be collected");
    assert.equal(await m.wr.readAtHead(T, W, "memory/secret.md"), null);
    await make(W, { "memory/new.md": "new\n" });
    assert.equal(await m.wr.readAtHead(T, W, "memory/secret.md"), null);
    assert.equal((await revIds(deps, W, "workspace")).length, 1);
  });

  test("delete takes the journal rows too, and a write racing the delete cannot leave a head behind", async () => {
    const deps = backend();
    await make(W, { "memory/a.md": "a\n" });
    m.store.writeWorkspaceFile(T, W, "memory/late.md", "late\n", { by: "test" }); // queued, journal row written
    assert.equal(m.jr.pgJournalStore().entries(T, W).length, 1);
    await m.store.deleteWorkspaceAsync(T, W);
    await m.wr.flushRevisions();
    assert.equal(m.jr.pgJournalStore().entries(T, W).length, 0);
    assert.equal((await revIds(deps, W, "workspace")).length, 0);
  });

  test("rename: the history, its operations and the queued journal rows follow; the old name is empty; pins stay valid", async () => {
    const deps = backend();
    await make(W, { "memory/a.md": "a\n", "state/s.json": "{}" });
    const before = await revIds(deps, W, "workspace");
    m.store.writeWorkspaceFile(T, W, "memory/queued.md", "q\n", { by: "test" });
    const to = `${W}-new`;
    await m.store.renameWorkspaceAsync(T, W, to);
    assert.deepEqual((await revIds(deps, to, "workspace")).slice(-before.length), before.slice(-before.length));
    assert.equal((await revIds(deps, W, "workspace")).length, 0);
    assert.equal((await revIds(deps, W, "state")).length, 0);
    assert.equal(m.jr.pgJournalStore().entries(T, W).length, 0, "no journal row under the old name");
    await m.wr.flushRevisions({ tenant: T, workspace: to });
    assert.equal((await m.wr.readAtHead(T, to, "memory/queued.md"))?.toString(), "q\n");
    assert.ok((await pinsOf("revision", before)) >= 1, "revision ids are unchanged, so their pins still hold");
    await make(W, { "memory/z.md": "z\n" });
    assert.equal(await m.wr.readAtHead(T, W, "memory/a.md"), null, "a new workspace of the old name sees none of it");
  });

  test("rename onto a name that still has stale rows replaces them (they belonged to a workspace that no longer exists)", async () => {
    const deps = backend();
    const to = `${W}-stale`;
    await make(to, { "memory/stale.md": "stale\n" });
    fs.rmSync(m.store.workspaceDir(T, to), { recursive: true, force: true }); // folder gone, rows left (the old bug)
    m.wr.resetJournalForTests();
    await make(W, { "memory/a.md": "a\n" });
    await m.store.renameWorkspaceAsync(T, W, to);
    assert.equal(await m.wr.readAtHead(T, to, "memory/stale.md"), null);
    assert.equal((await m.wr.readAtHead(T, to, "memory/a.md"))?.toString(), "a\n");
    assert.ok(deps);
  });

  test("deleting an account removes every workspace's rows, the pins, the journal and the blobs", async () => {
    const deps = backend();
    await make(W, { "memory/a.md": "a\n" });
    await make(`${W}b`, { "memory/b.md": "b\n" });
    await m.wr.dropTenantRevisions(T);
    const c = (await pool().query(`SELECT (SELECT count(*) FROM workspace_heads WHERE tenant=$1)::int h, (SELECT count(*) FROM workspace_revisions WHERE tenant=$1)::int r, (SELECT count(*) FROM blob_pins WHERE tenant=$1)::int p, (SELECT count(*) FROM revision_journal WHERE tenant=$1)::int j`, [T])).rows[0];
    assert.deepEqual(c, { h: 0, r: 0, p: 0, j: 0 });
    assert.equal(fs.existsSync(path.join(root, ".objects", "t", T)), false);
    assert.ok(deps);
  });

  test("state retention: only the newest N stay, the pruned revisions' pins go, a run's pin holds one back", async () => {
    const deps = backend({ keep: 3, days: 0 });
    await make(W, { "memory/a.md": "a\n" });
    const step = async (i: number) => {
      fs.mkdirSync(path.join(m.store.workspaceDir(T, W), "state"), { recursive: true });
      fs.writeFileSync(path.join(m.store.workspaceDir(T, W), "state", "s.json"), `{"i":${i}}`);
      const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
      m.wr.recordStepOutputs(T, W, [{ path: "state/s.json", base: i === 1 ? null : sha(`{"i":${i - 1}}`), after: Buffer.from(`{"i":${i}}`) }], { runId: `r${i}`, step: i });
      await m.wr.flushRevisions({ tenant: T, workspace: W });
    };
    for (let i = 1; i <= 2; i++) await step(i);
    const pin = await m.wr.pinRunBase(T, W, "run-ret/pod");
    assert.ok(pin);
    const held = (await deps.revisions.head({ tenant: T, workspace: W, scope: "state" }))!;
    for (let i = 3; i <= 9; i++) await step(i);
    assert.ok((await revIds(deps, W, "state")).includes(held.id), "held by the run");
    await pin!.release();
    const res = await m.wr.pruneStateNow(T, W);
    assert.ok(res && res.pruned >= 1);
    const left = await revIds(deps, W, "state");
    assert.equal(left.length, 3);
    assert.equal(await pinsOf("revision", [held.id]), 0, "the pruned revision's pin is released");
    assert.ok((await pinsOf("revision", left)) >= 3, "the kept ones still pin their manifests");
    assert.equal((await m.wr.readAtHead(T, W, "state/s.json"))?.toString(), '{"i":9}');
  });

  test("pinRunBase holds the base's manifests under a run holder; release removes exactly those", async () => {
    const deps = backend();
    await make(W, { "memory/a.md": "a\n", "state/s.json": "{}" });
    const pin = await m.wr.pinRunBase(T, W, "run-pin/pod");
    assert.ok(pin);
    const heads = await m.publish.headsOf(deps, { tenant: T, workspace: W });
    assert.equal(pin!.base.workspace, heads.workspace!.id);
    assert.equal(pin!.base.state, heads.state!.id);
    assert.equal(await deps.pins.isPinnedBeyondRevisions(T, "manifest", heads.workspace!.authored), true);
    await pin!.release();
    assert.equal(await deps.pins.isPinnedBeyondRevisions(T, "manifest", heads.workspace!.authored), false, "only the revision's own pin is left");
    assert.equal(await deps.pins.isPinned(T, "manifest", heads.workspace!.authored), true);
  });

  test("the journal store moves a workspace's rows to its new name", async () => {
    const s = m.jr.pgJournalStore();
    const rec = (id: string) => ({ v: 1 as const, tenant: T, workspace: W, id, files: [{ path: "memory/a.md", before: null, after: "x\n" }], by: "u", message: "m", at: new Date().toISOString() });
    const h = s.put(rec("movejournal0001"));
    s.move(T, W, `${W}-to`);
    assert.equal(s.entries(T, W).length, 0);
    assert.deepEqual(s.entries(T, `${W}-to`).map((e) => e.handle), [h]);
    assert.equal(s.read(T, `${W}-to`, h).id, "movejournal0001");
  });
}
