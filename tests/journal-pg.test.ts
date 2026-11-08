// The revision journal in Postgres (FOL-126 phase 4): the JournalStore contract
// on the real table, the journal writing through it (nothing on the volume),
// a replay after a crash, and a run's copy-back landing as a revision with a
// real conflict on the same path. DB-gated.
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
  test("the revision journal on Postgres (set FOLDRUN_TEST_DATABASE_URL to run)", { skip: "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" }, () => {});
} else {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
  const T = `jrn${Date.now().toString(36)}`;
  let root: string;
  let n = 0;
  let W: string;

  before(async () => {
    const { migrate } = await import("../src/db.ts");
    await migrate();
  });
  after(async () => {
    const { closePgSync } = await import("../src/pg-sync.ts");
    await closePgSync();
    const { db } = await import("../src/db.ts");
    await db()?.end();
  });
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-jrnpg-"));
    process.env.FOLDRUN_DATA = root;
    W = `desk${++n}`;
    const { workspaceDir } = await import("../../foldrun-core/src/store.ts");
    fs.mkdirSync(path.join(workspaceDir(T, W), "memory"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir(T, W), "AGENTS.md"), "---\nname: desk\n---\n");
    fs.writeFileSync(path.join(workspaceDir(T, W), "memory", "a.md"), "a0\n");
  });
  afterEach(async () => {
    const { setRevisionBackend, resetJournalForTests } = await import("../../foldrun-core/src/workspace-revisions.ts");
    setRevisionBackend(null);
    resetJournalForTests();
    const { pgJournalStore } = await import("../src/journal-pg.ts");
    pgJournalStore().drop(T);
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.FOLDRUN_DATA;
  });

  const rec = (id: string, p = "memory/a.md") => ({ v: 1 as const, tenant: T, workspace: W, id, files: [{ path: p, before: null, after: `body ${id}\n` }], by: "u", message: "m", at: new Date().toISOString() });

  async function backend(opts: { down?: { v: boolean } } = {}) {
    const { fsBlobStore, bounded } = await import("../../foldrun-core/src/blob-store.ts");
    const { pgRevisionStore } = await import("../src/revision-store-pg.ts");
    const { pgBlobPins } = await import("../src/blob-pins.ts");
    const { pgJournalStore } = await import("../src/journal-pg.ts");
    const { setRevisionBackend } = await import("../../foldrun-core/src/workspace-revisions.ts");
    const inner = pgRevisionStore();
    const revisions = opts.down
      ? new Proxy(inner, {
          get(t, p, r) {
            const v = Reflect.get(t, p, r);
            if (p === "commit" && typeof v === "function") return (...a: unknown[]) => (opts.down!.v ? Promise.reject(new Error("database down")) : (v as Function).apply(t, a));
            return typeof v === "function" ? v.bind(t) : v;
          },
        })
      : inner;
    const deps = { blobs: bounded(fsBlobStore(path.join(root, ".objects")), { backoffMs: 1 }), revisions, pins: pgBlobPins() };
    setRevisionBackend(deps, { journal: () => true, read: () => true, journalStore: pgJournalStore() });
    return deps;
  }

  test("the store: put, oldest first, read, set aside, remove, drop — on the real table", async () => {
    const { pgJournalStore } = await import("../src/journal-pg.ts");
    const s = pgJournalStore();
    const h1 = s.put(rec("journalpg00001"));
    const h2 = s.put(rec("journalpg00002"));
    assert.equal(s.put(rec("journalpg00001")), h1, "the same id is one entry");
    assert.deepEqual(s.workspaces().filter((w) => w.tenant === T), [{ tenant: T, workspace: W }]);
    const list = s.entries(T, W);
    assert.deepEqual(list.map((e) => e.handle), [h1, h2]);
    assert.ok(list[0].ageMs >= 0 && list[0].ageMs < 60_000);
    assert.equal(s.read(T, W, h2).files[0].after, "body journalpg00002\n");
    s.setAside(T, W, h1);
    assert.deepEqual(s.entries(T, W).map((e) => e.handle), [h2]);
    s.remove(T, W, h2);
    s.remove(T, W, h2);
    assert.equal(s.entries(T, W).length, 0);
    assert.throws(() => s.read(T, W, h2));
    s.put(rec("journalpg00003"));
    s.drop(T, W);
    assert.equal(s.workspaces().filter((w) => w.tenant === T).length, 0);
  });

  test("the journal is a row before the commit and gone after; the volume holds nothing", async () => {
    await backend();
    const { pgJournalStore } = await import("../src/journal-pg.ts");
    const store = await import("../../foldrun-core/src/store.ts");
    const wr = await import("../../foldrun-core/src/workspace-revisions.ts");
    store.writeWorkspaceFile(T, W, "memory/b.md", "b\n", { by: "user:a" });
    assert.equal(pgJournalStore().entries(T, W).length, 1);
    assert.equal(fs.existsSync(path.join(root, ".revision-journal")), false);
    await wr.flushRevisions({ tenant: T, workspace: W });
    assert.equal(pgJournalStore().entries(T, W).length, 0);
    assert.equal((await wr.readAtHead(T, W, "memory/b.md"))?.toString(), "b\n");
  });

  test("a crash with the commit refused: the rows survive the process, and boot replays them once", async () => {
    const down = { v: true };
    await backend({ down });
    const store = await import("../../foldrun-core/src/store.ts");
    const wr = await import("../../foldrun-core/src/workspace-revisions.ts");
    const { pgJournalStore } = await import("../src/journal-pg.ts");
    store.writeWorkspaceFile(T, W, "memory/b.md", "b\n", { by: "user:a" });
    store.writeWorkspaceFile(T, W, "memory/c.md", "c\n", { by: "user:a" });
    await wr.flushRevisions({ tenant: T, workspace: W });
    assert.equal(pgJournalStore().entries(T, W).length, 2, "still in the table");
    // the process dies: its memory is gone, the rows are not
    wr.resetJournalForTests();
    await backend(); // the next process, the store back
    const out = await wr.recoverJournal({ minAgeMs: 0 });
    assert.equal(out.entries, 2);
    assert.equal((await wr.readAtHead(T, W, "memory/b.md"))?.toString(), "b\n");
    assert.equal((await wr.readAtHead(T, W, "memory/c.md"))?.toString(), "c\n");
    assert.equal(pgJournalStore().entries(T, W).length, 0);
  });

  test("a legacy journal file on the volume is replayed into the same head and drained", async () => {
    await backend();
    const { fsJournalStore } = await import("../../foldrun-core/src/journal-store.ts");
    const wr = await import("../../foldrun-core/src/workspace-revisions.ts");
    fs.writeFileSync(path.join(root, "x"), "");
    fs.writeFileSync(path.join((await import("../../foldrun-core/src/store.ts")).workspaceDir(T, W), "memory", "old.md"), "old\n");
    const legacy = fsJournalStore(() => path.join(root, ".revision-journal"));
    legacy.put(rec("journalold00001", "memory/old.md"));
    const out = await wr.recoverJournal({ minAgeMs: 0 });
    assert.equal(out.entries, 1);
    assert.equal((await wr.readAtHead(T, W, "memory/old.md"))?.toString(), "old\n");
    assert.equal(legacy.workspaces().length, 0);
  });

  test("deleting the workspace clears its rows", async () => {
    const down = { v: true };
    await backend({ down });
    const store = await import("../../foldrun-core/src/store.ts");
    const { pgJournalStore } = await import("../src/journal-pg.ts");
    store.writeWorkspaceFile(T, W, "memory/b.md", "b\n", { by: "user:a" });
    assert.equal(pgJournalStore().entries(T, W).length, 1);
    store.deleteWorkspace(T, W);
    assert.equal(pgJournalStore().entries(T, W).length, 0);
  });

  test("two runs' copy-backs on Postgres: different paths both land, the same path is a conflict that keeps both", async () => {
    await backend();
    const wr = await import("../../foldrun-core/src/workspace-revisions.ts");
    const { workspaceDir } = await import("../../foldrun-core/src/store.ts");
    fs.writeFileSync(path.join(workspaceDir(T, W), "memory", "b.md"), "b0\n");
    fs.mkdirSync(path.join(workspaceDir(T, W), "state"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir(T, W), "state", "s.json"), "{}"); // a step wrote it before copy-back recorded it
    wr.recordStepOutputs(T, W, [{ path: "memory/a.md", base: null, after: Buffer.from("a0\n") }], { runId: "seed", step: 0 });
    await wr.flushRevisions({ tenant: T, workspace: W });
    wr.recordStepOutputs(T, W, [{ path: "memory/a.md", base: sha("a0\n"), after: Buffer.from("run 1\n") }], { runId: "r1", step: "p" });
    wr.recordStepOutputs(T, W, [{ path: "memory/b.md", base: sha("b0\n"), after: Buffer.from("run 2 b\n") }], { runId: "r2", step: "p" });
    wr.recordStepOutputs(T, W, [{ path: "memory/a.md", base: sha("a0\n"), after: Buffer.from("run 3\n") }, { path: "state/s.json", base: null, after: Buffer.from("{}") }], { runId: "r3", step: "p" });
    await wr.flushRevisions({ tenant: T, workspace: W });
    assert.equal((await wr.readAtHead(T, W, "memory/a.md"))?.toString(), "run 1\n");
    assert.equal((await wr.readAtHead(T, W, "memory/b.md"))?.toString(), "run 2 b\n");
    assert.equal((await wr.readAtHead(T, W, "state/s.json"))?.toString(), "{}");
    const tree = (await wr.readHeadTree(T, W)) ?? [];
    const copy = tree.find((f) => /^memory\/a\.conflict-[0-9a-f]{12}\.md$/.test(f.path));
    assert.ok(copy, "the other version is kept beside it");
    assert.equal(copy!.bytes.toString(), "run 3\n");
  });
}
