// Server tools on /v1/messages, run by foldrun (FOL-313): the provider is
// only ever asked plain client tools; the caller gets Anthropic's shape.
//
//   node --test tests/server-tools.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-servertools-"));
process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE = "1";
delete process.env.FOLDRUN_DATABASE_URL;

const st = await import("../src/server-tools.ts");
const runnersMod = await import("../src/server-tool-runners.ts");

type Json = Record<string, unknown>;
const SEARCH = { type: "web_search_20250305", name: "web_search" };
const FETCH = { type: "web_fetch_20250910", name: "web_fetch" };

// ------------------------------------------------------------ the request

test("server tools are found, an unknown one is refused, a client tool passes", () => {
  assert.equal(st.serverToolsOf({ tools: [{ name: "x", input_schema: {} }, { type: "custom", name: "y" }, { type: "bash_20250124", name: "bash" }] }), null);
  const got = st.serverToolsOf({ tools: [{ ...SEARCH, max_uses: 3, allowed_domains: ["example.com"] }, FETCH] })!;
  assert.deepEqual(got.map((c) => [c.kind, c.name, c.max_uses]), [["search", "web_search", 3], ["fetch", "web_fetch", undefined]]);
  assert.throws(() => st.serverToolsOf({ tools: [{ type: "code_execution_20250522", name: "code_execution" }] }), /not offered/);
  assert.throws(() => st.serverToolsOf({ tools: [SEARCH, { ...SEARCH, name: "other" }] }), /once/);
  assert.throws(() => st.serverToolsOf({ tools: [{ ...SEARCH, allowed_domains: ["a.com"], blocked_domains: ["b.com"] }] }), /both/);
  assert.throws(() => st.serverToolsOf({ tools: [{ ...SEARCH, max_uses: 0 }] }), /max_uses/);
});

test("the provider's request holds no server tool and no server block", () => {
  const configs = st.serverToolsOf({ tools: [SEARCH] })!;
  const sealed = st.seal("a snippet");
  const body = {
    model: "m",
    tools: [SEARCH, { name: "mine", input_schema: { type: "object" } }],
    messages: [
      { role: "user", content: "find it" },
      { role: "assistant", content: [
        { type: "text", text: "Looking." },
        { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "q" } },
        { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: "https://a.com/x", title: "A", encrypted_content: sealed }] },
        { type: "text", text: "Found it." },
      ] },
      { role: "user", content: "thanks" },
    ],
  };
  const low = st.lowerRequest(body, configs);
  const text = JSON.stringify(low);
  assert.doesNotMatch(text, /web_search_20250305|server_tool_use|web_search_tool_result/);
  const tools = low.tools as Json[];
  assert.equal(tools[0]!.type, undefined, "a plain client tool");
  assert.equal(tools[0]!.name, "web_search");
  assert.deepEqual(tools[1], { name: "mine", input_schema: { type: "object" } });
  const msgs = low.messages as { role: string; content: Json[] }[];
  assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "user", "assistant", "user"], "turns still alternate");
  assert.equal(msgs[1]!.content[1]!.type, "tool_use");
  assert.equal(msgs[2]!.content[0]!.type, "tool_result");
  assert.match(String(msgs[2]!.content[0]!.content), /a snippet/, "the snippet sealed in encrypted_content is read back");
});

test("a result as the assistant's last block (a turn resumed after pause_turn) ends on the tool_result", () => {
  const low = st.lowerMessages([
    { role: "user", content: "go" },
    { role: "assistant", content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" } }, { type: "web_search_tool_result", tool_use_id: "s1", content: { type: "web_search_tool_result_error", error_code: "unavailable" } }] },
  ]);
  assert.deepEqual(low.map((m) => m.role), ["user", "assistant", "user"]);
  const tr = (low[2]!.content as Json[])[0]!;
  assert.equal(tr.is_error, true);
});

test("domains: a domain covers its subdomains, not look-alikes", () => {
  assert.ok(st.domainMatches("https://docs.example.com/x", "example.com"));
  assert.ok(!st.domainMatches("https://badexample.com/", "example.com"));
});

// ------------------------------------------------------------ the loop

const reply = (content: Json[], stop: string, usage = { input_tokens: 100, output_tokens: 10 }) =>
  ({ status: 200, headers: { "content-type": "application/json", "request-id": "req_x" }, body: Buffer.from(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "m", content, stop_reason: stop, usage })) });

function fakeRunners(log: string[] = []) {
  return {
    async search(q: { query: string }) {
      log.push(`search:${q.query}`);
      return { results: [{ url: "https://a.com/page", title: "A page", snippet: "about a" }, { url: "https://blocked.com/x", title: "B", snippet: "b" }], via: "fake" };
    },
    async fetchPage(url: string) {
      log.push(`fetch:${url}`);
      return { page: { url, title: "A page", text: "the full text", mediaType: "text/html", retrievedAt: "2026-11-25T00:00:00.000Z" }, via: "fake" };
    },
  };
}

