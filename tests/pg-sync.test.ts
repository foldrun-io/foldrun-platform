// The synchronous bridge to Postgres (src/pg-sync.ts). DB-gated.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { takeTurnsOnLiveDb } from "./live-db-lock.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
takeTurnsOnLiveDb(url);

if (!url) {
  test("pg-sync (set FOLDRUN_TEST_DATABASE_URL to run)", { skip: "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" }, () => {});
} else {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;

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

  test("a statement answers synchronously, with typed rows", async () => {
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    const r = pgSyncOne("SELECT $1::int + 1 AS n, $2::jsonb AS j, now() AS at", [41, JSON.stringify({ a: [1, 2] })]);
    assert.equal(r.rows[0].n, 42);
    assert.deepEqual(r.rows[0].j, { a: [1, 2] });
    assert.ok(r.rows[0].at instanceof Date);
  });

  test("many calls in a row each get their own answer", async () => {
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    for (let i = 0; i < 300; i++) assert.equal(pgSyncOne("SELECT $1::int AS n", [i]).rows[0].n, i);
  });

  test("a failing statement throws with the database's code, and the bridge keeps working", async () => {
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    assert.throws(() => pgSyncOne("SELECT * FROM no_such_table_here"), (e: Error & { code?: string }) => e.code === "42P01");
    assert.equal(pgSyncOne("SELECT 1 AS n").rows[0].n, 1);
  });

  test("a batch is one transaction: a failure undoes the statements before it", async () => {
    const { pgSync, pgSyncOne } = await import("../src/pg-sync.ts");
    const key = `batch-${Date.now()}`;
    assert.throws(() =>
      pgSync([
        { text: "INSERT INTO lock_fences (name, token) VALUES ($1, 1)", values: [key] },
        { text: "INSERT INTO lock_fences (name, token) VALUES ($1, 1)", values: [key] }, // duplicate key
      ]),
    );
    assert.equal(pgSyncOne("SELECT count(*)::int AS n FROM lock_fences WHERE name = $1", [key]).rows[0].n, 0);
  });

  test("a stale fence refuses the write and nothing lands; the current one writes", async () => {
    const { pgSync, pgSyncOne, StaleFence } = await import("../src/pg-sync.ts");
    const name = `fence-${Date.now()}`;
    pgSyncOne("INSERT INTO lock_fences (name, token) VALUES ($1, 2)", [name]);
    const probe = `probe-${name}`;
    assert.throws(() => pgSync([{ text: "INSERT INTO lock_fences (name, token) VALUES ($1, 9)", values: [probe] }], { fence: { name, token: 1 } }), StaleFence);
    assert.equal(pgSyncOne("SELECT count(*)::int AS n FROM lock_fences WHERE name = $1", [probe]).rows[0].n, 0);
    pgSync([{ text: "INSERT INTO lock_fences (name, token) VALUES ($1, 9)", values: [probe] }], { fence: { name, token: 2 } });
    assert.equal(pgSyncOne("SELECT count(*)::int AS n FROM lock_fences WHERE name = $1", [probe]).rows[0].n, 1);
    assert.throws(() => pgSync([{ text: "SELECT 1" }], { fence: { name: "no-such-lock", token: 1 } }), StaleFence, "no fence row at all is stale too");
  });

  test("a statement that takes too long is cancelled by the server, and the bridge goes on answering in order", async () => {
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    assert.throws(() => pgSyncOne("SELECT pg_sleep(1.2), 'late' AS who", [], { timeoutMs: 150 }), (e: Error & { code?: string }) => e.code === "RECORDS_TIMEOUT" && /did not answer within 150 ms/.test(e.message));
    assert.equal(pgSyncOne("SELECT 'next' AS who").rows[0].who, "next");
  });

  test("a write that timed out never commits afterwards (Codex review): a retry's newer value is not overwritten", async () => {
    const { pgSync, pgSyncOne } = await import("../src/pg-sync.ts");
    const name = `slow-${Date.now()}`;
    assert.throws(
      () => pgSync([{ text: "INSERT INTO lock_fences (name, token) VALUES ($1, 1)", values: [name] }, { text: "SELECT pg_sleep(1.5)" }], { timeoutMs: 300 }),
      (e: Error & { code?: string }) => e.code === "RECORDS_TIMEOUT",
    );
    pgSyncOne("INSERT INTO lock_fences (name, token) VALUES ($1, 7)", [name]); // the retry
    await new Promise((r) => setTimeout(r, 1800)); // long enough for the first to have finished, had it been left running
    assert.equal(pgSyncOne("SELECT token FROM lock_fences WHERE name = $1", [name]).rows[0].token, "7");
  });

  test("the default deadline is short, and a call is never allowed to freeze a process (FOL-126 phase 3 part 1)", async () => {
    const { DEFAULT_TIMEOUT_MS } = await import("../src/pg-sync.ts");
    assert.ok(DEFAULT_TIMEOUT_MS >= 2000 && DEFAULT_TIMEOUT_MS <= 5000, `${DEFAULT_TIMEOUT_MS} ms`);
  });

  test("a thread that stops answering altogether: the call gives up at its hard deadline, the thread is replaced, the next call works at once", async () => {
    const { pgSyncOne, wedgeForTest, RecordsTimeout } = await import("../src/pg-sync.ts");
    assert.equal(pgSyncOne("SELECT 1 AS n").rows[0].n, 1);
    wedgeForTest(6000);
    const began = Date.now();
    assert.throws(() => pgSyncOne("SELECT 2 AS n", [], { timeoutMs: 200 }), RecordsTimeout);
    const took = Date.now() - began;
    assert.ok(took >= 1600 && took < 2600, `gave up after ${took} ms (200 + 1500 grace)`);
    const again = Date.now();
    assert.equal(pgSyncOne("SELECT 3 AS n").rows[0].n, 3);
    assert.ok(Date.now() - again < 1500, "a fresh thread answered, not the wedged one");
  });

  test("a stale holder of a fenced lock is refused after a newer one took over", async () => {
    const { withFencedLock, assertFence, StaleLock } = await import("../src/fenced-lock.ts");
    const { tx } = await import("../src/db.ts");
    const name = `takeover-${Date.now()}`;
    let old: { name: string; token: number } | null = null;
    await withFencedLock(name, async (f) => {
      old = f;
    });
    await withFencedLock(name, async (f) => {
      assert.ok(f.token > old!.token);
      await assert.rejects(() => tx((t) => assertFence(t, old!)), StaleLock);
    });
  });
}
