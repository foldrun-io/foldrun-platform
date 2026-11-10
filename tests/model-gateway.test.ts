// The model gateway: every call on one of the platform's model keys
// ("foldrun's models") is checked and metered in the egress proxy, whoever
// sends it — the SDK, a translator, or a script's own curl. The pure rules,
// then real leases against fake upstreams in both wire formats.
//
//   node --test tests/model-gateway.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-gateway-"));
process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE = "1";
delete process.env.FOLDRUN_DATABASE_URL;

const { egressHooks, startEgressProxy, stopEgressProxy } = await import("../src/egress-proxy.ts");
const gw = await import("../src/model-gateway.ts");
const usage = await import("../src/model-usage.ts");
const { setSupplyLeversForTest } = await import("../src/settings.ts");
const { addSupplyGrant, addGrant } = await import("../../foldrun-core/src/egress.ts");
const { SUPPLY_PROVIDERS, SUPPLY_KEY_NAME } = await import("../../foldrun-core/src/model-supply.ts");
type EgressGrant = import("../../foldrun-core/src/egress.ts").EgressGrant;
type ModelPrice = import("../src/model-gateway.ts").ModelPrice;

const PRICE: ModelPrice = { version: 7, inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75, maxOutputTokens: 8000 };
const OAI_PRICE: ModelPrice = { version: 7, inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: null, cacheWritePerMTok: null, maxOutputTokens: 4000 };
const PH = `\${${SUPPLY_KEY_NAME}}`;

// ------------------------------------------------------------ pure rules

/** OpenAI's Chat Completions shape — the format Gemini is reached in; OpenAI
 *  itself is reached over Responses (3 Nov 2026). */
const OAI_CHAT = { ...SUPPLY_PROVIDERS.openai, format: "openai" as const, metered: ["/v1/chat/completions"] };

test("only the provider's model routes are metered, a few free ones pass, the rest are refused", () => {
  const a = SUPPLY_PROVIDERS.anthropic;
  assert.equal(gw.routeRule(a, "POST", "/v1/messages"), "metered");
  assert.equal(gw.routeRule(a, "POST", "/v1/messages/count_tokens"), "free");
  assert.equal(gw.routeRule(a, "GET", "/v1/models"), "free");
  assert.equal(gw.routeRule(a, "GET", "/v1/messages"), null);
  assert.equal(gw.routeRule(a, "POST", "/v1/messages/batches"), null, "a batch would bill outside any call");
  assert.equal(gw.routeRule(a, "POST", "/v1/files"), null);
  assert.equal(gw.routeRule(SUPPLY_PROVIDERS.openai, "POST", "/v1/responses"), "metered");
  assert.equal(gw.routeRule(SUPPLY_PROVIDERS.openai, "POST", "/v1/chat/completions"), null, "GPT-6 calls tools on Responses alone");
  assert.equal(gw.routeRule(SUPPLY_PROVIDERS.gemini, "POST", "/v1beta/openai/chat/completions"), "metered");
  assert.equal(gw.routeRule(SUPPLY_PROVIDERS.deepseek, "POST", "/anthropic/v1/messages"), "metered");
  assert.equal(gw.routeRule(SUPPLY_PROVIDERS.moonshot, "POST", "/anthropic/v1/messages"), "metered");
  assert.notEqual(gw.routeRule(SUPPLY_PROVIDERS.deepseek, "POST", "/v1/chat/completions"), "metered", "only the route the price list prices");
});

test("the key may sit only in the provider's auth header, whole", () => {
  const a = SUPPLY_PROVIDERS.anthropic;
  const o = SUPPLY_PROVIDERS.openai;
  assert.equal(gw.placementProblem(a, SUPPLY_KEY_NAME, { "x-api-key": PH }), null);
  assert.match(gw.placementProblem(a, SUPPLY_KEY_NAME, { authorization: `Bearer ${PH}` })!, /x-api-key/);
  assert.match(gw.placementProblem(a, SUPPLY_KEY_NAME, { "x-api-key": PH, "x-echo": PH })!, /not in x-echo/, "a second copy in a header the far end may echo");
  assert.match(gw.placementProblem(a, SUPPLY_KEY_NAME, { "x-api-key": `${PH}x` })!, /not in x-api-key/);
  assert.equal(gw.placementProblem(o, SUPPLY_KEY_NAME, { authorization: `Bearer ${PH}` }), null);
  assert.match(gw.placementProblem(o, SUPPLY_KEY_NAME, { authorization: `Basic ${PH}` })!, /authorization/);
  assert.match(gw.placementProblem(o, SUPPLY_KEY_NAME, {})!, /not sent/);
});

