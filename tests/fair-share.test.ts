// FOL-123: one account flooding the queue does not move anyone else's wait.
// The real file queue's claim (queue.ts claimNext) under the flood
// simulation (fair-share-sim.ts); the Postgres claim runs the same
// simulation in postgres-live.test.ts.
//
//   node --test tests/fair-share.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { simulate, type Claimer } from "./fair-share-sim.ts";

process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-fair-"));
delete process.env.FOLDRUN_DATABASE_URL;
const { claimNext, fairOrder, accountQueueTop } = await import("../src/queue.ts");

const root = () => path.join(process.env.FOLDRUN_DATA!, "queue");

/** The file queue, fed the way enqueue names its files: arrival order in the
 *  name, the account in the body. */
const fileQueue: Claimer = {
  async reset() {
    fs.rmSync(root(), { recursive: true, force: true });
    fs.mkdirSync(path.join(root(), "pending"), { recursive: true });
  },
  async enqueue(tenant, runId, n) {
    fs.writeFileSync(path.join(root(), "pending", `${String(n).padStart(14, "0")}000000-${runId}.json`), JSON.stringify({ tenant, workspace: "desk", runId }));
  },
  async claim() {
    const got = await claimNext();
    return got ? { tenant: got.job.tenant, runId: got.job.runId, release: got.release } : null;
  },
};

/** What claimNext did before it counted claimed jobs, and plain FIFO: the
 *  controls, so the test is seen to tell fair from unfair. */
function control(order: (pending: { name: string; tenant: string; runId: string }[], claimed: Map<string, number>) => string): Claimer {
  let pending: { name: string; tenant: string; runId: string }[] = [];
  const claimed = new Map<string, number>();
  return {
    async reset() { pending = []; claimed.clear(); },
    async enqueue(tenant, runId, n) { pending.push({ name: `${String(n).padStart(14, "0")}-${runId}.json`, tenant, runId }); },
    async claim() {
      if (!pending.length) return null;
      const name = order(pending, claimed);
      const job = pending.find((p) => p.name === name)!;
      pending = pending.filter((p) => p !== job);
      claimed.set(job.tenant, (claimed.get(job.tenant) ?? 0) + 1);
      return { tenant: job.tenant, runId: job.runId, release: async () => void claimed.set(job.tenant, claimed.get(job.tenant)! - 1) };
    },
  };
}

test("a flood of 500 runs from one account leaves every other account's wait where it was", async () => {
  const quietAlone = await simulate(fileQueue, { flood: 0 });
  const withFlood = await simulate(fileQueue, { flood: 500 });
  for (const [tenant, wait] of Object.entries(withFlood.maxWait)) {
    // One turn: a job's length (2 ticks) is the most a slot can take to free.
    assert.ok(wait <= quietAlone.maxWait[tenant] + 2, `${tenant}: waited ${wait} ticks with the flood, ${quietAlone.maxWait[tenant]} without`);
  }
  // Gentle, not a lockout: the flood still gets every slot the others leave.
  assert.ok(withFlood.floodRan >= 50, `the flood still ran ${withFlood.floodRan} jobs`);
  assert.equal(withFlood.idleWhileWaiting, 0, "no slot sits idle while anything waits");

  // The controls: FIFO, and the snapshot round robin without claimed counts,
  // both put the quiet accounts behind the backlog.
  const fifo = await simulate(control((p) => [...p].sort((a, b) => a.name.localeCompare(b.name))[0].name), { flood: 500 });
  const snapshot = await simulate(control((p) => fairOrder(p)[0]), { flood: 500 });
  for (const r of [fifo, snapshot]) assert.ok(Math.max(...Object.values(r.maxWait)) > 20, `the control is unfair: ${JSON.stringify(r.maxWait)}`);
  // And the order this claim uses, fed the same way, is fair.
  const counted = await simulate(control((p, c) => fairOrder(p, c)[0]), { flood: 500 });
  assert.ok(Math.max(...Object.values(counted.maxWait)) <= 2, JSON.stringify(counted.maxWait));
});

test("fairOrder counts what is running: an account with jobs claimed waits its turn", () => {
  const entries = [
    { name: "00000000000001-run-f1.json", tenant: "flood" },
    { name: "00000000000002-run-f2.json", tenant: "flood" },
    { name: "00000000000009-run-q1.json", tenant: "quiet" },
  ];
  assert.equal(fairOrder(entries)[0], "00000000000001-run-f1.json", "nothing running: the oldest account first");
  assert.equal(fairOrder(entries, new Map([["flood", 3]]))[0], "00000000000009-run-q1.json", "flood has three running: the quiet account's first job goes now");
  assert.deepEqual(fairOrder(entries, new Map([["flood", 1]])), ["00000000000009-run-q1.json", "00000000000001-run-f1.json", "00000000000002-run-f2.json"]);
});

test("the per-account gauges rank the busiest accounts, never naming one", async () => {
  await fileQueue.reset();
  for (let i = 0; i < 7; i++) await fileQueue.enqueue("big", `run-b${i}`, i);
  for (let i = 0; i < 2; i++) await fileQueue.enqueue("small", `run-s${i}`, 10 + i);
  await fileQueue.enqueue("one", "run-o1", 20);
  const claimed = await fileQueue.claim();
  assert.equal(claimed!.tenant, "big", "the oldest account's first job");
  const top = await accountQueueTop(5);
  assert.deepEqual(top.pending, [6, 2, 1]);
  assert.deepEqual(top.claimed, [1]);
  assert.equal(top.oldestPendingSecs.length, 3);
  assert.ok(!JSON.stringify(top).includes("big"), "counts only");
  await claimed!.release();
});
