// A stop removes and kills only what is its own account's (30 Oct 2026,
// defence in depth). stopRun checks the (tenant, workspace, run) record, then
// matched the box-wide queue files and the run pods on the run id alone.
// Now a queue file naming another tenant or workspace stays, and a pod
// labelled for another account is not deleted.
//
//   node --test tests/stop-scope.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-stop-scope-"));
process.env.FOLDRUN_DATA = root;
delete process.env.FOLDRUN_DATABASE_URL;
delete process.env.FOLDRUN_RUN_ISOLATION;

const { stopRun, jobFileIsFor } = await import("../src/queue.ts");
const { runPodsToKill } = await import("../src/run-k8s.ts");
const { accountSegment } = await import("../src/account-pod.ts");
const { writeRun } = await import("../../foldrun-core/src/store.ts");

const RUN = "run-shared-id";
fs.mkdirSync(path.join(root, "acme/workspaces/desk"), { recursive: true });
fs.writeFileSync(path.join(root, "acme/workspaces/desk/AGENTS.md"), "---\nname: desk\n---\n");
writeRun("acme", "desk", {
  id: RUN, flow: "f", status: "queued", startedAt: "2026-10-30T00:00:00.000Z", finishedAt: null,
  steps: [{ agent: "a", instruction: "", group: 1, optional: false, status: "pending", events: [], result: null, costUsd: null }],
} as never);

const pending = path.join(root, "queue/pending");
const claimed = path.join(root, "queue/claimed");
fs.mkdirSync(pending, { recursive: true });
fs.mkdirSync(claimed, { recursive: true });
const job = (dir: string, prefix: string, tenant: string, workspace: string) => {
  const f = path.join(dir, `${prefix}-${RUN}.json`);
  fs.writeFileSync(f, JSON.stringify({ tenant, workspace, runId: RUN }));
  return f;
};

test("jobFileIsFor: only a file that reads as someone else's is not ours", () => {
  const mine = job(os.tmpdir(), `scope-a-${process.pid}`, "acme", "desk");
  const other = job(os.tmpdir(), `scope-b-${process.pid}`, "globex", "desk");
  const otherWs = job(os.tmpdir(), `scope-c-${process.pid}`, "acme", "ops");
  const torn = path.join(os.tmpdir(), `scope-d-${process.pid}-${RUN}.json`);
  fs.writeFileSync(torn, "{not json");
  assert.equal(jobFileIsFor(mine, "acme", "desk"), true);
  assert.equal(jobFileIsFor(other, "acme", "desk"), false);
  assert.equal(jobFileIsFor(otherWs, "acme", "desk"), false);
  assert.equal(jobFileIsFor(torn, "acme", "desk"), true, "unreadable names this run only, and goes as before");
  for (const f of [mine, other, otherWs, torn]) fs.rmSync(f, { force: true });
});

test("stopRun removes this workspace's queue files and leaves another account's with the same run id", () => {
  const mine = job(pending, "00000000000001000001", "acme", "desk");
  const theirs = job(claimed, "00000000000001000002", "globex", "desk");
  const run = stopRun("acme", "desk", RUN);
  assert.equal(run.status, "failed");
  assert.equal(fs.existsSync(mine), false, "its own job is gone");
  assert.equal(fs.existsSync(theirs), true, "another account's job is untouched");
});

test("runPodsToKill: another account's pod stays; an unlabelled one is still the run's", () => {
  const mine = accountSegment("acme");
  const out = [
    `pod/run-a ${mine}`,
    "pod/run-b globex",
    "pod/run-c ",
    "Warning: something on stderr",
    "",
  ].join("\n");
  assert.deepEqual(runPodsToKill(out, "acme"), ["pod/run-a", "pod/run-c"]);
  assert.deepEqual(runPodsToKill(out), ["pod/run-a", "pod/run-b", "pod/run-c"], "no scope is the old match on the run id");
});
