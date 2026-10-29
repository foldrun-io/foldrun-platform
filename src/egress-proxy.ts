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
// A v2 lease (FOLDRUN_EGRESS_LEASE_V2=1 on the worker, 29 Oct 2026) needs no
// account key to open: it is kept under the SHA-256 of its token, the grant
// sealed under a key derived from the token (AES-256-GCM, bound to lease,
// account and run), the record signed by the worker (Ed25519, egress-keys.ts).
// Redis then holds nothing that opens a lease or would let anyone write one
// the proxy honours, and an egress pod can run without the install key.
// Every proxy reads both shapes; legacyLeases() counts the v1 ones left.
//
// A refresh token the provider rotates mid-step is kept beside the lease
// (egress:rot:<lease>), so every replica refreshes with the newest one; the
// worker writes it to the vault copy it came from on its heartbeat.
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
import { decryptValue, encryptValue, getSecret, isOAuth2Value, materializeSecrets, replaceOAuth2RefreshToken } from "../../foldrun-core/src/secrets.ts";
import { leaseId, openForLease, sealForLease, signLeaseRecord, signRecoveryRecord, unwrapTokenForWorker, verifyLeaseRecord, verifyRecoveryRecord, wrapTokenForWorker } from "./egress-keys.ts";
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
  /** Where the store keeps it: the token for a v1 lease; for a v2 lease its
   *  SHA-256 (leaseId), so the store never holds a token that opens it. */
  key: string;
  /** A v2 lease: signed by the worker, its grant sealed under the token. */
  v2?: boolean;
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
 * A rotated OAuth refresh token, kept beside the lease (`egress:rot:<lease>`)
 * so every proxy replica refreshes with the newest one, not the one the
 * grant was written with — which the provider has just revoked. `base` is
 * the grant's own value it stands in for: an entry whose base the runner has
 * since re-granted is stale and ignored. `next` is the stored value with the
 * new refresh token. The worker writes it to the vault (mergeRotations).
 */
export interface Rotation {
  base: string;
  next: string;
  /** A worker's checkpoint for this chain, kept beside it so a worker
   *  taking the run over knows what the vault holds. */
  saved?: Saved;
}

/** A worker's write of `value` over `prev` to the vault copy of a chain
 *  that started at `base`. Checkpointed with done: false BEFORE the write
 *  and done: true after, so a worker that died between the two is finished
 *  by the next one (a compare-and-set from `prev`, harmless if it was done). */
export interface Saved {
  base: string;
  value: string;
  prev: string;
  done: boolean;
}

/** May a rotation from `used` to `r.next` replace the recorded `cur`? Over
 *  nothing, another chain's record, or the very record it started from:
 *  yes. Over a record already past it: no — that one is newer. */
export function rotationAdvances(cur: Rotation | null, r: Rotation, used: string): "write" | "same" | "stale" {
  if (!cur || cur.base !== r.base) return "write";
  if (cur.next === r.next) return "same";
  return cur.next === used ? "write" : "stale";
}

/**
 * Where leases live. Memory unless the install has Redis; both shapes
 * behind one interface so the proxy and the hooks never know which.
 * Everything but get() is addressed by the lease's store key (Lease.key):
 * the token for a v1 lease, its SHA-256 for a v2 one.
 */
interface LeaseStore {
  put(lease: Lease): Promise<void>;
  get(token: string): Promise<Lease | null>;
  /** `keepRotations`: the lease goes, its rotation record stays (the worker
   *  has not saved it to the vault yet). */
  del(key: string, runId?: string, keepRotations?: boolean): Promise<void>;
  append(key: string, entry: CallLine): Promise<void>;
  drain(key: string): Promise<CallLine[]>;
  size(): Promise<number>;
  /** v1 leases on the store: keyed by their token, sealed under the account
   *  key. A proxy without the account keys cannot open them. */
  legacy(): Promise<number>;
  /** Push every lease of this run's expiry out by the full window. */
  touchRun(runId: string, now: number): Promise<number>;
  /** When this run's driver last checked in, where the store keeps that
   *  apart from the leases (Redis); null where the lease itself says. */
  beatOf(runId: string): Promise<number | null>;
  /** The rotated refresh tokens recorded for this lease, by secret name. */
  rotations(lease: Lease): Promise<Record<string, Rotation>>;
  /** Record `r` — only over the record this refresh started from (its
   *  `next` is `used`), compared and set atomically: a delayed callback
   *  never writes an older refresh token over a newer one. False: a newer
   *  rotation is recorded, and this one is dropped. */
  rotate(lease: Lease, name: string, r: Rotation, used: string, at?: number): Promise<boolean>;
  /** Does `to` descend from `from` through rotations recorded for this
   *  credential (any lease holding it)? Each records the value it was made
   *  from, so this follows the provider's own chain, not anyone's clock. A
   *  value no rotation made — a person's reconnect — descends from nothing
   *  and nothing descends from it unless a rotation started there. */
  descends(lease: Lease, name: string, from: string, to: string): Promise<boolean>;
  /** The value a recorded rotation made from `value` (any lease holding
   *  this credential), or null. */
  successor(lease: Lease, name: string, value: string): Promise<string | null>;
  /** The rotation record's version: read before a settling merge. */
  rotationVersion(lease: Lease): Promise<string>;
  /** A released lease's records go — only if the rotation record is still
   *  at `version` (nothing was written since the merge read it). */
  settle(lease: Lease, version: string): Promise<boolean>;
  /** Release a v2 lease, keeping its rotation record: in ONE transaction,
   *  the lease goes and its recovery record (what a worker needs to finish
   *  the job after a restart — no grant, no authority) comes. Never one
   *  without the other: on failure nothing changed, and it is tried again. */
  releaseKeeping(lease: Lease, releasedAt: number): Promise<void>;
  /** The worker wrote `saved` to the vault for this secret's chain. */
  markSaved(lease: Lease, name: string, saved: Saved): Promise<void>;
}

const memoryLeases = new Map<string, Lease>();
const memoryLog = new Map<string, CallLine[]>();
const memoryRot = new Map<string, Map<string, Rotation>>();
/** Released leases whose rotation record is kept (the grace): no longer
 *  honoured, but a refresh in flight still finds its grant. */
const memoryKept = new Map<string, Lease>();
const memoryRotated = new Map<string, Map<string, { prev: string; at: number }>>();
/** cred → sha(from) → { next, at } (one process: no sealing needed). */
const memorySucc = new Map<string, Map<string, { next: string; at: number }>>();
/** Per lease, bumped by every rotation written: what a settle compares. */
const memoryRotVersion = new Map<string, number>();
/** The memory store's rotation history, kept as long as Redis keeps it:
 *  the lease window. */
