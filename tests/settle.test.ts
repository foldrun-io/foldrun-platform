// Settling a run's bill: awaited, retried, and never silently lost.
//
//   node --test tests/settle.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { settleRun, listUnsettled, redriveUnsettled, unsettledCount } from "../src/settle.ts";
import { readRun, writeRun, type RunRecord } from "../../foldrun-core/src/store.ts";
import { readLedger } from "../src/ledger.ts";

async function withRun(body: (run: RunRecord) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-settle-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    fs.mkdirSync(path.join(root, "acme/workspaces/desk"), { recursive: true });
    fs.writeFileSync(path.join(root, "acme/workspaces/desk/AGENTS.md"), "---\nname: desk\n---\n");
    const run: RunRecord = {
      id: "run-1",
      flow: "nightly",
      tags: [],
      status: "completed",
      startedAt: "2026-09-15T00:00:00.000Z",
      finishedAt: "2026-09-15T00:01:00.000Z",
      steps: [{ agent: "writer", instruction: "x", group: 1, optional: false, status: "completed", events: [], result: "ok", costUsd: 0.5, computeSecs: 10, attempts: 1 } as unknown as RunRecord["steps"][number]],
    };
    writeRun("acme", "desk", run);
    await body(run);
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("a charge that keeps failing is retried, then marked unsettled with a line on the run's trail", async () => {
  await withRun(async () => {
    let calls = 0;
    const charge = async () => {
      calls++;
      throw new Error("connection refused");
    };
    const quiet: string[] = [];
    const result = await settleRun("acme", "desk", "run-1", { charge, backoffMs: [1, 1], log: (l) => quiet.push(l) });
    assert.equal(result, false);
    assert.equal(calls, 3, "one try per backoff, plus the first");
    const marks = listUnsettled("acme");
    assert.equal(marks.length, 1);
    assert.equal(marks[0].runId, "run-1");
    assert.equal(marks[0].attempts, 3);
    assert.match(marks[0].error, /connection refused/);
    assert.equal(unsettledCount(), 1);
    const trail = readRun("acme", "desk", "run-1")!.steps[0].events;
    assert.equal(trail.length, 1);
    assert.equal(trail[0].type, "error");
    assert.match(trail[0].text, /billing: the charge could not be recorded after 3 attempts \(connection refused\) — marked unsettled/);
    assert.match(quiet[0], /unsettled after 3 attempt/);
    // Failing again adds to the count and does not repeat the trail line.
    await settleRun("acme", "desk", "run-1", { charge, backoffMs: [], log: () => {} });
    assert.equal(listUnsettled("acme")[0].attempts, 4);
    assert.equal(readRun("acme", "desk", "run-1")!.steps[0].events.length, 1);
  });
});

test("a blip that clears on the second try settles normally and marks nothing", async () => {
  await withRun(async () => {
    let calls = 0;
    const charge = async () => {
      if (calls++ === 0) throw new Error("blip");
      return { t: "x", kind: "run" as const, usd: -1 };
    };
    const result = await settleRun("acme", "desk", "run-1", { charge, backoffMs: [1, 1] });
    assert.ok(result && result.usd === -1);
    assert.equal(listUnsettled("acme").length, 0);
    assert.equal(readRun("acme", "desk", "run-1")!.steps[0].events.length, 0);
  });
});

