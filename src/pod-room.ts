// The room a run pod waits for before it is created (17 Oct 2026).
//
// A step's pod used to be applied the moment the step started. When the
// node was full the pod sat Pending, `kubectl wait` gave up after 180 s and
// the step FAILED — a fan-out of twenty large steps on the box was enough.
// And nothing stopped one account's fan-out from filling the node while
// everyone else's steps queued behind it in the scheduler, first come first
// served.
//
// So a step now waits here, before its pod exists, until two things hold:
//
//   · the memory every live pod in the run namespace reserves, plus this
//     step's, fits FOLDRUN_RUN_MEMORY_GIB. The platform's own pods live in
//     another namespace and are not counted; what is, besides run pods, is
//     what also holds node memory on a run's behalf — the accounts' browser
//     and search pods and the deploy-time runtime builds. The budget is the
//     node's memory less the platform's;
//   · its account has fewer than FOLDRUN_ACCOUNT_PODS run pods alive, so a
//     fan-out takes its turns instead of the node;
//   · its account's run pods, plus this step, hold no more cores and memory
//     than the account's compute pool (limits.ts accountCompute: the plan's,
//     the install's, or lower by the account's own `compute:`) — since
//     26 Oct 2026. A step that ALONE is bigger than the pool, or than the
//     plan's step maximum, fails at once: no amount of waiting makes room.
//
// The cluster is the record: the pods are listed each time, so nothing here
// can go stale when a worker dies — a pod that is gone is not counted. The
// worker's own steps take the check and the create one at a time (the
// lock below), so they cannot both see the same last gigabyte. Separate
// worker processes can: the lock is this process's, so N workers racing
// for the same room can overshoot by up to N−1 pods, which the scheduler
// then holds Pending, as before. One worker on the box; a fleet that runs
// several sizes its budget for that. The wait is before the rent clock starts, so it is
// never billed, and it is on the record as the `room` start-up phase.
//
// Unset, both are no limit and nothing is listed — the behaviour before.

import { ACCOUNT_LABEL } from "./search-k8s.ts";
import { RUN_LABEL } from "../../foldrun-core/src/run-container.ts";
import type { RoomLevel } from "../../foldrun-core/src/store.ts";
import { settingsEnv } from "./settings.ts";

export interface PodLike {
  metadata?: { labels?: Record<string, string>; deletionTimestamp?: string };
  status?: { phase?: string };
  spec?: { containers?: ContainerLike[]; initContainers?: ContainerLike[] };
}
type ContainerLike = { resources?: { requests?: Record<string, string>; limits?: Record<string, string> } };

/** One container's memory reservation: its request, or its limit where it
 *  sets none (Kubernetes makes the request equal to the limit then). */
const reserved = (c: ContainerLike) => {
  const g = memGiB(c.resources?.requests?.memory ?? c.resources?.limits?.memory);
  return Number.isFinite(g) ? g : 0;
};

/** One container's cores as the account is charged them: its CPU limit —
 *  the figure a step is capped at and billed by (run-k8s.ts). */
const cores = (c: ContainerLike) => {
  const n = cpuCores(c.resources?.limits?.cpu);
  return Number.isFinite(n) ? n : 0;
};

/** A CPU quantity in cores: "2", "0.5", "250m". NaN when it is not one. */
export function cpuCores(q: string | undefined): number {
  if (!q) return 0;
  const m = /^(\d+(?:\.\d+)?)(m)?$/.exec(q.trim());
  if (!m) return NaN;
  return m[2] ? Number(m[1]) / 1000 : Number(m[1]);
}

/** What a pod reserves the way the scheduler counts it: the larger of its
 *  app containers' sum and its largest init container
 *  (kubernetes.io/docs/concepts/workloads/pods/init-containers, "Resource
 *  sharing within containers"). No run pod has init containers today; a
 *  pod that gains one is not undercounted. */
export function podGiB(p: PodLike): number {
  const app = (p.spec?.containers ?? []).reduce((sum, c) => sum + reserved(c), 0);
  const init = Math.max(0, ...(p.spec?.initContainers ?? []).map(reserved));
  return Math.max(app, init);
}

