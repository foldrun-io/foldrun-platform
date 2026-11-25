// The rungs behind /v1/messages' server tools (FOL-313): who answers a
// search or a fetch, tried in order, our own first (owner, 25 Nov 2026;
// foldrun-infra docs/web-tool-consistency-plan.md, "Routes per tool").
//
//   search: the account's SearXNG (not yet reachable from the gateway pods:
//           next slice) → SerpApi (Google), the platform's key
//           (SERPAPI_API_KEY). No key and no engine: `unavailable`.
//   fetch:  plain HTTP from our own address, through fetchPublic (internal
//           names and addresses refused, every redirect hop checked, the
//           body capped) → the residential proxy rung (next slice).
//
// foldrun's own vendor accounts: the built-in tools never take a caller's
// vendor key (owner, 25 Nov 2026; a customer wires their own vendor through
// apis:, mcpServers:, scripts: or tools/). A key never leaves this process.

import { fetchPublic, PrivateAddressError } from "./ssrf.ts";
import type { FetchError, FetchResult, SearchError, SearchResult, ToolRunners } from "./server-tools.ts";

type Json = Record<string, unknown>;

const SEARCH_TIMEOUT_MS = 8_000;
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_MAX_BYTES = 5 * 1024 * 1024;
const UA = "Mozilla/5.0 (compatible; foldrun-fetch/1.0; +https://foldrun.io/bot)";

/** `site:` terms for allowed domains, so Google is asked for them alone
 *  (the loop filters the answer again either way). */
function siteTerms(allowed?: string[], blocked?: string[]): string {
  const clean = (d: string) => d.toLowerCase().replace(/^https?:\/\//, "").replace(/^\*\./, "").split("/")[0]!;
  if (allowed?.length) return ` (${allowed.slice(0, 8).map((d) => `site:${clean(d)}`).join(" OR ")})`;
  if (blocked?.length) return blocked.slice(0, 8).map((d) => ` -site:${clean(d)}`).join("");
  return "";
}

export async function serpApiSearch(
  q: { query: string; allowed_domains?: string[]; blocked_domains?: string[]; user_location?: Json },
  deps: { key?: string; fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<{ results: SearchResult[]; via: string } | { error: SearchError }> {
  const key = deps.key ?? process.env.SERPAPI_API_KEY;
  if (!key) return { error: "unavailable" };
  const params = new URLSearchParams({ engine: "google", q: `${q.query}${siteTerms(q.allowed_domains, q.blocked_domains)}`, num: "10", api_key: key });
  const country = typeof q.user_location?.country === "string" ? q.user_location.country.toLowerCase() : "";
  if (/^[a-z]{2}$/.test(country)) params.set("gl", country);
  const doFetch = deps.fetch ?? fetch;
  let res: Response;
  try {
    const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
    res = await doFetch(`https://serpapi.com/search.json?${params}`, { signal: deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout });
  } catch {
    return { error: "unavailable" };
  }
  if (res.status === 429) return { error: "too_many_requests" };
  if (!res.ok) return { error: "unavailable" };
  let data: Json;
  try {
    data = (await res.json()) as Json;
  } catch {
    return { error: "unavailable" };
  }
  // "Google hasn't returned any results for this query." is an answer, not a failure.
  if (typeof data.error === "string" && !/hasn't returned any results/i.test(data.error)) return { error: "unavailable" };
  const organic = Array.isArray(data.organic_results) ? (data.organic_results as Json[]) : [];
  const results = organic
    .filter((r) => typeof r.link === "string" && /^https?:\/\//.test(r.link as string))
    .map((r) => ({ url: r.link as string, title: String(r.title ?? ""), snippet: String(r.snippet ?? ""), page_age: typeof r.date === "string" ? r.date : null }));
  return { results, via: "serpapi" };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
/** A page's readable text: scripts, styles and markup out, blocks kept as
 *  lines. Plain on purpose — the model reads it, nobody renders it. */
export function htmlToText(html: string): { title: string | null; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? null;
  const text = html
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer)\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const n = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title: title ? htmlToText(title).text : null, text };
}

/** A block page served with a 200 (Cloudflare's challenge says so in a header). */
const blocked = (res: Response) => res.status === 403 || res.status === 429 || res.status === 503 || res.headers.get("cf-mitigated") === "challenge";

const MAX_HOPS = 5;

/** Plain HTTP from our own address. Redirects are followed here, one hop at
 *  a time, so the tool's domain rule (`allow`) is checked on every hop, as
 *  fetchPublic checks internal addresses on every hop. */
export async function directFetch(
  url: string,
  opts: { maxChars: number; allow?: (url: string) => boolean; signal?: AbortSignal },
  deps: { fetchPublic?: typeof fetchPublic; now?: () => Date } = {},
): Promise<{ page: FetchResult; via: string } | { error: FetchError }> {
  const get = deps.fetchPublic ?? fetchPublic;
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let res: Response | null = null;
  let current = url;
  for (let hop = 0; ; hop++) {
    if (opts.allow && !opts.allow(current)) return { error: "url_not_allowed" };
    try {
      res = await get(current, { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5" }, redirect: "manual", signal }, { maxBytes: FETCH_MAX_BYTES });
    } catch (err) {
      // An internal address, a refused connection, a timeout: not reachable.
      void (err instanceof PrivateAddressError);
      return { error: "url_not_accessible" };
    }
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!loc) break;
    await res.body?.cancel().catch(() => {});
    if (hop + 1 >= MAX_HOPS) return { error: "url_not_accessible" };
    try {
      current = new URL(loc, current).toString();
    } catch {
      return { error: "url_not_accessible" };
    }
    if (!/^https?:/i.test(current)) return { error: "url_not_accessible" };
  }
  if (res.status === 429) return { error: "too_many_requests" };
  if (blocked(res) || !res.ok) {
    await res.body?.cancel().catch(() => {});
    return { error: "url_not_accessible" };
  }
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    return { error: "url_not_accessible" };
  }
  let title: string | null = null;
  let text: string;
  if (type === "text/html" || type === "application/xhtml+xml" || (type === "" && /<html[\s>]/i.test(raw.slice(0, 2000)))) {
    ({ title, text } = htmlToText(raw));
  } else if (type.startsWith("text/") || type === "application/json" || type.endsWith("+json") || type === "application/xml" || type.endsWith("+xml")) {
    text = raw;
  } else {
    // PDFs and office files go through extract (FOL-302) in a later slice.
    return { error: "unsupported_content_type" };
  }
  return { page: { url: current, title, text: text.slice(0, opts.maxChars), mediaType: type || "text/plain", retrievedAt: (deps.now ?? (() => new Date()))().toISOString() }, via: "direct" };
}

/** The ladder for this pod. Each rung's own failure moves to the next. */
export function platformRunners(): ToolRunners {
  return {
    async search(q, ctx) {
      return serpApiSearch(q, { ...(ctx.signal ? { signal: ctx.signal } : {}) });
    },
    async fetchPage(url, opts) {
      return directFetch(url, opts);
    },
  };
}
