// The room a run pod waits for: memory across the run namespace, and an
// account's own sandboxes, checked before the pod exists (src/pod-room.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { admitPod, memGiB, podGiB, roomTaken, whyNoRoom, roomBlock, tooBig, stopWaitingFor, cpuCores, tooBigForAccount, waitYourTurn, WORKSPACE_LABEL, type PodLike } from "../src/pod-room.ts";
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
  assert.deepEqual(roomTaken(pods, "acme"), {
    usedGiB: 8.5, usedDiskGiB: 0, accountPods: 2, accountGiB: 7, accountCpu: 0, accountDiskGiB: 0,
    workspaceGiB: 0, workspaceCpu: 0, workspaceDiskGiB: 0, runGiB: 0, runCpu: 0, runDiskGiB: 0,
  });
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
  assert.match(waitYourTurn(other, [old, other], pods)!, /room on the node is kept for a step that has waited longer/);
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
  assert.match(waitYourTurn(young, [old, young], pods)!, /room on the node is kept for a step that has waited longer/, "the gap is the older step's");
  assert.match(waitYourTurn(young, [young], pods, [old])!, /room on the node is kept for a step that has waited longer/, "kept while its run waits in the queue too");
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

// ---- 27 Oct 2026: disk, and four levels — run, workspace, account, node.

const at = (o: { gib?: string; cpu?: string; disk?: string; account?: string; ws?: string; run?: string; phase?: string }): PodLike => ({
  metadata: { labels: { [RUN_LABEL]: o.run ?? "r", ...(o.account ? { [ACCOUNT_LABEL]: o.account } : {}), ...(o.ws ? { [WORKSPACE_LABEL]: o.ws } : {}) } },
  status: { phase: o.phase ?? "Running" },
  spec: { containers: [{ resources: { limits: { memory: o.gib ?? "1Gi", cpu: o.cpu ?? "1", ...(o.disk ? { "ephemeral-storage": o.disk } : {}) } } }] },
});

test("every level is counted from the pods: the run's, the workspace's, the account's, and disk by its limit", () => {
  const pods = [
    at({ gib: "2Gi", cpu: "1", disk: "8Gi", account: "acme", ws: "desk", run: "r1" }),
    at({ gib: "4Gi", cpu: "2", disk: "20Gi", account: "acme", ws: "desk", run: "r2" }),
    at({ gib: "1Gi", cpu: "1", disk: "2Gi", account: "acme", ws: "other", run: "r3" }),
    at({ gib: "1Gi", cpu: "1", disk: "2Gi", account: "zeta", ws: "desk", run: "r4" }),
  ];
  const t = roomTaken(pods, "acme", "desk", "r2");
  assert.equal(t.usedDiskGiB, 32, "the node: every pod's disk");
  assert.deepEqual([t.accountGiB, t.accountCpu, t.accountDiskGiB], [7, 4, 30]);
  assert.deepEqual([t.workspaceGiB, t.workspaceCpu, t.workspaceDiskGiB], [6, 3, 28], "acme's desk only — zeta's desk is not acme's");
  assert.deepEqual([t.runGiB, t.runCpu, t.runDiskGiB], [4, 2, 20]);
});

