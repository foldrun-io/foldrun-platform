// Server tools on /v1/messages, run by foldrun (FOL-313, owner 25 Nov 2026).
//
// A caller asks for Anthropic's server tools — `web_search_20250305`,
// `web_fetch_20250910` — in Anthropic's own shape, and a stock SDK reads the
// answer. But no tool call goes to the model provider (owner, 25 Nov 2026:
// "make sure no tool calls go out to the llm provider and all goes out via
// foldrun"). So the door does what Anthropic does on its side:
//
//   1. lower: each server tool becomes a plain client tool the model can call
//      (`web_search {query}`, `web_fetch {url}`), and the conversation's
//      earlier server blocks (`server_tool_use`, `*_tool_result`) become
//      ordinary `tool_use` / `tool_result` turns. The provider sees only
//      client tools, on every provider (translators carry them too);
//   2. loop: call the model; when it calls one of these tools, run it here
//      (search, fetch — our own ladder), hand back the result, call again;
//   3. raise: the reply the caller gets is one assistant message in
//      Anthropic's shape — `server_tool_use` + `web_search_tool_result` /
//      `web_fetch_tool_result` blocks inline, `usage.server_tool_use`
//      counts, `pause_turn` after MAX_ROUNDS model calls (the client resends,
//      as with Anthropic's own loop), a client tool_use handed back as is.
//
// A server tool this door does not run is refused (400) on every key,
// wherever the request declares it (top-level `tools`, or an inline
// definition in a mid-conversation `tool_addition`): sending it on would let
// the provider run it. Codex review, 25 Nov 2026, shaped the rules below.
// Pure apart from the injected model call and tool runners, for the tests.

import crypto from "node:crypto";
import { StringDecoder } from "node:string_decoder";

type Json = Record<string, unknown>;
type Block = Json & { type: string };
type Message = { role: "user" | "assistant" | "system"; content: string | Block[] };

/** The kinds this door runs. */
export type ToolKind = "search" | "fetch";
/** The dated versions accepted (Anthropic's names; a new one is added here). */
export const SERVER_TOOL_TYPES: Readonly<Record<string, ToolKind>> = {
  web_search_20250305: "search",
  web_fetch_20250910: "fetch",
};
/** The one name each tool has (Anthropic's SDKs know only these). */
const NAME_OF: Record<ToolKind, string> = { search: "web_search", fetch: "web_fetch" };
/** Client tool types (run by the caller): passed through untouched. */
const CLIENT_TYPE = /^(custom|bash_\d+|text_editor_\d+|computer_\d+|memory_\d+)$/;
/** What a dated server tool type looks like, anywhere in a request. */

/** Model calls in one request before the turn is handed back as pause_turn. */
export const MAX_ROUNDS = 10;
/** The most one search or fetch result may put into the conversation. */
const RESULT_TEXT_MAX = 100_000;

export interface ServerToolConfig {
  kind: ToolKind;
  name: string;
  type: string;
  max_uses?: number;
  allowed_domains?: string[];
  blocked_domains?: string[];
  user_location?: Json;
  max_content_tokens?: number;
  cache_control?: unknown;
}

export interface SearchResult { url: string; title: string; snippet: string; page_age?: string | null }
export type SearchError = "too_many_requests" | "invalid_tool_input" | "max_uses_exceeded" | "query_too_long" | "unavailable";
export type FetchError = "invalid_tool_input" | "url_too_long" | "url_not_allowed" | "url_not_in_prior_context" | "url_not_accessible" | "too_many_requests" | "unsupported_content_type" | "max_uses_exceeded" | "unavailable";
export interface FetchResult { url: string; title?: string | null; text: string; mediaType: string; retrievedAt: string }

export interface ToolRunners {
  search(q: { query: string; allowed_domains?: string[]; blocked_domains?: string[]; user_location?: Json }, ctx: { signal?: AbortSignal }): Promise<{ results: SearchResult[]; via: string } | { error: SearchError }>;
  /** `allow` is the tool's domain rule, checked on the first URL and every redirect hop. */
  fetchPage(url: string, opts: { maxChars: number; allow: (url: string) => boolean; signal?: AbortSignal }): Promise<{ page: FetchResult; via: string } | { error: FetchError }>;
}

/** One model call: the request body (a lowered, non-streaming Messages
 *  request) in, the provider's answer out. */
export type ModelCall = (body: Json) => Promise<{ status: number; headers: Record<string, string>; body: Buffer }>;

export class ServerToolRefusal extends Error {}

const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : undefined);

/** Inside a mid-conversation `tool_addition`: the wrappers and references
 *  that are not themselves a tool someone else runs. */
const ADDITION_SHAPES = new Set(["tool_addition", "tool_definition", "tool_reference", "tool_removal"]);

/** Every tool type added mid-conversation (a `tool_addition` carrying a
 *  full definition, an MCP toolset, anything with a type), wherever it sits. */
