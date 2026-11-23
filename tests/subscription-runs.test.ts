// A run on the account's Claude subscription (16 Nov 2026): an account
// holding a live Claude Code plan runs its routines and sessions on Claude,
// counted in the plan's windows like its Claude Code calls. The runner is
// told so by model-choice (modelSupplyFor → via "login"); the egress proxy
// sends such a call through the gateway's login path — a pooled login, the
// OAuth bearer, the pool told what came back — never the platform's API key,
// and asks the plan again on every call.
//
//   node --test tests/subscription-runs.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-subscription-"));
process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE = "1";
delete process.env.FOLDRUN_DATABASE_URL;

const { egressHooks, startEgressProxy, stopEgressProxy } = await import("../src/egress-proxy.ts");
const gw = await import("../src/model-gateway.ts");
const usage = await import("../src/model-usage.ts");
const door = await import("../src/gateway-door.ts");
const { setSupplyLeversForTest } = await import("../src/settings.ts");
const { addSupplyGrant } = await import("../../foldrun-core/src/egress.ts");
const { SUPPLY_KEY_NAME } = await import("../../foldrun-core/src/model-supply.ts");
type EgressGrant = import("../../foldrun-core/src/egress.ts").EgressGrant;
type LoginPool = import("../src/billing.ts").LoginPool;

const PH = `\${${SUPPLY_KEY_NAME}}`;
type Seen = { path: string; headers: http.IncomingHttpHeaders; body: string };

function fakeAnthropic() {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      seen.push({ path: req.url ?? "", headers: req.headers, body });
      res.writeHead(200, { "content-type": "text/event-stream", "anthropic-ratelimit-unified-status": "allowed" });
      res.write(`data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}\n\n`);
      res.end(`data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 20 } })}\n\n`);
    });
  });
  return new Promise<{ host: string; seen: Seen[]; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ host: `127.0.0.1:${(server.address() as { port: number }).port}`, seen, close: () => server.close() }));
  });
}

async function withSubscriptionLease(
  opts: { allowed?: boolean; pick?: LoginPool["pick"] },
  body: (ctx: { url: string; up: { seen: Seen[] }; recorded: unknown[]; picked: unknown[] }) => Promise<void>,
) {
  const up = await fakeAnthropic();
  const proxy = await startEgressProxy(0);
  const prevUrl = process.env.FOLDRUN_EGRESS_URL;
  process.env.FOLDRUN_EGRESS_URL = `http://127.0.0.1:${proxy.port}`;
  usage.resetModelUsageForTests();
  gw.setGatewayDepsForTests({ price: () => null, balance: async () => 0, key: () => null, host: () => up.host, plainHttp: () => true });
  const recorded: unknown[] = [];
  const picked: unknown[] = [];
  const pool: LoginPool = {
    pick: opts.pick ?? (async (who) => (picked.push(who), { login: "main", token: "sk-ant-oat01-the-login" })),
    record: async (who, call) => void recorded.push({ who, call }),
    shareOf: async () => null,
  };
  door.setGatewayLoginPoolForTests(() => pool);
  door.setGatewayLoginAllowedForTests(() => opts.allowed ?? true);
  const grant: EgressGrant = { secrets: {} };
  addSupplyGrant(grant, SUPPLY_KEY_NAME, "anthropic", up.host, "login");
  const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-1", grant, step: 2 } as Parameters<typeof egressHooks.lease>[0]))!;
  try {
    await body({ url: `${lease.url}/http://${up.host}`, up, recorded, picked });
  } finally {
    await lease.release().catch(() => {});
    gw.setGatewayDepsForTests(null);
    door.setGatewayLoginPoolForTests(null);
    door.setGatewayLoginAllowedForTests(null);
    if (prevUrl === undefined) delete process.env.FOLDRUN_EGRESS_URL;
    else process.env.FOLDRUN_EGRESS_URL = prevUrl;
    await stopEgressProxy();
    up.close();
  }
}

const call = (url: string, headers: Record<string, string> = { "x-api-key": PH, "anthropic-beta": "claude-code-20250219" }) =>
  fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...headers },
    body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 4000, stream: true, messages: [{ role: "user", content: "hi" }] }),
  });

test("a run's Claude call on the subscription goes on a pooled login: bearer + OAuth beta, no API key, the pool told its usage, nothing metered", async () => {
  await withSubscriptionLease({}, async ({ url, up, recorded, picked }) => {
    const res = await call(url);
    assert.equal(res.status, 200, await res.clone().text());
    assert.match(await res.text(), /message_delta/);
    assert.equal(up.seen.length, 1);
    const h = up.seen[0].headers;
    assert.equal(h.authorization, "Bearer sk-ant-oat01-the-login");
    assert.equal(h["x-api-key"], undefined, "no API key, and never the placeholder");
    assert.match(String(h["anthropic-beta"]), /oauth-2025-04-20/);
    assert.match(String(h["anthropic-beta"]), /claude-code-20250219/, "the runtime's own betas go on");
    assert.ok(!up.seen[0].body.includes(PH));
    assert.deepEqual(picked[0], { tenant: "acme", keyId: "runs:acme", plan: undefined }, "the caller is the account, from the lease");
    // The pool counts it once, in the plan's windows.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(recorded.length, 1);
    const rec = recorded[0] as { who: { tenant: string }; call: { login: string; usage: { input: number; output: number } } };
    assert.equal(rec.who.tenant, "acme");
    assert.equal(rec.call.login, "main");
    assert.deepEqual([rec.call.usage.input, rec.call.usage.output], [100, 20]);
    assert.equal((await usage.callsOfRun("acme", "run-1")).length, 0, "inside the plan: no metered row, nothing for the wallet");
  });
});

