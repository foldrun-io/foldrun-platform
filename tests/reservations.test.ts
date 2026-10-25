// Admission holds a run's share: the caps and the funds gate read what is
// held, not only what is spent, so a burst cannot all pass at once.
//
//   node --test tests/reservations.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { enqueueFlowRun, heldForRunsUsd, stopRun } from "../src/queue.ts";
import { expectedRunUsd, listReservations, reserveAdmission, bindReservation, dropReservation, sweepReservations, reservationTotals } from "../src/reservations.ts";
import { recordRunCost } from "../src/ledger.ts";
import { settleRun } from "../src/settle.ts";
import { readRun, writeRun } from "../../foldrun-core/src/store.ts";

const STEP = { agent: "writer", instruction: "draft it", group: 1, optional: false };
const VARS = ["FOLDRUN_DATA", "FOLDRUN_BILLING", "FOLDRUN_MAX_RUN_EXPOSURE", "FOLDRUN_MARGIN", "FOLDRUN_REDIS_URL"] as const;

async function withWorkspace(front: string, body: (root: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-reserve-"));
  const prev = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  for (const k of VARS) delete process.env[k];
  process.env.FOLDRUN_DATA = root;
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "agents/writer"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), `---\nname: desk\n${front}---\n`);
    fs.writeFileSync(path.join(ws, "agents/writer/agent.md"), "---\nname: writer\n---\nWrite.\n");
    await body(root);
  } finally {
    for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v as string);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const status = (r: PromiseSettledResult<unknown>) => (r.status === "rejected" ? (r.reason as { status?: number }).status : "ok");

test("a hold whose record was never written is dropped; the sweep frees holds of finished runs and orphans", async () => {
  await withWorkspace("budget: 50\n", async () => {
    const id = await reserveAdmission("acme", "desk", "nightly");
    assert.ok(id);
    await dropReservation("acme", id);
    assert.equal((await listReservations("acme")).length, 0);

    const run = await enqueueFlowRun("acme", "desk", [STEP], "nightly");
    const orphan = await reserveAdmission("acme", "desk", "nightly");
    await bindReservation("acme", orphan, "run-that-never-existed");
    const unbound = await reserveAdmission("acme", "desk", "nightly");
    assert.equal((await listReservations("acme")).length, 3);
    assert.equal(await sweepReservations("acme"), 1, "the orphan: no record. The live run and the fresh unbound hold stay.");
    const rec = readRun("acme", "desk", run.id)!;
    rec.status = "failed";
    writeRun("acme", "desk", rec);
    assert.equal(await sweepReservations("acme", Date.now() + 2 * 3600_000), 2, "the finished run's hold, and an unbound hold over an hour old");
    assert.equal((await listReservations("acme")).length, 0);
    assert.deepEqual(await reservationTotals(), { count: 0, usd: 0 });
    assert.ok(unbound);
  });
});

test("with no billing and no budget the gate holds nothing and costs nothing", async () => {
  await withWorkspace("", async () => {
    const run = await enqueueFlowRun("acme", "desk", [STEP], "free");
    assert.ok(run);
    assert.equal((await listReservations("acme")).length, 0);
    assert.ok(!fs.existsSync(path.join(process.env.FOLDRUN_DATA!, "acme/reservations.json")));
  });
});
