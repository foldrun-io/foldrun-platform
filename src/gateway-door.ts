// The gateway door (10 Nov 2026): the platform's Anthropic key for a coding
// agent. Claude Code, and any tool that takes an Anthropic base URL and key,
// sends its calls here with a `gateway` API key; the door checks and meters
// each one exactly as it meters a run's (model-gateway.ts admitCall) and sends
// it on with the platform's key, which only this process opens.
//
//   ANTHROPIC_BASE_URL=https://<gateway host>   ANTHROPIC_API_KEY=mda_…
//
// A listener of its own (FOLDRUN_GATEWAY_PORT, 8091), not the lease-based
// egress port: that one stays inside the cluster, this is the only door
// infra exposes. It serves three routes and nothing else —
//   POST /v1/messages              metered
//   POST /v1/messages/count_tokens free
//   GET  /v1/models                free
// — Anthropic models only; the key's own limits sit on top of the account's
// balance and daily supply limit. Spend is booked against the job
// `gateway:<key id>`, kind "coding", so a key's usage is its own.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { opsError } from "../../foldrun-core/src/ops-log.ts";
import { databaseEnabled } from "./db.ts";
import { findApiKeyByHashDb, touchApiKeyDb, type GatewayGrant } from "./api-keys-db.ts";
import { SUPPLY_PROVIDERS, type SupplyProviderName } from "../../foldrun-core/src/model-supply.ts";
import { providerPreset } from "../../foldrun-core/src/providers.ts";
import { ToolCallExtras, toResponses, toChatCompletions, fromResponses, fromChatCompletion, StreamTranslator, ResponsesStreamTranslator } from "../../foldrun-core/src/translator.ts";
import { accountStands, admitCall, supplyHostOf, supplyKeyOf, supplySchemeOk, type MeteredCall } from "./model-gateway.ts";
import { fetchPublic } from "./ssrf.ts";
import { cache, rateLimit } from "./cache.ts";
import { platformKeyAllowedFor } from "./settings.ts";
import { edition } from "./ledger.ts";


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

/** An error in Anthropic's own shape, which every client already parses. */
function fail(res: http.ServerResponse, status: number, message: string, extra: Record<string, string> = {}): void {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra });
  res.end(JSON.stringify({ type: "error", error: { type: ERR_TYPES[status] ?? "api_error", message } }));
}

