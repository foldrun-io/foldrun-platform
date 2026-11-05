// The egress proxy's search door (FOL-128): web search for a step held to
// its `network:` list.
//
// A held step runs in a `filtered` pod that reaches the egress proxy and
// nothing else (foldrun-infra run-network-policy.yaml), so the account's
// search pod — SearXNG, which has the world — is out of its reach. This door
// is the one way to it: `GET <egress>/s/<lease>/search?…` and
// `GET <egress>/s/<lease>/config`, answered only for a lease whose grant
// carries `search` (core search-egress.ts searchDoorWanted, written by the
// runner — never by the pod). The engine is a platform service, not a site
// on the step's list, and nothing here widens that list.
//
// What it is: a declared way out for the WORDS of a query. SearXNG sends
// them to public search engines, and nothing can stop those words carrying
// what the step knows. The door bounds where they go and records that they
// went, whatever program in the sandbox sends them (the tool, or curl with
// the lease):
//
//   - only fixed engines answer (DOOR_CATEGORIES): each queries its own
//     provider's endpoints with the text — none fetches a URL named in the
//     query (tineye), none federates to an instance a query could name, no
//     torrent, translator or weather lookup. A category becomes that list;
//     the upstream is always sent an explicit engines= the instance has
//     loaded, because SearXNG given no engine it knows falls back to its
//     category defaults (and an answer naming any other engine is refused);
//   - nothing chosen inside the query: SearXNG reads `!name` / `!!bang` as
//     engine and redirect choices and `<n` as a timeout, so such a word is
//     refused, and so is any control or format character (Python splits
//     words on some that JavaScript does not);
//   - no URL in the query (an engine could fetch it), no `${NAME}` placeholder
//     (the door fills none; it is how a bound secret would be sent), at most
//     QUERY_MAX characters;
//   - no plugin, DOI resolver or timeout chosen by the caller: the pinned
//     image's defaults, the same as every other step's;
//   - JSON only, one GET, no client header or cookie passed on, no redirect
//     followed, the answer cut to the fields the tool reads;
//   - at most `grant.search.max` (else FOLDRUN_SEARCH_DOOR_MAX) searches per
//     lease, counted at dispatch and shared by every proxy replica, and at
//     most IN_FLIGHT_MAX at once per replica.
//
// Each search is a line in the run trace, written (and awaited) before it is
// sent: which engines, how long the query was — never its words, which
// would sit in the lease store unredacted. The web tool's own call, with
// its query, is on the step's record like any tool call.

import http from "node:http";
import { accountSegment } from "./account-pod.ts";
import { DEFAULT_SEARCH_IMAGE, searchUrl } from "./search-k8s.ts";

/** The engines the door lets answer, by the category a call may name. The
 *  smallest set that searches well from our nodes (search-k8s.ts SETTINGS_YML
 *  has the measurements), each read in the image below: a text query to its
 *  own provider. Adding one is a security change — read its engine source in
 *  the pinned image first. */
export const DOOR_CATEGORIES: Readonly<Record<string, readonly string[]>> = {
  general: ["yandex", "naver", "brave", "wikipedia"],
  science: ["arxiv", "pubmed"],
  it: ["github", "stackoverflow"],
};
export const DOOR_ENGINES: ReadonlySet<string> = new Set(Object.values(DOOR_CATEGORIES).flat());
/** The SearXNG image those engines were read in. A new image is a new
 *  audit (tests/search-door.test.ts fails until this moves with it). */
export const DOOR_AUDITED_IMAGE = "docker.io/searxng/searxng@sha256:b36af7984b87191b595bc5301418ed6432c047668a4547ab531a7439b816fac3";