test("an OpenAI stream is made to report its usage; the body's model and ceiling are read", () => {
  const o = OAI_CHAT;
  const r = gw.readCall(o, Buffer.from(JSON.stringify({ model: "gpt-x", stream: true, max_completion_tokens: 900, messages: [] })));
  assert.ok(!("status" in r));
  assert.equal(r.model, "gpt-x");
  assert.equal(r.maxTokens, 900);
  assert.deepEqual(JSON.parse(r.body.toString()).stream_options, { include_usage: true });
  const bad = gw.readCall(o, Buffer.from("not json"));
  assert.ok("status" in bad && bad.status === 400);
  const none = gw.readCall(o, Buffer.from("{}"));
  assert.ok("status" in none && /no model/.test(none.message));
});

test("the output limit sent is the one held; n > 1 is refused (Codex review)", () => {
  const o = OAI_CHAT;
  const a = SUPPLY_PROVIDERS.anthropic;
  const ceil = () => 4000;
  const big = gw.readCall(a, Buffer.from(JSON.stringify({ model: "m", max_tokens: 64000 })), ceil);
  assert.ok(!("status" in big));
  assert.equal(big.maxTokens, 4000);
  assert.equal(JSON.parse(big.body.toString()).max_tokens, 4000, "clamped in what is sent");
  const none = gw.readCall(o, Buffer.from(JSON.stringify({ model: "m" })), ceil);
  assert.ok(!("status" in none));
  assert.equal(JSON.parse(none.body.toString()).max_completion_tokens, 4000, "no limit on OpenAI's format → the ceiling is set");
  const legacy = gw.readCall(o, Buffer.from(JSON.stringify({ model: "m", max_tokens: 99999 })), ceil);
  assert.ok(!("status" in legacy));
  assert.equal(JSON.parse(legacy.body.toString()).max_tokens, 4000, "the field the request used is the one clamped");
  const small = Buffer.from(JSON.stringify({ model: "m", max_tokens: 100 }));
  const kept = gw.readCall(a, small, ceil);
  assert.ok(!("status" in kept));
  assert.equal(JSON.parse(kept.body.toString()).max_tokens, 100, "a limit inside the ceiling is left as it came");
  const many = gw.readCall(o, Buffer.from(JSON.stringify({ model: "m", n: 3 })), ceil);
  assert.ok("status" in many && many.status === 400);
});

test("anything billed outside tokens is refused until it has a price (Codex review)", () => {
  const a = SUPPLY_PROVIDERS.anthropic;
  const o = OAI_CHAT;
  const r = SUPPLY_PROVIDERS.deepseek;
  const call = (p: typeof a, body: object) => gw.readCall(p, Buffer.from(JSON.stringify({ model: "m", ...body })));
  const refused = (x: ReturnType<typeof call>) => "status" in x && x.status === 400;
  assert.ok(!refused(call(a, { tools: [{ name: "Read", input_schema: {} }, { type: "bash_20250124", name: "bash" }] })), "client tools pass");
  assert.ok(refused(call(a, { tools: [{ type: "web_search_20250305", name: "web_search" }] })));
  assert.ok(refused(call(a, { tools: [{ type: "code_execution_20250825", name: "x" }] })));
  assert.ok(refused(call(a, { mcp_servers: [] })));
  assert.ok(!refused(call(o, { tools: [{ type: "function", function: { name: "f" } }] })));
  assert.ok(refused(call(o, { web_search_options: {} })));
  assert.ok(refused(call(r, { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }] })), "DeepSeek's paid web search");
  assert.ok(refused(call(r, { plugins: [{ id: "web" }] })), "a field nobody listed");
  // An allowlist of fields: a priced option nobody listed is refused by name.
  assert.ok(refused(call(o, { service_tier: "priority" })));
  const auto = call(o, { service_tier: "auto" });
  assert.ok(!("status" in auto) && JSON.parse(auto.body.toString()).service_tier === "default", "auto is sent as default");
  assert.ok(refused(call(o, { modalities: ["text", "audio"], audio: { voice: "x" } })));
  assert.ok(refused(call(o, { messages: [{ role: "user", content: [{ type: "input_audio", input_audio: {} }] }] })));
  assert.ok(!refused(call(o, { messages: [{ role: "user", content: [{ type: "text", text: "x" }, { type: "image_url", image_url: { url: "u" } }] }] })));
  assert.ok(refused(call(r, { models: ["a", "b"] })), "a fallback list would price other models");
  assert.ok(refused(call(a, { service_tier: "auto" })), "auto may land on a dearer tier");
  // The standard tier said outright; media by URL held or refused.
  const std = call(a, {});
  assert.ok(!("status" in std) && JSON.parse(std.body.toString()).service_tier === "standard_only");
  const img = call(o, { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] }] });
  assert.ok(!("status" in img) && img.mediaTokens === gw.MEDIA_URL_TOKENS);
  const inline = call(o, { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }] });
  assert.ok(!("status" in inline) && inline.mediaTokens === 0, "inline media is in the body's size already");
  assert.ok(refused(call(a, { messages: [{ role: "user", content: [{ type: "document", source: { type: "url", url: "https://x/a.pdf" } }] }] })));
  const nested = call(a, { messages: [{ role: "user", content: [{ type: "tool_result", content: [{ type: "image", source: { type: "url", url: "https://x" } }] }] }] });
  assert.ok(!("status" in nested) && nested.mediaTokens === gw.MEDIA_URL_TOKENS);
  const named = call(o, { store: true });
  assert.ok("status" in named && /request field store/.test(named.message));
});

