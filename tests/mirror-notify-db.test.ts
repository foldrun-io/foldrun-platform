// The heads announce themselves (drizzle/0063, 15 Nov 2026): every write to
// workspace_heads or tenant_keys, whoever makes it, reaches every pod that
// mirrors the workspaces, on commit and never on rollback; the listener coming
// up or going down wakes a full pass.
//
//   FOLDRUN_TEST_DATABASE_URL=postgres://foldrun:test@localhost:55432/foldrun \
//     node --test tests/mirror-notify-db.test.ts

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { takeTurnsOnLiveDb } from "./live-db-lock.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
const opts = { skip: url ? false : "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" };
takeTurnsOnLiveDb(url);

if (url) {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  process.env.FOLDRUN_SECRET_KEY ??= "test-install-key";
}

const T = "mirrornotify";
const until = async (ok: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
};
const settle = () => new Promise((r) => setTimeout(r, 300));

const seen: string[] = [];
let wakes = 0;
let stop: (() => void) | null = null;

before(async () => {
  if (!url) return;
  const { migrate } = await import("../src/db.ts");
  await migrate();
  const { db } = await import("../src/db.ts");
  await db()!.query(`DELETE FROM workspace_heads WHERE tenant LIKE '${T}%'`);
  await db()!.query(`DELETE FROM tenant_keys WHERE tenant LIKE '${T}%'`);
  const { startMirrorNotify } = await import("../src/mirror-notify.ts");
  stop = startMirrorNotify({
    workspace: async (t, w) => void seen.push(`${t}/${w}`),
    account: async (t) => void seen.push(`account:${t}`),
    wake: () => wakes++,
  });
});

after(async () => {
  if (!url) return;
  stop?.();
  const { db } = await import("../src/db.ts");
  await db()!.query(`DELETE FROM workspace_heads WHERE tenant LIKE '${T}%'`);
  await db()!.query(`DELETE FROM tenant_keys WHERE tenant LIKE '${T}%'`);
  const { stopListening } = await import("../src/pg-listen.ts");
  await stopListening();
  const { closePgSync } = await import("../src/pg-sync.ts");
  await closePgSync();
  await db()?.end();
});

test("the listener comes up, and coming up wakes a full pass", opts, async () => {
  const { mirrorNotifyLive } = await import("../src/mirror-notify.ts");
  assert.ok(await until(mirrorNotifyLive), "listening on foldrun_heads");
  assert.ok(await until(() => wakes >= 1), "a full pass now: a change before LISTEN went unheard");
});

test("a head written, moved, renamed and deleted is announced each time, by name", opts, async () => {
  const { db } = await import("../src/db.ts");
  const { mirrorNotifyIdleForTests } = await import("../src/mirror-notify.ts");
  const q = (sql: string, args: unknown[] = []) => db()!.query(sql, args);
  seen.length = 0;
  await q(`INSERT INTO workspace_heads (tenant, workspace, scope, revision_id, seq) VALUES ($1,'desk','workspace','r1',1)`, [T]);
  assert.ok(await until(() => seen.includes(`${T}/desk`)), "insert");
  seen.length = 0;
  await q(`UPDATE workspace_heads SET revision_id='r2', seq=seq+1 WHERE tenant=$1 AND workspace='desk'`, [T]);
  assert.ok(await until(() => seen.includes(`${T}/desk`)), "a new head");
  seen.length = 0;
  await q(`UPDATE workspace_heads SET workspace='renamed' WHERE tenant=$1 AND workspace='desk'`, [T]);
  assert.ok(await until(() => seen.includes(`${T}/desk`) && seen.includes(`${T}/renamed`)), "a rename names both: the old copy goes, the new one comes");
  seen.length = 0;
  await q(`DELETE FROM workspace_heads WHERE tenant=$1 AND workspace='renamed'`, [T]);
  assert.ok(await until(() => seen.includes(`${T}/renamed`)), "delete");
  await mirrorNotifyIdleForTests();
});

test("a rolled-back write announces nothing; a transaction's many rows for one workspace sync it once", opts, async () => {
  const { db } = await import("../src/db.ts");
  const { mirrorNotifyIdleForTests } = await import("../src/mirror-notify.ts");
  const c = await db()!.connect();
  try {
    seen.length = 0;
    await c.query("BEGIN");
    await c.query(`INSERT INTO workspace_heads (tenant, workspace, scope, revision_id, seq) VALUES ($1,'never','workspace','r1',1)`, [T]);
    await c.query("ROLLBACK");
    await settle();
    assert.deepEqual(seen, [], "nothing on rollback");
    await c.query("BEGIN");
    await c.query(`INSERT INTO workspace_heads (tenant, workspace, scope, revision_id, seq) VALUES ($1,'both','workspace','r1',1)`, [T]);
    await c.query(`INSERT INTO workspace_heads (tenant, workspace, scope, revision_id, seq) VALUES ($1,'both','state','s1',1)`, [T]);
    await c.query(`UPDATE workspace_heads SET seq=seq+1 WHERE tenant=$1 AND workspace='both'`, [T]);
    await c.query("COMMIT");
    assert.ok(await until(() => seen.includes(`${T}/both`)));
    await mirrorNotifyIdleForTests();
    await settle();
    assert.deepEqual(seen, [`${T}/both`], "Postgres folds identical notifications in one transaction");
  } finally {
    c.release();
  }
});

test("an account made or removed is announced as the account alone", opts, async () => {
  const { db } = await import("../src/db.ts");
  seen.length = 0;
  await db()!.query(`INSERT INTO tenant_keys (tenant, wrapped) VALUES ($1, 'x')`, [`${T}-acct`]);
  assert.ok(await until(() => seen.includes(`account:${T}-acct`)), "sign-up");
  seen.length = 0;
  await db()!.query(`DELETE FROM tenant_keys WHERE tenant=$1`, [`${T}-acct`]);
  assert.ok(await until(() => seen.includes(`account:${T}-acct`)), "account deleted");
});

test("a lost connection wakes a pass (poll now), and coming back wakes another", opts, async () => {
  const { dropConnectionForTests } = await import("../src/pg-listen.ts");
  const { mirrorNotifyLive } = await import("../src/mirror-notify.ts");
  const before = wakes;
  dropConnectionForTests();
  assert.equal(mirrorNotifyLive(), false, "not live: the loop polls at its old pace");
  assert.ok(wakes >= before + 1, "down: a pass now");
  assert.ok(await until(mirrorNotifyLive, 5_000), "reconnects");
  assert.ok(await until(() => wakes >= before + 2), "up: another, for what was missed meanwhile");
  // And it still hears.
  const { db } = await import("../src/db.ts");
  seen.length = 0;
  await db()!.query(`INSERT INTO workspace_heads (tenant, workspace, scope, revision_id, seq) VALUES ($1,'after','workspace','r1',1)`, [T]);
  assert.ok(await until(() => seen.includes(`${T}/after`)));
});