/** A Kubernetes memory quantity in GiB: 6Gi, 512Mi, 1G, 1073741824. NaN when it is not one. */
export function memGiB(q: string | undefined): number {
  if (!q) return 0;
  const m = /^(\d+(?:\.\d+)?)([KMGTE]i?|[kmgte])?$/.exec(q.trim());
  if (!m) return NaN;
  const n = Number(m[1]);
  const unit = m[2] ?? "";
  const bin: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Ei: 2 ** 60 };
  const dec: Record<string, number> = { k: 1e3, K: 1e3, m: 1e-3, M: 1e6, G: 1e9, g: 1e9, T: 1e12, t: 1e12, E: 1e18, e: 1e18 };
  const bytes = unit in bin ? n * bin[unit] : unit in dec ? n * dec[unit] : n;
  return bytes / 2 ** 30;
}

/** One container's disk allowance (27 Oct 2026): its ephemeral-storage
 *  LIMIT — what it may write — else its request, else nothing. Kubernetes
 *  schedules on the request; every cap here counts the allowance, so the
 *  allowances held together stay under it. */
const diskOf = (c: ContainerLike) => {
  const g = memGiB(c.resources?.limits?.["ephemeral-storage"] ?? c.resources?.requests?.["ephemeral-storage"]);
  return Number.isFinite(g) ? g : 0;
};

/** The label run pods carry their workspace in, beside the account's. */
export const WORKSPACE_LABEL = "foldrun-workspace";

/** Which cap holds a step back: its run's, its workspace's, its account's,
 *  or the node's budget for runs. */
export type { RoomLevel };

/** What the run namespace holds now: the memory and disk its live pods
 *  reserve, and what one account's run pods hold — and within it one
 *  workspace's and one run's (27 Oct 2026). Finished and deleting pods
 *  hold nothing. */
export interface RoomTaken {
  usedGiB: number;
  usedDiskGiB?: number;
  accountPods: number;
  /** What this account's live run pods hold: GiB reserved, cores capped, disk allowed. */
  accountGiB: number;
  accountCpu: number;
  accountDiskGiB?: number;
  workspaceGiB?: number;
  workspaceCpu?: number;
  workspaceDiskGiB?: number;
  runGiB?: number;
  runCpu?: number;
  runDiskGiB?: number;
}

export function roomTaken(pods: PodLike[], account: string | null, workspace: string | null = null, runId: string | null = null): RoomTaken {
  const t = {
    usedGiB: 0, usedDiskGiB: 0, accountPods: 0, accountGiB: 0, accountCpu: 0, accountDiskGiB: 0,
    workspaceGiB: 0, workspaceCpu: 0, workspaceDiskGiB: 0, runGiB: 0, runCpu: 0, runDiskGiB: 0,
  };
  for (const p of pods) {
    const phase = p.status?.phase;
    if (phase === "Succeeded" || phase === "Failed" || p.metadata?.deletionTimestamp) continue;
    const gib = podGiB(p);
    const disk = (p.spec?.containers ?? []).reduce((sum, c) => sum + diskOf(c), 0);
    t.usedGiB += gib;
    t.usedDiskGiB += disk;
    const labels = p.metadata?.labels ?? {};
    if (!account || !labels[RUN_LABEL] || labels[ACCOUNT_LABEL] !== account) continue;
    const cpu = (p.spec?.containers ?? []).reduce((sum, c) => sum + cores(c), 0);
    t.accountPods += 1;
    t.accountGiB += gib;
    t.accountCpu += cpu;
    t.accountDiskGiB += disk;
    // A pod from before 27 Oct 2026 has no workspace label: it counts to
    // its account and the node only.
    if (workspace && labels[WORKSPACE_LABEL] === workspace) {
      t.workspaceGiB += gib;
      t.workspaceCpu += cpu;
      t.workspaceDiskGiB += disk;
    }
    if (runId && labels[RUN_LABEL] === runId) {
      t.runGiB += gib;
      t.runCpu += cpu;
      t.runDiskGiB += disk;
    }
  }
  return t;
}

