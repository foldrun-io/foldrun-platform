// The model gateway: the egress proxy's rules for a call on one of the
// platform's model keys ("foldrun's models", core model-supply.ts).
//
// Every call that fills a supply grant passes through here, whoever sent it —
// the SDK in a step, a translator, a script's own curl, a host job — so the
// bill is what passed through, not what a step says it spent:
//
//   1. the route must be one of the provider's model routes (metered) or a
//      free one (a model list, a token count); anything else is refused;
//   2. the key may be filled only in the provider's auth header, in its exact
//      shape — never the URL, never another header (egress-proxy.ts checks the
//      URL, this checks the headers);
//   3. the account must stand: the switch on, not refused, BOUGHT credit
//      above zero (settings.ts supplyStanding, the billing door). Plan
//      credits never pay for tokens on foldrun's models, so the balance
//      asked is the bought pot's, not the total. At zero a run that is
//      already going and has already used foldrun's models in this run may
//      finish, up to a small allowance (finishGraceUsd) — a step is not cut
//      off mid-run over money; a new run, a host job, or a run that had not
//      started on the platform's keys is refused (7 Nov 2026, FOL-125);
//   4. the model must be on the price list, with every price its provider's
//      usage can name;
//   5. the call's estimate is held against the account's day before it is
//      sent (model-usage.ts reserveCall) — no room, no call;
//   6. the reply streams back untouched while its usage is read; the row is
//      closed with what it cost, or at its estimate when no usage came back.
//
// An OpenAI-format stream is sent with stream_options.include_usage, so a
// stream always says what it used.

import { customerLimits } from "./customers.ts";
import { SUPPLY_PROVIDERS, isSupplyProvider, shapeRequest, type SupplyProvider, type SupplyProviderName } from "../../foldrun-core/src/model-supply.ts";
import { billing, type ExtraUsage, type PlanCover } from "./billing.ts";
import { BILLING_UNREADABLE, BILLING_UNREADABLE_MESSAGE, SUBSCRIPTION_REQUIRED, SUBSCRIPTION_REQUIRED_MESSAGE, entitlementOf, type Entitlement } from "./entitlement.ts";
import { databaseEnabled, withNamedLock } from "./db.ts";
import { setting, supplyStanding } from "./settings.ts";
import { supplyKey } from "./model-keys.ts";
import { callsOfRun, closeCall, reserveCall, type UsageKind, type UsageTokens } from "./model-usage.ts";

/** One model's price on the platform's list (foldrun-admin model_prices):
 *  USD per million tokens. A cache price left null is one this model's
 *  provider never reports, or one the operator has not set. */
export interface ModelPrice {
  version: number;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number | null;
  cacheWritePerMTok: number | null;
  /** The most output one call may ask for: the estimate's ceiling. */
  maxOutputTokens: number;
}

/** What the gateway needs from outside, swappable in tests. */
export interface GatewayDeps {
  price(provider: SupplyProviderName, model: string): ModelPrice | null;
  /** What the account can spend on foldrun's models, USD: its BOUGHT
   *  credit — never plan credit, which pays for compute, storage and network
   *  only. Null where nothing is billed. */
  balance(tenant: string): Promise<number | null>;
  /** What one run has been charged so far for its calls on the platform's
   *  keys (settled or not), at the margin in force, USD. */
  /** A run's model spend so far; walletOnly: only the calls the wallet
   *  paid (not a plan's). */
  runSpend(tenant: string, runId: string, walletOnly?: boolean): Promise<number>;
  /** How far past zero a run already using the platform's keys may go to
   *  finish, USD per run. Zero: a run is cut at zero like any other call. */
  finishGraceUsd(): number;
  /** The platform's key for a provider, or null where it holds none. */
  key(provider: SupplyProviderName): string | null;
  /** The one host a provider's key may go to. */
  host(provider: SupplyProviderName): string;
  /** Whether a plain-http target may carry the key: never, outside a test
   *  against a local fake. */
  plainHttp(): boolean;
  /** A plan's cover for a run's calls (billing().planCover), or null. */
  planCover(tenant: string, provider: string, incoming?: { model: string; estimateUsd: number }): Promise<PlanCover | null>;
  /** Runs `fn` alone among an account's plan-covered admissions (a lock
   *  across every copy of the gateway): the plan's room is read again and
   *  the call held in one step (Codex review, 20 Nov 2026). */
  planLock<T>(tenant: string, fn: () => Promise<T>): Promise<T>;
  /** Whether the account may start new paid work (entitlement.ts). */
  entitlement(tenant: string): Promise<Entitlement>;
  /** The account's extra usage this period (on, limit, spent), or null. */
  extraUsage(tenant: string): Promise<ExtraUsage | null>;
  /** Whether `usd` more of extra usage fits under the monthly limit. */
  extraUsageRoom(tenant: string, usd: number): Promise<Refusal | null>;
}

/** A plan admission's lock costs a connection of its own (db withNamedLock:
 *  a pooled one could deadlock its own queries). Calls of one account wait
 *  their turn here first, so each copy of the gateway holds at most one
 *  such connection per account, and at most PLAN_LOCKS in all (Codex
 *  review, 20 Nov 2026: unbounded, they could take every database slot). */
const PLAN_LOCKS = 8;
const tenantTails = new Map<string, Promise<unknown>>();
let locksHeld = 0;
const lockWaiters: (() => void)[] = [];
async function planLockLocal<T>(tenant: string, fn: () => Promise<T>): Promise<T> {
  const before = tenantTails.get(tenant) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = before.then(() => mine);
  tenantTails.set(tenant, tail);
  try {
    await before.catch(() => {});
    // A slot is handed straight to the next waiter, never put back for
    // another to take first (Codex review).
    if (locksHeld >= PLAN_LOCKS) await new Promise<void>((r) => lockWaiters.push(r));
    else locksHeld++;
    try {
      return await fn();
    } finally {
      const next = lockWaiters.shift();
      if (next) next();
      else locksHeld--;
    }
  } finally {
    release();
    if (tenantTails.get(tenant) === tail) tenantTails.delete(tenant);
  }
}

const BALANCE_TTL_MS = 5_000;
const balances = new Map<string, { at: number; usd: number | null }>();

/** A run's spend from its calls; walletOnly: the closed calls the wallet
 *  carried — an open one is an estimate that may close at nothing. */
export function runCost(rows: Array<{ costUsd: number; covered?: boolean; status: string }>, walletOnly?: boolean): number {
  return rows.filter((r) => !walletOnly || (r.covered !== true && r.status !== "open")).reduce((n, r) => n + r.costUsd, 0);
}