test("search then answer: one message back, server blocks inline, usage summed, nothing of ours sent to the provider", async () => {
  const sent: Json[] = [];
  const answers = [
    reply([{ type: "text", text: "Let me look." }, { type: "tool_use", id: "toolu_1", name: "web_search", input: { query: "a" } }], "tool_use"),
    reply([{ type: "text", text: "It is about a." }], "end_turn", { input_tokens: 300, output_tokens: 20 }),
  ];
  const log: string[] = [];
  const body = { model: "m", max_tokens: 100, tools: [{ ...SEARCH, blocked_domains: ["blocked.com"] }], messages: [{ role: "user", content: "what is a?" }] };
  const r = await st.runServerToolLoop(body, st.serverToolsOf(body)!, async (b) => (sent.push(b), answers.shift()!), fakeRunners(log));
  assert.equal(r.status, 200);
  const m = r.body as Json;
  const types = (m.content as Json[]).map((b) => b.type);
  assert.deepEqual(types, ["text", "server_tool_use", "web_search_tool_result", "text"]);
  const use = (m.content as Json[])[1]!;
  const res = (m.content as Json[])[2]!;
  assert.match(String(use.id), /^srvtoolu_/, "Anthropic's prefix for a server call");
  assert.equal(st.providerId(use.id), "toolu_1", "the provider's own id rides inside it");
  assert.equal(res.tool_use_id, use.id);
  assert.deepEqual((res.content as Json[]).map((x) => x.url), ["https://a.com/page"], "blocked_domains filtered");
  assert.equal(m.stop_reason, "end_turn");
  assert.deepEqual((m.usage as Json).server_tool_use, { web_search_requests: 1, web_fetch_requests: 0 });
  assert.equal((m.usage as Json).input_tokens, 400);
  assert.equal((m.usage as Json).output_tokens, 30);
  assert.deepEqual(log, ["search:a"]);
  assert.equal(sent.length, 2);
  for (const b of sent) {
    assert.equal(b.stream, false);
    assert.doesNotMatch(JSON.stringify(b), /web_search_20250305|server_tool_use|web_search_tool_result/, "the provider never sees a server tool");
  }
  const second = (sent[1]!.messages as { role: string; content: Json[] }[]);
  assert.equal(second.at(-1)!.content[0]!.type, "tool_result", "the result is handed back as a plain tool_result");
});

test("fetch: only a URL the conversation holds; one from a search result is allowed after it", async () => {
  const body = { model: "m", max_tokens: 100, tools: [SEARCH, FETCH], messages: [{ role: "user", content: "read https://given.com/doc please" }] };
  const answers = [
    reply([{ type: "tool_use", id: "t1", name: "web_fetch", input: { url: "https://evil.com/?leak=1" } }, { type: "tool_use", id: "t2", name: "web_fetch", input: { url: "https://given.com/doc" } }], "tool_use"),
    reply([{ type: "tool_use", id: "t3", name: "web_search", input: { query: "a" } }], "tool_use"),
    reply([{ type: "tool_use", id: "t4", name: "web_fetch", input: { url: "https://a.com/page" } }], "tool_use"),
    reply([{ type: "text", text: "done" }], "end_turn"),
  ];
  const log: string[] = [];
  const r = await st.runServerToolLoop(body, st.serverToolsOf(body)!, async () => answers.shift()!, fakeRunners(log));
  const blocks = (r.body as Json).content as Json[];
  const errs = blocks.filter((b) => b.type === "web_fetch_tool_result").map((b) => (b.content as Json).error_code ?? "ok");
  assert.deepEqual(errs, ["url_not_in_prior_context", "ok", "ok"]);
  assert.deepEqual(log, ["fetch:https://given.com/doc", "search:a", "fetch:https://a.com/page"], "the unseen URL was never fetched");
  assert.deepEqual(r.ran, { search: 1, fetch: 2 });
});

test("max_uses, pause_turn after the round limit, and a client tool handed back", async () => {
  const body = { model: "m", max_tokens: 100, tools: [{ ...SEARCH, max_uses: 1 }, { name: "mine", input_schema: {} }], messages: [{ role: "user", content: "go" }] };
  const configs = st.serverToolsOf(body)!;
  const twice = [reply([{ type: "tool_use", id: "a", name: "web_search", input: { query: "1" } }, { type: "tool_use", id: "b", name: "web_search", input: { query: "2" } }], "tool_use"), reply([{ type: "text", text: "ok" }], "end_turn")];
  const r1 = await st.runServerToolLoop(body, configs, async () => twice.shift()!, fakeRunners());
  const codes = ((r1.body as Json).content as Json[]).filter((b) => b.type === "web_search_tool_result").map((b) => (Array.isArray(b.content) ? "ok" : (b.content as Json).error_code));
  assert.deepEqual(codes, ["ok", "max_uses_exceeded"]);

  const forever = async () => reply([{ type: "tool_use", id: "c", name: "web_search", input: { query: "x" } }], "tool_use");
  const r2 = await st.runServerToolLoop({ ...body, tools: [SEARCH] }, st.serverToolsOf({ tools: [SEARCH] })!, forever, fakeRunners(), { maxRounds: 3 });
  assert.equal((r2.body as Json).stop_reason, "pause_turn");

  const mixed = [reply([{ type: "tool_use", id: "d", name: "web_search", input: { query: "y" } }, { type: "tool_use", id: "e", name: "mine", input: {} }], "tool_use")];
  const r3 = await st.runServerToolLoop(body, configs, async () => mixed.shift()!, fakeRunners());
  const m3 = r3.body as Json;
  assert.equal(m3.stop_reason, "tool_use");
  assert.deepEqual((m3.content as Json[]).map((b) => b.type), ["server_tool_use", "web_search_tool_result", "tool_use"], "the client's own tool comes back for the client to run");
});

test("a provider refusal in the first round is the caller's answer as it came", async () => {
  const body = { model: "m", max_tokens: 100, tools: [SEARCH], messages: [{ role: "user", content: "go" }] };
  const r = await st.runServerToolLoop(body, st.serverToolsOf(body)!, async () => ({ status: 402, headers: {}, body: Buffer.from('{"type":"error"}') }), fakeRunners());
  assert.equal(r.status, 402);
  assert.ok(Buffer.isBuffer(r.body));
});

// ------------------------------------------------------------ streaming

