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
//   POST /v1/foldrun/browse        one page in a cloud browser (browse-jobs.ts):
//                                  the laptop's browser=cloud, priced per call
// — Anthropic models only; the key's own limits sit on top of the account's
// balance and daily supply limit. Spend is booked against the job
// `gateway:<key id>`, kind "coding", so a key's usage is its own.

import { checkBrowseInput, replayBrowse, runBrowse, type BrowseInput } from "./browse-jobs.ts";
import { mediaToText } from "./gateway-media.ts";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { opsError } from "../../foldrun-core/src/ops-log.ts";
import { databaseEnabled } from "./db.ts";
import { API_KEY_CHANNEL, findApiKeyByHashDb, meterJobOf, modelGrantOf, touchApiKeyDb, type GatewayGrant } from "./api-keys-db.ts";
import { listen } from "./pg-listen.ts";
import { SUPPLY_PROVIDERS, type SupplyProviderName } from "../../foldrun-core/src/model-supply.ts";
import { providerPreset } from "../../foldrun-core/src/providers.ts";
import { ToolCallExtras, toResponses, toChatCompletions, fromResponses, fromChatCompletion, StreamTranslator, ResponsesStreamTranslator, UnfinishedReply } from "../../foldrun-core/src/translator.ts";
import { dayOf, spentByJob } from "./model-usage.ts";
import { accountStands, admitCall, premiumAsk, standardTier, listedPrice, offeredProviders, priceProblem, chargeMargin, holdToolCall, supplyHostOf, supplyKeyOf, supplySchemeOk, UsageReader, type CallWho, type MeteredCall, type PricedTool } from "./model-gateway.ts";
import { billing, type LoginPool } from "./billing.ts";
import { entitlementOf } from "./entitlement.ts";
import { fetchPublic } from "./ssrf.ts";
import { cache, rateLimit } from "./cache.ts";
import { customerProblem } from "../../foldrun-core/src/customer.ts";
import { logDroppedBetas, modelRequestHeaders, modelRequestIdentity } from "./gateway-identity.ts";
import { admitCustomerCall, CustomerRefused } from "./customers.ts";
import { platformKeyAllowedFor, setting } from "./settings.ts";
import { catalogError } from "./error-catalog.ts";
import { noticeFor, noticeHeaders } from "./network-front.ts";
import { accountRoute, codeTierModel, ownModelKeysOn, providerOfModel } from "./model-choice.ts";
export { codeTierModel, providerOfModel };
import { edition } from "./ledger.ts";
import { MAX_BYTES as TRANSCRIBE_MAX_BYTES, MAX_SECONDS as TRANSCRIBE_MAX_SECONDS, langProblem, transcribe, TranscribeError } from "./transcribe.ts";
import { opsLog } from "../../foldrun-core/src/ops-log.ts";
import { isReadSafeHost } from "../../foldrun-core/src/test-mode.ts";
import { PassThrough, Writable } from "node:stream";
import { DEBATE_MAX_TOKENS, DEBATE_SYSTEM, debatePrompt, RESULT_TEXT_MAX, reviewText, lowerMessages, lowerRequest, REVIEW_SYSTEM, reviewOf, reviewPrompt, runServerToolLoop, runServerToolLoopStream, secondModelOf, SERVER_TOOL_TYPES, ServerToolRefusal, serverToolsOf, type ConsultError, type ConsultResult, type Sent, type ServerToolConfig, type ToolRunners } from "./server-tools.ts";
import { platformRunners } from "./server-tool-runners.ts";
import { claimReview, finishReview, forgetReview } from "./review-calls.ts";


const port = () => Number(process.env.FOLDRUN_GATEWAY_PORT) || 8091;
/** The most a request body may be (a long transcript with images). */
const MAX_BODY = 32 * 1024 * 1024;
const IDLE_MS = 10 * 60_000;

/** A reply stream that goes quiet this long gets a `ping` event: Cloudflare
 *  closes a connection that carries no byte for 100 s, which a client behind
 *  it sees as ECONNRESET. */
export const KEEPALIVE_MS = 15_000;

/** Anthropic's own keep-alive event, which every client of the Messages
 *  stream already ignores. */
export const SSE_PING = 'event: ping\ndata: {"type": "ping"}\n\n';

/** Writes SSE_PING when no byte has gone out for `everyMs`, and only between
 *  two events (the last bytes written end a blank line), so a ping never
 *  lands inside a half-written event. Call wrote() for every chunk sent and
 *  stop() when the reply ends. */
export function sseKeepAlive(res: http.ServerResponse, everyMs: number = Number(process.env.FOLDRUN_GATEWAY_KEEPALIVE_MS) || KEEPALIVE_MS): { wrote: (chunk: Uint8Array | string) => void; stop: () => void } {
  let tail = "\n\n";
  let last = Date.now();
  const timer = setInterval(() => {
    if (res.destroyed || res.writableEnded || res.writableNeedDrain) return;
    if (!/\r?\n\r?\n$/.test(tail)) return;
    if (Date.now() - last >= everyMs) {
      last = Date.now();
      res.write(SSE_PING);
    }
  }, Math.max(10, Math.floor(everyMs / 3)));
  timer.unref();
  return {
    wrote(chunk) {
      last = Date.now();
      const t = typeof chunk === "string" ? chunk : Buffer.from(chunk.subarray(Math.max(0, chunk.length - 4))).toString("latin1");
      tail = (tail + t).slice(-4);
    },
    stop: () => clearInterval(timer),
  };
}

/** What it does not hand back: hop-by-hop, and what names the platform's own
 *  Anthropic organisation and rate state. */
// x-foldrun-notice*: the operator's notice is the gateway's own (FOL-402); an upstream never sets or replaces it.
const DROP_BACK = /^(connection|keep-alive|transfer-encoding|content-encoding|content-length|set-cookie|anthropic-organization-id|anthropic-workspace-id|anthropic-ratelimit-.*|retry-after-ms|x-foldrun-notice(-id)?)$/i;

const ERR_TYPES: Record<number, string> = { 400: "invalid_request_error", 401: "authentication_error", 402: "billing_error", 403: "permission_error", 404: "not_found_error", 413: "request_too_large", 429: "rate_limit_error", 500: "api_error", 502: "api_error", 503: "overloaded_error" };

/** Who a response is for, once the gateway key is resolved (or found and
 *  refused): what a refusal is recorded against in the operations log, so
 *  the operator console can show an account's refused calls (D239 phase 1). */
interface Caller {
  tenant?: string;
  key?: string;
  surface: "gateway" | "transcribe" | "usage" | "browse" | "review";
  /** The model the call names, once serveModelCall has read it (19 Nov
   *  2026): a `login_share` refusal said which key, not which model, and a
   *  plan's share is counted per model. An id, or the line drops it. */
  model?: string;
}
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
    opsLog(status >= 500 ? "error" : "warn", "gateway.refused", { surface: who?.surface ?? "gateway", status, reason: reason ?? REASONS[status] ?? "refused", tenant: who?.tenant, key: who?.key, model: who?.model });
  }
  if (res.headersSent) return void res.end();
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra });
  // The reason a program can branch on rides beside Anthropic's own fields
  // (23 Nov 2026): subscription_required, model_not_in_plan, no_supply_key…
  // and, from the catalog (FOL-402), the message leads with what to do and
  // error.foldrun says it again for a program (error-catalog.ts).
  res.end(JSON.stringify({ type: "error", error: catalogError(ERR_TYPES[status] ?? "api_error", message, reason, status) }));
}

export interface GatewayWho {
  keyId: string;
  /** FOL-168: this key's calls must name an end customer (x-foldrun-customer). */
  requireCustomer?: boolean;
  /** An API key's model grant (one key), not a gateway key. */
  apiKey?: boolean;
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
  // A key with a model grant opens this door: a gateway key (which opens
  // nothing else — the web funnel refuses it), or an API key given model
  // access when it was made (one key, 22 Nov 2026: `foldrun login`, or a CI
  // key with { models }). An API key without that grant, and an A2A key,
  // are refused here, not honoured — each keeps exactly its old reach.
  const grant = modelGrantOf(record);
  if (!grant) {
    if (record.purpose === undefined && !record.scope) return { status: 403, message: "this API key has no model access — make one with it (`foldrun login`, or `foldrun keys create <label> --model-access --daily <usd>`) or mint a gateway key on Settings → API keys", reason: "no_model_grant", tenant: record.tenant, keyId: record.id };
    return { status: 403, message: "this is not a gateway key — mint one on Settings → API keys (or `foldrun keys create --gateway`)", reason: "not_gateway_key", tenant: record.tenant, keyId: record.id };
  }
  await noteUse(record, now);
  return { who: { keyId: record.id, tenant: record.tenant, grant, ...(record.requireCustomer ? { requireCustomer: true } : {}), ...(record.purpose === undefined ? { apiKey: true } : {}) } };
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
  const job = meterJobOf(who.keyId, who.grant);
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
  if (status === 403 && /no model access/.test(message)) return "foldrun · key has no model access";
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
  // Not metered yet, so no model budget could hold it: an API key's model
  // grant (one key, 22 Nov 2026) opens the metered routes only, and
  // transcription stays a gateway key's (Codex review).
  if (who.apiKey) return fail(res, 403, "transcription is not metered yet, so it takes a gateway key — an API key's model access opens /v1/messages, count_tokens, /v1/models and /v1/usage", {}, "not_gateway_key");
  // The end customer (FOL-168), checked before the key's buckets as on
  // /v1/messages: a blocked or busy customer never spends the key's
  // allowance, and a block list that cannot be read refuses.
  let customerHeld: { release: () => Promise<void> } | null = null;
  const rawCustomer = req.headers["x-foldrun-customer"];
  // A key that requires one refuses a recording that names none, as a call does.
  if (who.requireCustomer && rawCustomer === undefined) return fail(res, 400, "this key requires an end customer on every call: send x-foldrun-customer");
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
        // The account's own Whisper pods when tools are on demand (tool-pod.ts).
        const t = await transcribe(Buffer.concat(chunks), lang, process.env, cancel.signal, who.tenant);
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

/** What a browse job's error is as an HTTP status on the laptop route. */
const BROWSE_STATUS: Record<string, number> = { duplicate: 409, invalid_tool_input: 400, too_many_requests: 429, timeout: 504, outcome_unknown: 502, url_not_accessible: 502, screenshot_too_large: 413, unavailable: 503 };

/** POST /v1/foldrun/browse (FOL-313, FOL-304): `{url, steps?, mode?}` in —
 *  the same typed input as web_browse — `{url, text}` or `{url, screenshot}`
 *  out. One page in a cloud browser (a single-use pod run by the worker),
 *  for the laptop's browser=cloud. Priced by the browser-minute at the
 *  operator's price (pricing.tool_web_browse_minute, one minute at least), paid as a /v1/messages tool call is — the
 *  plan first where it has room, then the wallet or pay as you go — and
 *  charged only when the page came back. */
async function browseRoute(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const cancel = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) cancel.abort();
  });
  if (!lookupReplaced && !databaseEnabled()) return fail(res, 503, "the gateway needs the platform's database");
  const auth = await authenticate(req.headers);
  if ("status" in auth) {
    noteCaller(res, { tenant: auth.tenant, key: auth.keyId, surface: "browse" });
    return fail(res, auth.status, auth.message, {}, auth.reason);
  }
  const { who } = auth;
  noteCaller(res, { tenant: who.tenant, key: who.keyId, surface: "browse" });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) return fail(res, 413, "a browse request is at most 64 KB");
    chunks.push(c as Buffer);
  }
  // Decoded once, so a character split between chunks stays whole (Codex).
  const raw = Buffer.concat(chunks).toString("utf8");
  let body: unknown;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return fail(res, 400, "the body is JSON: {url, steps?, mode?}");
  }
  const checked = checkBrowseInput(body);
  if ("error" in checked) return fail(res, 400, checked.message, {}, checked.error);
  // Idempotency-Key (Codex): a retry of a call already made gets that
  // call's answer, never a second browser and never a second charge.
  const rawIdem = req.headers["idempotency-key"];
  const invocation = typeof rawIdem === "string" ? rawIdem.trim() : undefined;
  if (invocation !== undefined && !/^[\x21-\x7e]{1,255}$/.test(invocation)) return fail(res, 400, "Idempotency-Key is 1–255 visible characters");
  // The end customer (FOL-168), as on /v1/messages: required where the key
  // says so, checked against the block list, held while the call runs.
  const rawCustomer = req.headers["x-foldrun-customer"];
  if (who.requireCustomer && rawCustomer === undefined) return fail(res, 400, "this key requires an end customer on every call: send x-foldrun-customer");
  let customer: string | undefined;
  let customerHeld: { release: () => Promise<void> } | null = null;
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
    customer = v as string;
  }
  try {
    // Bound to the key and the customer: another key's or customer's call
    // with the same Idempotency-Key is its own, never this one's answer.
    const bound = invocation ? `laptop|${who.keyId}|${customer ?? ""}|${invocation}` : undefined;
    // A retry is answered from the first call before any hold (Codex): an
    // answer already paid for is never refused for budget, nor charged again.
    if (bound) {
      const answer = await replayBrowse(who.tenant, bound, checked.input, cancel.signal);
      if (answer) {
        if (!answer.ok) return fail(res, BROWSE_STATUS[answer.error] ?? 502, answer.message, {}, answer.error);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "idempotent-replayed": "true" });
        return void res.end(JSON.stringify(answer.result));
      }
    }
    await browseCall(res, who, checked.input, customer, bound, cancel.signal);
  } finally {
    await customerHeld?.release();
  }
}

async function browseCall(res: http.ServerResponse, who: Extract<Awaited<ReturnType<typeof authenticate>>, { who: unknown }>["who"], input: BrowseInput, customer: string | undefined, invocation: string | undefined, signal: AbortSignal): Promise<void> {
  const rate = await rateLimit(`gwb:${who.keyId}`, 30, 60);
  if (!rate.allowed) return fail(res, 429, "this key may open 30 pages a minute in the cloud browser — wait a moment", { "retry-after": String(rate.retryAfter) });
  const meterAs: CallWho = { tenant: who.tenant, kind: "coding", job: meterJobOf(who.keyId, who.grant), jobLimits: { capUsd: who.grant.capUsd ?? null, dailyUsd: who.grant.dailyUsd ?? null, ...(who.grant.credential === "account" ? { walletUsd: Math.max(0, who.grant.walletUsd ?? 0) } : {}) }, ...(customer ? { customer } : {}) };
  const payer = who.grant.credential === "login" ? loginTools(meterAs) : meterAs;
  if (signal.aborted) return;
  const held = await holdToolCall(payer, "web_browse", "anthropic").catch(() => ({ ok: false as const, message: "the meter did not answer" }));
  if (!held.ok) return fail(res, 402, `foldrun's tools: ${held.message}`, {}, "tool_refused");
  let ok = false;
  try {
    const answer = await runBrowse({ tenant: who.tenant, keyId: who.keyId, input, ...(invocation ? { invocation } : {}), signal });
    if (!answer.ok) return fail(res, BROWSE_STATUS[answer.error] ?? 502, answer.message, {}, answer.error);
    // A replay was charged when it first ran.
    ok = !answer.replayed;
    opsLog("info", "gateway.server_tools", { tenant: who.tenant, key: who.keyId, kind: "browse", count: 1, provider: "foldrun-browser", streaming: false });
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", ...(answer.replayed ? { "idempotent-replayed": "true" } : {}) });
    res.end(JSON.stringify(answer.result));
  } finally {
    await held.close(ok).catch((err) => opsError("gateway.tool_charge_failed", err, { tenant: who.tenant, kind: "web_browse" }));
  }
}

/** What a review's refusal is as an HTTP status on the laptop route. */
const REVIEW_STATUS: Record<string, number> = { invalid_tool_input: 400, model_not_allowed: 400, input_too_long: 413, payment_required: 402, too_many_requests: 429, unavailable: 503 };
/** A review request may weigh this much: the diff and files are capped at REVIEW_INPUT_MAX characters inside it. */
const REVIEW_BODY_MAX = 1024 * 1024;

