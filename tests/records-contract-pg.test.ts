// The records contract (core tests/records-contract.ts) against real Postgres:
// the same cases the in-memory reference passes. DB-gated like
// postgres-live.test.ts: FOLDRUN_TEST_DATABASE_URL=postgres://… npm test

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
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
    pgSyncOne("DELETE FROM run_step_state WHERE tenant IN ('acme', 'someone')");
    pgSyncOne("DELETE FROM run_records WHERE tenant IN ('acme', 'someone')");
    pgSyncOne("DELETE FROM trigger_events WHERE tenant IN ('acme', 'someone')");
    pgSyncOne("DELETE FROM workspace_files WHERE tenant IN ('acme', 'someone')");
    pgSyncOne("DELETE FROM workspace_docs WHERE tenant IN ('acme', 'someone')");
    pgSyncOne("DELETE FROM workspace_logs WHERE tenant IN ('acme', 'someone')");
    // The port itself, every workspace in the database: where a workspace's
    // records live (records-routing.ts) is tested in records-import.test.ts.
    return { port: pgRecords({ routed: false }), done() {} };
  });

  test("[postgres] the conversation list past its window (Codex round 10): an older conversation still comes when the newest runs are all one", async () => {
    const { pgRecords } = await import("../src/records-pg.ts");
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    const { registerPlatform } = await import("../../foldrun-core/src/platform.ts");
    const { writeRun } = await import("../../foldrun-core/src/store.ts");
    const { listSessions, contextKey } = await import("../../foldrun-core/src/conversation.ts");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-sessions-window-"));
    fs.mkdirSync(path.join(process.env.FOLDRUN_DATA, "win", "workspaces", "desk"), { recursive: true });
    pgSyncOne("DELETE FROM run_records WHERE tenant = 'win'");
    registerPlatform({ records: pgRecords({ routed: false }) } as never);
    const run = (id: string, at: string, ctx: string) => ({ id, flow: "adhoc:a", status: "completed", startedAt: at, finishedAt: at, context: { id: ctx, key: contextKey(ctx) }, steps: [{ agent: "a", instruction: "x", group: 1, optional: false, status: "completed", events: [], costUsd: null }] });
    writeRun("win", "desk", run("b1", "2026-11-01T00:00:00.000Z", "old-b") as never);
    for (let i = 0; i < 3; i++) writeRun("win", "desk", run(`a${i}`, `2026-11-02T0${i}:00:00.000Z`, "busy-a") as never);
    process.env.FOLDRUN_SESSIONS_SCAN = "2";
    try {
      assert.deepEqual(listSessions("win", "desk", 2).map((x) => [x.context, x.turns]), [["busy-a", 3], ["old-b", 1]]);
      // The fallback adds to what the window found, never replaces it: one key looked at, the window's still listed (Codex round 12).
      process.env.FOLDRUN_SESSIONS_KEYS = "1";
      assert.ok(listSessions("win", "desk", 2).some((x) => x.context === "busy-a"));
      delete process.env.FOLDRUN_SESSIONS_KEYS;
      // A count past its cap is said as at least that many.
      process.env.FOLDRUN_SESSIONS_TURNS_MAX = "2";
      const capped = listSessions("win", "desk", 2);
      assert.deepEqual([capped[0]!.turns, capped[0]!.turnsMore], [2, true]);
      assert.equal(capped[1]!.turnsMore, undefined);
    } finally {
      delete process.env.FOLDRUN_SESSIONS_SCAN;
      delete process.env.FOLDRUN_SESSIONS_KEYS;
      delete process.env.FOLDRUN_SESSIONS_TURNS_MAX;
      pgSyncOne("DELETE FROM run_records WHERE tenant = 'win'");
    }
  });

}