test("a one-hour cache write is refused; a settled call is final (Codex review)", async () => {
  const a = SUPPLY_PROVIDERS.anthropic;
  const long = gw.readCall(a, Buffer.from(JSON.stringify({ model: "m", system: [{ type: "text", text: "x", cache_control: { type: "ephemeral", ttl: "1h" } }] })));
  assert.ok("status" in long && /one-hour/.test(long.message));
  const short = gw.readCall(a, Buffer.from(JSON.stringify({ model: "m", system: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }] })));
  assert.ok(!("status" in short));

  usage.resetModelUsageForTests();
  const held = await usage.reserveCall({ tenant: "t1", kind: "run", runId: "r9", provider: "anthropic", model: "m", estimateUsd: 0.5, priceVersion: 1 }, 0);
  assert.ok(held.ok);
  assert.equal(await usage.markSettled([held.id], "run:r9"), 1);
  await usage.closeCall(held.id, { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.000001 });
  const [row] = await usage.callsOfRun("t1", "r9");
  assert.equal(row.status, "estimated", "frozen at its estimate when it was settled open");
  assert.equal(row.costUsd, 0.5, "a late close does not move what the ledger charged");
  assert.equal(await usage.markSettled([held.id], "run:r9"), 0, "and it is not settled twice");
});

test("a stream that ends without its last word on usage is not trusted (Codex review)", () => {
  const a = new gw.UsageReader("anthropic", "text/event-stream");
  a.feed(Buffer.from(`data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 1 } } })}\n\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error" } })}\n\n`));
  assert.equal(a.result(), null, "no message_delta: the estimate stands");
  // A message_delta that says nothing of output (MiMo documents usage as
  // nullable) is not the last word either: input alone would undercharge.
  const b = new gw.UsageReader("anthropic", "text/event-stream");
  b.feed(Buffer.from(`data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 1 } } })}\n\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: null })}\n\n`));
  assert.equal(b.result(), null, "no output count: the estimate stands");
});

test("usage is read from Anthropic's and OpenAI's replies, streamed or not", () => {
  const sse = (events: object[]) => Buffer.from(events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join(""));
  const a = new gw.UsageReader("anthropic", "text/event-stream; charset=utf-8");
  const stream = sse([
    { type: "message_start", message: { usage: { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 1000, output_tokens: 1 } } },
    { type: "content_block_delta", delta: { text: "hi" } },
    { type: "message_delta", usage: { output_tokens: 400 } },
  ]);
  // Fed in awkward pieces: an event split across chunks still counts.
  for (let i = 0; i < stream.length; i += 7) a.feed(stream.subarray(i, i + 7));
  assert.deepEqual(a.result(), { input: 100, output: 400, cacheWrite: 50, cacheRead: 1000 });

  const j = new gw.UsageReader("anthropic", "application/json");
  j.feed(Buffer.from(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 20 } })));
  assert.deepEqual(j.result(), { input: 10, output: 20, cacheWrite: 0, cacheRead: 0 });

  const o = new gw.UsageReader("openai", "text/event-stream");
  o.feed(Buffer.from(`data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":300,"completion_tokens":50,"prompt_tokens_details":{"cached_tokens":200}}}\n\ndata: [DONE]\n\n`));
  assert.deepEqual(o.result(), { input: 100, output: 50, cacheRead: 200, cacheWrite: 0 }, "cached tokens are part of prompt_tokens");

  const quiet = new gw.UsageReader("openai", "text/event-stream");
  quiet.feed(Buffer.from(`data: {"choices":[{"delta":{"content":"x"}}]}\n\n`));
  assert.equal(quiet.result(), null, "no usage said is no usage — the estimate stands");
});