/** POST /v1/foldrun/review (FOL-417): `{diff, files?, instructions?, model?,
 *  against?, max_tokens?}` in — the review a model of another provider makes
 *  of the change — `{model, summary, findings, dropped, usage}` out. The
 *  laptop's door for foldrun code's local review: koder gathers the diff
 *  itself, so its own model never has to write the patch out as tokens. The
 *  same reviewer, prompt, checks and meter as the foldrun_review server tool.
 *  `model` names the reviewer; or `against` names the caller's own provider
 *  and the console's pair answers. An Idempotency-Key replays a finished
 *  review free. */
async function reviewRoute(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const cancel = new AbortController();
  let gone = false;
  res.on("close", () => {
    if (!res.writableFinished) {
      gone = true;
      cancel.abort();
    }
  });
  if (!lookupReplaced && !databaseEnabled()) return fail(res, 503, "the gateway needs the platform's database");
  const auth = await authenticate(req.headers);
  if ("status" in auth) {
    noteCaller(res, { tenant: auth.tenant, key: auth.keyId, surface: "review" });
    return fail(res, auth.status, auth.message, {}, auth.reason);
  }
  const { who } = auth;
  noteCaller(res, { tenant: who.tenant, key: who.keyId, surface: "review" });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > REVIEW_BODY_MAX) return fail(res, 413, `a review request is at most ${REVIEW_BODY_MAX / 1024 / 1024} MB`, {}, "input_too_long");
    chunks.push(c as Buffer);
  }
  let body: Record<string, unknown>;
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    body = v as Record<string, unknown>;
  } catch {
    return fail(res, 400, "the body is JSON: {diff, files?, instructions?, model? | against?, max_tokens?}", {}, "invalid_tool_input");
  }
  // Who reviews: a model named `provider/model`, or the console's pair for the caller's own provider.
  const model = body.model;
  const against = body.against;
  if (model !== undefined && (typeof model !== "string" || !providerOfModel(model) || !model.includes("/"))) return fail(res, 400, "model is written provider/model, e.g. openai/<model>", {}, "invalid_tool_input");
  if (against !== undefined && (typeof against !== "string" || !(against in SUPPLY_PROVIDERS))) return fail(res, 400, `against names the provider of the model that wrote the change: ${Object.keys(SUPPLY_PROVIDERS).join(", ")}`, {}, "invalid_tool_input");
  if (model === undefined && against === undefined) return fail(res, 400, "say who reviews: model (provider/model), or against (your own model's provider) for the platform's choice", {}, "invalid_tool_input");
  const maxTokens = body.max_tokens ?? DEBATE_MAX_TOKENS.default;
  if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < DEBATE_MAX_TOKENS.min || maxTokens > DEBATE_MAX_TOKENS.max) return fail(res, 400, `max_tokens is a whole number from ${DEBATE_MAX_TOKENS.min} to ${DEBATE_MAX_TOKENS.max}`, {}, "invalid_tool_input");
  const made = reviewPrompt(body);
  if ("error" in made) return fail(res, REVIEW_STATUS[made.error]!, made.error === "input_too_long" ? "the diff and files together are too long for one review: send fewer files, or review in parts" : "diff is a unified diff (as git diff prints it); files, if any, are [{path, content}]; instructions is text", {}, made.error);
  const rawIdem = req.headers["idempotency-key"];
  const invocation = typeof rawIdem === "string" ? rawIdem.trim() : undefined;
  if (invocation !== undefined && !/^[\x21-\x7e]{1,255}$/.test(invocation)) return fail(res, 400, "Idempotency-Key is 1–255 visible characters");
  const rawCustomer = req.headers["x-foldrun-customer"];
  if (who.requireCustomer && rawCustomer === undefined) return fail(res, 400, "this key requires an end customer on every call: send x-foldrun-customer");
  let customer: string | null = null;
  let customerHeld: { release: () => Promise<void> } | null = null;
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
    customer = v as string;
  }
  // Bound to the key and the customer: another's call with the same key is its own.
  const bound = invocation ? `review|${who.keyId}|${customer ?? ""}|${invocation}` : null;
  // Over the input as given, not the prompt built from it: two requests that
  // make the same prompt can still check findings against different files (Codex).
  const inputHash = crypto.createHash("sha256").update(JSON.stringify([model ?? null, against ?? null, maxTokens, made.parts])).digest("hex");
  // The claim this call holds, freed only while nothing has been paid.
  let claim: string | null = null;
  try {
    if (bound) {
      // A retry is answered from the first call before any hold: an answer
      // already paid for is never refused for budget, nor charged again.
      const c = await claimReview(who.tenant, bound, inputHash);
      if (c.kind === "conflict") return fail(res, 409, "this Idempotency-Key was used for another review", { "x-should-retry": "false" }, "idempotency_conflict");
      if (c.kind === "running") return fail(res, 409, "a review with this Idempotency-Key is still running — ask again in a moment", { "retry-after": "5" }, "in_progress");
      if (c.kind === "lost") return fail(res, 409, "the review under this Idempotency-Key never finished, and may have been charged; it is not run again under the same key — send a new key to run it again", { "x-should-retry": "false" }, "idempotency_lost");
      if (c.kind === "replay") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "idempotent-replayed": "true" });
        return void res.end(JSON.stringify(c.result));
      }
      claim = c.owner;
    }
    const rate = await rateLimit(`gwr:${who.keyId}`, 30, 60);
    if (!rate.allowed) return fail(res, 429, "this key may ask for 30 reviews a minute — wait a moment", { "retry-after": String(rate.retryAfter) }, "too_many_requests");
    const meterAs: CallWho = { tenant: who.tenant, kind: "coding", job: meterJobOf(who.keyId, who.grant), jobLimits: { capUsd: who.grant.capUsd ?? null, dailyUsd: who.grant.dailyUsd ?? null, ...(who.grant.credential === "account" ? { walletUsd: Math.max(0, who.grant.walletUsd ?? 0) } : {}) }, ...(customer ? { customer } : {}) };
    // Paid as a tool call of the key is (as browse is): a login key's plan
    // allowance first, then pay as you go by its own switch (one subscription
    // pays for everything, owner 26 Nov 2026); the call itself is on the
    // platform's API key, never the login (callSecondModel).
    const payer = who.grant.credential === "login" ? loginTools(meterAs) : meterAs;
    const got = await callSecondModel({ req, who, customer, isGone: () => gone }, payer, (against as SupplyProviderName | undefined) ?? null, { ...(typeof model === "string" ? { model } : {}), maxTokens, system: REVIEW_SYSTEM, prompt: made.prompt }, cancel.signal);
    if ("error" in got && got.maybeCharged && bound && claim) {
      // It may have reached the provider and been billed: the key stays taken
      // (in progress, then idempotency_lost), so a retry never buys it twice (Codex).
      claim = null;
    }
    if (!("error" in got) && bound && claim) {
      // Paid for: from here the key keeps it, whatever happens to the answer's way back.
      const owner = claim;
      claim = null;
      await finishReview(who.tenant, bound, owner, reviewOf(got.result, made.sent)).catch((err) => opsError("gateway.review_finish_failed", err, { tenant: who.tenant }));
    }
    if (gone) return;
    if ("error" in got) return fail(res, REVIEW_STATUS[got.error] ?? 503, got.error === "model_not_allowed" ? "the reviewer must be a model of another provider than yours" : got.error === "unavailable" ? "that reviewer cannot be reached here: it has no key or no price on this platform, or it did not answer" : got.error, {}, got.error);
    const review = reviewOf(got.result, made.sent);
    opsLog("info", "gateway.server_tools", { tenant: who.tenant, key: who.keyId, kind: "review", count: 1, provider: got.via, streaming: false });
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(review));
  } finally {
    if (claim && bound) await forgetReview(who.tenant, bound, claim).catch((err) => opsError("gateway.review_forget_failed", err, { tenant: who.tenant }));
    await customerHeld?.release();
  }
}

/**
 * A second opinion a cloud step asks for (FOL-444): its `debate` or `review`
 * tool posts to the lease's /second door (egress-proxy.ts), which checks the
 * lease's grant and builds the caller from the lease alone; here is the call
 * itself: the same prompts, checks, reviewer and meter as the server tools
 * and POST /v1/foldrun/review, on the platform's key, metered to the run's
 * step. `max_usd` is what the step's budget has left: a call whose worst case
 * (its prompt at three characters a token, and all of max_tokens) costs more
 * is refused before anything is sent. Answers what the tool shows the model,
 * with the call's tokens and their list price.
 */
export async function secondOpinionOfRun(
  c: {
    req: http.IncomingMessage;
    who: GatewayWho;
    payer: CallWho;
    customer: string | null;
    testRun: boolean;
    isGone: () => boolean;
    firstProvider: SupplyProviderName;
    model: string;
    tools: readonly ("debate" | "review")[];
    /** Held before the call: one use of `tool` and `worstUsd`, against the lease's own limits and ceiling; false
     *  when either is spent. Settled after it with what the call cost (or released when nothing was sent). */
    reserve: (tool: "debate" | "review", worstUsd: number) => Promise<{ ok: true; settle: (usd: number | null) => Promise<void> } | { ok: false; why: string }>;
  },
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const no = (status: number, error: string, message: string, more: Record<string, unknown> = {}) => ({ status, body: { error, message, ...more } });
  const tool = body.tool;
  if (tool !== "debate" && tool !== "review") return no(400, "invalid_tool_input", "tool is debate or review");
  if (!c.tools.includes(tool)) return no(403, "not_granted", `this step's agent does not hold ${tool} (tools: [${tool}])`);
  const input = body.input && typeof body.input === "object" && !Array.isArray(body.input) ? (body.input as Record<string, unknown>) : null;
  if (!input) return no(400, "invalid_tool_input", "input is the tool's input, an object");
  const maxTokens = body.max_tokens ?? DEBATE_MAX_TOKENS.default;
  if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < DEBATE_MAX_TOKENS.min || maxTokens > DEBATE_MAX_TOKENS.max) {
    return no(400, "invalid_tool_input", `max_tokens is a whole number from ${DEBATE_MAX_TOKENS.min} to ${DEBATE_MAX_TOKENS.max}`);
  }
  const maxUsd = body.max_usd ?? null;
  if (maxUsd !== null && (typeof maxUsd !== "number" || !Number.isFinite(maxUsd) || maxUsd < 0)) return no(400, "invalid_tool_input", "max_usd is the dollars the step has left, 0 or more");
  const made = tool === "debate" ? debatePrompt(input) : reviewPrompt(input);
  if ("error" in made) {
    const why =
      made.error === "input_too_long"
        ? tool === "review" ? "the diff and files together are too long for one review: send fewer files, or review in parts" : "the topic, position and context together are too long"
        : tool === "review" ? "diff is a unified diff (as git diff prints it); files, if given, are [{path, content}]" : "topic is the question; position and context are text";
    return no(REVIEW_STATUS[made.error] ?? 400, made.error, why);
  }
  const system = tool === "debate" ? DEBATE_SYSTEM : REVIEW_SYSTEM;
  const target = providerOfModel(c.model);
  const price = target ? listedPrice(target.provider, target.model) : null;
  // What the account is charged: the list price at the margin in force, as the meter charges it (Codex).
  const margin = chargeMargin();
  // Input at the dearest input rate there is (a cache write can cost more than plain input; Codex): it can
  // only be over what the meter charged, never under.
  const inRate = price ? Math.max(price.inputPerMTok, price.cacheWritePerMTok ?? 0, price.cacheReadPerMTok ?? 0) : 0;
  const costOf = (inTok: number, outTok: number) => (price ? ((inTok * inRate + outTok * price.outputPerMTok) / 1e6) * margin : null);
  // The worst case, bounded from above: never more tokens in than the request's UTF-8 bytes (with room for the
  // message framing), and all of max_tokens out (Codex: characters / 3 undercounts CJK text).
  const worst = costOf(Buffer.byteLength(system, "utf8") + Buffer.byteLength(made.prompt, "utf8") + 64, maxTokens);
  if (worst === null) return no(503, "unavailable", `${c.model} has no price on this platform; nothing was sent`);
  if (maxUsd !== null && worst > maxUsd) return no(402, "over_budget", `this ${tool} could cost up to $${worst.toFixed(4)} and the step has $${maxUsd.toFixed(4)} left of its budget; nothing was sent`);
  // Held at the door, whatever the sandbox said: the lease's own limits and ceiling, atomically (Codex).
  const held = await c.reserve(tool, worst);
  if (!held.ok) return no(402, "over_budget", `${held.why}; nothing was sent`);
  let settled = false;
  const settle = async (usd: number | null) => {
    if (settled) return;
    settled = true;
    await held.settle(usd).catch((err) => opsError("gateway.second_settle_failed", err, { tenant: c.who.tenant }));
  };
  try {
    const got = await callSecondModel({ req: c.req, who: c.who, customer: c.customer, isGone: c.isGone, testRun: c.testRun }, c.payer, c.firstProvider, { model: c.model, maxTokens, system, prompt: made.prompt });
    if ("error" in got) {
      // Never sent: the hold is given back. Maybe sent: it stays at the worst case, and is said as that.
      await settle(got.maybeCharged ? worst : null);
      const message =
        got.error === "model_not_allowed"
          ? `${c.model} may not answer: a second opinion comes from another provider than this step's${c.testRun ? ", and a test run reaches read-safe hosts only" : ""}`
          : got.error === "payment_required"
            ? "the account's plan and wallet do not cover this call: upgrade or top up under Billing"
            : got.error === "too_many_requests"
              ? "too many model calls at once: try again in a moment"
              : `${c.model} cannot be reached here now (no key or no price for it on this platform, or the call failed)`;
      return no(got.error === "model_not_allowed" ? 403 : (REVIEW_STATUS[got.error] ?? 503), got.error, message, got.maybeCharged ? { maybe_charged: true, cost_usd: worst } : {});
    }
    const usage = got.result.usage;
    // No usage back is not free: it is counted at the worst case, as the meter settles it at its estimate (Codex).
    const costUsd = usage.input_tokens + usage.output_tokens > 0 ? (costOf(usage.input_tokens, usage.output_tokens) ?? worst) : worst;
    await settle(costUsd);
    opsLog("info", "gateway.server_tools", { tenant: c.who.tenant, key: c.who.keyId, kind: tool, count: 1, provider: got.via, streaming: false });
    if (tool === "debate") {
      const text = got.result.text.trim().slice(0, RESULT_TEXT_MAX);
      // Paid for, but no words: said as that, not as an answer.
      if (!text) return no(503, "unavailable", `${got.result.model} gave no answer`, { maybe_charged: true, model: got.result.model, usage, cost_usd: costUsd });
      return { status: 200, body: { tool, model: got.result.model, text, usage, cost_usd: costUsd } };
    }
    if (!("sent" in made)) return no(500, "unavailable", "review prompt without its file list");
    const review = reviewOf(got.result, made.sent as Sent);
    return { status: 200, body: { tool, model: got.result.model, text: reviewText(review), review, usage, cost_usd: costUsd } };
  } finally {
    // An exception on the way: what may have been sent stays held at the worst case.
    await settle(worst);
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
  if (method === "POST" && pathname === "/v1/foldrun/browse") return browseRoute(req, res);
  if (method === "POST" && pathname === "/v1/foldrun/review") return reviewRoute(req, res);
  const known = (method === "POST" && (pathname === "/v1/messages" || pathname === "/v1/messages/count_tokens")) || (method === "GET" && pathname === "/v1/models");
  // Which server tools this gateway runs itself (FOL-313), on every answer of
  // these routes: a client offers a server tool only to a gateway that says
  // it runs it, so none is ever forwarded to a provider by an older one.
  if (known) res.setHeader("foldrun-server-tools", Object.keys(SERVER_TOOL_TYPES).join(","));
  if (!known) return fail(res, 404, `${method} ${pathname} is not served here — this gateway offers POST /v1/messages, POST /v1/messages/count_tokens, GET /v1/models, GET /v1/usage, POST /v1/foldrun/transcribe, POST /v1/foldrun/browse and POST /v1/foldrun/review`);
  if (!lookupReplaced && !databaseEnabled()) return fail(res, 503, "the gateway needs the platform's database");

  const auth = await authenticate(req.headers);
  if ("status" in auth) {
    noteCaller(res, { tenant: auth.tenant, key: auth.keyId, surface: "gateway" });
    return fail(res, auth.status, auth.message, {}, auth.reason);
  }
  const { who } = auth;
  noteCaller(res, { tenant: who.tenant, key: who.keyId, surface: "gateway" });

  // A plan key (a Claude login) answers Claude Code alone: Anthropic refuses a
  // subscription call that is not Claude Code's with a bare 429, so another
  // client — Claude Desktop's chat, above all — met three retries and an
  // unexplained "429" (17 Nov 2026, two testers). Said here, plainly, and the
  // login is not asked at all. Runs on the plan come through serveModelCall
  // from the egress proxy, not this door. Still a 429, the status Anthropic
  // gave: Claude Desktop sends its own connection test this way and, on a
  // 429, shows a card and lets the Code tab work; how it takes another
  // status is not known, so only the words change.
  if (who.grant.credential === "login" && method === "POST" && pathname === "/v1/messages" && !fromClaudeCode(req.headers["user-agent"])) {
    const raw = await readBody(req);
    const probe = raw === "too-large" ? null : connectionTestOf(raw);
    // What the client was, never what it said: enough to tell Desktop's
    // test from its chat when a new version changes either.
    opsLog("info", "gateway.not_claude_code", { tenant: who.tenant, key: who.keyId, ...clientOf(req.headers["user-agent"]), answered: probe !== null, ...(probe ? { model: logModel(probe.model) } : {}), ...(raw === "too-large" ? {} : requestShape(raw)) });
    // Claude Desktop's own connection test (17 Nov 2026, owner: "remove
    // this"): answered here, a short OK, so its "Gateway returned an error"
    // card goes away. Nothing reaches Anthropic and nothing is counted.
    if (probe) return answerConnectionTest(res, probe);
    return fail(res, 429, NOT_CLAUDE_CODE, {}, "not_claude_code");
  }

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

  const q = (req.url ?? "").indexOf("?");
  return serveModelCall(req, res, who, { method, pathname, search: q >= 0 ? (req.url ?? "").slice(q) : "", customer, isGone: () => gone });
}

