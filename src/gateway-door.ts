// The gateway door (10 Nov 2026): the platform's Anthropic key for a coding
// agent. Claude Code, and any tool that takes an Anthropic base URL and key,
// sends its calls here with a `gateway` API key; the door checks and meters
// each one exactly as it meters a run's (model-gateway.ts admitCall) and sends
// it on with the platform's key, which only this process opens.
//
//   ANTHROPIC_BASE_URL=https://<gateway host>   ANTHROPIC_API_KEY=fr_gw_…
//
// A listener of its own (FOLDRUN_GATEWAY_PORT, 8091), not the lease-based
// egress port: that one stays inside the cluster, this is the only door
// infra exposes. It serves five routes and nothing else —
//   POST /v1/messages              metered
//   POST /v1/messages/count_tokens free
//   GET  /v1/models                free
//   GET  /v1/usage                 free: the key's own spend and limits
//                                  (`?format=line` for Claude Code's status line)
//   POST /v1/foldrun/transcribe    a recording to text on foldrun's own
//                                  Whisper pods (`/talk`, transcribe.ts)
// — Anthropic models only; the key's own limits sit on top of the account's
// balance and daily supply limit. Spend is booked against the job
// `gateway:<key id>`, kind "coding", so a key's usage is its own.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { opsError } from "../../foldrun-core/src/ops-log.ts";
import { databaseEnabled } from "./db.ts";
import { API_KEY_CHANNEL, findApiKeyByHashDb, touchApiKeyDb, type GatewayGrant } from "./api-keys-db.ts";
import { listen } from "./pg-listen.ts";
import { SUPPLY_PROVIDERS, type SupplyProviderName } from "../../foldrun-core/src/model-supply.ts";
import { providerPreset } from "../../foldrun-core/src/providers.ts";
import { ToolCallExtras, toResponses, toChatCompletions, fromResponses, fromChatCompletion, StreamTranslator, ResponsesStreamTranslator } from "../../foldrun-core/src/translator.ts";
import { dayOf, spentByJob } from "./model-usage.ts";
import { accountStands, admitCall, chargeMargin, supplyHostOf, supplyKeyOf, supplySchemeOk, UsageReader, type MeteredCall } from "./model-gateway.ts";
import { billing, type LoginPool } from "./billing.ts";
import { fetchPublic } from "./ssrf.ts";
import { cache, rateLimit } from "./cache.ts";
import { customerProblem, providerUserId, withProviderUser } from "../../foldrun-core/src/customer.ts";
import { admitCustomerCall, CustomerRefused } from "./customers.ts";
import { platformKeyAllowedFor } from "./settings.ts";
import { edition } from "./ledger.ts";
import { MAX_BYTES as TRANSCRIBE_MAX_BYTES, MAX_SECONDS as TRANSCRIBE_MAX_SECONDS, langProblem, transcribe, TranscribeError } from "./transcribe.ts";
import { opsLog } from "../../foldrun-core/src/ops-log.ts";


const port = () => Number(process.env.FOLDRUN_GATEWAY_PORT) || 8091;
/** The most a request body may be (a long transcript with images). */
const MAX_BODY = 32 * 1024 * 1024;
const IDLE_MS = 10 * 60_000;

/** What the door forwards of the caller's headers: nothing else — never the
 *  caller's key, cookies or address. */
const FORWARD = ["anthropic-version", "anthropic-beta", "content-type", "accept"];
/** What it does not hand back: hop-by-hop, and what names the platform's own
 *  Anthropic organisation and rate state. */
const DROP_BACK = /^(connection|keep-alive|transfer-encoding|content-encoding|content-length|set-cookie|anthropic-organization-id|anthropic-workspace-id|anthropic-ratelimit-.*|retry-after-ms)$/i;

const ERR_TYPES: Record<number, string> = { 400: "invalid_request_error", 401: "authentication_error", 402: "billing_error", 403: "permission_error", 404: "not_found_error", 413: "request_too_large", 429: "rate_limit_error", 500: "api_error", 502: "api_error", 503: "overloaded_error" };

/** Who a response is for, once the gateway key is resolved (or found and
 *  refused): what a refusal is recorded against in the operations log, so
 *  the operator console can show an account's refused calls (D239 phase 1). */
interface Caller { tenant?: string; key?: string; surface: "gateway" | "transcribe" | "usage" }
const callers = new WeakMap<http.ServerResponse, Caller>();
function noteCaller(res: http.ServerResponse, c: Caller): void {
  callers.set(res, c);
}

/** A refusal's reason, as one word an operator can count. */
const REASONS: Record<number, string> = { 400: "bad_request", 401: "unauthorized", 402: "payment_required", 403: "forbidden", 404: "not_found", 413: "too_large", 429: "rate_limited", 500: "error", 502: "upstream_error", 503: "unavailable" };

/** An error in Anthropic's own shape, which every client already parses.
 *  Every refusal is recorded (`gateway.refused`: status, reason, the account
 *  and key when known) except a 404 from a caller nobody knows — scanners. */
function fail(res: http.ServerResponse, status: number, message: string, extra: Record<string, string> = {}, reason?: string): void {
  const who = callers.get(res);
  if (status >= 400 && !(status === 404 && !who?.tenant)) {
    opsLog(status >= 500 ? "error" : "warn", "gateway.refused", { surface: who?.surface ?? "gateway", status, reason: reason ?? REASONS[status] ?? "refused", tenant: who?.tenant, key: who?.key });
  }
  if (res.headersSent) return void res.end();
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra });
  res.end(JSON.stringify({ type: "error", error: { type: ERR_TYPES[status] ?? "api_error", message } }));
}

export interface GatewayWho {
  keyId: string;
  /** FOL-168: this key's calls must name an end customer (x-foldrun-customer). */
  requireCustomer?: boolean;
  tenant: string;
  grant: GatewayGrant;
}

/** The key a request carries: `x-api-key` (ANTHROPIC_API_KEY) or a Bearer
 *  token (ANTHROPIC_AUTH_TOKEN), nothing else. */
export function presentedKey(headers: http.IncomingHttpHeaders): string | null {
  const x = headers["x-api-key"];
  if (typeof x === "string" && x.trim()) return x.trim();
  const a = headers.authorization;
  if (typeof a === "string" && /^bearer\s+\S/i.test(a)) return a.replace(/^bearer\s+/i, "").trim();
  return null;
}

/** When each key last authenticated here, so the list's "last used" is
 *  written at most once a minute per key, as the web funnel writes it. The
 *  address is left as it was: this door sits behind Cloudflare and nginx,
 *  and a guessed one is worse than none. */
const TOUCH_EVERY_MS = 60_000;
const touched = new Map<string, number>();
let touch: (id: string, at: Date, ip: string | null) => Promise<void> = (id, at, ip) => touchApiKeyDb(id, at, ip);
export function setGatewayTouchForTests(fn: typeof touch | null): void {
  touch = fn ?? ((id, at, ip) => touchApiKeyDb(id, at, ip));
  touched.clear();
}
async function noteUse(record: { id: string; lastUsedAt?: string | null; lastIp?: string | null }, now: number): Promise<void> {
  const last = touched.get(record.id) ?? (record.lastUsedAt ? Date.parse(record.lastUsedAt) : 0);
  if (now - last < TOUCH_EVERY_MS) return;
  touched.set(record.id, now);
  if (touched.size > 10_000) touched.clear();
  await touch(record.id, new Date(now), record.lastIp ?? null).catch((err) => opsError("gateway.last_use_not_recorded", err));
}