const sse = (events: [string, Json][]) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify({ type: e, ...d })}\n\n`).join("");
async function* chunked(text: string) {
  // cut mid-event, as a network does
  for (let i = 0; i < text.length; i += 37) yield Buffer.from(text.slice(i, i + 37));
}

test("streaming: text relayed, our tool_use sent as server_tool_use, indexes run on, one message_stop with the counts", async () => {
  const round1 = sse([
    ["message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "m", content: [], usage: { input_tokens: 100, output_tokens: 1 } } }],
    ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "Looking." } }],
    ["content_block_stop", { index: 0 }],
    ["content_block_start", { index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "web_search", input: {} } }],
    ["content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '{"query":' } }],
    ["content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '"a"}' } }],
    ["content_block_stop", { index: 1 }],
    ["message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } }],
    ["message_stop", {}],
  ]);
  const round2 = sse([
    ["message_start", { message: { id: "msg_2", type: "message", role: "assistant", model: "m", content: [], usage: { input_tokens: 300, output_tokens: 1 } } }],
    ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "Answer." } }],
    ["content_block_stop", { index: 0 }],
    ["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }],
    ["message_stop", {}],
  ]);
  const rounds = [round1, round2];
  const sent: Json[] = [];
  let started: number | null = null;
  let out = "";
  const body = { model: "m", max_tokens: 100, stream: true, tools: [SEARCH], messages: [{ role: "user", content: "a?" }] };
  const done = await st.runServerToolLoopStream(body, st.serverToolsOf(body)!, async (b) => (sent.push(b), { status: 200, headers: {}, chunks: chunked(rounds.shift()!) }), fakeRunners(), {
    start: (s) => (started = s),
    write: (t) => {
      out += t;
    },
  });
  assert.equal(started, 200);
  assert.deepEqual(done.ran, { search: 1, fetch: 0 });
  const events: { event: string; data: Json }[] = [];
  for await (const e of st.sseEvents(chunked(out))) events.push(e);
  assert.equal(events.filter((e) => e.event === "message_start").length, 1);
  assert.equal(events.filter((e) => e.event === "message_stop").length, 1);
  const starts = events.filter((e) => e.event === "content_block_start").map((e) => [e.data.index, (e.data.content_block as Json).type]);
  assert.deepEqual(starts, [[0, "text"], [1, "server_tool_use"], [2, "web_search_tool_result"], [3, "text"]]);
  const delta = events.find((e) => e.event === "message_delta")!.data;
  assert.equal((delta.delta as Json).stop_reason, "end_turn");
  assert.deepEqual((delta.usage as Json).server_tool_use, { web_search_requests: 1, web_fetch_requests: 0 });
  assert.equal((delta.usage as Json).input_tokens, 400);
  assert.equal((delta.usage as Json).output_tokens, 17, "each round's last count, summed: not message_start's 1 on top");
  assert.equal((starts[1] as unknown[])[1], "server_tool_use");
  const pub = ((events.find((e) => e.event === "content_block_start" && (e.data.content_block as Json).type === "server_tool_use")!.data.content_block) as Json).id;
  assert.match(String(pub), /^srvtoolu_/);
  assert.equal(sent[0]!.stream, true);
  const second = sent[1]!.messages as { role: string; content: Json[] }[];
  assert.deepEqual((second.at(-2)!.content[1] as Json).input, { query: "a" }, "the streamed tool input was put back together for the next round");
  for (const b of sent) assert.doesNotMatch(JSON.stringify(b), /web_search_20250305|server_tool_use/);  assert.equal(((second.at(-2)!.content[1]) as Json).id, "toolu_1", "the provider is handed back its own id, so a translated provider's signature still matches");
});

test("streaming: a first-round refusal is an HTTP answer, a later one an error event", async () => {
  const body = { model: "m", max_tokens: 100, stream: true, tools: [SEARCH], messages: [{ role: "user", content: "a?" }] };
  let status = 0;
  let refusal = "";
  await st.runServerToolLoopStream(body, st.serverToolsOf(body)!, async () => ({ status: 429, headers: {}, chunks: chunked('{"type":"error","error":{"type":"rate_limit_error","message":"slow"}}') }), fakeRunners(), {
    start: (s, _h, r) => ((status = s), (refusal = String(r))),
    write: () => assert.fail("nothing is streamed"),
  });
  assert.equal(status, 429);
  assert.match(refusal, /rate_limit_error/);
});

// ------------------------------------------------------------ the rungs

test("SerpApi: results mapped, no key is unavailable, a 429 is too_many_requests", async () => {
  assert.deepEqual(await runnersMod.serpApiSearch({ query: "x" }, { key: "" }), { error: "unavailable" });
  let asked = "";
  const ok = await runnersMod.serpApiSearch({ query: "x", allowed_domains: ["a.com"], user_location: { country: "AU" } }, {
    key: "k",
    fetch: (async (u: string) => {
      asked = u;
      return new Response(JSON.stringify({ organic_results: [{ link: "https://a.com/1", title: "One", snippet: "s", date: "2 days ago" }, { link: "javascript:x" }] }));
    }) as unknown as typeof fetch,
  });
  assert.deepEqual(ok, { results: [{ url: "https://a.com/1", title: "One", snippet: "s", page_age: "2 days ago" }], via: "serpapi" });
  const q = new URL(asked).searchParams;
  assert.equal(q.get("gl"), "au");
  assert.match(q.get("q")!, /site:a\.com/);
  const busy = await runnersMod.serpApiSearch({ query: "x" }, { key: "k", fetch: (async () => new Response("", { status: 429 })) as unknown as typeof fetch });
  assert.deepEqual(busy, { error: "too_many_requests" });
});

test("direct fetch: html to text, a challenge page is not accessible, a PDF waits for extract", async () => {
  const page = (body: string, init: ResponseInit) => (async () => new Response(body, init)) as unknown as typeof import("../src/ssrf.ts").fetchPublic;
  const ok = await runnersMod.directFetch("https://a.com", { maxChars: 1000 }, { fetchPublic: page("<html><head><title>T &amp; U</title><script>x()</script></head><body><p>Hello&nbsp;world</p><ul><li>one</li></ul></body></html>", { headers: { "content-type": "text/html" } }) });
  assert.ok("page" in ok);
  if ("page" in ok) {
    assert.equal(ok.page.title, "T & U");
    assert.match(ok.page.text, /Hello world/);
    assert.match(ok.page.text, /- one/);
    assert.doesNotMatch(ok.page.text, /x\(\)/);
  }
  assert.deepEqual(await runnersMod.directFetch("https://a.com", { maxChars: 10 }, { fetchPublic: page("challenge", { status: 200, headers: { "cf-mitigated": "challenge" } }) }), { error: "url_not_accessible" });
  assert.deepEqual(await runnersMod.directFetch("https://a.com", { maxChars: 10 }, { fetchPublic: page("%PDF", { headers: { "content-type": "application/pdf" } }) }), { error: "unsupported_content_type" });
});

// ------------------------------------------------------------ through the door

// ------------------------------------------------------------ Codex review, 25 Nov 2026

test("an inline server tool added mid-conversation is refused; a client one passes", () => {
  const withAddition = (tool: Json) => ({ tools: [{ name: "x", input_schema: {} }], messages: [{ role: "user", content: "hi" }, { role: "system", content: [{ type: "tool_addition", tool }] }] });
  assert.throws(() => st.serverToolsOf(withAddition({ type: "tool_definition", tool: { type: "web_search_20250305", name: "web_search" } })), /mid-conversation/);
  assert.throws(() => st.serverToolsOf(withAddition({ type: "web_fetch_20250910", name: "web_fetch" })), /mid-conversation/);
  assert.equal(st.serverToolsOf(withAddition({ type: "tool_definition", tool: { name: "mine", input_schema: {} } })), null);
  assert.throws(() => st.serverToolsOf(withAddition({ type: "mcp_toolset", mcp_server_name: "x" })), /mid-conversation/, "an undated provider-run tool too");
  assert.throws(() => st.serverToolsOf({ tools: [], mcp_servers: [{ type: "url", url: "https://m.example/mcp", name: "m" }], messages: [] }), /mcp_servers/);
  assert.throws(() => st.serverToolsOf({ tools: [{ type: "mcp_toolset", mcp_server_name: "m" }] }), /not offered/);
});

test("fetch may follow a URL from the user, a tool result, search results or a fetched page — never one only the model wrote", () => {
  const urls = st.urlsInConversation([
    { role: "user", content: "see https://user.com/a" },
    { role: "assistant", content: [{ type: "text", text: "maybe https://model.com/leak?d=secret" }, { type: "tool_use", id: "t", name: "x", input: { url: "https://model.com/in" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "got https://tool.com/b" }] },
  ]);
  assert.deepEqual([...urls].sort(), ["https://tool.com/b", "https://user.com/a"]);
});

test("a domain rule with a path holds the path; a redirect off the allowed list is refused", async () => {
  assert.ok(st.domainMatches("https://example.com/docs/x", "example.com/docs"));
  assert.ok(!st.domainMatches("https://example.com/blog", "example.com/docs"));
  assert.ok(!st.domainMatches("https://example.com/docsx", "example.com/docs"));
  assert.ok(st.domainMatches("https://example.com/news/articles/1", "example.com/*/articles"), "* in the path");
  assert.ok(!st.domainMatches("https://example.com/Docs/x", "example.com/docs"), "the path as written");
  assert.ok(st.domainMatches("https://EXAMPLE.com/", "example.com"));
  assert.ok(!st.domainAllowed("https://example.com./x", { blocked_domains: ["example.com"] }), "a trailing dot is the same name");
  assert.ok(!st.domainMatches("https://example.com/docs/x", "example.com/docs", "fetch"), "fetch: an entry with a path never matches");
  assert.ok(st.domainAllowed("https://example.com/docs/x", { blocked_domains: ["example.com/docs"] }, "fetch"));
  assert.throws(() => st.serverToolsOf({ tools: [{ ...SEARCH, allowed_domains: ["*.example.com"] }] }), /not valid/);
  assert.throws(() => st.serverToolsOf({ tools: [{ ...SEARCH, allowed_domains: ["https://example.com"] }] }), /not valid/);
  const hops: string[] = [];
  const fp = (async (u: string) => {
    hops.push(u);
    return u.includes("allowed.com") ? new Response(null, { status: 302, headers: { location: "https://other.com/x" } }) : new Response("secret", { headers: { "content-type": "text/plain" } });
  }) as unknown as typeof import("../src/ssrf.ts").fetchPublic;
  const r = await runnersMod.directFetch("https://allowed.com/a", { maxChars: 100, allow: (u) => st.domainAllowed(u, { allowed_domains: ["allowed.com"] }) }, { fetchPublic: fp });
  assert.deepEqual(r, { error: "url_not_allowed" });
  assert.deepEqual(hops, ["https://allowed.com/a"], "the excluded site was never asked");
});

test("a forced tool_choice decides the first round only", async () => {
  const body = { model: "m", max_tokens: 100, tools: [SEARCH], tool_choice: { type: "tool", name: "web_search" }, messages: [{ role: "user", content: "go" }] };
  const sent: Json[] = [];
  const answers = [reply([{ type: "tool_use", id: "a", name: "web_search", input: { query: "q" } }], "tool_use"), reply([{ type: "text", text: "ok" }], "end_turn")];
  await st.runServerToolLoop(body, st.serverToolsOf(body)!, async (b) => (sent.push(b), answers.shift()!), fakeRunners());
  assert.deepEqual(sent[0]!.tool_choice, { type: "tool", name: "web_search" });
  assert.deepEqual(sent[1]!.tool_choice, { type: "auto" });
});

test("max_uses counts the searches already made in the turn being continued", async () => {
  const prior = { role: "assistant", content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "1" } }, { type: "web_search_tool_result", tool_use_id: "s1", content: [] }] };
  const body = { model: "m", max_tokens: 100, tools: [{ ...SEARCH, max_uses: 1 }], messages: [{ role: "user", content: "go" }, prior] };
  assert.deepEqual(st.priorUses(body.messages as never), { search: 1, fetch: 0 });
  const log: string[] = [];
  const answers = [reply([{ type: "tool_use", id: "b", name: "web_search", input: { query: "2" } }], "tool_use"), reply([{ type: "text", text: "ok" }], "end_turn")];
  const r = await st.runServerToolLoop(body, st.serverToolsOf(body)!, async () => answers.shift()!, fakeRunners(log));
  const res = ((r.body as Json).content as Json[]).find((b) => b.type === "web_search_tool_result")!;
  assert.equal((res.content as Json).error_code, "max_uses_exceeded");
  assert.deepEqual(log, []);
});

test("error blocks use the SDK's names; a changed encrypted_content is refused", async () => {
  const body = { model: "m", max_tokens: 100, tools: [FETCH], messages: [{ role: "user", content: "go" }] };
  const answers = [reply([{ type: "tool_use", id: "a", name: "web_fetch", input: { url: "nope" } }], "tool_use"), reply([{ type: "text", text: "ok" }], "end_turn")];
  const r = await st.runServerToolLoop(body, st.serverToolsOf(body)!, async () => answers.shift()!, fakeRunners());
  const res = ((r.body as Json).content as Json[]).find((b) => b.type === "web_fetch_tool_result")!;
  assert.deepEqual(res.content, { type: "web_fetch_tool_result_error", error_code: "invalid_tool_input" });
  assert.deepEqual(r.ran, { search: 0, fetch: 0 }, "a refused call is not counted for the meter");
  const forged = Buffer.from(JSON.stringify({ v: 1, t: "other text", m: "x" })).toString("base64");
  assert.throws(() => st.lowerMessages([{ role: "user", content: "q" }, { role: "assistant", content: [{ type: "server_tool_use", id: "s", name: "web_search", input: {} }, { type: "web_search_tool_result", tool_use_id: "s", content: [{ type: "web_search_result", url: "https://a.com", title: "A", encrypted_content: forged }] }] }]), /changed/);
});

test("a character cut between two network chunks reaches the caller whole", async () => {
  const bytes = Buffer.from(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "سلام ✓" } })}\n\n`);
  const cut = bytes.indexOf(Buffer.from("✓")) + 1;
  async function* two() {
    yield bytes.subarray(0, cut);
    yield bytes.subarray(cut);
  }
  const got: SseEventLike[] = [];
  for await (const e of st.sseEvents(two())) got.push(e);
  assert.equal(((got[0]!.data.delta as Json).text), "سلام ✓");
});
type SseEventLike = { event: string; data: Json };

