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

/** What the run namespace holds now: the memory its live pods reserve
 *  (podGiB), and how many run pods this account has. Finished and deleting
 *  pods hold nothing. */
export interface RoomTaken {
  usedGiB: number;
  accountPods: number;
  /** What this account's live run pods hold: GiB reserved, cores capped. */
  accountGiB: number;
  accountCpu: number;
}

export function roomTaken(pods: PodLike[], account: string | null): RoomTaken {
  let usedGiB = 0;
  let accountPods = 0;
  let accountGiB = 0;
  let accountCpu = 0;
  for (const p of pods) {
    const phase = p.status?.phase;
    if (phase === "Succeeded" || phase === "Failed" || p.metadata?.deletionTimestamp) continue;
    usedGiB += podGiB(p);
    const labels = p.metadata?.labels ?? {};
    if (account && labels[RUN_LABEL] && labels[ACCOUNT_LABEL] === account) {
      accountPods += 1;
      accountGiB += podGiB(p);
      accountCpu += (p.spec?.containers ?? []).reduce((sum, c) => sum + cores(c), 0);
    }
  }
  return { usedGiB, accountPods, accountGiB, accountCpu };
}

export interface RoomLimits {
  /** GiB the run namespace may reserve; 0 is no limit. */
  budgetGiB: number;
  /** Run pods one account may have alive; 0 is no limit. */
  accountPods: number;
  /** The account's compute pool: GiB and cores its run pods may hold
   *  together; 0 is no limit. From accountCompute, per account. */
  accountGiB?: number;
  accountVcpu?: number;
  /** The most one step may hold; 0 is no limit. */
  stepGiB?: number;
  stepVcpu?: number;
}

export function roomLimits(env = process.env): RoomLimits {
  const n = (v: string | undefined) => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? x : 0;
  };
  return { budgetGiB: n(env.FOLDRUN_RUN_MEMORY_GIB), accountPods: Math.floor(n(env.FOLDRUN_ACCOUNT_PODS)) };
}

/** Why this step cannot start yet, or null when it can. A step bigger than
 *  the whole budget starts when nothing else holds room — refusing it
 *  forever would be worse than the scheduler's own answer. */