function inlineToolTypes(messages: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, inAddition: boolean) => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, inAddition));
    if (!v || typeof v !== "object") return;
    const o = v as Json;
    const t = typeof o.type === "string" ? o.type : "";
    if (!inAddition && t !== "tool_addition") {
      for (const x of Object.values(o)) walk(x, false);
      return;
    }
    if (inAddition && t && !ADDITION_SHAPES.has(t)) out.push(t);
    // Inside an addition, look no deeper than the tool itself.
    for (const [k, x] of Object.entries(o)) if (k === "tool" || k === "tools" || k === "content" || k === "definition") walk(x, true);
  };
  walk(messages, false);
  return out;
}

/** The server tools a request asks for, or null when it asks for none. A
 *  server tool this door does not run is refused, never passed on; so is
 *  one declared inline mid-conversation (the door would not see it in time). */
export function serverToolsOf(body: Json): ServerToolConfig[] | null {
  // Tools a provider would run for itself: refused, never passed on.
  if (Array.isArray(body.mcp_servers) ? body.mcp_servers.length > 0 : body.mcp_servers !== undefined) throw new ServerToolRefusal("mcp_servers is not offered: the provider would call those servers itself; connect an MCP server to a foldrun agent instead");
  for (const type of inlineToolTypes(body.messages)) {
    if (!CLIENT_TYPE.test(type)) throw new ServerToolRefusal(`the tool ${type} cannot be added mid-conversation here: declare it in the request's top-level tools`);
  }
  const tools = Array.isArray(body.tools) ? (body.tools as Json[]) : [];
  const out: ServerToolConfig[] = [];
  for (const t of tools) {
    const type = typeof t?.type === "string" ? t.type : "";
    if (type === "" || CLIENT_TYPE.test(type)) continue;
    const kind = SERVER_TOOL_TYPES[type];
    if (!kind) throw new ServerToolRefusal(`the server tool ${type} is not offered: foldrun runs server tools itself and runs ${Object.keys(SERVER_TOOL_TYPES).join(", ")}`);
    if (out.some((o) => o.kind === kind)) throw new ServerToolRefusal(`${type}: a request may name each server tool once`);
    const name = typeof t.name === "string" && t.name ? t.name : NAME_OF[kind];
    if (name !== NAME_OF[kind]) throw new ServerToolRefusal(`${type}: its name is ${NAME_OF[kind]}`);
    const allowed = strs(t.allowed_domains);
    const blocked = strs(t.blocked_domains);
    if (allowed?.length && blocked?.length) throw new ServerToolRefusal(`${type}: allowed_domains and blocked_domains cannot both be set`);
    for (const d of [...(allowed ?? []), ...(blocked ?? [])]) {
      const host = d.split("/")[0]!;
      if (/^https?:/i.test(d) || host.includes("*") || !/^[A-Za-z0-9.-]+$/.test(host)) throw new ServerToolRefusal(`${type}: the domain ${JSON.stringify(d)} is not valid (no scheme, ASCII, a * only in the path)`);
    }
    const maxUses = t.max_uses;
    if (maxUses !== undefined && (typeof maxUses !== "number" || !Number.isInteger(maxUses) || maxUses < 1)) throw new ServerToolRefusal(`${type}: max_uses must be a whole number of at least 1`);
    out.push({
      kind,
      type,
      name,
      ...(typeof maxUses === "number" ? { max_uses: maxUses } : {}),
      ...(allowed?.length ? { allowed_domains: allowed } : {}),
      ...(blocked?.length ? { blocked_domains: blocked } : {}),
      ...(t.user_location && typeof t.user_location === "object" ? { user_location: t.user_location as Json } : {}),
      ...(typeof t.max_content_tokens === "number" ? { max_content_tokens: t.max_content_tokens } : {}),
      ...(t.cache_control !== undefined ? { cache_control: t.cache_control } : {}),
    });
  }
  return out.length ? out : null;
}

/** The client tool the model is given in place of a server tool. */
function clientToolFor(c: ServerToolConfig): Json {
  const cc = c.cache_control !== undefined ? { cache_control: c.cache_control } : {};
  if (c.kind === "search") {
    return {
      name: c.name,
      description: "Search the web for current information. Returns titles, URLs and snippets of the top results. Use it for anything after your training data or that must be checked.",
      input_schema: { type: "object", properties: { query: { type: "string", description: "The search query" } }, required: ["query"] },
      ...cc,
    };
  }
  return {
    name: c.name,
    description: "Fetch the text of a web page at a URL. Only URLs that appeared in the conversation (from the user, a tool result, or earlier search or fetch results) can be fetched.",
    input_schema: { type: "object", properties: { url: { type: "string", description: "The URL to fetch" } }, required: ["url"] },
    ...cc,
  };
}

const RESULT_TYPE: Record<ToolKind, string> = { search: "web_search_tool_result", fetch: "web_fetch_tool_result" };
const isResultBlock = (b: Block) => b.type === "web_search_tool_result" || b.type === "web_fetch_tool_result";

