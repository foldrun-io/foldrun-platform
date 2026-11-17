import type { IncomingHttpHeaders } from "node:http";

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
