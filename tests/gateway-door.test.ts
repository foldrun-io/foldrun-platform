// The gateway door (10 Nov 2026): a coding agent's calls, on a gateway key,
// checked and metered like a run's and sent on with the platform's key.
//
//   node --test tests/gateway-door.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { GATEWAY_USER_AGENT } from "../src/gateway-identity.ts";

process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-gatewaydoor-"));
process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE = "1";
delete process.env.FOLDRUN_DATABASE_URL;

const door = await import("../src/gateway-door.ts");
const gw = await import("../src/model-gateway.ts");
const usage = await import("../src/model-usage.ts");
const { setSupplyLeversForTest } = await import("../src/settings.ts");
type ApiKeyRow = NonNullable<Awaited<ReturnType<typeof import("../src/api-keys-db.ts").findApiKeyByHashDb>>>;

const sha = (k: string) => crypto.createHash("sha256").update(k).digest("hex");
const PRICE = { version: 7, inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75, maxOutputTokens: 8000 };

const record = (over: Partial<ApiKeyRow> = {}): ApiKeyRow => ({
  id: "k1",
  hash: "",
  prefix: "mda_abcdef12",
  label: "claude code",
  tenant: "acme",
  createdAt: new Date().toISOString(),
  revokedAt: null,
  role: "viewer",
  workspaces: null,
  purpose: "gateway",
  gateway: { capUsd: 5, dailyUsd: null },
  ...over,
});

function keys(table: Record<string, ApiKeyRow>) {
  door.setGatewayKeyLookupForTests(async (h) => Object.values(table).find((r) => r.hash === h) ?? null);
}
const add = (table: Record<string, ApiKeyRow>, secret: string, over: Partial<ApiKeyRow> = {}) => {
  table[secret] = record({ ...over, hash: sha(secret) });
};

// ------------------------------------------------------------ the keys

test("a request must carry a live gateway key; any other key is refused, not honoured", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_good", {});
  add(table, "mda_revoked", { revokedAt: new Date().toISOString() });
  add(table, "mda_expired", { expiresAt: new Date(Date.now() - 86_400_000).toISOString() });
  add(table, "mda_account", { purpose: undefined, gateway: undefined });
  keys(table);
  const touches: string[] = [];
  door.setGatewayTouchForTests(async (id) => void touches.push(id));
  try {
    const a = (h: Record<string, string>) => door.authenticate(h);
    assert.ok("who" in (await a({ "x-api-key": "mda_good" })));
    assert.ok("who" in (await a({ authorization: "Bearer mda_good" })), "ANTHROPIC_AUTH_TOKEN sends a Bearer");
    const none = await a({});
    assert.ok("status" in none && none.status === 401);
    const unknown = await a({ "x-api-key": "mda_nope" });
    assert.ok("status" in unknown && unknown.status === 401 && /invalid/.test(unknown.message));
    const revoked = await a({ "x-api-key": "mda_revoked" });
    assert.ok("status" in revoked && revoked.status === 401 && /revoked/.test(revoked.message));
    const expired = await a({ "x-api-key": "mda_expired" });
    assert.ok("status" in expired && expired.status === 401 && /expired/.test(expired.message));
    const account = await a({ "x-api-key": "mda_account" });
    assert.ok("status" in account && account.status === 403 && /no model access/.test(account.message), "a platform key without a model grant keeps its old reach: none here");
    assert.deepEqual(touches, ["k1"], "last use written once a minute, and only for a key let in");
  } finally {
    door.setGatewayTouchForTests(null);
    door.setGatewayKeyLookupForTests(null);
  }
});

// ------------------------------------------------------- end to end

type Seen = { method: string; path: string; headers: http.IncomingHttpHeaders; body: string };

const flakyCalls = new Map<string, number>();
/** claude-opus-413's body (a refusal past REFUSAL_KEEP), and the gate its second half waits on: the test opens
 *  it only once the first half has reached the client, so a door that held
 *  the reply back until the end would never see it open. */
// Its message would read as prompt_too_long if the door kept all of it: the
// log's reason=other is the proof that it kept only REFUSAL_KEEP bytes.
const HUGE_REFUSAL = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: SECRET-PROMPT-WORDS " + "x".repeat(20_000) } });
let hugeGate: Promise<void> = Promise.resolve();
function fakeAnthropic() {
  flakyCalls.clear();
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body });
      // flaky-<n>: busy (529) for the first n calls on it, then as any other;
      // flaky-login: busy on the login "a" alone.
      const named = req.url === "/v1/messages" ? String(JSON.parse(body).model) : "";
      const flaky = /^flaky-(\d+)$/.exec(named);
      if (flaky || (named === "flaky-login" && req.headers.authorization === "Bearer sk-ant-oat01-pool-a")) {
        const n = (flakyCalls.get(named) ?? 0) + 1;
        flakyCalls.set(named, n);
        if (!flaky || n <= Number(flaky[1])) {
          res.writeHead(529, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
        }
      }
      // claude-opus-400 / -413: Anthropic's own 400, in its own words; the second
      // one past what the door keeps to read (19 Nov 2026).
      if (named === "claude-opus-400") {
        res.writeHead(400, { "content-type": "application/json", "request-id": "req_refused" });
        return void res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 215000 tokens > 200000 maximum" } }));
      }
      if (named === "claude-opus-413") {
        // Past what the door keeps to read: the client still gets all of it.
        res.writeHead(400, { "content-type": "application/json" });
        res.write(HUGE_REFUSAL.slice(0, 9000));
        return void hugeGate.then(() => res.end(HUGE_REFUSAL.slice(9000)));
      }
      if (req.url === "/v1/messages" && JSON.parse(body).model === "slow-x") {
        // Slow: every call is in flight at once.
        setTimeout(() => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1000, output_tokens: 1 } } })}\n\n`);
          res.end(`data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 2000 } })}\n\n`);
        }, 300);
        return;
      }
      if (req.url === "/v1/responses") {
        const model = JSON.parse(body).model;
        if (model === "gpt-busy") {
          res.writeHead(429, { "content-type": "application/json", "retry-after": "7" });
          return void res.end(JSON.stringify({ error: { message: "Rate limit reached for gpt-busy" } }));
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const ev = (o: object) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        ev({ type: "response.created", response: { id: "resp_1", model } });
        if (model === "gpt-fail") {
          ev({ type: "response.failed", response: { error: { message: "upstream exploded" }, usage: { input_tokens: 10, output_tokens: 0 } } });
          return void res.end();
        }
        ev({ type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant" } });
        ev({ type: "response.output_text.delta", output_index: 0, delta: "pong" });
        ev({ type: "response.output_item.done", output_index: 0, item: { type: "message" } });
        ev({ type: "response.completed", response: { usage: { input_tokens: 1000, output_tokens: 2000, input_tokens_details: { cached_tokens: 0 } } } });
        return void res.end();
      }
      if (req.url === "/v1beta/openai/chat/completions" && JSON.parse(body).model === "gemini-cut") {
        // Stops mid-reply: no finish reason, no [DONE] (21 Nov 2026).
        res.writeHead(200, { "content-type": "text/event-stream" });
        return void res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "half" } }] })}\n\n`);
      }
      if (req.url === "/v1beta/openai/chat/completions") {
        const j = JSON.parse(body);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "pong" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        if (j.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 2000 } })}\n\n`);
        return void res.end("data: [DONE]\n\n");
      }
      if (req.url === "/v1/messages" && body.includes("slow-reply")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } })}\n\n`);
        setTimeout(() => res.end(`data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 5 } })}\n\n`), 900);
        return;
      }
      if (req.url === "/v1/messages" || req.url === "/anthropic/v1/messages") {
        res.writeHead(200, { "content-type": "text/event-stream", "anthropic-organization-id": "org-secret", "anthropic-workspace-id": "wrkspc-secret", "anthropic-ratelimit-requests-remaining": "9", "request-id": "req_1" });
        res.write(`data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}\n\n`);
        res.end(`data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 2000 } })}\n\n`);
        return;
      }
      if (req.url?.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ data: [{ id: "claude-x" }] }));
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise<{ host: string; seen: Seen[]; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ host: `127.0.0.1:${(server.address() as { port: number }).port}`, seen, close: () => server.close() }));
  });
}

async function withDoor(opts: { balance?: number | null; denied?: string[]; noKey?: boolean }, table: Record<string, ApiKeyRow>, body: (ctx: { url: string; up: { host: string; seen: Seen[] } }) => Promise<void>) {
  const up = await fakeAnthropic();
  const d = await door.startGatewayDoor(0);
  usage.resetModelUsageForTests();
  setSupplyLeversForTest(opts.denied ?? [], {});
  process.env.FOLDRUN_MODEL_SUPPLY = "1";
  gw.setGatewayDepsForTests({
    price: (p, m) => ((p === "anthropic" && (m === "claude-x" || m === "slow-x" || m.startsWith("flaky-") || m === "claude-opus-400" || m === "claude-opus-413")) || (p === "deepseek" && m === "deepseek-v4") || (p === "moonshot" && m === "kimi-k3") ? PRICE : (p === "openai" && m.startsWith("gpt-")) || (p === "gemini" && m.startsWith("gemini-")) ? { ...PRICE, cacheReadPerMTok: null, cacheWritePerMTok: null } : null),
    balance: async () => (opts.balance === undefined ? 10 : opts.balance),
    key: () => (opts.noKey ? null : "real-anthropic-key-0000"),
    host: () => up.host,
    plainHttp: () => true,
  });
  keys(table);
  door.setGatewayTouchForTests(async () => {});
  try {
    await body({ url: `http://127.0.0.1:${d.port}`, up });
  } finally {
    door.setGatewayTouchForTests(null);
    gw.setGatewayDepsForTests(null);
    door.setGatewayKeyLookupForTests(null);
    await d.close();
    up.close();
  }
}

// From Claude Code unless a test says otherwise: a plan (login) key answers
// Claude Code alone (NOT_CLAUDE_CODE).
const call = (url: string, headers: Record<string, string>, model = "claude-x") =>
  fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "user-agent": "claude-cli/2.1.3 (external, cli)", ...headers },
    body: JSON.stringify({ model, max_tokens: 4000, stream: true, messages: [{ role: "user", content: "hi" }] }),
  });

test("Claude Code's call is metered, sent with the platform's key, and the caller's key goes no further", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_good", {});
  await withDoor({}, table, async ({ url, up }) => {
    const res = await call(url, { "x-api-key": "mda_good", cookie: "s=1", "x-real-ip": "1.2.3.4", "x-stainless-os": "Windows" });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /message_delta/, "the reply streamed through");
    assert.equal(up.seen[0].headers["x-api-key"], "real-anthropic-key-0000", "the provider saw the platform's key");
    assert.equal(up.seen[0].headers.cookie, undefined, "nothing of the caller's but the allowed headers");
    assert.equal(up.seen[0].headers["user-agent"], GATEWAY_USER_AGENT);
    assert.equal(up.seen[0].headers["x-real-ip"], undefined);
    assert.equal(up.seen[0].headers["x-stainless-os"], undefined);
    assert.equal(JSON.parse(up.seen[0].body).metadata, undefined);
    assert.equal(res.headers.get("anthropic-organization-id"), null, "the platform's organisation is not handed back");
    assert.equal(res.headers.get("anthropic-workspace-id"), null, "nor its workspace (seen on dev, 10 Nov 2026)");
    assert.equal(res.headers.get("anthropic-ratelimit-requests-remaining"), null);
    assert.equal(res.headers.get("request-id"), "req_1");
    assert.equal(await usage.spentByJob("acme", "gateway:k1"), Number(((1000 * 3 + 2000 * 15) / 1e6).toFixed(6)), "booked against the key's own job");
    assert.equal(await usage.spentByJob("acme", "gateway:other"), 0);
  });
});

test("a Bearer token works too, and the free routes pass unmetered", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_good", {});
  await withDoor({}, table, async ({ url }) => {
    const res = await call(url, { authorization: "Bearer mda_good" });
    assert.equal(res.status, 200);
    await res.text();
    const models = await fetch(`${url}/v1/models`, { headers: { "x-api-key": "mda_good" } });
    assert.equal(models.status, 200);
    assert.match(await models.text(), /claude-x/);
    assert.equal(await usage.spentByJob("acme", "gateway:k1"), Number(((1000 * 3 + 2000 * 15) / 1e6).toFixed(6)), "the model list cost nothing");
  });
});

test("the key's own cap stops it after it is spent, in Anthropic's error shape", async () => {
  const table: Record<string, ApiKeyRow> = {};
  // Held at about $0.06 a call, closed at $0.033: room for the first, not a second.
  add(table, "mda_small", { gateway: { capUsd: 0.07, dailyUsd: null } });
  await withDoor({}, table, async ({ url, up }) => {
    const first = await call(url, { "x-api-key": "mda_small" });
    assert.equal(first.status, 200);
    await first.text();
    const second = await call(url, { "x-api-key": "mda_small" });
    assert.equal(second.status, 402, "a 402, which Claude Code does not retry for minutes as it does a 429");
    const err = (await second.json()) as { type: string; error: { type: string; message: string } };
    assert.equal(err.type, "error");
    assert.equal(err.error.type, "billing_error");
    assert.match(err.error.message, /spending limit/);
    assert.equal(up.seen.length, 1, "the second call never left");
  });
});

test("a daily limit counts today only", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_day", { gateway: { capUsd: null, dailyUsd: 0.07 } });
  await withDoor({}, table, async ({ url }) => {
    const first = await call(url, { "x-api-key": "mda_day" });
    assert.equal(first.status, 200);
    await first.text();
    const second = await call(url, { "x-api-key": "mda_day" });
    assert.equal(second.status, 402);
    assert.match(((await second.json()) as { error: { message: string } }).error.message, /daily limit/);
  });
});

test("no key for the provider on this platform: 503 that says it is not set up and a retry will not help (dev, 20 Nov 2026)", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_good", {});
  await withDoor({ noKey: true }, table, async ({ url, up }) => {
    const r = await call(url, { "x-api-key": "mda_good" });
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("x-should-retry"), "false", "an SDK must not retry it (Codex)");
    const text = await r.text();
    assert.match(text, /has no usable key on this platform — the operator has to add or fix it, so retrying will not help/);
    assert.doesNotMatch(text, /for a moment/);
    assert.equal(up.seen.length, 0, "nothing sent");
  });
});

test("the account must stand: out of credit is a 402, nothing sent", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_good", {});
  await withDoor({ balance: 0 }, table, async ({ url, up }) => {
    const res = await call(url, { "x-api-key": "mda_good" });
    assert.equal(res.status, 402);
    assert.match(((await res.json()) as { error: { message: string } }).error.message, /out of credits/);
    assert.equal(up.seen.length, 0);
  });
});