test("cost and estimate: per million tokens; a missing cache price is never cheaper than input", () => {
  assert.equal(gw.costOf({ input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }, PRICE), 18);
  assert.equal(gw.costOf({ input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 }, OAI_PRICE), 2, "null cache-read price → input price");
  // 3000 bytes → 1000 input tokens at the dearest input price (cache write 3.75), 8000 output at 15.
  assert.equal(Number(gw.estimateOf(3000, null, PRICE).toFixed(6)), Number(((1000 * 3.75 + 8000 * 15) / 1e6).toFixed(6)));
  assert.equal(Number(gw.estimateOf(3000, 100, PRICE).toFixed(6)), Number(((1000 * 3.75 + 100 * 15) / 1e6).toFixed(6)));
  assert.match(gw.priceProblem(SUPPLY_PROVIDERS.anthropic, OAI_PRICE)!, /cache/, "an Anthropic-format model needs its cache prices");
  assert.equal(gw.priceProblem(SUPPLY_PROVIDERS.openai, OAI_PRICE), null);
});

test("a supply grant carries no value and cannot be confused with an ordinary secret", () => {
  const g: EgressGrant = { secrets: {} };
  addSupplyGrant(g, SUPPLY_KEY_NAME, "anthropic", "api.anthropic.com");
  assert.deepEqual(g.secrets[SUPPLY_KEY_NAME], { value: "", hosts: ["api.anthropic.com"], supply: { provider: "anthropic" } });
  assert.throws(() => addGrant(g, SUPPLY_KEY_NAME, "sk-x", "api.anthropic.com"), /platform's model key/);
  const g2: EgressGrant = { secrets: { X: { value: "v", hosts: ["h"] } } };
  assert.throws(() => addSupplyGrant(g2, "X", "anthropic", "h"), /already granted/);
});

// ------------------------------------------------------------ end to end

type Seen = { method: string; path: string; headers: http.IncomingHttpHeaders; body: string };

/** A fake provider: Anthropic SSE on /v1/messages, OpenAI SSE on
 *  /v1/chat/completions (usage only when asked), a hang on /hang. */
function fakeProvider() {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body });
      if (req.url === "/v1/messages") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}\n\n`);
        if (JSON.parse(body).model === "slow") return; // never finishes: the client hangs up
        res.end(`data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 2000 } })}\n\n`);
        return;
      }
      if (req.url === "/v1/responses") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "x" })}\n\n`);
        res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 500, input_tokens_details: { cached_tokens: 100 }, output_tokens: 250 } } })}\n\n`);
        return;
      }
      if (req.url === "/v1/chat/completions" || req.url === "/v1beta/openai/chat/completions") {
        const json = JSON.parse(body);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: {"choices":[{"delta":{"content":"x"}}]}\n\n`);
        if (json.stream_options?.include_usage) res.write(`data: {"choices":[],"usage":{"prompt_tokens":500,"completion_tokens":250}}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise<{ host: string; seen: Seen[]; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ host: `127.0.0.1:${port}`, seen, close: () => server.close() });
    });
  });
}

async function withGateway(
  opts: { provider?: "anthropic" | "openai" | "gemini"; plainHttp?: boolean; price?: (p: string, m: string) => ModelPrice | null; balance?: number | null; denied?: string[]; daily?: Record<string, number> },
  body: (ctx: { url: string; up: { host: string; seen: Seen[] }; lease: { release: () => Promise<void> } }) => Promise<void>,
) {
  const up = await fakeProvider();
  const proxy = await startEgressProxy(0);
  const prev = { url: process.env.FOLDRUN_EGRESS_URL, on: process.env.FOLDRUN_MODEL_SUPPLY };
  process.env.FOLDRUN_EGRESS_URL = `http://127.0.0.1:${proxy.port}`;
  process.env.FOLDRUN_MODEL_SUPPLY = "1";
  usage.resetModelUsageForTests();
  setSupplyLeversForTest(opts.denied ?? [], opts.daily ?? {});
  gw.setGatewayDepsForTests({
    price: (p, m) => (opts.price ? opts.price(p, m) : p === "openai" || p === "gemini" ? OAI_PRICE : PRICE),
    balance: async () => (opts.balance === undefined ? 10 : opts.balance),
    key: (p) => `real-${p}-key-0000`,
    host: () => up.host,
    plainHttp: () => opts.plainHttp ?? true,
  });
  const provider = opts.provider ?? "anthropic";
  const grant: EgressGrant = { secrets: {} };
  addSupplyGrant(grant, SUPPLY_KEY_NAME, provider, up.host);
  const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-1", grant, step: 2 } as Parameters<typeof egressHooks.lease>[0]))!;
  try {
    await body({ url: `${lease.url}/http://${up.host}`, up, lease });
  } finally {
    await lease.release().catch(() => {});
    gw.setGatewayDepsForTests(null);
    if (prev.url === undefined) delete process.env.FOLDRUN_EGRESS_URL;
    else process.env.FOLDRUN_EGRESS_URL = prev.url;
    if (prev.on === undefined) delete process.env.FOLDRUN_MODEL_SUPPLY;
    else process.env.FOLDRUN_MODEL_SUPPLY = prev.on;
    await stopEgressProxy();
    up.close();
  }
}

