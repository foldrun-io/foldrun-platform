// runStateById: the pod sweeps' answer to "is this run still going?" — off
// the run index, but never "over" on a row alone, because "over" is what
// lets a pod be deleted (src/scheduler.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeRun, listRunSummaries, runFilePath, type RunRecord } from "../../foldrun-core/src/store.ts";
import { runStateById } from "../src/scheduler.ts";

const record = (id: string, status: RunRecord["status"], extra: Partial<RunRecord> = {}): RunRecord => ({
  id, flow: "publish", status, startedAt: "2026-10-17T01:00:00Z", finishedAt: null, summary: null, steps: [], ...extra,
}) as RunRecord;

test("a run the index calls over is read before it is called over; a live record keeps its pod", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-runstate-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    fs.mkdirSync(path.join(root, "acme/workspaces/desk/runs"), { recursive: true });
    fs.writeFileSync(path.join(root, "acme/workspaces/desk/AGENTS.md"), "---\nname: desk\n---\n");
    writeRun("acme", "desk", record("done", "completed", { finishedAt: "2026-10-17T02:00:00Z" }));
    writeRun("acme", "desk", record("going", "running"));
    writeRun("acme", "desk", record("stopping", "running", { stopRequested: true }));
    writeRun("acme", "desk", record("revived", "completed", { finishedAt: "2026-10-17T02:00:00Z" }));
    listRunSummaries("acme", "desk"); // the index exists, and calls "revived" completed

    const stateOf = runStateById();
    // after the sweep read the index, the record moves on (a rerun in place,
    // a second writer the row has not caught up with)
    fs.writeFileSync(runFilePath("acme", "desk", "revived"), JSON.stringify(record("revived", "running")));

    assert.equal(stateOf("going"), "live");
    assert.equal(stateOf("done"), "over");
    assert.equal(stateOf("stopping"), "over", "a stop asked for is over");
    assert.equal(stateOf("revived"), "live", "the record, not the row, decides over");
    assert.equal(stateOf("nobody"), "unknown");
    fs.rmSync(runFilePath("acme", "desk", "done"));
    const again = runStateById();
    assert.equal(again("done"), "unknown", "gone is unknown, never over");
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