const realDeps: GatewayDeps = {
  price: (provider, model) => billing().modelPrice?.(provider, model) ?? null,
  async balance(tenant) {
    if (!billing().enabled()) return null;
    const hit = balances.get(tenant);
    if (hit && Date.now() - hit.at < BALANCE_TTL_MS) return hit.usd;
    // The bought pot (credits.ts creditBuckets), not the total. A build
    // that has no pots answers the total: there plan and bought are one.
    const b = billing();
    const usd = b.boughtBalanceUsd ? await b.boughtBalanceUsd(tenant) : await b.balanceUsd(tenant);
    balances.set(tenant, { at: Date.now(), usd });
    return usd;
  },
  async runSpend(tenant, runId, walletOnly) {
    // Wallet-paid: calls the wallet carried and that have closed — an open
    // reservation is only an estimate, and may still close at nothing, so
    // it never makes a run one the wallet "already paid for" (Codex review).
    const cost = runCost(await callsOfRun(tenant, runId), walletOnly);
    return billing().modelChargeOf?.(cost) ?? cost;
  },
  finishGraceUsd: () => finishGraceUsd(),
  key: (provider) => supplyKey(provider),
  host: (provider) => SUPPLY_PROVIDERS[provider].host,
  plainHttp: () => false,
  planCover: async (tenant, provider, incoming) => (await billing().planCover?.(tenant, provider, incoming)) ?? null,
  planLock: (tenant, fn) => (databaseEnabled() ? planLockLocal(tenant, () => withNamedLock(`plan-admit:${tenant}`, fn, 10_000)) : fn()),
  entitlement: (tenant) => entitlementOf(tenant),
  extraUsage: async (tenant) => (await billing().extraUsage?.(tenant)) ?? null,
  extraUsageRoom: async (tenant, usd) => (await billing().extraUsageRoom?.(tenant, usd)) ?? null,
};

/**
 * How far past zero one run may go to finish once it is using foldrun's
 * models (FOLDRUN_RUN_FINISH_GRACE_USD, default $1.00 = 100 credits per run).
 * It is a ceiling on what the platform carries, not a credit: the run's
 * calls are charged in full and the bought balance goes negative by what
 * they cost, to be repaid by the next purchase. A run that had not used
 * the platform's keys before the balance hit zero gets nothing — so plan
 * credit can never buy a free dollar of tokens by starting runs.
 */
export function finishGraceUsd(): number {
  const n = setting("models.supply.finish_grace_usd");
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 1;
}

let deps: GatewayDeps = realDeps;

/** For tests: replace what the gateway asks the outside world. */
export function setGatewayDepsForTests(d: Partial<GatewayDeps> | null): void {
  deps = d ? { ...realDeps, ...d } : realDeps;
  balances.clear();
}

/** The margin in force now — what one dollar of the price list is charged
 *  as — through the billing door (open code never imports pricing.ts); 1
 *  where nothing is billed. Kept on each call's row (model_usage.margin) so
 *  a margin changed later re-prices nothing already held. */
export function chargeMargin(): number {
  const c = billing().modelChargeOf?.(1_000_000);
  return c && c > 0 ? c / 1_000_000 : 1;
}

/** The providers the operator offers now (models.supply.providers). */
export function offeredProviders(): SupplyProviderName[] {
  const v = setting("models.supply.providers");
  return String(v ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(isSupplyProvider);
}

/** The platform's key for a supply grant's provider, for the proxy's fill. */
export function supplyKeyOf(provider: string): string | null {
  return isSupplyProvider(provider) ? deps.key(provider) : null;
}

/** Whether a target URL may carry the platform's key: https only (Codex
 *  review, 3 Nov 2026 — over http the key would cross the wire readable,
 *  whatever the provider then redirects to). */
export function supplySchemeOk(target: string): boolean {
  try {
    const proto = new URL(target).protocol;
    return proto === "https:" || (proto === "http:" && deps.plainHttp());
  } catch {
    return false;
  }
}

/** The one host a provider's key may be sent to. */
export function supplyHostOf(provider: SupplyProviderName): string {
  return deps.host(provider);
}

/** A refusal: the HTTP status, the sentence, and (since 23 Nov 2026) a
 *  code a program and the ops log can branch on — subscription_required,
 *  model_not_in_plan, extra_usage_cap, billing_unreadable. */
export type Refusal = { status: number; message: string; code?: string };

/** Whether a request on this route may use the key, and how. */
export function routeRule(p: SupplyProvider, method: string, pathname: string): "metered" | "free" | null {
  const m = method.toUpperCase();
  if (m === "POST" && p.metered.includes(pathname)) return "metered";
  if (p.free.some((f) => f.method === m && f.path === pathname)) return "free";
  return null;
}

/**
 * Where the request put the supply placeholder: only the provider's auth
 * header, whole. `headers` are as the pod sent them (before the fill). A
 * placeholder anywhere else — another header, a second credential beside it,
 * a prefix or suffix — is refused: the proxy would fill it, and a header the
 * provider echoes back would hand the key to the pod.
 */
export function placementProblem(p: SupplyProvider, name: string, headers: Record<string, string | string[] | undefined>): string | null {
  const ph = `\${${name}}`;
  let inAuth = false;
  for (const [k, v] of Object.entries(headers)) {
    const value = Array.isArray(v) ? v.join(", ") : v;
    if (value === undefined || !value.includes(ph)) continue;
    const key = k.toLowerCase();
    if (p.auth === "x-api-key" && key === "x-api-key" && value.trim() === ph) inAuth = true;
    else if (p.auth === "bearer" && key === "authorization" && /^Bearer\s+/i.test(value) && value.replace(/^Bearer\s+/i, "").trim() === ph) inAuth = true;
    else return `the platform's key may only be sent as ${p.auth === "x-api-key" ? "the x-api-key header" : "Authorization: Bearer"} — not in ${k}`;
  }
  return inAuth ? null : `the platform's key was not sent in ${p.auth === "x-api-key" ? "x-api-key" : "Authorization"}`;
}

/** What a call's body asks for, read before it is sent; for an
 *  OpenAI-format stream, the body is rewritten to ask for its usage. */
export function readCall(p: SupplyProvider, body: Buffer, ceiling?: (model: string) => number | null): { model: string; maxTokens: number | null; stream: boolean; body: Buffer; mediaTokens: number; inline?: { documents: boolean; images: number } } | Refusal {
  let json: Record<string, unknown>;
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    json = parsed as Record<string, unknown>;
  } catch {
    return { status: 400, message: "foldrun's models: the request body is not a JSON object" };
  }
  const model = typeof json.model === "string" ? json.model.trim() : "";
  if (!model) return { status: 400, message: "foldrun's models: the request names no model" };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null);
  const paid = paidExtra(p, json);
  if (paid) return { status: 400, message: `foldrun's models: ${paid} is not offered on the platform's keys (it is billed outside tokens, or keeps or runs something on the provider's side) — use your own key for it` };
  // One completion per call: n > 1 would multiply what the call can spend
  // past what it was held at (Codex review, 3 Nov 2026).
  if (json.n !== undefined && json.n !== null && json.n !== 1) return { status: 400, message: "foldrun's models: one completion per call (n must be 1)" };
  // Only what this provider's API documents (model-supply.ts send): the
  // agent runtime sends Claude's whole surface to every endpoint.
  let changed = shapeRequest(p, json);
  // The standard tier, said outright: an omitted tier is "auto", which may
  // land on a dearer one than the price list's (Codex review).
  if ((json.service_tier === undefined || (p.name === "openai" && json.service_tier === "auto")) && (p.name === "anthropic" || p.name === "openai")) {
    json.service_tier = p.name === "anthropic" ? "standard_only" : "default";
    changed = true;
  }
  // The Responses API keeps a response on OpenAI's side unless told not to,
  // and the default is to keep it: say no, outright. (An explicit store:true
  // was refused above; an omitted one would otherwise store under our key.)
  if (p.format === "responses" && json.store === undefined) {
    json.store = false;
    changed = true;
  }
  const media = mediaOf(p, json);
  if (typeof media === "string") return { status: 400, message: `foldrun's models: ${media} cannot be priced before the call — attach it inline, or use your own key` };
  let maxTokens =
    p.format === "openai" ? num(json.max_completion_tokens) ?? num(json.max_tokens) : p.format === "responses" ? num(json.max_output_tokens) : num(json.max_tokens);
  // The output limit SENT is the one the call is held at: a request asking
  // for more (or, on OpenAI's format, for no limit at all) is held to the
  // price list's ceiling, so the hold is a true bound on what it can cost.
  const max = ceiling?.(model) ?? null;
  if (max !== null && (maxTokens === null || maxTokens > max)) {
    maxTokens = max;
    if (p.format === "openai") {
      if (json.max_tokens !== undefined && json.max_completion_tokens === undefined) json.max_tokens = max;
      else json.max_completion_tokens = max;
    } else if (p.format === "responses") json.max_output_tokens = max;
    else json.max_tokens = max;
    changed = true;
  }
  const stream = json.stream === true;
  if (p.format === "openai" && stream) {
    const so = json.stream_options && typeof json.stream_options === "object" ? (json.stream_options as Record<string, unknown>) : {};
    if (so.include_usage !== true) {
      json.stream_options = { ...so, include_usage: true };
      changed = true;
    }
  }
  return { model, maxTokens, stream, body: changed ? Buffer.from(JSON.stringify(json)) : body, mediaTokens: media, inline: inlineMediaOf(p, json) };
}