test("a plan that lapsed stops the run's next call — 402, nothing sent, never onto the wallet", async () => {
  await withSubscriptionLease({ allowed: false }, async ({ url, up }) => {
    const res = await call(url);
    assert.equal(res.status, 402);
    assert.match(await res.text(), /no longer holds an active foldrun subscription/);
    assert.equal(up.seen.length, 0);
  });
});

test("the plan's limit reached, no extra usage: the pool's refusal, said as it is", async () => {
  const pick: LoginPool["pick"] = async () => ({ refuse: { status: 402, message: "You've hit your Claude Code Pro limit for these five hours · it resets at 14:00" } });
  await withSubscriptionLease({ pick }, async ({ url, up }) => {
    const res = await call(url);
    assert.equal(res.status, 402);
    assert.match(await res.text(), /Claude Code Pro limit/);
    assert.equal(up.seen.length, 0);
  });
});

test("the subscription grant only in x-api-key, only on Claude's model routes", async () => {
  await withSubscriptionLease({}, async ({ url, up }) => {
    const misplaced = await call(url, { authorization: `Bearer ${PH}` });
    assert.equal(misplaced.status, 403);
    const other = await fetch(`${url}/v1/files`, { method: "POST", headers: { "x-api-key": PH }, body: "{}" });
    assert.equal(other.status, 403);
    assert.match(await other.text(), /serves POST \/v1\/messages/);
    assert.equal(up.seen.length, 0);
  });
});

test("the logins cannot serve and the platform has no key for Claude (23 Nov 2026): the supply's error, said as it is — not the plan's, nothing sent", async (t) => {
  const pick: LoginPool["pick"] = async () => ({ refuse: { status: 503, message: "this gateway cannot serve this key right now", supply: true } });
  const prevSupply = process.env.FOLDRUN_MODEL_SUPPLY;
  process.env.FOLDRUN_MODEL_SUPPLY = "1";
  setSupplyLeversForTest([], {});
  t.after(() => (prevSupply === undefined ? delete process.env.FOLDRUN_MODEL_SUPPLY : (process.env.FOLDRUN_MODEL_SUPPLY = prevSupply)));
  await withSubscriptionLease({ pick }, async ({ url, up }) => {
    gw.setGatewayDepsForTests({ price: () => ({ version: 7, inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75, maxOutputTokens: 8000 }), balance: async () => 10, key: () => null, host: () => up.host, plainHttp: () => true });
    const res = await call(url);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("x-should-retry"), "false");
    assert.match(await res.text(), /anthropic has no usable key on this platform/);
    assert.equal(up.seen.length, 0);
  });
});

test("the logins cannot serve and the platform has a key: the run's call goes on it — the API key, no login bearer, no OAuth beta, metered as the run's own", async (t) => {
  const pick: LoginPool["pick"] = async () => ({ refuse: { status: 503, message: "this gateway cannot serve this key right now", supply: true } });
  const prevSupply = process.env.FOLDRUN_MODEL_SUPPLY;
  process.env.FOLDRUN_MODEL_SUPPLY = "1";
  setSupplyLeversForTest([], {});
  t.after(() => (prevSupply === undefined ? delete process.env.FOLDRUN_MODEL_SUPPLY : (process.env.FOLDRUN_MODEL_SUPPLY = prevSupply)));
  await withSubscriptionLease({ pick }, async ({ url, up, recorded }) => {
    gw.setGatewayDepsForTests({ price: () => ({ version: 7, inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75, maxOutputTokens: 8000 }), balance: async () => 10, key: () => "real-anthropic-key-0000", host: () => up.host, plainHttp: () => true });
    const res = await call(url);
    assert.equal(res.status, 200, await res.clone().text());
    await res.text();
    assert.equal(up.seen.length, 1);
    const h = up.seen[0].headers;
    assert.equal(h["x-api-key"], "real-anthropic-key-0000");
    assert.equal(h.authorization, undefined);
    assert.doesNotMatch(String(h["anthropic-beta"] ?? ""), /oauth-2025-04-20/);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(recorded.length, 0, "no login carried it");
    const rows = await usage.callsOfRun("acme", "run-1");
    assert.equal(rows.length, 1, "metered once, on the run");
  });
});