/** Who the call is metered as when it is metered (extra usage, or a key on
 *  foldrun's models): a gateway key's own job, or — for a run's call that
 *  came through the egress proxy — the run and its step. */
export interface ModelCallOptions {
  method: string;
  pathname: string;
  /** The query as it came ("" or "?…"), sent on unchanged. */
  search: string;
  /** FOL-168: the end customer, already checked by the caller. */
  customer: string | null;
  isGone: () => boolean;
  /** The admitCall caller for a metered call; default the key's own job. */
  meterAs?: CallWho;
  /** A login call only on a pooled login, never the install's own one
   *  (loginToken): a run on the subscription is counted, or not sent. */
  poolOnly?: boolean;
  /** A run's call on the operator's own credential (the egress proxy's
   *  door, SupplyGrant.via "operator", the account already asked): sent on
   *  that credential, not metered here — the step's own tokens are billed
   *  (store.ts supplyBillsTokens), so metering it too would charge twice. */
  operatorRun?: boolean;
  /** The lease says the door meters it (core OPERATOR_DOOR_TOKEN): the
   *  door is the step's one meter. Absent — a lease from an older worker,
   *  whose step bills its own tokens — sent unmetered, never both. */
  operatorMetered?: boolean;
  /** A run's call from the egress proxy (foldrun's door): the provider its
   *  lease was granted for — a model of another is refused — and whether
   *  the run is a test. The lease already carries the runner's decision on
   *  the credential: the account's route is not asked again here. */
  /** `secondModel`: the tools: [debate, review] grant the runner wrote on the lease (FOL-418); null, none. */
  fromLease?: { provider: SupplyProviderName; test: boolean; secondModel?: { tools: ("debate" | "review")[]; model: string } | null };
  /** The request body, already read (the server-tool loop reads it once and
   *  sends each round's own body). Absent: read from `req`. */
  body?: Buffer;
  /** A call the door makes itself to a second model, for foldrun_debate
   *  (FOL-416): always admitted and metered at the price list, on a platform
   *  API key — never a Claude login, the pool's or the operator's (Anthropic
   *  does not allow a subscription's credential to carry other people's
   *  requests; https://code.claude.com/docs/en/legal-and-compliance). */
  secondModel?: boolean;
}

/** Who answers the server tools' searches and fetches (a seam for tests). */
/** Who pays for the tools of a round served on a Claude login inside its
 *  share (FOL-313; best practice, owner delegated 25 Nov 2026): a Claude
 *  subscription includes search, so the account's plan allowance pays first
 *  where it has room (planCover not refused), then pay as you go by its own
 *  switch and limit — never a run's finish grace (optInOnly, Codex). */
export const loginTools = (meterAs: CallWho): CallWho => {
  const { planCover: _drop, ...rest } = meterAs;
  return { ...rest, optInOnly: true };
};

/** The runners with each call held and charged (FOL-313, holdToolCall):
 *  the payer is the latest round's; none yet (no round reached the meter)
 *  runs free. A call the meter refuses answers `unavailable`, costs nothing. */
export function pricedRunners(inner: ToolRunners, payerOf: () => { who: CallWho; provider: SupplyProviderName } | null, hold: typeof holdToolCall = holdToolCall): ToolRunners {
  const priced = async <T extends object>(tool: PricedTool, run: () => Promise<T>, refused: T): Promise<T> => {
    const p = payerOf();
    if (!p) return run();
    const h = await hold(p.who, tool, p.provider).catch(() => ({ ok: false as const, message: "the meter did not answer" }));
    if (!h.ok) return refused;
    let ok = false;
    try {
      const r = await run();
      // A replay of a call already charged is not charged again.
      ok = !("error" in r) && !("replayed" in r && r.replayed);
      return r;
    } finally {
      await h.close(ok).catch((err) => opsError("gateway.tool_charge_failed", err, { tenant: p.who.tenant, kind: tool }));
    }
  };
  const browse = inner.browse;
  return {
    search: (q, ctx) => priced("web_search", () => inner.search(q, ctx), { error: "unavailable" as const }),
    fetchPage: (url, opts) => priced("web_fetch", () => inner.fetchPage(url, opts), { error: "unavailable" as const }),
    // Charged only when the page came back (a cut-off or failed browse is free).
    ...(browse ? { browse: (input, ctx) => priced("web_browse", () => browse(input, ctx), { error: "unavailable" as const }) } : {}),
  };
}

/** The most a second model's reply may weigh as it comes back (16,000 tokens of text is far under it). */
const SECOND_REPLY_MAX = 1024 * 1024;

let serverToolRunnersFn: (tenant: string, keyId: string | null) => ToolRunners = platformRunners;
export function setServerToolRunnersForTests(fn: ((tenant: string, keyId: string | null) => ToolRunners) | null): void {
  serverToolRunnersFn = fn ?? platformRunners;
}

/** A model call's answer, caught in memory instead of sent: one round of the
 *  server-tool loop. serveModelCallOnce writes to it exactly as to a caller;
 *  the loop reads the status, the headers and the body as it streams.
 *  Backpressure carries through: a slow reader holds the provider's stream. */
class CaptureResponse extends Writable {
  statusCode = 200;
  /** Who this round was metered as — the payer of the tool calls it asks
   *  for (FOL-313) — and the provider it went to. */
  meterWho: { who: CallWho; provider: SupplyProviderName } | null = null;
  headersSent = false;
  readonly out = new PassThrough();
  readonly head: Promise<{ status: number; headers: Record<string, string> }>;
  private headers: Record<string, string> = {};
  private gotHead!: (h: { status: number; headers: Record<string, string> }) => void;
  constructor() {
    super();
    this.head = new Promise((r) => (this.gotHead = r));
    this.on("finish", () => {
      this.flushHead();
      this.out.end();
    });
    this.on("close", () => {
      this.flushHead();
      if (!this.out.writableEnded) this.out.end();
    });
  }
  setHeader(name: string, value: number | string | readonly string[]): this {
    this.headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
    return this;
  }
  getHeader(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }
  writeHead(status: number, a?: unknown, b?: unknown): this {
    const given = (typeof a === "object" && a ? a : typeof b === "object" && b ? b : {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(given)) if (v !== undefined) this.headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
    this.statusCode = status;
    this.headersSent = true;
    this.gotHead({ status, headers: { ...this.headers } });
    return this;
  }
  private flushHead(): void {
    if (!this.headersSent) this.writeHead(this.statusCode);
  }
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.flushHead();
    if (this.out.destroyed) return cb(new Error("the round is no longer read"));
    if (this.out.write(chunk)) return cb();
    // Waits for the reader, or ends when the reader is gone (destroyed):
    // never a callback left hanging, so the round's meter still settles.
    const go = (err?: Error) => {
      this.out.off("drain", ok);
      this.out.off("close", gone);
      cb(err);
    };
    const ok = () => go();
    const gone = () => go(new Error("the round is no longer read"));
    this.out.once("drain", ok);
    this.out.once("close", gone);
  }
}

/** What a request's earlier turns hold that only Anthropic could read. */
const hasServerBlocks = (json: Record<string, unknown>) =>
  Array.isArray(json.messages) && (json.messages as { content?: unknown }[]).some((m) => Array.isArray(m?.content) && (m.content as { type?: unknown }[]).some((b) => b?.type === "server_tool_use" || b?.type === "web_search_tool_result" || b?.type === "web_fetch_tool_result"));

/**
 * One model call, after the caller is known — with Anthropic's server tools
 * run here, never by the provider (FOL-313, owner 25 Nov 2026). A request
 * that names none goes straight to serveModelCallOnce, as before. One that
 * names a server tool this door runs is served by the loop in
 * server-tools.ts, each round a full model call of its own (admitted,
 * metered, retried as any other); one naming a server tool it does not run
 * is refused on every key, the login keys included, which used to send it to
 * Anthropic. A count_tokens call is counted on the request the provider
 * would see.
 */
/** How a model call ended, in a word to count (26 Nov 2026): it finished;
 *  the caller's connection closed first; the provider's stream broke off
 *  while the caller was still there; the provider went quiet past IDLE_MS;
 *  or it was refused. */
export type CallEnd = "complete" | "client_closed" | "upstream_cut" | "timeout" | "refused";
/** Where the call stood when it ended: the request was still coming in, it
 *  was waiting for the provider's first byte, or the reply was going out. */
export type CallPhase = "upload" | "wait" | "stream";

/** What a code path saw that the response alone cannot say. The first note
 *  stands. */
const endNotes = new WeakMap<object, CallEnd>();
export function noteEnd(res: object, how: CallEnd): void {
  if (!endNotes.has(res)) endNotes.set(res, how);
}

/** The caller's country as the edge names it (Cloudflare's CF-IPCountry):
 *  two lower-case letters, or nothing. "XX" (unknown) and "T1" (Tor) are not
 *  countries. Only a count per country is ever kept, never an address. The
 *  header is only as good as the edge: a caller who reaches the origin
 *  without it can send any country, so this is for statistics, not a gate. */
export function countryOf(headers: http.IncomingHttpHeaders): string | undefined {
  const v = headers["cf-ipcountry"];
  const c = typeof v === "string" ? v.trim().toUpperCase() : "";
  return /^[A-Z]{2}$/.test(c) && c !== "XX" ? c.toLowerCase() : undefined;
}

export function callEnd(o: { finished: boolean; status: number; note?: CallEnd; requestIn: boolean; headersSent: boolean }): { outcome: CallEnd; phase: CallPhase } {
  const phase: CallPhase = !o.requestIn ? "upload" : !o.headersSent ? "wait" : "stream";
  if (!o.finished) return { outcome: "client_closed", phase };
  if (o.note) return { outcome: o.note, phase };
  if (o.status === 504) return { outcome: "timeout", phase };
  return { outcome: o.status >= 400 ? "refused" : "complete", phase };
}

/** One `gateway.call_end` line per call the door serves: the caller's
 *  country, the size its request declared, how long the call lasted, the
 *  bytes sent back (the socket's count, headers included), the status, and
 *  how and where it ended. Counts only (core ops-log FIELDS); no address, no
 *  content. A call a run makes through its lease is not the door's caller and
 *  is not logged here.
 *
 *  Behind nginx the door never sees a slow upload: nginx reads the whole body
 *  (`proxy_request_buffering on`) before it passes the request on, so a
 *  caller that drops while sending never reaches this line — that shows in
 *  nginx's own log (499), not here. */
function watchCall(req: http.IncomingMessage, res: http.ServerResponse, who: GatewayWho, opts: ModelCallOptions): void {
  if (opts.fromLease || opts.method === "GET" || typeof res.once !== "function") return;
  const t0 = Date.now();
  const sock = req.socket;
  const out0 = sock?.bytesWritten ?? 0;
  const declared = /^\d{1,12}$/.test(String(req.headers["content-length"] ?? "")) ? Number(req.headers["content-length"]) : undefined;
  res.once("close", () => {
    const { outcome, phase } = callEnd({ finished: res.writableFinished, status: res.statusCode, note: endNotes.get(res), requestIn: req.complete, headersSent: res.headersSent });
    opsLog(outcome === "complete" || outcome === "refused" ? "info" : "warn", "gateway.call_end", {
      tenant: who.tenant,
      key: who.keyId,
      country: countryOf(req.headers),
      outcome,
      phase,
      status: res.headersSent ? res.statusCode : undefined,
      ms: Date.now() - t0,
      reqBytes: declared,
      bytes: sock ? sock.bytesWritten - out0 : undefined,
    });
  });
}

export async function serveModelCall(req: http.IncomingMessage, res: http.ServerResponse, who: GatewayWho, opts: ModelCallOptions): Promise<void> {
  watchCall(req, res, who, opts);
  return serveModelCallRouted(req, res, who, opts);
}

async function serveModelCallRouted(req: http.IncomingMessage, res: http.ServerResponse, who: GatewayWho, opts: ModelCallOptions): Promise<void> {
  if (opts.body || opts.method !== "POST" || (opts.pathname !== "/v1/messages" && opts.pathname !== "/v1/messages/count_tokens")) return serveModelCallOnce(req, res, who, opts);
  const body = await readBody(req);
  if (body === "too-large") return fail(res, 413, `the request is over ${MAX_BODY / 1024 / 1024} MB`);
  let json: Record<string, unknown> | null = null;
  try {
    const j = JSON.parse(body.toString("utf8")) as unknown;
    if (j && typeof j === "object" && !Array.isArray(j)) json = j as Record<string, unknown>;
  } catch {
    // not JSON: the call below answers it as it always has
  }
  if (!json) return serveModelCallOnce(req, res, who, { ...opts, body });
  let configs: ServerToolConfig[] | null;
  try {
    configs = serverToolsOf(json);
    // Read the earlier turns now (a changed encrypted_content is refused),
    // so a bad one is the caller's 400, not a 500 later.
    if (configs || hasServerBlocks(json)) lowerMessages(json.messages as Parameters<typeof lowerMessages>[0]);
  } catch (err) {
    if (err instanceof ServerToolRefusal) return fail(res, 400, err.message, { "x-should-retry": "false" }, "server_tool_not_offered");
    throw err;
  }
  if (!configs) {
    // Earlier server blocks with the tools since dropped: the provider is
    // given them as the plain turns they were.
    if (!hasServerBlocks(json)) return serveModelCallOnce(req, res, who, { ...opts, body });
    const lowered = { ...json, messages: lowerMessages(json.messages as Parameters<typeof lowerMessages>[0]) };
    return serveModelCallOnce(req, res, who, { ...opts, body: Buffer.from(JSON.stringify(lowered)) });
  }
  // A run's call through its lease (FOL-418): debate and review only as the
  // agent file granted them — that tool, that one model, written on the
  // lease by the runner. Anything else a request names (another model, a
  // tool not granted, a lease from a runner that wrote none) is refused
  // before a round is spent: a request is what the sandbox wrote.
  if (opts.fromLease) {
    const g = opts.fromLease.secondModel ?? null;
    const bad = configs.find((c) => (c.kind === "debate" || c.kind === "review") && (!g || !g.tools.includes(c.kind) || c.model !== g.model));
    if (bad) return fail(res, 400, `${bad.name} is not granted to this step${g ? ` as asked: its agent file grants ${g.tools.join(", ")} answered by ${g.model}` : ": its agent file has no tools: [debate, review] with second_model:"}`, { "x-should-retry": "false" }, "server_tool_not_offered");
  }
  if (opts.pathname === "/v1/messages/count_tokens") return serveModelCallOnce(req, res, who, { ...opts, body: Buffer.from(JSON.stringify(lowerRequest(json, configs))) });
  return serveServerTools(req, res, who, opts, json, configs);
}