const anthropicCall = (url: string, model = "claude-x", headers: Record<string, string> = { "x-api-key": PH }) =>
  fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model, max_tokens: 4000, stream: true, messages: [{ role: "user", content: "hi" }] }),
  });

test("a call as a script's own curl would send it is filled, forwarded and metered at the price list", async () => {
  await withGateway({}, async ({ url, up }) => {
    const res = await anthropicCall(url);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /message_delta/, "the reply streamed through untouched");
    assert.equal(up.seen[0].headers["x-api-key"], "real-anthropic-key-0000", "the provider saw the platform's key");
    const rows = await usage.callsOfRun("acme", "run-1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "closed");
    assert.equal(rows[0].step, 2);
    assert.deepEqual(rows[0].tokens, { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0 });
    assert.equal(rows[0].costUsd, Number(((1000 * 3 + 2000 * 15) / 1e6).toFixed(6)));
    assert.equal(rows[0].priceVersion, 7);
  });
});

test("the key put anywhere but the auth header, a route off the list, or an unpriced model: refused, nothing sent", async () => {
  await withGateway({ price: (_p, m) => (m === "claude-x" ? PRICE : null) }, async ({ url, up }) => {
    const echo = await anthropicCall(url, "claude-x", { "x-api-key": PH, "x-debug-echo": PH });
    assert.equal(echo.status, 403);
    const asBearer = await anthropicCall(url, "claude-x", { authorization: `Bearer ${PH}` });
    assert.equal(asBearer.status, 403);
    const batch = await fetch(`${url}/v1/messages/batches`, { method: "POST", headers: { "x-api-key": PH }, body: "{}" });
    assert.equal(batch.status, 403);
    const inUrl = await fetch(`${url}/v1/messages?k=${encodeURIComponent(PH)}`, { method: "POST", headers: { "x-api-key": PH }, body: "{}" });
    assert.equal(inUrl.status, 403);
    const unpriced = await anthropicCall(url, "claude-free-lunch");
    assert.equal(unpriced.status, 402);
    assert.match(await unpriced.text(), /no price/);
    assert.equal(up.seen.length, 0, "nothing reached the provider");
    assert.equal((await usage.callsOfRun("acme", "run-1")).length, 0, "and nothing was held");
  });
});

test("the platform's key never crosses plain http (Codex review)", async () => {
  await withGateway({ plainHttp: false }, async ({ url, up }) => {
    const r = await anthropicCall(url);
    assert.equal(r.status, 403);
    assert.match(await r.text(), /only sent over https/);
    assert.equal(up.seen.length, 0);
  });
});