export const QUERY_MAX = 512;
export const IN_FLIGHT_MAX = 4;
const BODY_MAX = 2 * 1024 * 1024;
const doorMax = () => Number(process.env.FOLDRUN_SEARCH_DOOR_MAX) || 500;
const timeoutMs = () => Number(process.env.FOLDRUN_SEARCH_DOOR_TIMEOUT_MS) || 45_000;
/** How long a lease's count is kept after its last search. */
export const COUNT_TTL_SEC = 24 * 60 * 60;

/** `/s/<lease>/search` and `/s/<lease>/config`, and nothing else. */
export function parseSearchDoorPath(rawUrl: string): { token: string; route: "search" | "config"; query: URLSearchParams } | null {
  const [p, q] = rawUrl.split("?");
  const m = p.match(/^\/s\/([A-Za-z0-9_-]{16,})\/(search|config)\/?$/);
  return m ? { token: m[1], route: m[2] as "search" | "config", query: new URLSearchParams(q ?? "") } : null;
}

/** Refusals in fixed words: nothing the caller sent is repeated, so a
 *  refusal cannot carry a query's words into the trace either. */
export const REFUSED = {
  empty: "search: an empty query",
  long: `search: a query is at most ${QUERY_MAX} characters here`,
  control: "search: a control or format character in a query is refused here",
  directive: "search: a word starting with ! or < is refused here — the search engine reads it as a choice of engine, redirect or timeout",
  placeholder: "search: a ${NAME} placeholder in a query is refused — the search door fills no secret",
  url: "search: a URL in a query is refused here — an engine could fetch it. Search for words; fetch the page itself with action=fetch, which is held to network:",
  engine: `search: only these engines answer a step held to its network: list — ${[...DOOR_ENGINES].join(", ")}`,
  category: `search: only these categories are offered to a step held to its network: list — ${Object.keys(DOOR_CATEGORIES).join(", ")}`,
  unloaded: "search: none of those engines is loaded on the account's search engine",
  option: "search: plugins, a DOI resolver and a timeout are not chosen by a step held to its network: list — the engine's defaults apply",
  answerEngine: "search: the account's search engine answered from an engine the door does not allow — refused",
  unreachable: "search: the account's search engine could not be reached",
  notJson: "search: the account's search engine did not answer JSON",
} as const;