test("only the three routes are served; an unpriced model and a bad key are refused", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_good", {});
  await withDoor({}, table, async ({ url, up }) => {
    const other = await fetch(`${url}/v1/files`, { headers: { "x-api-key": "mda_good" } });
    assert.equal(other.status, 404);
    const batch = await fetch(`${url}/v1/messages/batches`, { method: "POST", headers: { "x-api-key": "mda_good" }, body: "{}" });
    assert.equal(batch.status, 404);
    const bad = await call(url, { "x-api-key": "mda_wrong" });
    assert.equal(bad.status, 401);
    const unpriced = await call(url, { "x-api-key": "mda_good" }, "claude-unknown");
    assert.equal(unpriced.status, 402);
    assert.equal(up.seen.length, 0, "none of it reached the provider");
    const ok = await fetch(`${url}/healthz`);
    assert.equal(ok.status, 200);
  });
});

test("calls at once cannot pass the key's cap together: the limit is held with each call's estimate (Codex review)", async () => {
  // Each call is held at about $0.06 (4000 output tokens at $15/M): a $0.10
  // cap has room for one in flight, not three.
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_tight", { gateway: { capUsd: 0.1, dailyUsd: null } });
  await withDoor({}, table, async ({ url, up }) => {
    const all = await Promise.all([1, 2, 3].map(() => call(url, { "x-api-key": "mda_tight" }, "slow-x")));
    const codes = all.map((r) => r.status).sort();
    await Promise.all(all.map((r) => r.text()));
    assert.deepEqual(codes, [200, 402, 402]);
    assert.equal(up.seen.length, 1, "only the admitted call reached the provider");
  });
});

test("a call keeps the margin it was held at: a margin changed later re-prices nothing (Codex review)", async (t) => {
  const { billing } = await import("../src/billing.ts");
  if (!billing().modelChargeOf) return t.skip("the public edition has no margin");
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_good", {});
  const prev = process.env.FOLDRUN_MARGIN;
  process.env.FOLDRUN_MARGIN = "2";
  try {
    if (gw.chargeMargin() !== 2) return t.skip("the margin is not read from FOLDRUN_MARGIN here");
    await withDoor({}, table, async ({ url }) => {
      const res = await call(url, { "x-api-key": "mda_good" });
      await res.text();
      const cost = Number(((1000 * 3 + 2000 * 15) / 1e6).toFixed(6));
      process.env.FOLDRUN_MARGIN = "1";
      assert.equal(gw.chargeMargin(), 1);
      assert.equal(await usage.spentByJob("acme", "gateway:k1", undefined, gw.chargeMargin()), Number((cost * 2).toFixed(6)), "charged at 2×, still, after the margin dropped");
    });
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_MARGIN;
    else process.env.FOLDRUN_MARGIN = prev;
  }
});

test("the query string goes on to the provider; the route is still checked on the path alone (Codex review)", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_good", {});
  await withDoor({}, table, async ({ url, up }) => {
    const r = await fetch(`${url}/v1/models?after_id=claude-a&limit=5`, { headers: { "x-api-key": "mda_good" } });
    await r.text();
    assert.equal(up.seen.at(-1)!.path, "/v1/models?after_id=claude-a&limit=5");
    const off = await fetch(`${url}/v1/files?x=1`, { headers: { "x-api-key": "mda_good" } });
    assert.equal(off.status, 404);
  });
});

test("a caller gone while the call is being admitted is never sent upstream (Codex review)", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_good", {});
  await withDoor({}, table, async ({ url, up }) => {
    // Slow admission (the balance read), after the body is in: the caller
    // leaves while it waits.
    gw.setGatewayDepsForTests({
      price: (p, m) => (p === "anthropic" && m === "claude-x" ? PRICE : null),
      balance: async () => {
        await new Promise((r) => setTimeout(r, 400));
        return 10;
      },
      key: () => "real-anthropic-key-0000",
      host: () => up.host,
      plainHttp: () => true,
    });
    const req = http.request(`${url}/v1/messages`, { method: "POST", headers: { "x-api-key": "mda_good", "content-type": "application/json" } });
    req.on("error", () => {});
    req.end(JSON.stringify({ model: "claude-x", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }));
    await new Promise((r) => setTimeout(r, 150));
    req.destroy();
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(up.seen.length, 0, "nothing reached the provider");
    assert.equal(await usage.spentByJob("acme", "gateway:k1"), 0, "and nothing was charged");
  });
});

test("stopping the door lets a call in flight finish, and closes what is left at the deadline (Codex review)", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_good", {});
  await withDoor({}, table, async ({ url, up }) => {
    const inflight = call(url, { "x-api-key": "mda_good" }, "slow-x"); // the provider answers after 300 ms
    await new Promise((r) => setTimeout(r, 100));
    const stopped = door.stopGatewayDoor(5_000);
    const res = await inflight;
    assert.equal(res.status, 200, "the call in flight finished");
    assert.match(await res.text(), /message_delta/);
    assert.equal(await stopped, true, "it drained on its own, before the deadline");
    assert.equal(up.seen.length, 1);
    assert.equal(await usage.spentByJob("acme", "gateway:k1"), Number(((1000 * 3 + 2000 * 15) / 1e6).toFixed(6)), "charged what it used, not its hold");
  });
});

// ------------------------------------------- the operator's Claude login

test("with a login pool: the pool picks the login, is told what each reply used, refuses a used-up share, and /v1/usage shows the share", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_login", { gateway: { capUsd: null, dailyUsd: null, credential: "login" } });
  door.setGatewayLoginAllowedForTests(() => true);
  const picks: { keyId: string; model: string | null }[] = [];
  const records: { login: string; model: string | null; usage: unknown; status: number; headers: Record<string, string>; streamed?: boolean }[] = [];
  let full = false;
  door.setGatewayLoginPoolForTests(() => ({
    async pick(who, model) {
      picks.push({ keyId: who.keyId, model });
      if (full) return { refuse: { status: 402, message: "your share of this window is used" } };
      return { login: "b", token: "sk-ant-oat01-pool-b" };
    },
    async record(_who, c) {
      records.push(c);
    },
    async shareOf() {
      return { windows: [{ name: "window", used: 0.5, share: 2, resetsAt: "2026-11-14T05:00:00.000Z" }, { name: "week", used: 3, share: 3, resetsAt: "2026-11-19T00:00:00.000Z" }] };
    },
  }));
  try {
    await withDoor({ balance: 0 }, table, async ({ url, up }) => {
      const r1 = await call(url, { "x-api-key": "mda_login" });
      assert.equal(r1.status, 200);
      await r1.text();
      assert.equal(up.seen[0].headers.authorization, "Bearer sk-ant-oat01-pool-b", "sent on the login the pool picked");
      assert.deepEqual(picks, [{ keyId: "k1", model: "claude-x" }]);
      // The record lands after the reply ends.
      for (let i = 0; i < 50 && !records.length; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(records.length, 1, "told once");
      assert.equal(records[0].login, "b");
      assert.equal(records[0].status, 200);
      assert.deepEqual(records[0].usage, { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0 });
      assert.equal(records[0].headers["anthropic-ratelimit-requests-remaining"], "9", "the provider's rate headers reach the pool");
      assert.equal(records[0].streamed, true, "the pool hears the reply was a stream (a streamed empty reply answered nothing)");
      assert.equal(r1.headers.get("anthropic-ratelimit-requests-remaining"), null, "and still not the caller");

      full = true;
      const r2 = await call(url, { "x-api-key": "mda_login" });
      assert.equal(r2.status, 402);
      assert.match(await r2.text(), /your share of this window is used/);
      assert.equal(up.seen.length, 1, "a refused call is not sent");

      const u = await fetch(`${url}/v1/usage`, { headers: { "x-api-key": "mda_login" } });
      const j = (await u.json()) as { metered: boolean; share?: unknown; limits?: { name: string; percent: number | null; resetsAt: string }[] };
      assert.equal(j.metered, false);
      assert.equal(j.share, undefined, "amounts are the operator's: percentages only");
      assert.deepEqual(j.limits, [{ name: "window", percent: 25, resetsAt: "2026-11-14T05:00:00.000Z" }, { name: "week", percent: 100, resetsAt: "2026-11-19T00:00:00.000Z" }]);
      door.resetGatewayUsageCacheForTests();
      const line = await (await fetch(`${url}/v1/usage?format=line`, { headers: { "x-api-key": "mda_login" } })).text();
      assert.equal(line.trim(), "foldrun · window 25% · week 100% · limit reached");
    });
  } finally {
    door.setGatewayLoginPoolForTests(null);
    door.setGatewayLoginAllowedForTests(null);
  }
});

test("extra usage (15 Nov 2026): past its share, a login key goes on as a metered call on the platform's key, paid from the wallet — or says why it cannot", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_login", { gateway: { capUsd: null, dailyUsd: null, credential: "login" } });
  door.setGatewayLoginAllowedForTests(() => true);
  const records: unknown[] = [];
  door.setGatewayLoginPoolForTests(() => ({
    async pick() {
      return { refuse: { status: 402, message: "your Claude Code Pro limit is reached", wallet: true } };
    },
    async record(_who, c) {
      records.push(c);
    },
    async shareOf() {
      return null;
    },
  }));
  try {
    await withDoor({}, table, async ({ url, up }) => {
      const r = await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "user-agent": "claude-cli/2.1.3 (external, cli)", "x-api-key": "mda_login", "anthropic-beta": "claude-code-20250219" },
        body: JSON.stringify({ model: "claude-x", max_tokens: 4000, stream: true, system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(r.status, 200);
      await r.text();
      const h = up.seen[0].headers;
      assert.equal(h["x-api-key"], "real-anthropic-key-0000", "sent on the platform's own key");
      assert.equal(h.authorization, undefined, "no login token");
      assert.equal(h["anthropic-beta"], "claude-code-20250219", "no OAuth beta");
      assert.match(up.seen[0].body, /"cache_control":\{"type":"ephemeral"\}/, "the cache point as the caller sent it");
      assert.doesNotMatch(up.seen[0].body, /"ttl":"1h"/, "the subscription's hour-long cache points are not put on a metered call");
      assert.ok((await usage.spentByJob("acme", "gateway:k1")) > 0, "metered against the key's job");
      assert.equal(records.length, 0, "the pool is not told of a call that was not on a login");
    });
    await withDoor({ balance: 0 }, table, async ({ url, up }) => {
      const r = await call(url, { "x-api-key": "mda_login" });
      assert.equal(r.status, 402);
      assert.match(await r.text(), /your Claude Code Pro limit is reached; extra usage is on, but the wallet cannot pay: .*out of credits/);
      assert.equal(up.seen.length, 0);
    });
    await withDoor({ noKey: true }, table, async ({ url, up }) => {
      const r = await call(url, { "x-api-key": "mda_login" });
      assert.equal(r.status, 402, "the limit, not a 503 the client would retry");
      assert.match(await r.text(), /your Claude Code Pro limit is reached; extra usage cannot run right now/);
      assert.equal(up.seen.length, 0);
    });
  } finally {
    door.setGatewayLoginPoolForTests(null);
    door.setGatewayLoginAllowedForTests(null);
  }
});