test("the narrowest cap that holds a step back is named, and each level waits", () => {
  const limits = { budgetGiB: 0, accountPods: 0, runVcpu: 2, workspaceDiskGiB: 30, accountGiB: 8 };
  const taken = roomTaken([at({ gib: "4Gi", cpu: "2", disk: "20Gi", account: "acme", ws: "desk", run: "r1" })], "acme", "desk", "r1");
  assert.deepEqual(roomBlock(taken, 1, limits, 1, 1)?.level, "run", "2 of the run's 2 vCPU held");
  assert.match(roomBlock(taken, 1, limits, 1, 1)!.why, /2 of this run's 2 vCPU is held/);
  const otherRun = roomTaken([at({ gib: "4Gi", cpu: "2", disk: "20Gi", account: "acme", ws: "desk", run: "r1" })], "acme", "desk", "r9");
  assert.equal(roomBlock(otherRun, 1, limits, 1, 1), null, "another run of the same flow has its own pool");
  assert.match(roomBlock(otherRun, 1, limits, 1, 12)!.why, /20 of this workspace's 30 GiB of disk/);
  assert.match(roomBlock(otherRun, 5, limits, 1, 1)!.why, /4 of this account's 8 GiB/);
});

test("disk on the node waits; a step that alone is bigger than any cap fails at once, naming it", () => {
  const node = { budgetGiB: 0, budgetDiskGiB: 40, accountPods: 0 };
  assert.match(roomBlock(roomTaken([at({ disk: "30Gi" })], null), 1, node, 1, 20)!.why, /30\.0 GiB of the 40 GiB of disk for runs/);
  assert.match(tooBig(1, 1, node, 50) ?? "", /holds 50 GiB of disk, more than the install's 40 GiB of disk/, "an empty node does not let it through (Codex review)");
  assert.match(tooBig(1, 1, { budgetGiB: 0, accountPods: 0, stepDiskGiB: 20 }, 40) ?? "", /holds 40 GiB of disk and one step on this account may hold 20/);
  assert.match(tooBig(1, 3, { budgetGiB: 0, accountPods: 0, runVcpu: 2 }) ?? "", /more than this run's 2 vCPU for all its steps/);
  assert.match(tooBig(9, 1, { budgetGiB: 0, accountPods: 0, workspaceGiB: 8 }) ?? "", /more than this workspace's 8 GiB/);
});

// Codex's three traces against a saved "level": each older waiter is judged
// afresh against this round's pods.
test("fair order by scope: a waiter stuck behind its own workspace's pool holds back only that workspace", () => {
  const limits = { budgetGiB: 0, accountPods: 0, accountGiB: 10, workspaceGiB: 4 };
  // A holds 4 (its whole pool); W in A needs 2 — blocked by its workspace
  const pods = [at({ gib: "4Gi", account: "acme", ws: "A", run: "ra" })];
  const W = { account: "acme", workspace: "A", runId: "rw", key: "rw#0", since: 1000, needGiB: 2, needCpu: 0, limits };
  const V = { account: "acme", workspace: "B", runId: "rv", key: "rv#0", since: 2000, needGiB: 2, needCpu: 0, limits };
  const X = { account: "acme", workspace: "A", runId: "rx", key: "rx#0", since: 1500, needGiB: 1, needCpu: 0, limits };
  assert.equal(waitYourTurn(V, [W, V], pods), null, "trace 1: B has room and A's pool is not B's business");
  assert.match(waitYourTurn(X, [W, X], pods) ?? "", /older step of this workspace/, "within A, the older goes first");
  // trace 3: X waits behind W — that is not a reason for X to hold back B
  assert.equal(waitYourTurn(V, [W, X, V], pods), null);
});

test("fair order by scope: once the older step fits its workspace again, the account's gap is its, not a younger workspace's", () => {
  const limits = { budgetGiB: 0, accountPods: 0, accountGiB: 10, workspaceGiB: 4 };
  // trace 2: A's holder finished; W in A needs 4 and now fits — B's younger V must not take the account's room first
  const pods = [at({ gib: "4Gi", account: "acme", ws: "B", run: "rb" })];
  const W = { account: "acme", workspace: "A", runId: "rw", key: "rw#0", since: 1000, needGiB: 4, needCpu: 0, limits };
  const V = { account: "acme", workspace: "B", runId: "rv", key: "rv#0", since: 2000, needGiB: 4, needCpu: 0, limits };
  assert.match(waitYourTurn(V, [W, V], pods) ?? "", /older step of this account/);
});

test("node disk is kept for the oldest step of another account that its own caps would let start", () => {
  const limits = { budgetGiB: 0, budgetDiskGiB: 40, accountPods: 0 };
  const pods = [at({ disk: "20Gi", account: "x" })];
  const W = { account: "acme", since: 1000, needGiB: 1, needCpu: 1, needDisk: 15, limits };
  const V = { account: "zeta", since: 2000, needGiB: 1, needCpu: 1, needDisk: 10, limits };
  assert.match(waitYourTurn(V, [W, V], pods) ?? "", /disk on the node is kept for a step that has waited longer/, "20 + 10 + 15 > 40");
  assert.equal(waitYourTurn({ ...V, needDisk: 5 }, [W, V], pods), null, "20 + 5 + 15 ≤ 40");
  // held back by a pool of its own: nothing is kept for it
  const Wrun = { ...W, runId: "rw", limits: { ...limits, runDiskGiB: 15 } };
  const podsRun = [at({ disk: "20Gi", account: "x" }), at({ disk: "10Gi", account: "acme", run: "rw" })];
  assert.equal(waitYourTurn(V, [Wrun, V], podsRun.slice(0, 1).concat(podsRun[1])), null);
});

test("equal ages are ordered by key, and a step is never ahead of itself", () => {
  const limits = { budgetGiB: 0, accountPods: 0, accountGiB: 10 };
  const a = { account: "acme", runId: "r1", key: "r1#0", since: 1000, needGiB: 1, needCpu: 0, limits };
  const b = { account: "acme", runId: "r1", key: "r1#1", since: 1000, needGiB: 1, needCpu: 0, limits };
  assert.match(waitYourTurn(b, [a, b], []) ?? "", /older step/);
  assert.equal(waitYourTurn(a, [a, b], []), null);
  assert.equal(waitYourTurn(a, [a], [{ ...a }]), null, "its own record is not ahead of it");
});

// Codex review, round 3.
test("an unset cap never stops the checks after it", () => {
  const limits = { budgetGiB: 0, accountPods: 0, stepGiB: 0, stepVcpu: 0, stepDiskGiB: 0, runGiB: 0, runVcpu: 2, workspaceDiskGiB: 10 };
  assert.match(tooBig(1, 3, limits) ?? "", /more than this run's 2 vCPU/);
  assert.match(tooBig(1, 1, limits, 20) ?? "", /more than this workspace's 10 GiB of disk/);
  assert.equal(tooBig(1, 1, limits, 5), null);
});

test("a step queued behind an older one of its own workspace does not hold back another workspace", () => {
  const limits = { budgetGiB: 0, accountPods: 0, accountGiB: 10, workspaceGiB: 4 };
  // A holds 3 of 4; W (A) needs 2 — workspace-blocked; X (A) needs 1, fits, but waits behind W
  const pods = [at({ gib: "3Gi", account: "acme", ws: "A", run: "ra" })];
  const W = { account: "acme", workspace: "A", runId: "rw", key: "rw#0", since: 1000, needGiB: 2, needCpu: 0, limits };
  const X = { account: "acme", workspace: "A", runId: "rx", key: "rx#0", since: 1500, needGiB: 1, needCpu: 0, limits };
  const V = { account: "acme", workspace: "B", runId: "rv", key: "rv#0", since: 2000, needGiB: 1, needCpu: 0, limits };
  assert.match(waitYourTurn(X, [W, X, V], pods) ?? "", /older step of this workspace/);
  assert.equal(waitYourTurn(V, [W, X, V], pods), null, "B is not held behind A's queue");
});

test("a wait reason never names, or even mentions, another account", () => {
  const limits = { budgetGiB: 22, budgetDiskGiB: 40, accountPods: 0 };
  const W = { account: "secret-customer", since: 1000, needGiB: 8, needCpu: 1, needDisk: 15, limits };
  const V = { account: "acme", since: 2000, needGiB: 1, needCpu: 1, needDisk: 1, limits };
  const why = waitYourTurn(V, [W, V], [at({ gib: "14Gi", disk: "25Gi", account: "x" })]) ?? "";
  assert.ok(why.length > 0);
  assert.doesNotMatch(why, /secret-customer|another account|other account/);
});
