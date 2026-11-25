// How many web_search and web_fetch calls run at once (FOL-324, owner 25 Nov
// 2026: caps on the heavy tools, per subscriber and one platform-wide; not a
// spending limit — money is the admission's, FOL-313).
//
// A key is already held to FOLDRUN_GATEWAY_CONCURRENCY open calls, and one
// call runs its tools one at a time, so this adds the two bounds a key cannot
// give: one ACCOUNT across all its keys, and one gateway PROCESS across every
// account (the page downloads and SerpApi calls it makes).
//
//   - Under the search cache (tool-cache.ts): a hit takes no slot; only a call
//     that goes upstream does.
//   - Over a cap a call waits its turn (first come, first served) up to
//     FOLDRUN_TOOL_WAIT_MS, then answers Anthropic's own `too_many_requests`,
//     which the model reads as any provider's.
//   - A caller that leaves while waiting gives its place up at once.
//   - In memory, per process. A gateway pod's own load is what the process
//     cap protects; the account cap is per pod too, so N pods allow N times
//     it — still bounded, and nothing to lose when Redis is down.
//   - web_browse goes straight through: its job queue has its own limits.

import { opsLog } from "../../foldrun-core/src/ops-log.ts";
import type { ToolRunners } from "./server-tools.ts";

export interface ToolLimits {
  perAccount: number;
  perProcess: number;
  waitMs: number;
  /** Callers that may wait at once in one process; past it, refused at once. */
  maxWaiting: number;
}

const whole = (v: string | undefined, d: number, max: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : d;
};

/** The caps, from the environment: FOLDRUN_TOOL_PER_ACCOUNT (16),
 *  FOLDRUN_TOOL_PER_PROCESS (128), FOLDRUN_TOOL_WAIT_MS (10000),
 *  FOLDRUN_TOOL_MAX_WAITING (256). */
export function toolLimits(env: NodeJS.ProcessEnv = process.env): ToolLimits {
  return {
    perAccount: whole(env.FOLDRUN_TOOL_PER_ACCOUNT, 16, 10_000),
    perProcess: whole(env.FOLDRUN_TOOL_PER_PROCESS, 128, 100_000),
    waitMs: whole(env.FOLDRUN_TOOL_WAIT_MS, 10_000, 120_000),
    maxWaiting: whole(env.FOLDRUN_TOOL_MAX_WAITING, 256, 100_000),
  };
}

interface Waiter {
  tenant: string;
  /** When its wait ends, checked again at hand-off: a timer that is late
   *  because the event loop was busy never lets an overdue caller in. */
  deadline: number;
  grant: () => void;
  expire: () => void;
  /** Its place: the queue it is in (none once it has left) and its
   *  neighbours there, so leaving unlinks it at once (Codex). */
  q: Queue | null;
  prev: Waiter | null;
  next: Waiter | null;
}

/** First in, first out, doubly linked: push, take the front and remove any
 *  waiter are all O(1), and nothing that left stays in it. */
class Queue {
  head: Waiter | null = null;
  tail: Waiter | null = null;
  readonly tenant: string | null;
  constructor(tenant: string | null) {
    this.tenant = tenant;
  }
  push(w: Waiter) {
    w.q = this;
    w.prev = this.tail;
    w.next = null;
    if (this.tail) this.tail.next = w;
    else this.head = w;
    this.tail = w;
  }
  remove(w: Waiter) {
    if (w.q !== this) return;
    if (w.prev) w.prev.next = w.next;
    else this.head = w.next;
    if (w.next) w.next.prev = w.prev;
    else this.tail = w.prev;
    w.q = w.prev = w.next = null;
  }
}

// Slots in use, per account and in all. The line: every waiter in arrival
// order, and, per account, the ones parked because that account was at its
// own cap when the line reached them. A parked waiter is older than all of
// the line behind it, and only its own account's release can let it in, so
// that release serves it first. Each waiter is handled a fixed number of
// times however long the line is, and one that leaves is unlinked at once,
// so the queues hold exactly the live waiters (at most maxWaiting).
const running = new Map<string, number>();
let total = 0;
let line = new Queue(null);
const parked = new Map<string, Queue>();
let waiting = 0;
const waitingBy = new Map<string, number>();
let refusedLogged = 0;

const fits = (tenant: string, l: ToolLimits) => total < l.perProcess && (running.get(tenant) ?? 0) < l.perAccount;

function take(tenant: string) {
  total++;
  running.set(tenant, (running.get(tenant) ?? 0) + 1);
}

/** A waiter leaves: out of its queue and out of the counts. */
function leave(w: Waiter) {
  const q = w.q;
  if (!q) return;
  q.remove(w);
  if (q.tenant !== null && !q.head) parked.delete(q.tenant);
  waiting--;
  const n = (waitingBy.get(w.tenant) ?? 1) - 1;
  if (n > 0) waitingBy.set(w.tenant, n);
  else waitingBy.delete(w.tenant);
}

/** Hand the slots that are free to the waiters next in turn. Callers are
 *  settled after, so none runs while the queues are being read; the clock
 *  is read at each admission, so a long pass never lets in an overdue one. */
