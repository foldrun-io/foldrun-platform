// The egress proxy: where a step's credentials live while the step runs.
//
// One HTTP server in the worker process. The runner asks it for a lease
// per step — the secrets the step declared, each with the hosts it may go
// to — and hands the pod an address that carries the lease token. Every
// request the pod sends through that address is checked against the lease,
// has its `${NAME}` placeholders replaced for the target host, is forwarded,
// and its reply streamed back. When the step ends the lease is released and
// the values are gone.
//
// What the pod can and cannot do with it:
//   - reach only the hosts the lease names through /e/ (this door is for
//     credentials); everything else goes through the forward door below,
//     held to the step's `network:` list
//   - have a placeholder filled only for a host that secret was granted to
//     — `${STRIPE_API_KEY}` in a request to api.resend.com stays literal
//   - present a token that is random per step and useless after it
//
// An oauth2 or service-account secret is exchanged for a live token HERE,
// per request, cached until near expiry — the recipe (client secret,
// refresh token, private key) never crosses into the pod at all. Before
// the proxy that recipe was materialised into the pod's environment so the
// in-pod tools could exchange it themselves.
//
// Leases live in this process's memory, or in Redis when the install has
// one (FOLDRUN_REDIS_URL): then a pod's request may land on any worker
// behind the Service and still find its lease. In Redis the grant — the
// secret values — is ciphertext under the account's own key, the same
// envelope the vault uses; the log rides beside it as a list.
//
// A lease has no clock of its own. The platform's rule is that no limit is
// set on user work except the ones written in markdown, and a step that
// runs for nine hours is not a bug — so the lease's expiry is a SLIDING
// window, refreshed from the worker's claim heartbeat for as long as the
// step is driven (renewEgressLeases). The six hours is what a lease
// outlives its driver by, never how long a step may run.
//
// With Redis configured the store is Redis, full stop. Two workers stand
// behind the foldrun-egress Service, so a lease that quietly fell back to
// one process's memory when Redis was slow to answer was a lease the other
// worker could not honour: half a step's requests answered 401 for no
// reason anyone could see. Now a lease that cannot be written to Redis is
// a clear error on the step, and a request whose lease cannot be read is
// a 503 that says the store is down — not a 401 that says the step is
// over. FOLDRUN_EGRESS_LOCAL_LEASES=1 restores the in-process fallback for
// an install that runs one worker and knows it.
//
//   FOLDRUN_EGRESS_PORT   the port the worker listens on (8090)
//   FOLDRUN_EGRESS_URL    the address pods reach it at — unset means no
//                         proxy, and steps materialise secrets as before
//   FOLDRUN_EGRESS_LOCAL_LEASES=1   one worker: memory when Redis is down
//   FOLDRUN_NETWORK_ENFORCE=1       refuse a site off a step's network: list
//                                   (unset: allow it and name it in the trace)
//   FOLDRUN_EGRESS_FORWARD=0        no forward door; pods go direct

import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { decryptValue, encryptValue, materializeSecrets } from "../../foldrun-core/src/secrets.ts";
import { noteSecretUse } from "../../foldrun-core/src/secret-health.ts";
import { cache, cacheEnabled } from "./cache.ts";
import { fetchPublic, guardedLookup, isPrivateAddress, privateAllowed, PrivateAddressError, type ClientCert } from "./ssrf.ts";
import { isClientCertValue, clientCertOf } from "../../foldrun-core/src/secrets.ts";
import { mintIdentityToken } from "./oidc-issuer.ts";
import { leafFor, egressCaPem } from "./egress-ca.ts";
import { networkAllows, refusalText, siteCovers } from "../../foldrun-core/src/network.ts";
import {
  HOP_BY_HOP,
  hostOf,
  placeholderNames,
  substitutePlaceholders,
  type EgressGrant,
  type LeaseWho,
  type EgressHooks,
  type EgressLease,
  type EgressLogLine,
} from "../../foldrun-core/src/egress.ts";
import { TEST_SINK_EMAIL, bodySummary, refusalBody, rewriteResendEmail, testPolicy, type TestEffect } from "../../foldrun-core/src/test-mode.ts";
import { captureRefusalHeaders, isRefusalStatus, refusalLine } from "../../foldrun-core/src/refusal.ts";
import { LIVE_MAX_FRAME, endLiveFrame, parseLivePath, putLiveFrame } from "./live-view.ts";
import {
  JOB_MAX as DELEGATE_JOB_MAX,
  cancelDelegation,
  claimDelegation,
  closeQuestion,
  drainInbox,
  endedSteps,
  getDelegation,
  getQuestion,
  markStepEnded,
  postDelegation,
  postMessage,
  postQuestion,
  clearRunning,
  runningDelegations,
  settleDelegation,
} from "./operator-store.ts";
import { PEER_BY_PREFIX, PEER_TEXT_MAX, peerAddress, peerMatches, type PeerInfo } from "../../foldrun-core/src/operator.ts";

interface Lease {
  token: string;
  tenant: string;
  runId: string;
  /** Shared by reference with the runner in the memory store, which keeps
   *  adding grants after the lease exists — the model key's host needs the
   *  lease URL to be known first. The allowlist is read from here per
   *  request, never snapshotted; with Redis the runner's commit() is what
   *  publishes the additions. */
  grant: EgressGrant;
  createdAt: number;
  /** Last refreshed by the driver's heartbeat; what the expiry counts from. */
  renewedAt: number;
  /** A test run's lease: every request is held to the outward-write policy
   *  in test-mode.ts. On the lease, which the runner wrote, and never on
   *  the request, which the pod wrote. */
  test?: boolean;
  /** Which step of the run holds this lease — its index in run.steps. Keys
   *  the step's own inbox, so parallel steps of one group do not read each
   *  other's messages. Absent on a lease from a runner that does not say. */
  step?: number;
  /** tools: [peers] — this step's agent, and the other steps of its
   *  parallel group: the roster `/peers/<lease>` serves, and the only
   *  inboxes a message through `/peers/<lease>/message` may land in. */
  agent?: string;
  peers?: PeerInfo[];
  /** The workload this lease is for (the runner wrote it): what an identity
   *  token's subject is built from. */
  who?: LeaseWho;
  /** `sandbox: own` sub-agents this step may hand a job to through
   *  `/delegate/<lease>` — the only names that door takes. */
  delegates?: string[];
}

/** The lease's delegate list, when it has one. */
const delegateFields = (l: { delegates?: unknown }) =>
  Array.isArray(l.delegates) && l.delegates.length ? { delegates: l.delegates.filter((d): d is string => typeof d === "string") } : {};

/** The lease's colleague fields, when it has them — one spelling for the
 *  memory store, the Redis record and the hooks. */
const peerFields = (l: { agent?: string; peers?: PeerInfo[] }) =>
  typeof l.agent === "string" && Array.isArray(l.peers) ? { agent: l.agent, peers: l.peers } : {};

/** A request that went through, for the trace. Grouped at drain time: a
 *  step makes dozens of model calls to one path, and the trace wants one
 *  line saying so, not dozens. An `effect` line is what test mode did to a
 *  request; it carries the structured fact beside the text. */
type CallLine =
  | { kind: "call"; key: string; ms: number; secrets: string[] }
  | { kind: "line"; text: string }
  | { kind: "effect"; text: string; effect: TestEffect };

/** How long a lease outlives its last heartbeat — a worker that restarted
 *  mid-step and never released, say. Not a ceiling on a step: the driver
 *  renews for as long as it drives. */
const LEASE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const LEASE_TTL_SEC = LEASE_MAX_AGE_MS / 1000;

/** The lease store could not be reached. Distinct from "no such lease", so
 *  the proxy can answer 503 instead of 401 — a step must never be told its
 *  lease is over because Redis blinked. */
export class LeaseStoreUnavailable extends Error {
  constructor(what: string) {
    super(`egress: lease store unavailable — ${what}`);
  }
}

/**
 * Where leases live. Memory unless the install has Redis; both shapes
 * behind one interface so the proxy and the hooks never know which.
 */
interface LeaseStore {
  put(lease: Lease): Promise<void>;
  get(token: string): Promise<Lease | null>;
  del(token: string): Promise<void>;
  append(token: string, entry: CallLine): Promise<void>;
  drain(token: string): Promise<CallLine[]>;
  size(): Promise<number>;
  /** Push every lease of this run's expiry out by the full window. */
  touchRun(runId: string, now: number): Promise<number>;
  /** When this run's driver last checked in, where the store keeps that
   *  apart from the leases (Redis); null where the lease itself says. */
  beatOf(runId: string): Promise<number | null>;
}

const memoryLeases = new Map<string, Lease>();
const memoryLog = new Map<string, CallLine[]>();
const memoryStore: LeaseStore = {
  async put(l) {
    memoryLeases.set(l.token, l);
  },
  async get(token) {
    return memoryLeases.get(token) ?? null;
  },
  async del(token) {
    const l = memoryLeases.get(token);
    memoryLeases.delete(token);
    memoryLog.delete(token);
    // Drop the values, not just the map entry: nothing should keep a
    // reference to a step's secrets after the step.
    if (l) for (const k of Object.keys(l.grant.secrets)) delete l.grant.secrets[k];
  },
  async append(token, entry) {
    const list = memoryLog.get(token) ?? [];
    list.push(entry);
    memoryLog.set(token, list);
  },
  async drain(token) {
    const list = memoryLog.get(token) ?? [];
    memoryLog.set(token, []);
    return list;
  },
  async size() {
    return memoryLeases.size;
  },
  async touchRun(runId, now) {
    let n = 0;
    for (const l of memoryLeases.values()) {
      if (l.runId !== runId) continue;
      l.renewedAt = now;
      n++;
    }
    return n;
  },
  async beatOf() {
    return null; // a memory lease's renewedAt is the beat
  },
};