test("a URL with a credential is fetched only when a person wrote that credential", async () => {
  assert.deepEqual(st.credentialsIn("https://a.com/x?api_key=abc123&page=2"), ["abc123"]);
  assert.deepEqual(st.credentialsIn("https://u:pw@a.com/"), ["pw"]);
  const run = async (system: string) => {
    const body = { model: "m", max_tokens: 100, system, tools: [FETCH], messages: [{ role: "user", content: "go" }, { role: "assistant", content: [{ type: "tool_use", id: "c", name: "mine", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: "here: https://a.com/x?token=s3cr3t" }] }] };
    const answers = [reply([{ type: "tool_use", id: "f", name: "web_fetch", input: { url: "https://a.com/x?token=s3cr3t" } }], "tool_use"), reply([{ type: "text", text: "ok" }], "end_turn")];
    const r = await st.runServerToolLoop(body, st.serverToolsOf(body)!, async () => answers.shift()!, fakeRunners());
    const res = ((r.body as Json).content as Json[]).find((b) => b.type === "web_fetch_tool_result")!;
    return (res.content as Json).error_code ?? "ok";
  };
  assert.equal(await run("you help"), "url_not_allowed", "a credential only in a tool result does not count");
  assert.equal(await run("the token is s3cr3t"), "ok");
});