test("extra usage on a login (owner, 15 Nov 2026): past its share while a login has room, the call stays on the login, metered — the wallet pays the API price; no API key needed", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_login", { gateway: { capUsd: null, dailyUsd: null, credential: "login" } });
  door.setGatewayLoginAllowedForTests(() => true);
  const records: unknown[] = [];
  door.setGatewayLoginPoolForTests(() => ({
    async pick() {
      return { login: "l1", token: "login-token-1", extra: "your Claude Code Pro limit is reached" };
    },
    async record(_who, c) {
      records.push(c);
    },
    async shareOf() {
      return null;
    },
  }));
  try {
    for (const noKey of [false, true]) {
      await withDoor(noKey ? { noKey: true } : {}, table, async ({ url, up }) => {
        const r = await fetch(`${url}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "mda_login", "anthropic-beta": "claude-code-20250219", "user-agent": "claude-cli/2.1.3 (external, cli)" },
          body: JSON.stringify({ model: "claude-x", max_tokens: 4000, stream: true, system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: "hi" }] }),
        });
        assert.equal(r.status, 200, noKey ? "no API key on the platform: the login serves it" : "served");
        await r.text();
        const h = up.seen[0].headers;
        assert.equal(h.authorization, "Bearer login-token-1", "on the login");
        assert.equal(h["x-api-key"], undefined, "not on the platform's key");
        assert.match(h["anthropic-beta"] ?? "", /oauth-2025-04-20/, "the login's OAuth beta");
        assert.doesNotMatch(up.seen[0].body, /"ttl":"1h"/, "priced as the API would: the cache points as the caller sent them");
        assert.equal(JSON.parse(up.seen[0].body).system[0].text, door.CLAUDE_CODE_IDENTITY, "still the subscription's credential: Claude Code's line opens the call");
        assert.ok((await usage.spentByJob("acme", "gateway:k1")) > 0, "metered against the key's job: the wallet pays");
        assert.equal(records.length > 0, true, "the pool counts it against the login, so its own limits hold");
        records.length = 0;
      });
    }
    await withDoor({ balance: 0 }, table, async ({ url, up }) => {
      const r = await call(url, { "x-api-key": "mda_login" });
      assert.equal(r.status, 402);
      assert.match(await r.text(), /your Claude Code Pro limit is reached; extra usage is on, but the wallet cannot pay: .*out of credits/);
      assert.equal(up.seen.length, 0, "nothing sent");
    });
  } finally {
    door.setGatewayLoginPoolForTests(null);
    door.setGatewayLoginAllowedForTests(null);
  }
});

test("the gateway says which logins it holds when it starts (FOL-173): plans do not read sold out on an idle gateway", async () => {
  const told: Date[] = [];
  door.setGatewayLoginPoolForTests(() => ({
    async pick() {
      return { refuse: { status: 503, message: "unused" } };
    },
    async record() {},
    async shareOf() {
      return null;
    },
    async announce(now) {
      told.push(now);
    },
  }));
  try {
    await withDoor({}, {}, async () => {
      for (let i = 0; i < 20 && !told.length; i++) await new Promise((r) => setTimeout(r, 5));
      assert.equal(told.length, 1, "once at start, then hourly");
    });
  } finally {
    door.setGatewayLoginPoolForTests(null);
  }
});

test("a login key sends the operator's Claude login as a Bearer with the OAuth beta, unmetered, read fresh each call", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_login", { gateway: { capUsd: null, dailyUsd: null, credential: "login" } });
  const tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gw-login-")), "claude-oauth-token");
  fs.writeFileSync(tokenFile, "sk-ant-oat01-first\n");
  process.env.FOLDRUN_GATEWAY_LOGIN_FILE = tokenFile;
  door.setGatewayLoginAllowedForTests((t) => t === "acme");
  try {
    await withDoor({ balance: 0 }, table, async ({ url, up }) => {
      // Out of credits on purpose: the login is not foldrun's models, so the balance is not asked.
      const r1 = await call(url, { "x-api-key": "mda_login", "anthropic-beta": "claude-code-20250219" });
      assert.equal(r1.status, 200);
      await r1.text();
      const h = up.seen[0].headers;
      assert.equal(h.authorization, "Bearer sk-ant-oat01-first");
      assert.equal(h["x-api-key"], undefined, "the login is never sent as an API key");
      assert.equal(h["anthropic-beta"], "claude-code-20250219,oauth-2025-04-20");
      // The refresher rewrites the file: the next call carries the new token, no restart.
      fs.writeFileSync(tokenFile, "sk-ant-oat01-second\n");
      const r2 = await call(url, { "x-api-key": "mda_login" });
      await r2.text();
      assert.equal(up.seen[1].headers.authorization, "Bearer sk-ant-oat01-second");
      assert.equal(up.seen[1].headers["anthropic-beta"], "oauth-2025-04-20");
      assert.equal(await usage.spentByJob("acme", "gateway:k1"), 0, "not metered, not billed");
    });
  } finally {
    delete process.env.FOLDRUN_GATEWAY_LOGIN_FILE;
    door.setGatewayLoginAllowedForTests(null);
  }
});

test("Claude Code identity: a plan key's call from Claude Code opens with the line; one that has it, and other clients, are left alone", () => {
  const ID = door.CLAUDE_CODE_IDENTITY;
  const run = (body: unknown) => JSON.parse(door.withClaudeCodeIdentity(Buffer.from(JSON.stringify(body)))!.toString());
  const msgs = [{ role: "user", content: "hi" }];
  // No system prompt, an empty one, a string, a list: the line comes first and nothing is lost.
  assert.deepEqual(run({ model: "m", messages: msgs }).system, [{ type: "text", text: ID }]);
  assert.deepEqual(run({ model: "m", system: "", messages: msgs }).system, [{ type: "text", text: ID }]);
  assert.deepEqual(run({ model: "m", system: "Write a title.", messages: msgs }).system, [{ type: "text", text: ID }, { type: "text", text: "Write a title." }]);
  const cached = { type: "text", text: "Write a title.", cache_control: { type: "ephemeral" } };
  assert.deepEqual(run({ model: "m", system: [cached], messages: msgs }).system, [{ type: "text", text: ID }, cached]);
  assert.deepEqual(run({ model: "m", system: [cached], messages: msgs }).messages, msgs);
  // Claude Code's real shape (claude-cli 2.1.326): its billing header first.
  const BILL = { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.326.8ee; cc_entrypoint=cli;" };
  assert.deepEqual(run({ model: "m", system: [BILL, { type: "text", text: "Write a title." }], messages: msgs }).system, [BILL, { type: "text", text: ID }, { type: "text", text: "Write a title." }], "after the billing header, where Claude Code puts it");
  assert.deepEqual(run({ model: "m", system: [BILL], messages: msgs }).system, [BILL, { type: "text", text: ID }]);
  // Only a text block counts: one of another type naming the line or the
  // billing header is not taken for either (Codex review).
  const notText = { type: "document", text: ID };
  assert.deepEqual(run({ model: "m", system: [notText], messages: msgs }).system, [{ type: "text", text: ID }, notText]);
  const notBill = { type: "document", text: BILL.text };
  assert.deepEqual(run({ model: "m", system: [notBill], messages: msgs }).system, [{ type: "text", text: ID }, notBill]);
  // Empty: the line alone.
  assert.deepEqual(run({ model: "m", system: [], messages: msgs }).system, [{ type: "text", text: ID }]);
  // Already there: the very same bytes, so a cached prefix is not broken —
  // first, or second behind the billing header, as Claude Code's main calls send it.
  for (const system of [ID, `${ID} More.`, `Before. ${ID}`, [{ type: "text", text: ID }, cached], [BILL, { type: "text", text: ID }, cached], [BILL, { type: "text", text: ID, cache_control: { type: "ephemeral" } }], [BILL, { type: "text", text: "First." }, { type: "text", text: ID }]]) {
    const buf = Buffer.from(JSON.stringify({ model: "m", system, messages: msgs }));
    assert.equal(door.withClaudeCodeIdentity(buf), buf);
  }
  // The same body in gives the same body out.
  const again = Buffer.from(JSON.stringify({ model: "m", system: [cached], messages: msgs }));
  assert.equal(door.withClaudeCodeIdentity(again)!.toString(), door.withClaudeCodeIdentity(again)!.toString());
  // Not a JSON object, or a system prompt that is not text: as it came.
  for (const raw of ["not json", "[1,2]", JSON.stringify({ system: 7 })]) {
    const buf = Buffer.from(raw);
    assert.equal(door.withClaudeCodeIdentity(buf), buf);
  }
  assert.equal(door.withClaudeCodeIdentity(null), null);
  // Only Claude Code's own requests.
  for (const ua of ["claude-cli/2.1.3 (external, cli)", "claude-cli/2.0.0 (external, sdk-ts)", "Claude-Code/1.0", ["claude-cli/2.1.3"]]) assert.ok(door.fromClaudeCode(ua), String(ua));
  for (const ua of [undefined, "", "curl/8.4.0", "python-httpx/0.27", "anthropic-sdk-python/1.2", "my-claude-cli/1"]) assert.ok(!door.fromClaudeCode(ua), String(ua));
});

test("longCache: every cache point a Messages body may hold becomes 1h; a tool's input and anything else is left alone", () => {
  const eph = { type: "ephemeral" };
  const body = {
    model: "claude-x",
    cache_control: eph,
    tools: [{ name: "Bash", input_schema: {}, cache_control: eph }],
    system: [{ type: "text", text: "s1" }, { type: "text", text: "s2", cache_control: { type: "ephemeral", ttl: "5m" } }],
    messages: [
      { role: "user", content: "plain" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: { cache_control: eph } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "r", cache_control: eph }], cache_control: eph }, { type: "text", text: "next", cache_control: eph }] },
    ],
  };
  const out = JSON.parse(door.longCache(Buffer.from(JSON.stringify(body)))!.toString());
  const h1 = { type: "ephemeral", ttl: "1h" };
  assert.deepEqual(out.cache_control, h1);
  assert.deepEqual(out.tools[0].cache_control, h1);
  assert.equal(out.system[0].cache_control, undefined);
  assert.deepEqual(out.system[1].cache_control, h1, "an explicit 5m becomes 1h too, so longer points never follow shorter ones");
  assert.deepEqual(out.messages[1].content[0].input, { cache_control: eph }, "a tool's input is the model's words, never touched");
  assert.deepEqual(out.messages[2].content[0].cache_control, h1);
  assert.deepEqual(out.messages[2].content[0].content[0].cache_control, h1);
  assert.deepEqual(out.messages[2].content[1].cache_control, h1);
  assert.equal(out.messages[0].content, "plain");
  // Nothing to change, or not JSON: the very same buffer back.
  const none = Buffer.from(JSON.stringify({ model: "claude-x", messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: h1 }] }] }));
  assert.equal(door.longCache(none), none);
  const junk = Buffer.from("not json");
  assert.equal(door.longCache(junk), junk);
  // The same body in gives the same bytes out, so the cached prefix is stable turn to turn.
  assert.equal(door.longCache(Buffer.from(JSON.stringify(body)))!.toString(), door.longCache(Buffer.from(JSON.stringify(body)))!.toString());
});

test("a login key's cache points go upstream as 1h; a metered key's go as the caller sent them", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_login", { gateway: { capUsd: null, dailyUsd: null, credential: "login" } });
  add(table, "mda_metered");
  const tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gw-login-")), "claude-oauth-token");
  fs.writeFileSync(tokenFile, "sk-ant-oat01-first\n");
  process.env.FOLDRUN_GATEWAY_LOGIN_FILE = tokenFile;
  door.setGatewayLoginAllowedForTests((t) => t === "acme");
  const send = (url: string, key: string) =>
    fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "user-agent": "claude-cli/2.1.3 (external, cli)", "x-api-key": key },
      body: JSON.stringify({ model: "claude-x", max_tokens: 4000, stream: true, system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }] }),
    });
  try {
    await withDoor({ balance: 100 }, table, async ({ url, up }) => {
      const r1 = await send(url, "mda_login");
      assert.equal(r1.status, 200);
      await r1.text();
      const b1 = JSON.parse(up.seen[0].body);
      // Claude Code's identity line opens it (withClaudeCodeIdentity); the
      // caller's own block keeps its cache point, an hour long.
      assert.equal(b1.system[0].text, door.CLAUDE_CODE_IDENTITY);
      assert.deepEqual(b1.system.find((b: { text: string }) => b.text === "sys").cache_control, { type: "ephemeral", ttl: "1h" });
      assert.deepEqual(b1.messages[0].content[0].cache_control, { type: "ephemeral", ttl: "1h" });
      const r2 = await send(url, "mda_metered");
      assert.equal(r2.status, 200);
      await r2.text();
      const b2 = JSON.parse(up.seen[1].body);
      assert.deepEqual(b2.system[0].cache_control, { type: "ephemeral" }, "a metered key pays for its writes: Claude Code's own choice stands");
    });
  } finally {
    delete process.env.FOLDRUN_GATEWAY_LOGIN_FILE;
    door.setGatewayLoginAllowedForTests(null);
  }
});

test("a login key's call from Claude Code goes upstream opening with Claude Code's identity line; another client's is refused (429, as Anthropic answered), unsent; a metered key's goes as sent", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_login", { gateway: { capUsd: null, dailyUsd: null, credential: "login" } });
  add(table, "mda_metered");
  const tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gw-login-")), "claude-oauth-token");
  fs.writeFileSync(tokenFile, "sk-ant-oat01-first\n");
  process.env.FOLDRUN_GATEWAY_LOGIN_FILE = tokenFile;
  door.setGatewayLoginAllowedForTests((t) => t === "acme");
  const send = (url: string, key: string, ua: string, system?: unknown) =>
    fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": key, "user-agent": ua },
      body: JSON.stringify({ model: "claude-x", max_tokens: 4000, stream: true, ...(system === undefined ? {} : { system }), messages: [{ role: "user", content: "hi" }] }),
    });
  const CC = "claude-cli/2.1.3 (external, cli)";
  try {
    await withDoor({ balance: 100 }, table, async ({ url, up }) => {
      const seen = async (r: Response) => {
        assert.equal(r.status, 200);
        await r.text();
        return JSON.parse(up.seen[up.seen.length - 1].body);
      };
      // A background call: no system prompt at all.
      assert.deepEqual((await seen(await send(url, "mda_login", CC))).system, [{ type: "text", text: door.CLAUDE_CODE_IDENTITY }]);
      // One with its own prompt: the line first, the prompt kept, its cache point an hour.
      const own = await seen(await send(url, "mda_login", CC, [{ type: "text", text: "Write a title.", cache_control: { type: "ephemeral" } }]));
      assert.deepEqual(own.system, [{ type: "text", text: door.CLAUDE_CODE_IDENTITY }, { type: "text", text: "Write a title.", cache_control: { type: "ephemeral", ttl: "1h" } }]);
      // The main conversation already opens with it: not added twice.
      const main = await seen(await send(url, "mda_login", CC, [{ type: "text", text: door.CLAUDE_CODE_IDENTITY }, { type: "text", text: "rest" }]));
      assert.deepEqual(main.system.map((b: { text: string }) => b.text), [door.CLAUDE_CODE_IDENTITY, "rest"]);
      // Another client on a login key — Claude Desktop's chat, curl: refused
      // here with what to use instead, and the login is not asked. Nothing
      // is dressed as Claude Code.
      const before = up.seen.length;
      for (const ua of ["curl/8.4.0", "Claude/1.3.0 Electron", ""]) {
        const r = await send(url, "mda_login", ua);
        assert.equal(r.status, 429, ua);
        const j = (await r.json()) as { error: { type: string; message: string } };
        assert.equal(j.error.type, "rate_limit_error");
        assert.equal(j.error.message, door.NOT_CLAUDE_CODE);
        assert.match(j.error.message, /Code tab/);
      }
      assert.equal(up.seen.length, before, "nothing sent upstream");
      // A metered key, even from Claude Code: the body as the caller sent it.
      assert.equal((await seen(await send(url, "mda_metered", CC))).system, undefined);
    });
  } finally {
    delete process.env.FOLDRUN_GATEWAY_LOGIN_FILE;
    door.setGatewayLoginAllowedForTests(null);
  }
});

test("a login key on an account the operator does not allow, or with no login on the gateway, is refused and nothing is sent", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_login", { gateway: { capUsd: null, dailyUsd: null, credential: "login" } });
  const prevEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    await withDoor({}, table, async ({ url, up }) => {
      door.setGatewayLoginAllowedForTests(() => false);
      const refused = await call(url, { "x-api-key": "mda_login" });
      assert.equal(refused.status, 403);
      assert.match(((await refused.json()) as { error: { message: string } }).error.message, /no plan this key can run on/);
      door.setGatewayLoginAllowedForTests(() => true);
      const none = await call(url, { "x-api-key": "mda_login" });
      assert.equal(none.status, 503, "no login on this gateway");
      await none.text();
      assert.equal(up.seen.length, 0);
    });
  } finally {
    door.setGatewayLoginAllowedForTests(null);
    if (prevEnv !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = prevEnv;
  }
});

// ---------------------------------------- Part S (c): cache and load limits

test("a key is looked up once per 10 s per pod, and an unknown key is cached too", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_cached", { id: "kc" });
  let lookups = 0;
  door.setGatewayKeyLookupForTests(async (h) => {
    lookups++;
    return Object.values(table).find((r) => r.hash === h) ?? null;
  });
  try {
    for (let i = 0; i < 5; i++) assert.ok("who" in (await door.authenticate({ "x-api-key": "mda_cached" })));
    assert.equal(lookups, 1, "one database lookup for five calls");
    for (let i = 0; i < 5; i++) assert.ok("status" in (await door.authenticate({ "x-api-key": "mda_nobody" })));
    assert.equal(lookups, 2, "a bad key reaches the database once, not on every try");
    // Expiry is checked on every call, against the cached record.
    table.mda_cached.expiresAt = new Date(Date.now() - 1000).toISOString();
    const expired = await door.authenticate({ "x-api-key": "mda_cached" });
    assert.ok("status" in expired && /expired/.test(expired.message));
  } finally {
    door.setGatewayKeyLookupForTests(null);
  }
});

test("the per-key request rate: past it, a 429 with Retry-After, and nothing is sent", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_rate", { id: "krate" });
  process.env.FOLDRUN_GATEWAY_RPM = "2";
  try {
    await withDoor({}, table, async ({ url, up }) => {
      for (let i = 0; i < 2; i++) await (await call(url, { "x-api-key": "mda_rate" })).text();
      const third = await call(url, { "x-api-key": "mda_rate" });
      assert.equal(third.status, 429);
      assert.ok(Number(third.headers.get("retry-after")) > 0, "Retry-After says when");
      assert.match(((await third.json()) as { error: { message: string } }).error.message, /request rate/);
      assert.equal(up.seen.length, 2);
    });
  } finally {
    delete process.env.FOLDRUN_GATEWAY_RPM;
  }
});

test("the per-key open-call cap holds across calls at once, login keys included", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_conc", { id: "kconc", gateway: { capUsd: null, dailyUsd: null, credential: "login" } });
  const tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gw-conc-")), "t");
  fs.writeFileSync(tokenFile, "sk-ant-oat01-x");
  process.env.FOLDRUN_GATEWAY_LOGIN_FILE = tokenFile;
  process.env.FOLDRUN_GATEWAY_CONCURRENCY = "1";
  door.setGatewayLoginAllowedForTests(() => true);
  try {
    await withDoor({}, table, async ({ url }) => {
      const both = await Promise.all([call(url, { "x-api-key": "mda_conc" }, "slow-x"), call(url, { "x-api-key": "mda_conc" }, "slow-x")]);
      const codes = both.map((r) => r.status).sort();
      await Promise.all(both.map((r) => r.text()));
      assert.deepEqual(codes, [200, 429]);
      // The slot is given back when the call ends.
      const after = await call(url, { "x-api-key": "mda_conc" }, "slow-x");
      assert.equal(after.status, 200);
      await after.text();
    });
  } finally {
    delete process.env.FOLDRUN_GATEWAY_CONCURRENCY;
    delete process.env.FOLDRUN_GATEWAY_LOGIN_FILE;
    door.setGatewayLoginAllowedForTests(null);
  }
});

test("open-call slots in Redis: shared, capped, released, and expired when a pod dies", async (t) => {
  const url = process.env.FOLDRUN_TEST_REDIS_URL;
  if (!url) return t.skip("set FOLDRUN_TEST_REDIS_URL to run against Redis");
  const prev = process.env.FOLDRUN_REDIS_URL;
  process.env.FOLDRUN_REDIS_URL = url;
  try {
    const { cacheConnected, cache } = await import("../src/cache.ts");
    assert.equal(await cacheConnected(), true, "Redis answers");
    const key = `kr${Date.now()}`;
    const a = await door.takeSlot(key, 2);
    const b = await door.takeSlot(key, 2);
    const c = await door.takeSlot(key, 2);
    assert.deepEqual([a.ok, b.ok, c.ok], [true, true, false], "two of two, the third refused");
    assert.equal(await cache()!.zcard(`gwc:{${key}}`), 2, "held in Redis, where every gateway pod sees them");
    await a.release();
    assert.equal((await door.takeSlot(key, 2)).ok, true, "a released slot is free again");
    // A pod that died never releases: its slot counts until it expires.
    const later = Date.now() + 16 * 60_000;
    assert.equal((await door.takeSlot(key, 2, later)).ok, true, "expired slots are counted out");
  } finally {
    // The client keeps the process alive: close it so the test run ends.
    const { cache } = await import("../src/cache.ts");
    cache()?.disconnect();
    if (prev === undefined) delete process.env.FOLDRUN_REDIS_URL;
    else process.env.FOLDRUN_REDIS_URL = prev;
  }
});

test("a caller gone during the checks gives its open-call slot back (Codex review)", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_gone", { id: "kgone" });
  process.env.FOLDRUN_GATEWAY_CONCURRENCY = "1";
  try {
    await withDoor({}, table, async ({ url }) => {
      // A slow lookup: the caller leaves while the key is being looked up.
      door.setGatewayKeyLookupForTests(async (h) => {
        await new Promise((r) => setTimeout(r, 300));
        return Object.values(table).find((r) => r.hash === h) ?? null;
      });
      for (let i = 0; i < 3; i++) {
        const req = http.request(`${url}/v1/messages`, { method: "POST", headers: { "x-api-key": "mda_gone", "content-type": "application/json" } });
        req.on("error", () => {});
        req.end("{}");
        await new Promise((r) => setTimeout(r, 50));
        req.destroy();
        await new Promise((r) => setTimeout(r, 400));
      }
      // Had a slot leaked, a cap of one would refuse this.
      const ok = await call(url, { "x-api-key": "mda_gone" });
      assert.equal(ok.status, 200);
      await ok.text();
    });
  } finally {
    delete process.env.FOLDRUN_GATEWAY_CONCURRENCY;
  }
});

// ------------------------------------------------- Part A1: other providers

test("foldrun/<tier>: foldrun code's tier words, from models.code.tiers, else the Claude model of that tier", () => {
  const body = (model: string) => Buffer.from(JSON.stringify({ model, max_tokens: 10, messages: [] }));
  const modelOf = (r: ReturnType<typeof door.routeOf>) => ("body" in r && r.body ? JSON.parse(r.body.toString()).model : null);
  const prev = process.env.FOLDRUN_MODEL_CODE_TIERS;
  try {
    delete process.env.FOLDRUN_MODEL_CODE_TIERS;
    assert.equal(door.codeTierModel("foldrun/default"), "claude-sonnet-5-5");
    assert.equal(door.codeTierModel("claude-sonnet-5-5"), null, "not a tier word");
    assert.equal(door.codeTierModel("foldrun/huge"), "");
    let r = door.routeOf("POST", "/v1/messages", body("foldrun/max"));
    assert.ok("provider" in r && r.provider === "anthropic");
    assert.equal(modelOf(r), "claude-opus-5-5");
    process.env.FOLDRUN_MODEL_CODE_TIERS = "fast=deepseek/deepseek-v4-flash,default=kimi/kimi-k3";
    r = door.routeOf("POST", "/v1/messages", body("foldrun/default"));
    assert.ok("provider" in r && r.provider === "moonshot");
    assert.equal(modelOf(r), "kimi-k3", "the provider's own name for it");
    r = door.routeOf("POST", "/v1/messages", body("foldrun/fast"));
    assert.ok("provider" in r && r.provider === "deepseek");
    r = door.routeOf("POST", "/v1/messages", body("foldrun/max"));
    assert.equal(modelOf(r), "claude-opus-5-5", "a tier left out keeps its Claude model");
    r = door.routeOf("POST", "/v1/messages", body("foldrun/huge"));
    assert.ok("error" in r && r.status === 400);
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_MODEL_CODE_TIERS;
    else process.env.FOLDRUN_MODEL_CODE_TIERS = prev;
  }
});

test("model names choose the provider: provider/model, a bare known prefix, else Anthropic", () => {
  assert.deepEqual(door.providerOfModel("claude-sonnet-5-5"), { provider: "anthropic", model: "claude-sonnet-5-5" });
  assert.deepEqual(door.providerOfModel("deepseek-v4"), { provider: "deepseek", model: "deepseek-v4" });
  assert.deepEqual(door.providerOfModel("deepseek/deepseek-v4"), { provider: "deepseek", model: "deepseek-v4" });
  assert.deepEqual(door.providerOfModel("kimi/kimi-k3"), { provider: "moonshot", model: "kimi-k3" });
  assert.deepEqual(door.providerOfModel("kimi-k3"), { provider: "moonshot", model: "kimi-k3" });
  assert.deepEqual(door.providerOfModel("openai/gpt-6"), { provider: "openai", model: "gpt-6" });
  assert.deepEqual(door.providerOfModel("gpt-6"), { provider: "openai", model: "gpt-6" });
  assert.equal(door.providerOfModel("nope/x"), null);
  // Z.ai, Qwen, MiniMax and MiMo (10 Nov 2026), by prefix or by name.
  assert.deepEqual(door.providerOfModel("glm-5.3"), { provider: "zai", model: "glm-5.3" });
  assert.deepEqual(door.providerOfModel("zai/glm-5.3"), { provider: "zai", model: "glm-5.3" });
  assert.deepEqual(door.providerOfModel("qwen3.8-max"), { provider: "qwen", model: "qwen3.8-max" });
  assert.deepEqual(door.providerOfModel("alibaba/qwen3.7-plus"), { provider: "qwen", model: "qwen3.7-plus" });
  assert.deepEqual(door.providerOfModel("MiniMax-M3"), { provider: "minimax", model: "MiniMax-M3" }, "the name as MiniMax spells it");
  assert.deepEqual(door.providerOfModel("mimo-v2.6-pro"), { provider: "mimo", model: "mimo-v2.6-pro" });
  assert.deepEqual(door.providerOfModel("xiaomi/mimo-v2.6-pro"), { provider: "mimo", model: "mimo-v2.6-pro" });
});

test("a DeepSeek model goes to DeepSeek's Anthropic path with its x-api-key, the prefix stripped, metered at its price", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_ds", { id: "kds" });
  await withDoor({}, table, async ({ url, up }) => {
    const res = await call(url, { "x-api-key": "mda_ds", "anthropic-beta": "claude-code-20250219" }, "deepseek/deepseek-v4");
    assert.equal(res.status, 200);
    assert.match(await res.text(), /message_delta/);
    const seen = up.seen[0];
    assert.equal(seen.path, "/anthropic/v1/messages");
    assert.equal(seen.headers["x-api-key"], "real-anthropic-key-0000", "the platform's DeepSeek key (the test's one key)");
    assert.equal(seen.headers.authorization, undefined);
    assert.equal(JSON.parse(seen.body).model, "deepseek-v4", "the name DeepSeek knows");
    assert.ok((await usage.spentByJob("acme", "gateway:kds")) > 0, "metered against the key");
  });
});

test("a Kimi model goes to Moonshot with a Bearer key; GPT is not offered yet; a login key stays Claude-only", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_km", { id: "kkm" });
  add(table, "mda_lg", { id: "klg", gateway: { capUsd: null, dailyUsd: null, credential: "login" } });
  door.setGatewayLoginAllowedForTests(() => true);
  try {
    await withDoor({}, table, async ({ url, up }) => {
      const res = await call(url, { "x-api-key": "mda_km" }, "kimi-k3");
      assert.equal(res.status, 200);
      await res.text();
      assert.equal(up.seen[0].path, "/anthropic/v1/messages");
      assert.equal(up.seen[0].headers.authorization, "Bearer real-anthropic-key-0000");
      assert.equal(up.seen[0].headers["x-api-key"], undefined, "Moonshot's key goes as a Bearer, never x-api-key");
      const nope = await call(url, { "x-api-key": "mda_km" }, "mistral/large");
      assert.equal(nope.status, 400, "a provider foldrun does not offer");
      const login = await call(url, { "x-api-key": "mda_lg" }, "deepseek-v4");
      assert.equal(login.status, 403);
      assert.equal(up.seen.length, 1, "neither refusal reached a provider");
    });
  } finally {
    door.setGatewayLoginAllowedForTests(null);
  }
});

test("count_tokens on a provider without one answers an estimate, marked, and sends nothing", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_ct", { id: "kct" });
  await withDoor({}, table, async ({ url, up }) => {
    const res = await fetch(`${url}/v1/messages/count_tokens`, { method: "POST", headers: { "x-api-key": "mda_ct", "content-type": "application/json" }, body: JSON.stringify({ model: "deepseek-v4", messages: [{ role: "user", content: "hello there" }] }) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-foldrun-estimate"), "1");
    assert.ok(((await res.json()) as { input_tokens: number }).input_tokens > 0);
    assert.equal(up.seen.length, 0);
  });
});

test("a token-count estimate gets the same account checks as a call; a null body is a 400 (Codex review)", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_ce", { id: "kce" });
  add(table, "mda_cl", { id: "kcl", gateway: { capUsd: null, dailyUsd: null, credential: "login" } });
  door.setGatewayLoginAllowedForTests(() => true);
  try {
    await withDoor({ balance: 0 }, table, async ({ url }) => {
      const body = JSON.stringify({ model: "deepseek-v4", messages: [{ role: "user", content: "hi" }] });
      const broke = await fetch(`${url}/v1/messages/count_tokens`, { method: "POST", headers: { "x-api-key": "mda_ce", "content-type": "application/json" }, body });
      assert.equal(broke.status, 402, "out of credit: no estimate either");
      const login = await fetch(`${url}/v1/messages/count_tokens`, { method: "POST", headers: { "x-api-key": "mda_cl", "content-type": "application/json" }, body });
      assert.equal(login.status, 403, "a login key is Claude-only, estimates included");
      const nul = await fetch(`${url}/v1/messages`, { method: "POST", headers: { "x-api-key": "mda_ce", "content-type": "application/json" }, body: "null" });
      assert.equal(nul.status, 400);
    });
  } finally {
    door.setGatewayLoginAllowedForTests(null);
  }
});

// ---------------------------------------- Part A2: translated providers

const sse = (text: string) => text.split("\n\n").filter(Boolean);

test("a GPT model: Claude Code's request becomes a Responses request, its stream comes back as Anthropic's, metered", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_gpt", { id: "kgpt" });
  await withDoor({}, table, async ({ url, up }) => {
    const res = await call(url, { "x-api-key": "mda_gpt", "anthropic-beta": "claude-code-20250219" }, "openai/gpt-x");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /event-stream/);
    const text = await res.text();
    const events = sse(text).map((e) => e.split("\n")[0]);
    assert.ok(events.includes("event: message_start") && events.includes("event: message_stop"), text);
    assert.match(text, /"text_delta","text":"pong"/);
    const seen = up.seen[0];
    assert.equal(seen.path, "/v1/responses");
    assert.equal(seen.headers.authorization, "Bearer real-anthropic-key-0000");
    assert.equal(seen.headers["anthropic-beta"], undefined, "Anthropic's headers do not go to OpenAI");
    const sent = JSON.parse(seen.body);
    assert.equal(sent.model, "gpt-x");
    assert.ok(Array.isArray(sent.input), "the Responses shape");
    assert.equal(await usage.spentByJob("acme", "gateway:kgpt"), Number(((1000 * 3 + 2000 * 15) / 1e6).toFixed(6)), "metered on OpenAI's own usage");
  });
});

test("a Gemini model: Chat Completions with its usage asked for, translated back, metered", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_gem", { id: "kgem" });
  await withDoor({}, table, async ({ url, up }) => {
    const res = await call(url, { "x-api-key": "mda_gem" }, "gemini-x");
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /"text_delta","text":"pong"/);
    assert.match(text, /event: message_stop/);
    assert.equal(up.seen[0].path, "/v1beta/openai/chat/completions");
    assert.equal(JSON.parse(up.seen[0].body).stream_options?.include_usage, true);
    assert.ok((await usage.spentByJob("acme", "gateway:kgem")) > 0);
  });
});

test("a provider's 429 comes back as Anthropic's rate-limit error with its Retry-After; a failed stream ends in an error", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_busy", { id: "kbusy" });
  await withDoor({}, table, async ({ url }) => {
    const busy = await call(url, { "x-api-key": "mda_busy" }, "gpt-busy");
    assert.equal(busy.status, 429);
    assert.equal(busy.headers.get("retry-after"), "7");
    const err = (await busy.json()) as { type: string; error: { type: string; message: string } };
    assert.equal(err.type, "error");
    assert.equal(err.error.type, "rate_limit_error");
    assert.match(err.error.message, /Rate limit reached/);
    const failed = await call(url, { "x-api-key": "mda_busy" }, "gpt-fail");
    const text = await failed.text();
    assert.match(text, /event: error/);
    assert.match(text, /upstream exploded/);
    assert.doesNotMatch(text, /message_stop/);
  });
});

// ------------------------------------------- Part A5: the key's model map

test("a key's model map runs Claude Code's tier on another provider; unmapped tiers run as named", async () => {
  assert.equal(door.mapModel(Buffer.from(JSON.stringify({ model: "claude-haiku-5-5" })), { sonnet: "openai/gpt-x" })!.toString().includes("claude-haiku-5-5"), true);
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_map", { id: "kmap", gateway: { capUsd: 5, dailyUsd: null, models: { sonnet: "openai/gpt-x", haiku: "deepseek/deepseek-v4" } } });
  await withDoor({}, table, async ({ url, up }) => {
    for (const m of ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"]) await (await call(url, { "x-api-key": "mda_map" }, m === "claude-opus-5-5" ? "claude-x" : m)).text();
    assert.deepEqual(up.seen.map((x) => `${x.path} ${JSON.parse(x.body).model}`), [
      "/v1/responses gpt-x",
      "/anthropic/v1/messages deepseek-v4",
      "/v1/messages claude-x",
    ]);
  });
});

// ------------------------------------------- the database not answering

test("the database not answering is told apart from a wrong query, through drizzle's wrapping", () => {
  const coded = (code: string) => Object.assign(new Error("x"), { code });
  assert.equal(door.databaseDown(coded("ECONNREFUSED")), true);
  assert.equal(door.databaseDown(Object.assign(new Error("Failed query: select ..."), { cause: coded("57P01") })), true, "drizzle's cause");
  assert.equal(door.databaseDown(new Error("Connection terminated unexpectedly")), true);
  assert.equal(door.databaseDown(new Error("the database system is starting up")), true);
  assert.equal(door.databaseDown(coded("42601")), false, "a syntax error is ours, not an outage");
  assert.equal(door.databaseDown(new Error("boom")), false);
  assert.equal(door.databaseDown(null), false);
});

test("while Postgres is down: a key read in the last 2 minutes is still honoured; an older one, or none, is a 503 the client retries", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_good", {});
  let down = false;
  door.resetGatewayKeyCacheForTests();
  door.setGatewayKeyLookupForTests(async (h) => {
    if (down) throw Object.assign(new Error("Failed query"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    return Object.values(table).find((r) => r.hash === h) ?? null;
  });
  door.setGatewayTouchForTests(async () => {});
  try {
    const t0 = 1_800_000_000_000;
    assert.ok("who" in (await door.authenticate({ "x-api-key": "mda_good" }, t0)));
    down = true;
    assert.ok("who" in (await door.authenticate({ "x-api-key": "mda_good" }, t0 + 30_000)), "30 s into the outage: the last record");
    assert.ok("who" in (await door.authenticate({ "x-api-key": "mda_good" }, t0 + 110_000)), "and at 110 s");
    await assert.rejects(door.authenticate({ "x-api-key": "mda_good" }, t0 + 130_000), (e: unknown) => door.databaseDown(e), "past 2 minutes: not honoured");
    await assert.rejects(door.authenticate({ "x-api-key": "mda_never_seen" }, t0 + 30_000), (e: unknown) => door.databaseDown(e), "a key never read: not honoured");
    // Through the door: a 503 in Anthropic's shape with Retry-After, not a 500.
    const d = await door.startGatewayDoor(0);
    try {
      const r = await fetch(`http://127.0.0.1:${d.port}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "mda_never_seen" }, body: JSON.stringify({ model: "claude-x", max_tokens: 5, messages: [{ role: "user", content: "hi" }] }) });
      assert.equal(r.status, 503);
      assert.equal(r.headers.get("retry-after"), "5");
      const body = (await r.json()) as { type: string; error: { type: string; message: string } };
      assert.equal(body.type, "error");
      assert.match(body.error.message, /database is not answering, so the call was not made/);
    } finally {
      await d.close();
    }
  } finally {
    door.setGatewayKeyLookupForTests(null);
    door.setGatewayTouchForTests(null);
    door.resetGatewayKeyCacheForTests();
  }
});

test("a drain never closes a pooled connection under a client that is sending on it: every request answered, the last ones say Connection: close", async () => {
  door.setGatewayKeyLookupForTests(async () => null);
  const d = await door.startGatewayDoor(0);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
  let ok = 0, failed = 0, closing = 0;
  let sending = true;
  const one = () =>
    new Promise<void>((resolve) => {
      const r = http.request({ host: "127.0.0.1", port: d.port, path: "/v1/nothing", method: "GET", agent }, (res) => {
        if (res.headers.connection === "close") closing++;
        res.resume();
        res.on("end", () => (ok++, resolve()));
      });
      r.on("error", () => (failed++, resolve()));
      r.end();
    });
  const loops = Array.from({ length: 8 }, async () => {
    while (sending) await one();
  });
  await new Promise((r) => setTimeout(r, 300));
  const t0 = Date.now();
  const drained = d.close(10_000);
  await new Promise((r) => setTimeout(r, 700));
  sending = false;
  await Promise.all(loops);
  agent.destroy();
  const clean = await drained;
  assert.equal(failed, 0, `no request failed during the drain (${ok} answered)`);
  assert.ok(closing > 0, "responses during the drain said Connection: close");
  assert.equal(clean, true, "the drain finished, not cut at its deadline");
  assert.ok(Date.now() - t0 < 5_000, "and promptly once the client had gone");
  door.setGatewayKeyLookupForTests(null);
});

// ------------------------------------------- usage, for the status line

test("GET /v1/usage: the key's spend and limits, as JSON or one status line; it costs nothing", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_good", { gateway: { capUsd: 20, dailyUsd: 5 } });
  add(table, "mda_open", { id: "k2", gateway: { capUsd: null, dailyUsd: null } });
  await withDoor({}, table, async ({ url, up }) => {
    door.resetGatewayUsageCacheForTests();
    const before = await fetch(`${url}/v1/usage`, { headers: { authorization: "Bearer mda_good" } });
    assert.equal(before.status, 200);
    const b = (await before.json()) as Record<string, unknown>;
    assert.deepEqual({ ...b, day: undefined }, { metered: true, capUsd: 20, dailyUsd: 5, spentUsd: 0, todayUsd: 0, day: undefined });
    assert.match(String(b.day), /^\d{4}-\d{2}-\d{2}$/);
    const res = await call(url, { "x-api-key": "mda_good" });
    await res.text();
    door.resetGatewayUsageCacheForTests();
    const after = (await (await fetch(`${url}/v1/usage`, { headers: { "x-api-key": "mda_good" } })).json()) as { spentUsd: number; todayUsd: number };
    const spent = Number(((1000 * 3 + 2000 * 15) / 1e6).toFixed(6));
    assert.equal(after.spentUsd, spent, "as the key's limits count it");
    assert.equal(after.todayUsd, spent);
    const line = await fetch(`${url}/v1/usage?format=line`, { headers: { authorization: "Bearer mda_good" } });
    assert.equal(line.status, 200);
    assert.match(line.headers.get("content-type") ?? "", /^text\/plain/);
    assert.equal(await line.text(), "foldrun · $0.03 of $20.00 · today $0.03 of $5.00\n");
    const open = await fetch(`${url}/v1/usage?format=line`, { headers: { authorization: "Bearer mda_open" } });
    assert.equal(await open.text(), "foldrun · $0.00 spent · today $0.00\n", "no limits of its own");
    assert.equal(up.seen.length, 1, "only the one model call went upstream");
    assert.equal(await usage.spentByJob("acme", "gateway:k1"), spent, "asking cost nothing");
  });
});

test("GET /v1/usage refuses a bad key in Anthropic's shape, or as a short line with ?format=line", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_revoked", { revokedAt: new Date().toISOString() });
  add(table, "mda_account", { purpose: undefined, gateway: undefined });
  await withDoor({}, table, async ({ url }) => {
    const json = await fetch(`${url}/v1/usage`, { headers: { "x-api-key": "mda_nope" } });
    assert.equal(json.status, 401);
    assert.equal(((await json.json()) as { error: { type: string } }).error.type, "authentication_error");
    const line = (h: Record<string, string>) => fetch(`${url}/v1/usage?format=line`, { headers: h }).then(async (r) => [r.status, await r.text()]);
    assert.deepEqual(await line({ "x-api-key": "mda_nope" }), [401, "foldrun · key not valid\n"]);
    assert.deepEqual(await line({ "x-api-key": "mda_revoked" }), [401, "foldrun · key revoked\n"]);
    assert.deepEqual(await line({ "x-api-key": "mda_account" }), [403, "foldrun · key has no model access\n"]);
    assert.deepEqual(await line({}), [401, "foldrun · no key set\n"]);
  });
});