/** Key lookups, cached per pod for KEY_CACHE_MS (Part S (c), 10 Nov 2026):
 *  the gateway asked Postgres on every call. A key's expiry is checked on
 *  every call against the cached record; a revocation reaches this pod at
 *  once by LISTEN/NOTIFY (12 Nov 2026, below), and within KEY_CACHE_MS
 *  (at most 10 s) if that notice is missed. An unknown hash is
 *  cached too, so a flood of bad keys cannot reach the database. */
const KEY_CACHE_MS = 10_000;
const KEY_CACHE_MAX = 10_000;
/** While Postgres is not answering, a key read in the last KEY_STALE_MS is
 *  still honoured (10 Nov 2026: a minute's outage on dev turned every call
 *  into a 500). A revocation cannot be read while the database is down
 *  anyway; one made before the outage is in any record read after it, so
 *  the window is a key left unused since then — at most KEY_STALE_MS. A
 *  login key then works on; a metered call still stops, at its hold. */
const KEY_STALE_MS = 120_000;

/** Postgres is not answering — refused, reset or ended connections, a
 *  server starting up, shutting down or out of connections — as opposed to
 *  a query that is wrong. Drizzle wraps the driver's error in `cause`. */
export function databaseDown(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== "object" || depth > 4) return false;
  const e = err as { code?: unknown; message?: unknown; cause?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "EPIPE", "57P01", "57P02", "57P03", "53300", "08000", "08001", "08003", "08006"].includes(code)) return true;
  const m = typeof e.message === "string" ? e.message : "";
  if (/Connection terminated|connection timeout|timeout exceeded when trying to connect|the database system is (starting up|shutting down)|Client has encountered a connection error|terminating connection due to administrator command/i.test(m)) return true;
  return databaseDown(e.cause, depth + 1);
}
const keyCache = new Map<string, { at: number; record: Awaited<ReturnType<typeof findApiKeyByHashDb>> }>();
// A revocation, expiry, grant or require-customer change anywhere drops that
// key here at once (api-keys-db.ts announces it; 12 Nov 2026). KEY_CACHE_MS
// stays as the safety net for a missed notice. Each time LISTEN comes into
// effect (the first time too) everything cached is dropped: what changed
// before then went unheard. `keyGen` moves on every drop, so a lookup that
// was already reading when a drop happened does not put its older answer
// back (a read sees the database as of its start).
let keyListen = false;
let keyGen = 0;
function listenForKeyChanges(): void {
  if (keyListen) return;
  keyListen = true;
  listen(
    API_KEY_CHANNEL,
    (id) => {
      keyGen++;
      for (const [hash, v] of keyCache) if (v.record?.id === id) keyCache.delete(hash);
    },
    {
      up: () => {
        keyGen++;
        keyCache.clear();
      },
    },
  );
}
async function cachedLookup(hash: string, now: number): Promise<Awaited<ReturnType<typeof findApiKeyByHashDb>>> {
  if (!lookupReplaced) listenForKeyChanges();
  const hit = keyCache.get(hash);
  if (hit && now - hit.at < KEY_CACHE_MS) return hit.record;
  let record: Awaited<ReturnType<typeof findApiKeyByHashDb>>;
  let gen = keyGen;
  try {
    record = await lookup(hash);
    // A change was announced while we read: read again, from after it.
    if (keyGen !== gen) {
      gen = keyGen;
      record = await lookup(hash);
    }
  } catch (err) {
    // The last record read, while the database is down and it is recent.
    if (hit && now - hit.at < KEY_STALE_MS && databaseDown(err)) return hit.record;
    throw err;
  }
  // Still racing a stream of changes: answer, but do not keep it.
  if (keyGen !== gen) return record;
  if (keyCache.size >= KEY_CACHE_MAX) keyCache.clear();
  keyCache.set(hash, { at: now, record });
  return record;
}
/** For tests: forget every cached key. */
export function resetGatewayKeyCacheForTests(): void {
  keyCache.clear();
}

/** For tests: where a key is looked up. */
let lookup: (hash: string) => Promise<Awaited<ReturnType<typeof findApiKeyByHashDb>>> = (h) => findApiKeyByHashDb(h);
let lookupReplaced = false;
export function setGatewayKeyLookupForTests(fn: typeof lookup | null): void {
  lookup = fn ?? ((h) => findApiKeyByHashDb(h));
  lookupReplaced = fn !== null;
  keyCache.clear();
}

/** The gateway key a request presents, live — or the refusal to send. */
/** A refused key: the status and sentence the caller gets, a reason word for
 *  the operations log, and — when the key was found (revoked, expired, not a
 *  gateway key) — whose it is, so the refusal shows on that account. */
export interface GatewayRefusal { status: number; message: string; reason: string; tenant?: string; keyId?: string }

export async function authenticate(headers: http.IncomingHttpHeaders, now = Date.now()): Promise<{ who: GatewayWho } | GatewayRefusal> {
  const presented = presentedKey(headers);
  if (!presented) return { status: 401, message: "send your foldrun gateway key as x-api-key (ANTHROPIC_API_KEY) or Authorization: Bearer (ANTHROPIC_AUTH_TOKEN)", reason: "no_key" };
  const record = await cachedLookup(crypto.createHash("sha256").update(presented).digest("hex"), now);
  if (!record) return { status: 401, message: "invalid API key", reason: "key_unknown" };
  if (record.revokedAt) return { status: 401, message: "API key revoked", reason: "key_revoked", tenant: record.tenant, keyId: record.id };
  if (record.expiresAt && Date.parse(record.expiresAt) <= now) return { status: 401, message: `API key expired on ${record.expiresAt.slice(0, 10)} — mint a new one`, reason: "key_expired", tenant: record.tenant, keyId: record.id };
  // Only a gateway key opens this door, and a gateway key opens nothing else
  // (the web funnel refuses it): an account key pasted into a coding agent
  // is refused here, not honoured.
  if (record.purpose !== "gateway" || !record.gateway) return { status: 403, message: "this is not a gateway key — mint one on Settings → API keys (or `foldrun keys create --gateway`)", reason: "not_gateway_key", tenant: record.tenant, keyId: record.id };
  await noteUse(record, now);
  return { who: { keyId: record.id, tenant: record.tenant, grant: record.gateway, ...(record.requireCustomer ? { requireCustomer: true } : {}) } };
}

async function readBody(req: http.IncomingMessage): Promise<Buffer | "too-large"> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) return "too-large";
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/** What a gateway key has spent against its own limits, as charged — the
 *  numbers its limits are checked in, and the ones Settings → API keys shows. */
export interface GatewayUsage {
  metered: boolean;
  capUsd: number | null;
  dailyUsd: number | null;
  spentUsd: number;
  todayUsd: number;
  /** The UTC day `todayUsd` and the daily limit count. */
  day: string;
  /** A login key's usage limits, where they are kept (14 Nov 2026): per
   *  window, the part used (null: counted, no limit) and when it starts
   *  again. Percentages only: what stands behind them is the operator's. */
  limits?: { name: string; percent: number | null; resetsAt: string }[];
}

/** Usage answers are kept this long per key and pod: Claude Code redraws its
 *  status line after every message, and the line needs no fresher number. */