test("our public id reads back to the provider's; Anthropic's own srvtoolu_ ids pass through", () => {
  const pub = st.publicId("call_abc");
  assert.match(pub, /^srvtoolu_/);
  assert.equal(st.providerId(pub), "call_abc");
  assert.equal(st.providerId("srvtoolu_01A2B3C4D5E6F7G8H9"), "srvtoolu_01A2B3C4D5E6F7G8H9");
  const low = st.lowerMessages([{ role: "user", content: "q" }, { role: "assistant", content: [{ type: "server_tool_use", id: pub, name: "web_search", input: {} }, { type: "web_search_tool_result", tool_use_id: pub, content: [] }] }]);
  assert.equal((low[1]!.content as Json[])[0]!.id, "call_abc");
  assert.equal((low[2]!.content as Json[])[0]!.tool_use_id, "call_abc");
});

test("a client call before a search, text after it: on replay the client call ends the assistant turn, its result right after", () => {
  const low = st.lowerMessages([
    { role: "user", content: "go" },
    { role: "assistant", content: [
      { type: "tool_use", id: "c1", name: "mine", input: {} },
      { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" } },
      { type: "web_search_tool_result", tool_use_id: "s1", content: [] },
      { type: "text", text: "and now yours" },
    ] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "done" }] },
  ]);
  assert.deepEqual(low.map((m) => m.role), ["user", "assistant", "user", "assistant", "user"]);
  const last = low[3]!.content as Json[];
  assert.deepEqual(last.map((b) => b.type), ["text", "tool_use"]);
  assert.equal((low[4]!.content as Json[])[0]!.tool_use_id, "c1");
});

