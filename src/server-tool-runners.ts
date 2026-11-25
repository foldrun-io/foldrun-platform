// The rungs behind /v1/messages' server tools (FOL-313): who answers a
// search or a fetch, tried in order, our own first (owner, 25 Nov 2026;
// foldrun-infra docs/web-tool-consistency-plan.md, "Routes per tool").
//
//   search: the account's own SearXNG when its search pod is already up
//           (never started from here: searxngSearch says why; the search
//           door's engines and query rules) → SerpApi (Google), the
//           platform's key (SERPAPI_API_KEY), when there is no pod, the
//           query is one the door refuses, a domain list or a country is
//           set, or the engines found nothing. No key: `unavailable`.
//   fetch:  plain HTTP from our own address, through fetchPublic (internal
//           names and addresses refused, every redirect hop checked, the
//           body capped) → the residential proxy rung (next slice).
//
// foldrun's own vendor accounts: the built-in tools never take a caller's
// vendor key (owner, 25 Nov 2026; a customer wires their own vendor through
// apis:, mcpServers:, scripts: or tools/). A key never leaves this process.

import { runBrowse } from "./browse-jobs.ts";
import { fetchPublic, PrivateAddressError } from "./ssrf.ts";
import { accountSegment } from "./account-pod.ts";
import { DEFAULT_SEARCH_IMAGE, searchUrl } from "./search-k8s.ts";
import { answerEngines, DOOR_AUDITED_IMAGE, DOOR_ENGINES, doorSearchParams, upstreamGet } from "./search-door.ts";
import type { FetchError, FetchResult, SearchError, SearchResult, ToolRunners } from "./server-tools.ts";
import { withToolCache } from "./tool-cache.ts";
import { withToolLimits } from "./tool-limits.ts";

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
  if (!res.ok) {
    // Closed, not left to stream: the slot (tool-limits.ts) is given back
    // when this returns, and an open body would still be a connection.
    await res.body?.cancel().catch(() => {});
    return { error: res.status === 429 ? "too_many_requests" : "unavailable" };
  }
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

/** How long a web_search gives the account's own engine, all of it (its
 *  /config and the search), before SerpApi answers instead. */
const SEARXNG_WAIT_MS = waitSetting(process.env.FOLDRUN_SERVER_SEARCH_WAIT_MS);
/** A whole number of milliseconds, 100 to 30 000; anything else is the
 *  default (AbortSignal.timeout throws on a negative or fractional value,
 *  and that would skip SerpApi too). */
export function waitSetting(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 100 && n <= 30_000 ? n : 4_000;
}
/** How long an account's loaded engines are trusted before /config is read again. */
const CONFIG_TTL_MS = 10 * 60_000;
const loadedBySeg = new Map<string, { at: number; engines: Set<string> }>();

/** The account's own engine may be asked here: per-account search, and the
 *  image the door's engines were checked in (search-door.ts). */
export function searxngEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FOLDRUN_SEARCH_PER_ACCOUNT === "1" && (env.FOLDRUN_SEARCH_IMAGE ?? DEFAULT_SEARCH_IMAGE) === DOOR_AUDITED_IMAGE;
}

/**
 * One search on the account's own SearXNG, ONLY when its search pod is
 * already up (its runs keep it): the gateway never starts one, holds no
 * lease and stamps nothing, so a search here adds nothing to the account's
 * bill and nothing to the pod's lifecycle (Codex review, 25 Nov 2026: a
 * pod the gateway woke would bill the account for its whole idle window,
 * and racing the workers' starts and the reaper is theirs to own). With no
 * pod up the attempt fails (refused, or at the deadline) and SerpApi answers.
 *
 * Like the run door, it trusts the image setting of its own pod and caches
 * the pod's /config per account for ten minutes; a pod replaced by one with
 * other engines inside that window is the door's known gap too (FOL-313
 * follow-up: bind the check to the backend that receives the query).
 *
 * The search door's rules (search-door.ts): the engines the instance has
 * loaded (its /config) within the door's fixed general list, the query
 * refused when it carries a directive, a URL or a placeholder, an answer
 * naming any other engine thrown away. Options SearXNG cannot honour as
 * Google does — a domain list, a country — go to SerpApi. Null when it
 * cannot answer now; one deadline over the whole attempt, the requests
 * aborted at it.
 */