export interface RoomLimits {
  /** GiB the run namespace may reserve; 0 is no limit. */
  budgetGiB: number;
  /** GiB of disk the run namespace's pods may be allowed together; 0 is no limit. */
  budgetDiskGiB?: number;
  /** Run pods one account may have alive; 0 is no limit. */
  accountPods: number;
  /** The account's pool: GiB, cores and disk its run pods may hold together;
   *  0 is no limit. From accountCompute, per account. */
  accountGiB?: number;
  accountVcpu?: number;
  accountDiskGiB?: number;
  /** The workspace's pool (its AGENTS.md compute:); 0 is no limit. */
  workspaceGiB?: number;
  workspaceVcpu?: number;
  workspaceDiskGiB?: number;
  /** The run's pool (its flow's compute:, copied onto the run); 0 is no limit. */
  runGiB?: number;
  runVcpu?: number;
  runDiskGiB?: number;
  /** The most one step may hold; 0 is no limit. */
  stepGiB?: number;
  stepVcpu?: number;
  stepDiskGiB?: number;
  /** The memory of the largest node a run pod can land on
   *  (FOLDRUN_NODE_MAX_MEMORY_GIB, 28 Oct 2026, FOL-100): a step's memory
   *  is reserved whole (a limit, no smaller request), so one asking for
   *  more is never placed — it fails at once instead of waiting forever.
   *  Not cores: a pod requests less CPU than its limit, so a big limit
   *  still lands. Set per install — on an autoscaling cluster the largest
   *  node now is not the largest it can make. 0 is no limit. */
  nodeGiB?: number;
}

export function roomLimits(env = settingsEnv()): RoomLimits {
  const n = (v: string | undefined) => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? x : 0;
  };
  return {
    budgetGiB: n(env.FOLDRUN_RUN_MEMORY_GIB),
    budgetDiskGiB: n(env.FOLDRUN_RUN_DISK_GIB),
    accountPods: Math.floor(n(env.FOLDRUN_ACCOUNT_PODS)),
    nodeGiB: n(env.FOLDRUN_NODE_MAX_MEMORY_GIB),
  };
}

/** Whether any cap that waits is set — with none, nothing is listed (the
 *  behaviour before the gate). The step maxima only fail, never wait. */
export function anyRoomLimit(l: RoomLimits): boolean {
  return !!(l.budgetGiB || l.budgetDiskGiB || l.accountPods || l.accountGiB || l.accountVcpu || l.accountDiskGiB ||
    l.workspaceGiB || l.workspaceVcpu || l.workspaceDiskGiB || l.runGiB || l.runVcpu || l.runDiskGiB);
}

const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));

/** Why this step cannot start yet and which cap says so — its run's, its
 *  workspace's, its account's, then the node's: narrowest first — or null
 *  when it can. A step bigger than the whole memory budget starts when
 *  nothing else holds room — refusing it forever would be worse than the
 *  scheduler's own answer. One bigger than any pool, or than the disk
 *  budget, never waits here: tooBig fails it at once. */