/** What a wallet bound must allow beyond the body's bytes (Codex review,
 *  FOL-208): whether a document is inline (billed as extracted text and
 *  rendered pages, which its bytes do not bound) and how many images are
 *  inline (billed by pixels or tiles, not bytes). Only the provider's own
 *  content blocks are read — a message's parts and a tool result's — never
 *  a tool call's arguments, which may say anything. */
export function inlineMediaOf(p: SupplyProvider, json: Record<string, unknown>): { documents: boolean; images: number } {
  let documents = false;
  let images = 0;
  const look = (b: Record<string, unknown>) => {
    if (b.type === "document" || b.type === "file" || b.type === "input_file") documents = true;
    // Inline images only: one by URL already has its room (mediaOf, MEDIA_URL_TOKENS).
    else if (b.type === "image" && (b.source as Record<string, unknown> | undefined)?.type !== "url") images++;
    else if (b.type === "image_url" && String((b.image_url as Record<string, unknown> | undefined)?.url ?? "").startsWith("data:")) images++;
    else if (b.type === "input_image" && String(b.image_url ?? "").startsWith("data:")) images++;
  };
  if (p.format === "responses") {
    for (const item of Array.isArray(json.input) ? (json.input as unknown[]) : []) {
      if (!item || typeof item !== "object") continue;
      for (const part of responsesParts(item as Record<string, unknown>)) if (part && typeof part === "object") look(part as Record<string, unknown>);
    }
    return { documents, images };
  }
  for (const m of Array.isArray(json.messages) ? (json.messages as unknown[]) : []) {
    const content = m && typeof m === "object" ? (m as Record<string, unknown>).content : undefined;
    const blocks: unknown[] = Array.isArray(content) ? [...content] : [];
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i] as Record<string, unknown> | null;
      if (!b || typeof b !== "object") continue;
      look(b);
      // A tool result's own content blocks — not a tool call's input.
      if (b.type === "tool_result" && Array.isArray(b.content)) blocks.push(...(b.content as unknown[]));
    }
  }
  return { documents, images };
}

/** A wallet bound's room per inline image: more than any provider bills
 *  one image at its largest size (Anthropic ~1,600 tokens at 1568 px; an
 *  OpenAI high-detail image a few thousand), many times over. */
export const WALLET_BOUND_IMAGE_TOKENS = 20_000;

/** A wallet bound's input for a call with a document inline: the largest
 *  context window foldrun's models take — no call can be billed for more. */
export const WALLET_BOUND_DOCUMENT_TOKENS = 2_000_000;

/** Input the body's size does not show: an image fetched from a URL is
 *  billed by its pixels, not by the URL. Each is held at a generous
 *  allowance; a document by URL (pages unknown) is refused. Inline media
 *  is in the body, and its bytes already count. */
export const MEDIA_URL_TOKENS = 10_000;
function mediaOf(p: SupplyProvider, json: Record<string, unknown>): number | string {
  let tokens = 0;
  if (p.format === "responses") {
    for (const item of Array.isArray(json.input) ? (json.input as unknown[]) : []) {
      if (!item || typeof item !== "object") continue;
      for (const part of responsesParts(item as Record<string, unknown>)) {
        if (!part || typeof part !== "object") continue;
        const b = part as Record<string, unknown>;
        if (b.type === "input_image") {
          // A file id names a file kept on the provider's side: refused.
          if (b.file_id !== undefined) return "an image by file id";
          if (typeof b.image_url === "string" && !b.image_url.startsWith("data:")) tokens += MEDIA_URL_TOKENS;
        } else if (b.type === "input_file" && (b.file_url !== undefined || b.file_id !== undefined)) return "a document by URL or file id";
      }
    }
    return tokens;
  }
  for (const m of Array.isArray(json.messages) ? (json.messages as unknown[]) : []) {
    const content = m && typeof m === "object" ? (m as Record<string, unknown>).content : undefined;
    const blocks: unknown[] = Array.isArray(content) ? [...content] : [];
    // Anthropic nests content in tool results.
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i] as Record<string, unknown> | null;
      if (!b || typeof b !== "object") continue;
      if (Array.isArray(b.content)) blocks.push(...(b.content as unknown[]));
      if (p.format === "openai") {
        const url = (b.image_url as Record<string, unknown> | undefined)?.url;
        if (b.type === "image_url" && typeof url === "string" && !url.startsWith("data:")) tokens += MEDIA_URL_TOKENS;
        continue;
      }
      // A file by id (Files API) or a code-execution container's file lives
      // on the provider's side: refused, however it is wrapped.
      if (b.type === "container_upload") return "a container file";
      const src = b.source as Record<string, unknown> | undefined;
      if (src?.type === "file" || (src && src.file_id !== undefined)) return `a ${String(b.type)} by file id`;
      if (src?.type !== "url") continue;
      if (b.type === "image") tokens += MEDIA_URL_TOKENS;
      else return `a ${String(b.type)} by URL`;
    }
  }
  return tokens;
}