test("usage lines: a login key is not metered; a spent limit says so", () => {
  const u = { metered: true, capUsd: 20, dailyUsd: 5, spentUsd: 3.124, todayUsd: 1.1, day: "2026-11-11" };
  assert.equal(door.usageLine(u), "foldrun · $3.12 of $20.00 · today $1.10 of $5.00");
  assert.equal(door.usageLine({ ...u, todayUsd: 5 }), "foldrun · $3.12 of $20.00 · today $5.00 of $5.00 · limit reached");
  assert.equal(door.usageLine({ ...u, capUsd: null, spentUsd: 9 }), "foldrun · $9.00 spent · today $1.10 of $5.00");
  assert.equal(door.usageLine({ ...u, metered: false }), "foldrun · included in your plan");
});

test("usage asks have their own rate: a busy status line never uses up the key's call rate", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_good", { id: "kusage-rate" });
  const rpm = process.env.FOLDRUN_GATEWAY_RPM;
  process.env.FOLDRUN_GATEWAY_RPM = "2";
  try {
    await withDoor({}, table, async ({ url }) => {
      for (let i = 0; i < 5; i++) assert.equal((await fetch(`${url}/v1/usage`, { headers: { "x-api-key": "mda_good" } })).status, 200);
      const res = await call(url, { "x-api-key": "mda_good" });
      assert.equal(res.status, 200, "the call still has its rate");
      await res.text();
    });
  } finally {
    if (rpm === undefined) delete process.env.FOLDRUN_GATEWAY_RPM;
    else process.env.FOLDRUN_GATEWAY_RPM = rpm;
  }
});

