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
      if (req.url === "/v1/messages") {
        res.writeHead(200, { "content-type": "text/event-stream", "anthropic-organization-id": "org-secret", "anthropic-ratelimit-requests-remaining": "9", "request-id": "req_1" });
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
    price: (p, m) => (p === "anthropic" && (m === "claude-x" || m === "slow-x") ? PRICE : null),
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
      assert.match(((await refused.json()) as { error: { message: string } }).error.message, /not one the operator's Claude login is for/);
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