/** encrypted_content: the snippet, signed so a changed one is refused (as
 *  Anthropic refuses it). The key comes from the install's secret. */
const sealKey = () => crypto.createHash("sha256").update(`foldrun-server-tools:${process.env.FOLDRUN_SECRET_KEY ?? "dev"}`).digest();
const mac = (t: string) => crypto.createHmac("sha256", sealKey()).update(t).digest("base64url").slice(0, 32);
export const seal = (text: string) => Buffer.from(JSON.stringify({ v: 1, t: text, m: mac(text) }), "utf8").toString("base64");
/** The snippet back; null when it is not foldrun's (another service's result:
 *  its text cannot be read here); throws when foldrun's and changed. */
function unseal(s: unknown): string | null {
  if (typeof s !== "string") return null;
  let o: { v?: unknown; t?: unknown; m?: unknown };
  try {
    o = JSON.parse(Buffer.from(s, "base64").toString("utf8")) as typeof o;
  } catch {
    return null;
  }
  if (o?.v !== 1 || typeof o.t !== "string") return null;
  if (o.m !== mac(o.t)) throw new ServerToolRefusal("a web_search_result's encrypted_content was changed: send the results back as they were given");
  return o.t;
}

/** A result block, as the text the model reads in a tool_result. */
function resultText(b: Block): { text: string; isError: boolean } {
  const c = b.content as unknown;
  if (b.type === "web_search_tool_result") {
    if (!Array.isArray(c)) return { text: `search error: ${String((c as Json | undefined)?.error_code ?? "unavailable")}`, isError: true };
    const lines = (c as Json[]).map((r, i) => `${i + 1}. ${String(r.title ?? "")}\n   ${String(r.url ?? "")}${r.page_age ? `\n   (${String(r.page_age)})` : ""}\n   ${unseal(r.encrypted_content) ?? "(snippet not available)"}`);
    return { text: lines.length ? lines.join("\n\n") : "no results", isError: false };
  }
  const cj = (c ?? {}) as Json;
  if (cj.type !== "web_fetch_result") return { text: `fetch error: ${String(cj.error_code ?? "unavailable")}`, isError: true };
  const doc = (cj.content ?? {}) as Json;
  const src = (doc.source ?? {}) as Json;
  return { text: `${doc.title ? `${String(doc.title)}\n` : ""}${String(cj.url ?? "")}\n\n${typeof src.data === "string" ? src.data : ""}`, isError: false };
}

const withCache = (from: Block, to: Block): Block => (from.cache_control !== undefined ? { ...to, cache_control: from.cache_control } : to);

/** Earlier turns: server blocks become tool_use / tool_result turns the
 *  provider understands. An assistant message is cut after each result;
 *  consecutive turns of one role are joined, so the turns still alternate
 *  and a client's tool_result lands beside the server results it follows. */
export function lowerMessages(messages: Message[]): Message[] {
  const out: Message[] = [];
  const push = (m: Message) => {
    const last = out[out.length - 1];
    if (last && last.role === m.role && m.role !== "system") {
      const a = typeof last.content === "string" ? [{ type: "text", text: last.content } as Block] : last.content;
      const b = typeof m.content === "string" ? [{ type: "text", text: m.content } as Block] : m.content;
      last.content = [...a, ...b];
    } else out.push(m);
  };
  for (const m of messages) {
    if (m.role !== "assistant" || typeof m.content === "string") {
      push({ role: m.role, content: typeof m.content === "string" ? m.content : m.content.filter((b) => b.type !== "server_tool_use" && !isResultBlock(b)) });
      continue;
    }
    let cur: Block[] = [];
    // The client's own tool calls are answered in the caller's next message,
    // so they must end the assistant turn: moved after the server pairs
    // (Codex review, 25 Nov 2026: a client call before a search left its
    // tool_use without the result right after it).
    const hasServer = m.content.some((b) => b.type === "server_tool_use");
    const clientCalls = hasServer ? m.content.filter((b) => b.type === "tool_use") : [];
    for (const b of m.content) {
      if (hasServer && b.type === "tool_use") continue;
      if (b.type === "server_tool_use") {
        cur.push(withCache(b, { type: "tool_use", id: providerId(b.id), name: b.name, input: b.input ?? {} }));
      } else if (isResultBlock(b)) {
        if (cur.length) push({ role: "assistant", content: cur });
        cur = [];
        const r = resultText(b);
        push({ role: "user", content: [withCache(b, { type: "tool_result", tool_use_id: providerId(b.tool_use_id), content: r.text.slice(0, RESULT_TEXT_MAX), ...(r.isError ? { is_error: true } : {}) })] });
      } else {
        cur.push(b);
      }
    }
    cur.push(...clientCalls);
    if (cur.length) push({ role: "assistant", content: cur });
  }
  return out;
}