export function roomBlock(taken: RoomTaken, needGiB: number, limits: RoomLimits, needCpu = 0, needDisk = 0): { why: string; level: RoomLevel } | null {
  const over = (cap: number | undefined, held: number | undefined, need: number) => !!cap && (held ?? 0) > 0 && (held ?? 0) + need > cap + 1e-9;
  type Check = [number | undefined, number | undefined, number, string];
  const levels: [RoomLevel, string, Check[]][] = [
    ["run", "this run's", [[limits.runGiB, taken.runGiB, needGiB, "GiB"], [limits.runVcpu, taken.runCpu, needCpu, "vCPU"], [limits.runDiskGiB, taken.runDiskGiB, needDisk, "GiB of disk"]]],
    ["workspace", "this workspace's", [[limits.workspaceGiB, taken.workspaceGiB, needGiB, "GiB"], [limits.workspaceVcpu, taken.workspaceCpu, needCpu, "vCPU"], [limits.workspaceDiskGiB, taken.workspaceDiskGiB, needDisk, "GiB of disk"]]],
    ["account", "this account's", [[limits.accountGiB, taken.accountGiB, needGiB, "GiB"], [limits.accountVcpu, taken.accountCpu, needCpu, "vCPU"], [limits.accountDiskGiB, taken.accountDiskGiB, needDisk, "GiB of disk"]]],
  ];
  for (const [level, whose, checks] of levels) {
    if (level === "account" && limits.accountPods && taken.accountPods >= limits.accountPods) {
      return { why: `this account has ${taken.accountPods} sandbox${taken.accountPods === 1 ? "" : "es"} running, its most at once`, level };
    }
    for (const [cap, held, need, unit] of checks) {
      if (over(cap, held, need)) return { why: `${fmt(held ?? 0)} of ${whose} ${fmt(cap!)} ${unit} is held by its running steps and this one needs ${fmt(need)}`, level };
    }
  }
  if (limits.budgetGiB && taken.usedGiB > 0 && taken.usedGiB + needGiB > limits.budgetGiB + 1e-9) {
    return { why: `${taken.usedGiB.toFixed(1)} GiB of the ${limits.budgetGiB} GiB for runs is in use and this step needs ${needGiB.toFixed(1)}`, level: "node" };
  }
  const usedDisk = taken.usedDiskGiB ?? 0;
  if (limits.budgetDiskGiB && usedDisk + needDisk > limits.budgetDiskGiB + 1e-9) {
    return { why: `${usedDisk.toFixed(1)} GiB of the ${limits.budgetDiskGiB} GiB of disk for runs is allowed to running steps and this step needs ${needDisk.toFixed(1)}`, level: "node" };
  }
  return null;
}

/** roomBlock's reason alone. */
export function whyNoRoom(taken: RoomTaken, needGiB: number, limits: RoomLimits, needCpu = 0, needDisk = 0): string | null {
  return roomBlock(taken, needGiB, limits, needCpu, needDisk)?.why ?? null;
}

// One at a time within this worker: the check and the create, together.
let chain: Promise<void> = Promise.resolve();

/** Runs a stop reached while their step waited here — there is no pod yet
 *  for killRunPods to delete, so it leaves word instead. */
const stopped = new Set<string>();
export function stopWaitingFor(runId: string): void {
  stopped.add(runId);
  // A run that was not waiting has nothing to read the mark; drop it soon.
  setTimeout(() => stopped.delete(runId), 10 * 60_000).unref?.();
}

/** Why this step can never start under its limits, or null: it alone is
 *  bigger than the step maximum, than its run's, workspace's or account's
 *  whole pool, or than the node's disk budget. Said at once rather than
 *  waited on — no running step finishing makes room. */
export function tooBig(needGiB: number, needCpu: number, limits: RoomLimits, needDisk = 0): string | null {
  const fix = "— ask for less with size: or resources:, or allow more";
  // An unset cap (0) is null, never 0: `??` would stop at a 0 and skip
  // every check after it (Codex review).
  const one = (cap: number | undefined, need: number, unit: string) =>
    !cap || need <= cap + 1e-9 ? null : `this step holds ${fmt(need)} ${unit} and one step on this account may hold ${fmt(cap)} ${fix}`;
  const pool = (cap: number | undefined, need: number, unit: string, whose: string, what: string) =>
    !cap || need <= cap + 1e-9 ? null : `this step holds ${fmt(need)} ${unit}, more than ${whose} ${fmt(cap)} ${unit} for ${what} ${fix}`;
  return (
    one(limits.stepGiB, needGiB, "GiB") ?? one(limits.stepVcpu, needCpu, "vCPU") ?? one(limits.stepDiskGiB, needDisk, "GiB of disk") ??
    pool(limits.runGiB, needGiB, "GiB", "this run's", "all its steps (its flow's compute:)") ??
    pool(limits.runVcpu, needCpu, "vCPU", "this run's", "all its steps (its flow's compute:)") ??
    pool(limits.runDiskGiB, needDisk, "GiB of disk", "this run's", "all its steps (its flow's compute:)") ??
    pool(limits.workspaceGiB, needGiB, "GiB", "this workspace's", "all its running steps") ??
    pool(limits.workspaceVcpu, needCpu, "vCPU", "this workspace's", "all its running steps") ??
    pool(limits.workspaceDiskGiB, needDisk, "GiB of disk", "this workspace's", "all its running steps") ??
    pool(limits.accountGiB, needGiB, "GiB", "this account's", "all its running steps") ??
    pool(limits.accountVcpu, needCpu, "vCPU", "this account's", "all its running steps") ??
    pool(limits.accountDiskGiB, needDisk, "GiB of disk", "this account's", "all its running steps") ??
    pool(limits.budgetDiskGiB, needDisk, "GiB of disk", "the install's", "all running steps on it") ??
    pool(limits.nodeGiB, needGiB, "GiB", "the largest node's", "one step (no node here can hold it)")
  );
}