const rkey = (token: string) => `egress:lease:${token}`;
const rlog = (token: string) => `egress:log:${token}`;
/** The run's leases, so a heartbeat can find them without a SCAN. */
const rrun = (runId: string) => `egress:run:${runId}`;
const rbeat = (runId: string) => `egress:beat:${runId}`;
/** Called once when a grant will not decrypt, before the lease is treated as
 *  absent. The egress role sets it to reload the account keys: a proxy in its
 *  own pod learns a key minted by the worker only on its five-minute refresh,
 *  so a brand-new account's first step would otherwise be refused there. */
let reloadKeys: (() => Promise<unknown>) | null = null;
export function setGrantKeyReload(fn: (() => Promise<unknown>) | null): void {
  reloadKeys = fn;
}

const redisStore: LeaseStore = {
  async put(l) {
    const r = cache()!;
    const sealed = encryptValue(l.tenant, JSON.stringify(l.grant));
    await r
      .multi()
      .set(rkey(l.token), JSON.stringify({ tenant: l.tenant, runId: l.runId, createdAt: l.createdAt, renewedAt: l.renewedAt, grant: sealed, test: l.test === true, ...(typeof l.step === "number" ? { step: l.step } : {}), ...peerFields(l), ...delegateFields(l), ...(l.who ? { who: l.who } : {}) }), "EX", LEASE_TTL_SEC)
      .sadd(rrun(l.runId), l.token)
      .expire(rrun(l.runId), LEASE_TTL_SEC)
      .exec();
  },
  async get(token) {
    const raw = await cache()!.get(rkey(token));
    if (!raw) return null;
    const rec = JSON.parse(raw) as { tenant: string; runId: string; createdAt: number; renewedAt?: number; grant: ReturnType<typeof encryptValue>; test?: boolean; step?: number; agent?: string; peers?: PeerInfo[]; who?: LeaseWho; delegates?: string[] };
    // A grant that will not decrypt (the account's key rotated mid-step,
    // say) is a lease that cannot be honoured: treat it as absent.
    let plain = decryptValue(rec.tenant, rec.grant);
    if (plain === null && reloadKeys) {
      await reloadKeys().catch(() => undefined);
      plain = decryptValue(rec.tenant, rec.grant);
    }
    if (plain === null) return null;
    const grant = JSON.parse(plain) as EgressGrant;
    return { token, tenant: rec.tenant, runId: rec.runId, createdAt: rec.createdAt, renewedAt: rec.renewedAt ?? rec.createdAt, grant, test: rec.test === true, ...(typeof rec.step === "number" ? { step: rec.step } : {}), ...peerFields(rec), ...delegateFields(rec), ...(rec.who ? { who: rec.who } : {}) };
  },
  async del(token) {
    const r = cache()!;
    const raw = await r.get(rkey(token));
    const runId = raw ? (JSON.parse(raw) as { runId?: string }).runId : undefined;
    const m = r.multi().del(rkey(token), rlog(token));
    if (runId) m.srem(rrun(runId), token);
    await m.exec();
  },
  async touchRun(runId, now) {
    const r = cache()!;
    const tokens = await r.smembers(rrun(runId));
    if (!tokens.length) return 0;
    const m = r.multi();
    for (const t of tokens) m.expire(rkey(t), LEASE_TTL_SEC).expire(rlog(t), LEASE_TTL_SEC);
    m.expire(rrun(runId), LEASE_TTL_SEC);
    // The heartbeat's time, kept apart: the lease blobs only have their
    // expiry pushed out, and the identity door asks when the driver last
    // checked in.
    m.set(rbeat(runId), String(now), "EX", LEASE_TTL_SEC);
    await m.exec();
    return tokens.length;
  },
  async beatOf(runId) {
    const v = await cache()!.get(rbeat(runId));
    return v ? Number(v) : null;
  },
  async append(token, entry) {
    const r = cache()!;
    await r.rpush(rlog(token), JSON.stringify(entry));
    await r.expire(rlog(token), LEASE_TTL_SEC);
  },
  async drain(token) {
    const r = cache()!;
    const items = await r.lrange(rlog(token), 0, -1);
    if (items.length) await r.ltrim(rlog(token), items.length, -1);
    return items.map((i) => JSON.parse(i) as CallLine);
  },
  async size() {
    let n = 0;
    let cursor = "0";
    do {
      const [next, keys] = await cache()!.scan(cursor, "MATCH", "egress:lease:*", "COUNT", 100);
      cursor = next;
      n += keys.length;
    } while (cursor !== "0");
    return n;
  },
};

/**
 * Redis, ready. The shared client has its offline queue off (right for
 * rate limits, which should fail fast), so the first lease after a worker
 * restart used to throw before the socket was up; a short wait for `ready`
 * covers that. A Redis that is down, not slow, is `false` — and what
 * happens then is decided by the caller, never by quietly using memory.
 */
async function redisReady(): Promise<boolean> {
  if (!cacheEnabled()) return false;
  const r = cache();
  if (!r) return false;
  if (r.status === "ready") return true;
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 1500);
    r.once("ready", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

/** One worker, by the operator's word: memory is an acceptable home for a
 *  lease when Redis is down, because every request lands here anyway. */
const localLeasesAllowed = () => process.env.FOLDRUN_EGRESS_LOCAL_LEASES === "1";

/** Leases this process put in memory because Redis was down and the
 *  operator allowed it. Read from memory first for exactly these. */
const inMemory = new Set<string>();
const guardedStore: LeaseStore = {
  async put(l) {
    if (inMemory.has(l.token)) return memoryStore.put(l);
    if (await redisReady()) {
      try {
        return await redisStore.put(l);
      } catch (err) {
        if (!localLeasesAllowed()) throw new LeaseStoreUnavailable(`could not write the lease: ${err instanceof Error ? err.message : err}`);
      }
    } else if (!localLeasesAllowed()) {
      throw new LeaseStoreUnavailable("Redis is not answering, and FOLDRUN_EGRESS_LOCAL_LEASES is not set — a lease held in one worker's memory would be a 401 on every other worker behind the Service");
    }
    console.error(`[foldrun] egress: Redis is down; lease for ${l.runId} held in this process (FOLDRUN_EGRESS_LOCAL_LEASES=1)`);
    inMemory.add(l.token);
    return memoryStore.put(l);
  },
  async get(token) {
    if (inMemory.has(token)) return memoryStore.get(token);
    if (!(await redisReady())) throw new LeaseStoreUnavailable("Redis is not answering");
    try {
      return await redisStore.get(token);
    } catch (err) {
      throw new LeaseStoreUnavailable(err instanceof Error ? err.message : String(err));
    }
  },
  async del(token) {
    if (inMemory.has(token)) {
      inMemory.delete(token);
      return memoryStore.del(token);
    }
    if (await redisReady()) return redisStore.del(token);
    // Unreachable: it expires on its own after the window. That is what
    // the TTL is for.
  },
  async append(token, entry) {
    if (inMemory.has(token) || !(await redisReady())) return memoryStore.append(token, entry);
    return redisStore.append(token, entry);
  },
  async drain(token) {
    if (inMemory.has(token)) return memoryStore.drain(token);
    return (await redisReady()) ? redisStore.drain(token) : memoryStore.drain(token);
  },
  async size() {
    return (await memoryStore.size()) + ((await redisReady()) ? await redisStore.size() : 0);
  },
  async touchRun(runId, now) {
    const local = await memoryStore.touchRun(runId, now);
    if (!(await redisReady())) return local;
    try {
      return local + (await redisStore.touchRun(runId, now));
    } catch {
      return local; // the next heartbeat tries again; the window is hours
    }
  },
  async beatOf(runId) {
    if (!(await redisReady())) return null;
    try {
      return await redisStore.beatOf(runId);
    } catch (err) {
      throw new LeaseStoreUnavailable(`could not read the heartbeat: ${err instanceof Error ? err.message : err}`);
    }
  },
};
const store = (): LeaseStore => (cacheEnabled() ? guardedStore : memoryStore);

/** The trace's lines for one lease: refusals as they happened, then the
 *  calls that went through, grouped by method, host, path and status. */
export function formatDrain(entries: CallLine[]): EgressLogLine[] {
  const lines: EgressLogLine[] = [];
  const calls = new Map<string, { count: number; ms: number; secrets: Set<string> }>();
  for (const e of entries) {
    if (e.kind === "line") lines.push(e.text);
    else if (e.kind === "effect") lines.push({ text: e.text, effect: e.effect });
    else {
      const c = calls.get(e.key) ?? { count: 0, ms: 0, secrets: new Set<string>() };
      c.count++;
      c.ms += e.ms;
      for (const s of e.secrets) c.secrets.add(s);
      calls.set(e.key, c);
    }
  }
  for (const [key, c] of calls) {
    const secrets = c.secrets.size ? ` [${[...c.secrets].join(", ")}]` : "";
    lines.push(`egress: ${key}${c.count > 1 ? ` × ${c.count}` : ""} (${Math.round(c.ms)}ms${c.count > 1 ? " total" : ""})${secrets}`);
  }
  return lines;
}

const port = () => Number(process.env.FOLDRUN_EGRESS_PORT) || 8090;
/** How long an upstream may say nothing — no headers yet, or no next chunk
 *  of the body — before the proxy gives up on it. Generous: a model call
 *  thinks for minutes before its first byte. */
const upstreamIdleMs = () => Number(process.env.FOLDRUN_EGRESS_UPSTREAM_IDLE_MS) || 10 * 60 * 1000;
/** How long a sandbox may stop reading an answer it asked for before the
 *  proxy hangs up on it. While it is not reading, the proxy reads no more
 *  from upstream either, so nothing piles up here; this only frees the
 *  upstream connection a stuck reader would hold open. */
const clientStallMs = () => Number(process.env.FOLDRUN_EGRESS_CLIENT_STALL_MS) || 10 * 60 * 1000;

/** Resolves when `res` can take more, or has closed. A reader stalled past
 *  clientStallMs is hung up on, which closes it. */
function drained(res: http.ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    // Already gone: no drain or close is coming.
    if (res.destroyed) return resolve();
    const stall = setTimeout(() => res.destroy(new Error(`the client read nothing for ${Math.round(clientStallMs() / 1000)}s`)), clientStallMs());
    stall.unref();
    const done = () => {
      clearTimeout(stall);
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.on("drain", done);
    res.on("close", done);
  });
}
export const egressUrl = () => process.env.FOLDRUN_EGRESS_URL?.replace(/\/+$/, "") || null;

