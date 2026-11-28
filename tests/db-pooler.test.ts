// Behind a transaction pooler (FOL-478): what needs one connection held across
// statements goes direct (FOLDRUN_DATABASE_DIRECT_URL), and nothing leaves a
// session setting behind on a connection that is lent on.
//
// The config half runs anywhere. The live half needs Postgres
// (FOLDRUN_TEST_DATABASE_URL) and, to prove it against a real pooler, a
// transaction-mode PgBouncer in front of it (FOLDRUN_TEST_POOLER_URL, same
// user and password). Without the pooler URL the live half runs against the
// database directly: the settings checks still hold, the routing ones are
// then only a smoke test.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { takeTurnsOnLiveDb } from "./live-db-lock.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
const poolerUrl = process.env.FOLDRUN_TEST_POOLER_URL;

test("directConnectionConfig is the database, connectionConfig the pooler; without a direct URL they are the same", async () => {
  const keep = { u: process.env.FOLDRUN_DATABASE_URL, d: process.env.FOLDRUN_DATABASE_DIRECT_URL };
  try {
    const { connectionConfig, directConnectionConfig } = await import("../src/db.ts");
    process.env.FOLDRUN_DATABASE_URL = "postgres://foldrun@pgbouncer.ns:6432/foldrun";
    delete process.env.FOLDRUN_DATABASE_DIRECT_URL;
    assert.equal(directConnectionConfig().host, "pgbouncer.ns");
    assert.equal(directConnectionConfig().port, 6432);
    process.env.FOLDRUN_DATABASE_DIRECT_URL = "postgres://foldrun@db.example:5432/foldrun?sslmode=require";
    assert.equal(connectionConfig().host, "pgbouncer.ns");
    assert.equal(directConnectionConfig().host, "db.example");
    assert.equal(directConnectionConfig().port, 5432);
    assert.deepEqual(directConnectionConfig().ssl, { rejectUnauthorized: false });
    assert.equal(connectionConfig().ssl, undefined);
  } finally {
    for (const [k, v] of [["FOLDRUN_DATABASE_URL", keep.u], ["FOLDRUN_DATABASE_DIRECT_URL", keep.d]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

takeTurnsOnLiveDb(url);

if (!url) {
  test("the pooler's rules on Postgres (set FOLDRUN_TEST_DATABASE_URL to run)", { skip: "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" }, () => {});
} else {
  const u = new URL(url);
  const strip = (s: string) => {
    const x = new URL(s);
    return `${x.protocol}//${x.username}@${x.host}${x.pathname}`;
  };
  type Db = typeof import("../src/db.ts");
  type Rec = typeof import("../src/records-pg.ts");
  let db: Db;
  let rec: Rec;
  before(async () => {
    process.env.FOLDRUN_DATABASE_URL = strip(poolerUrl ?? url);
    process.env.FOLDRUN_DATABASE_DIRECT_URL = strip(url);
    process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
    process.env.FOLDRUN_DATABASE_POOL = "1"; // one pooled connection: any setting left on it is seen by the next call
    process.env.FOLDRUN_RECORDS_POOL = "1";
    db = await import("../src/db.ts");
    rec = await import("../src/records-pg.ts");
    await db.migrate();
  });
  after(async () => {
    await rec.closeRecordsReads();
    await db.db()?.end();
  });

  const show = async (setting: string) => String((await db.db()!.query(`SHOW ${setting}`)).rows[0][setting]);

  test("a records read gets its server deadline from SET LOCAL: it is in force during the call and gone after", async () => {
    const during = await rec.readWithDeadline("SELECT current_setting('statement_timeout') AS st", []);
    assert.notEqual(during.rows[0].st, "0", "the statement ran under a deadline");
    // The records pool has one connection and the call is over: the next
    // statement on it sees the server default, not the deadline.
    const after = await rec.readWithDeadline("SELECT 1 AS one", []);
    assert.equal(after.rows[0].one, 1);
    const c = await (db.db() as import("pg").Pool).connect();
    try {
      assert.equal(String((await c.query("SHOW statement_timeout")).rows[0].statement_timeout), "0");
    } finally {
      c.release();
    }
  });

  test("a records read past its deadline is cancelled by the server and leaves nothing behind", async () => {
    process.env.FOLDRUN_RECORDS_TIMEOUT_MS = "300";
    try {
      await assert.rejects(rec.readWithDeadline("SELECT pg_sleep(3)", []), /RecordsTimeout|timeout|57014/i);
    } finally {
      delete process.env.FOLDRUN_RECORDS_TIMEOUT_MS;
    }
    const ok = await rec.readWithDeadline("SELECT 2 AS two", []);
    assert.equal(ok.rows[0].two, 2, "the connection is usable and not stuck in an aborted transaction");
  });

  test("withNamedLock excludes a second holder, and lock_timeout does not outlive it", async () => {
    const order: string[] = [];
    const first = db.withNamedLock("fol478-lock", async () => {
      order.push("a-in");
      await new Promise((r) => setTimeout(r, 400));
      order.push("a-out");
    });
    await new Promise((r) => setTimeout(r, 100));
    const second = db.withNamedLock("fol478-lock", async () => {
      order.push("b-in");
    });
    await Promise.all([first, second]);
    assert.deepEqual(order, ["a-in", "a-out", "b-in"]);
    await db.withDirectClient(async (c) => {
      assert.equal(String((await c.query("SHOW lock_timeout")).rows[0].lock_timeout), "0");
    });
  });

  test("withNamedLock gives up after its wait instead of hanging", async () => {
    const holder = db.withNamedLock("fol478-lock2", () => new Promise<void>((r) => setTimeout(r, 1200)));
    await new Promise((r) => setTimeout(r, 100));
    await assert.rejects(db.withNamedLock("fol478-lock2", async () => {}, 300), /lock timeout|57014|55P03/i);
    await holder;
  });

  test("no session setting is left on a pooled connection by any of the above", async () => {
    for (const s of ["statement_timeout", "lock_timeout", "idle_in_transaction_session_timeout"]) {
      assert.equal(await show(s), "0", s);
    }
  });
}