/** Client tools: the model asks, the caller runs them — billed as tokens
 *  only. Anything else with a `type` is a provider-run tool (web search,
 *  web fetch, code execution, MCP) billed per use, which the price list
 *  does not price yet (Codex review, 3 Nov 2026). */
const CLIENT_TOOL = /^(custom|bash_\d+|text_editor_\d+|computer_\d+)$/;

/** Whether any cache_control in the request asks for a ttl other than 5m. */
function longCache(v: unknown, depth = 0): boolean {
  if (depth > 64 || !v || typeof v !== "object") return false;
  if (Array.isArray(v)) return v.some((x) => longCache(x, depth + 1));
  const o = v as Record<string, unknown>;
  const cc = o.cache_control;
  if (cc && typeof cc === "object" && (cc as Record<string, unknown>).ttl !== undefined && (cc as Record<string, unknown>).ttl !== "5m") return true;
  return Object.values(o).some((x) => longCache(x, depth + 1));
}

/** The request fields a call on the platform's key may carry: the ones
 *  billed as plain tokens at the price list's rates. An allowlist, not a
 *  list of what to refuse — a provider's next priced option (a service
 *  tier, audio, a fallback model list) is refused until it has a price
 *  (Codex review, 3 Nov 2026). What the runtime's SDK and translator send
 *  is all here; a refusal names the field, so a new one is one line. */
const ANTHROPIC_FIELDS = new Set([
  "model", "messages", "system", "max_tokens", "metadata", "stop_sequences", "stream", "temperature", "top_p", "top_k",
  "tools", "tool_choice", "thinking", "context_management", "output_format", "output_config", "service_tier",
]);
const OPENAI_FIELDS = new Set([
  "model", "messages", "stream", "stream_options", "max_tokens", "max_completion_tokens", "temperature", "top_p",
  "tools", "tool_choice", "parallel_tool_calls", "stop", "user", "prompt_cache_key", "reasoning_effort", "response_format",
  "seed", "presence_penalty", "frequency_penalty", "n", "service_tier",
]);
/** OpenAI's Responses API (GPT-6: tool calling is Responses-only, 3 Nov
 *  2026). No `previous_response_id`, `conversation`, `background` or
 *  `prompt`: each call carries its whole transcript, as the translator
 *  sends it. `store` passes only as false (paidExtra); omitted, readCall sets it. */
const RESPONSES_FIELDS = new Set([
  "model", "input", "instructions", "stream", "store", "max_output_tokens", "temperature", "top_p",
  "tools", "tool_choice", "parallel_tool_calls", "reasoning", "safety_identifier", "prompt_cache_key", "user",
  "text", "include", "metadata", "service_tier", "truncation",
]);
/** Responses input: items the transcript is made of, and the message parts
 *  billed as tokens (a file only inline — by URL or id it is refused). */
const RESPONSES_ITEMS = new Set(["message", "function_call", "function_call_output", "reasoning"]);
const RESPONSES_PARTS = new Set(["input_text", "output_text", "input_image", "input_file", "refusal"]);
/** The parts of one Responses input item: a message's `content`, and a
 *  tool result's `output` when it is a list (text, images, files). */
function responsesParts(it: Record<string, unknown>): unknown[] {
  return [...(Array.isArray(it.content) ? it.content : []), ...(Array.isArray(it.output) ? it.output : [])];
}
/** Message parts on OpenAI's format billed as tokens: text and images. */
const OPENAI_PARTS = new Set(["text", "image_url"]);

/** What in a request would be billed outside its tokens, named, or null. */
export function paidExtra(p: SupplyProvider, json: Record<string, unknown>): string | null {
  const allowed = p.format === "anthropic" ? ANTHROPIC_FIELDS : p.format === "responses" ? RESPONSES_FIELDS : OPENAI_FIELDS;
  for (const k of Object.keys(json)) if (!allowed.has(k)) return `the request field ${k}`;
  // Only the standard tier is the price list's.
  const tier = json.service_tier;
  if (tier !== undefined && !(p.format === "anthropic" ? tier === "standard_only" : tier === "auto" || tier === "default")) {
    return `the service tier ${String(tier)}`;
  }
  if (p.format === "responses") {
    // A stored response is data kept on OpenAI's side under our key. Only
    // false passes; an omitted one is set to false by readCall.
    if (json.store !== undefined && json.store !== false) return "store (a response kept on the provider's side; send store: false)";
    for (const item of Array.isArray(json.input) ? (json.input as unknown[]) : []) {
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, unknown>;
      const type = it.type ?? (it.role ? "message" : undefined);
      if (typeof type !== "string" || !RESPONSES_ITEMS.has(type)) return `a ${String(type)} input item`;
      // A tool result's output may be a list of parts too (Codex review).
      for (const part of responsesParts(it)) {
        const t = part && typeof part === "object" ? (part as Record<string, unknown>).type : undefined;
        if (typeof t !== "string" || !RESPONSES_PARTS.has(t)) return `a ${String(t)} message part`;
      }
    }
  }
  if (p.format === "openai") {
    for (const m of Array.isArray(json.messages) ? (json.messages as unknown[]) : []) {
      const content = m && typeof m === "object" ? (m as Record<string, unknown>).content : undefined;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        const type = part && typeof part === "object" ? (part as Record<string, unknown>).type : undefined;
        if (typeof type !== "string" || !OPENAI_PARTS.has(type)) return `a ${String(type)} message part`;
      }
    }
  }
  // A tool_choice may name a provider-run tool (web search, file search,
  // code interpreter, MCP) as well as a function: only a function passes.
  if (p.format !== "anthropic" && json.tool_choice && typeof json.tool_choice === "object") {
    const tc = json.tool_choice as Record<string, unknown>;
    if (tc.type === "allowed_tools") {
      for (const t of Array.isArray(tc.tools) ? (tc.tools as unknown[]) : []) {
        const type = t && typeof t === "object" ? (t as Record<string, unknown>).type : undefined;
        if (type !== "function") return `the tool choice ${String(type)}`;
      }
    } else if (tc.type !== "function") return `the tool choice ${String(tc.type)}`;
  }
  const tools = Array.isArray(json.tools) ? (json.tools as unknown[]) : [];
  if (p.format === "anthropic") {
    for (const t of tools) {
      const type = t && typeof t === "object" ? (t as Record<string, unknown>).type : undefined;
      if (type !== undefined && (typeof type !== "string" || !CLIENT_TOOL.test(type))) return `the server tool ${String(type)}`;
    }

    // A one-hour cache write is priced apart from the five-minute one the
    // price list's cache-write figure is for (Codex review).
    if (longCache(json)) return "a one-hour prompt cache (cache_control ttl other than 5m)";

  } else {
    for (const t of tools) {
      const type = t && typeof t === "object" ? (t as Record<string, unknown>).type : undefined;
      if (type !== "function") return `the tool type ${String(type)}`;
    }

  }
  return null;
}