/**
 * One call to a second model, for foldrun_debate and foldrun_review
 * (FOL-416, FOL-417): through serveModelCallOnce like any round — admitted,
 * held and metered at the model's list price for `payer` — with nothing of
 * the caller's request but `q` (no headers, no betas, no conversation), no
 * tools, and never on a Claude login (`secondModel`). The model is `q.model`
 * or the console's pair for `firstProvider`; it is never `firstProvider`
 * itself, and nothing falls back. Answers its text, or a typed refusal.
 */
export async function callSecondModel(
  c: { req: http.IncomingMessage; who: GatewayWho; customer: string | null; isGone: () => boolean; track?: (cap: CaptureResponse) => void; testRun?: boolean },
  payer: CallWho,
  firstProvider: SupplyProviderName | null,
  q: { model?: string; maxTokens: number; system: string; prompt: string },
  signal?: AbortSignal,
): Promise<{ result: ConsultResult; via: string } | { error: ConsultError; maybeCharged?: true }> {
  const refused = (error: ConsultError, maybeCharged = false) => (maybeCharged ? { error, maybeCharged: true as const } : { error });
  if (c.isGone() || signal?.aborted) return refused("unavailable");
  const model = q.model ?? (firstProvider ? secondModelOf(setting("models.second") as string | null, firstProvider) : null);
  if (!model) return refused("unavailable");
  // Another provider, always: a second opinion from the same one is not what
  // was asked for, and nothing falls back to it.
  const target = providerOfModel(model);
  if (!target || target.provider === firstProvider) return refused("model_not_allowed");
  // A model with no price on the console's list is not for sale: said as
  // that, before anything is asked of the meter or sent.
  if (!listedPrice(target.provider, target.model)) return refused("unavailable");
  // Nor one with no key here: said before the call, so it is known to cost
  // nothing and leaves an idempotency key free (Codex, FOL-417).
  if (!supplyKeyOf(target.provider)) return refused("unavailable");
  // A test run reaches only read-safe hosts, as its own calls do (core
  // test-mode.ts): another provider's host that is not one is refused.
  if (c.testRun && !isReadSafeHost(supplyHostOf(target.provider))) return refused("model_not_allowed");
  const cap = new CaptureResponse();
  c.track?.(cap);
  const stop = () => {
    cap.out.destroy();
    cap.destroy();
  };
  signal?.addEventListener("abort", stop, { once: true });
  // Nothing of the caller's request goes with it: not its headers (a beta can
  // switch on something billed), not its conversation.
  const asReq = Object.create(c.req, { headers: { value: { "content-type": "application/json", accept: "application/json" } } }) as http.IncomingMessage;
  // A login key's grant is Claude's alone; this call is the account's, on the platform's key.
  const asWho: GatewayWho = c.who.grant.credential === "login" ? { ...c.who, grant: { ...c.who.grant, credential: "account" } } : c.who;
  const body = Buffer.from(JSON.stringify({ model, max_tokens: q.maxTokens, system: q.system, messages: [{ role: "user", content: q.prompt }] }));
  try {
    const served = serveModelCallOnce(asReq, cap as unknown as http.ServerResponse, asWho, { method: "POST", pathname: "/v1/messages", search: "", customer: c.customer, isGone: c.isGone, meterAs: payer, body, secondModel: true }).catch((err) => {
      opsError("gateway.server_tools_round_failed", err, { tenant: c.who.tenant, key: c.who.keyId });
      if (!cap.headersSent) cap.writeHead(502, { "content-type": "application/json" });
      cap.end();
    });
    const head = await cap.head;
    // Read to its end either way, so the call settles at what it used; kept
    // only for an answer, and only up to a bound no real answer reaches.
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const ch of cap.out as AsyncIterable<Buffer>) {
      size += ch.length;
      if (head.status === 200 && size <= SECOND_REPLY_MAX) chunks.push(ch);
    }
    // Its hold is closed before anything else asks for one: an open estimate
    // would count against the key's limit (Codex review, FOL-416).
    await served;
    // 402 and 429 are the door's own refusals, made before anything is sent;
    // any other answer may have been billed at the call's estimate.
    if (head.status !== 200) return head.status === 402 ? refused("payment_required") : head.status === 429 ? refused("too_many_requests") : refused("unavailable", true);
    if (size > SECOND_REPLY_MAX) return refused("unavailable", true);
    const msg = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { content?: { type?: string; text?: unknown }[]; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
    const text = (Array.isArray(msg.content) ? msg.content : []).filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n");
    return { result: { model, text, usage: { input_tokens: (msg.usage?.input_tokens ?? 0) + (msg.usage?.cache_read_input_tokens ?? 0) + (msg.usage?.cache_creation_input_tokens ?? 0), output_tokens: msg.usage?.output_tokens ?? 0 } }, via: target.provider };
    // Cached input (read or written) is counted as input, priced at the dearest input rate by the caller.
  } catch {
    return refused("unavailable", true);
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

async function serveServerTools(req: http.IncomingMessage, res: http.ServerResponse, who: GatewayWho, opts: ModelCallOptions, json: Record<string, unknown>, configs: ServerToolConfig[]): Promise<void> {
  let gone = false;
  const rounds = new Set<CaptureResponse>();
  // Ends a search or fetch in flight, and the ones not started, when the
  // caller leaves (Codex review, 25 Nov 2026).
  const abort = new AbortController();
  res.on("close", () => {
    if (res.writableFinished) return;
    gone = true;
    abort.abort();
    // The caller left: every round still open stops, so its provider call does.
    for (const r of rounds) r.destroy();
  });
  const isGone = () => gone || opts.isGone();
  const round = async (b: Record<string, unknown>) => {
    const cap = new CaptureResponse();
    rounds.add(cap);
    cap.on("close", () => rounds.delete(cap));
    const served = serveModelCallOnce(req, cap as unknown as http.ServerResponse, who, { ...opts, body: Buffer.from(JSON.stringify(b)), isGone }).catch((err) => {
      opsError("gateway.server_tools_round_failed", err, { tenant: who.tenant, key: who.keyId });
      if (!cap.headersSent) cap.writeHead(502, { "content-type": "application/json" });
      cap.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "this step of the turn failed on foldrun's side" } }));
    });
    const head = await cap.head;
    // The latest round's payer pays for the tool calls it asked for.
    if (cap.meterWho) payer = cap.meterWho;
    const cancel = () => {
      cap.out.destroy();
      cap.destroy();
    };
    // The round is over for the loop only once its hold is closed: a tool
    // it asked for (a search at its price, a second model's call) is then
    // admitted against what the round really cost, not its open estimate
    // (Codex review, FOL-416).
    const chunks = (async function* () {
      yield* cap.out as AsyncIterable<Buffer>;
      await served;
    })();
    return { status: head.status, headers: head.headers, chunks, cancel };
  };
  // The caller's account: its own search engine is the first rung. Each
  // call is held at the operator's price before it runs and charged only
  // if it worked (holdToolCall); one it cannot hold answers `unavailable`.
  let payer: { who: CallWho; provider: SupplyProviderName } | null = null;
  // web_browse is a no-run job with its own grant, so a step's own model
  // calls (through its lease, network-held) never get it (Codex): only the
  // step's own tools reach the web for it, under its network: list.
  const base = serverToolRunnersFn(who.tenant, who.keyId ?? null);
  const runners = pricedRunners(opts.fromLease ? { search: base.search, fetchPage: base.fetchPage } : base, () => payer);
  // foldrun_debate and foldrun_review (FOL-416, FOL-417): one call to a
  // model of another provider, made through this same door — admitted, held
  // and metered as the round that asked for it is (its payer, the plan and
  // wallet behind it), at the second model's own price; no fee beside its
  // tokens. A run's call through its lease may ask it too (FOL-418): the
  // lease grants its OWN calls one provider; the second model's call is the
  // door's, on the platform's key, metered to the run's step — and held to
  // test mode's read-safe hosts like everything a test run sends.
  runners.consult = async (q, ctx) => {
    const p = payer;
    if (!p) return { error: "unavailable" as const };
    return callSecondModel({ req, who, customer: opts.customer, isGone, testRun: opts.fromLease?.test === true, track: (cap) => {
      rounds.add(cap);
      cap.on("close", () => rounds.delete(cap));
    } }, p.who, p.provider, q, ctx.signal);
  };
  const passBack = (h: Record<string, string>) => {
    const out: Record<string, string> = {};
    for (const k of ["request-id", "x-request-id"]) if (h[k]) out[k] = h[k]!;
    return out;
  };
  const log = (ran: { search: number; fetch: number; browse?: number; debate?: number; review?: number }, vias: string[], stream: boolean) => {
    // One line per kind, in the fields the ops log keeps (core ops-log FIELDS).
    for (const kind of ["search", "fetch", "browse", "debate", "review"] as const) {
      if (ran[kind]) opsLog("info", "gateway.server_tools", { tenant: who.tenant, key: who.keyId, kind, count: ran[kind], provider: vias.join("-") || undefined, streaming: stream });
    }
  };

  if (json.stream === true) {
    let keep: ReturnType<typeof sseKeepAlive> | null = null;
    const done = await runServerToolLoopStream(json, configs, round, runners, {
      start(status, headers, refusal) {
        if (status !== 200) {
          res.writeHead(status, { "content-type": headers["content-type"] ?? "application/json", "cache-control": "no-store", ...passBack(headers) });
          res.end(refusal ?? "");
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", ...passBack(headers) });
        keep = sseKeepAlive(res);
      },
      write(text) {
        if (res.destroyed || res.writableEnded) return;
        const ok = res.write(text);
        keep?.wrote(text);
        // The caller's socket is full: the loop waits, and so the round's
        // provider stream waits behind it, instead of piling up here.
        if (!ok) return new Promise<void>((r) => {
          const go = () => {
            res.off("drain", go);
            res.off("close", go);
            r();
          };
          res.once("drain", go);
          res.once("close", go);
        });
      },
      isGone,
    }, { signal: abort.signal });
    (keep as ReturnType<typeof sseKeepAlive> | null)?.stop();
    if (!res.writableEnded) res.end();
    return log(done.ran, done.vias, true);
  }

  const call = async (b: Record<string, unknown>) => {
    const r = await round(b);
    const chunks: Buffer[] = [];
    for await (const c of r.chunks) chunks.push(c);
    return { status: r.status, headers: r.headers, body: Buffer.concat(chunks) };
  };
  const done = await runServerToolLoop(json, configs, call, runners, { isGone, signal: abort.signal });
  log(done.ran, done.vias, false);
  if (res.destroyed || res.writableEnded) return;
  if (Buffer.isBuffer(done.body)) {
    res.writeHead(done.status, { "content-type": done.headers["content-type"] ?? "application/json", "cache-control": "no-store", ...passBack(done.headers) });
    return void res.end(done.body);
  }
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", ...passBack(done.headers) });
  res.end(JSON.stringify(done.body));
}

/**
 * One model call, after the caller is known: the provider by the model name,
 * the credential (a Claude login from the pool, or a platform key, metered),
 * the retries, and the reply streamed back. The gateway door calls it for a
 * gateway key; the egress proxy calls it for a run's call on the account's
 * Claude subscription (16 Nov 2026, SupplyGrant.via "login") with a `who`
 * it made from the lease — never from anything the sandbox sent — so a
 * run's Claude calls go through exactly this login path, counted in the
 * same windows as the account's Claude Code calls.
 */
