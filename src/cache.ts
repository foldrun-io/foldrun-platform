// Redis: only what can be rebuilt.
//
// The test for whether something belongs here (docs/paas-adr.md): if Redis is
// wiped, the platform gets slower and re-elects a worker, and loses no
// customer data. Rate-limit counters, leases, SSE fan-out, hot caches — yes.
// Runs, money, identity — never; those are Postgres, and the queue stays in
// the same database as the run records so a claim and a status write are one
// transaction. Adding Redis does not reopen that.
//
// OPTIONAL, like the database. With no FOLDRUN_REDIS_URL every function here
// degrades to a safe local answer rather than throwing — a laptop install has
// no Redis and must still refuse a brute-force attempt.
//
//   FOLDRUN_REDIS_URL   redis://host:6379

import { Redis } from "ioredis";

let client: Redis | null = null;
let down = false;

export function cacheEnabled(): boolean {
  return Boolean(process.env.FOLDRUN_REDIS_URL);
}

export function cache(): Redis | null {
  if (!cacheEnabled()) return null;
  if (!client) {
    client = new Redis(process.env.FOLDRUN_REDIS_URL!, {
      // A request must never hang waiting for a cache. Failing fast and
      // falling back is the whole point of holding only rebuildable state.
      connectTimeout: 2_000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false,
    });
    client.on("error", (err: Error) => {
      if (!down) console.error("[cache] redis unavailable:", err.message);
      down = true;
    });
    client.on("ready", () => {
      if (down) console.log("[cache] redis back");
      down = false;
    });
  }
  return client;
}

// ------------------------------------------------------------- rate limiting
//
// The gap this closes was live and exploitable: /api/auth/login had no limit
// at all, so a password could be guessed as fast as scrypt would answer.

/** In-process fallback, so a laptop with no Redis is still not a free oracle. */
const local = new Map<string, { n: number; resetAt: number }>();

export interface RateVerdict {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets — what a Retry-After header wants. */
  retryAfter: number;
}

/**
 * Fixed-window counter. Chosen over a sliding log because the failure mode of
 * a fixed window — up to 2x the limit across a boundary — is irrelevant for
 * login attempts, and it costs one INCR instead of a sorted set per attempt.
 *
 * Fails OPEN if Redis is unreachable, and says so. A cache outage must not
 * lock every customer out of their own account; the in-process counter below
 * still holds the line for a single replica, which is the common case.
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowSec: number,
): Promise<RateVerdict> {
  const c = cache();
  if (c) {
    try {
      const k = `rl:${key}`;
      const n = await c.incr(k);
      if (n === 1) await c.expire(k, windowSec);
      const ttl = n === 1 ? windowSec : await c.ttl(k);
      return {
        allowed: n <= limit,
        remaining: Math.max(0, limit - n),
        retryAfter: ttl > 0 ? ttl : windowSec,
      };
    } catch {
      // fall through to the local counter rather than refusing to serve
    }
  }

  const now = Date.now();
  const hit = local.get(key);
  if (!hit || hit.resetAt <= now) {
    local.set(key, { n: 1, resetAt: now + windowSec * 1000 });
    // Unbounded growth is the only way this map hurts; a sweep on write is
    // cheaper than a timer and runs exactly when entries are being added.
    if (local.size > 10_000) {
      for (const [k, v] of local) if (v.resetAt <= now) local.delete(k);
    }
    return { allowed: true, remaining: limit - 1, retryAfter: windowSec };
  }
  hit.n += 1;
  return {
    allowed: hit.n <= limit,
    remaining: Math.max(0, limit - hit.n),
    retryAfter: Math.ceil((hit.resetAt - now) / 1000),
  };
}

/** Forget a key — called on a SUCCESSFUL login, so one good password does not
 *  leave someone throttled by their own earlier typos. */
export async function rateLimitReset(key: string): Promise<void> {
  local.delete(key);
  const c = cache();
  if (!c) return;
  try {
    await c.del(`rl:${key}`);
  } catch {
    // a counter that outlives its reset is a slow login, not a broken one
  }
}

