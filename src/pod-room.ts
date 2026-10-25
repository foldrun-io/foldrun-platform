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
//     fan-out takes its turns instead of the node.
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
export function roomTaken(pods: PodLike[], account: string | null): { usedGiB: number; accountPods: number } {
  let usedGiB = 0;
  let accountPods = 0;
  for (const p of pods) {
    const phase = p.status?.phase;
    if (phase === "Succeeded" || phase === "Failed" || p.metadata?.deletionTimestamp) continue;
    usedGiB += podGiB(p);
    const labels = p.metadata?.labels ?? {};
    if (account && labels[RUN_LABEL] && labels[ACCOUNT_LABEL] === account) accountPods += 1;
  }
  return { usedGiB, accountPods };
}

export interface RoomLimits {
  /** GiB the run namespace may reserve; 0 is no limit. */
  budgetGiB: number;
  /** Run pods one account may have alive; 0 is no limit. */
  accountPods: number;
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
export function whyNoRoom(taken: { usedGiB: number; accountPods: number }, needGiB: number, limits: RoomLimits): string | null {
  if (limits.accountPods && taken.accountPods >= limits.accountPods) {
    return `this account has ${taken.accountPods} sandbox${taken.accountPods === 1 ? "" : "es"} running, its most at once`;
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

export interface AdmitOptions {
  account: string | null;
  needGiB: number;
  runId?: string;
  /** Whether the run was stopped, read from its record. The mark below is
   *  only this process's: the stop is usually written by another (the web
   *  tier), and the steps waiting here are the worker's. */
  stopped?: () => boolean;
  limits?: RoomLimits;
  /** The run namespace's pods, or null when the cluster did not answer. */
  listPods: () => Promise<PodLike[] | null>;
  emit: (line: string) => void;
  /** Longest wait before the step fails; FOLDRUN_ROOM_WAIT_SEC, default 30 min. */
  maxWaitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Wait for room, then hold the worker's lock until the caller has created
 * its pod: `release()` must be called once the create has returned, success
 * or not. Answers `{ waitedMs }`, or a reason the step should fail with.
 */
export async function admitPod(o: AdmitOptions): Promise<{ release: () => void; waitedMs: number } | { failed: string }> {
  const limits = o.limits ?? roomLimits();
  if (!limits.budgetGiB && !limits.accountPods) return { release: () => {}, waitedMs: 0 };
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = o.pollMs ?? 2000;
  const maxWaitMs = o.maxWaitMs ?? (Number(process.env.FOLDRUN_ROOM_WAIT_SEC) > 0 ? Number(process.env.FOLDRUN_ROOM_WAIT_SEC) * 1000 : 30 * 60_000);
  const start = now();
  let lastSaid = "";
  let saidAt = 0;
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
    const why = pods ? whyNoRoom(roomTaken(pods, o.account), o.needGiB, limits) : null;
    if (!why) {
      if (lastSaid) o.emit(`room: starting after ${Math.round((now() - start) / 1000)}s waiting`);
      return { release: unlock, waitedMs: now() - start };
    }
    unlock();
    if (now() - start >= maxWaitMs) {
      return { failed: `no room to start for ${Math.round(maxWaitMs / 60_000)} minutes — ${why}` };
    }
    // Said when it starts waiting, when the reason changes, and every five
    // minutes — a trail, not a heartbeat.
    if (why !== lastSaid || now() - saidAt >= 5 * 60_000) {
      o.emit(`room: waiting to start — ${why}`);
      lastSaid = why;
      saidAt = now();
    }
    await sleep(pollMs);
  }
}