function pruneMemoryRotated(now: number): void {
  for (const [cred, links] of memoryRotated) {
    for (const [v, link] of links) if (now - link.at > LEASE_MAX_AGE_MS) links.delete(v);
    if (!links.size) memoryRotated.delete(cred);
  }
  for (const [cred, succ] of memorySucc) {
    for (const [v, s] of succ) if (now - s.at > LEASE_MAX_AGE_MS) succ.delete(v);
    if (!succ.size) memorySucc.delete(cred);
  }
}
const memoryStore: LeaseStore = {
  async put(l) {
    memoryLeases.set(l.key, l);
  },
  async get(token) {
    // Held under its store key; the token must be the one it was issued
    // with — a v2 lease's id presented as a token is not its token.
    const l = memoryLeases.get(token) ?? (memoryLeases.size ? memoryLeases.get(leaseId(token)) : undefined);
    return l && l.token === token ? l : null;
  },
  async del(key, _runId, keepRotations) {
    const l = memoryLeases.get(key) ?? memoryKept.get(key);
    memoryLeases.delete(key);
    memoryLog.delete(key);
    if (keepRotations) {
      if (l) memoryKept.set(key, l);
      return;
    }
    memoryKept.delete(key);
    memoryRot.delete(key);
    memoryRotVersion.delete(key);
    // Drop the values, not just the map entry: nothing should keep a
    // reference to a step's secrets after the step.
    if (l) for (const k of Object.keys(l.grant.secrets)) delete l.grant.secrets[k];
  },
  async append(key, entry) {
    const list = memoryLog.get(key) ?? [];
    list.push(entry);
    memoryLog.set(key, list);
  },
  async drain(key) {
    const list = memoryLog.get(key) ?? [];
    memoryLog.set(key, []);
    return list;
  },
  async size() {
    return memoryLeases.size;
  },
  async legacy() {
    return 0; // one process's memory: nothing for another process to open
  },
  async touchRun(runId, now) {
    let n = 0;
    for (const l of memoryLeases.values()) {
      if (l.runId !== runId) continue;
      l.renewedAt = now;
      n++;
      // The credentials it holds keep their rotation history while it lives.
      for (const c of oauthCreds(l)) {
        for (const link of memoryRotated.get(c)?.values() ?? []) link.at = now;
        for (const succ of memorySucc.get(c)?.values() ?? []) succ.at = now;
      }
    }
    return n;
  },
  async beatOf() {
    return null; // a memory lease's renewedAt is the beat
  },
  async rotations(l) {
    return Object.fromEntries(memoryRot.get(l.key) ?? []);
  },
  async rotate(l, name, r, used, at = Date.now()) {
    const m = memoryRot.get(l.key) ?? new Map<string, Rotation>();
    const cur = m.get(name) ?? null;
    let d = rotationAdvances(cur, r, used);
    // Past the record by way of another lease's rotations: still forward.
    if (d === "stale" && cur && (await memoryStore.descends(l, name, cur.next, used))) d = "write";
    if (d === "stale") return false;
    if (d === "write") {
      m.set(name, { base: r.base, next: r.next, ...(cur?.saved && cur.base === r.base ? { saved: cur.saved } : {}) });
      memoryRotVersion.set(l.key, (memoryRotVersion.get(l.key) ?? 0) + 1);
      const links = memoryRotated.get(credOf(l, name)) ?? new Map<string, { prev: string; at: number }>();
      // A value is made once, from one predecessor: the first record stands.
      if (!links.has(sha(r.next))) links.set(sha(r.next), { prev: sha(used), at });
      memoryRotated.set(credOf(l, name), links);
      const succ = memorySucc.get(credOf(l, name)) ?? new Map<string, { next: string; at: number }>();
      if (!succ.has(sha(used))) succ.set(sha(used), { next: r.next, at });
      memorySucc.set(credOf(l, name), succ);
      pruneMemoryRotated(Date.now());
    }
    memoryRot.set(l.key, m);
    return true;
  },
  async successor(l, name, value) {
    return memorySucc.get(credOf(l, name))?.get(sha(value))?.next ?? null;
  },
  async descends(l, name, from, to) {
    const links = memoryRotated.get(credOf(l, name));
    return chainReaches(sha(from), sha(to), (v) => links?.get(v)?.prev ?? null);
  },
  async rotationVersion(l) {
    return String(memoryRotVersion.get(l.key) ?? 0);
  },
  async settle(l, version) {
    // A rotation recorded while the merge awaited: not settled yet.
    if (String(memoryRotVersion.get(l.key) ?? 0) !== version) return false;
    memoryRotVersion.delete(l.key);
    await memoryStore.del(l.key, l.runId);
    return true;
  },
  async releaseKeeping(l) {
    // One process's memory: a restart loses it either way.
    await memoryStore.del(l.key, l.runId, true);
  },
  async markSaved(l, name, saved) {
    const r = memoryRot.get(l.key)?.get(name);
    if (r) r.saved = { ...saved };
  },
};

const rkey = (key: string) => `egress:lease:${key}`;
const rlog = (key: string) => `egress:log:${key}`;
const rrot = (key: string) => `egress:rot:${key}`;
/** The run's leases, so a heartbeat can find them without a SCAN. */
const rrun = (runId: string) => `egress:run:${runId}`;
const rbeat = (runId: string) => `egress:beat:${runId}`;
/** A released v2 lease's recovery record, and the set of them. */
const rrecover = (key: string) => `egress:recover:${key}`;
const RECOVERING = "egress:recovering";
/** Per credential (account, vault scope, name — every lease holding it
 *  shares it): sha256 of each value a rotation produced → sha256 of the
 *  value it was produced from. The provider's chain, as recorded. */
const rrotated = (cred: string) => `egress:rotated:${cred}`;
const sha = (v: string) => crypto.createHash("sha256").update(v).digest("hex");
/** Per credential: sha256 of a value → the value a rotation made from it,
 *  sealed under a key derived from the value it was made FROM. Whoever
 *  holds an older value of the credential (a later lease's grant, before
 *  the worker has saved the rotation) can follow it to the newest; Redis
 *  alone opens none of it. */
