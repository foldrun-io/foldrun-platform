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
    assert.ok("status" in account && account.status === 403 && /not a gateway key/.test(account.message));
    assert.deepEqual(touches, ["k1"], "last use written once a minute, and only for a key let in");
  } finally {
    door.setGatewayTouchForTests(null);
    door.setGatewayKeyLookupForTests(null);
  }
});

// ------------------------------------------------------- end to end

type Seen = { method: string; path: string; headers: http.IncomingHttpHeaders; body: string };

function fakeAnthropic() {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body });
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
      if (req.url === "/v1beta/openai/chat/completions") {
        const j = JSON.parse(body);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "pong" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        if (j.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 2000 } })}\n\n`);
        return void res.end("data: [DONE]\n\n");
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

async function withDoor(opts: { balance?: number | null; denied?: string[] }, table: Record<string, ApiKeyRow>, body: (ctx: { url: string; up: { host: string; seen: Seen[] } }) => Promise<void>) {
  const up = await fakeAnthropic();
  const d = await door.startGatewayDoor(0);
  usage.resetModelUsageForTests();
  setSupplyLeversForTest(opts.denied ?? [], {});
  process.env.FOLDRUN_MODEL_SUPPLY = "1";
  gw.setGatewayDepsForTests({
    price: (p, m) => ((p === "anthropic" && (m === "claude-x" || m === "slow-x")) || (p === "deepseek" && m === "deepseek-v4") || (p === "moonshot" && m === "kimi-k3") ? PRICE : (p === "openai" && m.startsWith("gpt-")) || (p === "gemini" && m.startsWith("gemini-")) ? { ...PRICE, cacheReadPerMTok: null, cacheWritePerMTok: null } : null),
    balance: async () => (opts.balance === undefined ? 10 : opts.balance),
    key: () => "real-anthropic-key-0000",
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

const call = (url: string, headers: Record<string, string>, model = "claude-x") =>
  fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...headers },
    body: JSON.stringify({ model, max_tokens: 4000, stream: true, messages: [{ role: "user", content: "hi" }] }),
  });

test("Claude Code's call is metered, sent with the platform's key, and the caller's key goes no further", async () => {
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_good", {});
  await withDoor({}, table, async ({ url, up }) => {
    const res = await call(url, { "x-api-key": "mda_good", cookie: "s=1" });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /message_delta/, "the reply streamed through");
    assert.equal(up.seen[0].headers["x-api-key"], "real-anthropic-key-0000", "the provider saw the platform's key");
    assert.equal(up.seen[0].headers.cookie, undefined, "nothing of the caller's but the allowed headers");
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
  const records: { login: string; model: string | null; usage: unknown; status: number; headers: Record<string, string> }[] = [];
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
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": key },
      body: JSON.stringify({ model: "claude-x", max_tokens: 4000, stream: true, system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }] }),
    });
  try {
    await withDoor({ balance: 100 }, table, async ({ url, up }) => {
      const r1 = await send(url, "mda_login");
      assert.equal(r1.status, 200);
      await r1.text();
      const b1 = JSON.parse(up.seen[0].body);
      assert.deepEqual(b1.system[0].cache_control, { type: "ephemeral", ttl: "1h" });
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
    assert.deepEqual(await line({ "x-api-key": "mda_account" }), [403, "foldrun · not a gateway key\n"]);
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

test("an end customer (FOL-168): the provider is told its hashed id; a blocked one and one past its rate are refused before the key's own limits; a bad id is a 400", async () => {
  const customers = await import("../src/customers.ts");
  const { providerUserId } = await import("../../foldrun-core/src/customer.ts");
  const table: Record<string, ApiKeyRow> = {};
  add(table, "mda_good", {});
  customers.forgetBlocks();
  await withDoor({}, table, async ({ url, up }) => {
    const ok = await call(url, { "x-api-key": "mda_good", "x-foldrun-customer": "c-8812" });
    assert.equal(ok.status, 200);
    await ok.text();
    const sent = JSON.parse(up.seen.at(-1)!.body);
    assert.equal(sent.metadata.user_id, providerUserId("acme", "c-8812"), "the provider's end-user id, hashed with the account");
    assert.match(sent.metadata.user_id, /^fr-[0-9a-f]{32}$/);
    assert.ok(!JSON.stringify(sent).includes("c-8812"), "the partner's own id never leaves foldrun");

    const before = up.seen.length;
    const plain = await call(url, { "x-api-key": "mda_good" });
    await plain.text();
    assert.equal(JSON.parse(up.seen.at(-1)!.body).metadata, undefined, "no customer, nothing changed");
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