/** The request the provider sees: client tools only, no server blocks. */
export function lowerRequest(body: Json, configs: ServerToolConfig[]): Json {
  const tools = (Array.isArray(body.tools) ? (body.tools as Json[]) : []).map((t) => {
    const c = configs.find((x) => x.type === t?.type);
    return c ? clientToolFor(c) : t;
  });
  const messages = lowerMessages((Array.isArray(body.messages) ? body.messages : []) as Message[]);
  return { ...body, tools, messages };
}

const URL_RE = /https?:\/\/[^\s<>"'`)\]}]+/g;
const urlsIn = (s: string) => (s.match(URL_RE) ?? []).map((u) => u.replace(/[.,;:!?]+$/, ""));
const textOf = (v: unknown): string[] => {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(textOf);
  if (v && typeof v === "object") return Object.values(v as Json).flatMap(textOf);
  return [];
};

/** URLs the model may fetch, as Anthropic allows: what the user wrote, what a
 *  client tool result gave, and what earlier search or fetch results gave —
 *  never a URL only the model wrote (its prose, thinking or tool inputs). */
export function urlsInConversation(messages: Message[]): Set<string> {
  const seen = new Set<string>();
  const add = (v: unknown) => textOf(v).forEach((s) => urlsIn(s).forEach((u) => seen.add(u)));
  for (const m of messages) {
    if (m.role === "user") {
      if (typeof m.content === "string") add(m.content);
      else for (const b of m.content) if (b.type === "text" || b.type === "tool_result" || b.type === "document") add(b.type === "text" ? b.text : b.content ?? b.source);
    } else if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === "web_search_tool_result" && Array.isArray(b.content)) for (const r of b.content as Json[]) if (typeof r.url === "string") seen.add(r.url);
        if (b.type === "web_fetch_tool_result") add(b.content);
      }
    }
  }
  return seen;
}

const hostOf = (u: string): string | null => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
};
/** Anthropic's rules (server-tools docs, "Domain filtering"): a domain
 *  covers its subdomains; for search a path matches it and below, `*` in the
 *  path matches any run of characters; for fetch only the domain is matched,
 *  and an entry with a path never matches. Host case-insensitive, path as
 *  written. */
export function domainMatches(url: string, rule: string, kind: ToolKind = "search"): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  // `example.com.` is the same name as `example.com`: trailing dots off.
  const host = u.hostname.toLowerCase().replace(/\.+$/, "");
  const slash = rule.indexOf("/");
  const d = (slash >= 0 ? rule.slice(0, slash) : rule).toLowerCase().replace(/\.+$/, "");
  const p = slash >= 0 ? rule.slice(slash).replace(/\/+$/, "") : "";
  if (!(host === d || host.endsWith(`.${d}`))) return false;
  if (!p) return true;
  if (kind === "fetch") return false;
  const re = new RegExp(`^${p.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}(?:/.*)?$`);
  return re.test(u.pathname);
}
export function domainAllowed(url: string, c: Pick<ServerToolConfig, "allowed_domains" | "blocked_domains">, kind: ToolKind = "search"): boolean {
  if (!hostOf(url)) return false;
  if (c.allowed_domains?.length) return c.allowed_domains.some((d) => domainMatches(url, d, kind));
  if (c.blocked_domains?.length) return !c.blocked_domains.some((d) => domainMatches(url, d, kind));
  return true;
}

/** Credential-looking parts of a URL: a user:password, or a query value
 *  under a secret-sounding name. A fetch of such a URL is refused unless
 *  that value appears in the system prompt or a user's own text (Anthropic:
 *  "a credential that appears only in a tool result does not count"). */
const SECRET_PARAM = /^(api[_-]?key|apikey|key|token|access[_-]?token|auth|authorization|secret|client[_-]?secret|password|passwd|pwd|sig|signature|x-amz-signature|x-amz-credential|x-goog-signature|session|sessionid)$/i;
export function credentialsIn(url: string): string[] {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  const out: string[] = [];
  if (u.password) out.push(decodeURIComponent(u.password));
  else if (u.username) out.push(decodeURIComponent(u.username));
  for (const [k, v] of u.searchParams) if (v && SECRET_PARAM.test(k)) out.push(v);
  return out;
}
/** The text a person wrote: the system prompt and users' own text blocks. */
export function personText(body: Json): string {
  const parts: string[] = [];
  const sys = body.system;
  if (typeof sys === "string") parts.push(sys);
  else if (Array.isArray(sys)) for (const b of sys as Json[]) if (typeof b?.text === "string") parts.push(b.text);
  for (const m of (Array.isArray(body.messages) ? body.messages : []) as Message[]) {
    if (m.role !== "user") continue;
    if (typeof m.content === "string") parts.push(m.content);
    else for (const b of m.content) if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

/** Uses of each tool already made in the turn being continued (pause_turn,
 *  or a client tool_result after a mixed round): they count toward
 *  max_uses, as Anthropic counts them. The turn starts at the last user
 *  message that is more than tool results. */
export function priorUses(messages: Message[]): Record<ToolKind, number> {
  const n: Record<ToolKind, number> = { search: 0, fetch: 0 };
  let start = 0;
  messages.forEach((m, i) => {
    if (m.role === "user" && (typeof m.content === "string" || m.content.some((b) => b.type !== "tool_result"))) start = i + 1;
  });
  for (const m of messages.slice(start)) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "server_tool_use") {
        if (b.name === NAME_OF.search) n.search++;
        else if (b.name === NAME_OF.fetch) n.fetch++;
      }
    }
  }
  return n;
}