const USAGE_CACHE_MS = 5_000;
const usageCache = new Map<string, { at: number; usage: GatewayUsage }>();
/** For tests: forget every cached answer. */
export function resetGatewayUsageCacheForTests(): void {
  usageCache.clear();
}

export async function usageOf(who: GatewayWho, now = new Date()): Promise<GatewayUsage> {
  const day = dayOf(now);
  // A login key runs on the operator's Claude login: nothing is metered.
  if (who.grant.credential === "login") {
    const share = await loginPoolFn()?.shareOf({ tenant: who.tenant, keyId: who.keyId, plan: who.grant.plan }, now).catch((err) => void opsError("gateway.login_share_not_read", err));
    const limits = share?.windows.map((w) => ({ name: w.name, percent: w.share !== null && w.share > 0 ? Math.min(100, Math.floor((w.used / w.share) * 100)) : null, resetsAt: w.resetsAt }));
    return { metered: false, capUsd: null, dailyUsd: null, spentUsd: 0, todayUsd: 0, day, ...(limits ? { limits } : {}) };
  }
  const hit = usageCache.get(who.keyId);
  if (hit && now.getTime() - hit.at < USAGE_CACHE_MS && hit.usage.day === day) return hit.usage;
  const job = `gateway:${who.keyId}`;
  const m = chargeMargin();
  const [spentUsd, todayUsd] = await Promise.all([spentByJob(who.tenant, job, undefined, m), spentByJob(who.tenant, job, day, m)]);
  const usage: GatewayUsage = { metered: true, capUsd: who.grant.capUsd ?? null, dailyUsd: who.grant.dailyUsd ?? null, spentUsd, todayUsd, day };
  if (usageCache.size >= KEY_CACHE_MAX) usageCache.clear();
  usageCache.set(who.keyId, { at: now.getTime(), usage });
  return usage;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** One line for Claude Code's status line:
 *  `foldrun · $3.12 of $20.00 · today $1.10 of $5.00`. */
export function usageLine(u: GatewayUsage): string {
  if (!u.metered) {
    // A share that is kept: each window's part used, `limit reached` at 100%.
    const parts = (u.limits ?? []).filter((w) => w.percent !== null).map((w) => ({ name: w.name, pct: w.percent as number }));
    if (!parts.length) return "foldrun · included in your plan";
    return `foldrun · ${parts.map((x) => `${x.name} ${Math.min(x.pct, 100)}%`).join(" · ")}${parts.some((x) => x.pct >= 100) ? " · limit reached" : ""}`;
  }
  const all = u.capUsd === null ? `${usd(u.spentUsd)} spent` : `${usd(u.spentUsd)} of ${usd(u.capUsd)}`;
  const today = u.dailyUsd === null ? `today ${usd(u.todayUsd)}` : `today ${usd(u.todayUsd)} of ${usd(u.dailyUsd)}`;
  const reached = (u.capUsd !== null && u.spentUsd >= u.capUsd) || (u.dailyUsd !== null && u.todayUsd >= u.dailyUsd);
  return `foldrun · ${all} · ${today}${reached ? " · limit reached" : ""}`;
}

/** A refused key, in a few words for the status line. */
export function refusalLine(status: number, message: string): string {
  if (status === 403) return "foldrun · not a gateway key";
  if (/revoked/.test(message)) return "foldrun · key revoked";
  if (/expired/.test(message)) return "foldrun · key expired";
  if (/^send your foldrun gateway key/.test(message)) return "foldrun · no key set";
  if (status === 401) return "foldrun · key not valid";
  if (status === 429) return "foldrun · usage asked too often";
  return "foldrun · usage not available";
}

/** The most usage answers one key gets a minute, apart from its call rate:
 *  a status line must never use up the rate its calls need. */
const USAGE_RPM = 120;

/** GET /v1/usage: what the presenting key has spent and may spend. JSON, or
 *  with `?format=line` the one line a status line prints — refusals too, so
 *  a plain curl shows "key revoked" rather than an error body. */
async function usageRoute(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const line = new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("format") === "line";
  const refuse = (status: number, message: string, extra: Record<string, string> = {}, reason?: string) => {
    if (!line) return fail(res, status, message, extra, reason);
    const who = callers.get(res);
    opsLog(status >= 500 ? "error" : "warn", "gateway.refused", { surface: "usage", status, reason: reason ?? REASONS[status] ?? "refused", tenant: who?.tenant, key: who?.key });
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra });
    res.end(refusalLine(status, message) + "\n");
  };
  if (!lookupReplaced && !databaseEnabled()) return refuse(503, "the gateway needs the platform's database");
  let u: GatewayUsage;
  try {
    const auth = await authenticate(req.headers);
    if ("status" in auth) {
      noteCaller(res, { tenant: auth.tenant, key: auth.keyId, surface: "usage" });
      return refuse(auth.status, auth.message, {}, auth.reason);
    }
    noteCaller(res, { tenant: auth.who.tenant, key: auth.who.keyId, surface: "usage" });
    const rate = await rateLimit(`gwu:${auth.who.keyId}`, USAGE_RPM, 60);
    if (!rate.allowed) return refuse(429, `usage is answered ${USAGE_RPM} times a minute per key — ask less often`, { "retry-after": String(rate.retryAfter) });
    u = await usageOf(auth.who);
  } catch (err) {
    // JSON goes to the server's own handler; a status line still gets a line,
    // never an error object (Codex review, 11 Nov 2026).
    if (!line) throw err;
    const down = databaseDown(err);
    if (!down) opsError("gateway.usage_failed", err);
    return refuse(down ? 503 : 500, "usage not available", down ? { "retry-after": "5" } : {});
  }
  if (line) {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    return void res.end(usageLine(u) + "\n");
  }
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(u));
}

/** Recordings one key may send a minute: `/talk` is a person speaking, so
 *  a few a minute is plenty, and each holds a Whisper pod for seconds. */
const TRANSCRIBE_RPM = 30;

/** POST /v1/foldrun/transcribe?lang=auto|fa|en|…: a WAV (PCM 16-bit, 16 kHz,
 *  mono, at most TRANSCRIBE_MAX_SECONDS) in, `{text, language, model,
 *  seconds}` out. Any gateway key, login keys included; held to the key's
 *  open-call slots and a rate of its own. Not metered yet: extraction prices
 *  are the owner's to set (media-to-text design, open question 1). */
