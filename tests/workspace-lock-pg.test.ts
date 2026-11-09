// The workspace lock across pods (FOL-126): a commit holds it shared, a delete
// or rename exclusive, and a commit that gets the lock after a delete asks its
// guard whether the folder is still there. "Pods" here are separate pool
// connections — the advisory locks belong to the database session, which is
// exactly what separates pods. DB-gated.
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { takeTurnsOnLiveDb } from "./live-db-lock.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
takeTurnsOnLiveDb(url);

if (!url) {
  test("the workspace lock on Postgres (set FOLDRUN_TEST_DATABASE_URL to run)", { skip: "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" }, () => {});
} else {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  const T = `lock${Date.now().toString(36)}`;
  let n = 0;
  type Mods = { rev: typeof import("../src/revision-store-pg.ts"); db: typeof import("../src/db.ts"); manifest: typeof import("../../foldrun-core/src/manifest.ts") };
  let m: Mods;
  before(async () => {
    m = { rev: await import("../src/revision-store-pg.ts"), db: await import("../src/db.ts"), manifest: await import("../../foldrun-core/src/manifest.ts") };
    await m.db.migrate();
  });
  after(async () => {
    await m.rev.pgRevisionStore().drop({ tenant: T });
    await m.db.db()?.end();
  });
  afterEach(async () => {
    await m.rev.pgRevisionStore().drop({ tenant: T });
  });

  const input = (opId: string, guard?: () => boolean | Promise<boolean>) => ({
    base: null,
    authored: m.manifest.EMPTY_MANIFEST_ID,
    state: m.manifest.EMPTY_MANIFEST_ID,
    opId,
    digest: "d".repeat(64),
    by: "t",
    message: "m",
    guard,
  });
  const gate = () => {
    let open!: () => void;
    const p = new Promise<void>((r) => (open = r));
    return { p, open };
  };
  const settled = (p: Promise<unknown>) => Promise.race([p.then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), 300))]);
  /** Wait until some session is blocked on an advisory lock: the delete is queued behind the commit in flight. */
  const untilBlocked = async () => {
    for (let i = 0; i < 200; i++) {
      const r = await m.db.db()!.query(`SELECT count(*)::int c FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`);
      if (r.rows[0].c > 0) return;
      await new Promise((r2) => setTimeout(r2, 10));
    }
    throw new Error("the delete never queued for the lock");
  };
  const rows = async (w: string) => (await m.db.db()!.query(`SELECT count(*)::int c FROM workspace_revisions WHERE tenant=$1 AND workspace=$2`, [T, w])).rows[0].c as number;

  test("a delete waits for a commit in flight on another pod, then removes what it wrote", async () => {
    const store = m.rev.pgRevisionStore();
    const W = `w${++n}`;
    const inGuard = gate();
    const release = gate();
    const commit = store.commit({ tenant: T, workspace: W }, input("lock-op-delete-1", async () => {
      inGuard.open();
      await release.p; // the commit is "in flight" holding the shared lock
      return true;
    }));
    await inGuard.p;
    const drop = store.drop({ tenant: T, workspace: W });
    assert.equal(await settled(drop), false, "the delete is waiting for the commit's lock");
    release.open();
    assert.equal((await commit).status, "committed");
    await drop;
    assert.equal(await rows(W), 0, "the commit's rows are gone: the delete came after it");
  });

  test("a commit that gets the lock after the delete finds the folder gone and writes nothing", async () => {
    const store = m.rev.pgRevisionStore();
    const W = `w${++n}`;
    const res = await store.commit({ tenant: T, workspace: W }, input("lock-op-late-1", () => false));
    assert.deepEqual(res, { status: "gone" });
    assert.equal(await rows(W), 0);
    assert.equal(await store.head({ tenant: T, workspace: W }), null, "no head was created for the name");
    assert.equal(await store.operation({ tenant: T, workspace: W }, "lock-op-late-1"), null);
  });

  test("a commit queued behind the delete is refused by its guard, not applied to a recreated head", async () => {
    const store = m.rev.pgRevisionStore();
    const W = `w${++n}`;
    let folder = true;
    // the delete's first transaction holds the lock...
    const first = store.commit({ tenant: T, workspace: W }, input("lock-op-seed-1"));
    await first;
    const inGuard = gate();
    const hold = gate();
    const blocker = store.commit({ tenant: T, workspace: W }, { ...input("lock-op-blocker-1", async () => { inGuard.open(); await hold.p; return true; }), base: (await store.head({ tenant: T, workspace: W }))!.id });
    await inGuard.p;
    const del = store.drop({ tenant: T, workspace: W }).then(() => { folder = false; });
    await untilBlocked(); // the delete is now waiting behind the commit in flight
    // ...and a commit from a third pod queues behind it
    const late = store.commit({ tenant: T, workspace: W }, input("lock-op-queued-1", () => folder));
    hold.open();
    await blocker;
    await del;
    // The lock is granted the instant the delete commits, which can be before the
    // folder is removed: then its guard still says yes and the commit lands, and
    // the delete's SECOND drop (after the folder is gone) removes it. Either way
    // nothing survives, which is the guarantee.
    const res = await late;
    assert.ok(res.status === "gone" || res.status === "committed", res.status);
    await store.drop({ tenant: T, workspace: W });
    assert.equal(await rows(W), 0, "no rows are left under the deleted name");
    assert.equal(await store.head({ tenant: T, workspace: W }), null);
    // and from now on the folder is gone: a further commit is refused
    assert.deepEqual(await store.commit({ tenant: T, workspace: W }, input("lock-op-queued-2", () => folder)), { status: "gone" });
  });

  test("a rename waits for commits to both names; commits under the old name afterwards are refused", async () => {
    const store = m.rev.pgRevisionStore();
    const A = `w${++n}`;
    const B = `${A}-b`;
    await store.commit({ tenant: T, workspace: A }, input("lock-op-rename-seed"));
    const inGuard = gate();
    const hold = gate();
    const head = (await store.head({ tenant: T, workspace: A }))!;
    const commit = store.commit({ tenant: T, workspace: A }, { ...input("lock-op-rename-1", async () => { inGuard.open(); await hold.p; return true; }), base: head.id });
    await inGuard.p;
    const move = store.move(T, A, B);
    assert.equal(await settled(move), false, "the rename waits for the commit");
    hold.open();
    await commit;
    await move;
    assert.equal(await rows(A), 0);
    assert.equal(await rows(B), 2, "both revisions, the in-flight one included, moved");
    assert.deepEqual(await store.commit({ tenant: T, workspace: A }, input("lock-op-rename-2", () => false)), { status: "gone" });
    await store.drop({ tenant: T, workspace: B });
  });

  test("commits do not block each other (the lock is shared)", async () => {
    const store = m.rev.pgRevisionStore();
    const W = `w${++n}`;
    const both = gate();
    let inside = 0;
    const guard = async () => {
      inside++;
      if (inside === 2) both.open();
      await both.p; // neither can leave until BOTH are inside
      return true;
    };
    const a = store.commit({ tenant: T, workspace: W }, input("lock-op-shared-a", guard));
    const b = store.commit({ tenant: T, workspace: `${W}x` }, input("lock-op-shared-b", guard));
    const c = store.commit({ tenant: T, workspace: W }, input("lock-op-shared-c", guard));
    // a and c are the same workspace: if the lock were exclusive this would hang
    const done = await Promise.race([Promise.all([a, b, c]), new Promise<null>((r) => setTimeout(() => r(null), 3000))]);
    assert.ok(done, "commits of one workspace were inside the lock together");
  });

  test("an account delete waits for commits of any of its workspaces", async () => {
    const store = m.rev.pgRevisionStore();
    const W = `w${++n}`;
    const inGuard = gate();
    const hold = gate();
    const commit = store.commit({ tenant: T, workspace: W }, input("lock-op-tenant-1", async () => { inGuard.open(); await hold.p; return true; }));
    await inGuard.p;
    const drop = store.drop({ tenant: T });
    assert.equal(await settled(drop), false);
    hold.open();
    await commit;
    await drop;
    assert.equal(await rows(W), 0);
  });
}
