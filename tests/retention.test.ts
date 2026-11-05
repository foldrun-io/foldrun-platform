// FOL-124: what the platform keeps and for how long — run content 90 days
// after the run finished unless the operator says otherwise, the audit log
// 365 (with a database), the ledger for ever — and the delete a customer
// makes themselves. The Postgres half of the audit window is in
// postgres-live.test.ts.
//
//   node --test tests/retention.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-retention-"));
process.env.FOLDRUN_DATA = ROOT;
delete process.env.FOLDRUN_DATABASE_URL;
delete process.env.FOLDRUN_RETENTION_DAYS;
delete process.env.FOLDRUN_AUDIT_RETENTION_DAYS;

const { runRetentionCutoff, auditRetentionCutoff, pruneRunHistory, pruneAuditLog } = await import("../src/retention.ts");
const { settleRun } = await import("../src/settle.ts");
const { resetSettingsSnapshot, settingDef } = await import("../src/settings.ts");
const { writeRun, readRun, deleteRun, listRunSummaries, workspaceDir } = await import("../../foldrun-core/src/store.ts");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-05T12:00:00Z");

function workspace(ws = "desk") {
  const dir = path.join(ROOT, "acme/workspaces", ws);
  fs.mkdirSync(path.join(dir, "agents/writer"), { recursive: true });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), `---\nname: ${ws}\n---\n`);
  fs.writeFileSync(path.join(dir, "agents/writer/agent.md"), "---\nname: writer\n---\nWrite.\n");
}

let n = 0;
function finished(daysAgo: number, status: "completed" | "failed" | "running" = "completed", ws = "desk") {
  const id = `run-ret${++n}`;
  const at = new Date(NOW - daysAgo * DAY).toISOString();
  writeRun("acme", ws, {
    id,
    flow: "daily",
    status,
    startedAt: at,
    finishedAt: status === "running" ? null : at,
    steps: [{ agent: "writer", instruction: "x", group: 1, optional: false, status: status === "running" ? "running" : "completed", events: [{ t: at, type: "text", text: "a prompt's reply" }], result: "content", costUsd: 0.01 }],
  } as never);
  // An archived output and a captured call, beside the record.
  const dir = path.join(workspaceDir("acme", ws), "runs", id);
  fs.mkdirSync(path.join(dir, "outputs/writer"), { recursive: true });
  fs.writeFileSync(path.join(dir, "outputs/writer/report.md"), "customer content");
  fs.mkdirSync(path.join(dir, "calls"), { recursive: true });
  fs.writeFileSync(path.join(dir, "calls/c1.json"), "{}");
  return id;
}

test("the defaults: unset keeps for ever (an upgrade deletes nothing); hosted sets 90 and 365; 0 keeps for ever", () => {
  resetSettingsSnapshot();
  assert.equal(settingDef("runs.retention_days")!.default, 0);
  assert.equal(settingDef("audit.retention_days")!.default, 0);
  delete process.env.FOLDRUN_RETENTION_DAYS;
  delete process.env.FOLDRUN_AUDIT_RETENTION_DAYS;
  assert.equal(runRetentionCutoff(NOW), null, "unset: kept for ever, as before");
  assert.equal(auditRetentionCutoff(NOW), null);
  process.env.FOLDRUN_RETENTION_DAYS = "90";
  process.env.FOLDRUN_AUDIT_RETENTION_DAYS = "365";
  resetSettingsSnapshot();
  assert.equal(runRetentionCutoff(NOW), NOW - 90 * DAY, "the hosted platform's 90 days");
  assert.equal(auditRetentionCutoff(NOW), NOW - 365 * DAY);
  process.env.FOLDRUN_RETENTION_DAYS = "0";
  process.env.FOLDRUN_AUDIT_RETENTION_DAYS = "0";
  assert.equal(runRetentionCutoff(NOW), null);
  assert.equal(auditRetentionCutoff(NOW), null);
  process.env.FOLDRUN_RETENTION_DAYS = "30";
  assert.equal(runRetentionCutoff(NOW), NOW - 30 * DAY);
  // The operator's row over the variable: settings.test.ts (the reader's precedence).
  delete process.env.FOLDRUN_RETENTION_DAYS;
  delete process.env.FOLDRUN_AUDIT_RETENTION_DAYS;
});

test("the prune deletes finished runs past the window — record, outputs and captured calls — and nothing else", async () => {
  workspace();
  const old = finished(91);
  const oldFailed = finished(120, "failed");
  const recent = finished(89);
  const live = finished(200, "running");
  // A run whose charge is still to be recorded: the record is what settles it.
  const owed = finished(150);
  assert.equal(await settleRun("acme", "desk", owed, { charge: async () => { throw new Error("ledger down"); }, backoffMs: [] }), false);

  const pruned = pruneRunHistory("acme", NOW - 90 * DAY);
  assert.equal(pruned, 2);
  for (const id of [old, oldFailed]) {
    assert.equal(readRun("acme", "desk", id), null, `${id}: past the window`);
    assert.ok(!fs.existsSync(path.join(workspaceDir("acme", "desk"), "runs", id)), `${id}: its outputs and captured calls go with it`);
  }
  assert.ok(readRun("acme", "desk", recent), "89 days: kept");
  assert.ok(readRun("acme", "desk", live), "a live run is never pruned, however old");
  assert.ok(readRun("acme", "desk", owed), "an unsettled run is kept until its charge is recorded");
  assert.ok(!listRunSummaries("acme", "desk").some((r) => r.id === old), "the runs index forgets it too");
});

test("a person's delete takes the record and its folder, and a delete that failed halfway can be finished", () => {
  workspace();
  const id = finished(1);
  const dir = path.join(workspaceDir("acme", "desk"), "runs", id);
  // The folder is left behind with no record — what a crash between the two
  // removals used to leave, for ever, since a retry found no record.
  fs.rmSync(path.join(workspaceDir("acme", "desk"), "runs", `${id}.json`));
  assert.ok(fs.existsSync(dir));
  assert.equal(deleteRun("acme", "desk", id), true, "the leftover folder is still this run's to delete");
  assert.ok(!fs.existsSync(dir));
  assert.equal(deleteRun("acme", "desk", id), false, "and then there is nothing left");
});

test("without a database the audit log is not pruned — the file numbers its entries by line", async () => {
  assert.equal(await pruneAuditLog(NOW), null);
});
