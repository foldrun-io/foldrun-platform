import crypto from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { providerUserId } from "../../foldrun-core/src/customer.ts";

/** The upstream connection uses Node's Undici transport. Identify the actual
 * HTTP client without product branding or an invented laptop/SDK identity.
 * Credentials are supplied separately by the proxy. */
export const GATEWAY_USER_AGENT = "undici";
const FORWARD = new Set(["anthropic-version", "anthropic-beta", "openai-beta", "content-type", "accept"]);

export function modelRequestHeaders(incoming: IncomingHttpHeaders, credentials: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = { ...credentials, "user-agent": GATEWAY_USER_AGENT };
  for (const [name, value] of Object.entries(incoming)) {
    const key = name.toLowerCase();
    if (FORWARD.has(key) && typeof value === "string" && value) out[key] = value;
  }
  return out;
}

/** A stable account identity, rather than an SDK's device/session composite.
 * Explicit end customers retain their separate abuse-control identity. */
export function gatewayUserId(tenant: string, customer: string | null): string {
  return customer !== null ? providerUserId(tenant, customer)
    : crypto.createHash("sha256").update(`gateway-account\u0000${tenant}`).digest("hex");
}

export function modelRequestIdentity(body: Buffer | null, tenant: string, customer: string | null, shape: "anthropic" | "responses" | "chat" | "count-tokens"): Buffer | null {
  if (!body) return body;
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(body.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return body;
    parsed = value as Record<string, unknown>;
  } catch {
    return body;
  }
  const id = gatewayUserId(tenant, customer);
  // Never carry caller-supplied tracking tags, user/device composites or
  // cache identifiers upstream. Only proxy-owned attribution is added below.
  delete parsed.metadata;
  delete parsed.user;
  delete parsed.safety_identifier;
  delete parsed.prompt_cache_key;
  if (shape === "anthropic") {
    // Messages metadata supports user_id. Never forward arbitrary device or
    // session fields supplied alongside it by an outside client.
    parsed.metadata = { user_id: id };
  } else if (shape === "responses") parsed.safety_identifier = id;
  else if (shape === "chat") parsed.user = id;
  return Buffer.from(JSON.stringify(parsed));
}
