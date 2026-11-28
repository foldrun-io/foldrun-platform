// Admission per customer at the door (FOL-477, 28 Nov 2026).
//
// The outage that started this: one account's builds filled the database's
// connections and every other account's answers, sign-ins and run starts
// failed with it. The work that costs the database most — a deploy, a run
// start, a file upload — takes a PERMIT before it touches anything; the work
// that must always go through never asks for one.
//
//   take a permit      deploy, run start, uploads. Each door has its own
//                      limit per account (one account's burst fills its own
//                      permits, never another's), and all three share one
//                      install-wide cap. Over the account's limit: 429.
//                      Over the install's cap: 503. Both say when to come
//                      back (Retry-After) and nothing was started.
//   never asks         answering an agent's question, approving, stopping, a
//                      worker finishing a step (`reserved`). They are not
//                      counted against the permits, so a full house of
//                      deploys leaves room for them by construction; they are
//                      counted for the log, so the room can be watched.
//
// A permit is a member of a Valkey sorted set scored by its own expiry, one
// set per account and door and one for the install, taken by one script so
// two web pods never both take the last one. A permit that is never given
// back (a pod killed mid-request) lapses at its expiry, so a crash leaks
// nothing for longer than `admission.permit_seconds`.
//
// What lives here is rebuildable (docs/paas-adr.md): wipe Valkey and the
// platform admits everything for a moment. With no Valkey configured, or one
// that does not answer, the same limits hold per process — one pod's share,
// never an open door and never a locked one.
//
// Limits are console settings (settings.ts, group limits), read on each call:
// a change takes effect on the next request, without a deploy.

import crypto from "node:crypto";
import { opsLog } from "../../foldrun-core/src/ops-log.ts";
import { cache } from "./cache.ts";
import { setting } from "./settings.ts";

/** The doors that take a permit. */
export type Door = "deploy" | "run_start" | "upload";
/** The calls that never do. */
export type Reserved = "answer" | "approve" | "stop" | "completion";

export const DOORS: Door[] = ["deploy", "run_start", "upload"];

const LIMIT_KEY: Record<Door, string> = {
  deploy: "admission.deploy_per_account",
  run_start: "admission.run_start_per_account",
  upload: "admission.upload_per_account",
};

/** Why a request was turned away: its account is at its own limit (429), or
 *  the whole install is at its cap (503). Carries what the API answers with. */
export class Busy extends Error {
  status: 429 | 503;
  code: "busy_account" | "busy_install";
  retryAfter: number;
  limit: number;
  door: Door;
  constructor(door: Door, scope: "account" | "install", limit: number, retryAfter: number) {
    const what = door === "run_start" ? "starting runs" : door === "deploy" ? "deploys" : "uploads";
    super(
      scope === "account"
        ? `this account already has ${limit} ${what} in progress, its limit — nothing was started. Try again in ${retryAfter} s`
        : `foldrun is busy with ${what} right now — nothing was started. Try again in ${retryAfter} s`,
    );
    this.name = "Busy";
    this.status = scope === "account" ? 429 : 503;
    this.code = scope === "account" ? "busy_account" : "busy_install";
    this.retryAfter = retryAfter;
    this.limit = limit;
    this.door = door;
  }
}

export interface Permit {
  /** Give the permit back. Safe to call twice. */
  release(): Promise<void>;
}

const NO_PERMIT: Permit = { release: async () => undefined };

/** Taken in one step, so two pods never both take the last one. KEYS: the
 *  account's set, the install's set. ARGV: now, ttl (ms), account limit,
 *  install cap (0 = none), permit id. Answers 0 (taken), 1 (account full) or
 *  2 (install full). */