async function serveModelCallOnce(req: http.IncomingMessage, res: http.ServerResponse, who: GatewayWho, opts: ModelCallOptions): Promise<void> {
  const { method, pathname, customer } = opts;
  const meterAs: CallWho = opts.meterAs ?? { tenant: who.tenant, kind: "coding", job: meterJobOf(who.keyId, who.grant), jobLimits: { capUsd: who.grant.capUsd ?? null, dailyUsd: who.grant.dailyUsd ?? null, ...(who.grant.credential === "account" ? { walletUsd: Math.max(0, who.grant.walletUsd ?? 0) } : {}) }, ...(customer ? { customer } : {}) };
  // On a login key, what reaches the platform's API keys is extra usage the
  // wallet pays: never the plan's allowance (Codex review, 20 Nov 2026).
  let meterPaid: CallWho = who.grant.credential === "login" ? { ...meterAs, planCover: false } : meterAs;
  let poolOnly = opts.poolOnly === true;
  // An account key put on the subscription's login by the account's route.
  let routedLogin = false;
  // Watched from here as well: a caller gone before the listener above fired.
  let left = false;
  res.on("close", () => {
    if (!res.writableFinished) left = true;
  });
  const isGone = () => left || opts.isGone();

  const body = opts.body ?? (method === "POST" ? await readBody(req) : null);
  if (body === "too-large") return fail(res, 413, `the request is over ${MAX_BODY / 1024 / 1024} MB`);

  // Which provider serves this call (Part A1, 10 Nov 2026): by the model
  // name — `provider/model`, or a bare name with a known prefix — on the
  // provider's own Anthropic-format path. Anthropic when nothing says else.
  // The key's own model mapping (Part A5): the /model picker's tier, as this
  // key says it runs.
  // A key that reads images and PDFs into text first (FOL-268): each round's body, before it is mapped and sent.
  let mediaBody: Buffer | null = body;
  // count_tokens too, so a context check counts what the call will send (Codex).
  if (who.grant.mediaToText === true && (pathname === "/v1/messages" || pathname === "/v1/messages/count_tokens") && body) {
    // Stopped when the caller leaves: no reading goes on for nobody (Codex).
    const gone = new AbortController();
    const stop = () => gone.abort();
    res.once("close", stop);
    if (isGone()) gone.abort();
    const m = await mediaToText(who.tenant, body, { signal: gone.signal, actor: `gateway:${who.keyId}` }).finally(() => res.off("close", stop));
    if (isGone()) return;
    mediaBody = m.body;
    if (m.read || m.left) res.setHeader("foldrun-media-to-text", `read=${m.read}; left=${m.left}`);
  }
  const mapped = mapModel(mediaBody, who.grant.models);
  const route = routeOf(method, pathname, mapped, opts.fromLease?.provider);
  if ("error" in route) return fail(res, route.status, route.error, {}, route.code);
  const provider = route.provider;
  // A round's tools are paid as the round is (FOL-313): the login's own
  // until something below meters it otherwise.
  if (res instanceof CaptureResponse) res.meterWho = { who: who.grant.credential === "login" ? loginTools(meterAs) : meterPaid, provider };
  const sp = SUPPLY_PROVIDERS[provider];
  if (opts.fromLease) {
    if (provider !== opts.fromLease.provider) return fail(res, 403, `this step's calls are on ${opts.fromLease.provider} — ${provider} is not granted to it`, { "x-should-retry": "false" });
    // Test mode, as the proxy decides it for any host: a model call only to
    // a provider whose host is read-safe (core test-mode.ts).
    if (opts.fromLease.test && !isReadSafeHost(supplyHostOf(provider))) return fail(res, 403, `test mode: a call to ${provider} (${supplyHostOf(provider)}) is refused — it is not a read-safe host`, { "x-should-retry": "false" });
  }
  // One door (owner, 23 Nov 2026): every call of an account goes through
  // here, from a computer or from foldrun's cloud, and is served the way the
  // account's cloud step is. An account the operator runs on its own model
  // credential (accountRoute "operator", the runner's decision: the console's
  // lever, no foldrun's-models choice) has its Claude calls sent on that
  // credential, as its steps are — admitted, held and metered exactly as a
  // call on foldrun's models is: the account's standing, the key's limits,
  // the plan, the wallet (its steps' tokens are billed too: store.ts
  // supplyBillsTokens). Every other account, and every other provider, is
  // served as before. A login key keeps its own path. Not where own keys
  // are on (models.byok): this pod cannot read an account's own key, so it
  // cannot tell an account that brought one (Codex review, 23 Nov 2026).
  let operator: OperatorCredential | null = null;
  if (opts.operatorRun) {
    if (provider !== "anthropic") return fail(res, 403, `the operator's model credential is for Claude models only — ${provider} is not served on it`, { "x-should-retry": "false" });
    operator = operatorCredentialFn();
    if (!operator) return fail(res, 503, "the operator's model credential is not set on this proxy — the operator has to add it, so retrying will not help", { "x-should-retry": "false" }, "no_operator_credential");
  } else if (!opts.fromLease && who.grant.credential !== "login" && provider === "anthropic" && !ownModelKeysOn()) {
    const askedName = namedModel(mapped);
    const ar = accountRouteFn(who.tenant, { provider, ...(askedName ? { model: providerOfModel(askedName)?.model ?? askedName } : {}) });
    if (ar.kind === "operator") operator = operatorCredentialFn();
    else if (ar.kind === "login" && !opts.secondModel && who.grant.capUsd == null && who.grant.dailyUsd == null && !who.requireCustomer && !customer) {
      // The account's Claude subscription, as its cloud steps run on it (the
      // egress proxy's door, SupplyGrant.via "login"): a login from the pool,
      // never the install's own; past the plan's share the platform's key on
      // the plan, then extra usage on the wallet — metered against the key's
      // own wallet limit. Not a key with a lifetime or daily cap, or one that
      // serves end customers: a login call is not counted against those, so
      // they stay on foldrun's models, metered, every dollar against the
      // limit (Codex review, 23 Nov 2026).
      who = { ...who, grant: { ...who.grant, credential: "login" } };
      meterPaid = { ...meterAs, planCover: false };
      poolOnly = true;
      routedLogin = true;
      if (res instanceof CaptureResponse) res.meterWho = { who: loginTools(meterAs), provider };
    }
  }
  // A second model's call goes on an API key or not at all: the operator's
  // own Claude login is a subscription too.
  if (opts.secondModel && operator?.kind === "login") operator = null;
  // Strip SDK fingerprints and account/customer identifiers before translation
  // or login selection. Customer limits and accounting stay internal.
  const namedBody = pathname === "/v1/messages" || pathname === "/v1/messages/count_tokens"
    ? modelRequestIdentity(route.body) : route.body;
  // A login key's call from Claude Code opens with Claude Code's identity
  // line, as it does when Claude Code is signed in itself (see
  // withClaudeCodeIdentity). On the customer's body, not only the plan's:
  // extra usage on a login is sent with the same subscription credential and
  // is refused without the line just the same (Codex review, 17 Nov 2026).
  // A call the account's route puts on the operator's Claude login gets it
  // from any caller: what is behind the door is the door's
  // business (owner, 23 Nov 2026), and Anthropic refuses a login call
  // without it — the account's cloud step, Claude Code itself, sends it.
  const onLoginCredential = who.grant.credential === "login" || operator?.kind === "login";
  const customerBody = onLoginCredential && pathname === "/v1/messages" && (fromClaudeCode(req.headers["user-agent"]) || operator !== null || routedLogin) ? withClaudeCodeIdentity(namedBody) : namedBody;
  // A Claude login is a subscription: its cache points are kept an hour, as
  // Claude Code keeps them when it is signed in itself (see longCache).
  // Not on the operator's login: that call is metered at the price list,
  // which prices the caller's own cache points (Codex review, 23 Nov 2026).
  const routedBody = who.grant.credential === "login" && pathname === "/v1/messages" ? longCache(customerBody) : customerBody;
  // The model is known from here: every refusal below (a plan's share used,
  // the wallet, the provider's own answer) says which model it was for. Only
  // a caller the door noted gets it — the egress proxy's run calls have none,
  // and are left as they were.
  // routeOf hands back no body for a count it estimates (another provider's
  // count_tokens): the name as asked, its provider prefix taken off as
  // routing takes it off (`z-ai/glm-4.7` is `glm-4.7`).
  const asked = namedModel(mapped);
  const loggedModel = logModel(namedModel(routedBody) ?? (asked ? providerOfModel(asked)?.model ?? asked : null));
  const caller = callers.get(res);
  if (caller && loggedModel) caller.model = loggedModel;

  let metered: MeteredCall | null = null;
  let sendBody: Buffer | null = routedBody;
  let outBody: Buffer | null = routedBody;
  let xlate: Translated | null = null;
  let credential: Record<string, string> = {};
  let betaExtra: string | null = null;
  let pooled: { pool: LoginPool; login: string; model: string | null } | null = null;
  // A login key past its plan's share whose account turned on extra usage
  // goes on as a metered call, paid from the wallet (LoginPool.pick).
  let onWallet: { message: string } | null = null;
  // Past the share with extra usage on while a login has room (owner,
  // 15 Nov 2026): still on the login, metered — the wallet pays Anthropic's
  // API price for it. The limit it is past, for a refusal.
  let extraOnLogin: string | null = null;
  // A run on the subscription the logins cannot serve (none, or none with
  // room, while the account is inside its share — owner, 23 Nov 2026: one
  // subscription, the pool under it is ours to supply): foldrun's own key,
  // metered as the run's call with the plan standing behind it — the same
  // allowance the pool reads (planCoverOf counts acct:<tenant> too), so the
  // payer is unchanged and nothing is covered twice.
  let onPlatform = false;
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
    const standing = await loginStandingOf(who.tenant);
    if (standing === "unreadable") return fail(res, 503, LOGIN_STANDING_UNREADABLE, { "retry-after": "5" }, "billing_unreadable");
    if (standing === "no") return fail(res, 403, "this key runs on a foldrun subscription and this account has no active one — choose Pro or Max under Billing → Plans; it opens nothing until then", {}, "subscription_required");
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
      if ("refuse" in picked && poolOnly && picked.refuse.supply) {
        opsLog("warn", "gateway.run_on_platform_key", { tenant: who.tenant, status: picked.refuse.status });
        onPlatform = true;
        token = null;
      } else if ("refuse" in picked && !picked.refuse.wallet) return fail(res, picked.refuse.status, picked.refuse.message, {}, "login_share");
      else if ("refuse" in picked) {
        onWallet = { message: picked.refuse.message };
        token = null;
      } else {
        token = picked.token;
        pooled = { pool, login: picked.login, model };
        if (picked.extra) extraOnLogin = picked.extra;
      }
    } else if (poolOnly) return fail(res, 503, "the Claude subscription cannot be served on this installation", { "x-should-retry": "false" });
    else token = loginToken();
    if (!onWallet && !onPlatform) {
      if (!token) return fail(res, 503, "this gateway cannot serve this key right now");
      credential = { authorization: `Bearer ${token}` };
      betaExtra = OAUTH_BETA;
    }
  }
  if (onWallet || extraOnLogin || onPlatform) {
    // Metered from here on: the body as the customer sent it (the hour-long
    // cache points are the subscription's; on the API they cost double, and
    // extra usage is priced as the API would price it).
    sendBody = customerBody;
    outBody = customerBody;
  }
  // Who the metered call is: a run on the platform's key inside its plan is
  // the run's own call, the plan may cover it; extra usage is the wallet's.
  const meterHere: CallWho = onPlatform ? { ...meterAs, optInOnly: true } : meterPaid;
  // A run's call on the operator's credential (operatorRun) is metered here
  // like every other call through the door: the door is the one meter, so a
  // call the runtime does not report — another process in the sandbox — is
  // counted too, and the step's own tokens are not billed again (core
  // store.ts billedTokenCost, meteredAtDoor).
  if (opts.operatorRun && operator && !opts.operatorMetered) {
    credential = operator.kind === "key" ? { "x-api-key": operator.value } : { authorization: `Bearer ${operator.value}` };
    if (operator.kind === "login") betaExtra = OAUTH_BETA;
  } else if (who.grant.credential !== "login" || onWallet || extraOnLogin || onPlatform) {
    // The key's limits are held in reserveCall alone, with the call's
    // estimate (the pre-check that summed the key's spend twice more is gone:
    // Codex review, 10 Nov 2026). A spent limit is a 402, not a 429: Claude
    // Code retries a 429 for about three minutes, and no retry makes room
    // under a limit. A 429 the provider sends still comes back as it was.
    if (route.estimate !== undefined) {
      // count_tokens on a provider with no such route: an estimate, said so —
      // after the same account checks every call gets (Codex review).
      const refused = await accountStands(who.tenant, provider, meterHere);
      if (refused) return fail(res, refused.status, refused.message, {}, refused.code);
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
      meterHere,
      provider,
      method,
      route.path,
      outBody,
    );
    if ("refuse" in admitted) {
      // Extra usage on, and the wallet cannot pay either: both, in one line.
      const limit = onWallet?.message ?? extraOnLogin;
      const message = limit ? `${limit}; extra usage is on, but the wallet cannot pay: ${admitted.refuse.message}` : admitted.refuse.message;
      return fail(res, admitted.refuse.status === 429 ? 402 : admitted.refuse.status, message, {}, admitted.refuse.code);
    }
    metered = "metered" in admitted ? admitted.call : null;
    sendBody = "metered" in admitted ? admitted.body : outBody;
    if (res instanceof CaptureResponse) res.meterWho = { who: meterHere, provider };
    // Extra usage on a login: the login's own credential, kept as it is.
    if (operator) {
      // Admitted and metered above; sent on the operator's credential.
      credential = operator.kind === "key" ? { "x-api-key": operator.value } : { authorization: `Bearer ${operator.value}` };
      if (operator.kind === "login") betaExtra = OAUTH_BETA;
    } else if (!extraOnLogin) {
      const key = supplyKeyOf(provider);
      if (!key) {
        await metered?.finish(0, false).catch((e) => opsError("gateway.close_failed", e));
        // Past a plan's limit with nowhere metered to go: the limit, said as it is.
        if (onWallet) return fail(res, 402, `${onWallet.message}; extra usage cannot run right now (no Claude API key on this platform)`, {}, "login_share");
        // Not a passing outage: no usable key for the provider here (none
        // added, or one the pod cannot open — Codex), and a retry changes
        // nothing. It said "for a
        // moment" and sent people to retry (dev, 20 Nov 2026). Still 503 — the
        // service, not the caller — with its own reason for the ops log.
        return fail(res, 503, `foldrun's models: ${provider} has no usable key on this platform — the operator has to add or fix it, so retrying will not help; a model from another provider may work (foldrun account model prices, or GET /v1/account/model, lists what can be had)`, { "x-should-retry": "false" }, "no_supply_key");
      }
      // Each provider's key in its own header, in its exact shape.
      credential = sp.auth === "bearer" ? { authorization: `Bearer ${key}` } : { "x-api-key": key };
    }
  }

  const host = supplyHostOf(provider);
  // https always; plain http only where a test allows it (supplySchemeOk).
  // The route was checked on the path alone; its query goes on as it came
  // (Codex review: /v1/models?after_id=… pages).
  // The model list kept to what can be called (below) is asked for whole, so
  // no page of it comes back empty to a paging SDK, which stops there (Codex).
  const listPriced = method === "GET" && pathname === "/v1/models" && provider === "anthropic" && who.grant.credential !== "login" && !(opts.operatorRun && operator && !opts.operatorMetered);
  const target = `${supplySchemeOk(`http://${host}`) ? "http" : "https"}://${host}${route.path}${listPriced ? wholeListQuery(opts.search) : opts.search}`;
  if (!supplySchemeOk(target)) {
    await metered?.finish(0, false).catch((e) => opsError("gateway.close_failed", e));
    return fail(res, 503, "foldrun's models are unavailable for a moment");
  }

  if (isGone() || res.destroyed) {
    // Nothing was sent: the hold is closed at nothing.
    await metered?.finish(0, false).catch((e) => opsError("gateway.close_failed", e));
    return;
  }

  const headers = xlate
    // The content type is the request's, not a credential: given as one, it
    // was dropped, and every translated call (OpenAI, Gemini) went out with
    // none (since FOL-337; found in FOL-416's review).
    ? modelRequestHeaders({ "content-type": "application/json" }, credential, "other")
    : modelRequestHeaders(req.headers, credential, SUPPLY_PROVIDERS[provider].format === "anthropic" ? "anthropic" : "other");
  if (!xlate && SUPPLY_PROVIDERS[provider].format === "anthropic") logDroppedBetas(req.headers, who.tenant, "gateway");
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

  // A call the provider did not take is sent again (15 Nov 2026): one that
  // never connected, a 5xx or 529, or a 429 that asks for a short wait.
  // None of those were billed, and nothing has gone back to the caller yet,
  // so the same hold and the same body serve every try. A pooled login is
  // told what each try got and asked again, so a login the pool has just
  // set aside is not tried twice.
  // A retry's pick may say the plan's limit is reached with extra usage on
  // (a login cooled under this call, or the share ran out): the call goes on
  // metered, as on the first pick — admitted and held once, the body as the
  // customer sent it — on a login with room (`extra`) or else on the
  // platform's key. A refusal to answer with, or null when it goes on.
  let admittedExtra = Boolean(onWallet || extraOnLogin);
  // Which payer the hold above was taken for: extra usage (the wallet), or
  // the run's own call on the plan (a covered move to the platform's key).
  let admittedCovered = false;
  type Refused = { status: number; message: string; code?: string; headers?: Record<string, string> };
  // `covered`: a run's call the logins could not serve, on the plan's
  // allowance as the run's own (not extra usage the wallet pays).
  const meterExtra = async (limit: string, covered = false): Promise<Refused | null> => {
    if (admittedExtra && admittedCovered === covered) return null;
    if (admittedExtra) {
      // Held for the other payer (a wallet hold, then a covered move after a
      // reset under the call): that hold closes at nothing — none of the
      // tries so far were billed — and the call is admitted again for the
      // payer it now has (Codex review, 23 Nov 2026). Only once the close
      // has landed: a hold left open would settle at its estimate, so a
      // close that fails keeps the handle (the refusal path closes it again)
      // and nothing more is admitted (Codex, round 2).
      try {
        await metered?.finish(0, false);
      } catch (e) {
        opsError("gateway.close_failed", e);
        return { status: 503, message: "foldrun's models: this call could not be moved to your plan just now — try again in a moment", headers: { "retry-after": "5" } };
      }
      metered = null;
      admittedExtra = false;
      sendBody = customerBody;
    }
    const admitted = await admitCall(
      covered ? { ...meterAs, optInOnly: true } : meterPaid,
      provider,
      method,
      route.path,
      customerBody,
    );
    if ("refuse" in admitted) return { status: admitted.refuse.status === 429 ? 402 : admitted.refuse.status, message: covered ? admitted.refuse.message : `${limit}; extra usage is on, but the wallet cannot pay: ${admitted.refuse.message}`, ...(admitted.refuse.code ? { code: admitted.refuse.code } : {}) };
    admittedExtra = true;
    admittedCovered = covered;
    metered = "metered" in admitted ? admitted.call : null;
    sendBody = "metered" in admitted ? admitted.body : customerBody;
    if (res instanceof CaptureResponse) res.meterWho = { who: covered ? { ...meterAs, optInOnly: true } : meterPaid, provider };
    return null;
  };
  const toWallet = async (limit: string, covered = false): Promise<Refused | null> => {
    const key = supplyKeyOf(provider);
    if (!key) {
      // Nowhere metered to go: a hold already taken closes at nothing.
      await metered?.finish(0, false).catch((e) => opsError("gateway.close_failed", e));
      metered = null;
      return covered
        ? { status: 503, message: `foldrun's models: ${provider} has no usable key on this platform — the operator has to add or fix it, so retrying will not help`, code: "no_supply_key", headers: { "x-should-retry": "false" } }
        : { status: 402, message: `${limit}; extra usage cannot run right now (no Claude API key on this platform)` };
    }
    const no = await meterExtra(limit, covered);
    if (no) return no;
    delete headers.authorization;
    headers["x-api-key"] = key;
    const betas = (headers["anthropic-beta"] ?? "").split(",").map((b) => b.trim()).filter((b) => b && b !== OAUTH_BETA);
    if (betas.length) headers["anthropic-beta"] = betas.join(",");
    else delete headers["anthropic-beta"];
    pooled = null;
    return null;
  };

  const policy = retryPolicy();
  let upstream: Response;
  for (let tries = 0; ; tries++) {
    let reply: Response | null = null;
    let threw: unknown = null;
    // A call no meter priced (a Claude login, the operator's unmetered
    // credential) may not ask for a premium price either: fast mode, a
    // priority tier or a US-only region would be billed to foldrun's login or
    // key (FOL-340). Checked on every attempt, so a switch back from extra
    // usage to the login's share is checked too; on the operator's API key an
    // omitted tier is made standard_only.
    if (!metered && !xlate && pathname === "/v1/messages") {
      const premium = premiumAsk(sendBody);
      if (premium) {
        clearTimeout(idle);
        return fail(res, 400, `foldrun's models: ${premium} is not offered on this key — send the request without it`, {}, "premium_not_offered");
      }
      if (headers["x-api-key"]) sendBody = standardTier(sendBody);
    }
    try {
      reply = await fetchPublic(target, { method, headers, ...(sendBody ? { body: sendBody, duplex: "half" } : {}), redirect: "manual", signal: abort.signal } as RequestInit, { maxBytes: Infinity });
    } catch (err) {
      threw = err;
    }
    const code = threw ? ((threw as { cause?: { code?: string } })?.cause?.code ?? "") : "";
    const wait = tries < policy.retries && !isGone() && !res.destroyed && !abort.signal.aborted ? retryWaitMs(reply ? reply.status : null, code, reply?.headers.get("retry-after") ?? null, tries, policy) : null;
    if (wait === null) {
      if (reply) {
        upstream = reply;
        break;
      }
      // Never connected: nothing reached the provider, nothing is charged;
      // anything else may have been billed, so it stands at its estimate (as
      // the egress proxy does).
      await metered?.finish(NEVER_CONNECTED.test(code) || /^(ERR_TLS_CERT_ALTNAME_INVALID|CERT_)/.test(code) ? 0 : 200, false).catch((e) => opsError("gateway.close_failed", e));
      clearTimeout(idle);
      return fail(res, 502, `could not reach the model provider: ${threw instanceof Error ? threw.message : String(threw)}`);
    }
    opsLog("warn", "gateway.upstream_retry", { provider, status: reply ? reply.status : 0, ...(code ? { code } : {}), tenant: who.tenant, key: who.keyId });
    if (reply) {
      await reply.body?.cancel().catch(() => {});
      if (pooled) {
        // The pool hears of this try, and says which login the next goes on.
        const caller = { tenant: who.tenant, keyId: who.keyId, plan: who.grant.plan };
        await pooled.pool.record(caller, { login: pooled.login, model: pooled.model, usage: null, status: reply.status, headers: limitHeaders(reply), extra: metered !== null }, new Date()).catch((e) => opsError("gateway.login_record_failed", e));
        const next = await pooled.pool.pick(caller, pooled.model, new Date()).catch((e) => (opsError("gateway.login_pick_failed", e), null));
        // No login to go on: the pool's own refusal, as on the first pick
        // (a used-up share is not mended by coming back in a moment).
        // Each way out here closes an extra-usage hold at nothing: the tries
        // so far were not billed (Codex review, 15 Nov 2026).
        if (!next) {
          await metered?.finish(0, false).catch((e) => opsError("gateway.close_failed", e));
          clearTimeout(idle);
          return fail(res, 503, "this key's usage could not be read — try again in a moment", { "retry-after": "5" });
        }
        if ("refuse" in next) {
          // A run the logins can no longer serve goes on foldrun's key,
          // covered, as on the first pick.
          const onKey = poolOnly && next.refuse.supply === true;
          const no: Refused | null = onKey || next.refuse.wallet ? await toWallet(next.refuse.message, onKey) : next.refuse;
          if (no) {
            await metered?.finish(0, false).catch((e) => opsError("gateway.close_failed", e));
            clearTimeout(idle);
            return fail(res, no.status, no.message, no.headers ?? {}, no.code ?? "login_share");
          }
        } else {
          // Past the share now (extra usage on): metered from this try on.
          const no = next.extra ? await meterExtra(next.extra) : null;
          if (no) {
            clearTimeout(idle);
            return fail(res, no.status, no.message, no.headers ?? {}, no.code ?? "login_share");
          }
          if (!next.extra && metered) {
            // Inside the share again (its window turned over while this
            // waited): the plan covers it — the hold closes at nothing and the
            // subscription's body goes (Codex review, 15 Nov 2026).
            await metered.finish(0, false).catch((e) => opsError("gateway.close_failed", e));
            metered = null;
            admittedExtra = false;
            sendBody = routedBody;
            // Its tools follow it back inside the login's share (Codex review).
            if (res instanceof CaptureResponse) res.meterWho = { who: loginTools(meterAs), provider };
          }
          pooled = { ...pooled, login: next.login };
          headers.authorization = `Bearer ${next.token}`;
        }
      }
    }
    // The wait ends early when the caller leaves; the listener goes with it.
    if (!abort.signal.aborted) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(t);
          abort.signal.removeEventListener("abort", done);
          resolve();
        };
        const t = setTimeout(done, wait);
        abort.signal.addEventListener("abort", done);
      });
    }
    if (isGone() || res.destroyed || abort.signal.aborted) {
      // Stopped while this waited: no try was billed. A caller still there
      // (the idle timer, not a hang-up) is answered, so its slot is freed.
      await metered?.finish(0, false).catch((e) => opsError("gateway.close_failed", e));
      clearTimeout(idle);
      if (isGone() || res.destroyed) return;
      return fail(res, 504, "no reply from the model provider");
    }
    quiet();
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
  // The model list: Anthropic's own, so it named models foldrun has no price
  // for, and a call to one was refused (claude-haiku-4-5, claude-sonnet-4-6
  // on dev, 25 Nov 2026). On foldrun's price list only, the list is what can
  // be called. A run on the operator's own unmetered credential is not
  // priced: its list stays whole (Codex). A login key's list stays whole too:
  // its calls go by the plan's share, and only past it (extra usage, the
  // wallet) by the price list — a list cannot know which a later call will
  // be, and hiding a model the plan covers is the worse mistake. "Can be
  // called" is admitCall's test on what the call would really be: the key's
  // model map and routeOf as a message takes them, then a price with nothing
  // missing (priceProblem), not just a row (Codex).
  if (listPriced && upstream.status === 200) {
    // Read whole to filter it, so read to a bound (Codex): a list is a few KB.
    const got = await readCapped(upstream, MODEL_LIST_MAX_BYTES);
    clearTimeout(idle);
    if (got === null) return fail(res, 502, "the model provider's model list was too large to read");
    const offered = offeredProviders();
    const listed = pricedModels(got, opts.search, (id) => {
      const routed = routeOf("POST", "/v1/messages", mapModel(Buffer.from(JSON.stringify({ model: id })), who.grant.models), opts.fromLease?.provider);
      if ("error" in routed || !routed.body) return false;
      const model = (JSON.parse(routed.body.toString("utf8")) as { model?: unknown }).model;
      if (typeof model !== "string") return false;
      // A model mapped to a provider taken off the list is refused too (Codex).
      if (routed.provider !== "anthropic" && !offered.includes(routed.provider)) return false;
      const price = listedPrice(routed.provider, model);
      return price !== null && priceProblem(SUPPLY_PROVIDERS[routed.provider], price) === null;
    });
    if (typeof listed !== "string") return fail(res, 400, listed.error);
    const shown = listed;
    out["content-type"] = "application/json";
    res.writeHead(200, out);
    res.end(shown);
    return;
  }
  res.writeHead(upstream.status, out);
  metered?.start(upstream.headers.get("content-type"));
  // A pooled login's reply is read for its usage (a message only), and the
  // pool is told what came back — once, whatever happens to the stream.
  const ok = upstream.status >= 200 && upstream.status < 300;
  const reader = pooled && ok && pathname === "/v1/messages" ? new UsageReader("anthropic", upstream.headers.get("content-type")) : null;
  const tell = async () => {
    if (!pooled) return;
    await pooled.pool
      .record({ tenant: who.tenant, keyId: who.keyId, plan: who.grant.plan }, { login: pooled.login, model: pooled.model, usage: reader?.result() ?? null, status: upstream.status, headers: limitHeaders(upstream), extra: metered !== null, streamed: /text\/event-stream/i.test(upstream.headers.get("content-type") ?? "") }, new Date())
      .catch((e) => opsError("gateway.login_record_failed", e));
  };
  if (!upstream.body) {
    await metered?.finish(upstream.status, true).catch((e) => opsError("gateway.close_failed", e));
    if (!ok) logUpstreamRefusal(upstream.status, "", { provider, model: loggedModel, tenant: who.tenant, key: who.keyId });
    await tell();
    clearTimeout(idle);
    return void res.end();
  }
  let complete = false;
  const beat = (upstream.headers.get("content-type") ?? "").includes("text/event-stream") ? sseKeepAlive(res) : null;
  // A refusal's body is kept as it goes past (the first REFUSAL_KEEP bytes),
  // so the log can say WHY Anthropic said no — the client still gets every
  // byte as it came, as it comes.
  const refusal = ok ? null : refusalTap();
  try {
    for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
      quiet();
      metered?.feed(chunk);
      reader?.feed(chunk);
      refusal?.feed(chunk);
      if (!res.write(chunk)) await drained(res);
      beat?.wrote(chunk);
    }
    complete = true;
  } catch {
    // The caller left or the provider cut off: charged at the estimate.
    if (!isGone() && !res.destroyed) noteEnd(res, abort.signal.aborted ? "timeout" : "upstream_cut");
  } finally {
    beat?.stop();
    clearTimeout(idle);
    await metered?.finish(upstream.status, complete).catch((e) => opsError("gateway.close_failed", e));
    res.end();
    if (refusal) logUpstreamRefusal(upstream.status, refusal.text(), { provider, model: loggedModel, tenant: who.tenant, key: who.keyId });
    await tell();
  }
}