test("GET /v1/usage?format=line with the database not answering: still one line, a 503 with Retry-After (Codex review)", async () => {
  const table: Record<string, ApiKeyRow> = {};
  await withDoor({}, table, async ({ url }) => {
    door.setGatewayKeyLookupForTests(async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    });
    const r = await fetch(`${url}/v1/usage?format=line`, { headers: { "x-api-key": "mda_never_seen" } });
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("retry-after"), "5");
    assert.equal(await r.text(), "foldrun · usage not available\n");
    const j = await fetch(`${url}/v1/usage`, { headers: { "x-api-key": "mda_never_seen2" } });
    assert.equal(j.status, 503);
    assert.equal(((await j.json()) as { type: string }).type, "error", "JSON keeps Anthropic's error shape");
  });
});

test("an end customer stays internal: a blocked one and one past its rate are refused before the key's own limits; a bad id is a 400", async () => {
  const customers = await import("../src/customers.ts");
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_good", {});
  customers.forgetBlocks();
  await withDoor({}, table, async ({ url, up }) => {
    const ok = await call(url, { "x-api-key": "mda_good", "x-foldrun-customer": "c-8812" });
    assert.equal(ok.status, 200);
    await ok.text();
    const sent = JSON.parse(up.seen.at(-1)!.body);
    assert.equal(sent.metadata, undefined, "no customer metadata or hash is sent upstream");
    assert.ok(!JSON.stringify(sent).includes("c-8812"), "the partner's own id never leaves foldrun");

    const before = up.seen.length;
    const plain = await call(url, { "x-api-key": "mda_good" });
    await plain.text();
    assert.equal(JSON.parse(up.seen.at(-1)!.body).metadata, undefined, "no account metadata is added either");
    assert.equal(up.seen.length, before + 1);

    assert.equal((await call(url, { "x-api-key": "mda_good", "x-foldrun-customer": "has space" })).status, 400);

    await customers.blockCustomer("acme", "c-bad", "ana@acme.test", "abuse");
    const blocked = await call(url, { "x-api-key": "mda_good", "x-foldrun-customer": "c-bad" });
    assert.equal(blocked.status, 403);
    assert.match(await blocked.text(), /c-bad is blocked by this account/);
    const others = await call(url, { "x-api-key": "mda_good", "x-foldrun-customer": "c-good" });
    assert.equal(others.status, 200, "the partner's other customers carry on");
    await others.text();

    await customers.setCustomerLimits("acme", { gatewayRpm: 2 }, "ana@acme.test");
    const r1 = await call(url, { "x-api-key": "mda_good", "x-foldrun-customer": "c-busy" });
    await r1.text();
    const r2 = await call(url, { "x-api-key": "mda_good", "x-foldrun-customer": "c-busy" });
    await r2.text();
    const r3 = await call(url, { "x-api-key": "mda_good", "x-foldrun-customer": "c-busy" });
    assert.equal(r3.status, 429, "past its own calls a minute");
    assert.ok(r3.headers.get("retry-after"));
    const r4 = await call(url, { "x-api-key": "mda_good", "x-foldrun-customer": "c-calm" });
    assert.equal(r4.status, 200, "another customer is not held by it");
    await r4.text();
    await customers.setCustomerLimits("acme", { gatewayRpm: null }, "ana@acme.test");
    assert.equal((await customers.customerLimits("acme")).gatewayRpm, 60, "null puts the default back");
  });
});

test("a gateway key that requires a customer (FOL-168): a call without x-foldrun-customer is refused 400; with one it goes", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_req", { requireCustomer: true });
  await withDoor({}, table, async ({ url }) => {
    const bare = await call(url, { "x-api-key": "mda_req" });
    assert.equal(bare.status, 400);
    assert.match(await bare.text(), /requires an end customer on every call/);
    const named = await call(url, { "x-api-key": "mda_req", "x-foldrun-customer": "c-1" });
    assert.equal(named.status, 200);
    await named.text();
    const models = await fetch(`${url}/v1/models`, { headers: { "x-api-key": "mda_req" } });
    assert.equal(models.status, 200, "the free GET routes need no customer");
  });
});

