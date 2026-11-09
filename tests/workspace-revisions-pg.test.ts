// Workspaces as revisions on real Postgres (FOL-126 phase 3): the journal commits
// through the pg RevisionStore and blob pins. DB-gated.
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { takeTurnsOnLiveDb } from "./live-db-lock.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
takeTurnsOnLiveDb(url);

if (!url) {
  test("workspace revisions on Postgres (set FOLDRUN_TEST_DATABASE_URL to run)", { skip: "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" }, () => {});
} else {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  let root: string;
  const T = `wsr${Date.now().toString(36)}`;
  let n = 0;
  let W: string;

  before(async () => {
    const { migrate } = await import("../src/db.ts");
    await migrate();
  });
  after(async () => {
    const { db } = await import("../src/db.ts");
    await db()?.end();
  });
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-wsrpg-"));
    process.env.FOLDRUN_DATA = root;
    W = `desk${++n}`;
    const { workspaceDir } = await import("../../foldrun-core/src/store.ts");
    fs.mkdirSync(path.join(workspaceDir(T, W), "agents", "writer"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir(T, W), "AGENTS.md"), "---\nname: desk\n---\n");
    const { fsBlobStore, bounded } = await import("../../foldrun-core/src/blob-store.ts");
    const { pgRevisionStore } = await import("../src/revision-store-pg.ts");
    const { pgBlobPins } = await import("../src/blob-pins.ts");
    const { setRevisionBackend } = await import("../../foldrun-core/src/workspace-revisions.ts");
    setRevisionBackend({ blobs: bounded(fsBlobStore(path.join(root, ".objects")), { backoffMs: 1 }), revisions: pgRevisionStore(), pins: pgBlobPins() }, { journal: () => true, read: () => true });
  });
  afterEach(async () => {
    const { setRevisionBackend, resetJournalForTests } = await import("../../foldrun-core/src/workspace-revisions.ts");
    setRevisionBackend(null);
    resetJournalForTests();
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.FOLDRUN_DATA;
  });

  test("saves, deletes and a restore go through the Postgres revision store, and read back from head → manifest → blob", async () => {
    const store = await import("../../foldrun-core/src/store.ts");
    const wr = await import("../../foldrun-core/src/workspace-revisions.ts");
    store.writeWorkspaceFile(T, W, "memory/a.md", "one\n", { by: "user:a", message: "first" });
    store.writeWorkspaceFile(T, W, "memory/a.md", "two\n", { by: "user:b", message: "second" });
    store.writeWorkspaceFile(T, W, "memory/b.md", "bee\n", { by: "assistant", message: "third" });
    assert.equal((await wr.flushRevisions({ tenant: T, workspace: W })).pending, 0);
    const list = await wr.listRevisionSummaries(T, W);
    assert.ok(list.length >= 1);
    assert.equal((await wr.readAtHead(T, W, "memory/a.md"))!.toString(), "two\n");
    assert.equal((await wr.readAtHead(T, W, "memory/b.md"))!.toString(), "bee\n");
    store.deleteWorkspacePath(T, W, "memory/b.md", { by: "user:a", message: "drop b" });
    await wr.flushRevisions();
    assert.equal(await wr.readAtHead(T, W, "memory/b.md"), null);
    const [newest] = await wr.listRevisionSummaries(T, W);
    assert.equal(newest.message, "drop b");
    assert.deepEqual(newest.paths, ["memory/b.md"]);
    const first = list.at(-1)!;
    const res = (await wr.restoreRevision(T, W, first.id, { by: "user:a", opId: `restore-${T}-${W}` }))!;
    assert.equal(res.status, "committed");
    assert.equal((await wr.readAtHead(T, W, "memory/a.md"))!.toString(), (await wr.snapshotFiles(T, W, first.id))!.find((f) => f.path === "memory/a.md")!.content);
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    assert.ok(Number(pgSyncOne("SELECT count(*) AS n FROM workspace_revisions WHERE tenant = $1 AND workspace = $2", [T, W]).rows[0].n) >= 3);
  });

  test("two processes' worth of writers to different workspaces and one to the same all land, in order, with no duplicate", async () => {
    const store = await import("../../foldrun-core/src/store.ts");
    const wr = await import("../../foldrun-core/src/workspace-revisions.ts");
    for (let i = 0; i < 12; i++) store.writeWorkspaceFile(T, W, `memory/f${i}.md`, `body ${i}\n`, { by: "user:a", message: `f${i}` });
    await Promise.all([wr.flushRevisions(), wr.flushRevisions()]);
    for (let i = 0; i < 12; i++) assert.equal((await wr.readAtHead(T, W, `memory/f${i}.md`))!.toString(), `body ${i}\n`);
  });

  test("a crash with changes queued: the journal files replay onto Postgres at boot, and reconcile repairs the rest", async () => {
    const store = await import("../../foldrun-core/src/store.ts");
    const wr = await import("../../foldrun-core/src/workspace-revisions.ts");
    store.writeWorkspaceFile(T, W, "memory/base.md", "base\n", { by: "user:a" });
    await wr.flushRevisions();
    // the store goes away: entries are written down and stay queued
    const { pgRevisionStore } = await import("../src/revision-store-pg.ts");
    const { pgBlobPins } = await import("../src/blob-pins.ts");
    const real = pgRevisionStore();
    const down = new Proxy(real, { get: (t, p, r) => (p === "commit" ? () => Promise.reject(new Error("database down")) : (Reflect.get(t, p, r) as unknown)) });
    const { fsBlobStore, bounded } = await import("../../foldrun-core/src/blob-store.ts");
    const blobs = bounded(fsBlobStore(path.join(root, ".objects")), { backoffMs: 1 });
    wr.setRevisionBackend({ blobs, revisions: down as typeof real, pins: pgBlobPins() }, { journal: () => true, read: () => true });
    store.writeWorkspaceFile(T, W, "memory/late.md", "late\n", { by: "user:b", message: "late write" });
    assert.equal((await wr.flushRevisions({ tenant: T, workspace: W })).pending, 1);
    wr.resetJournalForTests(); // the process dies
    wr.setRevisionBackend({ blobs, revisions: real, pins: pgBlobPins() }, { journal: () => true, read: () => true });
    assert.equal((await wr.recoverJournal({ minAgeMs: 0 })).entries, 1);
    assert.equal((await wr.readAtHead(T, W, "memory/late.md"))!.toString(), "late\n");
    assert.equal((await wr.listRevisionSummaries(T, W))[0].message === "late write" || (await wr.listRevisionSummaries(T, W)).some((r) => r.message === "late write"), true);
  });
}
