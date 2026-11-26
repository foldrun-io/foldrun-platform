import type { IncomingHttpHeaders } from "node:http";
import { opsLog } from "../../foldrun-core/src/ops-log.ts";

/** The upstream connection uses Node's Undici transport. Identify the actual
 * HTTP client without product branding or an invented laptop/SDK identity.
 * Credentials are supplied separately by the proxy. */
export const GATEWAY_USER_AGENT = "undici";
/** The one Messages API version the platform speaks upstream. A caller's
 * `anthropic-version` is never copied: it only says the caller speaks the
 * Anthropic format, and this value goes in its place (owner, 26 Nov 2026:
 * "all headers should go from our box"). */
export const ANTHROPIC_VERSION = "2023-06-01";

/** Beta features the platform turns on upstream when a caller asks for them.
 * A caller's `anthropic-beta` is a wish list read against this list: only the
 * names here go upstream, spelled as here. They change how the model answers
 * a request (thinking, context, caching, tools, effort, output), so a coding
 * agent such as Claude Code keeps working through the gateway.
 *
 * Left out on purpose, and dropped (logged as gateway.beta_dropped):
 * - what runs or stores on foldrun's provider account rather than in the
 *   request: files-api, mcp-servers, mcp-tunnels, web-search (server tools are
 *   run by foldrun, never sent to the provider: FOL-313), managed-agents,
 *   environments, ccr-*, agent-memory, dreaming, afk-mode, message-batches,
 *   resumption, message-threads;
 * - what names or profiles the caller: request-tags, user-profiles,
 *   program-use-case-ids, oidc-federation;
 * - what spends or bills on the provider's side beyond a call's tokens:
 *   fast-mode (premium price), advisor-tool (a second model call the
 *   provider runs), fallback-credit, server-side-fallback-*;
 * - the provider login beta: the platform adds its own when it uses a login.
 * Read from Claude Code 2.1.332 (26 Nov 2026). A new beta stays out until it
 * is added here; the drop log says which ones callers ask for. */
export const ALLOWED_BETAS: ReadonlySet<string> = new Set([
  "advanced-tool-use-2025-11-20",
  "auto-mode-classifier-2026-07-16",
  "cache-diagnosis-2026-04-07",
  "cache-keepalive-2026-09-03",
  "claude-code-20250219",
  "context-1m-2025-08-07",
  "context-hint-2026-04-09",
  "context-management-2025-06-27",
  "dangerous-tool-use-2026-09-03",
  "effort-2025-11-24",
  "extended-cache-ttl-2025-04-11",
  "fine-grained-tool-streaming-2025-05-14",
  "inline-tools-2026-09-15",
  "interleaved-thinking-2025-05-14",
  "mid-conversation-system-2026-04-07",
  "mid-conversation-system-clear-at-2026-08-21",
  "mid-conversation-tool-changes-2026-07-01",
  "per-turn-control-2026-07-01",
  "prompt-caching-evict-2026-05-12",
  "prompt-caching-scope-2026-01-05",
  "redact-thinking-2026-02-12",
  "structured-outputs-2025-12-15",
  "task-budgets-2026-03-13",
  "thinking-binding-controls-2026-08-01",
  "thinking-display-updates-2026-08-18",
  "thinking-resumption-2026-07-17",
  "thinking-token-count-2026-05-13",
  "token-counting-2024-11-01",
  "token-efficient-tools-2025-02-19",
  "tool-provenance-2026-10-26",
  "tool-search-tool-2025-10-19",
]);

const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v.join(",") : v ?? "");

/** A caller's beta list read against ALLOWED_BETAS: what goes upstream, and
 * what was asked for and left out (names only, for the drop log). */
export function betasFor(incoming: IncomingHttpHeaders): { kept: string[]; dropped: string[] } {
  const asked = [...new Set(one(incoming["anthropic-beta"]).split(",").map((b) => b.trim().toLowerCase()).filter(Boolean))];
  return { kept: asked.filter((b) => ALLOWED_BETAS.has(b)), dropped: asked.filter((b) => !ALLOWED_BETAS.has(b)).map((b) => b.slice(0, 80)) };
}

/** The headers of a call to a model provider, every one set here: the
 * credentials the platform chose, its own user agent, and for a provider
 * that speaks the Anthropic format (said by the provider, never by the
 * caller's headers) the platform's API version and the allowed betas.
 * Content type and accept are the platform's values, picked by what the call
 * is (a body, a stream). No header a caller sent is copied. */
export function modelRequestHeaders(incoming: IncomingHttpHeaders, credentials: Record<string, string> = {}, format: "anthropic" | "other" = "anthropic"): Record<string, string> {
  // A credential map carries credentials only: any version, beta, user agent,
  // content type or accept in it is dropped whatever its case (Codex).
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(credentials)) if (!/^(anthropic-version|anthropic-beta|user-agent|content-type|accept)$/i.test(k)) out[k.toLowerCase()] = v;
  out["user-agent"] = GATEWAY_USER_AGENT;
  if (incoming["content-type"]) out["content-type"] = "application/json";
  const accept = one(incoming.accept).toLowerCase();
  if (accept) out.accept = accept.includes("text/event-stream") ? "text/event-stream" : "application/json";
  if (format === "anthropic") {
    out["anthropic-version"] = ANTHROPIC_VERSION;
    const { kept } = betasFor(incoming);
    if (kept.length) out["anthropic-beta"] = kept.join(",");
  }
  return out;
}

/** Account/customer attribution stays in the proxy's own records. No caller
 * metadata or replacement account identifier is sent to the model provider. */
export function modelRequestIdentity(body: Buffer | null): Buffer | null {
  if (!body) return body;
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(body.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return body;
    parsed = value as Record<string, unknown>;
  } catch {
    return body;
  }
  // Never carry caller-supplied tracking tags, user/device composites or
  // cache identifiers upstream, and never replace them with tenant ids.
  delete parsed.metadata;
  delete parsed.user;
  delete parsed.safety_identifier;
  delete parsed.prompt_cache_key;
  return Buffer.from(JSON.stringify(parsed));
}

/** A provider's beta identifier: a lowercase name ending in a date, the
 * shape every Anthropic beta has (`files-api-2025-04-14`,
 * `claude-code-20250219`). Only these are logged by name. */
const BETA_SHAPE = /^[a-z][a-z0-9-]{1,60}-20\d{2}-?\d{2}-?\d{2}$/;

/** Log the betas a caller asked for that were not sent on (FOL-337), so a new
 * one Claude Code starts sending is seen and reviewed: each beta-shaped name
 * by name, the rest only counted, never as text (a caller's header is not
 * written to the operator log). The login beta is the platform's own and
 * not a drop. */
export function logDroppedBetas(incoming: IncomingHttpHeaders, tenant: string | undefined, surface: "gateway" | "egress"): void {
  const dropped = betasFor(incoming).dropped.filter((b) => b !== "oauth-2025-04-20");
  if (!dropped.length) return;
  const named = dropped.filter((b) => BETA_SHAPE.test(b));
  for (const beta of named.slice(0, 20)) opsLog("info", "gateway.beta_dropped", { surface, tenant, beta });
  const other = dropped.length - Math.min(named.length, 20);
  if (other > 0) opsLog("info", "gateway.beta_dropped", { surface, tenant, count: other, reason: "unnamed" });
}