function handOff(freedBy: string, l: ToolLimits) {
  const settle: (() => void)[] = [];
  const admit = (w: Waiter) => {
    leave(w);
    if (performance.now() >= w.deadline) {
      settle.push(w.expire);
      return;
    }
    take(w.tenant);
    settle.push(w.grant);
  };
  // The releasing account's own parked waiters were ahead of the whole line.
  for (let w = parked.get(freedBy)?.head; w && fits(freedBy, l); w = parked.get(freedBy)?.head) admit(w);
  // Then the line, in order; one whose account is at its cap is parked.
  for (let w = line.head; w && total < l.perProcess; w = line.head) {
    if (performance.now() >= w.deadline || fits(w.tenant, l)) admit(w);
    else {
      line.remove(w);
      let q = parked.get(w.tenant);
      if (!q) parked.set(w.tenant, (q = new Queue(w.tenant)));
      q.push(w);
    }
  }
  for (const f of settle) f();
}

function give(tenant: string, l: ToolLimits) {
  total--;
  const n = (running.get(tenant) ?? 1) - 1;
  if (n > 0) running.set(tenant, n);
  else running.delete(tenant);
  handOff(tenant, l);
}

/** A slot for one upstream call, or why there is none. */
async function slot(tenant: string, l: ToolLimits, signal?: AbortSignal): Promise<"ok" | "busy" | "full" | "gone"> {
  if (signal?.aborted) return "gone";
  // Nobody of this account is waiting (a newcomer never passes its own
  // account's waiters), and the slot is free.
  if (fits(tenant, l) && !waitingBy.has(tenant)) {
    take(tenant);
    return "ok";
  }
  // The line itself is bounded: a burst across many keys is refused at
  // once rather than held, each with its timer, on the gateway (Codex).
  if (waiting >= l.maxWaiting) return "full";
  return new Promise((resolve) => {
    let settled = false;
    const w: Waiter = { tenant, deadline: performance.now() + l.waitMs, grant: () => done("ok"), expire: () => done("busy"), q: null, prev: null, next: null };
    const timer = setTimeout(() => done("busy"), l.waitMs);
    const onAbort = () => done("gone");
    signal?.addEventListener("abort", onAbort, { once: true });
    line.push(w);
    waiting++;
    waitingBy.set(tenant, (waitingBy.get(tenant) ?? 0) + 1);
    function done(why: "ok" | "busy" | "gone") {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // handOff has taken a granted or expired waiter out already; a timer
      // or an abort takes itself out here, at once.
      leave(w);
      resolve(why);
    }
  });
}

/** Entries held in the queues (tests: they hold the live waiters only). */
export function toolLimitsHeld(): number {
  let n = 0;
  for (let w = line.head; w; w = w.next) n++;
  for (const q of parked.values()) for (let w = q.head; w; w = w.next) n++;
  return n;
}

function refused(tenant: string, tool: string, why: "busy" | "full", waitedMs: number) {
  // One line a minute at most: a flood of refusals is one event to read.
  const now = Date.now();
  if (now - refusedLogged < 60_000) return;
  refusedLogged = now;
  // outcome: "busy" waited out its time, "full" found the line full and did
  // not wait; count: this account's calls running; total: the process's;
  // ms: how long it waited.
  opsLog("warn", "tool_limits.refused", { tenant, tool, outcome: why, count: running.get(tenant) ?? 0, total, ms: waitedMs });
}

/** `runners` held to the caps above for `tenant`. */
export function withToolLimits(tenant: string, runners: ToolRunners, opts: { limits?: ToolLimits } = {}): ToolRunners {
  const limits = () => opts.limits ?? toolLimits();
  const held = async <T>(tool: string, signal: AbortSignal | undefined, gone: T, busy: T, run: () => Promise<T>): Promise<T> => {
    const l = limits();
    const t0 = Date.now();
    const got = await slot(tenant, l, signal);
    if (got === "gone") return gone;
    if (got === "busy" || got === "full") {
      refused(tenant, tool, got, Date.now() - t0);
      return busy;
    }
    try {
      return await run();
    } finally {
      give(tenant, l);
    }
  };
  return {
    search: (q, ctx) => held("search", ctx.signal, { error: "unavailable" as const }, { error: "too_many_requests" as const }, () => runners.search(q, ctx)),
    fetchPage: (url, o) => held("fetch", o.signal, { error: "unavailable" as const }, { error: "too_many_requests" as const }, () => runners.fetchPage(url, o)),
    ...(runners.browse ? { browse: runners.browse.bind(runners) } : {}),
  };
}

/** What is held right now (tests, and the ops view). */
export function toolLimitsNow(): { total: number; waiting: number; accounts: Record<string, number> } {
  return { total, waiting, accounts: Object.fromEntries(running) };
}

export function resetToolLimitsForTests() {
  running.clear();
  total = 0;
  line = new Queue(null);
  parked.clear();
  waiting = 0;
  waitingBy.clear();
  refusedLogged = 0;
}