/** FOLDRUN_NETWORK_ENFORCE=1 refuses a site off a step's `network:` list;
 *  unset, the proxy allows it and names it in the trace (report only), so
 *  an install learns what its agents reach before it starts refusing. An
 *  account or workspace can refuse sooner with `network_enforce: true`. */
export const networkEnforced = () => process.env.FOLDRUN_NETWORK_ENFORCE === "1";

/** The forward-proxy URL a pod's HTTP(S)_PROXY gets: the egress address
 *  with the lease token as the password. FOLDRUN_EGRESS_FORWARD=0 turns the
 *  door off — programs then go direct, as before it existed. */
export function forwardDoorUrl(base: string, token: string): string | null {
  if (process.env.FOLDRUN_EGRESS_FORWARD === "0") return null;
  try {
    const u = new URL(base);
    return `${u.protocol}//foldrun:${token}@${u.host}`;
  } catch {
    return null;
  }
}

/** How often the worker driving a step looks for a job its pod posted. */
export const DELEGATE_POLL_MS = Number(process.env.FOLDRUN_DELEGATE_POLL_MS) || 1_000;
/** Waits between tries at settling a finished job: about a minute in all. */
const SETTLE_RETRIES = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

/**
 * The worker's side of the delegate door, for one step while it runs: claim
 * each job the step's pod posted, run it (the runner makes it a step of its
 * own), settle it so the door can answer the pod. `close()` — the step's
 * attempt is over — stops claiming, skips what never started, tells what is
 * running that nobody waits for it, and waits for it to end: a job is part
 * of the step that asked for it, so the step is not over before its jobs.
 */