async function transcribeRoute(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let gone = false;
  // A caller gone stops the work it asked for: the Whisper call is aborted
  // and no second (Persian) pass starts.
  const cancel = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) {
      gone = true;
      cancel.abort();
    }
  });
  if (!lookupReplaced && !databaseEnabled()) return fail(res, 503, "the gateway needs the platform's database");
  const lang = new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("lang") ?? "auto";
  const bad = langProblem(lang);
  if (bad) return fail(res, 400, bad);
  const auth = await authenticate(req.headers);
  if ("status" in auth) {
    noteCaller(res, { tenant: auth.tenant, key: auth.keyId, surface: "transcribe" });
    return fail(res, auth.status, auth.message, {}, auth.reason);
  }
  const { who } = auth;
  noteCaller(res, { tenant: who.tenant, key: who.keyId, surface: "transcribe" });
  // The end customer (FOL-168), checked before the key's buckets as on
  // /v1/messages: a blocked or busy customer never spends the key's
  // allowance, and a block list that cannot be read refuses.
  let customerHeld: { release: () => Promise<void> } | null = null;
  const rawCustomer = req.headers["x-foldrun-customer"];
  if (rawCustomer !== undefined) {
    const v = Array.isArray(rawCustomer) ? rawCustomer[0] : rawCustomer;
    const problem = customerProblem(v);
    if (problem) return fail(res, 400, `x-foldrun-customer: ${problem}`);
    try {
      customerHeld = await admitCustomerCall(who.tenant, v as string, takeSlot);
    } catch (err) {
      if (err instanceof CustomerRefused) return fail(res, err.status, err.message, err.retryAfter ? { "retry-after": String(err.retryAfter) } : {}, err.code);
      return fail(res, 503, `the block list for customer ${v} could not be read — try again in a moment`);
    }
  }
  try {
    if (gone || res.destroyed) return;
    const rate = await rateLimit(`gwt:${who.keyId}`, TRANSCRIBE_RPM, 60);
    if (!rate.allowed) return fail(res, 429, `this key may send ${TRANSCRIBE_RPM} recordings a minute — wait a moment`, { "retry-after": String(rate.retryAfter) });
    const slot = await takeSlot(who.keyId, limits().concurrency);
    if (!slot.ok) return fail(res, 429, `this key has ${limits().concurrency} calls open at once already — wait for one to finish`, { "retry-after": "2" }, "too_many_open");
    // Held until the transcription settles, not until the caller leaves: a
    // caller that sends and hangs up must not free its slot while Whisper
    // still works on what it sent.
    try {
      if (gone || res.destroyed) return;
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > TRANSCRIBE_MAX_BYTES) return fail(res, 413, `a recording is at most ${TRANSCRIBE_MAX_SECONDS} s of 16 kHz mono WAV`);
        chunks.push(c as Buffer);
      }
      const started = Date.now();
      try {
        const t = await transcribe(Buffer.concat(chunks), lang, process.env, cancel.signal);
        opsLog("info", "gateway.transcribed", { tenant: who.tenant, key: who.keyId, secs: t.seconds, model: t.model, kind: t.language, ms: Date.now() - started });
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(t));
      } catch (err) {
        if (err instanceof TranscribeError) return fail(res, err.status, err.message);
        opsError("gateway.transcribe_failed", err, { tenant: who.tenant });
        return fail(res, 500, "the recording could not be transcribed");
      }
    } finally {
      await slot.release();
    }
  } finally {
    await customerHeld?.release();
  }
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // Watched from the start: a caller gone while the checks below wait on the
  // database must not be sent upstream (Codex review, 10 Nov 2026).
  let gone = false;
  res.on("close", () => {
    if (!res.writableFinished) gone = true;
  });
  const method = (req.method ?? "GET").toUpperCase();
  const pathname = (req.url ?? "/").split("?")[0]!;
  if (pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    return void res.end("ok");
  }
  if (method === "GET" && pathname === "/v1/usage") return usageRoute(req, res);
  if (method === "POST" && pathname === "/v1/foldrun/transcribe") return transcribeRoute(req, res);
  const known = (method === "POST" && (pathname === "/v1/messages" || pathname === "/v1/messages/count_tokens")) || (method === "GET" && pathname === "/v1/models");
  if (!known) return fail(res, 404, `${method} ${pathname} is not served here — this gateway offers POST /v1/messages, POST /v1/messages/count_tokens, GET /v1/models, GET /v1/usage and POST /v1/foldrun/transcribe`);
  if (!lookupReplaced && !databaseEnabled()) return fail(res, 503, "the gateway needs the platform's database");

  const auth = await authenticate(req.headers);
  if ("status" in auth) {
    noteCaller(res, { tenant: auth.tenant, key: auth.keyId, surface: "gateway" });
    return fail(res, auth.status, auth.message, {}, auth.reason);
  }
  const { who } = auth;
  noteCaller(res, { tenant: who.tenant, key: who.keyId, surface: "gateway" });

  // FOL-168: which of the partner's own users this call is for, in
  // `x-foldrun-customer` (Claude Code sends it with ANTHROPIC_CUSTOM_HEADERS).
  // Checked BEFORE the key's buckets, so a blocked or busy customer never
  // spends the key's allowance; a call that names none is held to the key's
  // limits alone, as ever. A block list that cannot be read refuses.
  let customer: string | null = null;
  const rawCustomer = req.headers["x-foldrun-customer"];
  // A key that requires one refuses a call that names none (FOL-168).
  if (who.requireCustomer && method === "POST" && rawCustomer === undefined) {
    return fail(res, 400, "this key requires an end customer on every call: send x-foldrun-customer (Claude Code: ANTHROPIC_CUSTOM_HEADERS)");
  }
  if (rawCustomer !== undefined && method === "POST") {
    const v = Array.isArray(rawCustomer) ? rawCustomer[0] : rawCustomer;
    const problem = customerProblem(v);
    if (problem) return fail(res, 400, `x-foldrun-customer: ${problem}`);
    customer = v as string;
    try {
      const held = await admitCustomerCall(who.tenant, customer, takeSlot);
      res.on("close", () => void held.release());
      // Gone while the check waited: the close already fired (Codex review).
      if (gone || res.destroyed) return void (await held.release());
    } catch (err) {
      if (err instanceof CustomerRefused) return fail(res, err.status, err.message, err.retryAfter ? { "retry-after": String(err.retryAfter) } : {}, err.code);
      return fail(res, 503, `the block list for customer ${customer} could not be read — try again in a moment`);
    }
  }

  // Load limits, per key, on every route and every kind of key (login keys
  // and the free routes included — none of those are held by a dollar
  // limit). A real rate limit is a 429 with Retry-After: waiting does help.
  const rate = await rateLimit(`gw:${who.keyId}`, limits().rpm, 60);
  if (!rate.allowed) return fail(res, 429, `this key's request rate is reached (${limits().rpm} a minute) — slow down, or ask for a higher limit`, { "retry-after": String(rate.retryAfter) });
  const slot = await takeSlot(who.keyId, limits().concurrency);
  if (!slot.ok) return fail(res, 429, `this key has ${limits().concurrency} calls open at once already — wait for one to finish`, { "retry-after": "2" }, "too_many_open");
  res.on("close", () => void slot.release());
  // Gone while the checks above waited: the close event already fired, so
  // the listener above never will (Codex review, 10 Nov 2026).
  if (gone || res.destroyed) return void (await slot.release());

  const body = method === "POST" ? await readBody(req) : null;
  if (body === "too-large") return fail(res, 413, `the request is over ${MAX_BODY / 1024 / 1024} MB`);

  // Which provider serves this call (Part A1, 10 Nov 2026): by the model
  // name — `provider/model`, or a bare name with a known prefix — on the
  // provider's own Anthropic-format path. Anthropic when nothing says else.
  // The key's own model mapping (Part A5): the /model picker's tier, as this
  // key says it runs.
  const route = routeOf(method, pathname, mapModel(body, who.grant.models));
  if ("error" in route) return fail(res, route.status, route.error);
  const provider = route.provider;
  const sp = SUPPLY_PROVIDERS[provider];
  // The provider's end-user id for this customer (FOL-168), set on the
  // Anthropic-shaped body before anything translates it — the translator
  // carries metadata.user_id to OpenAI's `user` / `safety_identifier`.
  const routedBody = customer && route.body && pathname === "/v1/messages" ? withProviderUser(route.body, providerUserId(who.tenant, customer), "anthropic") : route.body;

  let metered: MeteredCall | null = null;
  let sendBody: Buffer | null = routedBody;
  let outBody: Buffer | null = routedBody;
  let xlate: Translated | null = null;
  let credential: Record<string, string>;
  let betaExtra: string | null = null;
  let pooled: { pool: LoginPool; login: string; model: string | null } | null = null;
  if (who.grant.credential === "login") {
    // A Claude login is Anthropic's alone.
    if (provider !== "anthropic") return fail(res, 403, `this key is for Claude models only — ${provider} needs a gateway key with a spending limit`);
    if (route.estimate !== undefined) return fail(res, 400, "a login gateway key counts tokens on Anthropic's models only");
    // The operator's own Claude login (owner, 10 Nov 2026: "subscription, my
    // own use only"): for an account the operator allows its credential —
    // asked on every call, so taking that away closes the key at once. Not
    // metered or billed (the subscription is flat-rate) and no limits; the
    // token is read fresh each call, as the runner reads it, so a refresh
    // reaches the next call with no restart.
    if (!loginAllowed(who.tenant)) return fail(res, 403, "this account has no plan this key can run on — it opens nothing");
    // Where the install keeps several logins (billing().loginPool), the pool
    // says which one this call goes on — or that the key's share is used.
    const pool = loginPoolFn();
    let token: string | null;
    if (pool) {
      const model = namedModel(routedBody);
      let picked: Awaited<ReturnType<LoginPool["pick"]>>;
      try {
        picked = await pool.pick({ tenant: who.tenant, keyId: who.keyId, plan: who.grant.plan }, model, new Date());
      } catch (err) {
        opsError("gateway.login_pick_failed", err);
        return fail(res, 503, "this key's usage could not be read — try again in a moment", { "retry-after": "5" });
      }
      if ("refuse" in picked) return fail(res, picked.refuse.status, picked.refuse.message, {}, "login_share");
      token = picked.token;
      pooled = { pool, login: picked.login, model };
    } else token = loginToken();
    if (!token) return fail(res, 503, "this gateway cannot serve this key right now");
    credential = { authorization: `Bearer ${token}` };
    betaExtra = OAUTH_BETA;
  } else {
    // The key's limits are held in reserveCall alone, with the call's
    // estimate (the pre-check that summed the key's spend twice more is gone:
    // Codex review, 10 Nov 2026). A spent limit is a 402, not a 429: Claude
    // Code retries a 429 for about three minutes, and no retry makes room
    // under a limit. A 429 the provider sends still comes back as it was.
    if (route.estimate !== undefined) {
      // count_tokens on a provider with no such route: an estimate, said so —
      // after the same account checks every call gets (Codex review).
      const refused = await accountStands(who.tenant, provider);
      if (refused) return fail(res, refused.status, refused.message);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "x-foldrun-estimate": "1" });
      return void res.end(JSON.stringify({ input_tokens: route.estimate }));
    }
    // OpenAI and Gemini speak another format: the request is translated
    // here, and admitted (checked, priced, held) as the provider will see it.
    if (sp.format !== "anthropic" && routedBody) {
      xlate = await translateRequest(who.tenant, provider, routedBody);
      outBody = xlate.body;
    }
    const admitted = await admitCall(
      { tenant: who.tenant, kind: "coding", job: `gateway:${who.keyId}`, jobLimits: { capUsd: who.grant.capUsd ?? null, dailyUsd: who.grant.dailyUsd ?? null }, ...(customer ? { customer } : {}) },
      provider,
      method,
      route.path,
      outBody,
    );
    if ("refuse" in admitted) return fail(res, admitted.refuse.status === 429 ? 402 : admitted.refuse.status, admitted.refuse.message);
    metered = "metered" in admitted ? admitted.call : null;
    sendBody = "metered" in admitted ? admitted.body : outBody;
    const key = supplyKeyOf(provider);
    if (!key) {
      await metered?.finish(0, false).catch((e) => opsError("gateway.close_failed", e));
      return fail(res, 503, `foldrun's models are unavailable for a moment (no ${provider} key on this platform)`);
    }
    // Each provider's key in its own header, in its exact shape.
    credential = sp.auth === "bearer" ? { authorization: `Bearer ${key}` } : { "x-api-key": key };
  }

  const host = supplyHostOf(provider);
  // https always; plain http only where a test allows it (supplySchemeOk).
  // The route was checked on the path alone; its query goes on as it came
  // (Codex review: /v1/models?after_id=… pages).
  const q = (req.url ?? "").indexOf("?");
  const target = `${supplySchemeOk(`http://${host}`) ? "http" : "https"}://${host}${route.path}${q >= 0 ? (req.url ?? "").slice(q) : ""}`;
  if (!supplySchemeOk(target)) {
    await metered?.finish(0, false).catch((e) => opsError("gateway.close_failed", e));
    return fail(res, 503, "foldrun's models are unavailable for a moment");
  }

  if (gone || res.destroyed) {
    // Nothing was sent: the hold is closed at nothing.
    await metered?.finish(0, false).catch((e) => opsError("gateway.close_failed", e));
    return;
  }

  const headers: Record<string, string> = xlate ? { ...credential, "content-type": "application/json" } : { ...credential, "anthropic-version": "2023-06-01" };
  if (!xlate) {
    for (const h of FORWARD) {
      const v = req.headers[h];
      if (typeof v === "string" && v) headers[h] = v;
    }
  }
  if (betaExtra) {
    const have = (headers["anthropic-beta"] ?? "").split(",").map((b) => b.trim()).filter(Boolean);
    if (!have.includes(betaExtra)) headers["anthropic-beta"] = [...have, betaExtra].join(",");
  }

  const abort = new AbortController();
  let idle = setTimeout(() => abort.abort(new Error("no reply from the model provider")), IDLE_MS);
  const quiet = () => {
    clearTimeout(idle);
    idle = setTimeout(() => abort.abort(new Error("no reply from the model provider")), IDLE_MS);
  };
  res.on("close", () => {
    clearTimeout(idle);
    if (!res.writableFinished) abort.abort(new Error("the client went away"));
  });

  let upstream: Response;
  try {
    upstream = await fetchPublic(target, { method, headers, ...(sendBody ? { body: sendBody, duplex: "half" } : {}), redirect: "manual", signal: abort.signal } as RequestInit, { maxBytes: Infinity });
  } catch (err) {
    // Never connected: nothing reached the provider, nothing is charged;
    // anything else may have been billed, so it stands at its estimate (as
    // the egress proxy does).
    const code = (err as { cause?: { code?: string } })?.cause?.code ?? "";
    await metered?.finish(/^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ERR_TLS_CERT_ALTNAME_INVALID|CERT_)/.test(code) ? 0 : 200, false).catch((e) => opsError("gateway.close_failed", e));
    clearTimeout(idle);
    return fail(res, 502, `could not reach the model provider: ${err instanceof Error ? err.message : String(err)}`);
  }

  // A provider refusal (not 2xx) billed nothing: closed at once.
  if (metered && (upstream.status < 200 || upstream.status >= 300)) await metered.finish(upstream.status, true).catch((e) => opsError("gateway.close_failed", e));
  if (xlate) {
    try {
      await relayTranslated(res, upstream, xlate, metered, who.tenant, quiet);
    } finally {
      clearTimeout(idle);
    }
    return;
  }
  const out: Record<string, string> = {};
  upstream.headers.forEach((v, k) => {
    if (!DROP_BACK.test(k)) out[k] = v;
  });
  res.writeHead(upstream.status, out);
  metered?.start(upstream.headers.get("content-type"));
  // A pooled login's reply is read for its usage (a message only), and the
  // pool is told what came back — once, whatever happens to the stream.
  const ok = upstream.status >= 200 && upstream.status < 300;
  const reader = pooled && ok && pathname === "/v1/messages" ? new UsageReader("anthropic", upstream.headers.get("content-type")) : null;
  const tell = async () => {
    if (!pooled) return;
    const headers: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
      if (/^(anthropic-ratelimit-|retry-after)/i.test(k)) headers[k.toLowerCase()] = v;
    });
    await pooled.pool
      .record({ tenant: who.tenant, keyId: who.keyId, plan: who.grant.plan }, { login: pooled.login, model: pooled.model, usage: reader?.result() ?? null, status: upstream.status, headers }, new Date())
      .catch((e) => opsError("gateway.login_record_failed", e));
  };
  if (!upstream.body) {
    await metered?.finish(upstream.status, true).catch((e) => opsError("gateway.close_failed", e));
    await tell();
    clearTimeout(idle);
    return void res.end();
  }
  let complete = false;
  try {
    for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
      quiet();
      metered?.feed(chunk);
      reader?.feed(chunk);
      if (!res.write(chunk)) await drained(res);
    }
    complete = true;
  } catch {
    // The caller left or the provider cut off: charged at the estimate.
  } finally {
    clearTimeout(idle);
    await metered?.finish(upstream.status, complete).catch((e) => opsError("gateway.close_failed", e));
    res.end();
    await tell();
  }
}

