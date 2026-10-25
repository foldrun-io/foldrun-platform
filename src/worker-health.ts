// The worker's health, answered from its own thread (FOL-18).
//
// The probe used to be answered on the worker's main thread, so any long
// synchronous stretch there — a quadratic merge on 6 Oct 2026, sync file
// reads on a stalled NFS mount, a big copy-back — left /api/healthz with no
// answer at all, and the liveness probe killed a worker that was busy, not
// stuck. Runs paused while the next one started.
//
// Now a worker_thread holds the port. The main thread writes three numbers
// into shared memory: a heartbeat every second, when its last tick
// finished, and what its last database/Redis check found. The thread reads
// them, so it answers even while the main thread is blocked, and says how
// long that has been (`loopLagMs`). A blocked loop is reported, not
// punished, until it has lasted FOLDRUN_WORKER_BLOCKED_MS (ten minutes):
// past that it is stuck, and 503 lets the liveness probe replace the pod.

import { Worker } from "node:worker_threads";

/** A check that has not answered in this long counts as down. */
export const CHECK_DEADLINE_MS = 5_000;

/** `p`, or false once `ms` have passed: a connection that hangs without
 *  closing must read as down, not keep the last good answer (Codex review). */
export function withDeadline(p: Promise<boolean>, ms = CHECK_DEADLINE_MS): Promise<boolean> {
  return new Promise((resolve) => {
    // Not unref'd: a pending check must still reach its answer, and five
    // seconds of a held-open process costs nothing (a test with nothing else
    // alive exited before the deadline fired — box deploy 39100233066).
    const t = setTimeout(() => resolve(false), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      () => { clearTimeout(t); resolve(false); },
    );
  });
}

/** The shared slots, as indexes into a BigInt64Array. */
export const SLOT = { ready: 0, loopBeatAt: 1, tickAt: 2, database: 3, redis: 4, checkedAt: 5 } as const;
export const SLOTS = 6;

/** A check's answer in one slot: not configured, answered, or did not. */
export const CHECK = { none: 0, ok: 1, down: 2 } as const;

export interface HealthSnapshot {
  ready: boolean;
  /** When the main thread's event loop last ran its heartbeat. */
  loopBeatAt: number;
  /** When the worker's last tick finished; 0 before the first. */
  tickAt: number;
  database: boolean | null;
  redis: boolean | null;
  /** When those two were last checked; 0 before the first check. */
  checkedAt: number;
}

export interface HealthLimits {
  /** A tick this old while the loop still runs: up, doing nothing. */
  staleMs: number;
  /** The loop held this long: stuck, not busy. */
  blockedMs: number;
}

export function healthLimits(env: NodeJS.ProcessEnv = process.env): HealthLimits {
  return {
    staleMs: Number(env.FOLDRUN_WORKER_STALE_MS) || 3 * 60_000,
    blockedMs: Number(env.FOLDRUN_WORKER_BLOCKED_MS) || 10 * 60_000,
  };
}

export interface HealthVerdict {
  ok: boolean;
  database: boolean | null;
  redis: boolean | null;
  tickAgeMs: number;
  stale: boolean;
  loopLagMs: number;
  blocked: boolean;
  /** How old the database/Redis answers are: they are only as fresh as the
   *  main thread's last check, which a blocked loop does not run. */
  checkedAgeMs: number | null;
}

/**
 * What the probe answers. Before boot: not ok. A loop held past `blockedMs`:
 * not ok — stuck. A tick older than `staleMs` while the loop is NOT held:
 * not ok — the old "up and doing nothing". A loop that is merely busy has
 * a stale tick too, and that is not counted until it is blocked.
 */