test("every refusal is recorded against the account and key when known, with a reason word (D239 phase 1)", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_good", {});
  add(table, "mda_revoked", { id: "k_rev", revokedAt: new Date().toISOString() });
  const lines: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void lines.push(String(a[0]));
  try {
    await withDoor({ balance: 0 }, table, async ({ url }) => {
      assert.equal((await call(url, { "x-api-key": "mda_revoked" })).status, 401);
      assert.equal((await call(url, { "x-api-key": "mda_nope" })).status, 401);
      assert.equal((await call(url, { "x-api-key": "mda_good" })).status, 402);
      assert.equal((await fetch(`${url}/v1/files`, { headers: { "x-api-key": "mda_nope" } })).status, 404);
    });
  } finally {
    console.warn = warn;
  }
  const refused = lines.filter((l) => l.startsWith("[ops] gateway.refused"));
  assert.ok(refused.some((l) => /reason=key_revoked/.test(l) && /tenant=acme/.test(l) && /key=k_rev/.test(l) && /status=401/.test(l)), refused.join("\n"));
  assert.ok(refused.some((l) => /reason=key_unknown/.test(l) && !/tenant=/.test(l)), "an unknown key: no account to show it on");
  assert.ok(refused.some((l) => /status=402/.test(l) && /tenant=acme/.test(l) && /key=k1/.test(l) && /surface=gateway/.test(l)));
  assert.equal(refused.filter((l) => /status=404/.test(l)).length, 0, "a 404 from nobody (a scanner) is not recorded");
  assert.ok(refused.every((l) => !/mda_/.test(l)), "never the key itself");
});

// ------------------------------- why, in the operations log (19 Nov 2026)

/** The readable ops lines a test's calls print (no boundary in a test), by
 *  console method. */
async function opsLinesOf(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => void lines.push(String(a[0]));
  try {
    await run();
  } finally {
    Object.assign(console, saved);
  }
  return lines.filter((l) => l.startsWith("[ops] "));
}

test("Anthropic's refusal: the client gets its body unchanged, and the log says why in our word, with the model — never the message", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_good", {});
  let body = "";
  let huge = "";
  let hugeBytes = Buffer.alloc(0);
  let open: () => void = () => {};
  hugeGate = new Promise<void>((resolve) => (open = resolve));
  const lines = await opsLinesOf(() =>
    withDoor({}, table, async ({ url }) => {
      const r = await call(url, { "x-api-key": "mda_good" }, "claude-opus-400");
      assert.equal(r.status, 400);
      body = await r.text();
      // The first half arrives while Anthropic still holds the second: the
      // door passes the refusal on as it comes, it does not wait for the end.
      // The deadline covers the headers too: a door that held the whole
      // reply back would not even send those.
      const deadline = Date.now() + 5000;
      const inTime = <T,>(p: Promise<T>): Promise<T | "late"> => Promise.race([p, new Promise<"late">((ok) => setTimeout(() => ok("late"), Math.max(1, deadline - Date.now())))]);
      const h = await inTime(call(url, { "x-api-key": "mda_good" }, "claude-opus-413"));
      assert.notEqual(h, "late", "no headers: the reply was held back");
      if (h === "late") return;
      assert.equal(h.status, 400);
      const rd = h.body!.getReader();
      const got: Buffer[] = [];
      const have = () => got.reduce((n, b) => n + b.length, 0);
      while (have() < 9000) {
        const next = await inTime(rd.read());
        assert.notEqual(next, "late", "the first half never came: the reply was held back");
        if (next === "late" || next.done) break;
        got.push(Buffer.from(next.value));
      }
      assert.ok(Buffer.concat(got).equals(Buffer.from(HUGE_REFUSAL.slice(0, 9000))), "byte for byte, before the rest exists");
      open();
      for (;;) {
        const next = await rd.read();
        if (next.done) break;
        got.push(Buffer.from(next.value));
      }
      hugeBytes = Buffer.concat(got);
      huge = hugeBytes.toString("utf8");
    }),
  );
  hugeGate = Promise.resolve();
  assert.equal(body, JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 215000 tokens > 200000 maximum" } }), "the body exactly as Anthropic sent it");
  assert.ok(huge.length > door.REFUSAL_KEEP, "a body past what is kept still reaches the client whole");
  assert.ok(hugeBytes.equals(Buffer.from(HUGE_REFUSAL)), "byte for byte");
  const refused = lines.filter((l) => l.startsWith("[ops] gateway.upstream_refused"));
  assert.equal(refused.length, 2, lines.join("\n"));
  const [long, big] = refused;
  for (const want of [/provider=anthropic/, /status=400/, /kind=invalid_request_error/, /reason=prompt_too_long/, /model=claude-opus-400/, /tenant=acme/, /key=k1/]) assert.match(long, want);
  assert.doesNotMatch(long, /dropped=/, "every field fits");
  // Cut at REFUSAL_KEEP, the JSON does not read: the status alone says it
  // (whole, the same body would read prompt_too_long — checked here).
  assert.equal(door.upstreamReason(400, "invalid_request_error", JSON.parse(HUGE_REFUSAL).error.message), "prompt_too_long");
  assert.match(big, /reason=other/);
  assert.doesNotMatch(big, /kind=/, "an unread body names no type");
  assert.match(big, /model=claude-opus-413/);
  for (const l of lines) assert.doesNotMatch(l, /215000|SECRET-PROMPT|too long/, "never the message's words");
});