interface Translated {
  wire: "responses" | "chat";
  body: Buffer;
  stream: boolean;
  model: string;
  stops: unknown;
  extras: ToolCallExtras;
}

/** Gemini's thought signatures, kept between this account's calls (core's
 *  translator keeps them per step; the gateway serves separate calls). In
 *  Redis under the account, never across accounts: one key per tool call,
 *  each living 2 h on its own (Codex review: one shared hash renewed on every
 *  call never let old ones go). */
const EXTRAS_TTL_S = 2 * 3600;
const extrasKey = (tenant: string, id: string) => `gwx:{${tenant}}:${id}`;

/** Keep this turn's extras for the next one. Awaited BEFORE the reply's last
 *  events go out (Codex review): a client that answers a tool call at once
 *  must find them. */
async function saveExtras(tenant: string, extras: ToolCallExtras): Promise<void> {
  const kept = extras.entries();
  if (!kept.length) return;
  const c = cache();
  if (c) {
    try {
      const m = c.multi();
      for (const [id, x] of kept) m.set(extrasKey(tenant, id), JSON.stringify(x), "EX", EXTRAS_TTL_S);
      await m.exec();
      return;
    } catch {
      // Redis did not answer: this pod's own memory, below
    }
  }
  // No Redis (a single-process install, or an outage): kept in this process,
  // bounded, so a Gemini tool loop still continues on this pod (Codex review).
  const until = Date.now() + EXTRAS_TTL_S * 1000;
  for (const [id, x] of kept) {
    localExtras.delete(extrasKey(tenant, id));
    localExtras.set(extrasKey(tenant, id), { x: JSON.stringify(x), until });
  }
  while (localExtras.size > LOCAL_EXTRAS_MAX) localExtras.delete(localExtras.keys().next().value as string);
}
const LOCAL_EXTRAS_MAX = 10_000;
const localExtras = new Map<string, { x: string; until: number }>();
async function loadExtras(tenant: string, ids: string[]): Promise<(string | null)[]> {
  const c = cache();
  if (c) {
    try {
      return await c.mget(...ids.map((id) => extrasKey(tenant, id)));
    } catch {
      // Redis did not answer: this pod's own memory
    }
  }
  const now = Date.now();
  return ids.map((id) => {
    const e = localExtras.get(extrasKey(tenant, id));
    return e && e.until > now ? e.x : null;
  });
}

