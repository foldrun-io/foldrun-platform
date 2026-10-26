// The room a run pod waits for: memory across the run namespace, and an
// account's own sandboxes, checked before the pod exists (src/pod-room.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { admitPod, memGiB, podGiB, roomTaken, whyNoRoom, stopWaitingFor, cpuCores, tooBigForAccount, waitYourTurn, type PodLike } from "../src/pod-room.ts";
import { RUN_LABEL } from "../../foldrun-core/src/run-container.ts";
import { ACCOUNT_LABEL } from "../src/search-k8s.ts";

const pod = (memory: string, labels: Record<string, string> = {}, phase = "Running", deleting = false): PodLike => ({
  metadata: { labels, ...(deleting ? { deletionTimestamp: "2026-10-17T00:00:00Z" } : {}) },
  status: { phase },
  spec: { containers: [{ resources: { limits: { memory } } }] },
});
const run = (memory: string, account: string, phase = "Running") => pod(memory, { [RUN_LABEL]: "r", [ACCOUNT_LABEL]: account }, phase);

test("memory quantities read as GiB, binary and decimal", () => {
  assert.equal(memGiB("6Gi"), 6);
  assert.equal(memGiB("512Mi"), 0.5);
  assert.equal(memGiB("1073741824"), 1);
  assert.ok(Math.abs(memGiB("1G") - 1e9 / 2 ** 30) < 1e-12);
  assert.equal(memGiB(undefined), 0);
  assert.ok(Number.isNaN(memGiB("lots")));
});

test("what is taken: live pods' memory, the account's run pods — finished and deleting pods hold nothing", () => {
  const pods = [
    run("6Gi", "acme"),
    run("1Gi", "acme", "Pending"),
    run("1Gi", "other"),
    run("8Gi", "acme", "Succeeded"),
    pod("6Gi", { [RUN_LABEL]: "r", [ACCOUNT_LABEL]: "acme" }, "Running", true),
    // the account's browser pod: room, but not one of its run sandboxes
    { metadata: { labels: { [ACCOUNT_LABEL]: "acme" } }, status: { phase: "Running" }, spec: { containers: [{ resources: { requests: { memory: "512Mi" }, limits: { memory: "3Gi" } } }] } },
  ];
  assert.deepEqual(roomTaken(pods, "acme"), { usedGiB: 8.5, accountPods: 2, accountGiB: 7, accountCpu: 0 });
});

test("a step waits for the account's turn and for memory; one bigger than the budget goes alone", () => {
  const limits = { budgetGiB: 22, accountPods: 3 };
  assert.equal(whyNoRoom({ usedGiB: 10, accountPods: 2 }, 6, limits), null);
  assert.match(whyNoRoom({ usedGiB: 10, accountPods: 3 }, 1, limits)!, /3 sandboxes running/);
  assert.match(whyNoRoom({ usedGiB: 18, accountPods: 0 }, 6, limits)!, /18\.0 GiB of the 22 GiB/);
  assert.equal(whyNoRoom({ usedGiB: 0, accountPods: 0 }, 40, limits), null, "nothing else holds room: start");
  assert.equal(whyNoRoom({ usedGiB: 99, accountPods: 99 }, 6, { budgetGiB: 0, accountPods: 0 }), null, "unset is no limit");
});