/** A forced choice of a tool decides the first call only: later rounds are
 *  `auto`, or the model would be made to call it again after its result. */
function laterChoice(body: Json): Json {
  const tc = body.tool_choice as Json | undefined;
  if (!tc || typeof tc !== "object" || (tc.type !== "tool" && tc.type !== "any")) return body;
  return { ...body, tool_choice: { type: "auto", ...(tc.disable_parallel_tool_use !== undefined ? { disable_parallel_tool_use: tc.disable_parallel_tool_use } : {}) } };
}

/** The id the caller sees for a server call carries Anthropic's `srvtoolu_`
 *  prefix and, inside it, the provider's own id, read back on replay
 *  (providerId), so a translated provider's signature saved under its id
 *  still matches, with no state kept here. */
const OUR_ID = "srvtoolu_fr";
export const publicId = (providerId: string) => `${OUR_ID}${Buffer.from(providerId, "utf8").toString("base64url")}`;
export function providerId(id: unknown): unknown {
  if (typeof id !== "string" || !id.startsWith(OUR_ID)) return id;
  const back = Buffer.from(id.slice(OUR_ID.length), "base64url").toString("utf8");
  return back && publicId(back) === id ? back : id;
}
const freshId = () => `toolu_fr${crypto.randomBytes(12).toString("base64url")}`;
const callIds = (b: Block) => {
  const prov = typeof b.id === "string" && b.id ? b.id : freshId();
  return { prov, pub: publicId(prov) };
};

interface Usage { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }
const USAGE_KEYS = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"] as const;
const zeroUsage = (): Usage => ({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });

interface ToolState { personText: string; allowedUrls: Set<string>; used: Record<ToolKind, number>; ran: { search: number; fetch: number }; vias: Set<string>; signal?: AbortSignal }

/** Runs one server tool call: limits, inputs, the domain lists, the URL
 *  rule for fetch, then the rung. Shared by both loops. `ran` counts calls
 *  that a rung answered (the meter's unit; a refused one is not counted). */