export function serveDelegations(
  args: { tenant: string; runId: string; step: number; resuming?: boolean },
  run: Parameters<NonNullable<EgressHooks["delegations"]>>[1],
): { close(): Promise<void> } {
  let closed = false;
  const startedAt = new Date().toISOString();
  const inFlight = new Map<string, { done: Promise<void>; stop: boolean }>();
  // A settle that fails (the cache blinked) is retried, not dropped: the
  // parent's pod is long-polling the record and would otherwise wait out
  // its whole timeout for a job that already finished.
  const settle = async (id: string, out: Parameters<typeof settleDelegation>[3]) => {
    for (let attempt = 0; ; attempt++) {
      try {
        await settleDelegation(args.tenant, args.runId, id, out);
        return;
      } catch (err) {
        if (attempt >= SETTLE_RETRIES.length) {
          console.error(`delegate: could not settle ${id} for run ${args.runId}: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        await new Promise((r) => setTimeout(r, SETTLE_RETRIES[attempt]));
      }
    }
  };
  /** Settle every job still queued for this step as skipped. Throws when the
   *  cache cannot be read: an empty queue and an unreadable one differ. */
  const skipQueued = async (why: string, postedBefore?: string) => {
    for (;;) {
      const left = await claimDelegation(args.tenant, args.runId, args.step, (id) => inFlight.has(id));
      if (!left) return;
      // At start-up, only what was posted before serving began is an earlier
      // attempt's; this attempt's pod may already be posting.
      if (postedBefore && left.postedAt >= postedBefore && !closed) start(left.id, left.agent, left.job);
      else await settle(left.id, { status: "skipped", result: why });
    }
  };
  const start = (id: string, agent: string, job: string) => {
    const entry = { stop: false, done: Promise.resolve() };
    let lastCheck = 0;
    let cancelled = false;
    const isCancelled = () => {
      // The pod's DELETE lands in the store; read it at most every few seconds.
      if (entry.stop || cancelled) return true;
      if (Date.now() - lastCheck > 5_000) {
        lastCheck = Date.now();
        void getDelegation(args.tenant, args.runId, id).then((r) => void (cancelled = r?.cancelled === true)).catch(() => undefined);
      }
      return false;
    };
    entry.done = run({ id, agent, job, cancelled: isCancelled })
      .then((r) => settle(id, r))
      .catch((err) => settle(id, { status: "failed", result: err instanceof Error ? err.message : String(err) }))
      .finally(() => void inFlight.delete(id));
    inFlight.set(id, entry);
  };
  const loop = (async () => {
    // A worker taking this step over (the last one restarted mid-step): the
    // jobs that one started died with it. Settle them as failed so the
    // parent's model, still polling, hears so and can hand them over again.
    // The runner fails their records the same way when it resumes the run.
    // An unreadable running set is not an empty one: tried again until it
    // reads, before any new claim.
    // Anything already queued was posted by an earlier attempt of this step
    // (serving starts before this attempt's sandbox exists): its pod is gone.
    while (!closed) {
      try {
        for (const id of await runningDelegations(args.tenant, args.runId, args.step)) {
          if (inFlight.has(id)) continue;
          const rec = await getDelegation(args.tenant, args.runId, id);
          // Settled already (the last worker died before it could say so on
          // the running set): its result stands — only the membership goes.
          if (rec && rec.status !== "running" && rec.status !== "queued") await clearRunning(args.tenant, args.runId, args.step, id);
          else await settle(id, { status: "failed", result: "the worker running this job restarted before it finished — hand it over again if it is still needed" });
        }
        // Re-attaching to a sandbox that outlived its worker: what it queued
        // is still waited for, and is served like anything it posts now.
        if (!args.resuming) await skipQueued("posted by an earlier attempt of this step, which is over", startedAt);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, DELEGATE_POLL_MS));
      }
    }
    while (!closed) {
      let rec: Awaited<ReturnType<typeof claimDelegation>> = null;
      try {
        rec = await claimDelegation(args.tenant, args.runId, args.step, (id) => inFlight.has(id));
      } catch {
        /* the cache blinked; try again on the next tick */
      }
      if (rec) {
        // close() may have begun while the claim was waiting on the cache:
        // the step that asked is done, so the job never starts.
        if (closed) await settle(rec.id, { status: "skipped", result: "the step that asked for it ended before it started" });
        else start(rec.id, rec.agent, rec.job);
        continue;
      }
      await new Promise((r) => setTimeout(r, DELEGATE_POLL_MS));
    }
  })();
  return {
    async close() {
      closed = true;
      for (const e of inFlight.values()) e.stop = true;
      await loop;
      // Anything still queued never starts: the step that asked is done. A
      // failed read is not an empty queue — tried again for about a minute,
      // and the next attempt's start skips whatever is left anyway.
      for (let tries = 0; tries < 60; tries++) {
        try {
          await skipQueued("the step that asked for it ended before it started");
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 1_000));
        }
      }
      for (const e of inFlight.values()) e.stop = true;
      await Promise.all([...inFlight.values()].map((e) => e.done));
    },
  };
}

function newToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/** The runner's side of the seam: a lease for one step. */
export const egressHooks: EgressHooks = {
  renew: (runId) => renewEgressLeases(runId),
  // `step` — the step's index in run.steps, when the runner says (it keys
  // the step's own operator inbox). Not in core's EgressHooks yet, so read
  // as an optional extra.
  async stepEnded({ tenant, runId, step }) {
    await markStepEnded(tenant, runId, step);
  },
  delegations: serveDelegations,
  async lease({ tenant, runId, grant, test, step, agent, peers, who, delegates }: Parameters<EgressHooks["lease"]>[0] & { step?: number }) {
    const base = egressUrl();
    if (!base) return null;
    const token = newToken();
    const now = Date.now();
    // The proxy decides, not the pod: a site off the list is refused, or
    // only named in the trace while an install is still learning its
    // agents' sites. On the grant, so it travels to every proxy replica.
    // The install's switch, or the account's or workspace's
    // network_enforce: true, which the runner put on the grant. Only ever
    // tightens: a grant saying false cannot loosen the install's true.
    grant.enforce = networkEnforced() || grant.enforce === true;
    const lease: Lease = {
      token,
      tenant,
      runId,
      grant,
      createdAt: now,
      renewedAt: now,
      ...(test ? { test: true } : {}),
      ...(Number.isInteger(step) && step! >= 0 ? { step } : {}),
      ...peerFields({ agent, peers }),
      ...delegateFields({ delegates }),
      ...(who ? { who } : {}),
    };
    await store().put(lease);
    const door = forwardDoorUrl(base, token);
    const self: EgressLease = {
      url: `${base}/e/${token}`,
      ...(door ? { proxy: door, ca: egressCaPem(), enforce: grant.enforce } : {}),
      // The memory store shares the grant by reference, so a commit there
      // is a no-op; Redis needs the additions written.
      commit: () => store().put(lease),
      drainLog: async () => formatDrain(await store().drain(token)),
      release: () => {
        reported.delete(token);
        return store().del(token);
      },
    };
    return self;
  },
};

/** For tests and the status line: how many leases are live. */
export function liveLeases(): Promise<number> {
  return store().size();
}

/**
 * The driver's heartbeat, for the leases of one run: every lease the run
 * holds gets the full window again. Called by the worker beside the claim
 * heartbeat (queue.ts), so a lease lives exactly as long as its driver
 * does, however long the step runs. Returns how many were renewed.
 */
export async function renewEgressLeases(runId: string, now = Date.now()): Promise<number> {
  return store().touchRun(runId, now);
}

/** Memory-store leases whose driver stopped renewing. Redis expires its
 *  own; only the memory store needs a broom. Exported for the test. */
export function sweepLeases(now = Date.now()): number {
  let swept = 0;
  for (const [token, l] of memoryLeases) {
    if (now - l.renewedAt > LEASE_MAX_AGE_MS) {
      void memoryStore.del(token);
      inMemory.delete(token);
      swept++;
    }
  }
  return swept;
}

/**
 * `/e/<token>/<absolute url>` → the lease and the target. The target is
 * the raw remainder of the request path, so `https://` survives (a URL
 * parser would collapse the double slash) and the query rides along.
 */
export function parseEgressPath(rawUrl: string): { token: string; target: string } | null {
  const m = rawUrl.match(/^\/e\/([A-Za-z0-9_-]{16,})\/(https?:\/\/.+)$/);
  if (!m) return null;
  return { token: m[1], target: m[2] };
}

/**
 * The substitution for one request: placeholders in `text` are filled
 * only for secrets granted to `host`. Pure, so the rule is testable
 * without a server. Returns the filled text and which names were used.
 */
export function fillForHost(
  text: string,
  host: string,
  secrets: Record<string, string>,
  grant: EgressGrant,
): { text: string; used: string[] } {
  const allowed: Record<string, string> = {};
  const used: string[] = [];
  for (const name of placeholderNames(text)) {
    const g = grant.secrets[name];
    if (!g || !g.hosts.some((h) => grantCovers(h, host))) continue;
    if (name in secrets) {
      allowed[name] = secrets[name];
      used.push(name);
    }
  }
  return { text: substitutePlaceholders(text, allowed), used };
}

/**
 * A URL's placeholders as clients actually send them. Python's `requests`
 * percent-encodes `${K}` in a query to `$%7BK%7D` (or `%24%7BK%7D`), and
 * curl's URL globbing turns `${K}` into `$K`; each goes back to `${K}` so
 * fillForHost sees it. Only names granted to this host are touched, so a
 * `$WORD` that is not a secret of this step stays exactly as sent.
 */
export function placeholdersInUrl(url: string, host: string, grant: EgressGrant): string {
  const names = Object.entries(grant.secrets).filter(([, g]) => g.hosts.some((h) => grantCovers(h, host))).map(([n]) => n);
  if (!names.length) return url;
  let out = url.replace(/(?:\$|%24)%7B([A-Z][A-Z0-9_]*)%7D/gi, (whole, name: string) => (names.includes(name) ? `\${${name}}` : whole));
  out = out.replace(/\$([A-Z][A-Z0-9_]*)(?![A-Z0-9_{])/g, (whole, name: string) => (names.includes(name) ? `\${${name}}` : whole));
  return out;
}

/** Is `host` one a secret on this grant may be sent to? A grant's hosts may
 *  be sites (`*.example.com`) since secrets can be bound to them. */
export function grantedHost(grant: EgressGrant, host: string): boolean {
  return Object.values(grant.secrets).some((g) => g.hosts.some((h) => grantCovers(h, host)));
}

/** One granted host against a request's: the exact host (a port is part of
 *  it, as hostOf writes it), or a bound site, which covers every port. */
function grantCovers(granted: string, host: string): boolean {
  return granted.toLowerCase() === host.toLowerCase() || (!granted.includes(":") && siteCovers(granted, host));
}

/**
 * An Authorization header, filled. `Basic` carries `user:password` in
 * base64, where a `${NAME}` cannot be seen — `curl -u "$USER:$KEY"` in a
 * sandbox holding placeholders sends exactly that — so it is decoded,
 * filled for the host, and encoded again. Anything else is filled as text.
 */
export function fillBasicAuth(value: string, host: string, secrets: Record<string, string>, grant: EgressGrant): { text: string; used: string[] } {
  const m = value.match(/^(Basic\s+)([A-Za-z0-9+/=]+)\s*$/i);
  if (m) {
    const decoded = Buffer.from(m[2], "base64").toString("utf8");
    if (placeholderNames(decoded).length) {
      const inner = fillForHost(decoded, host, secrets, grant);
      return { text: `${m[1]}${Buffer.from(inner.text, "utf8").toString("base64")}`, used: inner.used };
    }
  }
  return fillForHost(value, host, secrets, grant);
}

/**
 * What test mode does with one request, given the lease's word on whether
 * the run is a test. Pure apart from reading the body, which it does only
 * when the policy needs it: a write to a host that is not read-safe is
 * refused with a body naming what would have gone; a Resend send is
 * pointed at the sink and marked; reads pass; a live lease passes
 * everything. Exported so the rule is a test and not a network call.
 */
export async function testModeVerdict(
  test: boolean,
  method: string,
  host: string,
  target: string,
  readBody: () => Promise<Buffer>,
): Promise<
  | { kind: "pass" }
  | { kind: "refuse"; status: number; body: string; text: string; effect: TestEffect }
  | { kind: "forward"; body: Buffer; text: string; effect: TestEffect }
> {
  if (!test) return { kind: "pass" };
  const targetPath = (() => {
    try {
      return new URL(target).pathname;
    } catch {
      return "";
    }
  })();
  const verdict = testPolicy(method, host, targetPath);
  if (verdict.action === "allow") return { kind: "pass" };
  const raw = ["GET", "HEAD"].includes(method.toUpperCase()) ? "" : (await readBody()).toString("utf8");
  // Never a value: what the pod sent carried placeholders, and the summary
  // is cut before any substitution — so the trace can quote it.
  const summary = bodySummary(raw);
  if (verdict.action === "rewrite") {
    const rewritten = rewriteResendEmail(raw);
    if (rewritten) {
      const to = rewritten.to.join(", ") || "(nobody)";
      return {
        kind: "forward",
        body: Buffer.from(rewritten.body, "utf8"),
        text: `test: ${method} ${host}${targetPath} redirected to ${TEST_SINK_EMAIL} — would have gone to ${to}`,
        effect: { kind: "redirected", host, method, path: targetPath, summary: `would have gone to ${to}` },
      };
    }
    return {
      kind: "refuse",
      status: 403,
      body: refusalBody(method, host, targetPath, raw),
      text: `test: ${method} ${host}${targetPath} refused — a send whose body could not be redirected: ${summary}`,
      effect: { kind: "refused", host, method, path: targetPath, summary },
    };
  }
  return {
    kind: "refuse",
    status: 403,
    body: refusalBody(method, host, targetPath, raw),
    text: `test: ${method} ${host}${targetPath} refused — would have sent ${summary || "(empty body)"}`,
    effect: { kind: "refused", host, method, path: targetPath, summary: summary || "(empty body)" },
  };
}

/**
 * A frame of what a step's browser shows, for the run page's live view
 * (live-view.ts). The lease is the credential: it names the account and the
 * run, so a step can only ever paint its own run, and a finished step's
 * token is refused like any other request of a step that is over. Nothing
 * is forwarded anywhere; the frame is held for the dashboard and expires.
 */
async function handleLive(req: http.IncomingMessage, res: http.ServerResponse, token: string, deny: (s: number, m: string) => void): Promise<void> {
  if (req.method !== "POST") return deny(405, "live: POST a JPEG frame");
  let lease: Lease | null;
  try {
    lease = await store().get(token);
  } catch (err) {
    if (err instanceof LeaseStoreUnavailable) return deny(503, err.message);
    throw err;
  }
  if (!lease) return deny(401, "live: no such lease — the step it belonged to is over");
  const header = (name: string) => {
    const v = req.headers[name];
    return (Array.isArray(v) ? v[0] : v ?? "").toString();
  };
  const agent = header("x-foldrun-agent").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64) || "agent";
  if (header("x-foldrun-live") === "end") {
    await endLiveFrame(lease.tenant, lease.runId, agent);
    res.writeHead(204).end();
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > LIVE_MAX_FRAME) return deny(413, `live: a frame is at most ${LIVE_MAX_FRAME} bytes`);
    chunks.push(c as Buffer);
  }
  const jpeg = Buffer.concat(chunks);
  // A JPEG starts FF D8; anything else is not a frame and is not kept.
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return deny(415, "live: a frame is a JPEG");
  let page = header("x-foldrun-page");
  try { page = decodeURIComponent(page); } catch { /* as sent */ }
  await putLiveFrame(lease.tenant, lease.runId, {
    agent,
    url: page.slice(0, 500),
    engine: header("x-foldrun-engine").replace(/[^a-z]/g, "").slice(0, 16),
    at: new Date().toISOString(),
    ended: false,
  }, jpeg);
  res.writeHead(204).end();
}

/** `/ask/<lease>`, `/ask/<lease>/<id>` (GET waits for the answer, DELETE
 *  closes the question) and `/inbox/<lease>` — a step's line to a person;
 *  `/peers/<lease>` (GET the roster) and `/peers/<lease>/message` (POST
 *  {to, text}) — its line to the colleagues of its parallel group
 *  (foldrun-core operator.ts); `/delegate/<lease>` (POST {agent, job}) and
 *  `/delegate/<lease>/<id>` (GET waits for the reply, DELETE cancels) —
 *  its `sandbox: own` sub-agents (foldrun-core delegate-tools.ts). */
export function parseOperatorPath(rawUrl: string): { kind: "ask" | "answer" | "inbox" | "peers" | "tell" | "delegate" | "delegation"; token: string; id?: string; wait?: number } | null {
  const [p, q] = rawUrl.split("?");
  const wait = Number(new URLSearchParams(q ?? "").get("wait"));
  let m = p.match(/^\/ask\/([A-Za-z0-9_-]{16,})\/?$/);
  if (m) return { kind: "ask", token: m[1] };
  m = p.match(/^\/ask\/([A-Za-z0-9_-]{16,})\/([A-Za-z0-9_-]{1,64})\/?$/);
  if (m) return { kind: "answer", token: m[1], id: m[2], wait: Number.isFinite(wait) ? wait : 0 };
  m = p.match(/^\/inbox\/([A-Za-z0-9_-]{16,})\/?$/);
  if (m) return { kind: "inbox", token: m[1] };
  m = p.match(/^\/peers\/([A-Za-z0-9_-]{16,})\/?$/);
  if (m) return { kind: "peers", token: m[1] };
  m = p.match(/^\/peers\/([A-Za-z0-9_-]{16,})\/message\/?$/);
  if (m) return { kind: "tell", token: m[1] };
  m = p.match(/^\/delegate\/([A-Za-z0-9_-]{16,})\/?$/);
  if (m) return { kind: "delegate", token: m[1] };
  m = p.match(/^\/delegate\/([A-Za-z0-9_-]{16,})\/([A-Za-z0-9_-]{1,64})\/?$/);
  if (m) return { kind: "delegation", token: m[1], id: m[2], wait: Number.isFinite(wait) ? wait : 0 };
  return null;
}

/** `/identity/<lease>/<NAME>`: a fresh token for an identity granted to the
 *  step that holds the lease (oidc-issuer.ts). */
export function parseIdentityPath(rawUrl: string): { token: string; name: string } | null {
  const m = (rawUrl.split("?")[0] ?? "").match(/^\/identity\/([A-Za-z0-9_-]{16,})\/([A-Z][A-Z0-9_]{1,63})\/?$/);
  return m ? { token: m[1]!, name: m[2]! } : null;
}

/** A lease must have been renewed this recently to be issued a token: the
 *  driver's heartbeat (queue.ts, every third of the claim window — ten
 *  minutes by default) plus room for one late beat. Far tighter than the
 *  lease's own six hours, which only says a step may still be finishing. */
export const IDENTITY_LIVENESS_MS = Number(process.env.FOLDRUN_IDENTITY_LIVENESS_MS) || 15 * 60_000;

/**
 * The identity door. The lease is the credential, and it only ever yields a
 * token for an identity the runner granted this step, for the workload the
 * runner named on the lease — nothing the request says chooses the subject,
 * the audience or the lifetime. Refused when the lease is gone (the step
 * stopped or ended, on any replica: the store is shared), when its driver
 * has gone quiet, and when the store cannot be read (fail closed).
 */
async function handleIdentity(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: { token: string; name: string },
  deny: (s: number, m: string) => void,
): Promise<void> {
  if (req.method !== "GET") return deny(405, "identity: GET a token");
  let lease: Lease | null;
  try {
    lease = await store().get(id.token);
  } catch (err) {
    if (err instanceof LeaseStoreUnavailable) return deny(503, err.message);
    throw err;
  }
  if (!lease) return deny(401, "identity: no such lease — the step it belonged to is over");
  const granted = lease.grant.identities?.[id.name];
  if (!granted) return deny(403, `identity: ${id.name} is not granted to this step`);
  if (!lease.who) return deny(403, "identity: this lease names no workload");
  let beat = lease.renewedAt;
  try {
    beat = Math.max(beat, (await store().beatOf(lease.runId)) ?? 0);
  } catch (err) {
    if (err instanceof LeaseStoreUnavailable) return deny(503, err.message); // fail closed
    throw err;
  }
  if (Date.now() - beat > IDENTITY_LIVENESS_MS) {
    return deny(401, "identity: this step's driver has not checked in lately — no new token");
  }
  let minted: { token: string; expiresAt: number };
  try {
    minted = await mintIdentityToken(
      { tenant: lease.tenant, workspace: lease.who.workspace, agent: lease.who.agent, runId: lease.runId, ...(lease.who.flow ? { flow: lease.who.flow } : {}) },
      granted.audience,
    );
  } catch (err) {
    return deny(503, `identity: ${err instanceof Error ? err.message : String(err)}`);
  }
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(minted));
  await store().append(id.token, { kind: "line", text: `identity: ${id.name} — a token for ${granted.audience}, valid until ${new Date(minted.expiresAt).toISOString()}` }).catch(() => undefined);
}

/** How long one long-poll for an answer may hold the connection. */
export const ANSWER_POLL_MAX_MS = 25_000;

/**
 * The person-in-the-loop line. The lease is the credential, exactly as for a
 * live frame: it names the account and the run, so a step can only ask in,
 * wait on, or read the inbox of its own run. Nothing is forwarded anywhere.
 */
async function handleOperator(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  op: NonNullable<ReturnType<typeof parseOperatorPath>>,
  deny: (s: number, m: string) => void,
): Promise<void> {
  let lease: Lease | null;
  try {
    lease = await store().get(op.token);
  } catch (err) {
    if (err instanceof LeaseStoreUnavailable) return deny(503, err.message);
    throw err;
  }
  if (!lease) return deny(401, "operator: no such lease — the step it belonged to is over");
  const send = (body: unknown) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (op.kind === "ask") {
    if (req.method !== "POST") return deny(405, "operator: POST a question");
    let raw = "";
    for await (const c of req) {
      raw += c;
      if (raw.length > 16_000) return deny(413, "operator: a question is at most 16 KB");
    }
    let body: { question?: unknown; options?: unknown };
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return deny(400, "operator: the body is JSON {question, options?}");
    }
    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!question) return deny(400, "operator: expected {question}");
    const options = Array.isArray(body.options)
      ? body.options.map((o) => String(o).trim().slice(0, 200)).filter(Boolean).slice(0, 10)
      : undefined;
    const q = await postQuestion(lease.tenant, lease.runId, { question, options, step: lease.step });
    return send({ id: q.id });
  }
  if (op.kind === "answer" && req.method === "DELETE") {
    // The step stopped waiting (its ask timed out): nobody will read an
    // answer now, so the dashboard must stop offering the box.
    if (!(await getQuestion(lease.tenant, lease.runId, op.id!))) return deny(404, "operator: no such question on this run");
    await closeQuestion(lease.tenant, lease.runId, op.id!);
    return send({ closed: true });
  }
  if (op.kind === "delegate" || op.kind === "delegation") return handleDelegate(req, res, op, lease, send, deny);
  if (op.kind === "tell") {
    // A colleague's message: only to a step the lease names as a sibling,
    // only into that step's own inbox, signed with the sender's agent name
    // so the reader knows a colleague from a person. The lease decides who
    // the siblings are, not the pod.
    if (req.method !== "POST") return deny(405, "operator: POST {to, text}");
    if (!lease.agent || !lease.peers) return deny(403, "operator: this step was not granted tools: [peers]");
    let raw = "";
    for await (const c of req) {
      raw += c;
      if (raw.length > 16_000) return deny(413, "operator: a message is at most 16 KB");
    }
    let body: { to?: unknown; text?: unknown };
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return deny(400, "operator: the body is JSON {to, text}");
    }
    const to = typeof body.to === "string" ? body.to.trim() : "";
    const text = typeof body.text === "string" ? body.text.trim().slice(0, PEER_TEXT_MAX) : "";
    if (!to || !text) return deny(400, "operator: expected {to, text}");
    // A sibling the runner said is over would never read it: it reaches
    // nobody and the sender is told. One still starting, waiting for a slot
    // or between retries holds no lease yet is not over — its inbox keeps
    // the message until it reads.
    const ended = await endedSteps(lease.tenant, lease.runId);
    const targets = lease.peers.filter((p) => !ended.has(p.step) && peerMatches(p, to));
    if (!targets.length && to !== "all" && !lease.peers.some((p) => peerMatches(p, to))) return deny(404, `operator: no colleague named "${to}" runs beside this step`);
    const from = PEER_BY_PREFIX + (typeof lease.step === "number" ? peerAddress({ agent: lease.agent, step: lease.step }) : lease.agent);
    for (const t of targets) await postMessage(lease.tenant, lease.runId, text, from, t.step);
    return send({ to: targets.map(peerAddress) });
  }
  if (req.method !== "GET") return deny(405, "operator: GET");
  if (op.kind === "peers") {
    const ended = await endedSteps(lease.tenant, lease.runId);
    return send({ peers: (lease.peers ?? []).filter((p) => !ended.has(p.step)) });
  }
  if (op.kind === "inbox") return send({ messages: await drainInbox(lease.tenant, lease.runId, lease.step) });
  // op.kind === "answer": wait for it, up to the long-poll cap.
  const until = Date.now() + Math.max(0, Math.min(op.wait ?? 0, ANSWER_POLL_MAX_MS));
  for (;;) {
    const q = await getQuestion(lease.tenant, lease.runId, op.id!);
    if (!q) return deny(404, "operator: no such question on this run");
    if (q.answer !== undefined) return send({ answer: q.answer, by: q.by ?? null, answeredAt: q.answeredAt });
    if (Date.now() >= until || req.destroyed) return send({ pending: true });
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

/**
 * The delegate door. The lease decides everything: which step posts (its
 * own queue, served by the worker driving that step), and which agents it
 * may hand a job to (`delegates`, from its agent's `subagents:` marked
 * `sandbox: own`). The body names only one of those and the job's text.
 */
async function handleDelegate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  op: NonNullable<ReturnType<typeof parseOperatorPath>>,
  lease: Lease,
  send: (body: unknown) => void,
  deny: (s: number, m: string) => void,
): Promise<void> {
  if (!lease.delegates?.length || typeof lease.step !== "number") return deny(403, "delegate: this step has no sub-agents of its own sandbox");
  if (op.kind === "delegate") {
    if (req.method !== "POST") return deny(405, "delegate: POST {agent, job}");
    // Decoded as one stream: a character split across two chunks survives.
    req.setEncoding("utf8");
    let raw = "";
    for await (const c of req) {
      raw += c;
      // Room for JSON escaping (a quote or newline is two characters on the
      // wire, a control character six); the job's own limit is checked
      // decoded, below.
      if (raw.length > DELEGATE_JOB_MAX * 6 + 2_000) return deny(413, `delegate: a job is at most ${DELEGATE_JOB_MAX} characters`);
    }
    let body: { agent?: unknown; job?: unknown };
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return deny(400, "delegate: the body is JSON {agent, job}");
    }
    const agent = typeof body.agent === "string" ? body.agent.trim() : "";
    const job = typeof body.job === "string" ? body.job.trim() : "";
    if (!agent || !job) return deny(400, "delegate: expected {agent, job}");
    if (job.length > DELEGATE_JOB_MAX) return deny(413, `delegate: a job is at most ${DELEGATE_JOB_MAX} characters`);
    if (!lease.delegates.includes(agent)) return deny(403, `delegate: "${agent}" is not a sub-agent this step may hand a job to`);
    const d = await postDelegation(lease.tenant, lease.runId, { step: lease.step, agent, job });
    await store().append(op.token, { kind: "line", text: `delegate: a job for ${agent} (${d.id})` }).catch(() => undefined);
    return send({ id: d.id });
  }
  const rec = await getDelegation(lease.tenant, lease.runId, op.id!);
  if (!rec || rec.step !== lease.step) return deny(404, "delegate: no such job on this step");
  if (req.method === "DELETE") {
    await cancelDelegation(lease.tenant, lease.runId, rec.id);
    return send({ cancelled: true });
  }
  if (req.method !== "GET") return deny(405, "delegate: GET or DELETE");
  const until = Date.now() + Math.max(0, Math.min(op.wait ?? 0, ANSWER_POLL_MAX_MS));
  for (;;) {
    const now = await getDelegation(lease.tenant, lease.runId, rec.id);
    if (!now) return deny(404, "delegate: no such job on this step");
    if (now.status === "completed" || now.status === "failed" || now.status === "skipped") {
      return send({ status: now.status, result: now.result ?? "", wrote: now.wrote ?? [], files: now.files ?? [], filesOmitted: now.filesOmitted ?? [] });
    }
    if (Date.now() >= until || req.destroyed) return send({ status: now.status, pending: true });
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

const denier = (res: http.ServerResponse) => (status: number, message: string) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { type: "egress", message } }));
};

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const started = Date.now();
  const deny = denier(res);
  // The forward door's plain-HTTP half: an absolute-form request line,
  // `GET http://host/path`, from a client that HTTP_PROXY points here.
  if (/^http:\/\//i.test(req.url ?? "")) return handleForwardHttp(req, res, started);
  const liveFrame = parseLivePath(req.url ?? "");
  if (liveFrame) return handleLive(req, res, liveFrame.token, deny);
  const operator = parseOperatorPath(req.url ?? "");
  if (operator) return handleOperator(req, res, operator, deny);
  const identity = parseIdentityPath(req.url ?? "");
  if (identity) return handleIdentity(req, res, identity, deny);
  const parsed = parseEgressPath(req.url ?? "");
  if (!parsed) return deny(404, "egress: expected /e/<lease>/<https://target>");
  let lease: Lease | null;
  try {
    lease = await store().get(parsed.token);
  } catch (err) {
    // The store, not the step: say so, with a status a client retries.
    if (err instanceof LeaseStoreUnavailable) return deny(503, err.message);
    throw err;
  }
  if (!lease) return deny(401, "egress: no such lease — the step it belonged to is over");
  const host = hostOf(parsed.target);
  if (!host) return deny(400, "egress: target is not a URL");
  // This door is for credentials: only a host a secret was granted to.
  // Everything else goes through the forward door, under the site list.
  if (!grantedHost(lease.grant, host)) {
    await store().append(lease.token, { kind: "line", text: `egress: ${req.method} ${host} refused — not a host this step's secrets were granted to` });
    return deny(403, `egress: ${host} is not a host this step may send secrets to`);
  }
  return forward(req, res, lease, parsed.target, host, started);
}