/** How much of a refusal's body is kept to read its reason: Anthropic's
 *  error is a few hundred bytes; a proxy's HTML page is cut here. */
export const REFUSAL_KEEP = 16 * 1024;

/** Keeps the first REFUSAL_KEEP bytes of a reply that is passing through,
 *  and nothing past them. */
export function refusalTap(): { feed: (chunk: Uint8Array) => void; text: () => string } {
  const kept: Buffer[] = [];
  let size = 0;
  return {
    feed(chunk) {
      if (size >= REFUSAL_KEEP) return;
      const part = Buffer.from(chunk.subarray(0, REFUSAL_KEEP - size));
      kept.push(part);
      size += part.length;
    },
    text: () => Buffer.concat(kept).toString("utf8"),
  };
}

/** The error types Anthropic's API answers with (its errors page), the only
 *  ones a log line names as they are: anything else — another provider's
 *  own word, a proxy's — is "other". */
const UPSTREAM_ERROR_TYPES = new Set(["invalid_request_error", "authentication_error", "billing_error", "permission_error", "not_found_error", "request_too_large", "rate_limit_error", "api_error", "overloaded_error", "timeout_error"]);

/** Why a provider refused a call, as one of OUR words (a closed set) — read
 *  from its error's type, status and message, and the message never leaves
 *  this function (FOL-121: an error's words may quote the account's own
 *  request: a tool's name, a field, a file). The patterns are Anthropic's
 *  wording as its API answers; anything not matched is "other", so a word
 *  here is only ever a claim the text supports. */
export const UPSTREAM_REASONS = ["prompt_too_long", "max_tokens", "cache_control", "bad_image", "bad_document", "tool_blocks", "thinking", "unknown_model", "system_prompt", "billing", "beta_header", "sampling", "unknown_field", "auth", "rate_limit", "overloaded", "not_claude_code", "other"] as const;
export type UpstreamReason = (typeof UPSTREAM_REASONS)[number];
export function upstreamReason(status: number, type: string | null | undefined, message: string | null | undefined): UpstreamReason {
  const m = (typeof message === "string" ? message : "").slice(0, 4000);
  const t = typeof type === "string" ? type : "";
  // A subscription credential used outside Claude Code: its own words, whatever
  // status it came with.
  if (/only authori[sz]ed for use with Claude Code/i.test(m)) return "not_claude_code";
  // The provider's own type and status come before any word in the message
  // (Codex review, 19 Nov 2026): a rate limit that names "image" is a rate
  // limit.
  if (t === "rate_limit_error" || status === 429) return "rate_limit";
  if (t === "overloaded_error" || status === 529) return "overloaded";
  if (t === "authentication_error" || t === "permission_error" || status === 401 || status === 403) return "auth";
  if (t === "billing_error" || status === 402) return "billing";
  // Then where in the request it points, when the message opens with a field
  // path ("tools.3.custom.name: …", "messages.1.content.0.image.source…"):
  // the path is the API's, and says more than any word after it, which may
  // quote the account's own names.
  const path = /^([a-z_]+(?:\.[A-Za-z0-9_]+)*)\s*:/.exec(m)?.[1] ?? "";
  if (path) {
    if (/^tools\b/.test(path) || /^tool_choice\b/.test(path)) return "tool_blocks";
    if (/^system\b/.test(path)) return "system_prompt";
    if (/^thinking\b/.test(path) || /\.(thinking|redacted_thinking)\b/.test(path)) return "thinking";
    if (/^max_tokens$/.test(path)) return "max_tokens";
    if (/^(temperature|top_p|top_k)$/.test(path)) return "sampling";
    if (/\.cache_control\b/.test(path)) return "cache_control";
    if (/\.image\b/.test(path)) return "bad_image";
    if (/\.document\b/.test(path)) return "bad_document";
    if (/\.(tool_use|tool_result|tool_use_id)\b/.test(path)) return "tool_blocks";
    if (path === "model" && t === "not_found_error") return "unknown_model";
  }
  // Then the words. The context window: "prompt is too long: 215000 tokens >
  // 200000 maximum", "input length and `max_tokens` exceed context limit: …".
  if (/\bprompt is too long\b|exceed(s|ed)? (the )?context (limit|window)/i.test(m)) return "prompt_too_long";
  // Extended thinking: "Expected `thinking` or `redacted_thinking`…",
  // "`max_tokens` must be greater than `thinking.budget_tokens`" — before
  // max_tokens, which some of them also name.
  if (/\bthinking\b|budget_tokens/i.test(m)) return "thinking";
  // "max_tokens: 128000 > 64000, which is the maximum allowed number of
  // output tokens for …".
  if (/\bmax_tokens\b/i.test(m)) return "max_tokens";
  // "A maximum of 4 blocks with cache_control may be provided. Found 5."
  if (/\bcache_control\b/i.test(m)) return "cache_control";
  // "`tool_use` ids were found without `tool_result` blocks immediately
  // after", "unexpected `tool_use_id` found in `tool_result` blocks" —
  // before image and document, which a quoted tool name might be.
  if (/\btool_use(_id)?\b|\btool_result\b/i.test(m)) return "tool_blocks";
  // "Unexpected value(s) `x` for the `anthropic-beta` header".
  if (/anthropic-beta|\bbeta (header|flag)/i.test(m)) return "beta_header";
  // "Could not process image", "image exceeds 5 MB maximum", "image
  // dimensions exceed max allowed size".
  if (/\bimage\b/i.test(m)) return "bad_image";
  // "The PDF specified was not valid.", "A maximum of 100 PDF pages may be
  // provided."
  if (/\bpdf\b|\bdocument\b/i.test(m)) return "bad_document";
  // "`temperature` and `top_p` cannot both be specified for this model".
  if (/\b(temperature|top_p|top_k)\b/i.test(m)) return "sampling";
  // "… model … not found / does not exist / deprecated / is not supported".
  if (/\bmodel\b.{0,80}\b(not found|does not exist|not available|not supported|deprecated|retired)\b/i.test(m)) return "unknown_model";
  // "foo: Extra inputs are not permitted".
  if (/extra inputs are not permitted|unknown (field|parameter)|unexpected (field|parameter)/i.test(m)) return "unknown_field";
  // "Your credit balance is too low to access the Anthropic API", "You have
  // reached your specified API usage limits" (both a 400).
  if (/credit balance|usage limits/i.test(m)) return "billing";
  if (/invalid x-api-key|oauth token/i.test(m)) return "auth";
  return "other";
}