const TAKE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
local acct = tonumber(ARGV[3])
local cap = tonumber(ARGV[4])
if acct > 0 and redis.call('ZCARD', KEYS[1]) >= acct then return 1 end
if cap > 0 and redis.call('ZCARD', KEYS[2]) >= cap then return 2 end
local expiry = tonumber(ARGV[1]) + tonumber(ARGV[2])
redis.call('ZADD', KEYS[1], expiry, ARGV[5])
redis.call('ZADD', KEYS[2], expiry, ARGV[5])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]) * 2)
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[2]) * 2)
return 0
`;

/** The same limits without Valkey: permits held by this process, by expiry. */
const held = new Map<string, Map<string, number>>();
const INSTALL = "install";

function live(set: string, now: number): Map<string, number> {
  let m = held.get(set);
  if (!m) held.set(set, (m = new Map()));
  for (const [id, until] of m) if (until <= now) m.delete(id);
  return m;
}

function takeLocal(account: string, limit: number, cap: number, ttlMs: number, id: string): 0 | 1 | 2 {
  const now = Date.now();
  const mine = live(account, now);
  const all = live(INSTALL, now);
  if (limit > 0 && mine.size >= limit) return 1;
  if (cap > 0 && all.size >= cap) return 2;
  mine.set(id, now + ttlMs);
  all.set(id, now + ttlMs);
  return 0;
}

const num = (key: string, fallback: number): number => {
  const v = setting(key);
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
};

const setKey = (tenant: string, door: Door) => `adm:${door}:${tenant}`;
const installKey = () => `adm:install`;

/**
 * Take a permit for `door` on behalf of `tenant`, or throw Busy. The caller
 * gives it back (`release`) when the work is done, success or not — use
 * `admitted` so that is never forgotten. `admission.enabled` off: no permit
 * is ever refused.
 */
export async function admit(door: Door, tenant: string): Promise<Permit> {
  if (setting("admission.enabled") === false) return NO_PERMIT;
  const limit = num(LIMIT_KEY[door], 0);
  const cap = num("admission.install_cap", 0);
  if (limit <= 0 && cap <= 0) return NO_PERMIT;
  const retryAfter = Math.max(1, Math.round(num("admission.retry_after_seconds", 3)));
  const ttlMs = Math.max(5, num("admission.permit_seconds", 120)) * 1000;
  const id = crypto.randomUUID();
  const acctKey = setKey(tenant, door);

  let verdict: 0 | 1 | 2 | null = null;
  const c = cache();
  if (c) {
    try {
      verdict = Number(await c.eval(TAKE, 2, acctKey, installKey(), String(Date.now()), String(ttlMs), String(limit), String(cap), id)) as 0 | 1 | 2;
    } catch {
      // Valkey did not answer: this process's own count, below.
    }
  }
  if (verdict === null) verdict = takeLocal(acctKey, limit, cap, ttlMs, id);

  if (verdict !== 0) {
    const scope = verdict === 1 ? "account" : "install";
    noteRefused(door, scope, tenant, scope === "account" ? limit : cap);
    throw new Busy(door, scope, scope === "account" ? limit : cap, retryAfter);
  }

  let given = false;
  return {
    async release() {
      if (given) return;
      given = true;
      held.get(acctKey)?.delete(id);
      held.get(INSTALL)?.delete(id);
      const r = cache();
      if (!r) return;
      try {
        await r.multi().zrem(acctKey, id).zrem(installKey(), id).exec();
      } catch {
        // The permit lapses at its expiry; a failed release is a short wait.
      }
    },
  };
}

/** Run `work` holding a permit for `door`; the permit goes back however it ends. */
export async function admitted<T>(door: Door, tenant: string, work: () => Promise<T>): Promise<T> {
  const permit = await admit(door, tenant);
  try {
    return await work();
  } finally {
    await permit.release();
  }
}

const reservedSeen: Record<Reserved, number> = { answer: 0, approve: 0, stop: 0, completion: 0 };

/**
 * The calls that must always go through. Never refused, never counted against
 * a permit; counted, so what the reserved room carries can be read off the
 * log line `admission.reserved` (every hundredth call of a kind).
 */
export function reserved(kind: Reserved): void {
  reservedSeen[kind] += 1;
  if (reservedSeen[kind] % 100 === 1) opsLog("info", "admission.reserved", { kind, total: reservedSeen[kind] });
}

const refusedSeen = new Map<string, number>();

/** One line for the first refusal of an account at a door and one for every
 *  25th after it, so a burst answers thousands of requests and writes a few
 *  lines. `count` is the limit that was hit, `op` the door, `reason` whose. */
function noteRefused(door: Door, scope: "account" | "install", tenant: string, limit: number): void {
  const k = `${door}:${scope}:${tenant}`;
  const n = (refusedSeen.get(k) ?? 0) + 1;
  if (refusedSeen.size > 5_000) refusedSeen.clear();
  refusedSeen.set(k, n);
  if (n % 25 === 1) opsLog("warn", "admission.refused", { op: door, reason: scope, tenant, count: limit, total: n });
}

/** Permits held right now, for the door's gauge and the tests. */
export async function holding(door: Door, tenant: string): Promise<number> {
  const c = cache();
  if (c) {
    try {
      await c.zremrangebyscore(setKey(tenant, door), "-inf", Date.now());
      return await c.zcard(setKey(tenant, door));
    } catch {
      // fall through to this process's count
    }
  }
  return live(setKey(tenant, door), Date.now()).size;
}

/** Forget this process's own permits (tests). */
export function resetLocalAdmission(): void {
  held.clear();
}