test("admit waits until there is room, says so once, and is not billed — then holds the lock until release", async () => {
  let clock = 0;
  const lists: PodLike[][] = [[run("6Gi", "x"), run("6Gi", "x"), run("6Gi", "x"), run("2Gi", "x")], [run("6Gi", "x")]];
  const said: string[] = [];
  const got = await admitPod({
    account: "acme",
    needGiB: 6,
    limits: { budgetGiB: 22, accountPods: 3 },
    listPods: async () => lists.shift() ?? [],
    emit: (l) => said.push(l),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  });
  assert.ok("release" in got);
  assert.equal(got.waitedMs, 2000);
  assert.equal(said.length, 2);
  assert.match(said[0], /^room: waiting to start — 20\.0 GiB of the 22 GiB/);
  assert.match(said[1], /^room: starting after 2s waiting/);
  // a second step of this worker cannot check until the first has created its pod
  let secondIn = false;
  const second = admitPod({
    account: "acme", needGiB: 1, limits: { budgetGiB: 22, accountPods: 3 },
    listPods: async () => { secondIn = true; return []; }, emit: () => {},
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(secondIn, false, "still behind the first step's create");
  got.release();
  const s2 = await second;
  assert.ok("release" in s2);
  assert.equal(secondIn, true);
  s2.release();
});

// 27 Oct 2026: a wait for room has no time limit — it used to fail after
// 30 minutes (FOLDRUN_ROOM_WAIT_SEC). Only a stop ends it, or the queue.
test("admit waits however long it takes, and gives up only on a stop", async () => {
  let clock = 0;
  let polls = 0;
  const full = [run("20Gi", "x")];
  const late = await admitPod({
    account: "acme", needGiB: 6, limits: { budgetGiB: 22, accountPods: 0 },
    listPods: async () => (++polls > 3000 ? [] : full), emit: () => {}, sleep: async (ms) => { clock += ms; }, now: () => clock,
  });
  assert.ok("release" in late, "admitted once room appears, after 100 minutes of waiting");
  assert.ok(clock >= 100 * 60_000);
  late.release();

  stopWaitingFor("run-9");
  const stopped = await admitPod({
    account: "acme", needGiB: 6, runId: "run-9", limits: { budgetGiB: 22, accountPods: 0 },
    listPods: async () => full, emit: () => {}, sleep: async () => {},
  });
  assert.deepEqual(stopped, { failed: "stopped while waiting for room to start" });
});

test("a step that may wait in the queue answers deferred, after saying why it waits", async () => {
  const said: string[] = [];
  let mayDefer = false;
  let polls = 0;
  const got = await admitPod({
    account: "acme", needGiB: 6, limits: { budgetGiB: 22, accountPods: 0 },
    waiting: (why) => said.push(why),
    mayDefer: () => mayDefer,
    listPods: async () => { if (++polls === 3) mayDefer = true; return [run("20Gi", "x")]; },
    emit: () => {}, sleep: async () => {},
  });
  assert.ok("deferred" in got);
  assert.match(got.deferred, /20\.0 GiB of the 22 GiB/);
  assert.equal(said.length, 1, "told once, not every poll");
  assert.equal(polls, 3, "waited here until it was allowed to go to the queue");
});

test("fair order: a later step of an account never passes its older one", () => {
  const limits = { budgetGiB: 22, accountPods: 0 };
  const old = { account: "acme", since: 1000, needGiB: 8, needCpu: 1, limits };
  const young = { account: "acme", since: 2000, needGiB: 1, needCpu: 1, limits };
  const other = { account: "zeta", since: 3000, needGiB: 1, needCpu: 1, limits };
  const pods = [run("16Gi", "x")];
  assert.match(waitYourTurn(young, [old, young], pods)!, /older step of this account/);
  assert.match(waitYourTurn(young, [young], pods, [old])!, /older step of this account/, "an older one parked in the queue counts too");
  assert.equal(waitYourTurn(old, [old, young], pods), null, "the oldest is never held back by younger ones");
  assert.equal(waitYourTurn(young, [young], pods, [{ ...young }]), null, "its own record (same age) does not hold it back");
  // another account is not held behind acme's line — but the node's room
  // is kept for acme's oldest, which the node alone holds back: 16 + 1 + 8 > 22
  assert.match(waitYourTurn(other, [old, other], pods)!, /room on the node is kept/);
  assert.equal(waitYourTurn(other, [old, other], [run("10Gi", "x")]), null, "room for both: 10 + 1 + 8 ≤ 22");
});

// Codex review: room kept only while the older step did not fit let a
// younger one take the gap the moment it opened; and a step whose run
// waits in the queue kept no room at all.
test("fair order: room is kept for an older step that fits now, and for one parked in the queue", () => {
  const limits = { budgetGiB: 22, accountPods: 0 };
  const old = { account: "acme", since: 1000, needGiB: 8, needCpu: 1, limits };
  const young = { account: "zeta", since: 2000, needGiB: 1, needCpu: 1, limits };
  const pods = [run("14Gi", "x")]; // 14 + 8 = 22 fits the old one; 14 + 1 + 8 > 22
  assert.match(waitYourTurn(young, [old, young], pods)!, /room on the node is kept/, "the gap is the older step's");
  assert.match(waitYourTurn(young, [young], pods, [old])!, /room on the node is kept/, "kept while its run waits in the queue too");
  assert.equal(waitYourTurn(young, [young], [run("12Gi", "x")], [old]), null, "12 + 1 + 8 ≤ 22: room for both");
});

test("fair order: no node room is kept for a step its own account holds back", () => {
  const limits = { budgetGiB: 22, accountPods: 1 };
  const blocked = { account: "acme", since: 1000, needGiB: 8, needCpu: 1, limits };
  const other = { account: "zeta", since: 3000, needGiB: 1, needCpu: 1, limits };
  // acme already has its one pod: node room kept for its waiter would sit idle
  assert.equal(waitYourTurn(other, [blocked, other], [run("16Gi", "acme")]), null);
});

test("fair order through admit: the younger step waits until the older one has started", async () => {
  const limits = { budgetGiB: 22, accountPods: 0 };
  let pods = [run("20Gi", "x")];
  const order: string[] = [];
  let oldGot: Awaited<ReturnType<typeof admitPod>> | null = null;
  const older = admitPod({ account: "acme", needGiB: 6, since: 1000, limits, listPods: async () => pods, emit: () => {}, sleep: () => new Promise((r) => setTimeout(r, 2)) })
    .then((g) => { order.push("old"); oldGot = g; return g; });
  await new Promise((r) => setTimeout(r, 10));
  // room for the small younger step only (17 + 1 ≤ 22 < 17 + 6): it must
  // still wait for the old one
  pods = [run("17Gi", "x")];
  const younger = admitPod({ account: "acme", needGiB: 1, since: 2000, limits, listPods: async () => pods, emit: () => {}, sleep: () => new Promise((r) => setTimeout(r, 2)) })
    .then((g) => { order.push("young"); return g; });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(order, [], "the younger step did not take the gap");
  pods = [];
  const o = await older;
  assert.ok("release" in o);
  o.release();
  const y = await younger;
  assert.ok("release" in y);
  y.release();
  assert.deepEqual(order, ["old", "young"]);
  void oldGot;
});

// 21 Oct 2026: the stop is written by the web tier and the waiters are the
// worker's, so the in-process mark never reached them; and the first waiter
// to see a mark deleted it, so the other copies of a fan-out started anyway.
test("every waiter of a stopped run gives up, and a stop read from the record counts", async () => {
  const full = [run("20Gi", "x")];
  let tries = 0;
  const viaRecord = await admitPod({
    account: "acme", needGiB: 6, runId: "run-rec", limits: { budgetGiB: 22, accountPods: 0 },
    stopped: () => ++tries >= 3,
    listPods: async () => full, emit: () => {}, sleep: async () => {},
  });
  assert.deepEqual(viaRecord, { failed: "stopped while waiting for room to start" });

  stopWaitingFor("run-fan");
  const waiters = await Promise.all([1, 2, 3].map(() => admitPod({
    account: "acme", needGiB: 6, runId: "run-fan", limits: { budgetGiB: 22, accountPods: 0 },
    listPods: async () => full, emit: () => {}, sleep: async () => {},
  })));
  assert.deepEqual(waiters, [1, 2, 3].map(() => ({ failed: "stopped while waiting for room to start" })));
});

test("with no limits set nothing is listed — the behaviour before", async () => {
  let listed = false;
  const got = await admitPod({
    account: "acme", needGiB: 6, limits: { budgetGiB: 0, accountPods: 0 },
    listPods: async () => { listed = true; return []; }, emit: () => {},
  });
  assert.ok("release" in got);
  assert.equal(listed, false);
});

test("a cluster that does not answer is not a full one", async () => {
  const got = await admitPod({
    account: "acme", needGiB: 6, limits: { budgetGiB: 22, accountPods: 3 },
    listPods: async () => null, emit: () => {},
  });
  assert.ok("release" in got);
  got.release();
});

test("a pod reserves what the scheduler counts: its app containers' sum, or its largest init container if bigger", () => {
  const c = (memory: string) => ({ resources: { requests: { memory } } });
  assert.equal(podGiB({ spec: { containers: [c("1Gi"), c("1Gi")] } }), 2);
  assert.equal(podGiB({ spec: { containers: [c("1Gi")], initContainers: [c("512Mi"), c("4Gi")] } }), 4);
  assert.equal(podGiB({ spec: { containers: [c("3Gi"), c("1Gi")], initContainers: [c("2Gi")] } }), 4);
  assert.equal(podGiB({}), 0);
});

// ---------- the account's compute pool (26 Oct 2026) ----------

const sized = (memory: string, cpu: string, account: string): PodLike => ({
  metadata: { labels: { [RUN_LABEL]: "r", [ACCOUNT_LABEL]: account } },
  status: { phase: "Running" },
  spec: { containers: [{ resources: { limits: { memory, cpu } } }] },
});

test("an account's run pods count toward its pool by their cores and memory; nobody else's do", () => {
  const t = roomTaken([sized("6Gi", "3", "acme"), sized("8Gi", "4", "acme"), sized("8Gi", "4", "other"), pod("3Gi", { [ACCOUNT_LABEL]: "acme" })], "acme");
  assert.equal(t.accountGiB, 14);
  assert.equal(t.accountCpu, 7);
  assert.equal(t.accountPods, 2, "a browser pod is the account's, but not a run");
  assert.equal(cpuCores("250m"), 0.25);
  assert.equal(cpuCores("2"), 2);
});

test("a step past the pool waits; one that fits starts; the first always fits its pool", () => {
  const limits = { budgetGiB: 0, accountPods: 0, accountGiB: 16, accountVcpu: 8 };
  assert.equal(whyNoRoom({ usedGiB: 0, accountPods: 0, accountGiB: 0, accountCpu: 0 }, 8, limits, 4), null);
  assert.equal(whyNoRoom({ usedGiB: 8, accountPods: 1, accountGiB: 8, accountCpu: 4 }, 8, limits, 4), null, "8 + 8 = 16 fits");
  assert.match(whyNoRoom({ usedGiB: 14, accountPods: 2, accountGiB: 14, accountCpu: 7 }, 6, limits, 3) ?? "", /14 of this account's 16 GiB is held by its running steps and this one needs 6/);
  assert.match(whyNoRoom({ usedGiB: 4, accountPods: 2, accountGiB: 4, accountCpu: 7 }, 2, limits, 2) ?? "", /7 of this account's 8 vCPU/);
});

test("a step bigger than the plan allows one step, or than the whole pool, fails at once", async () => {
  const limits = { budgetGiB: 0, accountPods: 0, accountGiB: 8, accountVcpu: 4, stepGiB: 8, stepVcpu: 4 };
  assert.match(tooBigForAccount(12, 2, limits) ?? "", /holds 12 GiB and one step on this account may hold 8/);
  assert.match(tooBigForAccount(4, 6, limits) ?? "", /holds 6 vCPU and one step on this account may hold 4/);
  assert.match(tooBigForAccount(10, 2, { budgetGiB: 0, accountPods: 0, accountGiB: 8 }) ?? "", /more than this account's 8 GiB for all its running steps/);
  assert.equal(tooBigForAccount(8, 4, limits), null);
  let listed = false;
  const got = await admitPod({ account: "acme", needGiB: 12, needCpu: 2, limits, listPods: async () => { listed = true; return []; }, emit: () => {} });
  assert.ok("failed" in got && /one step on this account may hold 8/.test(got.failed));
  assert.equal(listed, false, "not waited on: no running step finishing makes room");
});

test("a step waits for its account's pool, then starts when a step of its own ends", async () => {
  let clock = 0;
  const said: string[] = [];
  const lists = [[sized("8Gi", "4", "acme"), sized("6Gi", "3", "acme")], [sized("6Gi", "3", "acme")]];
  const got = await admitPod({
    account: "acme",
    needGiB: 8,
    needCpu: 4,
    limits: { budgetGiB: 0, accountPods: 0, accountGiB: 16, accountVcpu: 8 },
    listPods: async () => lists.shift() ?? [],
    emit: (l) => said.push(l),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  });
  assert.ok("release" in got);
  (got as { release: () => void }).release();
  assert.match(said[0], /room: waiting to start — 14 of this account's 16 GiB/);
  assert.match(said.at(-1)!, /room: starting after/);
});