/** The type and message of an error body in Anthropic's shape
 *  ({"type":"error","error":{"type","message"}}), or nulls. */
export function upstreamError(text: string): { type: string | null; message: string | null } {
  try {
    const j = JSON.parse(text) as { error?: { type?: unknown; message?: unknown } };
    const e = j && typeof j === "object" ? j.error : undefined;
    return { type: e && typeof e.type === "string" ? e.type : null, message: e && typeof e.message === "string" ? e.message : null };
  } catch {
    return { type: null, message: null };
  }
}

/** `gateway.upstream_refused`: the provider's status, its error type (when it
 *  is one of Anthropic's), and our word for why — never the message. */
function logUpstreamRefusal(status: number, body: string, who: { provider: string; model: string | null; tenant: string; key: string }): void {
  const e = upstreamError(body);
  const kind = e.type && UPSTREAM_ERROR_TYPES.has(e.type) ? e.type : e.type ? "other" : undefined;
  // A run's call through the egress proxy has no key of its own (its `who`
  // says `runs:<tenant>`, which is not an id): left out, not counted dropped.
  const key = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(who.key) ? who.key : undefined;
  opsLog(status >= 500 ? "error" : "warn", "gateway.upstream_refused", { provider: who.provider, status, kind, reason: upstreamReason(status, e.type, e.message), model: who.model, tenant: who.tenant, key });
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
  let beat: ReturnType<typeof sseKeepAlive> | null = null;
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
      let msg: Record<string, unknown>;
      try {
        msg = t.wire === "responses" ? fromResponses(parsed, t.model) : fromChatCompletion(parsed, t.model, t.stops, t.extras);
      } catch (err) {
        // The provider did not finish the reply in a way Anthropic's format
        // can say (FOL-211): its own reason, as an error, never a 200. The
        // tokens it did produce are charged as for any reply.
        if (err instanceof UnfinishedReply) return fail(res, 502, err.message);
        throw err;
      }
      await saveExtras(tenant, t.extras);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(msg));
    } else {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      beat = sseKeepAlive(res);
      const machine = t.wire === "responses" ? new ResponsesStreamTranslator(t.model) : new StreamTranslator(t.model, t.stops, t.extras);
      const decoder = new TextDecoder();
      let buffer = "";
      // Whether the provider said it was done — `[DONE]`, a finish reason,
      // or a Responses end event. A stream that only stopped was cut off:
      // finishStream would dress it as a finished answer (Codex review,
      // 21 Nov 2026).
      let ended = false;
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
          if (data === "[DONE]") ended = true;
          if (!data || data === "[DONE]") continue;
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (upstreamEnded(t.wire, ev)) ended = true;
          for (const e of machine.feed(ev)) {
            if (!res.write(e)) await drained(res);
            beat?.wrote(e);
          }
        }
      }
      if (!ended) {
        // Charged at the estimate, as any reply cut off on the way.
        res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: "the provider's reply broke off before it ended — retry" } })}\n\n`);
        noteEnd(res, "upstream_cut");
        return void res.end();
      }
      complete = true;
      await saveExtras(tenant, t.extras);
      for (const e of machine.finishStream()) res.write(e);
      res.end();
    }
  } catch {
    // The caller left or the provider cut off: charged at the estimate.
    if (!res.headersSent) fail(res, 502, "the provider's reply could not be read");
    else {
      if (!res.destroyed) noteEnd(res, "upstream_cut");
      res.end();
    }
  } finally {
    beat?.stop();
    await metered?.finish(upstream.status, complete).catch((e) => opsError("gateway.close_failed", e));
  }
}

/** Whether one event of a provider's stream says the reply is over: a
 *  chat chunk with a finish reason, or a Responses end event (an `error`
 *  event too: the translator holds the provider's words and says them). */
export function upstreamEnded(wire: string, ev: Record<string, unknown>): boolean {
  if (wire === "responses") return ev.type === "response.completed" || ev.type === "response.incomplete" || ev.type === "response.failed" || ev.type === "error";
  const choices = ev.choices;
  return Array.isArray(choices) && choices.some((c) => !!c && typeof c === "object" && (c as { finish_reason?: unknown }).finish_reason != null);
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

/** What a reply says about the provider's limits: the headers a login pool
 *  reads (login-pool usedUpUntil). */
function limitHeaders(reply: Response): Record<string, string> {
  const out: Record<string, string> = {};
  reply.headers.forEach((v, k) => {
    if (/^(anthropic-ratelimit-|retry-after)/i.test(k)) out[k.toLowerCase()] = v;
  });
  return out;
}

export interface RetryPolicy {
  retries: number;
  baseMs: number;
  maxWaitMs: number;
}

/** How a call the provider did not take is sent again:
 *  FOLDRUN_GATEWAY_RETRIES (more tries after the first, 2; 0 turns it off),
 *  FOLDRUN_GATEWAY_RETRY_BASE_MS (the first wait, 500, doubled each try) and
 *  FOLDRUN_GATEWAY_RETRY_MAX_WAIT_MS (the longest one wait, 5000). Small on
 *  purpose: Claude Code retries for minutes by itself, and a caller's open
 *  call holds one of its key's slots while it waits here. */
export function retryPolicy(env: NodeJS.ProcessEnv = process.env): RetryPolicy {
  const n = (v: string | undefined, d: number, min: number) => {
    const x = Number(v);
    return v !== undefined && v !== "" && Number.isInteger(x) && x >= min ? x : d;
  };
  return { retries: Math.min(n(env.FOLDRUN_GATEWAY_RETRIES, 2, 0), 5), baseMs: n(env.FOLDRUN_GATEWAY_RETRY_BASE_MS, 500, 1), maxWaitMs: n(env.FOLDRUN_GATEWAY_RETRY_MAX_WAIT_MS, 5000, 1) };
}

/** A connection that was never made: nothing reached the provider. A
 *  certificate fault is not here — waiting does not mend one. */
const NEVER_CONNECTED = /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT)$/;
/** Replies that say "not now" and bill nothing. */
const BUSY = new Set([500, 502, 503, 504, 529]);

/**
 * How long to wait before sending a call again, or null when it is not
 * sent again. `status` is the provider's, null when the call threw (then
 * `code` is the socket's). A Retry-After the provider names is kept when it
 * is within the longest wait; a longer one goes back to the caller as it
 * came, because the caller can wait that long and this door should not.
 */
export function retryWaitMs(status: number | null, code: string, retryAfter: string | null, attempt: number, policy: RetryPolicy, random: () => number = Math.random): number | null {
  if (status === null) {
    if (!NEVER_CONNECTED.test(code)) return null;
  } else if (status !== 429 && !BUSY.has(status)) return null;
  if (retryAfter !== null && retryAfter.trim() !== "") {
    const s = Number(retryAfter);
    const ms = Number.isFinite(s) ? s * 1000 : Date.parse(retryAfter) - Date.now();
    if (!Number.isFinite(ms)) return null;
    return ms > policy.maxWaitMs ? null : Math.max(0, Math.round(ms));
  }
  const backoff = Math.min(policy.maxWaitMs, policy.baseMs * 2 ** attempt);
  return Math.round(backoff * (0.75 + random() * 0.5));
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

/** Every prompt-cache point in a Messages body, kept an hour (14 Nov 2026).
 *  Claude Code picks the cache's life itself: an hour when it is signed in to
 *  a Claude subscription, five minutes when it is handed a key — and through
 *  the gateway it only ever sees a key, so a login key's sessions went cold
 *  after five minutes away (proven on prod: every write `ephemeral_5m`). A
 *  login key IS a subscription, so its calls get the hour Claude Code would
 *  have asked for. Only the places a cache point may stand are touched — the
 *  body, tools, system blocks, message blocks and a tool result's blocks —
 *  never a tool's input; every point becomes 1h, so the API's rule that
 *  longer points come before shorter ones always holds. The same body in
 *  gives the same body out, so the cached prefix stays byte-stable turn to
 *  turn. Returned as it came when nothing changes or it is not JSON. */
export function longCache(body: Buffer | null): Buffer | null {
  if (!body) return body;
  let json: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return body;
    json = parsed as Record<string, unknown>;
  } catch {
    return body;
  }
  let changed = false;
  const mark = (o: unknown) => {
    if (!o || typeof o !== "object" || Array.isArray(o)) return;
    const cc = (o as Record<string, unknown>).cache_control;
    if (!cc || typeof cc !== "object" || Array.isArray(cc)) return;
    const c = cc as Record<string, unknown>;
    if (c.type !== "ephemeral" || c.ttl === "1h") return;
    (o as Record<string, unknown>).cache_control = { ...c, ttl: "1h" };
    changed = true;
  };
  const each = (list: unknown, also?: (o: Record<string, unknown>) => void) => {
    if (!Array.isArray(list)) return;
    for (const o of list) {
      mark(o);
      if (also && o && typeof o === "object") also(o as Record<string, unknown>);
    }
  };
  mark(json);
  each(json.tools);
  each(json.system);
  each(json.messages, (m) => each(m.content, (b) => b.type === "tool_result" && each(b.content)));
  return changed ? Buffer.from(JSON.stringify(json)) : body;
}

/** A Messages body that is a client's connection test, not a conversation:
 *  one short user turn, no tools, no system prompt of any size, and a reply
 *  capped at a few tokens. A chat asks for thousands of tokens; a test asks
 *  for one. Null for anything else, and for a body that does not read. */
export function connectionTestOf(body: Buffer | null): { model: string; stream: boolean; maxTokens: number } | null {
  if (!body) return null;
  let j: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    j = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const max = j.max_tokens;
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > CONNECTION_TEST_MAX_TOKENS) return null;
  if (Array.isArray(j.tools) && j.tools.length) return null;
  const msgs = j.messages;
  if (!Array.isArray(msgs) || msgs.length !== 1) return null;
  const m = msgs[0] as Record<string, unknown> | null;
  if (!m || m.role !== "user") return null;
  const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? (m.content as Record<string, unknown>[]).map((b) => (b && b.type === "text" && typeof b.text === "string" ? b.text : "\u0000")).join("") : "\u0000";
  if (text.includes("\u0000") || text.length > 200) return null;
  const sys = j.system;
  const sysLen = typeof sys === "string" ? sys.length : Array.isArray(sys) ? JSON.stringify(sys).length : 0;
  if (sysLen > 2000) return null;
  return { model: modelName(j.model) ?? "claude", stream: j.stream === true, maxTokens: max };
}

/** The largest reply cap a connection test asks for. */
const CONNECTION_TEST_MAX_TOKENS = 16;

/** The shape of a refused call, for the log: never its words. */
function requestShape(body: Buffer): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    // JSON, but not an object (`null`, a number): nothing more to say.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { bytes: body.length, json: true };
    const j = parsed as Record<string, unknown>;
    return {
      // A known model family, or "other" (logModel): a provider-prefixed
      // name (`anthropic/claude-…`) does not fit the field at all.
      model: logModel(typeof j.model === "string" ? j.model : null),
      maxTokens: typeof j.max_tokens === "number" ? j.max_tokens : null,
      messages: Array.isArray(j.messages) ? j.messages.length : null,
      tools: Array.isArray(j.tools) ? j.tools.length : 0,
      // The request's stream flag: `streaming`, a bool (`stream` is a word
      // field — stdout/stderr — and a bool there was dropped).
      streaming: j.stream === true,
      json: true,
      bytes: body.length,
    };
  } catch {
    return { bytes: body.length, json: false };
  }
}

/** A model name as it may go in a log: an identifier, or "other" — a
 *  caller can put anything in the field (Codex review). */
function modelName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return /^[A-Za-z0-9][A-Za-z0-9._:@\/-]{0,79}$/.test(v) ? v : "other";
}

/** The clients a log line names, by their User-Agent's first product token
 *  (compared without case): Claude Desktop, Claude Code, Anthropic's SDKs,
 *  the common HTTP libraries and coding tools. Any other is "other" — the
 *  header is the caller's own text, and a product token can be an internal
 *  name (Codex review, 19 Nov 2026), so only a word on this list is logged. */
const KNOWN_CLIENTS = ["Claude", "claude-cli", "claude-code", "Anthropic", "anthropic-sdk-python", "anthropic-sdk-typescript", "curl", "Wget", "python-requests", "python-httpx", "aiohttp", "node", "node-fetch", "undici", "axios", "Go-http-client", "okhttp", "Java", "Mozilla", "OpenAI", "litellm", "Cursor", "Zed", "opencode", "aider", "Cline", "Roo-Code", "Kilo-Code", "Continue", "Dart", "PostmanRuntime", "insomnia", "HTTPie"];
const KNOWN_CLIENT = new Map(KNOWN_CLIENTS.map((c) => [c.toLowerCase(), c]));

/** The client's first product token (`Claude/1.3.0`), for a log, as two
 *  ids — the product (`Claude`, from KNOWN_CLIENTS, else "other") and its
 *  version number (`1.3.0`) — since `/` does not fit an id and the whole
 *  token was dropped (19 Nov 2026). The version is its digits and dots
 *  alone (`1.3.0-payroll` gives `1.3.0`). Never the rest of the header; no
 *  header at all is "none". */
export function clientOf(ua: string | string[] | undefined): { client: string; clientVersion?: string } {
  const v = (Array.isArray(ua) ? ua[0] : ua) ?? "";
  if (!v.trim()) return { client: "none" };
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]{0,39})(?:\/(\S{1,40}))?/.exec(v);
  const client = (m && KNOWN_CLIENT.get(m[1].toLowerCase())) || "other";
  // A known client's version only, and at most three numbers: an unknown
  // product's "version" is the caller's text as much as its name, and four
  // dotted numbers can be an address (Codex review, 19 Nov 2026).
  const version = client !== "other" && m?.[2] ? /^\d{1,6}(\.\d{1,6}){0,2}/.exec(m[2])?.[0] : undefined;
  return version ? { client, clientVersion: version } : { client };
}

/** The words a model name is made of across the families the gateway
 *  routes; with digits and short letter-digit tokens (`v4`, `k3`, `4o`,
 *  `30b`, `a3b`) they spell every real model name. */
const MODEL_WORDS = new Set(["claude", "gpt", "gemini", "deepseek", "kimi", "moonshot", "glm", "qwen", "minimax", "mimo", "opus", "sonnet", "haiku", "fable", "instant", "mini", "nano", "pro", "flash", "lite", "turbo", "preview", "latest", "chat", "coder", "reasoner", "instruct", "thinking", "max", "plus", "codex", "exp", "high", "low", "medium", "fast", "vl", "oss", "air", "ultra", "long", "small", "large", "base", "beta", "alpha", "rc", "omni", "vision", "audio", "realtime", "search", "embedding", "next", "experimental"]);

/** A model name as the log's `model` field holds it, or "other": the field
 *  is the caller's string, and a refused call's model was never checked
 *  against anything, so a free-form name (`anthropic/my-secret-project`,
 *  `claude-private-project` — Codex review, 19 Nov 2026) is not copied into
 *  the log. A name is kept when it is in the id shape, opens with a family
 *  the gateway routes, and every part between `-`, `.` and `_` is a known
 *  model word, a number, or a short letter-digit token. Null when no name
 *  was given. */
export function logModel(v: string | null | undefined): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const name = v.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) return "other";
  const parts = name.toLowerCase().split(/[-._]/);
  if (!/^(claude|gpt|o\d|gemini|deepseek|kimi|moonshot|glm|qwen\d*|minimax|mimo)$/.test(parts[0]!)) return "other";
  const fits = (p: string) => p === "" || MODEL_WORDS.has(p) || /^\d{1,8}$/.test(p) || /^[a-z]{1,2}\d{1,3}[a-z]?$/.test(p) || /^\d{1,3}[a-z]{1,2}$/.test(p) || /^qwen\d{0,2}$/.test(p);
  // At most three numbers (`claude-sonnet-4-5-20250929` has three): four can
  // spell an address (`claude-10.24.8.17`, Codex review).
  return parts.every(fits) && parts.filter((p) => /^\d+$/.test(p)).length <= 3 ? name : "other";
}

/** What a connection test is told: OK, and, should a short chat land here,
 *  where a plan works. */
export const CONNECTION_TEST_REPLY = "OK. On a foldrun plan, use Claude Code: the terminal, or the Code tab in Claude Desktop.";

/** A connection test's answer, in the shape the client asked for. */
function answerConnectionTest(res: http.ServerResponse, probe: { model: string; stream: boolean }): void {
  const id = `msg_foldrun_${Date.now().toString(36)}`;
  const usage = { input_tokens: 0, output_tokens: 1 };
  const message = { id, type: "message", role: "assistant", model: probe.model, content: [{ type: "text", text: CONNECTION_TEST_REPLY }], stop_reason: "end_turn", stop_sequence: null, usage };
  if (!probe.stream) {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return void res.end(JSON.stringify(message));
  }
  const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  res.end(
    ev("message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } }) +
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: CONNECTION_TEST_REPLY } }) +
      ev("content_block_stop", { type: "content_block_stop", index: 0 }) +
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }) +
      ev("message_stop", { type: "message_stop" }),
  );
}

/** What a plan key's call from any other client than Claude Code is told. */
export const NOT_CLAUDE_CODE =
  "this Claude Code key works in Claude Code only: the terminal (claude), or the Code tab in Claude Desktop. Claude Desktop's chat is not supported on it — open the Code tab. For any other tool, use a foldrun API key (`foldrun keys create`); its calls count against the same subscription.";

/** The line Claude Code opens every request's system prompt with when it is
 *  signed in to a Claude subscription. */
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

/** Whether a request's User-Agent is Claude Code's (`claude-cli/2.1.3
 *  (external, cli)`; the Agent SDK and the desktop app's Code tab send the
 *  same client). */
export function fromClaudeCode(userAgent: string | string[] | undefined): boolean {
  const ua = Array.isArray(userAgent) ? userAgent[0] : userAgent;
  return typeof ua === "string" && /^claude-(cli|code)\//i.test(ua.trim());
}

/** A Messages body whose system prompt opens with Claude Code's identity
 *  line (17 Nov 2026). Anthropic answers a subscription login only to calls
 *  that open with it: proven on staging, where the same call got a bare 429
 *  without the line and 200 with it, on Haiku and on Sonnet. Signed in
 *  itself, Claude Code sends the line on every call; through the gateway it
 *  only ever sees a key, so its background calls (a session's title, a quick
 *  check) leave it out and were all refused — on prod every such call of a
 *  plan account came back 429 three times over. Only Claude Code's own
 *  requests get it (fromClaudeCode): the gateway restores what that client
 *  would have sent, it does not dress other traffic as Claude Code. A body
 *  that already carries the line in any block is returned as it came, so the
 *  cached prefix stays byte-stable; one that lacks it gets it where Claude
 *  Code puts it — after its billing-header block, else first. A body that is
 *  not a JSON object, or whose system prompt is not text, goes as it came. */
export function withClaudeCodeIdentity(body: Buffer | null): Buffer | null {
  if (!body) return body;
  let json: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return body;
    json = parsed as Record<string, unknown>;
  } catch {
    return body;
  }
  const line = { type: "text", text: CLAUDE_CODE_IDENTITY };
  const system = json.system;
  let next: unknown[];
  if (system === undefined || system === null || system === "") next = [line];
  else if (typeof system === "string") {
    if (system.includes(CLAUDE_CODE_IDENTITY)) return body;
    next = [line, { type: "text", text: system }];
  } else if (Array.isArray(system)) {
    // A text block's words; any other block (an image, a document, a
    // malformed one) has none here, whatever fields it carries (Codex).
    const textOf = (b: unknown) => {
      const r = b && typeof b === "object" ? (b as Record<string, unknown>) : null;
      return r && r.type === "text" && typeof r.text === "string" ? r.text : "";
    };
    // Claude Code's main calls already carry the line, as their SECOND block:
    // the first is its billing header (`x-anthropic-billing-header: …`),
    // seen 17 Nov 2026 on claude-cli 2.1.326. Anywhere in the prompt counts.
    if (system.some((b) => textOf(b).trimStart().startsWith(CLAUDE_CODE_IDENTITY))) return body;
    // Where Claude Code puts it itself: after the billing header, else first.
    const at = textOf(system[0]).startsWith("x-anthropic-billing-header:") ? 1 : 0;
    next = [...system.slice(0, at), line, ...system.slice(at)];
  } else return body;
  return Buffer.from(JSON.stringify({ ...json, system: next }));
}

/** Providers the gateway serves: Anthropic-format ones as they are, OpenAI
 *  (Responses) and Gemini (Chat Completions) through core's translator
 *  (Part A2, 10 Nov 2026); Z.ai, Qwen, MiniMax and MiMo on their own
 *  Anthropic-format endpoints (10 Nov 2026). */
const SERVED = new Set<SupplyProviderName>(["anthropic", "deepseek", "moonshot", "openai", "gemini", "zai", "qwen", "minimax", "mimo"]);

type Route =
  | { provider: SupplyProviderName; path: string; body: Buffer | null; estimate?: number }
  | { error: string; status: number; code?: string };

/** Where a call goes: the provider, its path, and the body with the model
 *  name as that provider knows it. */
const MODEL_LIST_MAX_BYTES = 2 * 1024 * 1024;

/** The caller's query for the whole list: its own settings kept (the SDK's
 *  `beta=true` — Codex), its paging replaced by one page of 1000. */
export function wholeListQuery(search: string): string {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  q.delete("after_id");
  q.delete("before_id");
  q.set("limit", "1000");
  return `?${q.toString()}`;
}

/** A reply's body as text, or null past `max` bytes (the rest not read). */
async function readCapped(r: Response, max: number): Promise<string | null> {
  const chunks: Uint8Array[] = [];
  let n = 0;
  for await (const chunk of (r.body ?? []) as unknown as AsyncIterable<Uint8Array>) {
    n += chunk.byteLength;
    if (n > max) {
      await r.body?.cancel().catch(() => {});
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** An Anthropic model list, asked for whole (newest first), kept to the
 *  models `priced` says yes to, then paged as the caller asked — limit
 *  (default 20, 1–1000), after_id, before_id — as Anthropic pages it (Codex).
 *  A body that is not a list goes back as it came. Past 1000 models the
 *  provider's later pages are not read: Anthropic lists a few dozen. */
export function pricedModels(body: string, search: string, priced: (id: string) => boolean): string | { error: string } {
  let j: { data?: unknown; first_id?: unknown; last_id?: unknown };
  try {
    j = JSON.parse(body);
  } catch {
    return body;
  }
  if (!j || typeof j !== "object" || !Array.isArray(j.data)) return body;
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const raw = q.get("limit");
  // As Anthropic answers it: a limit that is not a whole number 1–1000 is the
  // caller's mistake, not a default (Codex).
  if (raw !== null && !(/^\d+$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 1000)) return { error: "limit: a whole number from 1 to 1000" };
  const limit = raw === null ? 20 : Number(raw);
  const after = q.get("after_id");
  const before = q.get("before_id");
  // The cursor is found in the provider's own order, then what is priced on
  // its side is paged: a cursor model that lost its price since the last
  // page still marks the place (Codex).
  const rows = (j.data as { id?: unknown }[]).filter((m) => m && typeof m.id === "string") as { id: string }[];
  const keep = (xs: { id: string }[]) => xs.filter((m) => priced(m.id));
  let data: { id: string }[];
  let hasMore: boolean;
  if (before) {
    const at = rows.findIndex((m) => m.id === before);
    const side = keep(rows.slice(0, at < 0 ? 0 : at));
    data = side.slice(Math.max(0, side.length - limit));
    hasMore = side.length > limit;
  } else {
    const at = after ? rows.findIndex((m) => m.id === after) : -1;
    const side = keep(rows.slice(after ? (at < 0 ? rows.length : at + 1) : 0));
    data = side.slice(0, limit);
    hasMore = side.length > limit;
  }
  return JSON.stringify({ ...j, data, has_more: hasMore, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
}

export function routeOf(method: string, pathname: string, body: Buffer | null, leaseProvider?: SupplyProviderName): Route {
  // A run's call on a lease (foldrun's door): a GET has no model to say
  // whose it is, and a bare model id with no `provider/` is the lease
  // provider's own — a runtime strips the prefix for a subagent of the
  // same provider (Codex review, 23 Nov 2026).
  if (method === "GET") {
    if (leaseProvider && leaseProvider !== "anthropic") {
      const free = SUPPLY_PROVIDERS[leaseProvider].free?.find((f) => f.method === "GET");
      if (!free) return { error: `${leaseProvider} has no model list`, status: 404 };
      return { provider: leaseProvider, path: free.path, body: null };
    }
    return { provider: "anthropic", path: pathname, body: null };
  }
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
  const tier = codeTierModel(named);
  if (tier === "") return { error: `${named}: foldrun's tiers are fast, default and max`, status: 400 };
  const leaseNamed = leaseProvider && tier == null && !named.includes("/") ? `${leaseProvider}/${named}` : null;
  const r = providerOfModel(tier ?? leaseNamed ?? named);
  if (!r) return { code: "model_unavailable", error: `${named}: no provider of that name — write anthropic/, openai/, gemini/, deepseek/, kimi/, zai/, qwen/, minimax/ or mimo/ before the model, or a model name with a known prefix (claude-, gpt-, gemini-, deepseek-, kimi-, glm-, qwen, minimax-, mimo-)`, status: 400 };
  if (!SERVED.has(r.provider)) return { code: "model_unavailable", error: `${r.provider}'s models are not offered through the gateway`, status: 400 };
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