/** tooBig without disk — its name before 27 Oct 2026. */
export function tooBigForAccount(needGiB: number, needCpu: number, limits: RoomLimits): string | null {
  return tooBig(needGiB, needCpu, limits);
}

/** A step waiting for room: where it belongs (account, workspace, run),
 *  its place in line (when it first found none, carried across re-drives on
 *  the step record; `key` breaks a tie), and what it needs under which
 *  limits. */
export interface RoomWaiter {
  account: string | null;
  workspace?: string | null;
  runId?: string | null;
  /** `${runId}#${step}` — orders two equal ages, and names one step. */
  key?: string;
  since: number;
  needGiB: number;
  needCpu: number;
  needDisk?: number;
  limits: RoomLimits;
}

/**
 * The fair order (27 Oct 2026): why a step that would fit must still wait
 * its turn, or null. Without it every waiter re-tried on its own clock, and
 * a big step could wait forever while smaller ones took each gap.
 *
 * Every older waiter is judged afresh against this round's pods — never by
 * a reason it saved earlier, which goes stale (Codex review):
 *
 *   · held back by its run's own pool, it goes first among that run's steps;
 *     by its workspace's, among that workspace's; otherwise (its account's
 *     pool, the node, or nothing) among all its account's steps. A later,
 *     smaller step never passes an older one of its scope — and a step stuck
 *     behind a narrow pool of its own never holds back the rest;
 *   · room on the node — memory and disk — is kept for the oldest step of
 *     another account that all its own caps would let start (said without
 *     naming the other account: a wait reason never tells one customer
 *     about another), whether or not
 *     the node is short this moment, so the node's last gigabytes go to it,
 *     not to whoever looks next.
 *
 * Waiters come from this worker (`others`) and the run records
 * (`recorded`: another worker's, or one whose run waits in the queue).
 * Pure: the pods are the cluster's answer this round.
 */
