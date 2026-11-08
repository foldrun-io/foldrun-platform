// FOL-100, 5 Nov 2026: how many runs one account may have waiting for their
// turn, and the most one step may hold on an account whose plan says
// nothing (billing's default). Waiting stays the rule (room-wait, 27 Oct);
// the cap only refuses a NEW run while the account has its limit waiting.
//
//   node --test tests/waiting-cap.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { enqueueFlowRun, enqueueResume, rerunFrom } from "../src/queue.ts";
import { accountCompute, assertWaitingRoom, waitingRunCount, waitingRunsCap, waitsForTurn, WAITING_FLOOR, WAITING_PER_SLOT } from "../src/limits.ts";
import { billing } from "../src/billing.ts";
import { admitTrigger, rollbackTrigger } from "../src/trigger-gate.ts";
import { readTriggerEvents } from "../../foldrun-core/src/trigger-log.ts";
import { accountDir, readRun, writeRun, type FlowInfo, type RunRecord } from "../../foldrun-core/src/store.ts";

const STEP = { agent: "writer", instruction: "draft it", group: 1, optional: false };

async function withAccount(body: () => Promise<void>, env: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-waiting-"));
  const prev: Record<string, string | undefined> = { FOLDRUN_DATA: process.env.FOLDRUN_DATA };
  for (const k of ["FOLDRUN_MAX_WAITING_RUNS", "FOLDRUN_PLAN_CONCURRENCY", "FOLDRUN_ACCOUNT_CONCURRENCY", "FOLDRUN_CONCURRENCY", ...Object.keys(env)]) prev[k] = process.env[k];
  process.env.FOLDRUN_DATA = root;
  for (const k of ["FOLDRUN_MAX_WAITING_RUNS", "FOLDRUN_PLAN_CONCURRENCY", "FOLDRUN_ACCOUNT_CONCURRENCY", "FOLDRUN_CONCURRENCY"]) delete process.env[k];
  Object.assign(process.env, env);
  try {
    for (const ws of ["desk", "other"]) {
      const dir = path.join(root, "acme/workspaces", ws);
      fs.mkdirSync(path.join(dir, "agents/writer"), { recursive: true });
      fs.mkdirSync(path.join(dir, "runs"), { recursive: true });
      fs.writeFileSync(path.join(dir, "AGENTS.md"), `---\nname: ${ws}\n---\n`);
      fs.writeFileSync(path.join(dir, "agents/writer/agent.md"), "---\nname: writer\ndescription: writes\n---\n\nWrite.\n");
    }
    await body();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const step = (over: Partial<RunRecord["steps"][number]> = {}) =>
  ({ agent: "writer", instruction: "x", group: 1, optional: false, status: "pending", events: [], result: null, ...over }) as unknown as RunRecord["steps"][number];

function put(ws: string, id: string, status: RunRecord["status"], extra: Partial<RunRecord> = {}) {
  writeRun("acme", ws, { id, flow: "f", status, startedAt: new Date().toISOString(), finishedAt: null, steps: [step()], ...extra } as RunRecord);
}

test("what waits for its turn: lined up, back for room, let out of a gate — not asleep on its own wait:", () => {
  const now = Date.parse("2026-11-05T00:00:00Z");
  const base = { status: "queued" as const, parkedAt: null, steps: [step()] };
  assert.equal(waitsForTurn(base, now), true, "lined up, never started");
  assert.equal(waitsForTurn({ ...base, status: "running" }, now), false);
  assert.equal(waitsForTurn({ ...base, status: "awaiting-approval" }, now), false);
  const parked = { ...base, parkedAt: "2026-11-04T23:00:00Z" };
  assert.equal(waitsForTurn({ ...parked, steps: [step({ roomWait: { since: "x", why: "y", cpus: 1, memGiB: 1 } })] }, now), true, "back in the queue for room");
  assert.equal(waitsForTurn({ ...parked, steps: [step({ waitUntil: "2026-11-06T00:00:00Z" })] }, now), false, "asleep on wait: 1d");
  assert.equal(waitsForTurn({ ...parked, steps: [step({ waitUntil: "2026-11-04T23:30:00Z" })] }, now), true, "its wait: is over: waiting for a worker");
  assert.equal(waitsForTurn(parked, now), true, "let out of a gate, lined up again");
});

test("the count is the account's, across workspaces, and stops where asked", () =>
  withAccount(async () => {
    put("desk", "r1", "queued");
    put("desk", "r2", "running");
    put("other", "r3", "queued");
    put("other", "r4", "queued", { parkedAt: new Date().toISOString(), steps: [step({ waitUntil: new Date(Date.now() + 3_600_000).toISOString() })] });
    put("other", "r5", "completed");
    assert.equal(waitingRunCount("acme"), 2);
    assert.equal(waitingRunCount("acme", 1), 1, "admission only needs to know the limit is reached");
  }));

test("the limit: 20 a run at once, at least 50; FOLDRUN_MAX_WAITING_RUNS sets it, 0 lifts it", () =>
  withAccount(async () => {
    assert.deepEqual(await waitingRunsCap("acme"), { limit: WAITING_FLOOR, source: "derived", slots: 2 }, "no cap anywhere: a worker's 2 slots");
    process.env.FOLDRUN_PLAN_CONCURRENCY = "4";
    assert.deepEqual(await waitingRunsCap("acme"), { limit: 4 * WAITING_PER_SLOT, source: "derived", slots: 4 });
    fs.writeFileSync(path.join(accountDir("acme"), "AGENTS.md"), "---\nconcurrency: 1\n---\n");
    assert.equal((await waitingRunsCap("acme")).limit, WAITING_FLOOR, "one at a time still gets the floor");
    process.env.FOLDRUN_MAX_WAITING_RUNS = "3";
    assert.deepEqual(await waitingRunsCap("acme"), { limit: 3, source: "install" });
    process.env.FOLDRUN_MAX_WAITING_RUNS = "0";
    assert.deepEqual(await waitingRunsCap("acme"), { limit: null, source: null });
  }));

test("at the limit a new run is refused at once — 409, waiting_cap, nothing written — and an admitted run still comes back", () =>
  withAccount(async () => {
    const a = await enqueueFlowRun("acme", "desk", [STEP], "one");
    await enqueueFlowRun("acme", "other", [STEP], "two");
    const before = fs.readdirSync(path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk/runs")).filter((f) => f.endsWith(".json")).length;
    await assert.rejects(enqueueFlowRun("acme", "desk", [STEP], "three"), (err: Error & { status?: number; code?: string; limit?: number; waiting?: number }) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, "waiting_cap");
      assert.equal(err.limit, 2);
      assert.equal(err.waiting, 2);
      assert.match(err.message, /already has 2 runs waiting for their turn, its limit \(2: the install's FOLDRUN_MAX_WAITING_RUNS\) — nothing was started/);
      return true;
    });
    const after = fs.readdirSync(path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk/runs")).filter((f) => f.endsWith(".json")).length;
    assert.equal(after, before, "no record for a refused run");
    // A run already admitted is never refused on its way back.
    await enqueueResume("acme", "desk", a.id);
    assert.equal(readRun("acme", "desk", a.id)?.status, "queued");
    // A re-run is a new run: refused the same way.
    put("desk", "done", "completed", { finishedAt: new Date().toISOString(), steps: [step({ status: "completed" })] });
    await assert.rejects(rerunFrom("acme", "desk", "done", { step: 1 }), /waiting_cap|runs waiting for their turn/);
    // Room again once one is gone.
    const r = readRun("acme", "desk", a.id)!;
    writeRun("acme", "desk", { ...r, status: "completed", finishedAt: new Date().toISOString() });
    await assert.doesNotReject(enqueueFlowRun("acme", "desk", [STEP], "four"));
  }, { FOLDRUN_MAX_WAITING_RUNS: "2" }));

test("a cheap bound under the limit is an answer without reading a run; at the limit the runs decide", () =>
  withAccount(async () => {
    put("desk", "r1", "queued");
    put("desk", "r2", "queued");
    let read = false;
    await assertWaitingRoom("acme", async () => 1).then(() => (read = true));
    assert.ok(read, "1 job < 2: admitted (the bound is trusted)");
    await assert.rejects(assertWaitingRoom("acme", async () => 5), /waiting for their turn/);
    put("desk", "r2", "completed");
    await assert.doesNotReject(assertWaitingRoom("acme", async () => 5), "5 jobs, but only 1 run waits for its turn");
  }, { FOLDRUN_MAX_WAITING_RUNS: "2" }));

test("a trigger refused by the cap is logged queue-full, not failed", () =>
  withAccount(async () => {
    const flow = { name: "nightly", trigger: "schedule", steps: [STEP] } as unknown as FlowInfo;
    const gate = await admitTrigger("acme", "desk", flow, { tag: "schedule" });
    assert.equal(gate.admit, true);
    await rollbackTrigger("acme", "desk", flow, { reason: "this account already has 50 runs waiting", code: "waiting_cap" });
    await rollbackTrigger("acme", "desk", flow, { reason: "out of credit" });
    const outcomes = readTriggerEvents("acme", "desk").map((e) => e.outcome);
    assert.ok(outcomes.includes("queue-full"), outcomes.join(","));
    assert.ok(outcomes.includes("failed"), "any other refusal is still failed");
  }));

test("an account whose plan sets no step maximum gets billing's default; the install's 0 lifts it; a free install has none", () =>
  withAccount(async () => {
    const b = billing();
    const prev = b.stepMaxDefault;
    try {
      delete (b as { stepMaxDefault?: unknown }).stepMaxDefault;
      const none = await accountCompute("acme", {} as NodeJS.ProcessEnv);
      assert.equal(none.stepVcpu, null, "no default: no step maximum (a self-hosted install)");
      assert.equal("stepDefault" in none, false, "and the shape is as before");
      b.stepMaxDefault = () => ({ stepVcpu: 4, stepMemGiB: 8, stepDiskGiB: 20 });
      const c = await accountCompute("acme", {} as NodeJS.ProcessEnv);
      assert.deepEqual([c.stepVcpu, c.stepMemGiB, c.stepDiskGiB], [4, 8, 20]);
      assert.deepEqual(c.stepDefault, ["stepVcpu", "stepMemGiB", "stepDiskGiB"]);
      const mixed = await accountCompute("acme", { FOLDRUN_STEP_MAX_VCPU: "2", FOLDRUN_STEP_MAX_DISK_GIB: "0" } as NodeJS.ProcessEnv);
      assert.equal(mixed.stepVcpu, 2, "the install's own figure wins over the default");
      assert.equal(mixed.stepDiskGiB, null, "the install's 0 is no cap, default or not");
      assert.deepEqual(mixed.stepDefault, ["stepMemGiB"], "only the figure that came from the default is named");
      b.stepMaxDefault = () => {
        throw new Error("plans unreadable");
      };
      await assert.rejects(accountCompute("acme", {} as NodeJS.ProcessEnv), /plans unreadable/, "a broken default is a fault, never a lifted cap");
    } finally {
      if (prev) b.stepMaxDefault = prev;
      else delete (b as { stepMaxDefault?: unknown }).stepMaxDefault;
    }
  }));

test("a plan sets the waiting-runs limit (FOL-125); the install's number still wins; no plan figure falls back to the derived one", () =>
  withAccount(async () => {
    const b = billing();
    const prev = b.plan;
    try {
      b.plan = async () => ({ name: "starter", concurrency: 20, waitingRuns: 100 });
      assert.deepEqual(await waitingRunsCap("acme"), { limit: 100, source: "plan" }, "the plan's own figure, not 20 × its run cap");
      b.plan = async () => ({ name: "free", concurrency: 5, waitingRuns: 10 });
      assert.deepEqual(await waitingRunsCap("acme"), { limit: 10, source: "plan" }, "Free's 10 is below the old floor of 50");
      assert.deepEqual(await waitingRunsCap("acme", { FOLDRUN_MAX_WAITING_RUNS: "7" } as NodeJS.ProcessEnv), { limit: 7, source: "install" }, "the install's explicit number beats the plan");
      b.plan = async () => ({ name: "custom", concurrency: 4 });
      assert.deepEqual(await waitingRunsCap("acme"), { limit: 4 * WAITING_PER_SLOT, source: "derived", slots: 4 }, "a plan without the figure derives it, as before");
    } finally {
      b.plan = prev;
    }
  }));

test("a start past a plan's limit is refused naming the plan", () =>
  withAccount(async () => {
    const b = billing();
    const prev = b.plan;
    try {
      b.plan = async () => ({ name: "free", waitingRuns: 2 });
      put("desk", "q1", "queued");
      put("desk", "q2", "queued");
      await assert.rejects(assertWaitingRoom("acme"), (err: Error & { status?: number; code?: string }) => err.status === 409 && err.code === "waiting_cap" && /limit \(2: set by its plan\)/.test(err.message));
    } finally {
      b.plan = prev;
    }
  }));