/** How an account's call is served (model-choice.ts accountRoute). */
let accountRouteFn: typeof accountRoute = accountRoute;
export function setGatewayAccountRouteForTests(fn: typeof accountRoute | null): void {
  accountRouteFn = fn ?? accountRoute;
}

/** The operator's own model credential, read fresh on every call as the
 *  runner reads it (runner.ts platformModelEnv): ANTHROPIC_API_KEY, else the
 *  Claude login (FOLDRUN_GATEWAY_LOGIN_FILE, the same mounted secret the
 *  worker's FOLDRUN_MODEL_KEY_FILE names). */
export type OperatorCredential = { kind: "key" | "bearer" | "login"; value: string };
export function operatorCredential(env: NodeJS.ProcessEnv = process.env): OperatorCredential | null {
  // A credential for another endpoint (ANTHROPIC_BASE_URL elsewhere) is
  // never sent to Anthropic: none here, and the call goes as any other
  // (Codex review, 23 Nov 2026).
  const base = env.ANTHROPIC_BASE_URL?.trim();
  if (base) {
    try {
      if (new URL(base).origin !== "https://api.anthropic.com") return null;
    } catch {
      return null;
    }
  }
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (key) return { kind: "key", value: key };
  const bearer = env.ANTHROPIC_AUTH_TOKEN?.trim();
  if (bearer) return { kind: "bearer", value: bearer };
  // The worker's name for the operator's login file (the egress pods carry
  // it under this name, so their login pool is not changed), then the
  // gateway's own login file and the environment's token.
  const file = env.FOLDRUN_MODEL_KEY_FILE;
  if (file) {
    try {
      const v = fs.readFileSync(file, "utf8").trim();
      if (v) return { kind: "login", value: v };
    } catch {
      // unreadable: the next
    }
  }
  const login = loginToken(env);
  return login ? { kind: "login", value: login } : null;
}
let operatorCredentialFn: () => OperatorCredential | null = () => operatorCredential();
export function setGatewayOperatorCredentialForTests(fn: (() => OperatorCredential | null) | null): void {
  operatorCredentialFn = fn ?? (() => operatorCredential());
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
/** The same, and — where the install keeps a pool of logins — the accounts
 *  the subscription decision lets in (23 Nov 2026: one decision, the same
 *  entitlementOf every other door asks): an active Pro or Max subscription,
 *  or an account the operator charges nothing (the platform's own, an
 *  unlimited one). A legacy platform plan is not a subscription to the pool.
 *  What minting, every call and a run on the subscription ask. A billing
 *  state that cannot be read allows nobody more; with no pool (a
 *  self-hosted install) only the operator's own grant counts, so "no
 *  billing" never opens the operator's login to every account. */
export async function loginAllowedFor(tenant: string): Promise<boolean> {
  return (await loginStandingOf(tenant)) === "yes";
}
/** The same, with a billing read that failed said as that (Codex review,
 *  23 Nov 2026): a paying run told to subscribe during an outage is worse
 *  than a 503 it retries. */
export async function loginStandingOf(tenant: string): Promise<"yes" | "no" | "unreadable"> {
  if (loginAllowedFn(tenant)) return "yes";
  if (!loginPoolFn()) return "no";
  const e = await entitlementOf(tenant);
  if (e.kind === "unreadable") {
    opsError("gateway.login_allowed_not_read", new Error(`the subscription of ${tenant} could not be read`));
    return "unreadable";
  }
  if (e.kind === "active") return e.source === "subscription" ? "yes" : "no";
  return e.kind === "exempt" && e.reason !== "self-hosted" ? "yes" : "no";
}
export const LOGIN_STANDING_UNREADABLE = "this account's subscription could not be read just now — nothing was sent or charged; try again in a moment";
export function setGatewayLoginAllowedForTests(fn: ((tenant: string) => boolean) | null): void {
  loginAllowedFn = fn ?? ((tenant) => platformKeyAllowedFor(tenant, edition() === "hosted"));
}

let server: http.Server | null = null;
let announceTimer: ReturnType<typeof setInterval> | null = null;
const ANNOUNCE_MS = 60 * 60 * 1000;
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
      // The operator's notice for callers in Iran (FOL-402), on every answer
      // to one: set here so a refusal, a stream and a usage line all carry it.
      // A bad notice never stops a model call (Codex, FOL-402).
      try {
        for (const [k, v] of Object.entries(noticeHeaders(noticeFor(req.headers)))) res.setHeader(k, v);
      } catch {
        /* no notice on this answer */
      }
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
      // The logins this gateway holds, said now and every hour (the pool's
      // `announce`): the operator's capacity view counts them, and an idle
      // gateway must not make them all read as gone (FOL-173, Codex review).
      const announce = () => void loginPoolFn()?.announce?.(new Date()).catch((err) => opsError("gateway.login_announce_failed", err));
      announce();
      announceTimer = setInterval(announce, ANNOUNCE_MS);
      announceTimer.unref();
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
    if (announceTimer) clearInterval(announceTimer);
    announceTimer = null;
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