const door = await import("../src/gateway-door.ts");
door.setGatewayAccountRouteForTests((_t, want) => (want ? { kind: "supply", provider: want.provider } : { kind: "operator" }));
const gw = await import("../src/model-gateway.ts");
const usage = await import("../src/model-usage.ts");
const { setSupplyLeversForTest } = await import("../src/settings.ts");
type ApiKeyRow = NonNullable<Awaited<ReturnType<typeof import("../src/api-keys-db.ts").findApiKeyByHashDb>>>;
const sha = (k: string) => crypto.createHash("sha256").update(k).digest("hex");
const PRICE = { version: 7, inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75, maxOutputTokens: 8000 };
const row: ApiKeyRow = { id: "k1", hash: sha("mda_good"), prefix: "mda_abcdef12", label: "cc", tenant: "acme", createdAt: new Date().toISOString(), revokedAt: null, role: "viewer", workspaces: null, purpose: "gateway", gateway: { capUsd: 5, dailyUsd: null } } as ApiKeyRow;

test("end to end on a metered key: the provider sees a plain tool twice, the caller gets server blocks, both rounds are metered", async () => {
  const seen: Json[] = [];
  const up = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c: Buffer) => (b += c));
    req.on("end", () => {
      const j = JSON.parse(b) as Json;
      seen.push(j);
      const first = seen.length % 2 === 1;
      if (j.stream !== true) {
        res.writeHead(200, { "content-type": "application/json", "request-id": "req_up" });
        return void res.end(JSON.stringify(first
          ? { id: "m1", type: "message", role: "assistant", model: "claude-x", content: [{ type: "tool_use", id: "toolu_9", name: "web_search", input: { query: "news" } }], stop_reason: "tool_use", usage: { input_tokens: 1000, output_tokens: 2000 } }
          : { id: "m2", type: "message", role: "assistant", model: "claude-x", content: [{ type: "text", text: "Here is the news." }], stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 2000 } }));
      }
      res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_up" });
      res.end(sse(first
        ? [["message_start", { message: { id: "m1", type: "message", role: "assistant", model: "claude-x", content: [], usage: { input_tokens: 1000, output_tokens: 1 } } }], ["content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_9", name: "web_search", input: {} } }], ["content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"news"}' } }], ["content_block_stop", { index: 0 }], ["message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2000 } }], ["message_stop", {}]]
        : [["message_start", { message: { id: "m2", type: "message", role: "assistant", model: "claude-x", content: [], usage: { input_tokens: 1000, output_tokens: 1 } } }], ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }], ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "Here is the news." } }], ["content_block_stop", { index: 0 }], ["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2000 } }], ["message_stop", {}]]));
    });
  });
  await new Promise<void>((r) => up.listen(0, "127.0.0.1", () => r()));
  const host = `127.0.0.1:${(up.address() as { port: number }).port}`;
  const d = await door.startGatewayDoor(0);
  usage.resetModelUsageForTests();
  setSupplyLeversForTest([], {});
  process.env.FOLDRUN_MODEL_SUPPLY = "1";
  gw.setGatewayDepsForTests({ price: (p, m) => (p === "anthropic" && m === "claude-x" ? PRICE : null), balance: async () => 10, key: () => "real-anthropic-key-0000", host: () => host, plainHttp: () => true });
  door.setGatewayKeyLookupForTests(async (h) => (h === row.hash ? row : null));
  door.setGatewayTouchForTests(async () => {});
  door.setServerToolRunnersForTests(() => fakeRunners());
  try {
    const url = `http://127.0.0.1:${d.port}`;
    const post = (body: Json) => fetch(`${url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "user-agent": "claude-cli/2.1.3 (external, cli)", "x-api-key": "mda_good" }, body: JSON.stringify(body) });

    // Non-streaming.
    const res = await post({ model: "claude-x", max_tokens: 4000, tools: [SEARCH], messages: [{ role: "user", content: "news?" }] });
    assert.equal(res.status, 200);
    const msg = (await res.json()) as Json;
    assert.deepEqual((msg.content as Json[]).map((b) => b.type), ["server_tool_use", "web_search_tool_result", "text"]);
    assert.deepEqual((msg.usage as Json).server_tool_use, { web_search_requests: 1, web_fetch_requests: 0 });
    assert.equal(seen.length, 2);
    for (const s of seen) {
      assert.doesNotMatch(JSON.stringify(s), /web_search_20250305|server_tool_use|web_search_tool_result/, "no server tool reached the provider");
      assert.equal((s.tools as Json[])[0]!.type, undefined);
    }
    // Each round is a metered model call, and the search it ran is charged at the operator's price (0 without billing).
    const searchUsd = (await import("../src/billing.ts")).billing().toolPrice?.("web_search") ?? 0;
    assert.equal(await usage.spentByJob("acme", "gateway:k1"), Number((2 * (1000 * 3 + 2000 * 15) / 1e6 + searchUsd).toFixed(6)), "each round is a metered model call, the search one call at its price");

    // Streaming.
    seen.length = 0;
    const s = await post({ model: "claude-x", max_tokens: 4000, stream: true, tools: [SEARCH], messages: [{ role: "user", content: "news?" }] });
    assert.equal(s.status, 200);
    assert.match(s.headers.get("content-type") ?? "", /event-stream/);
    const text = await s.text();
    assert.match(text, /"server_tool_use"/);
    assert.match(text, /web_search_tool_result/);
    assert.match(text, /Here is the news\./);
    assert.equal((text.match(/event: message_stop/g) ?? []).length, 1);

    // A server tool foldrun does not run: refused, never sent.
    seen.length = 0;
    const refused = await post({ model: "claude-x", max_tokens: 10, tools: [{ type: "code_execution_20250522", name: "code_execution" }], messages: [{ role: "user", content: "x" }] });
    assert.equal(refused.status, 400);
    assert.equal(((await refused.json()) as { error: { code: string } }).error.code, "server_tool_not_offered");
    assert.equal(seen.length, 0);

    // A changed encrypted_content is the caller's 400, before any model call.
    const forged = Buffer.from(JSON.stringify({ v: 1, t: "other", m: "x" })).toString("base64");
    const bad = await post({ model: "claude-x", max_tokens: 10, tools: [SEARCH], messages: [{ role: "user", content: "q" }, { role: "assistant", content: [{ type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} }, { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: "https://a.com", title: "A", encrypted_content: forged }] }] }, { role: "user", content: "and?" }] });
    assert.equal(bad.status, 400);
    assert.equal(seen.length, 0);

    // A call without server tools is served as before.
    const plain = await post({ model: "claude-x", max_tokens: 10, messages: [{ role: "user", content: "no tools" }], stream: true });
    assert.equal(plain.status, 200, "a call without server tools is served as before");
    await plain.text();
  } finally {
    door.setServerToolRunnersForTests(null);
    door.setGatewayTouchForTests(null);
    door.setGatewayKeyLookupForTests(null);
    gw.setGatewayDepsForTests(null);
    await d.close();
    up.close();
  }
});

// ------------------------------------------------------------ the account's own engine (SearXNG rung)

test("SearXNG: only the loaded door engines answer; a refused query, a domain list, a country, a foreign engine or a slow pod moves to the next rung", async () => {
  runnersMod.resetSearxngForTests();
  const config = { status: 200, body: JSON.stringify({ engines: [{ name: "brave" }, { name: "wikipedia" }, { name: "google" }, { name: "yandex", enabled: false }] }) };
  const asked: string[] = [];
  const get = (search: unknown) => async (u: string) => (asked.push(u), u.endsWith("/config") ? config : { status: 200, body: JSON.stringify(search) });
  const ok = await runnersMod.searxngSearch("acme", { query: "node lts" }, {
    url: (seg) => `http://search-${seg}:8080`,
    get: get({ results: [{ url: "https://nodejs.org/en", title: "Node", content: "LTS 24", engine: "brave", engines: ["brave"] }, { url: "https://nodejs.org/en", title: "dup", engine: "brave" }, { url: "javascript:x", engine: "brave" }] }),
  });
  assert.deepEqual(ok, { results: [{ url: "https://nodejs.org/en", title: "Node", snippet: "LTS 24", page_age: null }], via: "searxng" });
  const search = new URL(asked.find((u) => u.includes("/search?"))!).searchParams;
  assert.equal(search.get("format"), "json");
  assert.deepEqual(search.get("engines")!.split(",").sort(), ["brave", "wikipedia"], "the door's engines the pod has loaded, never google or a disabled one");
  asked.length = 0;
  await runnersMod.searxngSearch("acme", { query: "again" }, { url: (seg) => `http://search-${seg}:8080`, get: get({ results: [{ url: "https://a.com", engine: "brave" }] }) });
  assert.ok(!asked.some((u) => u.endsWith("/config")), "the loaded engines are remembered");
  let called = false;
  const never = async () => ((called = true), config);
  for (const q of [{ query: "!g bang" }, { query: "see https://x.com/a" }, { query: "q", allowed_domains: ["a.com"] }, { query: "q", blocked_domains: ["a.com"] }, { query: "q", user_location: { country: "AU" } }]) {
    assert.equal(await runnersMod.searxngSearch("acme", q, { get: q.query === "q" ? never : get({ results: [] }) }), null, JSON.stringify(q));
  }
  assert.equal(called, false, "options SearXNG cannot honour never reach it");
  assert.equal(await runnersMod.searxngSearch("acme", { query: "q" }, { get: get({ results: [{ url: "https://a.com", engine: "google" }] }) }), null, "an engine outside the door's list");
  assert.equal(await runnersMod.searxngSearch("acme", { query: "q" }, { get: get({ results: [] }) }), null, "nothing found");
  assert.equal(await runnersMod.searxngSearch("acme", { query: "q" }, { get: async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); } }), null, "no pod up");
  runnersMod.resetSearxngForTests();
  let aborted = false;
  const slow = (_u: string, o?: { signal?: AbortSignal }) => new Promise<{ status: number; body: string }>((_r, rej) => o?.signal?.addEventListener("abort", () => ((aborted = true), rej(new Error("aborted")))));
  const t0 = Date.now();
  assert.equal(await runnersMod.searxngSearch("acme", { query: "q" }, { get: slow, waitMs: 50 }), null, "a slow pod: SerpApi answers now");
  assert.ok(Date.now() - t0 < 400);
  assert.equal(aborted, true, "the request is aborted at the deadline, not left running");
});