const rsucc = (cred: string) => `egress:succ:${cred}`;
/** The credentials a lease's grant carries (oauth2 only), by credOf. */
const rcreds = (key: string) => `egress:creds:${key}`;
const oauthCreds = (l: Lease): string[] => [...new Set(Object.entries(l.grant.secrets).filter(([, g]) => isOAuth2Value(g.value)).map(([n]) => credOf(l, n)))];
const successorKey = (from: string) => Buffer.from(crypto.hkdfSync("sha256", from, Buffer.alloc(0), "foldrun egress successor v1", 32));
function sealSuccessor(cred: string, from: string, next: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", successorKey(from), iv, { authTagLength: 16 });
  c.setAAD(Buffer.from(`${cred}|${sha(from)}`));
  const enc = Buffer.concat([c.update(next, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}
function openSuccessor(cred: string, from: string, sealed: string): string | null {
  try {
    const raw = Buffer.from(sealed, "base64");
    if (raw.length < 28) return null;
    const d = crypto.createDecipheriv("aes-256-gcm", successorKey(from), raw.subarray(0, 12), { authTagLength: 16 });
    d.setAAD(Buffer.from(`${cred}|${sha(from)}`));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
/** Walk back from `to` along recorded predecessors: true when `from` is on
 *  the way, however long the chain. A value seen twice is a loop someone
 *  wrote, and ends the walk. */
export function chainReaches(from: string, to: string, prevOf: (v: string) => string | null): boolean {
  const seen = new Set<string>([to]);
  let v: string | null = to;
  while (v) {
    v = prevOf(v);
    if (v === from) return true;
    if (v === null || seen.has(v)) return false;
    seen.add(v);
  }
  return false;
}
const credOf = (l: Lease, name: string) => sha(JSON.stringify([l.tenant, secretWorkspace(l.grant, l.who, name) ?? "", name]));
/** Compare-and-set on one rotation field, by its stored (sealed) value: the
 *  caller opened and judged the current one; this writes only if nobody
 *  changed it since. "" stands for "no field". In the same step, when the
 *  rotation was made (KEYS[2], the credential's record): the two are never
 *  apart. And a rotation that lands after its lease was released and
 *  settled (a proxy's late retry) puts the lease back among those a worker
 *  recovers, while its signed recovery record (KEYS[4]) is still there. */
const HASH_CAS = `local cur = redis.call('HGET', KEYS[1], ARGV[1])
if (cur == false and ARGV[2] == '') or cur == ARGV[2] then
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
  redis.call('HINCRBY', KEYS[1], '@v', 1)
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
  redis.call('HSETNX', KEYS[2], ARGV[5], ARGV[6])
  redis.call('EXPIRE', KEYS[2], tonumber(ARGV[4]))
  redis.call('HSETNX', KEYS[6], ARGV[6], ARGV[8])
  redis.call('EXPIRE', KEYS[6], tonumber(ARGV[4]))
  if redis.call('EXISTS', KEYS[3]) == 0 and redis.call('EXISTS', KEYS[4]) == 1 then
    redis.call('SADD', KEYS[5], ARGV[7])
  end
  return 1
end
return 0`;
/** Settle a released lease: its records go only if no rotation was written
 *  since the merge read them (`@v`, bumped by every write above). */
const SETTLE = `local cur = redis.call('HGET', KEYS[1], '@v')
if (cur == false and ARGV[1] == '') or cur == ARGV[1] then
  redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
  redis.call('SREM', KEYS[4], ARGV[2])
  redis.call('SREM', KEYS[5], ARGV[2])
  return 1
end
return 0`;
/** A v2 lease's store key: 64 hex. A v1 key is the 32-character token. */
const V2_KEY = /^egress:lease:[0-9a-f]{64}$/;
/** Called once when a grant will not decrypt, before the lease is treated as
 *  absent. The egress role sets it to reload the account keys: a proxy in its
 *  own pod learns a key minted by the worker only on its five-minute refresh,
 *  so a brand-new account's first step would otherwise be refused there. */
let reloadKeys: (() => Promise<unknown>) | null = null;
export function setGrantKeyReload(fn: (() => Promise<unknown>) | null): void {
  reloadKeys = fn;
}

/** Whether this process may open v1 leases at all. An egress pod running
 *  without the install key turns it off (egress.ts): a v1 grant is sealed
 *  under the account key, and asking for one would reach for the install
 *  key — which, absent, core would otherwise create as a file. */
let v1Readable = true;
export function setLegacyLeasesReadable(on: boolean): void {
  v1Readable = on;
}

/** Whether the worker writes v2 leases (FOLDRUN_EGRESS_LEASE_V2=1). Every
 *  proxy reads both, so the switch is flipped on the worker once a release
 *  that reads v2 is on every egress pod. */
export const leaseV2 = () => process.env.FOLDRUN_EGRESS_LEASE_V2 === "1";

/** What a v2 grant's seal is bound to: moved to another lease, tenant or
 *  run, it will not open. */
const grantAad = (id: string, tenant: string, runId: string) => `${id}|${tenant}|${runId}`;

/** The lease fields beside the grant, one spelling for both record shapes. */
type LeaseRecord = { tenant: string; runId: string; createdAt: number; renewedAt?: number; test?: boolean; step?: number; agent?: string; peers?: PeerInfo[]; who?: LeaseWho; delegates?: string[] };
const recordOf = (l: Lease): LeaseRecord => ({
  tenant: l.tenant,
  runId: l.runId,
  createdAt: l.createdAt,
  renewedAt: l.renewedAt,
  test: l.test === true,
  ...(typeof l.step === "number" ? { step: l.step } : {}),
  ...peerFields(l),
  ...delegateFields(l),
  ...(l.who ? { who: l.who } : {}),
});
const leaseOf = (token: string, key: string, rec: LeaseRecord, grant: EgressGrant, v2: boolean): Lease => ({
  token,
  key,
  ...(v2 ? { v2: true } : {}),
  tenant: rec.tenant,
  runId: rec.runId,
  createdAt: rec.createdAt,
  renewedAt: rec.renewedAt ?? rec.createdAt,
  grant,
  test: rec.test === true,
  ...(typeof rec.step === "number" ? { step: rec.step } : {}),
  ...peerFields(rec),
  ...delegateFields(rec),
  ...(rec.who ? { who: rec.who } : {}),
});

/** Refused v2 records, said once each in the log: a forged or unsigned
 *  record is someone writing to Redis who should not be. */
const refusedV2 = new Set<string>();
function refuseV2(id: string, why: string): null {
  if (!refusedV2.has(id)) {
    if (refusedV2.size > 1000) refusedV2.clear();
    refusedV2.add(id);
    console.error(`[foldrun] egress: lease ${id.slice(0, 12)}… refused — ${why}`);
  }
  return null;
}

/** A v2 lease by its token: the record at sha256(token), signed by the
 *  worker, its grant sealed under the token's own key. undefined: there is
 *  none (the caller tries v1); null: there is one and it is refused. */
async function getV2(token: string): Promise<Lease | null | undefined> {
  const id = leaseId(token);
  const raw = await cache()!.get(rkey(id));
  if (!raw) return undefined;
  let w: { v?: unknown; rec?: unknown; sig?: unknown };
  try {
    w = JSON.parse(raw);
  } catch {
    return refuseV2(id, "not a lease record");
  }
  if (w.v !== 2 || typeof w.rec !== "string" || typeof w.sig !== "string") return refuseV2(id, "not a signed v2 record");
  if (!verifyLeaseRecord(w.rec, w.sig)) return refuseV2(id, "its signature does not verify under the worker's lease key");
  const rec = JSON.parse(w.rec) as LeaseRecord & { v?: number; id?: string; grant?: string };
  if (rec.v !== 2 || rec.id !== id || typeof rec.grant !== "string") return refuseV2(id, "the signed record names another lease");
  const plain = openForLease(token, grantAad(id, rec.tenant, rec.runId), rec.grant);
  if (plain === null) return refuseV2(id, "its grant will not open with this token");
  return leaseOf(token, id, rec, JSON.parse(plain) as EgressGrant, true);
}

/** Open a rotation field as stored (`what` is "rot" or "saved"). null: it
 *  will not open; skipped. */
function openRotationField(l: Lease, what: "rot" | "saved", name: string, stored: string): Record<string, unknown> | null {
  let plain: string | null = null;
  if (l.v2) plain = openForLease(l.token, `${l.key}|${what}|${name}`, stored);
  else if (v1Readable) {
    try {
      plain = decryptValue(l.tenant, JSON.parse(stored));
    } catch {
      plain = null;
    }
  }
  if (plain === null) return null;
  try {
    return JSON.parse(plain) as Record<string, unknown>;
  } catch {
    return null;
  }
}
const sealRotationField = (l: Lease, what: "rot" | "saved", name: string, plain: string) =>
  l.v2 ? sealForLease(l.token, `${l.key}|${what}|${name}`, plain) : JSON.stringify(encryptValue(l.tenant, plain));
/** The hash field a worker's saved value for `name` lives in. Secret names
 *  are UPPER_SNAKE, so this never collides with one. */
const SAVED = "@saved";

const redisStore: LeaseStore = {
  async put(l) {
    const r = cache()!;
    let stored: string;
    if (l.v2) {
      // Nothing here opens the grant without the token, and the record is
      // signed: a lease only the worker could have written.
      // `wrap`: the token under a key only a worker can derive, so a worker
      // taking the run over can open the rotation record (recoverIssued).
      const rec = JSON.stringify({ v: 2, id: l.key, ...recordOf(l), grant: sealForLease(l.token, grantAad(l.key, l.tenant, l.runId), JSON.stringify(l.grant)), wrap: wrapTokenForWorker(l.token, l.key) });
      stored = JSON.stringify({ v: 2, rec, sig: signLeaseRecord(rec) });
    } else {
      stored = JSON.stringify({ ...recordOf(l), grant: encryptValue(l.tenant, JSON.stringify(l.grant)) });
    }
    // Which credentials this lease's grant carries (hashes only): its
    // heartbeat keeps their rotation history alive as long as it lives.
    const creds = oauthCreds(l);
    const m = r
      .multi()
      .set(rkey(l.key), stored, "EX", LEASE_TTL_SEC)
      .sadd(rrun(l.runId), l.key)
      .expire(rrun(l.runId), LEASE_TTL_SEC)
      .del(rcreds(l.key));
    if (creds.length) m.sadd(rcreds(l.key), ...creds).expire(rcreds(l.key), LEASE_TTL_SEC);
    await m.exec();
  },
  async get(token) {
    const v2 = await getV2(token);
    if (v2 !== undefined) return v2;
    if (!v1Readable) return null;
    const raw = await cache()!.get(rkey(token));
    if (!raw) return null;
    const rec = JSON.parse(raw) as LeaseRecord & { v?: number; grant: ReturnType<typeof encryptValue> };
    // A v2 record read through its id as if the id were a token: refused.
    if (rec.v === 2) return null;
    // A grant that will not decrypt (the account's key rotated mid-step,
    // say) is a lease that cannot be honoured: treat it as absent.
    let plain = decryptValue(rec.tenant, rec.grant);
    if (plain === null && reloadKeys) {
      await reloadKeys().catch(() => undefined);
      plain = decryptValue(rec.tenant, rec.grant);
    }
    if (plain === null) return null;
    return leaseOf(token, token, rec, JSON.parse(plain) as EgressGrant, false);
  },
  async del(key, runId, keepRotations) {
    const r = cache()!;
    if (!runId) {
      const raw = await r.get(rkey(key));
      if (raw) {
        const w = JSON.parse(raw) as { v?: number; rec?: string; runId?: string };
        runId = w.v === 2 && typeof w.rec === "string" ? (JSON.parse(w.rec) as { runId?: string }).runId : w.runId;
      }
    }
    // Settled: the recovery record stays until it expires (the lease's
    // window), off the list — a proxy's late write puts it back on.
    const m = keepRotations ? r.multi().del(rkey(key), rlog(key), rcreds(key)) : r.multi().del(rkey(key), rlog(key), rrot(key), rcreds(key)).srem(RECOVERING, key);
    if (runId) m.srem(rrun(runId), key);
    await m.exec();
  },
  async touchRun(runId, now) {
    const r = cache()!;
    const keys = await r.smembers(rrun(runId));
    if (!keys.length) return 0;
    // A credential's rotation history (successors, chain links) lives as
    // long as the longest-lived lease holding it: a lease that has been
    // quiet for hours while another rotated its credential must still find
    // the newest token on its next refresh.
    const creds = new Set((await Promise.all(keys.map((k) => r.smembers(rcreds(k))))).flat());
    const m = r.multi();
    for (const k of keys) m.expire(rkey(k), LEASE_TTL_SEC).expire(rlog(k), LEASE_TTL_SEC).expire(rrot(k), LEASE_TTL_SEC).expire(rcreds(k), LEASE_TTL_SEC);
    for (const c of creds) m.expire(rsucc(c), LEASE_TTL_SEC).expire(rrotated(c), LEASE_TTL_SEC);
    m.expire(rrun(runId), LEASE_TTL_SEC);
    // The heartbeat's time, kept apart: the lease blobs only have their
    // expiry pushed out, and the identity door asks when the driver last
    // checked in.
    m.set(rbeat(runId), String(now), "EX", LEASE_TTL_SEC);
    await m.exec();
    return keys.length;
  },
  async beatOf(runId) {
    const v = await cache()!.get(rbeat(runId));
    return v ? Number(v) : null;
  },
  async append(key, entry) {
    const r = cache()!;
    await r.rpush(rlog(key), JSON.stringify(entry));
    await r.expire(rlog(key), LEASE_TTL_SEC);
  },
  async drain(key) {
    const r = cache()!;
    const items = await r.lrange(rlog(key), 0, -1);
    if (items.length) await r.ltrim(rlog(key), items.length, -1);
    return items.map((i) => JSON.parse(i) as CallLine);
  },
  async size() {
    return (await scanLeaseKeys()).length;
  },
  async legacy() {
    return (await scanLeaseKeys()).filter((k) => !V2_KEY.test(k)).length;
  },
  async rotations(l) {
    const all = await cache()!.hgetall(rrot(l.key));
    const out: Record<string, Rotation> = {};
    for (const [name, stored] of Object.entries(all ?? {})) {
      if (name.startsWith("@") || name.endsWith(SAVED)) continue;
      const r = openRotationField(l, "rot", name, stored);
      if (r && typeof r.base === "string" && typeof r.next === "string") out[name] = { base: r.base, next: r.next };
    }
    for (const [field, stored] of Object.entries(all ?? {})) {
      if (!field.endsWith(SAVED)) continue;
      const name = field.slice(0, -SAVED.length);
      const v = out[name] && openRotationField(l, "saved", name, stored);
      if (v && typeof v.base === "string" && typeof v.value === "string" && typeof v.prev === "string") out[name]!.saved = { base: v.base, value: v.value, prev: v.prev, done: v.done === true };
    }
    // Kept as long as it is used: a worker from before rotation records
    // renews the lease but not this, and a lease outliving its record would
    // go back to the revoked refresh token in its grant.
    if (Object.keys(out).length) await cache()!.expire(rrot(l.key), LEASE_TTL_SEC).catch(() => undefined);
    return out;
  },
  async rotate(l, name, rot, used, at = Date.now()) {
    const r = cache()!;
    for (let attempt = 0; attempt < 5; attempt++) {
      const raw = await r.hget(rrot(l.key), name);
      const opened = raw ? openRotationField(l, "rot", name, raw) : null;
      const cur = opened && typeof opened.base === "string" && typeof opened.next === "string" ? { base: opened.base, next: opened.next } : null;
      let d = rotationAdvances(cur, rot, used);
      // Past the record by way of another lease's rotations (this request
      // followed the credential's chain): still forward, not stale.
      if (d === "stale" && cur && (await redisStore.descends(l, name, cur.next, used))) d = "write";
      if (d === "stale") return false;
      const cred = rrotated(credOf(l, name));
      if (d === "same") {
        // Recorded already; its link too, unless an earlier write lost it.
        // HSETNX: a value is made once, from one predecessor.
        const succ = rsucc(credOf(l, name));
        await r
          .multi()
          .hsetnx(cred, sha(rot.next), sha(used))
          .expire(cred, LEASE_TTL_SEC)
          .hsetnx(succ, sha(used), sealSuccessor(credOf(l, name), used, rot.next))
          .expire(succ, LEASE_TTL_SEC)
          .exec();
        return true;
      }
      // v2: under the lease token's key, which this proxy and the worker
      // alone can derive. v1: under the account key, as the grant is.
      const stored = sealRotationField(l, "rot", name, JSON.stringify({ base: rot.base, next: rot.next }));
      if (Number(await r.eval(HASH_CAS, 6, rrot(l.key), cred, rkey(l.key), rrecover(l.key), RECOVERING, rsucc(credOf(l, name)), name, raw ?? "", stored, String(LEASE_TTL_SEC), sha(rot.next), sha(used), l.key, sealSuccessor(credOf(l, name), used, rot.next))) === 1) return true;
      // Changed between the read and the write: read it again.
    }
    throw new Error("the rotation record kept changing under this write");
  },
  async successor(l, name, value) {
    const cred = credOf(l, name);
    const sealed = await cache()!.hget(rsucc(cred), sha(value));
    return sealed ? openSuccessor(cred, value, sealed) : null;
  },
  async descends(l, name, from, to) {
    const links = await cache()!.hgetall(rrotated(credOf(l, name)));
    return chainReaches(sha(from), sha(to), (v) => links?.[v] ?? null);
  },
  async rotationVersion(l) {
    return (await cache()!.hget(rrot(l.key), "@v")) ?? "";
  },
  async settle(l, version) {
    // The recovery record stays until it expires (the lease's window), off
    // the list — a proxy's late write puts it back on.
    const settled = Number(await cache()!.eval(SETTLE, 5, rrot(l.key), rkey(l.key), rlog(l.key), RECOVERING, rrun(l.runId), version, l.key)) === 1;
    if (settled) await cache()!.del(rcreds(l.key)).catch(() => undefined);
    return settled;
  },
  async releaseKeeping(l, releasedAt) {
    // Signed by the worker; the token in it wrapped under a key only a
    // worker derives. Nothing here opens a lease or is honoured as one.
    const rec = JSON.stringify({
      kind: "recover",
      v: 1,
      id: l.key,
      runId: l.runId,
      tenant: l.tenant,
      releasedAt,
      wrap: wrapTokenForWorker(l.token, l.key),
      healthKeys: l.grant.healthKeys ?? {},
      ...(l.who ? { who: l.who } : {}),
    });
    const results = await cache()!
      .multi()
      .set(rrecover(l.key), JSON.stringify({ rec, sig: signRecoveryRecord(rec) }), "EX", LEASE_TTL_SEC)
      .sadd(RECOVERING, l.key)
      .del(rkey(l.key), rlog(l.key), rcreds(l.key))
      .srem(rrun(l.runId), l.key)
      .exec();
    const failed = results?.find(([err]) => err);
    if (!results || failed) throw new Error(`could not release the lease: ${failed?.[0]?.message ?? "the transaction was not run"}`);
  },
  async markSaved(l, name, saved) {
    await cache()!.hset(rrot(l.key), `${name}${SAVED}`, sealRotationField(l, "saved", name, JSON.stringify(saved)));
  },
};

async function scanLeaseKeys(): Promise<string[]> {
  const out: string[] = [];
  let cursor = "0";
  do {
    const [next, keys] = await cache()!.scan(cursor, "MATCH", "egress:lease:*", "COUNT", 100);
    cursor = next;
    out.push(...keys);
  } while (cursor !== "0");
  return out;
}

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
 *  operator allowed it, by store key. Read from memory first for exactly
 *  these. */
const inMemory = new Set<string>();
const heldHere = (token: string) => inMemory.size > 0 && (inMemory.has(token) || inMemory.has(leaseId(token)));
const guardedStore: LeaseStore = {
  async put(l) {
    if (inMemory.has(l.key)) return memoryStore.put(l);
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
    inMemory.add(l.key);
    return memoryStore.put(l);
  },
  async get(token) {
    if (heldHere(token)) return memoryStore.get(token);
    if (!(await redisReady())) throw new LeaseStoreUnavailable("Redis is not answering");
    try {
      return await redisStore.get(token);
    } catch (err) {
      throw new LeaseStoreUnavailable(err instanceof Error ? err.message : String(err));
    }
  },
  async del(key, runId, keepRotations) {
    if (inMemory.has(key)) {
      if (!keepRotations) inMemory.delete(key);
      return memoryStore.del(key, runId, keepRotations);
    }
    if (await redisReady()) return redisStore.del(key, runId, keepRotations);
    // Unreachable: it expires on its own after the window. That is what
    // the TTL is for.
  },
  async append(key, entry) {
    if (inMemory.has(key) || !(await redisReady())) return memoryStore.append(key, entry);
    return redisStore.append(key, entry);
  },
  async drain(key) {
    if (inMemory.has(key)) return memoryStore.drain(key);
    return (await redisReady()) ? redisStore.drain(key) : memoryStore.drain(key);
  },
  async size() {
    return (await memoryStore.size()) + ((await redisReady()) ? await redisStore.size() : 0);
  },
  async legacy() {
    return (await redisReady()) ? redisStore.legacy() : 0;
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
  async rotations(l) {
    if (inMemory.has(l.key)) return memoryStore.rotations(l);
    if (!(await redisReady())) throw new LeaseStoreUnavailable("Redis is not answering");
    return redisStore.rotations(l);
  },
  async rotate(l, name, r, used, at) {
    if (inMemory.has(l.key)) return memoryStore.rotate(l, name, r, used, at);
    if (!(await redisReady())) throw new LeaseStoreUnavailable("Redis is not answering");
    return redisStore.rotate(l, name, r, used, at);
  },
  async rotationVersion(l) {
    if (inMemory.has(l.key)) return memoryStore.rotationVersion(l);
    if (!(await redisReady())) throw new LeaseStoreUnavailable("Redis is not answering");
    return redisStore.rotationVersion(l);
  },
  async settle(l, version) {
    if (inMemory.has(l.key)) {
      // The routing goes only once it is settled: a rotation still held
      // here must be found here by the next try.
      const settled = await memoryStore.settle(l, version);
      if (settled) inMemory.delete(l.key);
      return settled;
    }
    if (!(await redisReady())) throw new LeaseStoreUnavailable("Redis is not answering");
    return redisStore.settle(l, version);
  },
  async successor(l, name, value) {
    if (inMemory.has(l.key)) return memoryStore.successor(l, name, value);
    if (!(await redisReady())) throw new LeaseStoreUnavailable("Redis is not answering");
    return redisStore.successor(l, name, value);
  },
  async descends(l, name, from, to) {
    if (inMemory.has(l.key)) return memoryStore.descends(l, name, from, to);
    if (!(await redisReady())) throw new LeaseStoreUnavailable("Redis is not answering");
    return redisStore.descends(l, name, from, to);
  },
  async releaseKeeping(l, releasedAt) {
    if (inMemory.has(l.key)) return memoryStore.releaseKeeping(l, releasedAt);
    if (!(await redisReady())) throw new LeaseStoreUnavailable("Redis is not answering");
    return redisStore.releaseKeeping(l, releasedAt);
  },
  async markSaved(l, name, saved) {
    if (inMemory.has(l.key)) return memoryStore.markSaved(l, name, saved);
    if (!(await redisReady())) throw new LeaseStoreUnavailable("Redis is not answering");
    return redisStore.markSaved(l, name, saved);
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
    // v2 (FOLDRUN_EGRESS_LEASE_V2=1): kept at the token's hash, signed, its
    // grant sealed under the token — a proxy opens it with no account key.
    const v2 = leaseV2();
    const key = v2 ? leaseId(token) : token;
    const lease: Lease = {
      token,
      key,
      ...(v2 ? { v2: true } : {}),
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
    const mine: Issued = { lease, merged: {} };
    issued.set(key, mine);
    const door = forwardDoorUrl(base, token);
    const self: EgressLease = {
      url: `${base}/e/${token}`,
      ...(door ? { proxy: door, ca: egressCaPem(), enforce: grant.enforce } : {}),
      // The memory store shares the grant by reference, so a commit there
      // is a no-op; Redis needs the additions written.
      commit: () => store().put(lease),
      drainLog: async () => formatDrain(await store().drain(key)),
      release: async () => {
        reported.delete(token);
        if (!lease.v2) {
          // v1: the proxy wrote the vault itself on each rotation; a write
          // that failed is made here, from the rotation record, before the
          // record goes. This worker holds the account keys that open it.
          await mergeRotations(mine).catch((err) => console.error(`[foldrun] egress: rotated refresh tokens for ${runId} not saved: ${err instanceof Error ? err.message : err}`));
          issued.delete(key);
          return store().del(key, runId);
        }
        // A refresh token the provider rotated during the step goes to the
        // vault now. The lease goes too — no new request is honoured — but
        // its rotation record stays a little longer: a refresh already in
        // flight may still record one. It is merged again after that grace
        // (settleReleased), and on every heartbeat until it is saved.
        await mergeRotations(mine).catch((err) => console.error(`[foldrun] egress: rotated refresh tokens for ${runId} not saved yet: ${err instanceof Error ? err.message : err}`));
        mine.released = Date.now();
        mine.lease.renewedAt = mine.released;
        // The lease goes and what a worker after a restart needs to finish
        // this comes, in one transaction. If it fails, the lease is still
        // there (and recoverable as a live one); every settle tries again
        // before anything else.
        mine.recoveryKept = await store().releaseKeeping(lease, mine.released).then(
          () => true,
          (err) => {
            console.error(`[foldrun] egress: lease for ${runId} not released yet: ${err instanceof Error ? err.message : err}`);
            return false;
          },
        );
        // Retried until it settles (a store that is down now may not be in a
        // minute), not left to the next run's heartbeat: an idle worker has
        // none. Backs off to ten minutes, gives up after about ten hours.
        const settle = (attempt: number) =>
          setTimeout(async () => {
            if (!(await settleReleased(key, mine).catch(() => false)) && attempt < 60) settle(attempt + 1);
          }, attempt === 0 ? rotationGraceMs() : Math.min(30_000 * 2 ** Math.min(attempt, 5), 600_000)).unref();
        settle(0);
      },
    };
    return self;
  },
};

/** For tests only: record a rotation on a live lease exactly as the proxy
 *  does after a refresh (compare-and-set against `used`). */
export async function recordRotationForTest(
  token: string,
  name: string,
  r: Rotation,
  used: string,
  /** A released lease: what a proxy still holding it would know. */
  gone?: { tenant: string; runId: string; healthKeys?: Record<string, string> },
): Promise<boolean> {
  const lease: Lease | null = (await store().get(token)) ??
    (gone ? { token, key: leaseId(token), v2: true, tenant: gone.tenant, runId: gone.runId, grant: { secrets: {}, healthKeys: gone.healthKeys ?? {} }, createdAt: Date.now(), renewedAt: Date.now() } : null);
  if (!lease) throw new Error("no such lease");
  return store().rotate(lease, name, r, used);
}

/** For tests and the status line: how many leases are live. */
export function liveLeases(): Promise<number> {
  return store().size();
}

/** How many live leases are v1 (keyed by token, sealed under the account
 *  key). Zero is when an egress pod may drop the install key. */
export function legacyLeases(): Promise<number> {
  return store().legacy();
}

/** The leases this worker process wrote, by store key, while they live:
 *  only the writer of a v2 lease knows its token, which opens the rotation
 *  record the proxy keeps beside it (a v1 one's opens with the account key,
 *  and is merged too, for a vault write the proxy could not make). `merged` is, per secret, the value
 *  this worker last wrote to the vault. */
interface Issued {
  lease: Lease;
  /** Per secret: the grant value a rotation chain started from, and the
   *  value this worker last wrote to the vault for it. A re-grant starts a
   *  new chain. */
  merged: Record<string, Saved & { synced?: boolean }>;
  /** When the step released it: the lease is gone, its rotation record kept
   *  until a merge after the grace has saved everything (settleReleased). */
  released?: number;
  /** The merge in progress, so the next waits for it. */
  merging?: Promise<unknown>;
  /** Taken on from a worker that stopped while the lease was live: merged
   *  by the recovery loop until the lease is gone. */
  orphan?: boolean;
  /** False: the release transaction (lease out, recovery record in) has
   *  not gone through yet — the lease is still live; settling retries it. */
  recoveryKept?: boolean;
}
const issued = new Map<string, Issued>();

/** Which vault scope a granted secret came from: the workspace named in its
 *  health key, the account for "account:NAME", and — for a grant from a
 *  runner that did not say — the lease's workspace, then the account. */
export function secretWorkspace(grant: EgressGrant, who: LeaseWho | undefined, name: string): string | undefined {
  const key = grant.healthKeys?.[name];
  if (key) return /^workspace:(.+):[^:]+$/.exec(key)?.[1];
  return who?.workspace;
}

/** Rotations this proxy could not record (the store failed after the
 *  provider had rotated), by lease key: used here, written again on the
 *  lease's next request, and retried in the background (retryUnsaved) so a
 *  step's last request is not the end of it. */
/** One refresh this proxy could not record: from `used` to `next`. */
interface HeldStep {
  used: string;
  next: string;
  at: number;
}
const unsaved = new Map<string, { lease: Lease; held: Map<string, { base: string; steps: HeldStep[] }> }>();

/** Write what this proxy holds for one lease, each refresh in the order it
 *  happened — never collapsed, so a store that already has an intermediate
 *  value still takes the rest. `current` is the lease as a request found it
 *  now (a re-grant since drops what it held), or null for the background
 *  retry, which goes by the lease it was held with. */
const flushing = new Map<string, Promise<void>>();
function flushUnsaved(key: string, current: Lease | null): Promise<void> {
  // One flush per lease at a time: the background retry and a request must
  // not both write (and remove) the same chain's steps.
  const run = (flushing.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => flushOnce(key, current));
  flushing.set(key, run);
  void run.finally(() => {
    if (flushing.get(key) === run) flushing.delete(key);
  }).catch(() => undefined);
  return run;
}

async function flushOnce(key: string, current: Lease | null): Promise<void> {
  const entry = unsaved.get(key);
  if (!entry) return;
  const lease = current ?? entry.lease;
  for (const [name, chain] of entry.held) {
    // A re-grant since made it another chain's: dropped, never written over
    // the new one's record.
    if (current && current.grant.secrets[name]?.value !== chain.base) {
      entry.held.delete(name);
      continue;
    }
    try {
      while (chain.steps.length) {
        const step = chain.steps[0]!;
        // Kept no longer than the lease could live. Otherwise compared and
        // set like the first try: written, already there, or superseded by
        // a newer one (another replica) — the step is done with either way.
        if (Date.now() - step.at <= LEASE_MAX_AGE_MS) await store().rotate(lease, name, { base: chain.base, next: step.next }, step.used, step.at);
        // That step, and only that one, is done with.
        const i = chain.steps.indexOf(step);
        if (i >= 0) chain.steps.splice(i, 1);
      }
      if (entry.held.get(name) === chain && !chain.steps.length) entry.held.delete(name);
    } catch {
      break; // the store is still refusing; the next try goes on from here
    }
  }
  if (!entry.held.size) unsaved.delete(key);
}

/** The background retry: every held rotation, until the store takes it or
 *  the lease's window is over. Backs off to a minute. */
let unsavedTimer: NodeJS.Timeout | null = null;
function retryUnsaved(attempt = 0): void {
  if (unsavedTimer) return;
  unsavedTimer = setTimeout(async () => {
    unsavedTimer = null;
    for (const key of [...unsaved.keys()]) await flushUnsaved(key, null).catch(() => undefined);
    if (unsaved.size) retryUnsaved(attempt + 1);
  }, Math.min(1_000 * 2 ** attempt, 60_000));
  unsavedTimer.unref();
}

/** This lease's rotations: the store's, with any this proxy still holds
 *  unwritten over them — written now if the store takes them. */
async function rotationsOf(lease: Lease): Promise<Record<string, Rotation>> {
  if (unsaved.has(lease.key)) await flushUnsaved(lease.key, lease);
  const held = unsaved.get(lease.key)?.held;
  const mine = held
    ? Object.fromEntries([...held].filter(([, c]) => c.steps.length).map(([n, c]) => [n, { base: c.base, next: c.steps[c.steps.length - 1]!.next }]))
    : {};
  return { ...(await store().rotations(lease)), ...mine };
}

/**
 * Write a rotated refresh token to the vault copy the grant came from,
 * compare-and-set against `from`. When the grant names its origin
 * (healthKeys), only that copy: core's replaceOAuth2RefreshToken falls back
 * to the account's copy when the workspace's does not match, and an account
 * secret holding the same value must never take a workspace's rotation. A
 * grant that does not say keeps that fallback, as before.
 */
function writeRefreshToken(lease: Lease, name: string, from: string, refresh: string): boolean {
  const named = lease.grant.healthKeys?.[name];
  const workspace = secretWorkspace(lease.grant, lease.who, name);
  if (named && workspace) {
    const cur = getSecret(lease.tenant, name, workspace);
    if (!cur || cur.scope !== "workspace" || cur.value !== from) return false;
  }
  return replaceOAuth2RefreshToken(lease.tenant, name, workspace, from, refresh);
}

/** The refresh token inside a stored oauth2 value, or null. */
function refreshTokenOf(value: string): string | null {
  if (!isOAuth2Value(value)) return null;
  try {
    const config = JSON.parse(value.slice(value.indexOf("{"))) as { refresh_token?: unknown };
    return typeof config.refresh_token === "string" ? config.refresh_token : null;
  } catch {
    return null;
  }
}

/**
 * The worker's half of a v2 lease's OAuth rotation: every refresh token the
 * proxy recorded as rotated is written to the vault copy it came from —
 * compare-and-set against what this lease started from (or last wrote), so
 * a credential a person reconnected meanwhile is never overwritten. Run on
 * every heartbeat and at release. Returns how many copies were written.
 */
function mergeRotations(entry: Issued): Promise<{ written: number; ok: boolean }> {
  // One at a time per lease: a heartbeat and the release merging at once
  // could both write over the same value and settle the older rotation.
  // And one worker at a time across workers: one that took an orphaned or
  // released lease on may be merging it while its first worker still is.
  const run = (entry.merging ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const unlock = await lockFor("merge", entry.lease.key);
    if (!unlock) return { written: 0, ok: false };
    try {
      return await mergeOnce(entry);
    } finally {
      await unlock();
    }
  });
  entry.merging = run;
  return run;
}

async function mergeOnce(entry: Issued): Promise<{ written: number; ok: boolean }> {
  const { lease } = entry;
  const rotations = await store().rotations(lease);
  let written = 0;
  let ok = true;
  for (const [name, r] of Object.entries(rotations)) {
    // Stale: the runner has re-granted this name since. (A released lease's
    // grant was emptied with it; its record is what is left to go by.)
    if (!entry.released && lease.grant.secrets[name]?.value !== r.base) continue;
    const workspace = secretWorkspace(lease.grant, lease.who, name);
    const write = (from: string, value: string): boolean => {
      const refresh = refreshTokenOf(value);
      return refresh ? writeRefreshToken(lease, name, from, refresh) : false;
    };
    // The vault moved off what this lease used: another lease holding the
    // same credential saved its own rotation (the two shared one exchange,
    // then went on separately). Written over only when ours descends from
    // the vault's value along the recorded chain — the provider made ours
    // from it, through however many refreshes. A person's reconnect is on
    // no chain of ours, and is never overwritten.
    const catchUp = async (next: string): Promise<boolean> => {
      const cur = getSecret(lease.tenant, name, workspace)?.value;
      if (!cur || cur === next) return false;
      return (await store().descends(lease, name, cur, next)) ? write(cur, next) : false;
    };
    const checkpoint = async (c: Saved & { synced?: boolean }): Promise<boolean> => {
      try {
        await store().markSaved(lease, name, { base: c.base, value: c.value, prev: c.prev, done: c.done });
        c.synced = true;
        return true;
      } catch {
        c.synced = false;
        ok = false;
        return false;
      }
    };
    try {
      // What the vault holds for this chain: what this worker (or, after a
      // restart, the one before it) last wrote, else the chain's start.
      const seen = entry.merged[name] ?? r.saved;
      let chain = seen && seen.base === r.base ? { ...seen } : undefined;
      if (chain && !chain.done) {
        // Checkpointed, maybe not written (a worker died between the two, or
        // the write threw). Finished the same way: over what it was written
        // over, or over an older rotation another lease saved meanwhile.
        if (write(chain.prev, chain.value) || (await catchUp(chain.value))) written++;
        chain.done = true;
        entry.merged[name] = chain;
        if (!(await checkpoint(chain))) continue;
      } else if (chain && entry.merged[name]?.synced === false && !(await checkpoint(entry.merged[name]!))) {
        continue;
      }
      const used = chain ? chain.value : r.base;
      if (used === r.next) continue;
      // The intent first: without it a worker after this one could not tell
      // which value the vault holds. No checkpoint, no write.
      chain = { base: r.base, value: r.next, prev: used, done: false };
      if (!(await checkpoint(chain))) continue;
      entry.merged[name] = chain;
      if (write(used, r.next) || (await catchUp(r.next))) written++;
      // Written, or the vault holds something newer than this rotation, or
      // what a person put there (a reconnect): either way it is settled.
      chain.done = true;
      await checkpoint(chain);
    } catch (err) {
      console.error(`[foldrun] egress: could not save the rotated refresh token of ${name} for ${lease.runId}: ${err instanceof Error ? err.message : err}`);
      ok = false; // the next heartbeat tries again
    }
  }
  return { written, ok };
}

/** How long a released lease's rotation record outlives it: longer than a
 *  token refresh already in flight can take (three tries, 15 s each). */
function rotationGraceMs(): number {
  const v = process.env.FOLDRUN_EGRESS_ROTATION_GRACE_MS;
  return v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : 120_000;
}

/** A released lease, once its grace is over: merge what is left, and when
 *  everything is saved, the record goes. True when it is settled. */
async function settleReleased(key: string, entry: Issued, now = Date.now()): Promise<boolean> {
  if (issued.get(key) !== entry || entry.released === undefined) return true;
  if (now - entry.released < rotationGraceMs()) return false;
  // One worker at a time: the one that released it and one that recovered
  // it after a restart elsewhere may both be trying.
  const unlock = await lockFor("settle", key);
  if (!unlock) return false;
  try {
    // The recovery record first, if the release could not write it: until
    // it is there, a restart of this worker would lose what is left.
    if (entry.recoveryKept === false) {
      entry.recoveryKept = await store().releaseKeeping(entry.lease, entry.released).then(() => true, () => false);
      if (!entry.recoveryKept) return false;
    }
    // Read before the merge: if a proxy writes a rotation after the merge
    // read the record, the records stay and this settles again later.
    const version = await store().rotationVersion(entry.lease).catch(() => null);
    if (version === null) return false;
    const m = await mergeRotations(entry).catch(() => null);
    if (!m?.ok || issued.get(key) !== entry) return false;
    if (!(await store().settle(entry.lease, version).catch(() => false))) return false;
    issued.delete(key);
    return true;
  } finally {
    await unlock();
  }
}

/** This process, to the settle lock. */
const instance = crypto.randomUUID();
const UNLOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

/** A worker-wide lock on one lease (settling it, or merging it), or null
 *  when another worker holds it. No Redis: this process is the only one. */
async function lockFor(kind: "settle" | "merge", key: string): Promise<(() => Promise<void>) | null> {
  if (!cacheEnabled() || inMemory.has(key)) return async () => undefined;
  const r = cache()!;
  const lock = `egress:${kind}:${key}`;
  const got = await r.set(lock, instance, "PX", 120_000, "NX").catch(() => null);
  if (got !== "OK") return null;
  return async () => {
    await r.eval(UNLOCK, 1, lock, instance).catch(() => undefined);
  };
}

/**
 * Released v2 leases whose rotations nobody has saved — the worker that
 * released them stopped during the grace, or before a failed merge could be
 * retried. Their recovery record (releaseKeeping) carries what it takes:
 * the run, the account, which vault copy each secret came from, and the
 * token wrapped for a worker. Taken on as released, so the next settle
 * saves them; the grace still counts from the original release.
 */
async function recoverReleased(now: number): Promise<void> {
  if (!cacheEnabled() || !(await redisReady())) return;
  const r = cache()!;
  for (const id of await r.smembers(RECOVERING)) {
    if (issued.has(id)) continue;
    const raw = await r.get(rrecover(id));
    if (!raw) {
      await r.srem(RECOVERING, id); // expired with nothing left to do
      continue;
    }
    try {
      const w = JSON.parse(raw) as { rec?: string; sig?: string };
      if (typeof w.rec !== "string" || typeof w.sig !== "string" || !verifyRecoveryRecord(w.rec, w.sig)) continue;
      const rec = JSON.parse(w.rec) as { kind?: string; id?: string; runId?: string; tenant?: string; releasedAt?: number; wrap?: string; healthKeys?: Record<string, string>; who?: LeaseWho };
      if (rec.kind !== "recover" || rec.id !== id || typeof rec.runId !== "string" || typeof rec.tenant !== "string" || typeof rec.wrap !== "string") continue;
      const token = unwrapTokenForWorker(rec.wrap, id);
      if (!token) continue;
      const lease: Lease = {
        token,
        key: id,
        v2: true,
        tenant: rec.tenant,
        runId: rec.runId,
        grant: { secrets: {}, healthKeys: rec.healthKeys ?? {} },
        createdAt: now,
        renewedAt: now,
        ...(rec.who ? { who: rec.who } : {}),
      };
      issued.set(id, { lease, merged: {}, released: typeof rec.releasedAt === "number" ? rec.releasedAt : 0 });
    } catch {
      continue;
    }
  }
}

/**
 * A worker that took a run over from one that stopped: the v2 leases still
 * live for the run, which the stopped worker wrote. Their record carries the
 * token wrapped under a key only a worker derives; with it, this worker can
 * open the rotation record and save what the proxy rotated meanwhile.
 */
async function recoverIssued(runId: string, now: number): Promise<void> {
  if (!cacheEnabled() || !(await redisReady())) return;
  for (const id of await cache()!.smembers(rrun(runId))) {
    if (!/^[0-9a-f]{64}$/.test(id) || issued.has(id)) continue;
    const lease = await liveLeaseOf(id);
    if (!lease) continue;
    lease.renewedAt = now;
    // This worker never holds its release: the recovery loop keeps merging
    // it after the run's heartbeats stop, until the lease is gone.
    issued.set(id, { lease, merged: {}, orphan: true });
  }
}

/** A live v2 lease by its id, opened through the token its record wraps for
 *  a worker; null when there is none, or it is not the worker's. */
async function liveLeaseOf(id: string): Promise<Lease | null> {
  const raw = await cache()!.get(rkey(id));
  if (!raw) return null;
  let token: string | null = null;
  try {
    const w = JSON.parse(raw) as { v?: number; rec?: string; sig?: string };
    if (w.v !== 2 || typeof w.rec !== "string" || typeof w.sig !== "string" || !verifyLeaseRecord(w.rec, w.sig)) return null;
    const rec = JSON.parse(w.rec) as { wrap?: unknown };
    if (typeof rec.wrap === "string") token = unwrapTokenForWorker(rec.wrap, id);
  } catch {
    return null;
  }
  return token ? ((await getV2(token)) ?? null) : null;
}

/** How long a run's driver may be silent before a live lease of it with
 *  rotations is taken on by whichever worker's recovery loop finds it. */
const orphanMs = () => {
  const v = process.env.FOLDRUN_EGRESS_ORPHAN_MS;
  return v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : 5 * 60_000;
};

/**
 * Live v2 leases whose worker stopped before releasing them, with rotations
 * nobody has saved: no heartbeat of their run for orphanMs. Found by their
 * rotation records; taken on so the recovery loop merges them until the
 * lease is gone. (A worker that resumes the run takes them on too; the merge
 * lock keeps the two apart.)
 */
async function recoverOrphans(now: number): Promise<void> {
  if (!cacheEnabled() || !(await redisReady())) return;
  const r = cache()!;
  let cursor = "0";
  do {
    const [next, keys] = await r.scan(cursor, "MATCH", "egress:rot:*", "COUNT", 200);
    cursor = next;
    for (const k of keys) {
      const id = k.slice("egress:rot:".length);
      if (!/^[0-9a-f]{64}$/.test(id) || issued.has(id)) continue;
      const lease = await liveLeaseOf(id);
      if (!lease) continue; // released (RECOVERING has it) or gone
      const beat = Number((await r.get(rbeat(lease.runId))) ?? 0);
      if (now - Math.max(beat, lease.createdAt) < orphanMs()) continue;
      lease.renewedAt = now;
      issued.set(id, { lease, merged: {}, orphan: true });
    }
  } while (cursor !== "0");
}

/**
 * The proxy's half: a refresh during `forward` came back with a new refresh
 * token. Recorded beside the lease, so every replica uses it from the next
 * request on. A v1 lease's proxy holds the account keys and also writes the
 * vault itself, as before v2 — to the scope the secret came from.
 */
async function keepRotation(lease: Lease, name: string, base: string | undefined, used: string, next: string): Promise<void> {
  // When the provider answered: what orders this rotation against another
  // lease's of the same credential, however late it is written.
  const at = Date.now();
  if (!lease.v2) {
    // v1: this proxy holds the account keys and writes the vault itself —
    // over what this refresh used, or, when an earlier write failed and the
    // vault still holds the chain's start, over that.
    const refresh = refreshTokenOf(next);
    try {
      if (refresh && !writeRefreshToken(lease, name, used, refresh) && base && base !== used) {
        writeRefreshToken(lease, name, base, refresh);
      }
    } catch (err) {
      console.error(`[foldrun] egress: could not save the rotated refresh token of ${name}: ${err instanceof Error ? err.message : err}`);
    }
  }
  // `base` is the grant's value when the refresh began, never as it is now:
  // a re-grant meanwhile (a person reconnected) starts a chain this refresh
  // is not part of.
  if (!base) return;
  // And a refresh that finished after such a re-grant must not overwrite
  // the new chain's record: the lease as it is now decides.
  const now = await store().get(lease.token).catch(() => lease);
  if (now && now.grant.secrets[name]?.value !== base) return;
  try {
    // Only over the record this refresh started from: two requests sharing
    // one exchange both land here, and the later callback must not put its
    // (older) token over one a refresh after it recorded.
    await store().rotate(lease, name, { base, next }, used, at);
  } catch (err) {
    // The provider has already revoked the old one: hold the new one here,
    // use it, and write it as soon as the store takes it — on the lease's
    // next request through this proxy, or by the background retry.
    console.error(`[foldrun] egress: could not record the rotated refresh token of ${name} yet: ${err instanceof Error ? err.message : err}`);
    const entry = unsaved.get(lease.key) ?? { lease, held: new Map<string, { base: string; steps: HeldStep[] }>() };
    const prev = entry.held.get(name);
    if (prev && prev.base === base) {
      const last = prev.steps[prev.steps.length - 1];
      // Held already, or a delayed callback from a value the held chain has
      // already moved past (A→B arriving after B→C was held): left out.
      const known = prev.steps.some((st) => st.next === next) || (last && used !== last.next && prev.steps.some((st) => st.used === used || st.next === used));
      if (!known) prev.steps.push({ used, next, at });
    } else {
      entry.held.set(name, { base, steps: [{ used, next, at }] });
    }
    unsaved.set(lease.key, entry);
    if (unsaved.size > 1000) unsaved.delete(unsaved.keys().next().value!);
    retryUnsaved();
  }
}

/**
 * Released leases settle without anyone's heartbeat: every minute (and at
 * once) this worker takes on those a stopped worker left (recoverReleased)
 * and settles every released one whose grace is over. A worker with no run
 * to drive still does it. Returns a stop function.
 */
export function startEgressRotationRecovery(everyMs = 60_000): () => void {
  let busy = false;
  const tick = async () => {
    // Not gated on FOLDRUN_EGRESS_LEASE_V2: that switch decides what NEW
    // leases look like. v2 leases and recovery records already in Redis are
    // still settled after it is turned off, or their rotated refresh tokens
    // would expire there without reaching the vault.
    if (busy) return;
    busy = true;
    try {
      const now = Date.now();
      await recoverReleased(now).catch(() => undefined);
      await recoverOrphans(now).catch(() => undefined);
      for (const [key, entry] of issued) {
        if (entry.released !== undefined) await settleReleased(key, entry, now).catch(() => false);
        else if (entry.orphan) {
          // Merged while it lives; once the lease is gone (released by a
          // worker that resumed the run, or expired), so is this.
          if (!(await cache()?.exists(rkey(key)).catch(() => 1))) {
            issued.delete(key);
            continue;
          }
          entry.lease.renewedAt = now;
          await mergeRotations(entry).catch(() => undefined);
        }
      }
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * The driver's heartbeat, for the leases of one run: every lease the run
 * holds gets the full window again. Called by the worker beside the claim
 * heartbeat (queue.ts), so a lease lives exactly as long as its driver
 * does, however long the step runs. Returns how many were renewed.
 */
export async function renewEgressLeases(runId: string, now = Date.now()): Promise<number> {
  const n = await store().touchRun(runId, now);
  // Whatever the switch says now (see startEgressRotationRecovery).
  await recoverIssued(runId, now).catch(() => undefined);
  await recoverReleased(now).catch(() => undefined);
  // And the refresh tokens the proxy rotated since the last beat go to the
  // vault, so a step that runs for hours does not leave the next run with
  // one the provider revoked hours ago.
  for (const [key, entry] of issued) {
    // One this worker never released (its step died mid-flight) is forgotten
    // after the lease's own window; Redis has expired the lease by then.
    if (now - entry.lease.renewedAt > LEASE_MAX_AGE_MS) {
      issued.delete(key);
      continue;
    }
    if (entry.released !== undefined) {
      // Released: once the grace is over and everything is saved, the
      // record goes too; until then each heartbeat tries again.
      await settleReleased(key, entry, now);
      continue;
    }
    if (entry.lease.runId !== runId) continue;
    entry.lease.renewedAt = now;
    await mergeRotations(entry).catch((err) => console.error(`[foldrun] egress: rotated refresh tokens for ${runId} not saved yet: ${err instanceof Error ? err.message : err}`));
  }
  return n;
}

/** Memory-store leases whose driver stopped renewing. Redis expires its
 *  own; only the memory store needs a broom. Exported for the test. */
export function sweepLeases(now = Date.now()): number {
  let swept = 0;
  pruneMemoryRotated(now);
  for (const [key, l] of memoryLeases) {
    if (now - l.renewedAt > LEASE_MAX_AGE_MS) {
      void memoryStore.del(key);
      inMemory.delete(key);
      swept++;
    }
  }
  // A worker's own record of a lease it never released (it was swept, or
  // expired in Redis) goes with it after the same window.
  for (const [key, e] of issued) if (now - e.lease.renewedAt > LEASE_MAX_AGE_MS && !memoryLeases.has(key)) issued.delete(key);
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
  await store().append(lease.key, { kind: "line", text: `identity: ${id.name} — a token for ${granted.audience}, valid until ${new Date(minted.expiresAt).toISOString()}` }).catch(() => undefined);
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
    await store().append(lease.key, { kind: "line", text: `delegate: a job for ${agent} (${d.id})` }).catch(() => undefined);
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
    await store().append(lease.key, { kind: "line", text: `egress: ${req.method} ${host} refused — not a host this step's secrets were granted to` });
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
  // Each secret's grant value as this request found it: what a rotation
  // during its refresh belongs to, whatever the grant says by then.
  const bases: Record<string, string> = { ...raw };
  // A refresh token rotated on any replica since the grant was written:
  // the newest one, which is the only one the provider still honours.
  if (Object.values(raw).some(isOAuth2Value)) {
    try {
      for (const [name, r] of Object.entries(await rotationsOf(lease))) {
        if (raw[name] === r.base && isOAuth2Value(r.next)) raw[name] = r.next;
      }
      // And one another lease of the same credential rotated, which the
      // worker has not saved yet (this lease's grant was read from the vault
      // before it did): followed to the newest.
      for (const name of Object.keys(raw)) {
        if (!isOAuth2Value(raw[name]!)) continue;
        // To the end of the chain, however long: stopping short would send a
        // token the provider has revoked. A value seen twice is a loop
        // someone wrote, and ends it.
        const seen = new Set<string>([raw[name]!]);
        for (;;) {
          const next = await store().successor(lease, name, raw[name]!);
          if (!next || !isOAuth2Value(next) || seen.has(next)) break;
          seen.add(next);
          raw[name] = next;
        }
      }
    } catch (err) {
      if (err instanceof LeaseStoreUnavailable) return deny(503, err.message);
      throw err;
    }
  }
  const live: Record<string, string> = {};
  try {
    // One secret at a time, each with the vault scope it came from: a
    // workspace's oauth2 secret's health and rotated refresh token belong
    // to that workspace's copy, not the account's.
    for (const [name, value] of Object.entries(raw)) {
      const ctx = {
        tenant: lease.tenant,
        workspace: secretWorkspace(lease.grant, lease.who, name),
        onRotate: (n: string, used: string, next: string) => keepRotation(lease, n, bases[n], used, next),
      };
      Object.assign(live, await materializeSecrets({ [name]: value }, ctx));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await store().append(lease.key, { kind: "line", text: `egress: ${req.method} ${host} — ${message}` });
    return deny(502, `egress: ${message}`);
  }

  const used = new Set<string>();
  const url = fillForHost(placeholdersInUrl(parsed.target, host, lease.grant), host, live, lease.grant);
  // The host was checked before the fill. A placeholder in the authority
  // (`https://${KEY}.example.com/` under a `*.example.com` binding) puts the
  // secret in DNS and SNI, and a value holding `/ ? # @ :` would change
  // which host is contacted. The filled URL must name the host that was
  // checked, and a secret never rides in the authority.
  if (url.used.length) {
    // Compared with the target as it was sent, not `host`: an intercepted
    // tunnel names a bare host while the URL carries its port.
    let filledHost: string | null = null;
    let sentHost: string | null = null;
    try {
      filledHost = hostOf(url.text);
      sentHost = hostOf(parsed.target);
    } catch {
      filledHost = null;
    }
    const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url.text)?.[1] ?? "";
    const rawAuthority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(parsed.target)?.[1] ?? "";
    if (filledHost === null || filledHost !== sentHost || authority !== rawAuthority) {
      await store().append(lease.key, { kind: "line", text: `egress: ${req.method} ${host} — refused: a secret may not be placed in the host part of a URL` });
      return deny(403, "egress: a secret may not be placed in the host part of a URL");
    }
  }
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
    await store().append(lease.key, { kind: "effect", text: verdict.text, effect: verdict.effect });
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
    await store().append(lease.key, { kind: "line", text: `egress: ${host} — client certificate ${picked.name} presented` });
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
      await store().append(lease.key, { kind: "line", text: `egress: ${method} ${host} refused — ${message}` });
      return deny(403, `egress: ${message}`);
    }
    // undici says "fetch failed" and puts the reason in `cause` (a refused
    // connection, a TLS alert, a bad client key): the trace names it.
    const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
    const why = cause ? [cause.code, cause.message].filter(Boolean).join(" ") : "";
    const message = `${err instanceof Error ? err.message : String(err)}${why ? ` (${why})` : ""}`;
    await store().append(lease.key, { kind: "line", text: `egress: ${method} ${host} → unreachable: ${message}` });
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
  await store().append(lease.key, { kind: "call", key: `${method} ${host}${path} → ${upstream.status}`, ms: Date.now() - started, secrets: [...used] });
  // A refusal, said in words while the evidence still exists. The proxy is
  // the only party that ever sees this response's headers — the pod gets a
  // status and a sentence written by the SDK, and the hour this cost once
  // was spent guessing between a dead key and a spent window. Nothing but
  // core's allow-list is read, and no clause about a second supply is added
  // here: the proxy sees a response, not a flow, and the runner appends
  // that part when it finalises the step (including "no second supply is
  // configured", which is now the ordinary state).
  if (isRefusalStatus(upstream.status)) {
    await store().append(lease.key, {
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
    await store().append(lease.key, { kind: "line", text: `${message} Refused.` });
    return { ok: false, message };
  }
  const seen = reported.get(lease.token) ?? new Set<string>();
  if (!seen.has(host)) {
    seen.add(host);
    reported.set(lease.token, seen);
    await store().append(lease.key, { kind: "line", text: `network: ${host} would be refused (network: ${policy.level}) — allowed, because nothing here asks to refuse yet. Add it to the agent's network: list to keep it reachable; network_enforce: true in AGENTS.md refuses it.` });
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
    await store().append(lease.key, { kind: "line", text: `egress: CONNECT ${target.host}:${target.port} refused — a private or internal address` });
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
    void store().append(lease.key, { kind: "line", text: `egress: CONNECT ${target.host}:${target.port} ${inward ? "refused" : "unreachable"} — ${err.message}` });
    refuseConnect(socket, inward ? 403 : 502, `egress: ${inward ? "" : "could not reach "}${target.host}:${target.port} — ${err.message}`);
  });
  socket.on("close", () => upstream.destroy());
  upstream.on("close", () => {
    socket.destroy();
    if (opened) void store().append(lease.key, { kind: "call", key: `CONNECT ${target.host}:${target.port}`, ms: Date.now() - started, secrets: [] });
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
