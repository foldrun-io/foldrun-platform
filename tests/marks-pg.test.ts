// The platform's own bookkeeping as rows (FOL-126, 13 Nov 2026): marks.ts on
// real Postgres, and the callers that moved to it — unsettled charges listed
// from rows AND the files an older release wrote, a pause told once however
// many pods ask, warm-up status written by one pod and read by another.
//
//   FOLDRUN_TEST_DATABASE_URL=postgres://… node --test tests/marks-pg.test.ts

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { takeTurnsOnLiveDb } from "./live-db-lock.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
takeTurnsOnLiveDb(url);
const live = { skip: url ? false : "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" };

if (url) {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-marks-"));
  before(async () => {
    const { migrate } = await import("../src/db.ts");
    await migrate();
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    pgSyncOne("DELETE FROM platform_marks WHERE tenant LIKE 'marks-%' OR tenant = ''");
  });
  after(async () => {
    const { closePgSync } = await import("../src/pg-sync.ts");
    await closePgSync();
    const { db } = await import("../src/db.ts");
    await db()?.end();
  });
}

test("marks: put replaces, a claim changes once per value, list by account or across, delete, an account's go with it", live, async () => {
  const m = await import("../src/marks.ts");
  m.markPut("marks-a", "accrued", "", { day: "2026-11-12" });
  m.markPut("marks-a", "accrued", "", { day: "2026-11-13" });
  assert.deepEqual(m.markGet("marks-a", "accrued"), { day: "2026-11-13" });
  assert.equal(m.markClaim("marks-a", "pause-notice", "ws/f", { runId: "r1" }), true);
  assert.equal(m.markClaim("marks-a", "pause-notice", "ws/f", { runId: "r1" }), false, "the same finish: told already");
  assert.equal(m.markClaim("marks-a", "pause-notice", "ws/f", { runId: "r2" }), true, "a later finish is told");
  m.markPut("marks-b", "unsettled", "run-9", { runId: "run-9" });
  m.markPut("marks-a", "unsettled", "run-1", { runId: "run-1" });
  assert.deepEqual(m.markList("marks-a", "unsettled").map((x) => x.key), ["run-1"]);
  assert.deepEqual(m.markList(null, "unsettled").filter((x) => x.tenant.startsWith("marks-")).map((x) => `${x.tenant}/${x.key}`), ["marks-a/run-1", "marks-b/run-9"]);
  m.markDelete("marks-a", "unsettled", "run-1");
  assert.equal(m.markGet("marks-a", "unsettled", "run-1"), undefined);
  m.deleteTenantMarks("marks-a");
  assert.equal(m.markGet("marks-a", "accrued"), undefined);
  assert.deepEqual(m.markGet("marks-b", "unsettled", "run-9"), { runId: "run-9" }, "another account's stay");
});

test("unsettled charges: rows and an older release's files are both listed, once each", live, async () => {
  const { listUnsettled } = await import("../src/settle.ts");
  const m = await import("../src/marks.ts");
  const dir = path.join(process.env.FOLDRUN_DATA!, "marks-c", "unsettled");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "run-old.json"), JSON.stringify({ tenant: "marks-c", workspace: "w", runId: "run-old", at: "", error: "x", attempts: 1 }));
  fs.writeFileSync(path.join(dir, "run-both.json"), JSON.stringify({ tenant: "marks-c", workspace: "w", runId: "run-both", at: "", error: "file", attempts: 1 }));
  m.markPut("marks-c", "unsettled", "run-both", { tenant: "marks-c", workspace: "w", runId: "run-both", at: "", error: "row", attempts: 2 });
  m.markPut("marks-c", "unsettled", "run-new", { tenant: "marks-c", workspace: "w", runId: "run-new", at: "", error: "row", attempts: 1 });
  const got = listUnsettled("marks-c").sort((a, b) => a.runId.localeCompare(b.runId));
  assert.deepEqual(got.map((u) => [u.runId, u.error]), [["run-both", "row"], ["run-new", "row"], ["run-old", "x"]], "the row wins where both exist");
});

test("warm-up status: a row written by the worker is what the web reads, over an older file", live, async () => {
  const { readWarmStatus } = await import("../src/runtime-warm.ts");
  const m = await import("../src/marks.ts");
  fs.mkdirSync(path.join(process.env.FOLDRUN_DATA!, "marks-d"), { recursive: true });
  fs.writeFileSync(path.join(process.env.FOLDRUN_DATA!, "marks-d", ".runtime-status.json"), JSON.stringify({ fp1: { ok: false, state: "building" }, fp2: { ok: true, state: "ready" } }));
  m.markPut("marks-d", "runtime-status", "fp1", { ok: true, state: "ready" });
  const s = readWarmStatus("marks-d") as unknown as Record<string, { state: string }>;
  assert.equal(s.fp1.state, "ready");
  assert.equal(s.fp2.state, "ready");
});

test("an unsettled marker survives the database being the thing that failed (Codex review)", live, async () => {
  const marks = await import("../src/marks.ts");
  const { settleRun, listUnsettled } = await import("../src/settle.ts");
  // The row write fails as if the database were gone: the marker is a file.
  marks.failMarkWritesForTests(true);
  try {
    const run = { id: "run-x", flow: "f", status: "completed", startedAt: new Date().toISOString(), steps: [] };
    const store = await import("../../foldrun-core/src/store.ts");
    fs.mkdirSync(path.join(process.env.FOLDRUN_DATA!, "marks-e", "workspaces", "w"), { recursive: true });
    store.writeRun("marks-e", "w", run as never);
    const r = await settleRun("marks-e", "w", "run-x", { charge: async () => { throw new Error("database down"); }, backoffMs: [] } as never);
    assert.equal(r, false);
  } finally {
    marks.failMarkWritesForTests(false);
  }
  assert.ok(fs.existsSync(path.join(process.env.FOLDRUN_DATA!, "marks-e", "unsettled", "run-x.json")), "kept as a file");
  assert.deepEqual(listUnsettled("marks-e").map((u) => u.runId), ["run-x"]);
});