export async function searxngSearch(
  tenant: string,
  q: { query: string; allowed_domains?: string[]; blocked_domains?: string[]; user_location?: Json },
  deps: { get?: typeof upstreamGet; url?: (seg: string) => string; waitMs?: number; signal?: AbortSignal; now?: () => number } = {},
): Promise<{ results: SearchResult[]; via: string } | null> {
  if (q.allowed_domains?.length || q.blocked_domains?.length || q.user_location) return null;
  const seg = accountSegment(tenant);
  if (!seg) return null;
  const get = deps.get ?? upstreamGet;
  const base = (deps.url ?? searchUrl)(seg);
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.waitMs ?? SEARXNG_WAIT_MS;
  // A plain timer, not AbortSignal.timeout: that one does not hold the
  // event loop, so a wait with nothing else pending ended the process early
  // (the dev pipeline's isolated test run, 25 Nov 2026).
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error("timeout")), timeoutMs);
  try {
    const signal = deps.signal ? AbortSignal.any([deps.signal, deadline.signal]) : deadline.signal;
    let loaded = loadedBySeg.get(seg);
    if (!loaded || now() - loaded.at > CONFIG_TTL_MS) {
      const cfg = await get(`${base}/config`, { signal, timeoutMs });
      if (cfg.status !== 200) return null;
      const engines = new Set<string>();
      for (const e of ((JSON.parse(cfg.body) as Json).engines as Json[] | undefined) ?? []) {
        if (typeof e?.name === "string" && e.enabled !== false) engines.add(e.name.toLowerCase());
      }
      loaded = { at: now(), engines };
      loadedBySeg.set(seg, loaded);
    }
    const asked = doorSearchParams(new URLSearchParams({ q: q.query, categories: "general" }), loaded.engines);
    if ("refuse" in asked) return null;
    const res = await get(`${base}/search?${asked.params}`, { signal, timeoutMs });
    if (res.status !== 200) return null;
    const data = JSON.parse(res.body) as Json;
    // An engine outside the door's list answered: not used (search-door.ts).
    if (answerEngines(data).some((e) => !DOOR_ENGINES.has(e))) return null;
    const seen = new Set<string>();
    const results = (Array.isArray(data.results) ? (data.results as Json[]) : [])
      .filter((r) => typeof r.url === "string" && /^https?:\/\//i.test(r.url as string))
      .filter((r) => (seen.has(r.url as string) ? false : (seen.add(r.url as string), true)))
      .slice(0, 10)
      .map((r) => ({ url: r.url as string, title: String(r.title ?? "").slice(0, 500), snippet: String(r.content ?? "").slice(0, 2000), page_age: typeof r.publishedDate === "string" && r.publishedDate ? r.publishedDate.slice(0, 64) : null }));
    return results.length ? { results, via: "searxng" } : null;
  } catch {
    // Refused (no pod), timed out, aborted, not JSON: the next rung.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Test seam: forget the engines each account's pod said it has. */
export function resetSearxngForTests(): void {
  loadedBySeg.clear();
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
  if (res.status === 429 || blocked(res) || !res.ok) {
    await res.body?.cancel().catch(() => {});
    return { error: res.status === 429 ? "too_many_requests" : "url_not_accessible" };
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

/** The ladder for one account's request, held to the caps on searches and
 *  fetches at once (tool-limits.ts), its searches behind the account's short
 *  cache (tool-cache.ts). Each rung's own failure moves to the next. */
export function platformRunners(tenant: string, keyId: string | null = null): ToolRunners {
  // The cache key names which engines this ladder may use, so turning the
  // account's own engine off (or changing its image) never serves its answers.
  const rungs = `${searxngEnabled() ? `searxng:${process.env.FOLDRUN_SEARCH_IMAGE ?? DEFAULT_SEARCH_IMAGE}` : "-"}|${process.env.SERPAPI_API_KEY ? "serpapi" : "-"}`;
  // The caps (tool-limits.ts) sit under the cache: a hit takes no slot.
  return withToolCache(tenant, withToolLimits(tenant, ladder(tenant, keyId)), { rungs });
}

function ladder(tenant: string, keyId: string | null): ToolRunners {
  const own = searxngEnabled();
  return {
    // A browse job (browse-jobs.ts): a worker's single-use pod; the limits
    // per key and per account are the job queue's. A resent /v1/messages
    // request runs the model again, so its browses are new calls, as a
    // provider's server tools are on a retry (Codex: an ordinal is no
    // identity for a fresh model turn); outcome_unknown tells the model a
    // step may already have acted.
    async browse(input, ctx) {
      const got = await runBrowse({ tenant, keyId, input, ...(ctx.signal ? { signal: ctx.signal } : {}) });
      return got.ok ? { result: got.result, via: "foldrun-browser" } : { error: got.error };
    },
    async search(q, ctx) {
      if (own) {
        const mine = await searxngSearch(tenant, q, { ...(ctx.signal ? { signal: ctx.signal } : {}) });
        if (mine) return mine;
      }
      return serpApiSearch(q, { ...(ctx.signal ? { signal: ctx.signal } : {}) });
    },
    async fetchPage(url, opts) {
      return directFetch(url, opts);
    },
  };
}