/** A price list entry is usable for a provider when it names every price
 *  that provider's usage can report: Anthropic's format reports cache
 *  writes and reads; OpenAI's reports cached reads (null: charged at the
 *  input price, never less). */
export function priceProblem(p: SupplyProvider, price: ModelPrice): string | null {
  if (!(price.inputPerMTok >= 0) || !(price.outputPerMTok >= 0) || !(price.maxOutputTokens > 0)) return "its price list entry is incomplete";
  if (p.format === "anthropic" && (price.cacheReadPerMTok === null || price.cacheWritePerMTok === null)) return "its price list entry has no cache prices";
  return null;
}

/** USD for what a call used. A cache price the list leaves null is charged
 *  at the input price: never less than the provider could bill. */
export function costOf(t: UsageTokens, price: ModelPrice): number {
  const per = (n: number, perM: number) => (n * perM) / 1_000_000;
  return (
    per(t.input, price.inputPerMTok) +
    per(t.output, price.outputPerMTok) +
    per(t.cacheRead, price.cacheReadPerMTok ?? price.inputPerMTok) +
    per(t.cacheWrite, price.cacheWritePerMTok ?? price.inputPerMTok)
  );
}

/** What a call is held at before it is sent: its input read generously
 *  from the body's size (a token per 3 bytes, at most 1M), every cache price
 *  at its dearest, and every output token it may ask for. */
/** Room in a wallet bound for the tokens a provider adds itself — the
 *  system prompt a tools definition brings (a few hundred on Anthropic),
 *  many times over (Codex review, FOL-208). */
export const WALLET_BOUND_EXTRA_TOKENS = 8192;

export function estimateOf(bodyBytes: number, maxTokens: number | null, price: ModelPrice, mediaTokens = 0, capInput = true): number {
  const input = (capInput ? Math.min(Math.ceil(bodyBytes / 3), 1_000_000) : Math.ceil(bodyBytes / 3)) + mediaTokens;
  const dearestIn = Math.max(price.inputPerMTok, price.cacheWritePerMTok ?? 0, price.cacheReadPerMTok ?? 0);
  const output = Math.min(maxTokens ?? price.maxOutputTokens, price.maxOutputTokens);
  return (input * dearestIn + output * price.outputPerMTok) / 1_000_000;
}

// ------------------------------------------------------------- the meter

/**
 * Reads usage out of a reply as it streams past. Anthropic's format reports
 * it in message_start (input, cache) and message_delta (output, running
 * totals); a non-streamed reply in its `usage`. OpenAI's reports it in the
 * last chunk (include_usage) or the reply's `usage`, its prompt_tokens
 * counting the cached ones too.
 */
export class UsageReader {
  private sse: boolean;
  private format: "anthropic" | "openai" | "responses";
  private carry = "";
  private json: Buffer[] = [];
  private jsonBytes = 0;
  private overflow = false;
  private usage: UsageTokens | null = null;
  /** The reply said its last word on usage: Anthropic's message_delta,
   *  OpenAI's usage chunk, a JSON reply's usage. A stream that stopped
   *  before it (an error event, then a clean end) is not complete. */
  private final = false;
  static readonly JSON_MAX = 16 * 1024 * 1024;

  constructor(format: "anthropic" | "openai" | "responses" | string, contentType: string | null) {
    this.format = format === "openai" || format === "responses" ? format : "anthropic";
    this.sse = /text\/event-stream/i.test(contentType ?? "");
  }

  feed(chunk: Uint8Array): void {
    if (!this.sse) {
      if (this.overflow) return;
      this.jsonBytes += chunk.byteLength;
      if (this.jsonBytes > UsageReader.JSON_MAX) {
        this.overflow = true;
        this.json = [];
        return;
      }
      this.json.push(Buffer.from(chunk));
      return;
    }
    this.carry += Buffer.from(chunk).toString("utf8");
    let nl: number;
    while ((nl = this.carry.indexOf("\n")) >= 0) {
      const line = this.carry.slice(0, nl).replace(/\r$/, "");
      this.carry = this.carry.slice(nl + 1);
      if (line.startsWith("data:")) this.event(line.slice(5).trim());
    }
    // A line that never ends is not an event; keep only a bounded tail.
    if (this.carry.length > 1_000_000) this.carry = this.carry.slice(-1_000_000);
  }

  /** The usage the reply reported, or null when it said none. */
  result(): UsageTokens | null {
    if (this.sse) {
      if (this.carry.startsWith("data:")) this.event(this.carry.slice(5).trim());
      this.carry = "";
      return this.final ? this.usage : null;
    }
    if (this.overflow) return null;
    try {
      const body = JSON.parse(Buffer.concat(this.json).toString("utf8")) as Record<string, unknown>;
      this.take(body.usage);
      this.final = this.usage !== null;
    } catch {
      return null;
    }
    return this.final ? this.usage : null;
  }

  private event(data: string): void {
    if (!data || data === "[DONE]") return;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (this.format === "openai") {
      if (ev.usage) {
        this.take(ev.usage);
        this.final = this.usage !== null;
      }
      return;
    }
    if (this.format === "responses") {
      // The reply's last event carries the response with its usage — a
      // completed one, or one cut short at its output limit. A failed or
      // errored one never completed.
      if (ev.type === "response.completed" || ev.type === "response.incomplete") {
        this.take((ev.response as Record<string, unknown> | undefined)?.usage);
        this.final = this.usage !== null;
      } else if (ev.type === "response.failed" || ev.type === "error") this.final = false;
      return;
    }
    if (ev.type === "message_start") this.take((ev.message as Record<string, unknown> | undefined)?.usage);
    else if (ev.type === "message_delta") {
      this.take(ev.usage);
      // The last word on usage only when it says what the reply cost: an
      // endpoint whose message_delta carries no output count (MiMo documents
      // usage as nullable) leaves the call at its hold, never at its input.
      const u = ev.usage as Record<string, unknown> | null | undefined;
      this.final = this.usage !== null && typeof u?.output_tokens === "number";
    } else if (ev.type === "error") this.final = false;
  }