/**
 * The client certificate to present to `host`: the one granted secret of that
 * kind bound to exactly this host (never a wildcard), with its pool named by
 * account, vault entry and certificate version. Two is an error, not a guess.
 */
export function clientCertFor(
  grant: EgressGrant,
  tenant: string,
  host: string,
): { cert?: ClientCert; name?: string } | { error: string } {
  // Bindings name a host, never a port: api.bank.test:8443 is api.bank.test.
  const bare = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/(?<!:):\d+$/, "");
  const certs = Object.entries(grant.secrets).filter(
    ([, g]) => isClientCertValue(g.value) && g.hosts.some((h) => !h.startsWith("*.") && h.toLowerCase() === bare),
  );
  if (certs.length > 1) return { error: `${certs.map(([n]) => n).join(" and ")} are client certificates bound to ${host} — bind one` };
  if (!certs.length) return {};
  const [name, g] = certs[0]!;
  const c = clientCertOf(g.value);
  const identity = `${tenant}:${grant.healthKeys?.[name] ?? name}`;
  return {
    name,
    cert: {
      identity,
      pool: crypto.createHash("sha256").update(`${identity}\0${g.value}`).digest("hex"),
      cert: c.cert,
      key: c.key,
      ...(c.passphrase ? { passphrase: c.passphrase } : {}),
    },
  };
}

