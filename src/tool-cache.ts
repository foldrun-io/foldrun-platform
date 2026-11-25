// A short cache in front of web_search's rungs (FOL-321, owner 25 Nov 2026:
// "do cache"). The same search asked again within minutes, by the same
// account, is answered from Redis instead of SearXNG or SerpApi — each
// SerpApi search is a paid call, which is the cache's whole saving.
//
// What it may and may not do:
//
//   - Per account. The key holds the tenant, so one account's hit never
//     answers another's call: a fast answer would tell a caller that some
//     other customer had searched those words.
//   - Only answers. An error is never stored.
//   - Everything that changes which rung answers or what it is asked is in
//     the key: the words, the domain lists as given, the location. The tool
//     loop filters results by the caller's domain rules again on a hit.
//   - Nothing that looks like a credential: an answer is neither kept nor
//     handed to another waiting caller when a result link, title, snippet or
//     page_age has a secret-looking parameter, a user part, or text the scan
//     cannot read through (secretIn). A false yes only costs a miss.
//   - Rebuildable only (cache.ts): Redis down, slow or full means no cache,
//     never a failed call. Each Redis command has its own short deadline, and
//     the cache spends only part of Redis (the budget below).
//   - Identical searches in flight on one process share one upstream call.
//
// A hit comes back with `via: "cache"`; it still counts as a call to the
// tool (max_uses, the ops log). The price book (FOL-283) decides what a hit
// costs.
//
// web_fetch is NOT cached (25 Nov 2026). A fetched page is whatever a site
// returned — sometimes one visitor's (a JSON body with an access_token, a
// page with a short freshness) — and a fetch costs no vendor money. 18 Codex
// rounds on a fetch cache kept finding such pages; it was taken out of this
// change. Its open points are on FOL-321.
//
//   FOLDRUN_TOOL_CACHE_SEARCH_S   seconds a search answer is kept, default 600, 0 = off

import { createHash } from "node:crypto";
import { cache } from "./cache.ts";
import { opsError } from "../../foldrun-core/src/ops-log.ts";
import { redactText } from "../../foldrun-core/src/scan.ts";
import { credentialsIn } from "./server-tools.ts";
import type { SearchResult, ToolRunners } from "./server-tools.ts";

type Json = Record<string, unknown>;

/** Where answers are kept. Redis in the service; a Map in tests. */
export interface ToolCacheStore {
  get(key: string): Promise<string | null>;
  /** Kept until `expireAtMs` (epoch ms, Redis PXAT): a write that lands
   *  late cannot outlive the deadline it was given. */
  set(key: string, value: string, expireAtMs: number): Promise<void>;
}

/** A stored answer bigger than this is not kept. */
const MAX_VALUE_BYTES = 256 * 1024;
const REDIS_DEADLINE_MS = 150;
/** Commands sent and not yet answered (a timed-out one is not cancelled by
 *  ioredis). Past this the cache is skipped, so a Redis that holds the
 *  socket open and stops answering cannot pile answers up in memory. */
const MAX_PENDING = 64;
let pending = 0;

// ------------------------------------------------------------- the budget
//
// The cache shares its Redis with the worker, scheduler and egress leases,
// and that Redis refuses writes when full (noeviction, foldrun-infra
// manifests/base/datastores.yaml: an evicted lease is a lost lock). So the
// cache spends only part of it: every few seconds one INFO memory says how
// full Redis is, and between two readings this process writes at most a
// sixteenth of the room left under the cache's cap (roomInRedis), counting
// each entry's overhead, so every gateway copy bursting at once still
// cannot fill the room the leases need.

const SAMPLE_MS = 5_000;
const WINDOW_BYTES = 8 * 1024 * 1024;
const budget = { checkedAt: 0, room: 0, written: 0, checking: null as Promise<void> | null };

/** From INFO memory: how many bytes this process may write before the next
 *  reading. The room is the cap (FOLDRUN_TOOL_CACHE_REDIS_SHARE of maxmemory,
 *  default 0.5; with no maxmemory, FOLDRUN_TOOL_CACHE_REDIS_MB, default 128)
 *  less what Redis holds; each process takes a sixteenth of it (the gateway
 *  runs at most ten copies), never more than WINDOW_BYTES. 0: no writes.
 *  Exported for tests. */