test("refusalTap keeps exactly the first REFUSAL_KEEP bytes, across chunks, and nothing after", () => {
  assert.equal(door.REFUSAL_KEEP, 16 * 1024);
  const tap = door.refusalTap();
  const body = Buffer.from(Array.from({ length: 40_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join(""));
  tap.feed(body.subarray(0, 10_000));
  tap.feed(body.subarray(10_000, 16_383));
  tap.feed(body.subarray(16_383, 16_385));
  tap.feed(body.subarray(16_385));
  assert.equal(tap.text(), body.subarray(0, door.REFUSAL_KEEP).toString("utf8"));
  const small = door.refusalTap();
  small.feed(Buffer.from('{"type":"error"}'));
  assert.equal(small.text(), '{"type":"error"}');
});

test("upstreamReason: Anthropic's wording becomes one of our words; anything unknown is other", () => {
  const r = (message: string, type = "invalid_request_error", status = 400) => door.upstreamReason(status, type, message);
  assert.equal(r("prompt is too long: 215000 tokens > 200000 maximum"), "prompt_too_long");
  assert.equal(r("input length and `max_tokens` exceed context limit: 180000 + 64000 > 200000, decrease input length or `max_tokens` and try again"), "prompt_too_long");
  assert.equal(r("max_tokens: 128000 > 64000, which is the maximum allowed number of output tokens for claude-sonnet-4-5-20250929"), "max_tokens");
  assert.equal(r("max_tokens: Field required"), "max_tokens");
  assert.equal(r("A maximum of 4 blocks with cache_control may be provided. Found 5."), "cache_control");
  assert.equal(r("messages.1.content.0.image.source.base64: image exceeds 5 MB maximum: 6291456 bytes > 5242880 bytes"), "bad_image");
  assert.equal(r("Could not process image"), "bad_image");
  assert.equal(r("The PDF specified was not valid."), "bad_document");
  assert.equal(r("A maximum of 100 PDF pages may be provided."), "bad_document");
  assert.equal(r("messages.2: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_01AbC. Each `tool_use` block must have a corresponding `tool_result` block in the next message."), "tool_blocks");
  assert.equal(r("messages.3.content.0: unexpected `tool_use_id` found in `tool_result` blocks: toolu_01X. Each `tool_result` block must have a corresponding `tool_use` block in the previous message."), "tool_blocks");
  assert.equal(r("tools.3.custom.name: String should match pattern '^[a-zA-Z0-9_-]{1,128}$'"), "tool_blocks");
  assert.equal(r("messages.1.content.0.type: Expected `thinking` or `redacted_thinking`, but found `text`. When `thinking` is enabled, a final `assistant` message must start with a thinking block."), "thinking");
  assert.equal(r("`max_tokens` must be greater than `thinking.budget_tokens`"), "thinking", "thinking before max_tokens");
  assert.equal(r("model: claude-3-opus-20230000", "not_found_error", 404), "unknown_model");
  assert.equal(r("The model `claude-2.0` has been deprecated and is no longer available"), "unknown_model");
  assert.equal(r("system: text content blocks must be non-empty"), "system_prompt");
  assert.equal(r("Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."), "billing");
  assert.equal(r("Unexpected value(s) `context-9000-2099-01-01` for the `anthropic-beta` header. Please consult our documentation at docs.anthropic.com or try again without the header."), "beta_header");
  assert.equal(r("`temperature` and `top_p` cannot both be specified for this model. Please use only one."), "sampling");
  assert.equal(r("temperature: Input should be less than or equal to 1"), "sampling");
  assert.equal(r("output_format: Extra inputs are not permitted"), "unknown_field");
  assert.equal(r("invalid x-api-key", "authentication_error", 401), "auth");
  assert.equal(r("OAuth token has expired. Please obtain a new token or refresh your existing token.", "authentication_error", 401), "auth");
  assert.equal(r("This credential is only authorized for use with Claude Code and cannot be used for other API requests.", "invalid_request_error", 400), "not_claude_code");
  assert.equal(r("Number of request tokens has exceeded your per-minute rate limit", "rate_limit_error", 429), "rate_limit");
  assert.equal(r("Overloaded", "overloaded_error", 529), "overloaded");
  assert.equal(r("Something we have never seen"), "other");
  // The provider's type and status win over a word in the message, and a
  // field path over a word after it (Codex review, 19 Nov 2026).
  assert.equal(r("Rate limit exceeded for the image endpoint", "rate_limit_error", 429), "rate_limit");
  assert.equal(r("Overloaded while processing a document", "overloaded_error", 529), "overloaded");
  assert.equal(r("tools.0.name: 'image' is already used by another tool"), "tool_blocks");
  assert.equal(r("tools.1.input_schema: JSON schema is invalid - please consult https://json-schema.org for the document"), "tool_blocks");
  assert.equal(r("messages.0.content.1.document.source.data: The PDF specified was not valid."), "bad_document");
  assert.equal(r("messages.0.content.3.cache_control.ttl: a ttl='1h' cache_control block must not come after a ttl='5m' cache_control block"), "cache_control");
  assert.equal(r("thinking: Extra inputs are not permitted"), "thinking");
  assert.equal(door.upstreamReason(400, null, null), "other", "an unreadable body: the status alone");
  assert.equal(door.upstreamReason(429, null, null), "rate_limit");
  for (const w of door.UPSTREAM_REASONS) assert.match(w, /^[a-z][a-z0-9_-]{0,31}$/, `${w} fits the reason field`);
  assert.deepEqual(door.upstreamError('{"type":"error","error":{"type":"invalid_request_error","message":"x"}}'), { type: "invalid_request_error", message: "x" });
  assert.deepEqual(door.upstreamError("<html>502</html>"), { type: null, message: null });
  assert.deepEqual(door.upstreamError("null"), { type: null, message: null });
});

test("a plan's refusal (login_share) names the model it was for (19 Nov 2026)", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_login", { gateway: { capUsd: null, dailyUsd: null, credential: "login" } });
  door.setGatewayLoginAllowedForTests(() => true);
  door.setGatewayLoginPoolForTests(() => ({
    async pick() {
      return { refuse: { status: 402, message: "your share of this window is used" } };
    },
    async record() {},
    async shareOf() {
      return { windows: [] };
    },
  }));
  try {
    const lines = await opsLinesOf(() =>
      withDoor({ balance: 0 }, table, async ({ url }) => {
        const r = await call(url, { "x-api-key": "mda_login" }, "claude-haiku-5-5");
        assert.equal(r.status, 402);
        await r.text();
      }),
    );
    const refused = lines.filter((l) => l.startsWith("[ops] gateway.refused"));
    assert.equal(refused.length, 1, lines.join("\n"));
    for (const want of [/reason=login_share/, /model=claude-haiku-5-5/, /tenant=acme/, /key=k1/, /status=402/]) assert.match(refused[0], want);
    assert.doesNotMatch(refused[0], /dropped=/);
  } finally {
    door.setGatewayLoginPoolForTests(null);
    door.setGatewayLoginAllowedForTests(null);
  }
});

test("gateway.not_claude_code keeps its fields: the client and its version, the request's shape — nothing dropped (19 Nov 2026)", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_login", { gateway: { capUsd: null, dailyUsd: null, credential: "login" } });
  const tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gw-login-")), "claude-oauth-token");
  fs.writeFileSync(tokenFile, "sk-ant-oat01-first\n");
  process.env.FOLDRUN_GATEWAY_LOGIN_FILE = tokenFile;
  door.setGatewayLoginAllowedForTests((t) => t === "acme");
  const send = (url: string, body: Record<string, unknown>) =>
    fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "mda_login", "user-agent": "Claude/1.3.0 (Electron; secret words here)" },
      body: JSON.stringify(body),
    });
  try {
    const lines = await opsLinesOf(() =>
      withDoor({ balance: 100 }, table, async ({ url }) => {
        assert.equal((await (await send(url, { model: "claude-haiku-5-5", max_tokens: 1, messages: [{ role: "user", content: "hi" }] })).text()).length > 0, true);
        const chat = await send(url, { model: "claude-opus-5-5", max_tokens: 32000, stream: true, tools: [{ name: "t", input_schema: { type: "object" } }], messages: [{ role: "user", content: "hello there" }] });
        assert.equal(chat.status, 429);
        await chat.text();
        // JSON, but not an object: still JSON (Codex review).
        const odd = await fetch(`${url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "mda_login", "user-agent": "Claude/1.3.0" }, body: "null" });
        assert.equal(odd.status, 429);
        await odd.text();
      }),
    );
    const seen = lines.filter((l) => l.startsWith("[ops] gateway.not_claude_code"));
    assert.equal(seen.length, 3, lines.join("\n"));
    const [probe, chat, odd] = seen;
    assert.match(odd, /json=true/);
    assert.doesNotMatch(odd, /model=|messages=/);
    for (const want of [/client=Claude\b/, /clientVersion=1\.3\.0/, /answered=true/, /model=claude-haiku-5-5/, /maxTokens=1\b/, /messages=1\b/, /tools=0\b/, /streaming=false/, /json=true/, /tenant=acme/, /key=k1/]) assert.match(probe, want);
    for (const want of [/client=Claude\b/, /answered=false/, /model=claude-opus-5-5/, /maxTokens=32000/, /tools=1\b/, /streaming=true/]) assert.match(chat, want);
    for (const l of seen) {
      assert.doesNotMatch(l, /dropped=/, l);
      assert.doesNotMatch(l, /secret|Electron|hello/, "never the rest of the header or the request's words");
    }
    // Its refusal carries the account and key, as every refusal does.
    assert.ok(lines.some((l) => l.startsWith("[ops] gateway.refused") && /reason=not_claude_code/.test(l) && /tenant=acme/.test(l)));
  } finally {
    delete process.env.FOLDRUN_GATEWAY_LOGIN_FILE;
    door.setGatewayLoginAllowedForTests(null);
  }
});

test("clientOf: the first product token as two ids; nothing else of the header", () => {
  assert.deepEqual(door.clientOf("Claude/1.3.0 (Electron)"), { client: "Claude", clientVersion: "1.3.0" });
  assert.deepEqual(door.clientOf("claude-cli/2.1.3 (external, cli)"), { client: "claude-cli", clientVersion: "2.1.3" });
  assert.deepEqual(door.clientOf("curl/8.7.1"), { client: "curl", clientVersion: "8.7.1" });
  assert.deepEqual(door.clientOf("curl"), { client: "curl" });
  assert.deepEqual(door.clientOf(undefined), { client: "none" });
  assert.deepEqual(door.clientOf("   "), { client: "none" });
  assert.deepEqual(door.clientOf("ana@example.com/1"), { client: "other" }, "an email is not a product");
  assert.deepEqual(door.clientOf("https://evil.example/x"), { client: "other" });
  assert.deepEqual(door.clientOf(["Claude/1.3.0", "x"]), { client: "Claude", clientVersion: "1.3.0" });
  // Only a client on the list is named, and only a version's number (Codex review).
  assert.deepEqual(door.clientOf("private-project/1.2.3"), { client: "other" }, "an unknown product's version is its text too");
  assert.deepEqual(door.clientOf("Claude/10.24.8.17"), { client: "Claude", clientVersion: "10.24.8" }, "three numbers at most");
  assert.deepEqual(door.clientOf("Claude/1.2.3-payroll"), { client: "Claude", clientVersion: "1.2.3" });
  assert.deepEqual(door.clientOf("Claude/private-project"), { client: "Claude" });
});

test("logModel: a name in a family the gateway routes, else other — never a free-form name (Codex review, 19 Nov 2026)", () => {
  assert.equal(door.logModel("claude-opus-5-5"), "claude-opus-5-5");
  assert.equal(door.logModel("gpt-5.1"), "gpt-5.1");
  assert.equal(door.logModel("deepseek-v4"), "deepseek-v4");
  assert.equal(door.logModel("private-project"), "other");
  assert.equal(door.logModel("claude-private-project"), "other", "a family prefix is not enough (Codex review)");
  assert.equal(door.logModel("claude-10.24.8.17"), "other", "four numbers can be an address");
  for (const real of ["claude-sonnet-4-5-20250929", "claude-haiku-5-5", "claude-opus-4-1", "gpt-4o-mini", "gpt-5.1-codex", "o3", "o4-mini", "gemini-2.5-pro", "gemini-3-flash-preview", "deepseek-reasoner", "kimi-k3", "glm-4.7", "qwen3-coder-plus", "qwen3-30b-a3b", "minimax-m2", "mimo-v2-flash"]) assert.equal(door.logModel(real), real, real);
  assert.equal(door.logModel("anthropic/claude-x"), "other", "a / does not fit the field");
  assert.equal(door.logModel("claude x y"), "other");
  assert.equal(door.logModel(""), null);
  assert.equal(door.logModel(null), null);
});

// ------------------------------------------- retries (15 Nov 2026)

test("retryWaitMs: what is sent again, and after how long", () => {
  const policy = { retries: 2, baseMs: 500, maxWaitMs: 5000 };
  const mid = () => 0.5; // no jitter
  for (const status of [500, 502, 503, 504, 529, 429]) assert.equal(door.retryWaitMs(status, "", null, 0, policy, mid), 500, `${status} is sent again`);
  for (const status of [200, 400, 401, 402, 403, 404, 413]) assert.equal(door.retryWaitMs(status, "", null, 0, policy, mid), null, `${status} is not`);
  assert.equal(door.retryWaitMs(529, "", null, 1, policy, mid), 1000, "the wait doubles");
  assert.equal(door.retryWaitMs(529, "", null, 9, policy, mid), 5000, "and stops at the longest wait");
  assert.equal(door.retryWaitMs(429, "", "2", 0, policy, mid), 2000, "a short Retry-After is kept");
  assert.equal(door.retryWaitMs(429, "", "7", 0, policy, mid), null, "a long one goes back to the caller");
  assert.equal(door.retryWaitMs(503, "", "soon", 0, policy, mid), null, "one that cannot be read is not guessed at");
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]) assert.equal(door.retryWaitMs(null, code, null, 0, policy, mid), 500, `${code} never connected`);
  for (const code of ["", "ECONNRESET", "CERT_HAS_EXPIRED", "UND_ERR_SOCKET"]) assert.equal(door.retryWaitMs(null, code, null, 0, policy, mid), null, `${code || "an unknown failure"} may have reached the provider`);
  const lo = door.retryWaitMs(529, "", null, 0, policy, () => 0)!;
  const hi = door.retryWaitMs(529, "", null, 0, policy, () => 1)!;
  assert.ok(lo === 375 && hi === 625, "the wait is spread a quarter either way");
  assert.deepEqual(door.retryPolicy({}), { retries: 2, baseMs: 500, maxWaitMs: 5000 });
  assert.deepEqual(door.retryPolicy({ FOLDRUN_GATEWAY_RETRIES: "0", FOLDRUN_GATEWAY_RETRY_BASE_MS: "10", FOLDRUN_GATEWAY_RETRY_MAX_WAIT_MS: "50" }), { retries: 0, baseMs: 10, maxWaitMs: 50 });
  assert.equal(door.retryPolicy({ FOLDRUN_GATEWAY_RETRIES: "99" }).retries, 5, "never more than five");
  assert.equal(door.retryPolicy({ FOLDRUN_GATEWAY_RETRIES: "-1" }).retries, 2);
});

async function withRetryEnv(env: Record<string, string>, body: () => Promise<void>) {
  const names = ["FOLDRUN_GATEWAY_RETRIES", "FOLDRUN_GATEWAY_RETRY_BASE_MS", "FOLDRUN_GATEWAY_RETRY_MAX_WAIT_MS"];
  const before = names.map((n) => process.env[n]);
  Object.assign(process.env, { FOLDRUN_GATEWAY_RETRY_BASE_MS: "1", ...env });
  try {
    await body();
  } finally {
    names.forEach((n, i) => (before[i] === undefined ? delete process.env[n] : (process.env[n] = before[i])));
  }
}

test("a busy provider is asked again and the call is charged once; one that stays busy comes back as it was, charged nothing", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_retry", { id: "kretry" });
  await withRetryEnv({}, async () => {
    await withDoor({}, table, async ({ url, up }) => {
      const ok = await call(url, { "x-api-key": "mda_retry" }, "flaky-1");
      assert.equal(ok.status, 200, "the second try answered");
      assert.match(await ok.text(), /message_delta/);
      assert.equal(up.seen.length, 2, "sent twice");
      assert.equal(up.seen[0].body, up.seen[1].body, "the same body both times");
      assert.equal(await usage.spentByJob("acme", "gateway:kretry"), Number(((1000 * 3 + 2000 * 15) / 1e6).toFixed(6)), "charged once");

      const busy = await call(url, { "x-api-key": "mda_retry" }, "flaky-9");
      assert.equal(busy.status, 529, "the provider's own answer after the last try");
      assert.match(await busy.text(), /overloaded_error/);
      assert.equal(up.seen.length, 5, "three tries: the first and two more");
      assert.equal(await usage.spentByJob("acme", "gateway:kretry"), Number(((1000 * 3 + 2000 * 15) / 1e6).toFixed(6)), "the busy call cost nothing");
    });
  });
});

test("FOLDRUN_GATEWAY_RETRIES=0: a busy provider is asked once", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_once", { id: "konce" });
  await withRetryEnv({ FOLDRUN_GATEWAY_RETRIES: "0" }, async () => {
    await withDoor({}, table, async ({ url, up }) => {
      const res = await call(url, { "x-api-key": "mda_once" }, "flaky-1");
      assert.equal(res.status, 529);
      await res.text();
      assert.equal(up.seen.length, 1);
    });
  });
});

test("a provider that cannot be reached is tried again, then a 502 and nothing charged", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_down", { id: "kdown" });
  await withRetryEnv({}, async () => {
    await withDoor({}, table, async ({ url, up }) => {
      // The provider's port, closed: every try is refused at the socket.
      const dead = http.createServer();
      await new Promise<void>((r) => dead.listen(0, "127.0.0.1", () => r()));
      const port = (dead.address() as { port: number }).port;
      await new Promise<void>((r) => dead.close(() => r()));
      gw.setGatewayDepsForTests({ price: () => PRICE, balance: async () => 10, key: () => "real-anthropic-key-0000", host: () => `127.0.0.1:${port}`, plainHttp: () => true });
      const res = await call(url, { "x-api-key": "mda_down" });
      assert.equal(res.status, 502);
      assert.match(await res.text(), /could not reach the model provider/);
      assert.equal(up.seen.length, 0);
      assert.equal(await usage.spentByJob("acme", "gateway:kdown"), 0);
    });
  });
});

test("extra usage on a retry (Codex review, 15 Nov 2026): a login cooled under the call, and the pool says go on the wallet — the next try is metered on the platform's key", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_login", { gateway: { capUsd: null, dailyUsd: null, credential: "login" } });
  door.setGatewayLoginAllowedForTests(() => true);
  const records: { login: string; status: number }[] = [];
  let cooled = false;
  door.setGatewayLoginPoolForTests(() => ({
    async pick() {
      return cooled ? { refuse: { status: 402, message: "the service is at its limit for now", wallet: true } } : { login: "a", token: "sk-ant-oat01-pool-a" };
    },
    async record(_who, c) {
      records.push({ login: c.login, status: c.status });
      if (c.status === 529) cooled = true;
    },
    async shareOf() {
      return { windows: [] };
    },
  }));
  try {
    await withRetryEnv({}, async () => {
      await withDoor({}, table, async ({ url, up }) => {
        const res = await call(url, { "x-api-key": "mda_login", "anthropic-beta": "claude-code-20250219" }, "flaky-login");
        assert.equal(res.status, 200);
        await res.text();
        assert.equal(up.seen.length, 2);
        assert.equal(up.seen[0].headers.authorization, "Bearer sk-ant-oat01-pool-a", "first on the login");
        assert.equal(up.seen[1].headers.authorization, undefined, "then no login token");
        assert.equal(up.seen[1].headers["x-api-key"], "real-anthropic-key-0000", "but the platform's key");
        assert.equal(up.seen[1].headers["anthropic-beta"], "claude-code-20250219", "without the OAuth beta");
        assert.ok((await usage.spentByJob("acme", "gateway:k1")) > 0, "metered");
        for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10));
        assert.deepEqual(records, [{ login: "a", status: 529 }], "the pool heard of the login's try only");
      });
    });
  } finally {
    door.setGatewayLoginPoolForTests(null);
    door.setGatewayLoginAllowedForTests(null);
  }
});

test("extra usage on a login, on a retry (Codex review, 15 Nov 2026): the next login stays metered on one hold; a refusal then closes the hold at nothing", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_login", { gateway: { capUsd: null, dailyUsd: null, credential: "login" } });
  door.setGatewayLoginAllowedForTests(() => true);
  let cooled = false;
  let then: "extra" | "refuse" | "plan" = "extra";
  door.setGatewayLoginPoolForTests(() => ({
    async pick() {
      if (!cooled) return { login: "a", token: "sk-ant-oat01-pool-a", extra: "your Claude Code Pro limit is reached" };
      if (then === "plan") return { login: "b", token: "sk-ant-oat01-pool-b" };
      return then === "extra" ? { login: "b", token: "sk-ant-oat01-pool-b", extra: "your Claude Code Pro limit is reached" } : { refuse: { status: 402, message: "extra usage is off now" } };
    },
    async record(_who, c) {
      if (c.status === 529) cooled = true;
    },
    async shareOf() {
      return { windows: [] };
    },
  }));
  try {
    await withRetryEnv({}, async () => {
      await withDoor({}, table, async ({ url, up }) => {
        const res = await call(url, { "x-api-key": "mda_login" }, "flaky-login");
        assert.equal(res.status, 200);
        await res.text();
        assert.equal(up.seen.length, 2);
        assert.equal(up.seen[1].headers.authorization, "Bearer sk-ant-oat01-pool-b", "the next login");
        assert.ok((await usage.spentByJob("acme", "gateway:k1")) > 0, "metered");
      });
      cooled = false;
      then = "refuse";
      await withDoor({}, table, async ({ url, up }) => {
        const res = await call(url, { "x-api-key": "mda_login" }, "flaky-login");
        assert.equal(res.status, 402);
        assert.match(await res.text(), /extra usage is off now/);
        assert.equal(up.seen.length, 1);
        assert.equal(await usage.spentByJob("acme", "gateway:k1"), 0, "the hold closed at nothing: the 529 was not billed");
      });
      // The share's window turned over while it waited: the plan covers the
      // retry — nothing charged, the subscription's hour-long cache points back.
      cooled = false;
      then = "plan";
      await withDoor({}, table, async ({ url, up }) => {
        const res = await fetch(`${url}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "user-agent": "claude-cli/2.1.3 (external, cli)", "x-api-key": "mda_login" },
          body: JSON.stringify({ model: "flaky-login", max_tokens: 4000, stream: true, system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: "hi" }] }),
        });
        await res.text();
        assert.equal(up.seen.length, 2);
        assert.doesNotMatch(up.seen[0].body, /"ttl":"1h"/, "the first try priced as the API");
        assert.match(up.seen[1].body, /"ttl":"1h"/, "the retry on the subscription's body");
        assert.equal(await usage.spentByJob("acme", "gateway:k1"), 0, "nothing charged");
      });
    });
  } finally {
    door.setGatewayLoginPoolForTests(null);
    door.setGatewayLoginAllowedForTests(null);
  }
});