/**
 * One request on its way out, for a lease that may make it: placeholders
 * filled for the target host's granted secrets, the test policy applied,
 * the answer streamed back. Both doors end here — `/e/<lease>/<url>` and
 * the forward door (an intercepted TLS request to a bound site, or a plain
 * `http://` one) — so the rules are the same whichever way a request came.
 */
async function forward(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  lease: Lease,
  target: string,
  host: string,
  started: number,
): Promise<void> {
  const deny = denier(res);
  const parsed = { target };

  // Live values, per request: an oauth2 recipe becomes a fresh access
  // token here, on the worker, never in the pod.
  const raw: Record<string, string> = {};
  for (const [name, g] of Object.entries(lease.grant.secrets)) raw[name] = g.value;
  let live: Record<string, string>;
  try {
    live = await materializeSecrets(raw, { tenant: lease.tenant });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await store().append(lease.token, { kind: "line", text: `egress: ${req.method} ${host} — ${message}` });
    return deny(502, `egress: ${message}`);
  }

  const used = new Set<string>();
  const url = fillForHost(placeholdersInUrl(parsed.target, host, lease.grant), host, live, lease.grant);
  for (const n of url.used) used.add(n);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key) || key.startsWith("x-forwarded")) continue;
    const value = Array.isArray(v) ? v.join(", ") : v;
    if (value === undefined) continue;
    const filled = key === "authorization" ? fillBasicAuth(value, host, live, lease.grant) : fillForHost(value, host, live, lease.grant);
    for (const n of filled.used) used.add(n);
    headers[k] = filled.text;
  }

  const method = req.method ?? "GET";
  const hasBody = !["GET", "HEAD"].includes(method);
  // Test mode, decided here and nowhere the pod can reach — see
  // testModeVerdict. The request body has to be read to say what was
  // refused (and to rewrite a send), so on a test lease it is buffered,
  // not streamed; a live lease streams as before.
  let body: ReadableStream | Buffer | undefined = hasBody ? (Readable.toWeb(req) as unknown as ReadableStream) : undefined;
  const verdict = await testModeVerdict(lease.test === true, method, host, parsed.target, async () => Buffer.concat(await req.toArray()));
  if (verdict.kind !== "pass") {
    await store().append(lease.token, { kind: "effect", text: verdict.text, effect: verdict.effect });
    if (verdict.kind === "refuse") {
      res.writeHead(verdict.status, { "content-type": "application/json" });
      res.end(verdict.body);
      return;
    }
    body = verdict.body;
    headers["content-type"] = "application/json";
  }
  // The upstream request ends with the client's: a pod that hung up (or a
  // step that timed out) stops the transfer instead of leaving it running
  // on the worker, and an upstream that goes quiet is cut off.
  const abort = new AbortController();
  let idle: NodeJS.Timeout | undefined;
  const quiet = () => {
    clearTimeout(idle);
    idle = setTimeout(() => abort.abort(new Error(`no reply from ${host} for ${Math.round(upstreamIdleMs() / 1000)}s`)), upstreamIdleMs());
    idle.unref();
  };
  res.on("close", () => {
    clearTimeout(idle);
    if (!res.writableFinished) abort.abort(new Error("the client went away"));
  });
  quiet();
  // A client certificate bound to exactly this host is presented on the
  // upstream connection (mutual TLS); the sandbox never held its key. Two
  // bound to one host is ambiguous, and refused rather than guessed.
  const picked = clientCertFor(lease.grant, lease.tenant, host);
  if ("error" in picked) return deny(409, `egress: ${picked.error}`);
  const clientCert = picked.cert;
  if (clientCert) {
    // A certificate-authenticated call is a use of that secret, like a filled one.
    used.add(picked.name!);
    await store().append(lease.token, { kind: "line", text: `egress: ${host} — client certificate ${picked.name} presented` });
  }
  let upstream: Response;
  try {
    // Never inward: the worker can reach what a sandbox cannot, and a host
    // the tenant granted a secret to is still a host the tenant chose.
    upstream = await fetchPublic(url.text, {
      method,
      headers,
      ...(body !== undefined ? { body, duplex: "half" } : {}),
      redirect: "manual",
      signal: abort.signal,
      // A step's own traffic — a page, a download — streamed straight back to
      // the sandbox, never held here, so no read limit on the platform's side.
    } as RequestInit, { ...(clientCert ? { clientCert } : {}), maxBytes: Infinity });
  } catch (err) {
    const inward = err instanceof PrivateAddressError || (err as { cause?: unknown })?.cause instanceof PrivateAddressError;
    if (inward) {
      const message = (err instanceof PrivateAddressError ? err : ((err as { cause: PrivateAddressError }).cause)).message;
      await store().append(lease.token, { kind: "line", text: `egress: ${method} ${host} refused — ${message}` });
      return deny(403, `egress: ${message}`);
    }
    // undici says "fetch failed" and puts the reason in `cause` (a refused
    // connection, a TLS alert, a bad client key): the trace names it.
    const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
    const why = cause ? [cause.code, cause.message].filter(Boolean).join(" ") : "";
    const message = `${err instanceof Error ? err.message : String(err)}${why ? ` (${why})` : ""}`;
    await store().append(lease.token, { kind: "line", text: `egress: ${method} ${host} → unreachable: ${message}` });
    return deny(502, `egress: could not reach ${host}: ${message}`);
  }

  quiet();
  const outHeaders: Record<string, string | string[]> = {};
  upstream.headers.forEach((v, k) => {
    if (!HOP_BY_HOP.has(k.toLowerCase()) && k.toLowerCase() !== "content-encoding") outHeaders[k] = v;
  });
  // Headers.forEach joins repeated headers with ", " — which for cookies
  // (whose Expires has a comma of its own) is one broken cookie. Each
  // Set-Cookie goes back on its own line.
  const cookies = upstream.headers.getSetCookie();
  if (cookies.length) outHeaders["set-cookie"] = cookies;
  res.writeHead(upstream.status, outHeaders);
  const path = (() => {
    try {
      return new URL(parsed.target).pathname;
    } catch {
      return "";
    }
  })();
  await store().append(lease.token, { kind: "call", key: `${method} ${host}${path} → ${upstream.status}`, ms: Date.now() - started, secrets: [...used] });
  // A refusal, said in words while the evidence still exists. The proxy is
  // the only party that ever sees this response's headers — the pod gets a
  // status and a sentence written by the SDK, and the hour this cost once
  // was spent guessing between a dead key and a spent window. Nothing but
  // core's allow-list is read, and no clause about a second supply is added
  // here: the proxy sees a response, not a flow, and the runner appends
  // that part when it finalises the step (including "no second supply is
  // configured", which is now the ordinary state).
  if (isRefusalStatus(upstream.status)) {
    await store().append(lease.token, {
      kind: "line",
      text: refusalLine({
        status: upstream.status,
        headers: captureRefusalHeaders(upstream.headers),
        // The grant carries the step's zone; a lease from a runner that
        // does not send one yet reads in UTC rather than failing.
        timezone: lease.grant.timezone || "UTC",
        provider: host,
      }),
    });
  }
  // The proxy is the one place that knows both which credential was used and
  // what the far end said about it. Recording it here means credential health
  // costs nothing and instruments nothing: it is a fact already in hand.
  for (const name of used) {
    const key = lease.grant.healthKeys?.[name];
    // No key means the runner did not know which vault entry this was
    // (an older lease, a materialised value). Better unrecorded than
    // recorded against the wrong credential.
    if (key) noteSecretUse(lease.tenant, key, { host, status: upstream.status });
  }
  if (!upstream.body) {
    res.end();
    return;
  }
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      quiet();
      if (res.write(value)) continue;
      // The sandbox reads slower than upstream sends: read no more until it
      // catches up, so a download streams through and is never held here.
      // Waiting on the sandbox is not upstream going quiet, so the idle
      // clock stops until it drains.
      clearTimeout(idle);
      await drained(res);
      if (res.destroyed) break;
      quiet();
    }
  } finally {
    clearTimeout(idle);
    // Hung up on: free upstream. An upstream that failed meanwhile still
    // rejects here, as its read would have.
    if (res.destroyed) await reader.cancel();
    else res.end();
  }
}