export function roomInRedis(info: string, env: NodeJS.ProcessEnv = process.env): number {
  const num = (name: string) => {
    const m = new RegExp(`^${name}:(\\d+)`, "m").exec(info);
    return m ? Number(m[1]) : undefined;
  };
  const used = num("used_memory");
  if (used === undefined) return 0;
  const max = num("maxmemory") ?? 0;
  const shareRaw = Number(env.FOLDRUN_TOOL_CACHE_REDIS_SHARE ?? "0.5");
  const share = shareRaw > 0 && shareRaw <= 0.9 ? shareRaw : 0.5;
  const mbRaw = Number(env.FOLDRUN_TOOL_CACHE_REDIS_MB ?? "128");
  const cap = max > 0 ? max * share : (mbRaw > 0 ? mbRaw : 128) * 1024 * 1024;
  return Math.max(0, Math.min(WINDOW_BYTES, Math.floor((cap - used) / 16)));
}

/** What one entry costs Redis beyond its value: key, expiry, allocator. */
const ENTRY_OVERHEAD = 256;

async function mayWrite(bytes: number): Promise<boolean> {
  const c = cache();
  if (!c || c.status !== "ready") return false;
  const now = Date.now();
  if (now - budget.checkedAt >= SAMPLE_MS && !budget.checking) {
    budget.checking = (async () => {
      try {
        const info = await withDeadline(track(c.info("memory")), REDIS_DEADLINE_MS);
        budget.room = roomInRedis(info);
      } catch (err) {
        budget.room = 0;
        redisFailed("set", err);
      } finally {
        budget.checkedAt = Date.now();
        budget.written = 0;
        budget.checking = null;
      }
    })();
  }
  if (budget.checking) await budget.checking;
  const cost = bytes + ENTRY_OVERHEAD;
  if (budget.written + cost > budget.room) return false;
  budget.written += cost;
  return true;
}
function track<T>(p: Promise<T>): Promise<T> {
  pending++;
  return p.finally(() => {
    pending--;
  });
}