export function whyNoRoom(taken: { usedGiB: number; accountPods: number; accountGiB?: number; accountCpu?: number }, needGiB: number, limits: RoomLimits, needCpu = 0): string | null {
  if (limits.accountPods && taken.accountPods >= limits.accountPods) {
    return `this account has ${taken.accountPods} sandbox${taken.accountPods === 1 ? "" : "es"} running, its most at once`;
  }
  const n = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
  const heldGiB = taken.accountGiB ?? 0;
  const heldCpu = taken.accountCpu ?? 0;
  if (limits.accountGiB && heldGiB > 0 && heldGiB + needGiB > limits.accountGiB + 1e-9) {
    return `${n(heldGiB)} of this account's ${n(limits.accountGiB)} GiB is held by its running steps and this one needs ${n(needGiB)}`;
  }
  if (limits.accountVcpu && heldCpu > 0 && heldCpu + needCpu > limits.accountVcpu + 1e-9) {
    return `${n(heldCpu)} of this account's ${n(limits.accountVcpu)} vCPU is held by its running steps and this one needs ${n(needCpu)}`;
  }
  if (limits.budgetGiB && taken.usedGiB > 0 && taken.usedGiB + needGiB > limits.budgetGiB + 1e-9) {
    return `${taken.usedGiB.toFixed(1)} GiB of the ${limits.budgetGiB} GiB for runs is in use and this step needs ${needGiB.toFixed(1)}`;
  }
  return null;
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

/** Why this step can never start under the account's limits, or null: it
 *  alone is bigger than the plan's step maximum or the whole pool. Said at
 *  once rather than waited on — no running step finishing makes room. */
export function tooBigForAccount(needGiB: number, needCpu: number, limits: RoomLimits): string | null {
  const n = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
  const fix = "— ask for less with size: or resources:, or a plan that allows more";
  if (limits.stepGiB && needGiB > limits.stepGiB + 1e-9) return `this step holds ${n(needGiB)} GiB and one step on this account may hold ${n(limits.stepGiB)} ${fix}`;
  if (limits.stepVcpu && needCpu > limits.stepVcpu + 1e-9) return `this step holds ${n(needCpu)} vCPU and one step on this account may hold ${n(limits.stepVcpu)} ${fix}`;
  if (limits.accountGiB && needGiB > limits.accountGiB + 1e-9) return `this step holds ${n(needGiB)} GiB, more than this account's ${n(limits.accountGiB)} GiB for all its running steps ${fix}`;
  if (limits.accountVcpu && needCpu > limits.accountVcpu + 1e-9) return `this step holds ${n(needCpu)} vCPU, more than this account's ${n(limits.accountVcpu)} vCPU for all its running steps ${fix}`;
  return null;
}

/** A step waiting for room: its account, its place in line (when it first
 *  found none, carried across re-drives on the step record) and what it
 *  needs under which limits. */
export interface RoomWaiter {
  account: string | null;
  since: number;
  needGiB: number;
  needCpu: number;
  limits: RoomLimits;
}

/**
 * The fair order (27 Oct 2026): why a step that would fit must still wait
 * its turn, or null. Without it every waiter re-tried on its own clock, and
 * a big step could wait forever while smaller ones took each gap.
 *
 *   · an older step of the same account waits first — in this worker, or
 *     on the records (`recorded`: another worker's, or one whose run waits
 *     in the queue). A later, smaller step of an account never passes its
 *     older one;
 *   · room on the node is kept for the oldest step of another account that
 *     its own account's limits would let start — in this worker or on the
 *     records, its run waiting in the queue — so the node's last gigabytes
 *     go to it, not to whoever polls next.
 *
 * Equal ages do not order each other. Pure: the pods are the cluster's
 * answer this round, `others` the waiters this worker holds.
 */
export function waitYourTurn(me: RoomWaiter, others: readonly RoomWaiter[], pods: PodLike[], recorded: readonly RoomWaiter[] = []): string | null {
  const older = (w: RoomWaiter) => w !== me && w.since < me.since;
  const age = (w: RoomWaiter) => {
    const m = Math.max(0, Math.round((Date.now() - w.since) / 60_000));
    return m < 1 ? "under a minute" : `${m} minute${m === 1 ? "" : "s"}`;
  };
  const first = [...others, ...recorded].filter((w) => older(w) && me.account !== null && w.account === me.account).sort((a, b) => a.since - b.since)[0];
  if (first) return `an older step of this account has waited ${age(first)} for room and starts first`;
  if (!me.limits.budgetGiB) return null;
  const used = roomTaken(pods, null).usedGiB;
  for (const w of [...others, ...recorded].filter(older).sort((a, b) => a.since - b.since)) {
    if (w.account === me.account) continue;
    const taken = roomTaken(pods, w.account);
    // Held back by its own account (its pool, its pod count): node room
    // kept for it would only sit idle.
    if (whyNoRoom(taken, w.needGiB, { ...w.limits, budgetGiB: 0 }, w.needCpu)) continue;
    // Kept whether or not it fits this moment: one that fits now but has
    // not looked yet would otherwise lose the gap to whoever looks first
    // (Codex review). It looks within its own poll, or its next recheck.
    if (used + me.needGiB + w.needGiB > me.limits.budgetGiB + 1e-9) {
      return `room on the node is kept for an older step of another account that has waited ${age(w)}`;
    }
    return null;
  }
  return null;
}

// The steps waiting in this worker, for the fair order.
const waiters = new Set<RoomWaiter>();

/** Why `me` cannot start now, or null — the room gate's whole answer for
 *  one look, without waiting or taking the lock (core platform.roomCheck,
 *  before a step waiting in the queue is started again). */
export function roomFor(me: RoomWaiter, pods: PodLike[], recorded: readonly RoomWaiter[] = []): string | null {
  return whyNoRoom(roomTaken(pods, me.account), me.needGiB, me.limits, me.needCpu) ?? waitYourTurn(me, [...waiters], pods, recorded);
}

export interface AdmitOptions {
  account: string | null;
  needGiB: number;
  /** The cores this step's pod is capped at — what the account's pool counts. */
  needCpu?: number;
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
  /** Called when it finds no room, and again when the reason changes. */
  waiting?: (why: string) => void;
  /** Whether it may stop waiting here and answer `deferred`, so its run
   *  waits in the queue instead (core runner.ts mayDefer). Absent or false:
   *  it waits here. There is no time limit either way (27 Oct 2026). */
  mayDefer?: () => boolean;
  /** This account's steps waiting for room on the run records — another
   *  worker's, and those whose runs wait in the queue. Its own is among
   *  them; an equal age orders nothing, so it never waits on itself. */
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
  const never = tooBigForAccount(o.needGiB, needCpu, limits);
  if (never) return { failed: never };
  if (!limits.budgetGiB && !limits.accountPods && !limits.accountGiB && !limits.accountVcpu) return { release: () => {}, waitedMs: 0 };
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = o.pollMs ?? 2000;
  const start = now();
  const me: RoomWaiter = { account: o.account, since: o.since ?? start, needGiB: o.needGiB, needCpu, limits };
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
      let why = pods ? whyNoRoom(roomTaken(pods, o.account), o.needGiB, limits, needCpu) : null;
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
        if (why !== lastSaid) o.waiting?.(why);
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