test("the account must stand: switched off, refused by the operator, or out of credit", async () => {
  await withGateway({ denied: ["acme"] }, async ({ url, up }) => {
    const r = await anthropicCall(url);
    assert.equal(r.status, 403);
    assert.match(await r.text(), /not available to this account/);
    assert.equal(up.seen.length, 0);
  });
  await withGateway({ balance: 0 }, async ({ url }) => {
    const r = await anthropicCall(url);
    assert.equal(r.status, 402);
    assert.match(await r.text(), /out of credits/);
  });
  await withGateway({ balance: null }, async ({ url }) => {
    assert.equal((await anthropicCall(url)).status, 403, "an install that bills nothing offers nothing");
  });
  await withGateway({}, async ({ url }) => {
    process.env.FOLDRUN_MODEL_SUPPLY = "0";
    const r = await anthropicCall(url);
    assert.equal(r.status, 403);
    assert.match(await r.text(), /switched off/);
  });
});

test("a provider taken off the list stops calls on leases already handed out (Codex review)", async () => {
  await withGateway({}, async ({ url, up }) => {
    process.env.FOLDRUN_MODEL_SUPPLY_PROVIDERS = "openai";
    try {
      const r = await anthropicCall(url);
      assert.equal(r.status, 403);
      assert.match(await r.text(), /no longer offered/);
      assert.equal(up.seen.length, 0);
    } finally {
      delete process.env.FOLDRUN_MODEL_SUPPLY_PROVIDERS;
    }
  });
});