export function waitYourTurn(me: RoomWaiter, others: readonly RoomWaiter[], pods: PodLike[], recorded: readonly RoomWaiter[] = []): string | null {
  const older = (w: RoomWaiter) => w !== me && (w.since < me.since || (w.since === me.since && !!w.key && !!me.key && w.key < me.key));
  const age = (w: RoomWaiter) => {
    const m = Math.max(0, Math.round((Date.now() - w.since) / 60_000));
    return m < 1 ? "under a minute" : `${m} minute${m === 1 ? "" : "s"}`;
  };
  const ahead = [...others, ...recorded].filter((w) => older(w) && (!me.key || w.key !== me.key)).sort((a, b) => a.since - b.since || (a.key ?? "").localeCompare(b.key ?? ""));
  const blockOf = (w: RoomWaiter) =>
    roomBlock(roomTaken(pods, w.account, w.workspace ?? null, w.runId ?? null), w.needGiB, w.limits, w.needCpu, w.needDisk ?? 0);
  // A waiter's scope: the cap that holds it now — or, when nothing does but
  // it waits its turn behind an older waiter of its own run or workspace,
  // that narrower scope (Codex review: a step queued behind a workspace-
  // local wait must not hold back the whole account). Oldest first, so an
  // older waiter's scope is known when a younger one asks.
  const scopes = new Map<RoomWaiter, RoomLevel | undefined>();
  for (const w of ahead) {
    let level = blockOf(w)?.level;
    if (!level || level === "account" || level === "node") {
      for (const u of ahead) {
        if (u === w) break;
        if (u.account !== w.account) continue;
        const ul = scopes.get(u);
        if (ul === "run" && u.runId && u.runId === w.runId) { level = "run"; break; }
        if (ul === "workspace" && u.workspace && u.workspace === w.workspace) { level = "workspace"; break; }
      }
    }
    scopes.set(w, level);
  }
  if (me.account !== null) {
    for (const w of ahead) {
      if (w.account !== me.account) continue;
      const level = scopes.get(w);
      if (level === "run" && (!w.runId || w.runId !== me.runId)) continue;
      if (level === "workspace" && (!w.workspace || w.workspace !== me.workspace)) continue;
      const scope = level === "run" ? "of this run" : level === "workspace" ? "of this workspace" : "of this account";
      return `an older step ${scope} has waited ${age(w)} for room and starts first`;
    }
  }
  if (!me.limits.budgetGiB && !me.limits.budgetDiskGiB) return null;
  const taken = roomTaken(pods, null);
  for (const w of ahead) {
    if (w.account === me.account) continue;
    const level = scopes.get(w);
    // Held back by a cap of its own (or queued behind one): node room kept
    // for it would sit idle.
    if (level && level !== "node") continue;
    // Kept whether or not it fits this moment: one that fits now but has
    // not looked yet would otherwise lose the gap to whoever looks first.
    if (me.limits.budgetGiB && taken.usedGiB + me.needGiB + w.needGiB > me.limits.budgetGiB + 1e-9) {
      return `room on the node is kept for a step that has waited longer (${age(w)})`;
    }
    const diskBudget = me.limits.budgetDiskGiB;
    if (diskBudget && (taken.usedDiskGiB ?? 0) + (me.needDisk ?? 0) + (w.needDisk ?? 0) > diskBudget + 1e-9) {
      return `disk on the node is kept for a step that has waited longer (${age(w)})`;
    }
    return null;
  }
  return null;
}

// The steps waiting in this worker, for the fair order.
const waiters = new Set<RoomWaiter>();

/** Why `me` cannot start now and at which level, or null — the room gate's
 *  whole answer for one look, without waiting or taking the lock (core
 *  platform.roomCheck, before a step waiting in the queue is started again). */
export function roomFor(me: RoomWaiter, pods: PodLike[], recorded: readonly RoomWaiter[] = []): string | null {
  const block = roomBlock(roomTaken(pods, me.account, me.workspace ?? null, me.runId ?? null), me.needGiB, me.limits, me.needCpu, me.needDisk ?? 0);
  return block?.why ?? waitYourTurn(me, [...waiters], pods, recorded);
}