test("the account's search pod admits the gateway; a browser pod does not", async () => {
  const sk = await import("../src/search-k8s.ts");
  const bk = await import("../src/browser-k8s.ts");
  assert.match(JSON.stringify(sk.searchPolicyManifests("acme")), /foldrun-gateway/);
  assert.doesNotMatch(JSON.stringify(bk.browserPolicyManifests("acme")), /foldrun-gateway/);
});

test("the runners: SerpApi when the own engine is off; the own engine needs the audited image", async () => {
  const r = runnersMod.platformRunners("acme");
  const saved = process.env.SERPAPI_API_KEY;
  delete process.env.SERPAPI_API_KEY;
  try {
    assert.deepEqual(await r.search({ query: "q" }, {}), { error: "unavailable" });
  } finally {
    if (saved !== undefined) process.env.SERPAPI_API_KEY = saved;
  }
  assert.equal(runnersMod.searxngEnabled({ FOLDRUN_SEARCH_PER_ACCOUNT: "1" } as NodeJS.ProcessEnv), true);
  assert.equal(runnersMod.searxngEnabled({ FOLDRUN_SEARCH_PER_ACCOUNT: "1", FOLDRUN_SEARCH_IMAGE: "docker.io/searxng/searxng:latest" } as NodeJS.ProcessEnv), false, "an image the door's engines were not checked in");
  assert.equal(runnersMod.searxngEnabled({} as NodeJS.ProcessEnv), false);
});

