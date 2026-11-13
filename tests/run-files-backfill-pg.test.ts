// The one-time copy of old runs' outputs and captured calls from their run
// folders into the stores (FOL-126), on Postgres with the platform wired:
// copied once, read back from the stores, a second pass copies nothing.
//
//   FOLDRUN_TEST_DATABASE_URL=postgres://… node --test tests/run-files-backfill-pg.test.ts

import { test, after } from "node:test";
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
  process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-backfill-"));
  process.env.FOLDRUN_SECRET_KEY ??= "test-install-key";
  after(async () => {
    const { closePgSync } = await import("../src/pg-sync.ts");
    await closePgSync();
    const { db } = await import("../src/db.ts");
    await db()?.end();
  });
}

test("old runs' outputs and calls are copied into the stores once, and read back from them", live, async () => {
  const { migrate } = await import("../src/db.ts");
  await migrate();
  const { installPlatform } = await import("../src/index.ts");
  installPlatform();
  const { workspaceDir, writeRun } = await import("../../foldrun-core/src/store.ts");
  const T = `bf${Date.now().toString(36)}`;
  const W = "desk";
  // Records in the database for this workspace, as every one on dev is.
  const { pgSyncOne } = await import("../src/pg-sync.ts");
  pgSyncOne("INSERT INTO records_routing (tenant, workspace, state) VALUES ($1, $2, 'database') ON CONFLICT DO NOTHING", [T, W]);
  const root = workspaceDir(T, W);
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "---\nname: desk\n---\n");
  const runId = "run-old-1";
  writeRun(T, W, { id: runId, flow: "f", status: "completed", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), steps: [] } as never);
  fs.mkdirSync(path.join(root, "runs", runId, "outputs", "writer"), { recursive: true });
  fs.writeFileSync(path.join(root, "runs", runId, "outputs", "writer", "draft.md"), "the draft\n");
  fs.mkdirSync(path.join(root, "runs", runId, "calls"), { recursive: true });
  fs.writeFileSync(path.join(root, "runs", runId, "calls", "toolu_1.json"), JSON.stringify({ id: "toolu_1", tool: "web", input: "q", output: "a" }));

  const { backfillRunFiles } = await import("../src/run-files-backfill.ts");
  const dry = await backfillRunFiles({ write: false, tenants: [T] });
  assert.deepEqual([dry.outputs.copied, dry.calls.copied], [1, 1], "a dry run counts");
  const first = await backfillRunFiles({ write: true, tenants: [T] });
  assert.deepEqual([first.outputs.copied, first.calls.copied, first.failures], [1, 1, []]);
  const again = await backfillRunFiles({ write: true, tenants: [T] });
  assert.deepEqual([again.outputs.copied, again.outputs.present, again.calls.copied, again.calls.present], [0, 1, 0, 1], "a second pass copies nothing");

  // Read back from the stores, with the folder gone.
  fs.rmSync(path.join(root, "runs", runId), { recursive: true, force: true });
  const { readRunOutput } = await import("../../foldrun-core/src/run-outputs.ts");
  assert.equal((await readRunOutput(T, W, runId, "writer", "draft.md"))?.toString(), "the draft\n");
  const { readCapturedCallAsync } = await import("../../foldrun-core/src/captured-calls.ts");
  assert.equal((await readCapturedCallAsync(T, W, runId, "toolu_1"))?.output, "a");
});

test("a run whose outputs the store holds only in part is copied again, never counted as done (Codex review)", live, async () => {
  const { workspaceDir, writeRun } = await import("../../foldrun-core/src/store.ts");
  const { pgSyncOne } = await import("../src/pg-sync.ts");
  const { backfillRunFiles } = await import("../src/run-files-backfill.ts");
  const T = `bp${Date.now().toString(36)}`;
  const W = "desk";
  pgSyncOne("INSERT INTO records_routing (tenant, workspace, state) VALUES ($1, $2, 'database') ON CONFLICT DO NOTHING", [T, W]);
  const root = workspaceDir(T, W);
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "---\nname: desk\n---\n");
  writeRun(T, W, { id: "run-p", flow: "f", status: "completed", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), steps: [] } as never);
  const out = path.join(root, "runs", "run-p", "outputs", "writer");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "a.md"), "a\n");
  assert.deepEqual((await backfillRunFiles({ write: true, tenants: [T] })).outputs.copied, 1);
  // A file the store does not have yet (written after, or refused before).
  fs.writeFileSync(path.join(out, "b.md"), "b\n");
  const again = await backfillRunFiles({ write: true, tenants: [T] });
  assert.deepEqual([again.outputs.copied, again.outputs.present], [1, 0], "copied again");
  const { readRunOutput } = await import("../../foldrun-core/src/run-outputs.ts");
  assert.equal((await readRunOutput(T, W, "run-p", "writer", "b.md"))?.toString(), "b\n");
  assert.deepEqual((await backfillRunFiles({ write: true, tenants: [T] })).outputs.present, 1);
});