export interface AdmitOptions {
  account: string | null;
  /** The workspace the step belongs to — its pool is counted by pod label. */
  workspace?: string | null;
  needGiB: number;
  /** The cores this step's pod is capped at — what the pools count. */
  needCpu?: number;
  /** The disk this step's pod is allowed (its ephemeral-storage limit), GiB. */
  needDisk?: number;
  /** `${runId}#${step}` — breaks a tie between equal ages. */
  key?: string;
  runId?: string;
  /** Whether the run was stopped, read from its record. The mark below is
   *  only this process's: the stop is usually written by another (the web
   *  tier), and the steps waiting here are the worker's. */
  stopped?: () => boolean;
  limits?: RoomLimits;
  /** The run namespace's pods, or null when the cluster did not answer. */
  listPods: () => Promise<PodLike[] | null>;
  emit: (line: string) => void;
  /** When this step first found no room (ms), from its record — its place
   *  in line. Absent: now. */
  since?: number | null;
  /** Called when it finds no room, and again when the reason changes —
   *  with the cap that holds it back (or none, when it waits its turn). */
  waiting?: (why: string, level?: RoomLevel) => void;
  /** Whether it may stop waiting here and answer `deferred`, so its run
   *  waits in the queue instead (core runner.ts mayDefer). Absent or false:
   *  it waits here. There is no time limit either way (27 Oct 2026). */
  mayDefer?: () => boolean;
  /** Steps waiting for room on the run records — another worker's, and
   *  those whose runs wait in the queue. Its own is among them; the same
   *  `key` is never ahead of itself. */
  recorded?: () => Promise<RoomWaiter[]>;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Wait for room, then hold the worker's lock until the caller has created
 * its pod: `release()` must be called once the create has returned, success
 * or not. Answers `{ waitedMs }`; `{ deferred }` when its run may wait in
 * the queue instead (mayDefer); or a reason the step should fail with —
 * only one no wait can cure (too big, or stopped). A wait for room has no
 * time limit: the 30-minute failure (FOLDRUN_ROOM_WAIT_SEC) is gone.
 */
export async function admitPod(o: AdmitOptions): Promise<{ release: () => void; waitedMs: number } | { failed: string } | { deferred: string }> {
  const limits = o.limits ?? roomLimits();
  const needCpu = o.needCpu ?? 0;
  const needDisk = o.needDisk ?? 0;
  const never = tooBig(o.needGiB, needCpu, limits, needDisk);
  if (never) return { failed: never };
  if (!anyRoomLimit(limits)) return { release: () => {}, waitedMs: 0 };
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = o.pollMs ?? 2000;
  const start = now();
  const me: RoomWaiter = { account: o.account, workspace: o.workspace ?? null, runId: o.runId ?? null, ...(o.key ? { key: o.key } : {}), since: o.since ?? start, needGiB: o.needGiB, needCpu, needDisk, limits };
  waiters.add(me);
  let lastSaid = "";
  let saidAt = 0;
  try {
    for (;;) {
      let unlock!: () => void;
      const mine = new Promise<void>((r) => (unlock = r));
      const before = chain;
      chain = before.then(() => mine);
      await before;
      // Every waiter of the run reads the mark, not just the first: it is
      // dropped by its own timer. Until 21 Oct 2026 the first waiter deleted
      // it and the other nineteen of a fan-out started anyway, and a stop
      // from the web tier never reached the worker's waiters at all.
      let isStopped = !!o.runId && stopped.has(o.runId);
      if (!isStopped && o.stopped) {
        try { isStopped = o.stopped(); } catch { /* an unreadable record is not a stop */ }
      }
      if (isStopped) {
        unlock();
        return { failed: "stopped while waiting for room to start" };
      }
      const pods = await o.listPods();
      // A cluster that does not answer is not a full one: go ahead, and let
      // the create say what is wrong, as it did before this gate existed.
      const block = pods ? roomBlock(roomTaken(pods, o.account, me.workspace ?? null, me.runId ?? null), o.needGiB, limits, needCpu, needDisk) : null;
      let why = block?.why ?? null;
      if (!why && pods) {
        let recorded: RoomWaiter[] = [];
        try { recorded = (await o.recorded?.()) ?? []; } catch { /* unreadable records order nothing */ }
        why = waitYourTurn(me, [...waiters], pods, recorded);
      }
      if (!why) {
        if (lastSaid) o.emit(`room: starting after ${Math.round((now() - start) / 1000)}s waiting`);
        return { release: unlock, waitedMs: now() - start };
      }
      unlock();
      // Said when it starts waiting, when the reason changes, and every five
      // minutes — a trail, not a heartbeat.
      if (why !== lastSaid || now() - saidAt >= 5 * 60_000) {
        if (why !== lastSaid) o.waiting?.(why, block?.level);
        o.emit(`room: waiting to start — ${why}`);
        lastSaid = why;
        saidAt = now();
      }
      if (o.mayDefer?.()) return { deferred: why };
      await sleep(pollMs);
    }
  } finally {
    waiters.delete(me);
  }
}