export interface GatewayWho {
  keyId: string;
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
 *  every call against the cached record; a revocation reaches this pod
 *  within KEY_CACHE_MS (documented: at most 10 s). An unknown hash is
 *  cached too, so a flood of bad keys cannot reach the database. */
const KEY_CACHE_MS = 10_000;
const KEY_CACHE_MAX = 10_000;
const keyCache = new Map<string, { at: number; record: Awaited<ReturnType<typeof findApiKeyByHashDb>> }>();
async function cachedLookup(hash: string, now: number): Promise<Awaited<ReturnType<typeof findApiKeyByHashDb>>> {
  const hit = keyCache.get(hash);
  if (hit && now - hit.at < KEY_CACHE_MS) return hit.record;
  const record = await lookup(hash);
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
export async function authenticate(headers: http.IncomingHttpHeaders, now = Date.now()): Promise<{ who: GatewayWho } | { status: number; message: string }> {
  const presented = presentedKey(headers);
  if (!presented) return { status: 401, message: "send your foldrun gateway key as x-api-key (ANTHROPIC_API_KEY) or Authorization: Bearer (ANTHROPIC_AUTH_TOKEN)" };
  const record = await cachedLookup(crypto.createHash("sha256").update(presented).digest("hex"), now);
  if (!record) return { status: 401, message: "invalid API key" };
  if (record.revokedAt) return { status: 401, message: "API key revoked" };
  if (record.expiresAt && Date.parse(record.expiresAt) <= now) return { status: 401, message: `API key expired on ${record.expiresAt.slice(0, 10)} — mint a new one` };
  // Only a gateway key opens this door, and a gateway key opens nothing else
  // (the web funnel refuses it): an account key pasted into a coding agent
  // is refused here, not honoured.
  if (record.purpose !== "gateway" || !record.gateway) return { status: 403, message: "this is not a gateway key — mint one on Settings → API keys (or `foldrun keys create --gateway`)" };
  await noteUse(record, now);
  return { who: { keyId: record.id, tenant: record.tenant, grant: record.gateway } };
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
  const known = (method === "POST" && (pathname === "/v1/messages" || pathname === "/v1/messages/count_tokens")) || (method === "GET" && pathname === "/v1/models");
  if (!known) return fail(res, 404, `${method} ${pathname} is not served here — this gateway offers POST /v1/messages, POST /v1/messages/count_tokens and GET /v1/models`);
  if (!lookupReplaced && !databaseEnabled()) return fail(res, 503, "the gateway needs the platform's database");

  const auth = await authenticate(req.headers);
  if ("status" in auth) return fail(res, auth.status, auth.message);
  const { who } = auth;

  // Load limits, per key, on every route and every kind of key (login keys
  // and the free routes included — none of those are held by a dollar
  // limit). A real rate limit is a 429 with Retry-After: waiting does help.
  const rate = await rateLimit(`gw:${who.keyId}`, limits().rpm, 60);
  if (!rate.allowed) return fail(res, 429, `this key's request rate is reached (${limits().rpm} a minute) — slow down, or ask for a higher limit`, { "retry-after": String(rate.retryAfter) });
  const slot = await takeSlot(who.keyId, limits().concurrency);
  if (!slot.ok) return fail(res, 429, `this key has ${limits().concurrency} calls open at once already — wait for one to finish`, { "retry-after": "2" });
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

  let metered: MeteredCall | null = null;
  let sendBody: Buffer | null = route.body;
  let outBody: Buffer | null = route.body;
  let xlate: Translated | null = null;
  let credential: Record<string, string>;
  let betaExtra: string | null = null;
  if (who.grant.credential === "login") {
    // A Claude login is Anthropic's alone.
    if (provider !== "anthropic") return fail(res, 403, `a login gateway key runs on the operator's Claude login, Anthropic's models only — ${provider} needs a gateway key on foldrun's models`);
    if (route.estimate !== undefined) return fail(res, 400, "a login gateway key counts tokens on Anthropic's models only");
    // The operator's own Claude login (owner, 10 Nov 2026: "subscription, my
    // own use only"): for an account the operator allows its credential —
    // asked on every call, so taking that away closes the key at once. Not
    // metered or billed (the subscription is flat-rate) and no limits; the
    // token is read fresh each call, as the runner reads it, so a refresh
    // reaches the next call with no restart.
    if (!loginAllowed(who.tenant)) return fail(res, 403, "this account is not one the operator's Claude login is for — a login gateway key on it opens nothing");
    const token = loginToken();
    if (!token) return fail(res, 503, "the operator's Claude login is not available on this gateway");
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
    if (sp.format !== "anthropic" && route.body) {
      xlate = await translateRequest(who.tenant, provider, route.body);
      outBody = xlate.body;
    }
    const admitted = await admitCall(
      { tenant: who.tenant, kind: "coding", job: `gateway:${who.keyId}`, jobLimits: { capUsd: who.grant.capUsd ?? null, dailyUsd: who.grant.dailyUsd ?? null } },
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
  if (!upstream.body) {
    await metered?.finish(upstream.status, true).catch((e) => opsError("gateway.close_failed", e));
    clearTimeout(idle);
    return void res.end();
  }
  let complete = false;
  try {
    for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
      quiet();
      metered?.feed(chunk);
      if (!res.write(chunk)) await drained(res);
    }
    complete = true;
  } catch {
    // The caller left or the provider cut off: charged at the estimate.
  } finally {
    clearTimeout(idle);
    await metered?.finish(upstream.status, complete).catch((e) => opsError("gateway.close_failed", e));
    res.end();
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

/** Whether an account may use the operator's Claude login: the accounts the
 *  operator allows its own model credential (the console's grant, or
 *  FOLDRUN_PLATFORM_KEY_ACCOUNTS) — the same rule its desks' runs follow. */
let loginAllowedFn = (tenant: string) => platformKeyAllowedFor(tenant, edition() === "hosted");
export const loginAllowed = (tenant: string) => loginAllowedFn(tenant);
export function setGatewayLoginAllowedForTests(fn: ((tenant: string) => boolean) | null): void {
  loginAllowedFn = fn ?? ((tenant) => platformKeyAllowedFor(tenant, edition() === "hosted"));
}

let server: http.Server | null = null;

/** Start the door. Idempotent. A no-op unless FOLDRUN_GATEWAY_PORT is set or
 *  `force` — the egress role starts it only where infra exposes it. */
export function startGatewayDoor(listenPort = port()): Promise<{ port: number; close: (graceMs?: number) => Promise<boolean> }> {
  return new Promise((resolve, reject) => {
    if (server) {
      const a = server.address();
      return resolve({ port: typeof a === "object" && a ? a.port : listenPort, close: stopGatewayDoor });
    }
    const s = http.createServer((req, res) => {
      handle(req, res).catch((err) => {
        opsError("gateway.door_failed", err);
        fail(res, 500, "the gateway failed on this request");
      });
    });
    s.requestTimeout = 0; // a model call streams for minutes
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
    s.close(() => {
      clearTimeout(timer);
      resolve(!forced);
    });
    // Idle keep-alive sockets hold close() open; they carry no call.
    s.closeIdleConnections?.();
  });
}