  private take(u: unknown): void {
    if (!u || typeof u !== "object") return;
    const x = u as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
    const cur = this.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    if (this.format === "responses") {
      // input_tokens counts the cached ones too; output_tokens the reasoning.
      const inp = n(x.input_tokens);
      const out = n(x.output_tokens);
      const cached = n((x.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens) ?? 0;
      if (inp === null && out === null) return;
      this.usage = { input: Math.max(0, (inp ?? 0) - cached), output: out ?? 0, cacheRead: cached, cacheWrite: 0 };
      return;
    }
    if (this.format === "openai") {
      const prompt = n(x.prompt_tokens);
      const out = n(x.completion_tokens);
      const cached = n((x.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens) ?? 0;
      if (prompt === null && out === null) return;
      this.usage = { input: Math.max(0, (prompt ?? 0) - cached), output: out ?? 0, cacheRead: cached, cacheWrite: 0 };
      return;
    }
    // Anthropic: message_start carries input and cache, message_delta the
    // running output (and, on newer APIs, the inputs again): later wins.
    const input = n(x.input_tokens);
    const output = n(x.output_tokens);
    const cw = n(x.cache_creation_input_tokens);
    const cr = n(x.cache_read_input_tokens);
    if (input === null && output === null && cw === null && cr === null) return;
    this.usage = {
      input: input ?? cur.input,
      output: output ?? cur.output,
      cacheWrite: cw ?? cur.cacheWrite,
      cacheRead: cr ?? cur.cacheRead,
    };
  }
}

/** One admitted call: feed it the reply, then finish it exactly once. */
export interface MeteredCall {
  id: string;
  provider: SupplyProviderName;
  model: string;
  /** The reply's headers are in: its content type decides how it is read. */
  start(contentType: string | null): void;
  feed(chunk: Uint8Array): void;
  /** `complete`: the reply was read to its end. A reply that was not, or
   *  that reported no usage, stands at its estimate. A refusal from the
   *  provider (not 2xx) cost nothing. */
  finish(status: number, complete: boolean): Promise<{ costUsd: number; estimated: boolean }>;
}

export interface CallWho {
  tenant: string;
  kind: UsageKind;
  runId?: string | null;
  step?: number | null;
  job?: string | null;
  /** The job's own limits (a gateway key's), held with the account's. */
  jobLimits?: { capUsd: number | null; dailyUsd: number | null; walletUsd?: number };
  /** FOL-168: the end customer the call is for — its row says so, and its
   *  daily limit on foldrun's models (customers.ts) is held with the rest. */
  customer?: string | null;
  /** False: never on the plan's allowance — a login key past its share
   *  whose extra usage the wallet pays; the plan must not stand behind it
   *  on the platform's API keys instead (Codex review, 20 Nov 2026). */
  planCover?: false;
  /** True: past the plan this call reaches the wallet only by the account's
   *  own pay-as-you-go switch — no "a run in flight finishes" exception. A
   *  run's call moved onto the platform's key because the Claude logins
   *  could not serve it (Codex review, 23 Nov 2026). */
  optInOnly?: true;
}

/**
 * Whether an account may use a provider on the platform's keys now: foldrun's
 * models on and not refused to it (supplyStanding), the provider still
 * offered, and credit left. Null when it may. admitCall asks this for every
 * call; the gateway asks it for an answer it gives itself (a token-count
 * estimate), so no route skips it (Codex review, 10 Nov 2026).
 */
/** Nothing pays for this call: no plan covers it right now (no plan, a
 *  provider or model outside it, a key or call kind it does not pay for, or
 *  an allowance used up) and there is no bought credit behind it. Before
 *  FOL-208 this said plan credits never pay for models; a plan now pays for
 *  what it covers, so the refusal says only what is true in every case —
 *  bought credit pays — and recommends nothing it cannot know (bench and
 *  Codex, 20 Nov 2026). A free account's starter credits pay compute, never tokens. */
const OUT_OF_CREDITS = "foldrun's models: out of credits — nothing covers this call and there are no bought credits behind it; buy credits to keep using them";

/** No subscription, no new paid call (23 Nov 2026, entitlement.ts). A run
 *  already admitted that has calls behind it finishes as before (its
 *  bounded grace); anything else is refused before the provider is asked.
 *  Null: the account may go on. */
async function subscriptionRefusal(tenant: string, inRun: string | null, ent: Entitlement | null): Promise<Refusal | null> {
  const e = ent ?? (await deps.entitlement(tenant));
  if (e.kind === "unreadable") return { status: 503, message: `foldrun's models: ${BILLING_UNREADABLE_MESSAGE}`, code: BILLING_UNREADABLE };
  if (e.kind !== "none") return null;
  if (inRun && (await deps.runSpend(tenant, inRun)) > 0) return null;
  return { status: 402, message: `foldrun's models: ${SUBSCRIPTION_REQUIRED_MESSAGE}`, code: SUBSCRIPTION_REQUIRED };
}

/** A provider outside the subscriber's plan: extra usage only, which the
 *  account turns on itself; otherwise said plainly, before any spend. */
function notInPlan(provider: SupplyProviderName, ent: Entitlement): Refusal {
  const plan = ent.kind === "active" ? `${ent.plan} plan` : "plan";
  return { status: 402, message: `foldrun's models: ${provider}'s models are not included in your ${plan} — top up your wallet and turn on pay as you go under Billing → Plans to use them at the listed price`, code: "model_not_in_plan" };
}

/** Whether the account may use the platform's keys at all, and whether it
 *  has bought credit behind the call. `deps.balance` is the bought pot. */
async function standingOf(tenant: string, provider: SupplyProviderName): Promise<{ refuse: Refusal } | { funded: boolean }> {
  const standing = supplyStanding(tenant);
  if (!standing.ok) return { refuse: { status: 403, message: `foldrun's models: ${standing.reason}` } };
  // Asked per call, so taking a provider off the list stops leases already
  // handed out, not only new steps (Codex review).
  if (!offeredProviders().includes(provider)) return { refuse: { status: 403, message: `foldrun's models: ${provider} is no longer offered on this platform` } };
  const balance = await deps.balance(tenant);
  if (balance === null) return { refuse: { status: 403, message: "foldrun's models: not offered on this install" } };
  return { funded: balance > 0 };
}

/** The account checks every call outside a run gets (the gateway's
 *  count_tokens estimate): it stands, and it has bought credit — or, for a
 *  coding agent's call, a plan with room stands behind it as it would for
 *  the call itself (Codex review, 20 Nov 2026). */
export async function accountStands(tenant: string, provider: SupplyProviderName, who?: Pick<CallWho, "kind" | "planCover">): Promise<Refusal | null> {
  const s = await standingOf(tenant, provider);
  if ("refuse" in s) return s.refuse;
  // A subscription first (23 Nov 2026): the same rule as the call itself,
  // so an estimate is not a way to reach a provider without one.
  const ent = await deps.entitlement(tenant);
  const sub = await subscriptionRefusal(tenant, null, ent);
  if (sub) return sub;
  if (ent.kind === "active" && ent.source === "subscription") {
    // A subscriber: the plan's provider with room, or extra usage on. A
    // legacy plan honoured to its paid-through date pays as it always did.
    const cover = who?.planCover === false ? null : await deps.planCover(tenant, provider);
    if (cover?.kind === "covered") return null;
    if (cover?.kind === "unreadable") return { status: 503, message: "foldrun's models: this account's plan could not be read just now — try again in a moment", code: BILLING_UNREADABLE };
    if (cover?.kind === "refused") return { status: 402, message: `foldrun's models: ${cover.message}`, code: "allowance_used" };
    const extra = await deps.extraUsage(tenant);
    if (!extra?.on) return notInPlan(provider, ent);
    return s.funded ? null : { status: 402, message: OUT_OF_CREDITS, code: "extra_usage_unfunded" };
  }
  if (s.funded) return null;
  if (who && (who.kind === "run" || who.kind === "coding") && who.planCover !== false) {
    const cover = await deps.planCover(tenant, provider);
    if (cover?.kind === "covered") return null;
    if (cover?.kind === "unreadable") return { status: 503, message: "foldrun's models: this account's plan could not be read just now — try again in a moment" };
  }
  return { status: 402, message: OUT_OF_CREDITS };
}

/**
 * Admit one call on the platform's key, or refuse it. `free`: pass it
 * unmetered (still only for an account that stands). `metered`: send
 * `body` (perhaps rewritten) and run the reply through `call`.
 */
export async function admitCall(
  who: CallWho,
  provider: SupplyProviderName,
  method: string,
  pathname: string,
  body: Buffer | null,
): Promise<{ refuse: Refusal } | { free: true } | { metered: true; body: Buffer; call: MeteredCall }> {
  const p = SUPPLY_PROVIDERS[provider];
  const rule = routeRule(p, method, pathname);
  if (!rule) return { refuse: { status: 403, message: `foldrun's models: ${method} ${pathname} is not a ${provider} model route` } };
  const standing = supplyStanding(who.tenant);
  if (!standing.ok) return { refuse: { status: 403, message: `foldrun's models: ${standing.reason}` } };
  const stands = await standingOf(who.tenant, provider);
  if ("refuse" in stands) return { refuse: stands.refuse };
  // A call that belongs to a run in flight (a step's own calls carry its run).
  const inRun = who.kind === "run" && who.runId ? who.runId : null;
  // A subscription before anything else (23 Nov 2026): a balance alone no
  // longer pays for a new call. Before the free routes too — a token count
  // reaches the provider as well.
  const ent = await deps.entitlement(who.tenant);
  const unsubscribed = await subscriptionRefusal(who.tenant, inRun, ent);
  if (unsubscribed) return { refuse: unsubscribed };
  // A Pro or Max subscriber: its allowance, then extra usage by its own
  // switch and limit. A legacy plan honoured to its paid-through date, and
  // an exempt account, pay as they always did.
  const subscribed = ent.kind === "active" && ent.source === "subscription";
  // An automation of an account with a plan (15 Nov 2026), or its coding
  // agent through a gateway key — foldrun code on this computer (20 Nov
  // 2026, owner: one platform plan for AI and compute): the plan's
  // allowance stands behind the call in place of bought credit; past it the
  // wallet does only when the account said so, else new work waits for the
  // reset (a run in flight finishes inside the same allowance as below).
  // Decided here, once: the call settles on the payer it was admitted on.
  const cover = (who.kind === "run" || who.kind === "coding") && who.planCover !== false ? await deps.planCover(who.tenant, provider) : null;
  if (cover?.kind === "unreadable") return { refuse: { status: 503, message: "foldrun's models: this account's plan could not be read just now — try again in a moment", code: BILLING_UNREADABLE } };
  // Past the allowance a run in flight still finishes on the plan — one
  // that has calls behind it already; only new work waits for the reset.
  const finishing = cover?.kind === "refused" && inRun ? (await deps.runSpend(who.tenant, inRun)) > 0 : false;
  const onPlan = cover?.kind === "covered" || finishing;
  const planRefusal = cover?.kind === "refused" && !finishing ? { status: 402, message: `foldrun's models: ${cover.message}`, code: "allowance_used" } : null;
  // A subscriber's call no plan stands behind — a provider outside the plan,
  // or a login key past its share — is extra usage: only with the account's
  // own switch on (a run in flight the WALLET already paid for finishes as
  // before). Calls the plan covered do not count: a run that starts on a
  // covered provider and then names one outside the plan (a step's own
  // model:, 23 Nov 2026) must not reach the wallet without the switch
  // (Codex review).
  const extraOnly = subscribed && cover === null;
  if (extraOnly && (who.optInOnly === true || !(inRun && (await deps.runSpend(who.tenant, inRun, true)) > 0))) {
    const extra = await deps.extraUsage(who.tenant);
    if (!extra?.on) return { refuse: who.planCover === false ? { status: 402, message: "foldrun's models: this plan's share is used and pay as you go is off — top up your wallet and turn it on under Billing → Plans to continue, or wait for the reset", code: "allowance_used" } : notInPlan(provider, ent) };
  }
  const funded = onPlan ? true : stands.funded;
  if (rule === "free") {
    // A model list or a token count costs nothing: it passes for an account
    // that stands, and a run in flight keeps counting its tokens at zero.
    if (!funded && !inRun) return { refuse: { status: 402, message: OUT_OF_CREDITS } };
    return { free: true };
  }

  // Only a metered call waits for the plan's reset: a model list or a token
  // count above costs nothing and passes as it always did (Codex review).
  // An account with a plan has its payer decided below, under its lock, on
  // a read the sweep cannot move half-way (Codex review, 20 Nov 2026); the
  // read above only says whether there is a plan.
  const planned = cover !== null;
  if (planRefusal && !planned) return { refuse: planRefusal };
  const read = readCall(p, body ?? Buffer.alloc(0), (model) => deps.price(provider, model)?.maxOutputTokens ?? null);
  if ("status" in read) return { refuse: read };
  const price = deps.price(provider, read.model);
  if (!price) return { refuse: { status: 402, message: `foldrun's models: ${read.model} has no price on ${provider} — pick another model, or use your own key` } };
  const bad = priceProblem(p, price);
  if (bad) return { refuse: { status: 402, message: `foldrun's models: ${read.model} on ${provider} cannot be used yet (${bad})` } };
  const estimate = estimateOf(read.body.byteLength, read.maxTokens, price, read.mediaTokens);
  // A call an account key's wallet budget pays is held at a true upper
  // bound — every input byte a token — so a close can never take the key
  // past what its owner allowed (Codex review, FOL-208).
  const walletBound = who.jobLimits?.walletUsd !== undefined ? (read.inline?.documents ? estimateOf(0, read.maxTokens, price, WALLET_BOUND_DOCUMENT_TOKENS, false) : estimateOf(read.body.byteLength * 3, read.maxTokens, price, read.mediaTokens + WALLET_BOUND_EXTRA_TOKENS + (read.inline?.images ?? 0) * WALLET_BOUND_IMAGE_TOKENS, false)) : estimate;
  // The wallet's rule: bought credit, or, at zero, a run already on the
  // platform's keys finishing inside its allowance — its first call had
  // bought credit behind it. A login's extra usage is the wallet's alone:
  // never a run's finish grace, which would take the balance below zero.
  const walletRefusal = async (): Promise<Refusal | null> => {
    if (stands.funded) return null;
    if (!inRun || who.planCover === false) return { status: 402, message: OUT_OF_CREDITS };
    // Only a run the wallet already paid for finishes on its grace: calls
    // a plan covered had no bought credit behind them (Codex review).
    const spent = await deps.runSpend(who.tenant, inRun, true);
    if (!(spent > 0)) return { status: 402, message: OUT_OF_CREDITS };
    const grace = deps.finishGraceUsd();
    const next = spent + (billing().modelChargeOf?.(estimate) ?? estimate);
    if (next > grace) return { status: 402, message: `foldrun's models: out of credits — this run used up its $${grace.toFixed(2)} allowance to finish after the balance reached zero; buy credits and run it again` };
    return null;
  };
  if (!funded && !planned) {
    const refused = await walletRefusal();
    if (refused) return { refuse: refused };
  }
  const customerDailyUsd = who.customer ? (await customerLimits(who.tenant)).dailyModelUsd : null;
  // Why the payer is who it is, kept on the row (FOL-208): the plan with
  // room, a run finishing on it, the wallet past the allowance with extra
  // usage on, or the wallet because no plan stands behind this call.
  const reasonOf = (covered: boolean, finishingRun: boolean, again: PlanCover | null): string =>
    covered ? (finishingRun ? "plan-finishing" : "plan") : who.planCover === false ? "wallet-login" : again?.kind === "wallet" || subscribed ? "wallet-extra-usage" : "wallet";
  const reserve = (covered: boolean, reason = reasonOf(covered, finishing, cover)) =>
    reserveCall(
      {
        tenant: who.tenant, kind: who.kind, runId: who.runId, step: who.step, job: who.job, provider, model: read.model, estimateUsd: covered ? estimate : walletBound, ...(!covered && walletBound > estimate ? { billingEstimateUsd: estimate } : {}), priceVersion: price.version, margin: chargeMargin(),
        payerReason: reason,
        ...(covered ? { covered: true } : {}),
        ...(who.jobLimits ? { jobLimits: who.jobLimits } : {}),
        ...(who.customer ? { customer: who.customer, customerDailyUsd } : {}),
      },
      standing.dailyUsd,
    );
  // An account with a plan: who pays is decided here, under one lock per
  // account that the settlement sweep takes too, with this call's own
  // estimate counted in — so calls at once cannot all fit the same room,
  // and no read sees a call half-way between pending and counted. Each held
  // call weighs on the next one's read (plan-allowance pending).
  type Outcome = { held: Awaited<ReturnType<typeof reserve>> } | { refuse: Refusal };
  // A subscriber's extra usage: the wallet's rule, then the account's own
  // monthly limit with this call's charge in — read under the plan lock, so
  // calls at once at the last dollar cannot all fit (23 Nov 2026).
  const onExtra = async (reason: string): Promise<Outcome> => {
    // A subscriber's call reaches the wallet only by the account's own
    // switch, read fresh here under the lock — the read above may be a few
    // seconds old, and the switch turned off while this call waited (Codex
    // review, round 2, 23 Nov 2026). Only a run the wallet already paid for
    // finishes without it, as above; a run moved onto the platform's key
    // (optInOnly) never does.
    const walletFinish = async () => who.optInOnly !== true && Boolean(inRun) && (await deps.runSpend(who.tenant, inRun!, true)) > 0;
    if (subscribed && !(await deps.extraUsage(who.tenant))?.on && !(await walletFinish())) {
      return { refuse: { status: 402, message: "foldrun's models: this call is past your plan and pay as you go is off — top up your wallet and turn it on under Billing → Plans to continue, or wait for the reset", code: "allowance_used" } };
    }
    const refused = await walletRefusal();
    if (refused) return { refuse: refused };
    if (subscribed) {
      const charge = billing().modelChargeOf?.(walletBound) ?? walletBound;
      const over = await deps.extraUsageRoom(who.tenant, charge);
      if (over) return { refuse: { ...over, message: `foldrun's models: ${over.message}` } };
    }
    return { held: await reserve(false, reason) };
  };
  const outcome: Outcome = planned
    ? await deps.planLock(who.tenant, async (): Promise<Outcome> => {
        const again = await deps.planCover(who.tenant, provider, { model: read.model, estimateUsd: estimate });
        if (again?.kind === "covered") return { held: await reserve(true, "plan") };
        if (again?.kind === "refused") {
          // A run in flight finishes on the plan; only new work waits.
          if (inRun && !again.final && (await deps.runSpend(who.tenant, inRun)) > 0) return { held: await reserve(true, "plan-finishing") };
          return { refuse: { status: 402, message: `foldrun's models: ${again.message}`, code: "allowance_used" } };
        }
        if (again?.kind === "unreadable") return { refuse: { status: 503, message: "foldrun's models: this account's plan could not be read just now — try again in a moment", code: BILLING_UNREADABLE } };
        // Extra usage on, or the plan just ended: the wallet, by its rule.
        return onExtra(reasonOf(false, false, again));
      })
    : extraOnly && !onPlan
      ? await deps.planLock(who.tenant, () => onExtra(reasonOf(false, false, cover)))
      : { held: await reserve(onPlan) };
  if ("refuse" in outcome) return { refuse: outcome.refuse };
  const held = outcome.held;
  if (!held.ok) return { refuse: { status: 429, message: `foldrun's models: ${held.reason}` } };

  let reader: UsageReader | null = null;
  // The outcome is decided by the first finish; its write is retried by any
  // later one until it lands — a failed write must never leave the row open
  // at its estimate for a call the provider refused (Codex review).
  let decided: { tokens: UsageTokens; costUsd: number } | { estimated: true; costUsd?: number } | null = null;
  let result: { costUsd: number; estimated: boolean } = { costUsd: 0, estimated: false };
  let saved = false;
  const call: MeteredCall = {
    id: held.id,
    provider,
    model: read.model,
    start(contentType) {
      reader = new UsageReader(p.format, contentType);
    },
    feed(chunk) {
      reader?.feed(chunk);
    },
    async finish(status, complete) {
      if (saved) return result;
      if (!decided) {
        if (status < 200 || status >= 300) {
          decided = { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0 };
          result = { costUsd: 0, estimated: false };
        } else {
          const usage = complete ? reader?.result() ?? null : null;
          if (!usage) {
            // Billed at the estimate, never at a wallet bound held above it (Codex).
            decided = { estimated: true, costUsd: estimate };
            result = { costUsd: estimate, estimated: true };
          } else {
            const cost = costOf(usage, price);
            decided = { tokens: usage, costUsd: cost };
            result = { costUsd: cost, estimated: false };
          }
        }
      }
      await closeCall(held.id, decided);
      saved = true;
      return result;
    },
  };
  return { metered: true, body: read.body, call };
}