function toolRunner(runners: ToolRunners, st: ToolState) {
  return async function runOne(c: ServerToolConfig, input: Json): Promise<{ block: Block; text: string; isError: boolean }> {
    const err = (code: string) => {
      const block: Block = c.kind === "search"
        ? { type: RESULT_TYPE.search, content: { type: "web_search_tool_result_error", error_code: code } }
        : { type: RESULT_TYPE.fetch, content: { type: "web_fetch_tool_result_error", error_code: code } };
      return { block, text: `${c.kind} error: ${code}`, isError: true };
    };
    if (st.signal?.aborted) return err("unavailable");
    if (c.max_uses !== undefined && st.used[c.kind] >= c.max_uses) return err("max_uses_exceeded");
    st.used[c.kind]++;
    if (c.kind === "search") {
      const query = typeof input.query === "string" ? input.query.trim() : "";
      if (!query) return err("invalid_tool_input");
      if (query.length > 400) return err("query_too_long");
      const got = await runners.search({ query, ...(c.allowed_domains ? { allowed_domains: c.allowed_domains } : {}), ...(c.blocked_domains ? { blocked_domains: c.blocked_domains } : {}), ...(c.user_location ? { user_location: c.user_location } : {}) }, { ...(st.signal ? { signal: st.signal } : {}) }).catch(() => ({ error: "unavailable" as const }));
      if ("error" in got) return err(got.error);
      st.ran.search++;
      st.vias.add(got.via);
      const results = got.results.filter((r) => domainAllowed(r.url, c));
      for (const r of results) st.allowedUrls.add(r.url);
      const block: Block = { type: RESULT_TYPE.search, content: results.map((r) => ({ type: "web_search_result", url: r.url, title: r.title, encrypted_content: seal(r.snippet), page_age: r.page_age ?? null })) };
      return { block, ...resultText(block) };
    }
    const url = typeof input.url === "string" ? input.url.trim() : "";
    if (!url || !/^https?:\/\//i.test(url) || !hostOf(url)) return err("invalid_tool_input");
    if (url.length > 250) return err("url_too_long");
    if (!st.allowedUrls.has(url)) return err("url_not_in_prior_context");
    if (!domainAllowed(url, c, "fetch")) return err("url_not_allowed");
    const credentialOk = (u: string) => credentialsIn(u).every((v) => st.personText.includes(v));
    if (!credentialOk(url)) return err("url_not_allowed");
    const maxChars = Math.min(RESULT_TEXT_MAX, c.max_content_tokens ? c.max_content_tokens * 4 : RESULT_TEXT_MAX);
    const got = await runners.fetchPage(url, { maxChars, allow: (u) => domainAllowed(u, c, "fetch") && credentialOk(u), ...(st.signal ? { signal: st.signal } : {}) }).catch(() => ({ error: "unavailable" as const }));
    if ("error" in got) return err(got.error);
    st.ran.fetch++;
    st.vias.add(got.via);
    const p = got.page;
    // Links in a fetched page may be followed next, as from a search result.
    for (const u of urlsIn(p.text)) st.allowedUrls.add(u);
    const block: Block = { type: RESULT_TYPE.fetch, content: { type: "web_fetch_result", url: p.url, content: { type: "document", source: { type: "text", media_type: "text/plain", data: p.text.slice(0, maxChars) }, ...(p.title ? { title: p.title } : {}) }, retrieved_at: p.retrievedAt } };
    return { block, ...resultText(block) };
  };
}

function startState(body: Json, signal?: AbortSignal): ToolState {
  const messages = (Array.isArray(body.messages) ? body.messages : []) as Message[];
  return { personText: personText(body), allowedUrls: urlsInConversation(messages), used: priorUses(messages), ran: { search: 0, fetch: 0 }, vias: new Set<string>(), ...(signal ? { signal } : {}) };
}

export interface LoopResult {
  status: number;
  /** The final message (200), or the provider's own error body. */
  body: Json | Buffer;
  headers: Record<string, string>;
  /** Tool calls a rung answered, for the meter and the log. */
  ran: { search: number; fetch: number };
  vias: string[];
}

/**
 * The loop: model call, run the server tools it called, call again, until it
 * stops calling them, calls a client tool, or MAX_ROUNDS is reached. The
 * request must already be validated (serverToolsOf) and non-streaming.
 */
export async function runServerToolLoop(body: Json, configs: ServerToolConfig[], call: ModelCall, runners: ToolRunners, opts: { isGone?: () => boolean; maxRounds?: number; signal?: AbortSignal } = {}): Promise<LoopResult> {
  const lowered = lowerRequest({ ...body, stream: false }, configs);
  const byName = new Map(configs.map((c) => [c.name, c]));
  const st = startState(body, opts.signal);
  const runOne = toolRunner(runners, st);
  const usage = zeroUsage();
  const content: Block[] = [];
  const convo = [...(lowered.messages as Message[])];
  let last: Json | null = null;
  let headers: Record<string, string> = {};
  const maxRounds = opts.maxRounds ?? MAX_ROUNDS;
  const done = (status: number, b: Buffer): LoopResult => ({ status, body: b, headers, ran: st.ran, vias: [...st.vias] });

  for (let round = 0; round < maxRounds; round++) {
    if (opts.isGone?.()) break;
    const reply = await call({ ...(round === 0 ? lowered : laterChoice(lowered)), messages: convo });
    headers = reply.headers;
    // A refusal is the caller's answer as the provider gave it. Tool calls
    // already run are in `ran` (metered all the same).
    if (reply.status !== 200) return done(reply.status, reply.body);
    let msg: Json;
    try {
      msg = JSON.parse(reply.body.toString("utf8")) as Json;
    } catch {
      return done(502, Buffer.from(JSON.stringify({ type: "error", error: { type: "api_error", message: "the provider's reply could not be read" } })));
    }
    last = msg;
    const u = (msg.usage ?? {}) as Partial<Usage>;
    for (const k of USAGE_KEYS) usage[k] += u[k] ?? 0;
    const blocks = (Array.isArray(msg.content) ? msg.content : []) as Block[];
    const ours = blocks.filter((b) => b.type === "tool_use" && byName.has(String(b.name)));
    const theirs = blocks.some((b) => b.type === "tool_use" && !byName.has(String(b.name)));
    if (msg.stop_reason !== "tool_use" || ours.length === 0) {
      content.push(...blocks);
      return finish(msg.stop_reason as string);
    }
    // The model's order kept; each of our calls followed by its result.
    const roundAssistant: Block[] = [];
    const roundResults: Block[] = [];
    for (const b of blocks) {
      if (!(b.type === "tool_use" && byName.has(String(b.name)))) {
        content.push(b);
        roundAssistant.push(b);
        continue;
      }
      const c = byName.get(String(b.name))!;
      const { prov, pub } = callIds(b);
      const input = (b.input ?? {}) as Json;
      const result = await runOne(c, input);
      content.push({ type: "server_tool_use", id: pub, name: c.name, input }, { ...result.block, tool_use_id: pub });
      roundAssistant.push({ type: "tool_use", id: prov, name: c.name, input });
      roundResults.push({ type: "tool_result", tool_use_id: prov, content: result.text.slice(0, RESULT_TEXT_MAX), ...(result.isError ? { is_error: true } : {}) });
    }
    if (theirs) return finish("tool_use");
    convo.push({ role: "assistant", content: roundAssistant }, { role: "user", content: roundResults });
  }
  return finish("pause_turn");

  function finish(stop: string): LoopResult {
    const base = last ?? { id: `msg_${crypto.randomBytes(12).toString("base64url")}`, type: "message", role: "assistant", model: String(body.model ?? "") };
    const message: Json = {
      ...base,
      content,
      stop_reason: stop,
      stop_sequence: stop === "stop_sequence" ? (last?.stop_sequence ?? null) : null,
      usage: { ...((last?.usage as Json) ?? {}), ...usage, server_tool_use: { web_search_requests: st.ran.search, web_fetch_requests: st.ran.fetch } },
    };
    return { status: 200, body: message, headers, ran: st.ran, vias: [...st.vias] };
  }
}

// ------------------------------------------------------------------ streaming

/** One event of Anthropic's stream. */
export interface SseEvent { event: string; data: Json }

/** Anthropic SSE bytes → events, as chunks arrive (a character cut between
 *  two chunks is joined, never replaced). */
export async function* sseEvents(chunks: AsyncIterable<Buffer | string>): AsyncGenerator<SseEvent> {
  const dec = new StringDecoder("utf8");
  let buf = "";
  for await (const c of chunks) {
    buf += typeof c === "string" ? c : dec.write(c);
    let cut: number;
    while ((cut = buf.search(/\r?\n\r?\n/)) >= 0) {
      const raw = buf.slice(0, cut);
      buf = buf.slice(cut).replace(/^\r?\n\r?\n/, "");
      let event = "message";
      const data: string[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (!data.length) continue;
      try {
        const d = JSON.parse(data.join("\n")) as Json;
        yield { event: event === "message" && typeof d.type === "string" ? d.type : event, data: d };
      } catch {
        // a line that is not JSON is not Anthropic's; dropped
      }
    }
  }
}

const sse = (event: string, data: Json) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** A model call that streams: the status first, then the body's chunks;
 *  `cancel` ends a round whose stream is no longer read. */
export type StreamingModelCall = (body: Json) => Promise<{ status: number; headers: Record<string, string>; chunks: AsyncIterable<Buffer>; cancel?: () => void }>;

/**
 * The loop for a caller that asked for `stream: true`. Each round's stream
 * is relayed as it comes — text and thinking reach the caller live — with
 * three changes: our tools' tool_use blocks go out as server_tool_use, every
 * block index runs on across rounds, and only the last round's
 * message_delta / message_stop are sent (usage summed over the rounds,
 * server_tool_use counted). Between rounds the tools run and their result
 * blocks are sent.
 *
 * `start` is called once, before the first byte, with the first round's
 * status: a refusal there (status ≠ 200) is the caller's HTTP answer and
 * nothing is streamed. A refusal in a later round is an `error` event.
 * `write` may return a promise: the loop waits on it (the caller's socket
 * is full), so a slow caller holds the provider's stream back.
 */
export async function runServerToolLoopStream(
  body: Json,
  configs: ServerToolConfig[],
  call: StreamingModelCall,
  runners: ToolRunners,
  out: { start: (status: number, headers: Record<string, string>, refusal?: Buffer) => void; write: (text: string) => void | Promise<void>; isGone?: () => boolean },
  opts: { maxRounds?: number; signal?: AbortSignal } = {},
): Promise<{ ran: { search: number; fetch: number }; vias: string[] }> {
  const lowered = lowerRequest({ ...body, stream: true }, configs);
  const byName = new Map(configs.map((c) => [c.name, c]));
  const st = startState(body, opts.signal);
  const runOne = toolRunner(runners, st);
  const total = zeroUsage();
  const convo = [...(lowered.messages as Message[])];
  const maxRounds = opts.maxRounds ?? MAX_ROUNDS;
  const result = () => ({ ran: st.ran, vias: [...st.vias] });
  const write = async (text: string) => {
    const w = out.write(text);
    if (w) await w;
  };
  let next = 0; // the next block index the caller sees
  let stop: string | null = null;
  let stopSequence: unknown = null;

  for (let round = 0; round < maxRounds; round++) {
    if (out.isGone?.()) return result();
    const reply = await call({ ...(round === 0 ? lowered : laterChoice(lowered)), messages: convo });
    if (reply.status !== 200) {
      const chunks: Buffer[] = [];
      for await (const c of reply.chunks) chunks.push(c);
      const text = Buffer.concat(chunks);
      if (round === 0) {
        out.start(reply.status, reply.headers, text);
        return result();
      }
      let err: Json = { type: "api_error", message: "the provider refused the next step of this turn" };
      try {
        const j = JSON.parse(text.toString("utf8")) as Json;
        if (j.error && typeof j.error === "object") err = j.error as Json;
      } catch {
        // keep the plain one
      }
      await write(sse("error", { type: "error", error: err }));
      return result();
    }
    if (round === 0) out.start(200, reply.headers);

    // This round's blocks, rebuilt for the next round's request.
    const blocks = new Map<number, { block: Block; json: string; ours: boolean; pub?: string }>();
    const base = next;
    // The round's usage: message_start's, then each message_delta's
    // (cumulative within the round, and the only place a translated
    // provider gives its input counts). Summed over rounds at the end.
    const roundUsage = zeroUsage();
    let roundStop: string | null = null;
    let sawStop = false;
    try {
      for await (const e of sseEvents(reply.chunks)) {
        const d = e.data;
        if (e.event === "ping") {
          await write(sse("ping", { type: "ping" }));
        } else if (e.event === "error") {
          await write(sse("error", d));
          return result();
        } else if (e.event === "message_start") {
          const u = (((d.message ?? {}) as Json).usage ?? {}) as Partial<Usage>;
          for (const k of USAGE_KEYS) if (typeof u[k] === "number") roundUsage[k] = u[k]!;
          if (round === 0) await write(sse("message_start", d));
        } else if (e.event === "content_block_start") {
          const i = Number(d.index);
          const cb = (d.content_block ?? {}) as Block;
          const ours = cb.type === "tool_use" && byName.has(String(cb.name));
          const ids = ours ? callIds(cb) : undefined;
          blocks.set(i, { block: ours ? { type: "tool_use", id: ids!.prov, name: cb.name, input: {} } : { ...cb }, json: "", ours, pub: ids?.pub });
          next = Math.max(next, base + i + 1);
          await write(sse("content_block_start", { type: "content_block_start", index: base + i, content_block: ours ? { type: "server_tool_use", id: ids!.pub, name: cb.name, input: {} } : cb }));
        } else if (e.event === "content_block_delta") {
          const i = Number(d.index);
          const b = blocks.get(i);
          const delta = (d.delta ?? {}) as Json;
          if (b) {
            if (delta.type === "text_delta") b.block.text = `${String(b.block.text ?? "")}${String(delta.text ?? "")}`;
            else if (delta.type === "thinking_delta") b.block.thinking = `${String(b.block.thinking ?? "")}${String(delta.thinking ?? "")}`;
            else if (delta.type === "signature_delta") b.block.signature = delta.signature;
            else if (delta.type === "input_json_delta") b.json += String(delta.partial_json ?? "");
            else if (delta.type === "citations_delta") b.block.citations = [...((b.block.citations as unknown[]) ?? []), delta.citation];
          }
          await write(sse("content_block_delta", { ...d, index: base + i }));
        } else if (e.event === "content_block_stop") {
          const i = Number(d.index);
          const b = blocks.get(i);
          if (b && b.block.type === "tool_use") {
            try {
              b.block.input = b.json ? (JSON.parse(b.json) as Json) : {};
            } catch {
              b.block.input = {};
            }
          }
          await write(sse("content_block_stop", { type: "content_block_stop", index: base + i }));
        } else if (e.event === "message_delta") {
          const dd = (d.delta ?? {}) as Json;
          roundStop = typeof dd.stop_reason === "string" ? dd.stop_reason : null;
          stopSequence = dd.stop_sequence ?? null;
          const u = (d.usage ?? {}) as Partial<Usage>;
          for (const k of USAGE_KEYS) if (typeof u[k] === "number") roundUsage[k] = u[k]!;
        } else if (e.event === "message_stop") {
          sawStop = true;
        }
      }
    } finally {
      // Left early (an error event, the caller gone): the round's provider
      // stream is ended, not left waiting for a reader.
      if (!sawStop) reply.cancel?.();
    }
    for (const k of USAGE_KEYS) total[k] += roundUsage[k];
    if (!sawStop) {
      await write(sse("error", { type: "error", error: { type: "api_error", message: "the provider's stream ended early" } }));
      return result();
    }
    const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
    const ours = ordered.filter((b) => b.ours);
    const theirs = ordered.some((b) => b.block.type === "tool_use" && !b.ours);
    if (roundStop !== "tool_use" || ours.length === 0) {
      stop = roundStop;
      break;
    }
    const results: Block[] = [];
    for (const b of ours) {
      const r = await runOne(byName.get(String(b.block.name))!, (b.block.input ?? {}) as Json);
      await write(sse("content_block_start", { type: "content_block_start", index: next, content_block: { ...r.block, tool_use_id: b.pub } }));
      await write(sse("content_block_stop", { type: "content_block_stop", index: next }));
      next++;
      results.push({ type: "tool_result", tool_use_id: b.block.id, content: r.text.slice(0, RESULT_TEXT_MAX), ...(r.isError ? { is_error: true } : {}) });
    }
    if (theirs) {
      stop = "tool_use";
      break;
    }
    convo.push({ role: "assistant", content: ordered.map((b) => b.block) }, { role: "user", content: results });
    stop = "pause_turn";
  }
  await write(sse("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: stop === "stop_sequence" ? stopSequence : null }, usage: { ...total, server_tool_use: { web_search_requests: st.ran.search, web_fetch_requests: st.ran.fetch } } }));
  await write(sse("message_stop", { type: "message_stop" }));
  return result();
}