test("the SearXNG deadline setting: a bad value is the default, never a thrown timeout", () => {
  for (const bad of [undefined, "", "-5", "1.5", "abc", "50", "999999"]) assert.equal(runnersMod.waitSetting(bad), 4000, String(bad));
  assert.equal(runnersMod.waitSetting("2500"), 2500);
});

// ------------------------------------------------------------ tool prices (the console's pricing.tool_*)

test("priced runners: each call held before it runs as the round was metered, charged only when it worked; a refused call answers unavailable and never runs", async () => {
  const calls: string[] = [];
  const inner: import("../src/server-tools.ts").ToolRunners = {
    search: async (q) => (calls.push(`search:${q.query}`), q.query === "bad" ? { error: "unavailable" } : { results: [], via: "fake" }),
    fetchPage: async (u) => (calls.push(`fetch:${u}`), { page: { url: u, title: "", text: "", media_type: "text/plain" } as never, via: "fake" }),
  };
  const held: { tool: string; closed?: boolean; provider: string; who: unknown }[] = [];
  let refuse = false;
  const hold = (async (who: unknown, tool: string, provider: string) => {
    if (refuse) return { ok: false, message: "cap" };
    const h: { tool: string; closed?: boolean; provider: string; who: unknown } = { tool, provider, who };
    held.push(h);
    return { ok: true, close: async (ok: boolean) => void (h.closed = ok) };
  }) as never;
  let payer: { who: import("../src/model-gateway.ts").CallWho; provider: "anthropic" } | null = null;
  const r = door.pricedRunners(inner, () => payer, hold);
  // No round reached the meter yet: nothing to charge to, the call runs.
  await r.search({ query: "first" }, {});
  assert.equal(held.length, 0);
  payer = { who: { tenant: "acme", kind: "coding", planCover: false }, provider: "anthropic" };
  await r.search({ query: "ok" }, {});
  await r.search({ query: "bad" }, {});
  await r.fetchPage("https://a.com", { maxChars: 10, allow: () => true });
  assert.deepEqual(held.map((h) => [h.tool, h.closed]), [["web_search", true], ["web_search", false], ["web_fetch", true]], "a failed search is free");
  assert.deepEqual(held[0]!.who, payer.who, "the round's payer");
  assert.equal(held[0]!.provider, "anthropic");
  refuse = true;
  calls.length = 0;
  assert.deepEqual(await r.search({ query: "x" }, {}), { error: "unavailable" });
  assert.deepEqual(await r.fetchPage("https://b.com", { maxChars: 10, allow: () => true }), { error: "unavailable" });
  assert.deepEqual(calls, [], "a call the meter refuses never runs");
});

test("holdToolCall: through admitCall at a fixed price — a row at the operator's price, margin 1, charged on success, free on failure; the wallet's rule; no price, no row", async () => {
  const { billing } = await import("../src/billing.ts");
  const b = billing() as { toolPrice?: (t: string) => number };
  const saved = b.toolPrice;
  usage.resetModelUsageForTests();
  setSupplyLeversForTest([], {});
  process.env.FOLDRUN_MODEL_SUPPLY = "1";
  let balance = 10;
  gw.setGatewayDepsForTests({ balance: async () => balance, key: () => "real-anthropic-key-0000" });
  const who = { tenant: "acme", kind: "coding" as const, job: "gateway:k9" };
  const day = new Date().toISOString().slice(0, 10);
  const toolRows = async () => (await usage.callsInDays("acme", day, day)).filter((r) => r.provider === "foldrun");
  try {
    b.toolPrice = () => 0;
    const free = await gw.holdToolCall(who, "web_search", "anthropic");
    assert.ok(free.ok);
    await (free as { close: (ok: boolean) => Promise<void> }).close(true);
    assert.deepEqual(await toolRows(), [], "price 0: nothing recorded");

    b.toolPrice = (t) => (t === "web_search" ? 0.02 : 0.005);
    const a = await gw.holdToolCall(who, "web_search", "anthropic");
    const f = await gw.holdToolCall(who, "web_fetch", "anthropic");
    const failed = await gw.holdToolCall(who, "web_search", "anthropic");
    for (const [h, ok] of [[a, true], [f, true], [failed, false]] as const) {
      assert.ok(h.ok, JSON.stringify(h));
      await (h as { close: (ok: boolean) => Promise<void> }).close(ok);
    }
    assert.deepEqual((await toolRows()).map((r) => [r.model, r.costUsd, r.margin, r.status, r.priceVersion]).sort(), [
      ["tool:web_fetch", 0.005, 1, "closed", 0],
      ["tool:web_search", 0, 1, "closed", 0],
      ["tool:web_search", 0.02, 1, "closed", 0],
    ]);
    assert.equal(await usage.spentByJob("acme", "gateway:k9"), 0.025, "the key's spend counts the tools that worked");
    // No bought credit: refused, as a model call would be.
    balance = 0;
    const broke = await gw.holdToolCall(who, "web_search", "anthropic");
    assert.equal(broke.ok, false);
  } finally {
    b.toolPrice = saved;
    gw.setGatewayDepsForTests(null);
  }
});

test("a login round's tools: the account's plan may pay (no planCover: false), never a run's finish grace (optInOnly)", () => {
  const who = door.loginTools({ tenant: "acme", kind: "coding", job: "gateway:k1", planCover: false, jobLimits: { capUsd: 5, dailyUsd: null } });
  assert.deepEqual(who, { tenant: "acme", kind: "coding", job: "gateway:k1", jobLimits: { capUsd: 5, dailyUsd: null }, optInOnly: true });
});
