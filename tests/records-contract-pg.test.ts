// The records contract (core tests/records-contract.ts) against real Postgres:
// the same cases the in-memory reference passes. DB-gated like
// postgres-live.test.ts: FOLDRUN_TEST_DATABASE_URL=postgres://… npm test

import { test, before, after } from "node:test";
import { takeTurnsOnLiveDb } from "./live-db-lock.ts";
import { recordsContract } from "../../foldrun-core/tests/records-contract.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
takeTurnsOnLiveDb(url);

if (!url) {
  test("records contract on Postgres (set FOLDRUN_TEST_DATABASE_URL to run)", { skip: "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" }, () => {});
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
    const { closeRecordsReads } = await import("../src/records-pg.ts");
    await closeRecordsReads();
    await closePgSync();
    const { db } = await import("../src/db.ts");
    await db()?.end();
  });

  recordsContract("postgres", async () => {
    const { pgRecords } = await import("../src/records-pg.ts");
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    pgSyncOne("DELETE FROM run_records WHERE tenant IN ('acme', 'someone')");
    pgSyncOne("DELETE FROM trigger_events WHERE tenant IN ('acme', 'someone')");
    pgSyncOne("DELETE FROM workspace_files WHERE tenant IN ('acme', 'someone')");
    return { port: pgRecords(), done() {} };
  });
}