/** True when Redis answers. For healthz, never to gate a request. */
export async function cacheReady(): Promise<boolean> {
  const c = cache();
  if (!c) return false;
  try {
    return (await c.ping()) === "PONG";
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------- leases
//
// A lease says "one process is doing this job". The file version had to read,
// decide, then write — three steps, so two workers could both read "stale" and
// both write. It papered over that with a staleness window and a comment
// admitting the worst case was one bounded double-claim during a handover.
//
// `SET key owner NX PX ttl` has no window: the server decides, once. And the
// expiry is free — a dead holder's lease simply stops existing, rather than
// sitting there until someone notices it has gone quiet.

export interface LeaseState {
  held: boolean;
  /** Who held it before us, when this call was a takeover. For the log line
   *  that turns a silent handover into a timestamped one. */
  tookOverFrom?: string;
}

/**
 * Wait, briefly, for the connection. The client never queues a command while
 * connecting (enableOfflineQueue: false), so the first one made right after
 * start fails — which a lease reads as "not held". A loop that ticks gets it
 * next tick; a one-shot at boot (the gallery sync) never would, and without
 * this it never ran. False when Redis is off or not up within `ms`.
 */
export async function cacheConnected(ms = 3_000): Promise<boolean> {
  const c = cache();
  if (!c) return false;
  if (c.status === "ready") return true;
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      c.off("ready", onReady);
      resolve(ok);
    };
    const onReady = () => done(true);
    const timer = setTimeout(() => done(false), ms);
    c.once("ready", onReady);
  });
}

/**
 * Claim the lease, or renew it if we already hold it.
 *
 * Renewal is `SET … XX` rather than PEXPIRE so that losing the lease and
 * regaining it are the same code path: XX only succeeds if the key exists,
 * and the value comparison below is what stops us renewing someone else's.
 */
export async function takeLease(key: string, owner: string, ttlMs: number): Promise<LeaseState> {
  const c = cache();
  if (!c) return { held: false };
  const k = `lease:${key}`;
  try {
    // Free? Take it.
    const taken = await c.set(k, owner, "PX", ttlMs, "NX");
    if (taken === "OK") return { held: true };

    const holder = await c.get(k);
    if (holder === owner) {
      // Ours — extend it. If it expired between the GET and here, the SET NX
      // on the next tick takes it again; a lease that lapses for one second
      // costs a tick, not a run.
      await c.set(k, owner, "PX", ttlMs, "XX");
      return { held: true };
    }
    return { held: false };
  } catch {
    // Redis unreachable. Say NOT held rather than assuming: two workers both
    // deciding "I hold it" because the coordinator is down is the exact
    // failure a lease exists to prevent.
    return { held: false };
  }
}

/** Who holds it, or null. For deciding whether a claim's owner is still
 *  alive — the value is the owner string takeLease stored. */
export async function leaseOwner(key: string): Promise<string | null | undefined> {
  const c = cache();
  if (!c) return undefined;
  try {
    return await c.get(`lease:${key}`);
  } catch {
    // Unreadable is not "nobody": a caller deciding "that worker is dead"
    // because Redis was down would hand back every live claim at once.
    return undefined;
  }
}

/** Is anyone holding it? For a probe — never takes it. */
export async function leaseHeld(key: string): Promise<boolean> {
  const c = cache();
  if (!c) return false;
  try {
    return (await c.exists(`lease:${key}`)) === 1;
  } catch {
    return false;
  }
}

/** Is anyone holding a lease under this prefix — `worker:` across every
 *  worker pod, say. A SCAN, not KEYS: the keyspace also carries rate-limit
 *  counters and SSE fan-out, and a probe must not stall the server. */
export async function anyLeaseHeld(prefix: string): Promise<boolean> {
  const c = cache();
  if (!c) return false;
  try {
    let cursor = "0";
    do {
      const [next, keys] = await c.scan(cursor, "MATCH", `lease:${prefix}*`, "COUNT", 100);
      if (keys.length) return true;
      cursor = next;
    } while (cursor !== "0");
    return false;
  } catch {
    return false;
  }
}

/**
 * Give it up, but only if it is still ours.
 *
 * A GET-then-DEL can delete a lease that expired between the two and was
 * already retaken by someone else — so the compare and the delete have to be
 * one operation, which on Redis means a script.
 */
export async function releaseLease(key: string, owner: string): Promise<void> {
  const c = cache();
  if (!c) return;
  try {
    await c.eval(
      `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
      1,
      `lease:${key}`,
      owner,
    );
  } catch {
    // It expires on its own; that is the point of PX.
  }
}