test("the daily cap is a ceiling: concurrent calls past it are refused before they are sent", async () => {
  // Each call holds max_tokens 4000 at $15/MTok ≈ $0.06 until it closes.
  await withGateway({ daily: { acme: 0.2 } }, async ({ url, up }) => {
    const results = await Promise.all(Array.from({ length: 20 }, () => anthropicCall(url).then(async (r) => ({ status: r.status, text: await r.text(), noRetry: r.headers.get("x-should-retry") }))));
    const ok = results.filter((r) => r.status === 200).length;
    const capped = results.filter((r) => r.status === 429);
    // A call holds its estimate (~$0.06) while it runs and closes at what it
    // cost ($0.033), so the room a finished call leaves lets the next in:
    // what matters is that the day never passes the cap.
    assert.ok(ok >= 1 && ok < 20, `some went through, not all (${ok})`);
    // A refusal says not to retry, in the shape the SDKs read (e2e, 3 Nov
    // 2026) — read off the batch's own refusals (Codex review).
    const refusal = results.find((r) => r.status === 429)!;
    assert.equal(refusal.noRetry, "false");
    const body = JSON.parse(refusal.text) as { type: string; error: { message: string } };
    assert.equal(body.type, "error");
    assert.match(body.error.message, /daily limit on foldrun's models/);
    assert.equal(ok + capped.length, 20);
    assert.match(capped[0].text, /daily limit/);
    assert.equal(up.seen.length, ok, "a refused call never reached the provider");
    assert.ok((await usage.spentToday("acme")) <= 0.2);
  });
});

test("a Chat Completions stream (Gemini) that did not ask for usage is made to, and metered", async () => {
  await withGateway({ provider: "gemini" }, async ({ url, up }) => {
    const res = await fetch(`${url}/v1beta/openai/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${PH}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-x", stream: true, messages: [] }),
    });
    assert.equal(res.status, 200);
    await res.text();
    assert.deepEqual(JSON.parse(up.seen[0].body).stream_options, { include_usage: true });
    assert.equal(up.seen[0].headers.authorization, "Bearer real-gemini-key-0000");
    const [row] = await usage.callsOfRun("acme", "run-1");
    assert.deepEqual(row.tokens, { input: 500, output: 250, cacheRead: 0, cacheWrite: 0 });
    assert.equal(row.costUsd, Number(((500 * 2 + 250 * 8) / 1e6).toFixed(6)));
  });
});

test("a reply cut short is charged at its estimate, never free", async () => {
  await withGateway({}, async ({ url }) => {
    const ac = new AbortController();
    const res = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": PH, "content-type": "application/json" },
      body: JSON.stringify({ model: "slow", max_tokens: 1000, stream: true, messages: [] }),
      signal: ac.signal,
    });
    const reader = res.body!.getReader();
    await reader.read(); // the first event arrives
    ac.abort();
    // The proxy notices the hang-up and closes the call.
    for (let i = 0; i < 50; i++) {
      const [row] = await usage.callsOfRun("acme", "run-1");
      if (row?.status !== "open") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const [row] = await usage.callsOfRun("acme", "run-1");
    assert.equal(row.status, "estimated");
    assert.ok(row.costUsd >= (1000 * 15) / 1e6, "at least every output token it could have had");
  });
});

test("DeepSeek and Moonshot: the final message_delta usage is the call's — message_start's is not added to it", () => {
  const r = new gw.UsageReader("anthropic", "text/event-stream");
  const ev = (o: object) => `data: ${JSON.stringify(o)}\n\n`;
  r.feed(Buffer.from(ev({ type: "message_start", message: { usage: { input_tokens: 900, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 1 } } })));
  r.feed(Buffer.from(ev({ type: "message_delta", usage: { input_tokens: 900, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 250 } })));
  r.feed(Buffer.from(ev({ type: "message_stop" })));
  assert.deepEqual(r.result(), { input: 900, output: 250, cacheRead: 100, cacheWrite: 0 });
});

test("an agent's request, as each provider of foldrun's models gets it, passes the gateway (3 Nov 2026)", async () => {
  const { toChatCompletions, toResponses, ToolCallExtras } = await import("../../foldrun-core/src/translator.ts");
  const { providerPreset } = await import("../../foldrun-core/src/providers.ts");
  // What Claude Code sends: a cached system prompt, tools with a cache mark,
  // a turn that used a tool and got an image back, thinking, effort, a stream.
  const agent = {
    model: "MODEL",
    max_tokens: 32000,
    stream: true,
    system: [{ type: "text", text: "You are an agent.", cache_control: { type: "ephemeral" } }],
    metadata: { user_id: "user_abc_account_def_session_ghi" },
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    tools: [
      { name: "Read", description: "read a file", input_schema: { type: "object", properties: { p: { type: "string" } } } },
      { name: "Bash", description: "run", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "look" }] },
      { role: "assistant", content: [{ type: "text", text: "reading" }, { type: "tool_use", id: "call_1", name: "Read", input: { p: "a.png" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }] }, { type: "text", text: "and?" }] },
    ],
  };
  for (const name of ["anthropic", "deepseek", "moonshot"] as const) {
    const r = gw.readCall(SUPPLY_PROVIDERS[name], Buffer.from(JSON.stringify({ ...agent, model: "m", context_management: { edits: [] } })), () => 32000);
    assert.ok(!("status" in r), `${name}: ${"status" in r ? r.message : ""}`);
    const sent = JSON.parse((r as { body: Buffer }).body.toString());
    if (name === "moonshot") {
      assert.ok(!("thinking" in sent) && !("context_management" in sent), "Kimi gets its schema's fields only");
      assert.deepEqual(sent.output_config, { effort: "high" });
    }
    if (name === "deepseek") assert.ok(!("context_management" in sent));
    if (name === "anthropic") assert.ok("context_management" in sent && sent.thinking.type === "adaptive", "Anthropic gets it as written");
  }
  {
    const preset = providerPreset(SUPPLY_PROVIDERS.gemini.preset)!;
    const extras = new ToolCallExtras();
    extras.keep("call_1", { google: { thought_signature: "c2ln" } });
    const body = toChatCompletions({ ...agent, model: "m" }, { maxTokensParam: preset.maxTokensParam, reasoningEffort: preset.reasoningEffort, stream: true, extras });
    const r = gw.readCall(SUPPLY_PROVIDERS.gemini, Buffer.from(JSON.stringify(body)), () => 32000);
    assert.ok(!("status" in r), `gemini: ${"status" in r ? r.message : ""}`);
    const sent = JSON.parse((r as { body: Buffer }).body.toString());
    assert.deepEqual(sent.stream_options, { include_usage: true }, "gemini: usage comes back on the stream");
    assert.equal(sent.reasoning_effort, "high", "gemini: effort is sent (its preset says reasoningEffort)");
  }
  {
    // OpenAI through the Responses API (GPT-6 calls tools there alone).
    assert.equal(SUPPLY_PROVIDERS.openai.format, "responses");
    const preset = providerPreset(SUPPLY_PROVIDERS.openai.preset)!;
    const body = toResponses({ ...agent, model: "m" }, { reasoningEffort: preset.reasoningEffort, cacheKey: "k", stream: true });
    const r = gw.readCall(SUPPLY_PROVIDERS.openai, Buffer.from(JSON.stringify(body)), () => 32000);
    assert.ok(!("status" in r), `openai: ${"status" in r ? r.message : ""}`);
    const sent = JSON.parse((r as { body: Buffer }).body.toString());
    assert.equal(sent.max_output_tokens, 32000);
    assert.equal(sent.service_tier, "default");
    assert.deepEqual(sent.reasoning, { effort: "high" });
    assert.ok(!("stream_options" in sent), "Responses reports usage on its own");
  }
});

test("OpenAI's Responses API: usage read from a reply and a stream; its paid tools and stateful fields refused", () => {
  const o = SUPPLY_PROVIDERS.openai;
  const j = new gw.UsageReader("responses", "application/json");
  j.feed(Buffer.from(JSON.stringify({ id: "resp_1", usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 400 }, output_tokens: 300, output_tokens_details: { reasoning_tokens: 200 } } })));
  assert.deepEqual(j.result(), { input: 600, output: 300, cacheRead: 400, cacheWrite: 0 }, "reasoning is in output_tokens");
  const s = new gw.UsageReader("responses", "text/event-stream");
  const ev = (o: object) => `event: x\ndata: ${JSON.stringify(o)}\n\n`;
  s.feed(Buffer.from(ev({ type: "response.created", response: { usage: null } }) + ev({ type: "response.output_text.delta", delta: "hi" })));
  s.feed(Buffer.from(ev({ type: "response.completed", response: { usage: { input_tokens: 50, input_tokens_details: { cached_tokens: 0 }, output_tokens: 7 } } })));
  assert.deepEqual(s.result(), { input: 50, output: 7, cacheRead: 0, cacheWrite: 0 });
  const failed = new gw.UsageReader("responses", "text/event-stream");
  failed.feed(Buffer.from(ev({ type: "response.failed", response: { usage: { input_tokens: 5, output_tokens: 0 } } })));
  assert.equal(failed.result(), null, "a failed stream is charged at its estimate, not as complete");

  const call = (body: object) => gw.readCall(o, Buffer.from(JSON.stringify({ model: "m", input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }], ...body })));
  const refused = (x: ReturnType<typeof call>) => "status" in x && x.status === 400;
  assert.ok(!refused(call({ tools: [{ type: "function", name: "f", parameters: {} }] })));
  assert.ok(refused(call({ tools: [{ type: "web_search" }] })), "OpenAI's own web search");
  assert.ok(refused(call({ previous_response_id: "resp_0" })), "no stored conversations");
  assert.ok(refused(call({ background: true })));
  assert.ok(refused(call({ service_tier: "priority" })));
  assert.ok(refused(call({ input: [{ role: "user", content: [{ type: "input_file", file_url: "https://x/a.pdf" }] }] })), "a document by URL");
  assert.ok(refused(call({ input: [{ type: "web_search_call" }] })));
  // A tool result's output may carry parts too (Codex review).
  assert.ok(refused(call({ input: [{ type: "function_call_output", call_id: "c", output: [{ type: "input_file", file_url: "https://x/a.pdf" }] }] })), "a document by URL in a tool result");
  assert.ok(refused(call({ input: [{ type: "function_call_output", call_id: "c", output: [{ type: "computer_screenshot" }] }] })));
  const pic = call({ input: [{ type: "function_call_output", call_id: "c", output: [{ type: "input_image", image_url: "https://x/a.png" }] }] });
  assert.ok(!("status" in pic) && pic.mediaTokens > 0, "an image by URL in a tool result is held at the media allowance");
  assert.ok(!("status" in call({ input: [{ type: "function_call_output", call_id: "c", output: "plain text" }] })));
  const capped = call({ max_output_tokens: 999999 });
  assert.ok(!("status" in capped));
});

test("OpenAI over Responses end to end: the key filled, the standard tier said, usage metered from the stream", async () => {
  await withGateway({ provider: "openai" }, async ({ url, up }) => {
    const res = await fetch(`${url}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${PH}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-x", stream: true, store: false, input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }], reasoning: { effort: "high" } }),
    });
    assert.equal(res.status, 200);
    await res.text();
    const sent = JSON.parse(up.seen[0].body);
    assert.equal(up.seen[0].headers.authorization, "Bearer real-openai-key-0000");
    assert.equal(sent.service_tier, "default");
    assert.equal(typeof sent.max_output_tokens, "number", "the ceiling is set when the request named none");
    const [row] = await usage.callsOfRun("acme", "run-1");
    assert.deepEqual(row.tokens, { input: 400, output: 250, cacheRead: 100, cacheWrite: 0 });
  });
});