// ------------------------------------------------------------ forward door
//
// The pod's programs reach the world through here: HTTPS_PROXY and
// HTTP_PROXY name this server with the step's lease token as the proxy
// password (`http://foldrun:<token>@egress:8090`). Three things happen per
// connection, in order:
//
//   1. the lease is looked up from Proxy-Authorization — no lease, no door
//   2. the site is held to the step's `network:` list (network.ts): open
//      reaches any public host, trusted and none their lists, and a host a
//      secret is granted to is always allowed. Off the list is a 403 — or,
//      on an install that only reports (FOLDRUN_NETWORK_ENFORCE unset),
//      allowed and named in the trace once per site
//   3. a host a secret is granted to is INTERCEPTED: TLS ends here with a
//      leaf the egress CA signs (egress-ca.ts; the sandbox trusts it), and
//      each request inside goes through forward() exactly as an /e/ request
//      does — placeholders filled for that host, the test policy applied.
//      Every other host is a TUNNEL: bytes both ways, never read.
//
// Private addresses are refused whatever the list says (ssrf.ts): the
// worker can reach what a sandbox must not.

/** The lease token a forward-door request carries: the password of
 *  Proxy-Authorization's Basic credential. */
export function proxyToken(header: string | string[] | undefined): string | null {
  const v = Array.isArray(header) ? header[0] : header;
  const m = v?.match(/^Basic\s+([A-Za-z0-9+/=]+)\s*$/i);
  if (!m) return null;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const i = decoded.indexOf(":");
  const token = i >= 0 ? decoded.slice(i + 1) : decoded;
  return /^[A-Za-z0-9_-]{16,}$/.test(token) ? token : null;
}

/** `host:port` of a CONNECT, the brackets of an IPv6 literal dropped. */
export function connectTarget(raw: string | undefined): { host: string; port: number } | null {
  const m = (raw ?? "").match(/^\[?([^\]\s]+?)\]?:(\d{1,5})$/);
  if (!m) return null;
  const port = Number(m[2]);
  if (!(port > 0 && port < 65536)) return null;
  return { host: m[1].toLowerCase(), port };
}

