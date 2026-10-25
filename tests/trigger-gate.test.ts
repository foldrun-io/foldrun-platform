// The gate between a trigger firing and a run existing, and the schedule's
// answer to a fire it slept through.
//
//   node --test tests/trigger-gate.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFlow, type FlowInfo, type RunRecord } from "../../foldrun-core/src/store.ts";
import { admitTrigger, dueDebounced, pauseReason, quarantineReason, resetTriggerState } from "../src/trigger-gate.ts";
import { findDueFlows, parseCron, lastFireIn } from "../src/scheduler.ts";
import { setPaused } from "../src/admin.ts";

/** A workspace on disk with the flows and runs a case needs. */
function workspace(flows: Record<string, string>, runs: RunRecord[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-gate-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  const ws = path.join(root, "acme/workspaces/desk");
  fs.mkdirSync(path.join(ws, "flows"), { recursive: true });
  fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
  for (const [name, body] of Object.entries(flows)) fs.writeFileSync(path.join(ws, "flows", `${name}.md`), body);
  for (const run of runs) fs.writeFileSync(path.join(ws, "runs", `${run.id}.json`), JSON.stringify(run));
  void resetTriggerState();
  return {
    done() {
      if (prev === undefined) delete process.env.FOLDRUN_DATA;
      else process.env.FOLDRUN_DATA = prev;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const flow = (frontmatter: string): FlowInfo =>
  parseFlow("orders.md", `---\nname: orders\ntrigger: webhook\n${frontmatter}\n---\n\n1. [[a]] — go\n`);

const ranAt = (id: string, status: RunRecord["status"], minutesAgo: number, startedBy?: string): RunRecord => ({
  id,
  flow: "orders",
  status,
  startedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  finishedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  ...(startedBy ? { startedBy } : {}),
  steps: [],
});

// ---------------------------------------------------------- idempotency

test("the same delivery id is one run; a different one is another", async () => {
  const w = workspace({ orders: "---\nname: orders\n---\n1. [[a]] — go\n" });
  try {
    const f = flow("idempotency: x-delivery");
    assert.equal((await admitTrigger("acme", "desk", f, { deliveryKey: "d-1" })).admit, true);
    const second = await admitTrigger("acme", "desk", f, { deliveryKey: "d-1" });
    assert.equal(second.admit, false);
    assert.equal(second.admit === false && second.reason, "duplicate");
    assert.equal((await admitTrigger("acme", "desk", f, { deliveryKey: "d-2" })).admit, true);
  } finally {
    w.done();
  }
});

test("a delivery with no id is admitted — a missing header must not become an outage", async () => {
  const w = workspace({ orders: "---\nname: orders\n---\n1. [[a]] — go\n" });
  try {
    const f = flow("idempotency: x-delivery");
    assert.equal((await admitTrigger("acme", "desk", f, { deliveryKey: null })).admit, true);
    assert.equal((await admitTrigger("acme", "desk", f, { deliveryKey: null })).admit, true);
  } finally {
    w.done();
  }
});

test("ids are scoped to the flow — two flows may legitimately see the same delivery", async () => {
  const w = workspace({ orders: "---\nname: orders\n---\n1. [[a]] — go\n" });
  try {
    const a = flow("idempotency: x-delivery");
    const b = parseFlow("other.md", "---\nname: other\ntrigger: webhook\nidempotency: x-delivery\n---\n\n1. [[a]] — go\n");
    assert.equal((await admitTrigger("acme", "desk", a, { deliveryKey: "d-1" })).admit, true);
    assert.equal((await admitTrigger("acme", "desk", b, { deliveryKey: "d-1" })).admit, true);
  } finally {
    w.done();
  }
});

// ------------------------------------------------------------- throttle

test("throttle drops a trigger inside the window and admits one after it", async () => {
  const w = workspace({ orders: "---\nname: orders\n---\n1. [[a]] — go\n" });
  try {
    const f = flow("throttle: 15m");
    const t0 = Date.now();
    assert.equal((await admitTrigger("acme", "desk", f, { now: t0 })).admit, true);
    const blocked = await admitTrigger("acme", "desk", f, { now: t0 + 60_000 });
    assert.equal(blocked.admit, false);
    assert.equal(blocked.admit === false && blocked.reason, "throttled");
    assert.equal((await admitTrigger("acme", "desk", f, { now: t0 + 16 * 60_000 })).admit, true);
  } finally {
    w.done();
  }
});

// ------------------------------------------------------------- debounce

test("a burst collapses into one run, carrying the last event and the count", async () => {
  const w = workspace({ orders: "---\nname: orders\n---\n1. [[a]] — go\n" });
  try {
    const f = flow("debounce: 2m");
    const t0 = Date.now();
    for (const [i, body] of ["first", "second", "third"].entries()) {
      const held = await admitTrigger("acme", "desk", f, { body, tag: "storage_event", now: t0 + i * 30_000 });
      assert.equal(held.admit, false);
      assert.equal(held.admit === false && held.reason, "debounced");
    }
    // Still inside the window from the last event: nothing is due yet.
    assert.deepEqual(await dueDebounced(t0 + 61_000 + 60_000), []);
    const due = await dueDebounced(t0 + 60_000 + 121_000);
    assert.equal(due.length, 1);
    assert.equal(due[0].flow, "orders");
    assert.equal(due[0].body, "third", "the last event is the state the flow reacts to");
    assert.equal(due[0].count, 3);
    assert.deepEqual(await dueDebounced(t0 + 10 * 60_000), [], "taking it removes it");
  } finally {
    w.done();
  }
});

// -------------------------------------------------------- disable_after

test("consecutive failures quarantine a flow, and one success clears it", async () => {
  const failures = [ranAt("r-1", "failed", 10), ranAt("r-2", "failed", 20), ranAt("r-3", "failed", 30)];
  const w = workspace({ orders: "---\nname: orders\n---\n1. [[a]] — go\n" }, failures);
  try {
    const f = flow("disable_after: 3");
    const blocked = await admitTrigger("acme", "desk", f, {});
    assert.equal(blocked.admit, false);
    assert.equal(blocked.admit === false && blocked.reason, "quarantined");
    assert.equal(quarantineReason("acme", "desk", flow("disable_after: 4")), null, "four failures were not reached");
  } finally {
    w.done();
  }
});

test("a success newer than the failures clears the count", async () => {
  const runs = [ranAt("r-0", "completed", 5), ranAt("r-1", "failed", 10), ranAt("r-2", "failed", 20), ranAt("r-3", "failed", 30)];
  const w = workspace({ orders: "---\nname: orders\n---\n1. [[a]] — go\n" }, runs);
  try {
    assert.equal(quarantineReason("acme", "desk", flow("disable_after: 3")), null);
    assert.equal((await admitTrigger("acme", "desk", flow("disable_after: 3"), {})).admit, true);
  } finally {
    w.done();
  }
});

test("a run a person started is not evidence — testing a fix must not count against it", () => {
  const runs = [ranAt("r-1", "failed", 10, "matt@example.com"), ranAt("r-2", "failed", 20), ranAt("r-3", "failed", 30)];
  const w = workspace({ orders: "---\nname: orders\n---\n1. [[a]] — go\n" }, runs);
  try {
    assert.equal(quarantineReason("acme", "desk", flow("disable_after: 3")), null, "only two automatic failures");
  } finally {
    w.done();
  }
});

test("a busy neighbour's runs do not push a flow's own verdict out of the window", async () => {
  const other = (i: number): RunRecord => ({ ...ranAt(`run-z${String(i).padStart(3, "0")}`, "completed", 5), flow: "neighbour" });
  const w = workspace({}, [
    ranAt("run-a1", "failed", 30),
    ranAt("run-a2", "failed", 20),
    ranAt("run-a3", "failed", 10),
    saidRun("run-b1", "DONE", 8, { flow: "tidy" }),
    // Newer than all of the above, and far more of them than the window.
    ...Array.from({ length: 150 }, (_, i) => other(i)),
  ]);
  try {
    assert.match(quarantineReason("acme", "desk", flow("disable_after: 3")) ?? "", /last 3 runs of this flow failed/);
    const tidy = parseFlow("tidy.md", "---\nname: tidy\ntrigger: schedule\npause_when: DONE\n---\n\n1. [[a]] — go\n");
    assert.equal(pauseReason("acme", "desk", tidy)?.runId, "run-b1");
    // Asked again — the answer from what it learnt, still the same.
    assert.match(quarantineReason("acme", "desk", flow("disable_after: 3")) ?? "", /last 3 runs/);
  } finally {
    w.done();
  }
});

test("no disable_after means never quarantined, however bad the week was", () => {
  const runs = [1, 2, 3, 4, 5, 6].map((n) => ranAt(`r-${n}`, "failed", n * 10));
  const w = workspace({ orders: "---\nname: orders\n---\n1. [[a]] — go\n" }, runs);
  try {
    assert.equal(quarantineReason("acme", "desk", flow("description: plain")), null);
  } finally {
    w.done();
  }
});

// --------------------------------------------------------------- catchup

test("lastFireIn reports the most recent match, which is what tells late from missed", () => {
  const cron = parseCron("0 5 * * *")!;
  const from = new Date("2026-09-05T04:00:00Z");
  const now = new Date("2026-09-07T12:00:00Z");
  assert.equal(lastFireIn(cron, from, now, "UTC")?.toISOString(), "2026-09-07T05:00:00.000Z");
  assert.equal(lastFireIn(cron, new Date("2026-09-07T06:00:00Z"), now, "UTC"), null);
});

test("catchup: none skips a fire the platform slept through; last still makes it up", () => {
  const w = workspace({
    missed: '---\nname: missed\ntrigger: schedule\nschedule: "0 5 * * *"\ncatchup: none\n---\n1. [[a]] — x\n',
    madeup: '---\nname: madeup\ntrigger: schedule\nschedule: "0 5 * * *"\n---\n1. [[a]] — x\n',
  });
  try {
    // Last seen before this morning's 05:00; noticed at 11:00.
    const lastFired = {
      "acme/desk/missed": "2026-09-06T12:00:00Z",
      "acme/desk/madeup": "2026-09-06T12:00:00Z",
    };
    const due = findDueFlows(new Date("2026-09-07T11:00:00Z"), { lastFired }, ["acme"]);
    assert.deepEqual(
      due.map((d) => d.flow.name),
      ["madeup"],
      "the default still makes one make-up run; catchup: none waits for the next real occurrence",
    );
  } finally {
    w.done();
  }
});

test("a fire a few seconds late is not a make-up run", () => {
  const w = workspace({
    missed: '---\nname: missed\ntrigger: schedule\nschedule: "0 5 * * *"\ncatchup: none\n---\n1. [[a]] — x\n',
  });
  try {
    const lastFired = { "acme/desk/missed": "2026-09-07T04:59:00Z" };
    const due = findDueFlows(new Date("2026-09-07T05:00:20Z"), { lastFired }, ["acme"]);
    assert.deepEqual(due.map((d) => d.flow.name), ["missed"], "a tick running slightly behind is still on time");
  } finally {
    w.done();
  }
});

test("a person's success clears a quarantine; a person's failure does not extend one", () => {
  const w = workspace(
    { orders: "---\nname: orders\n---\n1. [[a]] — go\n" },
    [
      ranAt("r-0", "completed", 5, "matt@example.com"),
      ranAt("r-1", "failed", 10),
      ranAt("r-2", "failed", 20),
      ranAt("r-3", "failed", 30),
    ],
  );
  try {
    // The owner fixed the flow and clicked Run: that success is exactly the
    // evidence that should switch the flow back on.
    assert.equal(quarantineReason("acme", "desk", flow("disable_after: 3")), null);
  } finally {
    w.done();
  }
});

test("a stopped run is not a failure of the flow", () => {
  const stopped = (id: string, m: number) => ({ ...ranAt(id, "failed", m), stopRequested: true });
  const w = workspace({ orders: "---\nname: orders\n---\n1. [[a]] — go\n" }, [stopped("r-1", 10), stopped("r-2", 20), stopped("r-3", 30)]);
  try {
    assert.equal(quarantineReason("acme", "desk", flow("disable_after: 3")), null, "bulk-stopping runs must not switch flows off");
  } finally {
    w.done();
  }
});

test("shares sum to the charge exactly, whatever the rounding", async () => {
  const { attributeToAgents } = await import("../src/ledger.ts");
  const shares = attributeToAgents(
    [
      { agent: "a", costUsd: 1, status: "completed" },
      { agent: "b", costUsd: 1, status: "completed" },
      { agent: "c", costUsd: 1, status: "completed" },
    ],
    1,
  );
  const sum = Object.values(shares).reduce((n, v) => n + v, 0);
  assert.equal(Math.round(sum * 1e6) / 1e6, 1);
});

// ---------------------------------------------------------- pause_when

/** A finished run whose one step replied `reply`. */
const saidRun = (id: string, reply: string, minutesAgo: number, extra: Partial<RunRecord> = {}): RunRecord => ({
  ...ranAt(id, "completed", minutesAgo),
  steps: [{ agent: "planner", instruction: "plan", group: 1, optional: false, status: "completed", result: reply } as unknown as RunRecord["steps"][number]],
  ...extra,
});

test("a flow whose latest run said its pause_when marker is not fired again, and says why", async () => {
  const w = workspace({}, [
    saidRun("run-a", "RESEARCH north-shore\nqueued: 20", 120),
    saidRun("run-b", "DONE\nnothing more to do", 60),
  ]);
  try {
    const f = flow("pause_when: DONE");
    const gate = await admitTrigger("acme", "desk", f);
    assert.equal(gate.admit, false);
    assert.equal(gate.admit === false && gate.reason, "paused");
    assert.match(gate.admit === false ? gate.detail : "", /run-b reported DONE/);
  } finally {
    w.done();
  }
});

test("a run that finds work again lifts the pause by itself", () => {
  const w = workspace({}, [
    saidRun("run-a", "DONE", 120),
    saidRun("run-b", "RESEARCH melbourne-inner", 30, { startedBy: "matt@example.com" }),
  ]);
  try {
    assert.equal(pauseReason("acme", "desk", flow("pause_when: DONE")), null);
  } finally {
    w.done();
  }
});

test("a test run, a stopped run and a run still going are not the flow's verdict", () => {
  const w = workspace({}, [
    saidRun("run-a", "DONE", 120),
    saidRun("run-b", "RESEARCH x", 50, { test: true }),
    saidRun("run-c", "RESEARCH x", 40, { stopRequested: true, status: "failed" }),
    { ...saidRun("run-d", "RESEARCH x", 1), status: "running", finishedAt: null },
  ]);
  try {
    assert.equal(pauseReason("acme", "desk", flow("pause_when: DONE"))?.runId, "run-a");
  } finally {
    w.done();
  }
});

test("the marker must lead a line: saying there is nothing DONE yet is not DONE", () => {
  const w = workspace({}, [saidRun("run-a", "RESEARCH x — none of it is DONE yet\nDONEISH", 10)]);
  try {
    assert.equal(pauseReason("acme", "desk", flow("pause_when: DONE")), null);
    assert.equal(pauseReason("acme", "desk", flow("description: none")), null, "no pause_when, never paused");
  } finally {
    w.done();
  }
});

test("a paused workspace refuses a fire as halted, before the delivery is remembered", async () => {
  const w = workspace({ orders: "---\nname: orders\n---\n1. [[a]] — go\n" });
  try {
    const f = flow("idempotency: x-delivery");
    await setPaused("acme", "desk", { pause: { by: "ana@acme.io", reason: "incident" } });
    const held = await admitTrigger("acme", "desk", f, { deliveryKey: "d-1" });
    assert.equal(held.admit === false && held.reason, "halted");
    assert.match(held.admit === false ? held.detail : "", /this workspace is paused by ana@acme\.io — incident/);
    await setPaused("acme", "desk", { resume: { by: "ana@acme.io" } });
    assert.equal((await admitTrigger("acme", "desk", f, { deliveryKey: "d-1" })).admit, true, "the held delivery is not a duplicate");
  } finally {
    w.done();
  }
});

test("a fire inside a pause window is consumed as halted — not made up after the resume, not called missed", () => {
  const w = workspace({
    madeup: '---\nname: madeup\ntrigger: schedule\nschedule: "0 5 * * *"\n---\n1. [[a]] — x\n',
  });
  try {
    const lastFired = { "acme/desk/madeup": "2026-09-06T12:00:00Z" };
    const pausedAt = (t: string, ws: string, at: number) =>
      t === "acme" && ws === "desk" && at >= Date.parse("2026-09-07T04:00:00Z") && at <= Date.parse("2026-09-07T06:00:00Z");
    const state = { lastFired };
    assert.deepEqual(findDueFlows(new Date("2026-09-07T11:00:00Z"), state, ["acme"], undefined, undefined, pausedAt), []);
    assert.equal(state.lastFired["acme/desk/madeup"], "2026-09-07T11:00:00.000Z", "the tick is consumed");
  } finally {
    w.done();
  }
});

test("a trigger: once whose moment fell inside a pause is recorded, not run", () => {
  const w = workspace({
    launch: '---\nname: launch\ntrigger: once\nat: "2026-09-07T05:00:00Z"\n---\n1. [[a]] — x\n',
  });
  try {
    const pausedAt = (_t: string, _ws: string, at: number) => at >= Date.parse("2026-09-07T04:00:00Z") && at <= Date.parse("2026-09-07T06:00:00Z");
    const state = { lastFired: {} as Record<string, string> };
    assert.deepEqual(findDueFlows(new Date("2026-09-07T07:00:00Z"), state, ["acme"], undefined, undefined, pausedAt), []);
    assert.deepEqual(findDueFlows(new Date("2026-09-07T07:01:00Z"), state, ["acme"], undefined, undefined, () => false), [], "and never later");
  } finally {
    w.done();
  }
});