export function healthVerdict(s: HealthSnapshot, now: number, limits: HealthLimits): HealthVerdict {
  const loopLagMs = Math.max(0, now - s.loopBeatAt);
  const tickAgeMs = s.ready && s.tickAt ? Math.max(0, now - s.tickAt) : 0;
  // The heartbeat runs every second; a few seconds late is a busy loop.
  const held = loopLagMs > 5_000;
  const blocked = loopLagMs > limits.blockedMs;
  const stale = !held && tickAgeMs > limits.staleMs;
  // The database/Redis answers are re-checked every ten seconds, each
  // inside a deadline. Older than a minute while the loop runs means the
  // checks themselves have stopped: not ok. None yet: not ok either, so a
  // check that never answered is not read as "not configured".
  const checkedAgeMs = s.checkedAt ? Math.max(0, now - s.checkedAt) : null;
  const unchecked = checkedAgeMs === null || (!held && checkedAgeMs > 60_000);
  const ok = s.ready && !unchecked && s.database !== false && s.redis !== false && !stale && !blocked;
  return {
    ok,
    database: s.database,
    redis: s.redis,
    tickAgeMs,
    stale,
    loopLagMs,
    blocked,
    checkedAgeMs,
  };
}

const toCheck = (v: boolean | null) => BigInt(v === null ? CHECK.none : v ? CHECK.ok : CHECK.down);
export const fromCheck = (v: bigint): boolean | null => (Number(v) === CHECK.none ? null : Number(v) === CHECK.ok);

export function readSnapshot(slots: BigInt64Array): HealthSnapshot {
  const at = (i: number) => Number(Atomics.load(slots, i));
  return {
    ready: at(SLOT.ready) === 1,
    loopBeatAt: at(SLOT.loopBeatAt),
    tickAt: at(SLOT.tickAt),
    database: fromCheck(Atomics.load(slots, SLOT.database)),
    redis: fromCheck(Atomics.load(slots, SLOT.redis)),
    checkedAt: at(SLOT.checkedAt),
  };
}

export interface HealthHandle {
  slots: BigInt64Array;
  setReady(): void;
  /** Stops the heartbeat and the thread; the port closes with it. */
  close(): Promise<void>;
}

/**
 * Start the thread on `port`, and the main thread's side of it: the
 * heartbeat (every second, with the tick's age) and the database/Redis
 * check (every ten seconds). Both timers are unref'd; the thread is not,
 * so it is what keeps the process alive between ticks, as the server used
 * to. A thread that dies is started again.
 */
export function startHealth(opts: {
  port: number;
  version: string | null;
  tickAge: () => number;
  checks: () => Promise<{ database: boolean | null; redis: boolean | null }>;
}): HealthHandle {
  const slots = new BigInt64Array(new SharedArrayBuffer(SLOTS * 8));
  const beat = () => {
    const now = Date.now();
    Atomics.store(slots, SLOT.loopBeatAt, BigInt(now));
    const age = opts.tickAge();
    Atomics.store(slots, SLOT.tickAt, BigInt(age > 0 ? now - age : 0));
  };
  beat();
  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      const { database, redis } = await opts.checks();
      Atomics.store(slots, SLOT.database, toCheck(database));
      Atomics.store(slots, SLOT.redis, toCheck(redis));
      Atomics.store(slots, SLOT.checkedAt, BigInt(Date.now()));
    } catch (err) {
      console.error("[foldrun] worker health check:", err instanceof Error ? err.message : err);
    } finally {
      checking = false;
    }
  };
  void check();
  const beater = setInterval(beat, 1_000);
  const checker = setInterval(() => void check(), 10_000);
  beater.unref();
  checker.unref();

  let closing = false;
  let thread: Worker;
  const spawn = () => {
    thread = new Worker(new URL("./worker-health-thread.ts", import.meta.url), {
      workerData: { slots, port: opts.port, version: opts.version, limits: healthLimits() },
    });
    thread.on("error", (err: Error) => console.error("[foldrun] worker health thread:", err.message));
    thread.on("exit", (code) => {
      if (closing) return;
      console.error(`[foldrun] worker health thread exited (${code}) — starting it again`);
      setTimeout(spawn, 1_000).unref();
    });
  };
  spawn();

  return {
    slots,
    setReady: () => {
      Atomics.store(slots, SLOT.ready, 1n);
      void check();
    },
    close: async () => {
      closing = true;
      clearInterval(beater);
      clearInterval(checker);
      await thread.terminate();
    },
  };
}