/** Claude Code's Anthropic request in the provider's format. */
async function translateRequest(tenant: string, provider: SupplyProviderName, body: Buffer): Promise<Translated> {
  const json = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
  const preset = providerPreset(SUPPLY_PROVIDERS[provider].preset);
  const stream = json.stream === true;
  const extras = new ToolCallExtras();
  const wire = SUPPLY_PROVIDERS[provider].format === "responses" ? "responses" : "chat";
  if (wire === "chat") {
    // The tool calls this request carries back: their kept extras.
    const ids: string[] = [];
    for (const m of Array.isArray(json.messages) ? (json.messages as Record<string, unknown>[]) : []) {
      for (const b of Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : []) if (b.type === "tool_use" && typeof b.id === "string") ids.push(b.id);
    }
    if (ids.length) {
      try {
        const got = await loadExtras(tenant, ids);
        ids.forEach((id, i) => {
          if (got[i]) extras.keep(id, JSON.parse(got[i]!));
        });
      } catch {
        // without them a Gemini tool turn may be refused; nothing else breaks
      }
    }
  }
  const out =
    wire === "responses"
      ? toResponses(json, { reasoningEffort: preset?.reasoningEffort, stream })
      : toChatCompletions(json, { maxTokensParam: preset?.maxTokensParam, reasoningEffort: preset?.reasoningEffort, stream, extras });
  return { wire, body: Buffer.from(JSON.stringify(out)), stream, model: String(json.model ?? ""), stops: json.stop_sequences, extras };
}

/** The provider's reply in Anthropic's format: its error as Anthropic's
 *  error, a stream through core's stream translator, a whole reply through
 *  its converter. Metered on the provider's own bytes, before translation. */
async function relayTranslated(res: http.ServerResponse, upstream: Response, t: Translated, metered: MeteredCall | null, tenant: string, quiet: () => void): Promise<void> {
  metered?.start(upstream.headers.get("content-type"));
  if (upstream.status < 200 || upstream.status >= 300) {
    const text = await upstream.text().catch(() => "");
    let message = `the provider answered ${upstream.status}`;
    try {
      const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
      message = typeof j.error === "string" ? j.error : j.error?.message ?? j.message ?? message;
    } catch {
      // not JSON: the status says it
    }
    const extra: Record<string, string> = {};
    const ra = upstream.headers.get("retry-after");
    if (ra) extra["retry-after"] = ra;
    return fail(res, upstream.status, message, extra);
  }
  let complete = false;
  try {
    if (!t.stream) {
      const chunks: Buffer[] = [];
      for await (const chunk of (upstream.body ?? []) as unknown as AsyncIterable<Uint8Array>) {
        quiet();
        metered?.feed(chunk);
        chunks.push(Buffer.from(chunk));
      }
      complete = true;
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const msg = t.wire === "responses" ? fromResponses(parsed, t.model) : fromChatCompletion(parsed, t.model, t.stops, t.extras);
      await saveExtras(tenant, t.extras);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(msg));
    } else {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const machine = t.wire === "responses" ? new ResponsesStreamTranslator(t.model) : new StreamTranslator(t.model, t.stops, t.extras);
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of (upstream.body ?? []) as unknown as AsyncIterable<Uint8Array>) {
        quiet();
        metered?.feed(chunk);
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }
          for (const e of machine.feed(ev)) if (!res.write(e)) await drained(res);
        }
      }
      complete = true;
      await saveExtras(tenant, t.extras);
      for (const e of machine.finishStream()) res.write(e);
      res.end();
    }
  } catch {
    // The caller left or the provider cut off: charged at the estimate.
    if (!res.headersSent) fail(res, 502, "the provider's reply could not be read");
    else res.end();
  } finally {
    await metered?.finish(upstream.status, complete).catch((e) => opsError("gateway.close_failed", e));
  }
}