/** The query as the door sends it, or why it will not. */
export function doorQuery(raw: string): { q: string } | { refuse: string } {
  // Tab, newline and the like split words the same in JavaScript and in
  // Python; every other control or format character is refused, because
  // Python splits on some (\x1c–\x1f, \x85) where JavaScript does not.
  if (/[\p{Cf}]|(?![\t\n\v\f\r])\p{Cc}/u.test(raw)) return { refuse: REFUSED.control };
  const words = raw.split(/\s+/).filter(Boolean);
  if (!words.length) return { refuse: REFUSED.empty };
  if (words.some((w) => w.startsWith("!") || w.startsWith("<"))) return { refuse: REFUSED.directive };
  const q = words.join(" ");
  if (q.length > QUERY_MAX) return { refuse: REFUSED.long };
  if (/\$(\{|%7B)/i.test(q)) return { refuse: REFUSED.placeholder };
  if (/[a-z][a-z0-9+.-]*:\/\//i.test(q) || /\bwww\.\S+\//i.test(q)) return { refuse: REFUSED.url };
  return { q };
}

/** The upstream query string: only what the door allows, always with an
 *  explicit engine list the instance has loaded, never categories. Pure. */
export function doorSearchParams(asked: URLSearchParams, loaded: ReadonlySet<string>): { params: URLSearchParams; engines: string[]; q: string } | { refuse: string } {
  if (["enabled_plugins", "disabled_plugins", "doi_resolver", "timeout_limit"].some((k) => asked.has(k))) return { refuse: REFUSED.option };
  const got = doorQuery(asked.get("q") ?? "");
  if ("refuse" in got) return got;
  const list = (v: string | null) => (v ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  const askedEngines = list(asked.get("engines"));
  const askedCats = list(asked.get("categories"));
  let engines: string[];
  if (askedEngines.length) {
    if (askedEngines.some((e) => !DOOR_ENGINES.has(e))) return { refuse: REFUSED.engine };
    engines = [...new Set(askedEngines)];
  } else {
    const cats = askedCats.length ? askedCats : ["general"];
    if (cats.some((c) => !Object.hasOwn(DOOR_CATEGORIES, c))) return { refuse: REFUSED.category };
    engines = [...new Set(cats.flatMap((c) => DOOR_CATEGORIES[c]))];
  }
  engines = engines.filter((e) => loaded.has(e));
  if (!engines.length) return { refuse: REFUSED.unloaded };
  const params = new URLSearchParams();
  params.set("q", got.q);
  params.set("format", "json");
  params.set("engines", engines.join(","));
  const language = asked.get("language");
  if (language && /^([a-z]{2,3}([-_][a-z]{2})?|all|auto)$/i.test(language)) params.set("language", language);
  const range = asked.get("time_range");
  if (range && ["day", "week", "month", "year"].includes(range)) params.set("time_range", range);
  const page = Number(asked.get("pageno"));
  if (Number.isInteger(page) && page >= 2 && page <= 10) params.set("pageno", String(page));
  const safe = asked.get("safesearch");
  if (safe && /^[012]$/.test(safe)) params.set("safesearch", safe);
  return { params, engines, q: got.q };
}

type Json = Record<string, unknown>;
const str = (v: unknown, max = 2000) => (typeof v === "string" ? v.slice(0, max) : undefined);
const strs = (v: unknown, n = 20) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, n).map((x) => x.slice(0, 300)) : []);

/** The engines an answer says it came from. */
export function answerEngines(data: Json): string[] {
  const out = new Set<string>();
  for (const r of Array.isArray(data.results) ? data.results : []) for (const e of strs((r as Json)?.engines, 50)) out.add(e.toLowerCase());
  for (const r of Array.isArray(data.results) ? data.results : []) if (typeof (r as Json)?.engine === "string") out.add(String((r as Json).engine).toLowerCase());
  for (const b of Array.isArray(data.infoboxes) ? data.infoboxes : []) if (typeof (b as Json)?.engine === "string") out.add(String((b as Json).engine).toLowerCase());
  for (const e of Array.isArray(data.unresponsive_engines) ? data.unresponsive_engines : []) if (Array.isArray(e) && typeof e[0] === "string") out.add(e[0].toLowerCase());
  return [...out];
}

/** What the tool reads of a search answer, and nothing else. */
export function trimSearchAnswer(data: Json): Json {
  const results = (Array.isArray(data.results) ? data.results : []).slice(0, 100).flatMap((r: Json) => {
    const url = str(r?.url);
    if (!url || !/^https?:\/\//i.test(url)) return [];
    return [{ title: str(r.title, 500), url, content: str(r.content, 2000), publishedDate: str(r.publishedDate, 64), engines: strs(r.engines).filter((e) => DOOR_ENGINES.has(e)) }];
  });
  const answers = (Array.isArray(data.answers) ? data.answers : []).slice(0, 10).flatMap((a: unknown) => {
    if (typeof a === "string") return [{ answer: a.slice(0, 2000) }];
    const t = str((a as Json)?.answer);
    return t ? [{ answer: t }] : [];
  });
  const infoboxes = (Array.isArray(data.infoboxes) ? data.infoboxes : []).slice(0, 5).map((b: Json) => ({
    infobox: str(b?.infobox, 300),
    engine: str(b?.engine, 64),
    content: str(b?.content, 2000),
    attributes: (Array.isArray(b?.attributes) ? b.attributes : []).slice(0, 20).map((a: Json) => ({ label: str(a?.label, 200), value: typeof a?.value === "string" || typeof a?.value === "number" ? String(a.value).slice(0, 300) : undefined })),
    urls: (Array.isArray(b?.urls) ? b.urls : []).slice(0, 10).map((u: Json) => ({ title: str(u?.title, 300), url: str(u?.url, 2000) })),
  }));
  const unresponsive = (Array.isArray(data.unresponsive_engines) ? data.unresponsive_engines : [])
    .filter((e: unknown): e is unknown[] => Array.isArray(e))
    .slice(0, 30)
    .map((e) => [String(e[0] ?? "").slice(0, 64), String(e[1] ?? "").slice(0, 200)]);
  return { results, answers, infoboxes, corrections: strs(data.corrections), suggestions: strs(data.suggestions), unresponsive_engines: unresponsive };
}

/** The instance's /config, cut to the door's engines and categories; no
 *  plugins and no DOI resolvers, which a held step does not choose. */
export function trimConfig(cfg: Json): Json {
  const engines = (Array.isArray(cfg.engines) ? cfg.engines : [])
    .filter((e: Json) => typeof e?.name === "string" && DOOR_ENGINES.has(String(e.name).toLowerCase()))
    .map((e: Json) => {
      const name = String(e.name).toLowerCase();
      return {
        name,
        // The door's own categories: what a category= call reaches here.
        categories: Object.entries(DOOR_CATEGORIES).filter(([, list]) => list.includes(name)).map(([c]) => c),
        enabled: true,
        time_range_support: e.time_range_support === true,
      };
    });
  return { engines, categories: Object.keys(DOOR_CATEGORIES), plugins: [], doi_resolvers: [] };
}

/** One GET to the account's engine: no redirect followed, no header of the
 *  client's passed on, a cap on the answer. In-cluster and computed here,
 *  so not through the public-address guard. */
export function upstreamGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { Accept: "application/json", "User-Agent": "foldrun-search-door/1" }, timeout: timeoutMs() }, (res) => {
      let size = 0;
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > BODY_MAX) {
          req.destroy(new Error("too large"));
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

export interface DoorLease {
  key: string;
  token: string;
  tenant: string;
  grant: { search?: { max?: number } };
}

export interface DoorDeps {
  lease(token: string): Promise<DoorLease | null>;
  /** A line in the step's trace. Rejects when it could not be written. */
  line(lease: DoorLease, text: string): Promise<void>;
  /** This search's number for the lease, counted where every replica sees
   *  it. Rejects when that store cannot answer: then nothing is sent. */
  count(lease: DoorLease, ttlSec: number): Promise<number>;
  /** The account's engine, by tenant; null when it cannot be named. */
  upstream?(tenant: string): string | null;
  get?(url: string): Promise<{ status: number; body: string }>;
  /** The image the account's search pods run (FOLDRUN_SEARCH_IMAGE). */
  image?(): string;
}

const inFlight = new Map<string, number>();
const configs = new Map<string, { at: number; cfg: Json }>();
const CONFIG_TTL_MS = 5 * 60_000;

/** For tests: forget what is in flight and the cached configs. */
export function resetSearchDoor(): void {
  inFlight.clear();
  configs.clear();
}

/** Answer one door request: status and JSON body. */
export async function answerSearchDoor(
  method: string | undefined,
  door: NonNullable<ReturnType<typeof parseSearchDoorPath>>,
  deps: DoorDeps,
): Promise<{ status: number; body: Json }> {
  const fail = (status: number, message: string) => ({ status, body: { error: message } });
  if (method !== "GET") return fail(405, "search: the door takes GET");
  const lease = await deps.lease(door.token);
  if (!lease) return fail(401, "search: no such lease — the step it belonged to is over");
  if (!lease.grant.search || typeof lease.grant.search !== "object") {
    return fail(403, "search: this step was not given the search door — it is not held to a restricted network: list, it names a search provider in web:, or its network: does not name search");
  }
  const image = (deps.image ?? (() => process.env.FOLDRUN_SEARCH_IMAGE ?? DEFAULT_SEARCH_IMAGE))();
  if (image !== DOOR_AUDITED_IMAGE) return fail(503, "search: this install's search image is not the one the door's engines were checked in — the door is closed until they are");
  const base = (deps.upstream ?? defaultUpstream)(lease.tenant);
  if (!base) return fail(502, "search: this account's search engine cannot be named");
  const get = deps.get ?? upstreamGet;
  const fetchJson = async (path: string): Promise<{ ok: true; json: Json } | { ok: false; message: string }> => {
    let r: { status: number; body: string };
    try {
      r = await get(`${base.replace(/\/+$/, "")}${path}`);
    } catch {
      return { ok: false, message: REFUSED.unreachable };
    }
    if (r.status !== 200) return { ok: false, message: `search: the account's search engine answered ${r.status}` };
    try {
      const json = JSON.parse(r.body) as unknown;
      return json && typeof json === "object" && !Array.isArray(json) ? { ok: true, json: json as Json } : { ok: false, message: REFUSED.notJson };
    } catch {
      return { ok: false, message: REFUSED.notJson };
    }
  };
  const loadedConfig = async (): Promise<Json | null> => {
    const hit = configs.get(lease.tenant);
    if (hit && Date.now() - hit.at < CONFIG_TTL_MS) return hit.cfg;
    const got = await fetchJson("/config");
    if (!got.ok) return null;
    configs.set(lease.tenant, { at: Date.now(), cfg: got.json });
    return got.json;
  };
  const cfg = await loadedConfig();
  if (!cfg) return fail(502, "search: the account's search engine did not give its configuration");
  if (door.route === "config") return { status: 200, body: trimConfig(cfg) };
  const loaded = new Set((Array.isArray(cfg.engines) ? cfg.engines : []).map((e: Json) => String(e?.name ?? "").toLowerCase()).filter(Boolean));
  const built = doorSearchParams(door.query, loaded);
  if ("refuse" in built) {
    await deps.line(lease, `${built.refuse}. Refused.`).catch(() => undefined);
    return fail(400, built.refuse);
  }
  const busy = inFlight.get(lease.key) ?? 0;
  if (busy >= IN_FLIGHT_MAX) return fail(429, `search: at most ${IN_FLIGHT_MAX} searches at once from one step`);
  inFlight.set(lease.key, busy + 1);
  try {
    const max = typeof lease.grant.search.max === "number" ? Math.min(lease.grant.search.max, doorMax()) : doorMax();
    let n: number;
    try {
      n = await deps.count(lease, COUNT_TTL_SEC);
    } catch {
      return fail(503, "search: the door cannot count this step's searches right now — nothing was sent");
    }
    if (n > max) return fail(429, `search: this step has searched ${max} times — the most it may through the door`);
    const words = built.q.split(" ").length;
    // On the record before it is sent, or not sent.
    try {
      await deps.line(lease, `search: a query (${built.q.length} characters, ${words} word${words === 1 ? "" : "s"}) sent to ${built.engines.join(", ")} through the account's engine — its words may reach those public search engines`);
    } catch {
      return fail(503, "search: the door could not put this search on the run's record — nothing was sent");
    }
    const got = await fetchJson(`/search?${built.params}`);
    if (!got.ok) {
      await deps.line(lease, got.message).catch(() => undefined);
      return fail(502, got.message);
    }
    const off = answerEngines(got.json).filter((e) => !DOOR_ENGINES.has(e));
    if (off.length) {
      await deps.line(lease, REFUSED.answerEngine).catch(() => undefined);
      return fail(502, REFUSED.answerEngine);
    }
    return { status: 200, body: trimSearchAnswer(got.json) };
  } finally {
    const left = (inFlight.get(lease.key) ?? 1) - 1;
    if (left > 0) inFlight.set(lease.key, left);
    else inFlight.delete(lease.key);
  }
}

function defaultUpstream(tenant: string): string | null {
  const seg = accountSegment(tenant);
  return seg ? searchUrl(seg) : null;
}