/** Sites already named in a lease's trace as "would be refused", so a
 *  report-only install says each once, not once per request. */
const reported = new Map<string, Set<string>>();

/**
 * May this lease reach `host` through the forward door? `refuse` carries
 * the sentence for the client and the trace.
 */
export async function siteVerdict(lease: Lease, host: string): Promise<{ ok: true } | { ok: false; message: string }> {
  // A grant from a runner that predates network: has no list; the door is
  // then as narrow as the secrets — never wider than what the step declared.
  const policy = lease.grant.network ?? { level: "none" as const, hosts: [] };
  if (grantedHost(lease.grant, host) || networkAllows(policy, host)) return { ok: true };
  const message = refusalText(policy, host);
  if (lease.grant.enforce) {
    await store().append(lease.token, { kind: "line", text: `${message} Refused.` });
    return { ok: false, message };
  }
  const seen = reported.get(lease.token) ?? new Set<string>();
  if (!seen.has(host)) {
    seen.add(host);
    reported.set(lease.token, seen);
    await store().append(lease.token, { kind: "line", text: `network: ${host} would be refused (network: ${policy.level}) — allowed, because nothing here asks to refuse yet. Add it to the agent's network: list to keep it reachable; network_enforce: true in AGENTS.md refuses it.` });
  }
  return { ok: true };
}

async function leaseFor(header: string | string[] | undefined): Promise<{ lease: Lease } | { status: number; message: string }> {
  const token = proxyToken(header);
  if (!token) return { status: 407, message: "egress: the forward door needs the step's lease as the proxy password" };
  try {
    const lease = await store().get(token);
    return lease ? { lease } : { status: 407, message: "egress: no such lease — the step it belonged to is over" };
  } catch (err) {
    if (err instanceof LeaseStoreUnavailable) return { status: 503, message: err.message };
    throw err;
  }
}

/** `GET http://host/path` through HTTP_PROXY. */
async function handleForwardHttp(req: http.IncomingMessage, res: http.ServerResponse, started: number): Promise<void> {
  const deny = denier(res);
  const got = await leaseFor(req.headers["proxy-authorization"]);
  if ("status" in got) {
    if (got.status === 407) res.setHeader("proxy-authenticate", 'Basic realm="foldrun"');
    return deny(got.status, got.message);
  }
  const target = req.url ?? "";
  const host = hostOf(target);
  if (!host) return deny(400, "egress: not an absolute http:// URL");
  const verdict = await siteVerdict(got.lease, host);
  if (!verdict.ok) return deny(403, verdict.message);
  return forward(req, res, got.lease, target, host, started);
}

/** The socket property an intercepted connection carries its lease on. */
const TUNNEL = Symbol("foldrun.tunnel");
type Tunneled = { token: string; host: string; port: number };

/** Requests inside an intercepted TLS connection: never listening, fed one
 *  socket per bound-site CONNECT. */
const intercepted = http.createServer((req, res) => {
  const t = (req.socket as unknown as { [TUNNEL]?: Tunneled })[TUNNEL];
  const started = Date.now();
  const deny = denier(res);
  void (async () => {
    if (!t) return deny(500, "egress: an intercepted request without its tunnel");
    let lease: Lease | null;
    try {
      lease = await store().get(t.token);
    } catch (err) {
      if (err instanceof LeaseStoreUnavailable) return deny(503, err.message);
      throw err;
    }
    if (!lease) return deny(401, "egress: no such lease — the step it belonged to is over");
    const target = `https://${t.host}${t.port === 443 ? "" : `:${t.port}`}${req.url ?? "/"}`;
    return forward(req, res, lease, target, t.host, started);
  })().catch((err) => {
    if (!res.headersSent) deny(500, String(err));
    else res.end();
  });
});

function refuseConnect(socket: net.Socket, status: number, message: string): void {
  const body = JSON.stringify({ error: { type: "egress", message } });
  const reason = status === 403 ? "Forbidden" : status === 407 ? "Proxy Authentication Required" : status === 503 ? "Service Unavailable" : "Bad Gateway";
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n` +
      `${status === 407 ? 'proxy-authenticate: Basic realm="foldrun"\r\n' : ""}connection: close\r\n\r\n${body}`,
  );
}

/** HTTPS (and any other TCP a client tunnels) through HTTPS_PROXY. */
async function handleConnect(req: http.IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
  const started = Date.now();
  socket.on("error", () => undefined); // a pod that hung up is not the proxy's error
  const target = connectTarget(req.url);
  if (!target) return refuseConnect(socket, 400, "egress: CONNECT host:port");
  const got = await leaseFor(req.headers["proxy-authorization"]);
  if ("status" in got) return refuseConnect(socket, got.status, got.message);
  const { lease } = got;
  const verdict = await siteVerdict(lease, target.host);
  if (!verdict.ok) return refuseConnect(socket, 403, verdict.message);

  if (grantedHost(lease.grant, target.host)) {
    // A bound site: TLS ends here, so its requests can be filled.
    let leaf: { cert: string; key: string };
    try {
      leaf = leafFor(target.host);
    } catch (err) {
      return refuseConnect(socket, 502, `egress: could not sign for ${target.host}: ${err instanceof Error ? err.message : err}`);
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) socket.unshift(head);
    const secure = new tls.TLSSocket(socket, { isServer: true, cert: leaf.cert, key: leaf.key, ALPNProtocols: ["http/1.1"] });
    secure.on("error", () => undefined);
    (secure as unknown as { [TUNNEL]: Tunneled })[TUNNEL] = { token: lease.token, host: target.host, port: target.port };
    intercepted.emit("connection", secure);
    return;
  }

  // Every other site: a tunnel, never read. The lookup refuses private
  // addresses at connect time, after DNS, so a name that rebinds inward
  // is refused too.
  // An IP literal never reaches a lookup, so it is checked here.
  const guarded = !privateAllowed();
  if (guarded && net.isIP(target.host) && isPrivateAddress(target.host)) {
    await store().append(lease.token, { kind: "line", text: `egress: CONNECT ${target.host}:${target.port} refused — a private or internal address` });
    return refuseConnect(socket, 403, `egress: ${target.host} is a private or internal address`);
  }
  const upstream = net.connect({ host: target.host, port: target.port, ...(guarded ? { lookup: guardedLookup as unknown as net.LookupFunction } : {}) });
  let opened = false;
  upstream.on("connect", () => {
    opened = true;
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", (err) => {
    if (opened) {
      socket.destroy();
      return;
    }
    const inward = err instanceof PrivateAddressError || (err as { cause?: unknown }).cause instanceof PrivateAddressError || /private|internal/i.test(err.message);
    void store().append(lease.token, { kind: "line", text: `egress: CONNECT ${target.host}:${target.port} ${inward ? "refused" : "unreachable"} — ${err.message}` });
    refuseConnect(socket, inward ? 403 : 502, `egress: ${inward ? "" : "could not reach "}${target.host}:${target.port} — ${err.message}`);
  });
  socket.on("close", () => upstream.destroy());
  upstream.on("close", () => {
    socket.destroy();
    if (opened) void store().append(lease.token, { kind: "call", key: `CONNECT ${target.host}:${target.port}`, ms: Date.now() - started, secrets: [] });
  });
}

let server: http.Server | null = null;

/** Start listening. Idempotent; a no-op when FOLDRUN_EGRESS_URL is unset,
 *  because then no step will ever be told to send here. */
export function startEgressProxy(listenPort = port()): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    if (server) {
      const a = server.address();
      return resolve({ port: typeof a === "object" && a ? a.port : listenPort, close: stopEgressProxy });
    }
    const s = http.createServer((req, res) => {
      handle(req, res).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { type: "egress", message: String(err) } }));
        } else res.end();
      });
    });
    // The forward door's HTTPS half (see handleConnect).
    s.on("connect", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
      handleConnect(req, socket, head).catch((err) => refuseConnect(socket, 502, `egress: ${err instanceof Error ? err.message : err}`));
    });
    s.on("error", reject);
    s.listen(listenPort, "0.0.0.0", () => {
      server = s;
      const sweep = setInterval(sweepLeases, 10 * 60 * 1000);
      sweep.unref();
      const a = s.address();
      resolve({ port: typeof a === "object" && a ? a.port : listenPort, close: stopEgressProxy });
    });
  });
}

/** Stop taking new connections and let the ones open finish — a model call
 *  streams for minutes — closing what is still open at `graceMs`. For the
 *  egress role's SIGTERM, so a rolling update of the proxy does not cut a
 *  step's call the way a worker restart did (6 Oct 2026). Resolves true
 *  when everything finished on its own. */
export function drainEgressProxy(graceMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = server;
    server = null;
    if (!s) return resolve(true);
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      s.closeAllConnections?.();
      resolve(false);
    }, graceMs);
    timer.unref();
    s.close(() => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(true);
    });
    // Keep-alive sockets with nothing in flight would hold close() open.
    s.closeIdleConnections?.();
  });
}

export function stopEgressProxy(): Promise<void> {
  return new Promise((resolve) => {
    const s = server;
    server = null;
    if (!s) return resolve();
    s.closeAllConnections?.();
    s.close(() => resolve());
  });
}