/** The reply drained, or the caller went away (Codex review, 10 Nov 2026:
 *  a caller gone while the write was full emitted no drain, and the handler
 *  waited forever with its call open at its estimate). */
function drained(res: http.ServerResponse): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const done = (err?: Error) => {
      res.off("drain", ok);
      res.off("close", gone);
      res.off("error", gone);
      if (err) reject(err);
      else resolve();
    };
    const ok = () => done();
    const gone = () => done(new Error("the client went away"));
    if (res.destroyed || res.writableEnded) return done(new Error("the client went away"));
    res.on("drain", ok);
    res.on("close", gone);
    res.on("error", gone);
  });
}

/** The per-key load limits: FOLDRUN_GATEWAY_RPM (requests a minute, 300)
 *  and FOLDRUN_GATEWAY_CONCURRENCY (calls open at once, 32). A Claude Code
 *  session sends a call every few seconds, more with subagents. */
export function limits(env: NodeJS.ProcessEnv = process.env): { rpm: number; concurrency: number } {
  const n = (v: string | undefined, d: number) => {
    const x = Number(v);
    return Number.isInteger(x) && x > 0 ? x : d;
  };
  return { rpm: n(env.FOLDRUN_GATEWAY_RPM, 300), concurrency: n(env.FOLDRUN_GATEWAY_CONCURRENCY, 32) };
}

/** How long one call may hold a slot before it is counted out anyway: a pod
 *  that died mid-stream never releases its slots, so each expires. */
const SLOT_TTL_MS = 15 * 60_000;
const localSlots = new Map<string, Set<string>>();

/**
 * One of a key's open-call slots, across every gateway pod: a Redis sorted
 * set of open call ids scored by when each expires, trimmed, counted and
 * added in one script. Without Redis, a per-pod count (load control, not
 * money: an outage must not stop every coding agent).
 */
export async function takeSlot(keyId: string, limit: number, now = Date.now()): Promise<{ ok: boolean; release: () => Promise<void> }> {
  const id = crypto.randomBytes(8).toString("hex");
  const k = `gwc:{${keyId}}`;
  const c = cache();
  if (c) {
    try {
      const got = (await c.eval(
        "redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1]) if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4]) redis.call('PEXPIRE', KEYS[1], ARGV[5]) return 1",
        1,
        k,
        String(now),
        String(now + SLOT_TTL_MS),
        String(limit),
        id,
        String(SLOT_TTL_MS),
      )) as number;
      let done = false;
      return {
        ok: got === 1,
        release: async () => {
          if (done || got !== 1) return;
          done = true;
          await c.zrem(k, id).catch(() => {});
        },
      };
    } catch {
      // Redis did not answer: the per-pod count below.
    }
  }
  const open = localSlots.get(keyId) ?? new Set<string>();
  if (open.size >= limit) return { ok: false, release: async () => {} };
  open.add(id);
  localSlots.set(keyId, open);
  let done = false;
  return {
    ok: true,
    release: async () => {
      if (done) return;
      done = true;
      open.delete(id);
      if (!open.size) localSlots.delete(keyId);
    },
  };
}

/** Claude Code names a tier in the model (claude-opus-…, claude-sonnet-…,
 *  claude-haiku-…). A key that maps that tier gets its mapped model
 *  instead; anything else is left as it came. */
export function mapModel(body: Buffer | null, models: GatewayGrant["models"]): Buffer | null {
  if (!body || !models) return body;
  let json: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return body;
    json = parsed as Record<string, unknown>;
  } catch {
    return body;
  }
  const named = typeof json.model === "string" ? json.model.toLowerCase() : "";
  if (!named.startsWith("claude-")) return body;
  const tier = (["opus", "sonnet", "haiku"] as const).find((t) => named.includes(`-${t}`));
  const to = tier ? models[tier] : undefined;
  return to ? Buffer.from(JSON.stringify({ ...json, model: to })) : body;
}

/** A provider name as a caller may write it in `provider/model`. */
const PROVIDER_ALIASES: Record<string, SupplyProviderName> = {
  anthropic: "anthropic",
  claude: "anthropic",
  deepseek: "deepseek",
  moonshot: "moonshot",
  kimi: "moonshot",
  openai: "openai",
  gemini: "gemini",
  google: "gemini",
  zai: "zai",
  "z-ai": "zai",
  glm: "zai",
  zhipu: "zai",
  qwen: "qwen",
  alibaba: "qwen",
  minimax: "minimax",
  mimo: "mimo",
  xiaomi: "mimo",
};

/** The provider a model name names, and the name the provider knows:
 *  `provider/model`, else a bare name's known prefix, else Anthropic. */
export function providerOfModel(model: string): { provider: SupplyProviderName; model: string } | null {
  const slash = model.indexOf("/");
  if (slash > 0) {
    const p = PROVIDER_ALIASES[model.slice(0, slash).toLowerCase()];
    return p ? { provider: p, model: model.slice(slash + 1) } : null;
  }
  const m = model.toLowerCase();
  if (m.startsWith("deepseek-")) return { provider: "deepseek", model };
  if (m.startsWith("kimi-") || m.startsWith("moonshot-")) return { provider: "moonshot", model };
  if (m.startsWith("gpt-") || /^o\d/.test(m)) return { provider: "openai", model };
  if (m.startsWith("gemini-")) return { provider: "gemini", model };
  if (m.startsWith("glm-")) return { provider: "zai", model };
  if (m.startsWith("qwen")) return { provider: "qwen", model };
  if (m.startsWith("minimax-")) return { provider: "minimax", model };
  if (m.startsWith("mimo-")) return { provider: "mimo", model };
  return { provider: "anthropic", model };
}

/** Providers the gateway serves: Anthropic-format ones as they are, OpenAI
 *  (Responses) and Gemini (Chat Completions) through core's translator
 *  (Part A2, 10 Nov 2026); Z.ai, Qwen, MiniMax and MiMo on their own
 *  Anthropic-format endpoints (10 Nov 2026). */
const SERVED = new Set<SupplyProviderName>(["anthropic", "deepseek", "moonshot", "openai", "gemini", "zai", "qwen", "minimax", "mimo"]);

type Route =
  | { provider: SupplyProviderName; path: string; body: Buffer | null; estimate?: number }
  | { error: string; status: number };

/** Where a call goes: the provider, its path, and the body with the model
 *  name as that provider knows it. */