/** Seconds from a setting: a whole number 0–86 400, else the default. */
export function ttlSetting(raw: string | undefined, fallback: number): number {
  if (raw === undefined || !/^\d{1,5}$/.test(raw.trim())) return fallback;
  const n = Number(raw.trim());
  return n <= 86_400 ? n : fallback;
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_r, rej) => {
    timer = setTimeout(() => rej(new Error("tool cache: redis deadline")), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

// One line per process and direction, not one per call, while Redis is
// away; only a success in the same direction rearms it (a Redis that reads
// but refuses writes at its memory limit logs once).
const warned = { get: false, set: false };
function redisFailed(op: "get" | "set", err: unknown): void {
  if (warned[op]) return;
  warned[op] = true;
  const e = err instanceof Error ? err : new Error(String(err));
  if (op === "get") opsError("tool_cache.redis_get_failed", e);
  else opsError("tool_cache.redis_set_failed", e);
}

/** The service's store: Redis, each command under a short deadline. */
export const redisStore: ToolCacheStore = {
  async get(key) {
    const c = cache();
    if (!c || c.status !== "ready" || pending >= MAX_PENDING) return null;
    try {
      const v = await withDeadline(track(c.get(key)), REDIS_DEADLINE_MS);
      warned.get = false;
      return v;
    } catch (err) {
      redisFailed("get", err);
      return null;
    }
  },
  async set(key, value, expireAtMs) {
    const c = cache();
    if (!c || c.status !== "ready" || pending >= MAX_PENDING) return;
    // The slot is held from here, through the budget's wait, until Redis
    // answers the SET (or no SET is sent).
    pending++;
    let sent: Promise<unknown> | null = null;
    try {
      if (!(await mayWrite(Buffer.byteLength(value)))) return;
      sent = c.set(key, value, "PXAT", expireAtMs);
      await withDeadline(sent, REDIS_DEADLINE_MS);
      warned.set = false;
    } catch (err) {
      redisFailed("set", err);
    } finally {
      if (sent) void sent.catch(() => {}).finally(() => { pending--; });
      else pending--;
    }
  },
};

const hash = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

/** The key a search is kept under: everything that can change which rung
 *  answers or what it is asked. The domain lists are kept as given (order
 *  and spelling: SerpApi is sent the first eight as written), and a
 *  location is part of it even without a country (any location skips the
 *  account's own engine). `rungs` names the ladder's setting (which engines
 *  it may use), so a rollout that turns one off never serves its answers. */
export function searchKey(tenant: string, q: { query: string; allowed_domains?: string[]; blocked_domains?: string[]; user_location?: Json }, rungs = ""): string {
  const loc = q.user_location ? Object.fromEntries(Object.entries(q.user_location).sort(([a], [b]) => (a < b ? -1 : 1))) : null;
  return `tc:v1:s:${hash([tenant, q.query, q.allowed_domains ?? null, q.blocked_domains ?? null, loc, rungs])}`;
}

type SearchAnswer = { results: SearchResult[]; via: string };
/** A stored record also says when it was written (epoch ms), so a lowered
 *  TTL applies at once to what is already in Redis. */
type Stored = { storedAt: number };
const fresh = (x: unknown, ttlSec: number) => {
  const at = (x as Partial<Stored> | null)?.storedAt;
  return typeof at === "number" && Date.now() - at <= ttlSec * 1000 && at <= Date.now() + 1000;
};
const str = (x: unknown): x is string => typeof x === "string";
/** A URL that carries a credential, or one whose user part cannot even be
 *  read (credentialsIn throws on bad percent-encoding): not kept. */
function parsedCredential(u: string): boolean {
  try {
    return credentialsIn(u).length > 0;
  } catch {
    return true;
  }
}
/** URL fields get the whole text check (escaped names, the fragment, a
 *  signed link carried %-encoded inside a parameter). */
const hasCredential = (urls: string[]) => urls.some((u) => parsedCredential(u) || secretIn(u));

/** Text that may carry a credential. Judged three ways, any one enough
 *  (a false yes only costs a cache miss):
 *   - a parameter whose name holds token, secret, sig, key, auth, session,
 *     password or credential (`refresh_token=`, `X-Amz-Signature=`, a
 *     fragment's `#access_token=` — wider than credentialsIn's list), or an
 *     OAuth callback's `code=` / `state=` (and `ticket=`, `nonce=`, `otp=`), after
 *     `?`, `&`, `;` or `#`, as written or with %-escapes undone;
 *   - `Bearer <token>` / `Basic <token>` or a JWT-shaped string, or a
 *     credential written as a field (`"access_token": "…"`), as written or
 *     decoded;
 *   - any `scheme://…@` (a user part, with or without a password);
 *   - credentialsIn over every link the text holds, read to the next space. */
const SECRET_PARAM_IN_TEXT = /[?&;#](?:[^=&#;\s]{0,40}?(?:token|secret|sig|key|auth|session|password|passwd|pwd|credential|jwt)[^=&#;\s]{0,40}|code|state|ticket|nonce|otp)=/i;
/** A bearer credential written out: `Bearer <token>`, or anything shaped
 *  like a JWT (`eyJ….…`). */
const BEARER_IN_TEXT = /\b(?:bearer|basic)\s+[a-z0-9._~+/=-]{8,}|\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{4,}/i;
/** A credential written as a field: `"access_token": "…"`, `api_key=…`,
 *  `client_secret: …` (JSON, config, env text in a snippet). */
const FIELD_IN_TEXT = /["']?[a-z0-9_-]{0,30}?(?:token|secret|password|passwd|api[_-]?key|private[_-]?key|credential)["']?\s*[:=]\s*["']?[^\s"',}]{6,}/i;
/** %-escapes undone (backslash escapes never get here: ESCAPED). */
function unescapeLoosely(text: string): string {
  return text.replace(/%([0-9a-f]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
}
// Not the apostrophe: it is valid in a URL's user part.
const LINK_END = /[\s"<>]/;
/** One pass over the text (no backtracking regex): every `//`, its link read to the next space or quote, and
 *  the scan goes on after that link. A link holding a second `://` (a link
 *  inside a link) counts as a secret rather than being taken apart. */
function linkSecret(text: string): boolean {
  // Every `//`, so a scheme-relative link (`//user:pw@host`) is read too.
  let i = text.indexOf("//");
  while (i >= 0) {
    let start = text[i - 1] === ":" ? i - 1 : i;
    const colon = start;
    while (start > 0 && colon - start < 32 && /[a-z0-9+.-]/i.test(text[start - 1]!)) start--;
    let end = i + 2;
    while (end < text.length && !LINK_END.test(text[end]!)) end++;
    const next = text.indexOf("//", i + 2);
    if (next >= 0 && next < end) return true;
    const authority = text.slice(i + 2, end).split(/[/?#]/, 1)[0]!;
    if (authority.includes("@")) return true;
    if (start < colon && parsedCredential(text.slice(start, end))) return true;
    i = next;
  }
  return false;
}

/** Escapes the scan cannot read through reliably (`\u0026` for `&`, `\/`
 *  for `/`, …): such text is treated as holding a secret — not kept, not
 *  shared — rather than decoded. */
const ESCAPED = /\\(?:u[0-9a-f]{4}|\/|x[0-9a-f]{2})/i;

/** A credential that needs no context: a private key block, or a token in
 *  a provider's own published shape (OpenAI/Anthropic `sk-`, GitHub `ghp_`
 *  and kin, Slack `xox?-`, AWS `AKIA`, Google `AIza`, Stripe `sk_live_`). */
const STANDALONE_SECRET = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[a-z0-9_-]{16,}|\bgh[pousr]_[a-z0-9]{20,}|\bxox[abposr]-[a-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9a-z_-]{30,}|\b[rs]k_(?:live|test)_[a-z0-9]{10,}/i;
/** A password-like field with any quoted value, however short. */
const QUOTED_PASSWORD = /["'](?:password|passwd|pwd|passphrase|pin|secret)["']\s*:\s*["'][^"']+["']/i;
/** The shapes `foldrun check` knows (core scan.ts, ~30 issuers, foldrun's own
 *  keys included): redactText changes text only when it finds one, so the
 *  cache and the scanner never disagree about what a credential looks like. */
const knownShape = (t: string) => redactText(t) !== t;
const plainSecret = (t: string) => ESCAPED.test(t) || BEARER_IN_TEXT.test(t) || FIELD_IN_TEXT.test(t) || QUOTED_PASSWORD.test(t) || STANDALONE_SECRET.test(t) || knownShape(t);

function secretIn(text: string): boolean {
  if (plainSecret(text)) return true;
  if (SECRET_PARAM_IN_TEXT.test(text)) return true;
  const plain = unescapeLoosely(text);
  // Still %-escaped after one pass (a link inside a link inside a link):
  // not read deeper, treated as holding a secret.
  if (plain !== text && /%[0-9a-f]{2}/i.test(plain)) return true;
  if (plain !== text && (SECRET_PARAM_IN_TEXT.test(plain) || plainSecret(plain))) return true;
  return linkSecret(text) || (plain !== text && linkSecret(plain));
}

/** A stored search, as the tool loop reads it — anything else is a miss. */
function validSearch(x: unknown): x is SearchAnswer {
  const a = x as SearchAnswer | null;
  return !!a && Array.isArray(a.results) && a.results.every((r) => !!r && typeof r === "object" && str(r.url) && str(r.title) && str(r.snippet) && (r.page_age === null || r.page_age === undefined || str(r.page_age)));
}

/**
 * `runners` with the search cache in front. `tenant` is the account the
 * call is for; nothing is shared between two tenants. fetchPage and
 * browse go straight to the rung.
 */
export function withToolCache(
  tenant: string,
  runners: ToolRunners,
  deps: { store?: ToolCacheStore; env?: NodeJS.ProcessEnv; rungs?: string } = {},
): ToolRunners {
  const env = deps.env ?? process.env;
  const rungs = deps.rungs ?? "";
  const store = deps.store ?? redisStore;
  const searchTtl = ttlSetting(env.FOLDRUN_TOOL_CACHE_SEARCH_S, 600);

  const read = async (key: string): Promise<unknown> => {
    const raw = await store.get(key).catch(() => null);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
  /** The record as stored, or null when it is too big to keep (then it is
   *  not shared either). A cheap byte count first bounds the work. */
  const record = (value: unknown, approxBytes: number): string | null => {
    if (approxBytes > MAX_VALUE_BYTES) return null;
    const raw = JSON.stringify(value);
    return Buffer.byteLength(raw) > MAX_VALUE_BYTES ? null : raw;
  };
  /** `at`: when the answer came back — the deadline runs from then, not
   *  from after the checks, and a write already past it is skipped. */
  const write = (key: string, raw: string, ttl: number, at: number): void => {
    const expireAt = at + ttl * 1000;
    if (expireAt <= Date.now()) return;
    const held = settling.size < SETTLING_MAX ? { raw, until: expireAt } : null;
    if (held) settling.set(key, held);
    // Not awaited: the caller has its answer; a slow write must not hold it.
    void store.set(key, raw, expireAt).catch(() => {}).finally(() => {
      if (held && settling.get(key) === held) settling.delete(key);
    });
  };

  return {
    async search(q, ctx) {
      if (searchTtl === 0) return runners.search(q, ctx);
      const key = searchKey(tenant, q, rungs);
      // One per key at a time, the lookup included: a caller that arrives
      // while the first one reads Redis or asks the engine joins it.
      let mine = false;
      const got = await shared<Awaited<ReturnType<ToolRunners["search"]>> & { own?: boolean; share?: boolean }>(key, async () => {
        mine = true;
        const held = settling.get(key);
        const hit = held && held.until > Date.now() ? JSON.parse(held.raw) : await read(key);
        if (validSearch(hit) && fresh(hit, searchTtl)) return { results: hit.results, via: "cache" };
        if (ctx.signal?.aborted) return { error: "unavailable" as const };
        let r: Awaited<ReturnType<ToolRunners["search"]>>;
        try {
          r = await runners.search(q, ctx);
        } catch {
          // A rung that threw (a malformed provider answer) is not the
          // leader leaving: share "unavailable" so the waiters do not each
          // pay for the same broken call.
          return ctx.signal?.aborted ? { error: "unavailable" as const } : { error: "unavailable" as const, share: true };
        }
        const at = Date.now();
        if ("error" in r) return ctx.signal?.aborted ? r : { ...r, share: true };
        // Too big to keep: not scanned, not shared.
        const raw = record({ results: r.results, via: r.via, storedAt: at }, r.results.reduce((n, x) => n + Buffer.byteLength(x.url) + Buffer.byteLength(x.title) + Buffer.byteLength(x.snippet) + Buffer.byteLength(x.page_age ?? ""), 0));
        if (raw === null) return { ...r, own: true };
        // An answer holding a secret is the leader's alone: not kept, and
        // not handed to the waiters.
        if (hasCredential(r.results.map((x) => x.url)) || r.results.some((x) => secretIn(`${x.title} ${x.snippet} ${x.page_age ?? ""}`))) return { ...r, own: true };
        write(key, raw, searchTtl, at);
        return r;
      }, ctx.signal, { error: "unavailable" as const });
      if (ctx.signal?.aborted) return { error: "unavailable" };
      if ("error" in got) return { error: got.error };
      if (got.own && !mine) return runners.search(q, ctx);
      // A waiter served by the leader's call made no call of its own.
      return { results: got.results, via: mine ? got.via : "cache" };
    },

    fetchPage(url, opts) {
      return runners.fetchPage(url, opts);
    },

    // web_browse is never cached: each browse is a new call on a live page.
    ...(runners.browse ? { browse: runners.browse.bind(runners) } : {}),
  };
}

// ------------------------------------------------------------- in flight
//
// One upstream call per key per process at a time. A joiner waits for the
// leader's call (which has the rung's own deadline) or its own signal,
// whichever comes first: an aborted joiner stops waiting and gets `gone`,
// and the leader is not stopped for it. An answer the leader keeps to itself
// (`own`) sends the joiner to ask on its own; so does a failure that was the
// leader's own doing (its abort).

const inFlight = new Map<string, Promise<unknown>>();

/** Answers whose Redis write has not settled yet (the budget may be waiting
 *  on INFO): a search asked in that gap is answered from here, not sent to
 *  SerpApi again. Bounded; cleared as each write settles. */
const settling = new Map<string, { raw: string; until: number }>();
const SETTLING_MAX = 256;

async function shared<T>(key: string, run: () => Promise<T>, signal: AbortSignal | undefined, gone: T): Promise<T> {
  if (signal?.aborted) return gone;
  const ahead = inFlight.get(key) as Promise<T> | undefined;
  if (ahead) {
    const got = await untilAborted(ahead.catch(() => null), signal);
    if (got === ABORTED || signal?.aborted) return gone;
    if (got && !isFailure(got) && !(got as { own?: boolean }).own) return got;
    // A failure the leader marked as not its own (a timeout, a 429, an
    // engine that is down — not its abort) is shared: a waiter that already
    // waited out the rung's deadline does not start another, and a provider
    // that said "too many" is not asked again by every waiter at once. It is
    // never stored.
    if (got && (got as { share?: boolean }).share) return got;
    // An answer the leader kept to itself: each waiter asks on its own.
    if (got && (got as { own?: boolean }).own) return run();
    // The leader left (its abort): the waiters elect a new one among them.
    return shared(key, run, signal, gone);
  }
  const p = run();
  inFlight.set(key, p);
  try {
    return await p;
  } finally {
    if (inFlight.get(key) === p) inFlight.delete(key);
  }
}

const ABORTED = Symbol("aborted");
function untilAborted<T>(p: Promise<T>, signal?: AbortSignal): Promise<T | typeof ABORTED> {
  if (!signal) return p;
  return new Promise((resolve) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then((v) => {
      signal.removeEventListener("abort", onAbort);
      resolve(v);
    });
  });
}

function isFailure(x: unknown): boolean {
  return typeof x === "object" && x !== null && "error" in x;
}

/** For tests: forget what is in flight. */
export function resetToolCacheForTests(): void {
  inFlight.clear();
  settling.clear();
  pending = 0;
  budget.checkedAt = 0;
  budget.room = 0;
  budget.written = 0;
  budget.checking = null;
  warned.get = false;
  warned.set = false;
}