test("with a login pool: a busy login is reported to the pool and the next try goes on the login it then picks", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_login", { gateway: { capUsd: null, dailyUsd: null, credential: "login" } });
  door.setGatewayLoginAllowedForTests(() => true);
  const records: { login: string; status: number; usage: unknown }[] = [];
  let busy = new Set<string>();
  let none = false;
  door.setGatewayLoginPoolForTests(() => ({
    async pick() {
      if (none && busy.has("a")) return { refuse: { status: 402, message: "your share of this window is used" } };
      return busy.has("a") ? { login: "b", token: "sk-ant-oat01-pool-b" } : { login: "a", token: "sk-ant-oat01-pool-a" };
    },
    async record(_who, c) {
      records.push({ login: c.login, status: c.status, usage: c.usage });
      if (c.status === 529) busy.add(c.login);
    },
    async shareOf() {
      return { windows: [] };
    },
  }));
  try {
    await withRetryEnv({}, async () => {
      await withDoor({ balance: 0 }, table, async ({ url, up }) => {
        const res = await call(url, { "x-api-key": "mda_login" }, "flaky-login");
        assert.equal(res.status, 200);
        await res.text();
        assert.deepEqual(up.seen.map((s) => s.headers.authorization), ["Bearer sk-ant-oat01-pool-a", "Bearer sk-ant-oat01-pool-b"], "first on a, again on b");
        for (let i = 0; i < 50 && records.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
        assert.deepEqual(records.map((r) => [r.login, r.status]), [["a", 529], ["b", 200]], "the pool heard of both tries, each once");
        assert.equal(records[0].usage, null);

        // No login left to go on: the pool's own refusal, not the busy login's answer.
        busy = new Set();
        none = true;
        records.length = 0;
        const out = await call(url, { "x-api-key": "mda_login" }, "flaky-login");
        assert.equal(out.status, 402);
        assert.match(await out.text(), /your share of this window is used/);
        assert.equal(up.seen.length, 3, "one more try, and none after the pool had no login");
      });
    });
  } finally {
    door.setGatewayLoginPoolForTests(null);
    door.setGatewayLoginAllowedForTests(null);
  }
});

test("a plan key: another client's connection test is answered OK here, nothing sent; its chat still gets the Code-tab message; Claude Code's test goes upstream", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_login", { gateway: { capUsd: null, dailyUsd: null, credential: "login" } });
  const tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gw-login-")), "claude-oauth-token");
  fs.writeFileSync(tokenFile, "sk-ant-oat01-first\n");
  process.env.FOLDRUN_GATEWAY_LOGIN_FILE = tokenFile;
  door.setGatewayLoginAllowedForTests((t) => t === "acme");
  const DESKTOP = "Claude/1.3.0 (Electron)";
  const send = (url: string, ua: string, body: Record<string, unknown>) =>
    fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "mda_login", "user-agent": ua },
      body: JSON.stringify(body),
    });
  try {
    await withDoor({ balance: 100 }, table, async ({ url, up }) => {
      // Not streamed: a Messages object, "OK".
      const a = await send(url, DESKTOP, { model: "claude-haiku-5-5", max_tokens: 1, messages: [{ role: "user", content: "hi" }] });
      assert.equal(a.status, 200);
      const aj = (await a.json()) as { type: string; role: string; model: string; content: { type: string; text: string }[]; stop_reason: string };
      assert.equal(aj.type, "message");
      assert.equal(aj.model, "claude-haiku-5-5");
      assert.deepEqual(aj.content, [{ type: "text", text: door.CONNECTION_TEST_REPLY }]);
      assert.match(door.CONNECTION_TEST_REPLY, /^OK\./);
      // Streamed, content as blocks: the event stream a client reads.
      const b = await send(url, DESKTOP, { model: "claude-opus-5-5", max_tokens: 10, stream: true, system: "You are a test.", messages: [{ role: "user", content: [{ type: "text", text: "Reply with OK" }] }] });
      assert.equal(b.status, 200);
      assert.match(b.headers.get("content-type") ?? "", /text\/event-stream/);
      const events = [...(await b.text()).matchAll(/^event: (\S+)$/gm)].map((m) => m[1]);
      assert.deepEqual(events, ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
      assert.equal(up.seen.length, 0, "a test never reaches Anthropic");

      // A chat — thousands of tokens asked for, or tools, or two turns: refused with the message.
      for (const body of [
        { model: "claude-opus-5-5", max_tokens: 32000, messages: [{ role: "user", content: "hi" }] },
        { model: "claude-haiku-5-5", max_tokens: 5, tools: [{ name: "t", input_schema: { type: "object" } }], messages: [{ role: "user", content: "hi" }] },
        { model: "claude-haiku-5-5", max_tokens: 5, messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }] },
        { model: "claude-haiku-5-5", max_tokens: 5, messages: [{ role: "user", content: "x".repeat(500) }] },
      ]) {
        const r = await send(url, DESKTOP, body);
        assert.equal(r.status, 429, JSON.stringify(body).slice(0, 80));
        assert.equal(((await r.json()) as { error: { message: string } }).error.message, door.NOT_CLAUDE_CODE);
      }
      assert.equal(up.seen.length, 0);

      // Claude Code's own small call is real work (a title): it goes upstream.
      const cc = await send(url, "claude-cli/2.1.3 (external, cli)", { model: "claude-haiku-5-5", max_tokens: 1, messages: [{ role: "user", content: "hi" }] });
      assert.equal(cc.status, 200);
      await cc.text();
      assert.equal(up.seen.length, 1, "Claude Code is never answered by the gateway itself");
    });
  } finally {
    delete process.env.FOLDRUN_GATEWAY_LOGIN_FILE;
    door.setGatewayLoginAllowedForTests(null);
  }
});

test("connectionTestOf: one short user turn and a tiny reply cap; anything else is a conversation", () => {
  const t = (o: unknown) => door.connectionTestOf(Buffer.from(JSON.stringify(o)));
  assert.deepEqual(t({ model: "m", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }), { model: "m", stream: false, maxTokens: 1 });
  assert.equal(t({ model: "m", max_tokens: 17, messages: [{ role: "user", content: "hi" }] }), null);
  assert.equal(t({ model: "m", max_tokens: 1, messages: [{ role: "user", content: [{ type: "image", source: {} }] }] }), null);
  assert.equal(t({ model: "m", max_tokens: 1, system: "x".repeat(3000), messages: [{ role: "user", content: "hi" }] }), null);
  assert.equal(t({ model: "m", messages: [{ role: "user", content: "hi" }] }), null);
  assert.equal(door.connectionTestOf(Buffer.from("not json")), null);
});

test("sseKeepAlive: a quiet stream gets a ping between events, never inside one, and none once stopped", async () => {
  const written: string[] = [];
  const res = { destroyed: false, writableEnded: false, writableNeedDrain: false, write: (s: string) => (written.push(s), true) } as unknown as http.ServerResponse;
  const beat = door.sseKeepAlive(res, 60);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Quiet at an event boundary: pinged.
  beat.wrote(Buffer.from("event: message_start\ndata: {}\n\n"));
  await wait(200);
  assert.ok(written.length >= 1 && written.every((w) => w === door.SSE_PING), "a ping went out");

  // Quiet in the middle of an event: nothing written into it.
  written.length = 0;
  beat.wrote(Buffer.from("event: content_block_delta\ndata: {\"tex"));
  await wait(200);
  assert.deepEqual(written, []);

  // The event completes: pings may resume.
  beat.wrote(Buffer.from("t\":\"hi\"}\n\n"));
  await wait(200);
  assert.ok(written.length >= 1);

  // A stream that keeps talking is not pinged, and a stopped one is silent.
  written.length = 0;
  for (let i = 0; i < 6; i++) {
    beat.wrote(Buffer.from("event: x\ndata: {}\n\n"));
    await wait(15);
  }
  assert.deepEqual(written, []);
  beat.stop();
  await wait(150);
  assert.deepEqual(written, []);
});

test("a slow reply through the door carries pings while the provider is quiet, and the usage is still read", async () => {
  process.env.FOLDRUN_GATEWAY_KEEPALIVE_MS = "150";
  try {
    const table: Record<string, ApiKeyRow> = {};
    add(table, "mda_slow", { id: "kslow" });
    await withDoor({}, table, async ({ url }) => {
      const res = await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "user-agent": "claude-cli/2.1.3 (external, cli)", "x-api-key": "mda_slow", "anthropic-beta": "claude-code-20250219" },
        body: JSON.stringify({ model: "claude-x", max_tokens: 4000, stream: true, messages: [{ role: "user", content: "slow-reply" }] }),
      });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.match(text, /event: ping\ndata: \{"type": "ping"\}\n\n/);
      assert.match(text, /message_start/);
      assert.match(text, /message_delta/);
    });
  } finally {
    delete process.env.FOLDRUN_GATEWAY_KEEPALIVE_MS;
  }
});

test("a translated provider's stream that stops without saying it is done ends in an error, not a finished answer", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_gem", { id: "kgem" });
  await withDoor({}, table, async ({ url }) => {
    const res = await call(url, { "x-api-key": "mda_gem" }, "gemini-cut");
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /event: error/);
    assert.doesNotMatch(text, /message_stop/);
  });
});

test("a provider's stream is over on a finish reason, [DONE] or a Responses end event, nothing else", () => {
  assert.equal(door.upstreamEnded("chat", { choices: [{ delta: { content: "x" } }] }), false);
  assert.equal(door.upstreamEnded("chat", { choices: [{ delta: {}, finish_reason: "stop" }] }), true);
  assert.equal(door.upstreamEnded("chat", { choices: [] }), false);
  assert.equal(door.upstreamEnded("responses", { type: "response.output_text.delta" }), false);
  for (const t of ["response.completed", "response.incomplete", "response.failed", "error"]) assert.equal(door.upstreamEnded("responses", { type: t }), true, t);
});


// ------------------------------------------- one key (22 Nov 2026)

test("one key: an API key with a model grant opens the door; one without, an A2A or deploy key, stays refused before anything is sent", async () => {
  const table: Record<string, ApiKeyRow> = {};
  const grant = { capUsd: null, dailyUsd: 100, credential: "account" as const, walletUsd: 20, principal: "first" };
  add(table, "fr_api_unified", { id: "k9", purpose: undefined, role: "admin", gateway: grant });
  add(table, "fr_api_plain", { id: "k8", purpose: undefined, role: "admin", gateway: undefined });
  // A grant that is not the plan-first kind on an API key is not honoured:
  // only `credential: account` is ever written there.
  add(table, "fr_api_odd", { id: "k7", purpose: undefined, gateway: { capUsd: 5, dailyUsd: null } });
  add(table, "fr_a2a_x", { id: "k6", purpose: "a2a", gateway: grant });
  add(table, "fr_dep_x", { id: "k5", purpose: undefined, scope: { workspace: "w", access: "read" }, gateway: grant });
  await withDoor({}, table, async ({ url, up }) => {
    const ok = await call(url, { authorization: "Bearer fr_api_unified" });
    assert.equal(ok.status, 200);
    await ok.text();
    const spent = Number(((1000 * 3 + 2000 * 15) / 1e6).toFixed(6));
    assert.equal(await usage.spentByJob("acme", "gateway:first"), spent, "booked against the grant's chain, so a rotation keeps it");
    assert.equal(await usage.spentByJob("acme", "gateway:k9"), 0);
    const plain = await call(url, { authorization: "Bearer fr_api_plain" });
    assert.equal(plain.status, 403);
    assert.match(((await plain.json()) as { error: { message: string } }).error.message, /no model access/);
    for (const k of ["fr_api_odd", "fr_a2a_x", "fr_dep_x"]) {
      const r = await call(url, { authorization: `Bearer ${k}` });
      assert.equal(r.status, 403, k);
      await r.text();
    }
    assert.equal(up.seen.length, 1, "only the granted key's call went upstream");
  });
});

test("one key: its own budget, the wallet and revocation stop a call before the provider is asked", async () => {
  const table: Record<string, ApiKeyRow> = {};
  // An account key is held as charged (the margin on top): room for one call, not two.
  add(table, "fr_api_day", { id: "k9", purpose: undefined, gateway: { capUsd: null, dailyUsd: 0.1, credential: "account", walletUsd: 20, principal: "k9" } });
  add(table, "fr_api_gone", { id: "k4", purpose: undefined, revokedAt: new Date().toISOString(), gateway: { capUsd: null, dailyUsd: 100, credential: "account", walletUsd: 0, principal: "k4" } });
  add(table, "fr_api_old", { id: "k3", purpose: undefined, expiresAt: new Date(Date.now() - 1000).toISOString(), gateway: { capUsd: null, dailyUsd: 100, credential: "account", walletUsd: 0, principal: "k3" } });
  await withDoor({}, table, async ({ url, up }) => {
    const first = await call(url, { authorization: "Bearer fr_api_day" });
    assert.equal(first.status, 200, await first.clone().text());
    await first.text();
    const second = await call(url, { authorization: "Bearer fr_api_day" });
    assert.equal(second.status, 402, "its daily budget is spent");
    await second.text();
    const gone = await call(url, { authorization: "Bearer fr_api_gone" });
    assert.equal(gone.status, 401);
    assert.match(await gone.text(), /revoked/);
    const old = await call(url, { authorization: "Bearer fr_api_old" });
    assert.equal(old.status, 401);
    assert.match(await old.text(), /expired/);
    assert.equal(up.seen.length, 1, "nothing after the first call reached the provider");
  });
  await withDoor({ balance: 0 }, table, async ({ url, up }) => {
    door.resetGatewayKeyCacheForTests();
    const r = await call(url, { authorization: "Bearer fr_api_day" });
    assert.equal(r.status, 402, "an account out of credits is refused for this key as for any");
    await r.text();
    assert.equal(up.seen.length, 0);
  });
});

test("one key: a revocation announced on the channel drops the cached key at once", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "fr_api_live", { id: "k9", purpose: undefined, gateway: { capUsd: null, dailyUsd: 100, credential: "account", walletUsd: 0, principal: "k9" } });
  keys(table);
  door.setGatewayTouchForTests(async () => {});
  try {
    assert.ok("who" in (await door.authenticate({ authorization: "Bearer fr_api_live" })));
    table["fr_api_live"] = { ...table["fr_api_live"], revokedAt: new Date().toISOString() };
    // Within the cache window the old answer would stand: a test cannot
    // LISTEN, so it drops the cache the way the notice does.
    door.resetGatewayKeyCacheForTests();
    const after = await door.authenticate({ authorization: "Bearer fr_api_live" });
    assert.ok("status" in after && after.status === 401);
    // And without any notice, past KEY_CACHE_MS the record is read again.
    table["fr_api_live"] = { ...table["fr_api_live"], revokedAt: null };
    door.resetGatewayKeyCacheForTests();
    const t0 = Date.now();
    assert.ok("who" in (await door.authenticate({ authorization: "Bearer fr_api_live" }, t0)));
    table["fr_api_live"] = { ...table["fr_api_live"], revokedAt: new Date().toISOString() };
    assert.ok("who" in (await door.authenticate({ authorization: "Bearer fr_api_live" }, t0 + 1000)), "cached within 10 s");
    const later = await door.authenticate({ authorization: "Bearer fr_api_live" }, t0 + 11_000);
    assert.ok("status" in later && later.status === 401, "refused once the cache refreshes");
  } finally {
    door.setGatewayTouchForTests(null);
    door.setGatewayKeyLookupForTests(null);
  }
});