export function routeOf(method: string, pathname: string, body: Buffer | null): Route {
  if (method === "GET") return { provider: "anthropic", path: pathname, body: null };
  let json: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse((body ?? Buffer.alloc(0)).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    json = parsed as Record<string, unknown>;
  } catch {
    return { error: "the request body is not a JSON object", status: 400 };
  }
  const named = typeof json.model === "string" ? json.model.trim() : "";
  if (!named) return { error: "the request names no model", status: 400 };
  const r = providerOfModel(named);
  if (!r) return { error: `${named}: no provider of that name — write anthropic/, openai/, gemini/, deepseek/, kimi/, zai/, qwen/, minimax/ or mimo/ before the model, or a model name with a known prefix (claude-, gpt-, gemini-, deepseek-, kimi-, glm-, qwen, minimax-, mimo-)`, status: 400 };
  if (!SERVED.has(r.provider)) return { error: `${r.provider}'s models are not offered through the gateway`, status: 400 };
  const sp = SUPPLY_PROVIDERS[r.provider];
  if (pathname === "/v1/messages/count_tokens") {
    if (r.provider === "anthropic") return { provider: "anthropic", path: pathname, body: rewrite(json, named, r.model, body) };
    // No count route there: about four bytes a token, marked as an estimate.
    return { provider: r.provider, path: pathname, body: null, estimate: Math.ceil((body?.byteLength ?? 0) / 4) };
  }
  const path = r.provider === "anthropic" ? pathname : sp.metered[0]!;
  return { provider: r.provider, path, body: rewrite(json, named, r.model, body) };
}

function rewrite(json: Record<string, unknown>, named: string, model: string, body: Buffer | null): Buffer | null {
  if (named === model) return body;
  return Buffer.from(JSON.stringify({ ...json, model }));
}

/** The beta a Claude login token is sent with: the Messages API takes such a
 *  token as a Bearer only under it. */
export const OAUTH_BETA = "oauth-2025-04-20";

/** The operator's Claude login token: FOLDRUN_GATEWAY_LOGIN_FILE (the
 *  mounted secret the refresher rewrites), read fresh every call; else
 *  CLAUDE_CODE_OAUTH_TOKEN. Null when neither holds one. */
export function loginToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const file = env.FOLDRUN_GATEWAY_LOGIN_FILE;
  if (file) {
    try {
      const v = fs.readFileSync(file, "utf8").trim();
      if (v) return v;
    } catch {
      // unreadable: the environment's, below
    }
  }
  return env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || null;
}

/** The operator's Claude logins as a pool, where the install has one
 *  (billing().loginPool); null: the single login above. */
let loginPoolFn: () => LoginPool | null = () => billing().loginPool?.() ?? null;
export function setGatewayLoginPoolForTests(fn: (() => LoginPool | null) | null): void {
  loginPoolFn = fn ?? (() => billing().loginPool?.() ?? null);
}

/** The model a request body names, or null. */
function namedModel(body: Buffer | null): string | null {
  if (!body) return null;
  try {
    const m = (JSON.parse(body.toString("utf8")) as { model?: unknown }).model;
    return typeof m === "string" && m.trim() ? m.trim() : null;
  } catch {
    return null;
  }
}

/** Whether an account may use the operator's Claude login: the accounts the
 *  operator allows its own model credential (the console's grant, or
 *  FOLDRUN_PLATFORM_KEY_ACCOUNTS) — the same rule its desks' runs follow. */
let loginAllowedFn = (tenant: string) => platformKeyAllowedFor(tenant, edition() === "hosted");
export const loginAllowed = (tenant: string) => loginAllowedFn(tenant);
export function setGatewayLoginAllowedForTests(fn: ((tenant: string) => boolean) | null): void {
  loginAllowedFn = fn ?? ((tenant) => platformKeyAllowedFor(tenant, edition() === "hosted"));
}

let server: http.Server | null = null;
let lastDbDownLog = 0;
let doorDraining = false;
const openSockets = new Set<import("node:net").Socket>();
/** How long a drain waits for nginx to retire its pooled connections before
 *  closing what is left: past nginx's upstream keepalive_timeout (60 s). */
const IDLE_RETIRE_MS = 70_000;

/** Start the door. Idempotent. A no-op unless FOLDRUN_GATEWAY_PORT is set or
 *  `force` — the egress role starts it only where infra exposes it. */
export function startGatewayDoor(listenPort = port()): Promise<{ port: number; close: (graceMs?: number) => Promise<boolean> }> {
  return new Promise((resolve, reject) => {
    if (server) {
      const a = server.address();
      return resolve({ port: typeof a === "object" && a ? a.port : listenPort, close: stopGatewayDoor });
    }
    const s = http.createServer((req, res) => {
      // Draining: this response is the connection's last, said so, and the
      // CLIENT (nginx) retires the connection after it — no race (below).
      if (doorDraining) res.setHeader("connection", "close");
      handle(req, res).catch((err) => {
        // The database not answering is an outage to wait out, said as one:
        // a 503 with Retry-After, which Claude Code retries, and nothing was
        // sent to the provider (admission comes first). Anything else is ours.
        if (databaseDown(err)) {
          // Once, then at most every 30 s: an outage under load is thousands
          // of these a second.
          if (Date.now() - lastDbDownLog > 30_000) {
            lastDbDownLog = Date.now();
            opsError("gateway.database_unavailable", err);
          }
          return fail(res, 503, "foldrun's database is not answering, so the call was not made — retry in a few seconds", { "retry-after": "5" });
        }
        opsError("gateway.door_failed", err);
        fail(res, 500, "the gateway failed on this request");
      });
    });
    s.requestTimeout = 0; // a model call streams for minutes
    // Idle kept-alive connections stay open longer than nginx keeps them
    // (its upstream keepalive_timeout, 60 s), so nginx is always the side
    // that closes an idle one — never this server while nginx sends on it.
    s.keepAliveTimeout = 75_000;
    s.headersTimeout = 76_000;
    s.on("connection", (sock) => {
      openSockets.add(sock);
      sock.on("close", () => openSockets.delete(sock));
    });
    s.on("error", reject);
    s.listen(listenPort, "0.0.0.0", () => {
      server = s;
      const a = s.address();
      resolve({ port: typeof a === "object" && a ? a.port : listenPort, close: stopGatewayDoor });
    });
  });
}

/** Stop taking new calls, let the open ones finish — a coding agent's reply
 *  streams for minutes — and close what is still open at `graceMs` (Codex
 *  review, 10 Nov 2026: closing at once cut every call in flight on a
 *  deploy, each charged at its hold). The egress role's SIGTERM drains this
 *  and the proxy together. Resolves true when everything finished on its own. */
export function stopGatewayDoor(graceMs = 0): Promise<boolean> {
  return new Promise((resolve) => {
    const s = server;
    server = null;
    if (!s) return resolve(true);
    let forced = false;
    const timer = setTimeout(() => {
      forced = true;
      s.closeAllConnections?.();
    }, graceMs);
    const finish = () => {
      // Stop listening and close what is idle; open streams finish (graceMs).
      s.close(() => {
        clearTimeout(timer);
        doorDraining = false;
        resolve(!forced);
      });
      s.closeIdleConnections?.();
    };
    if (graceMs <= 0) return finish();
    // A drain (SIGTERM, 10 Nov 2026). Closing nginx's pooled keep-alive
    // connections the moment the drain began raced with nginx sending on
    // them: a few 502s each time a pod stopped (dev: 3, then 1, ~5 s after a
    // kill). Instead every response now says Connection: close, so nginx
    // retires each connection itself after its next response; the rest go
    // when nginx's own idle timeout closes them. Then, at most
    // IDLE_RETIRE_MS (or half the deadline) later, the server closes.
    doorDraining = true;
    const started = Date.now();
    const wait = setInterval(() => {
      // At most half the deadline, so a stream still open has the rest.
      if (openSockets.size === 0 || Date.now() - started >= Math.min(IDLE_RETIRE_MS, graceMs / 2)) {
        clearInterval(wait);
        finish();
      }
    }, 250);
  });
}
