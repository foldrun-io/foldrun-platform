// tools: [debate, review] in a cloud step (FOL-444): the egress proxy's
// /second/<lease> door, end to end against the real proxy and gateway door,
// with the second provider faked as a local HTTP server.
//
//   node --test tests/egress-second-door.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-second-door-"));
process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE = "1";
process.env.FOLDRUN_MODEL_SUPPLY = "1";
delete process.env.FOLDRUN_DATABASE_URL;
delete process.env.FOLDRUN_REDIS_URL;

const { egressHooks, parseSecondDoorPath, startEgressProxy, stopEgressProxy } = await import("../src/egress-proxy.ts");
const gw = await import("../src/model-gateway.ts");
const usage = await import("../src/model-usage.ts");
const { setSupplyLeversForTest } = await import("../src/settings.ts");

type Json = Record<string, unknown>;
const T = "t".repeat(24);
const DEEP = { version: 7, inputPerMTok: 1, outputPerMTok: 4, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1, maxOutputTokens: 8000 };
const DIFF = ["diff --git a/src/pay.ts b/src/pay.ts", "--- a/src/pay.ts", "+++ b/src/pay.ts", "@@ -10,3 +10,4 @@", "   const a = 1;", "+  const b = a / 0;", "   return a;"].join("\n");

test("the door's path is /second/<lease>, nothing more", () => {
  assert.equal(parseSecondDoorPath(`/second/${T}`)!.token, T);
  assert.equal(parseSecondDoorPath(`/second/${T}/`)!.token, T);
  assert.equal(parseSecondDoorPath("/second/short"), null);
  assert.equal(parseSecondDoorPath(`/second/${T}/more`), null);
  assert.equal(parseSecondDoorPath(`/text/${T}`), null);
});

/** The second provider: answers every call with `answer`, and records it. */
/** Set to hold the fake provider's answers until it resolves: a call kept in flight. */
let hold: Promise<void> | null = null;
async function withUpstream<R>(answer: (body: Json) => Json, fn: (seen: { headers: http.IncomingHttpHeaders; body: Json }[]) => Promise<R>): Promise<R> {
  const seen: { headers: http.IncomingHttpHeaders; body: Json }[] = [];
  const up = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c: Buffer) => (b += c));
    req.on("end", async () => {
      const j = JSON.parse(b) as Json;
      seen.push({ headers: req.headers, body: j });
      if (hold) await hold;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer(j)));
    });
  });
  await new Promise<void>((r) => up.listen(0, "127.0.0.1", () => r()));
  const host = `127.0.0.1:${(up.address() as { port: number }).port}`;
  usage.resetModelUsageForTests();
  setSupplyLeversForTest([], {});
  gw.setGatewayDepsForTests({ price: (p, m) => (p === "deepseek" && m === "deep-y" ? DEEP : null), balance: async () => 10, key: (p) => (p === "deepseek" ? "real-deepseek-key-0000" : "real-anthropic-key-0000"), host: () => host, plainHttp: () => true });
  const proxy = await startEgressProxy(0);
  const prev = process.env.FOLDRUN_EGRESS_URL;
  process.env.FOLDRUN_EGRESS_URL = `http://127.0.0.1:${proxy.port}`;
  try {
    return await fn(seen);
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_EGRESS_URL;
    else process.env.FOLDRUN_EGRESS_URL = prev;
    await stopEgressProxy();
    gw.setGatewayDepsForTests(null);
    up.close();
  }
}

const reply = (text: string) => () => ({ id: "d1", type: "message", role: "assistant", model: "deep-y", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 500, output_tokens: 100 } });
const tokenOf = (url: string) => url.match(/\/e\/([A-Za-z0-9_-]+)$/)![1]!;
const base = () => process.env.FOLDRUN_EGRESS_URL!;
const ask = (tok: string, body: Json) => fetch(`${base()}/second/${tok}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const anthropicKey = () => ({ FOLDRUN_MODEL_KEY: { value: "marker", hosts: ["api.foldrun.internal"], supply: { provider: "anthropic" } } });

test("a debate through the door: on the platform's key, nothing of the run sent, metered to the run's step, its cost said", async () => {
  await withUpstream(reply("It does not stand."), async (seen) => {
    const lease = (await egressHooks.lease({ tenant: "acme", runId: "r1", step: 2, grant: { secrets: anthropicKey() }, secondModel: { tools: ["debate"], model: "deepseek/deep-y" } }))!;
    const res = await ask(tokenOf(lease.url), { tool: "debate", input: { topic: "cache or not?", position: "cache it" } });
    const body = (await res.json()) as Json;
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.text, "It does not stand.");
    assert.equal(body.model, "deepseek/deep-y");
    assert.equal(body.cost_usd, (500 * 1 + 100 * 4) / 1e6);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.headers["x-api-key"], "real-deepseek-key-0000");
    assert.deepEqual((seen[0]!.body.messages as Json[]).length, 1, "the payload alone, no conversation");
    assert.match(JSON.stringify(seen[0]!.body), /cache or not\?/);
    const calls = await usage.callsOfRun("acme", "r1");
    assert.deepEqual(calls.map((c) => [c.model, c.step]), [["deep-y", 2]], "on the run's step");
    const trace = (await lease.drainLog()).map((l) => JSON.stringify(l)).join("\n");
    assert.match(trace, /second opinion: debate asked of deepseek\/deep-y/);
    assert.match(trace, /second\/debate → 200/);
    await lease.release();
  });
});

test("a review through the door: findings held to the files sent, its text for the model", async () => {
  const findings = JSON.stringify({ summary: "one bug", findings: [{ severity: "high", file: "src/pay.ts", line: 11, title: "division by zero", body: "a / 0" }, { severity: "low", file: "src/other.ts", line: 1, title: "x", body: "y" }] });
  await withUpstream(reply(findings), async () => {
    const lease = (await egressHooks.lease({ tenant: "acme", runId: "r2", step: 0, grant: { secrets: anthropicKey() }, secondModel: { tools: ["review"], model: "deepseek/deep-y" } }))!;
    const res = await ask(tokenOf(lease.url), { tool: "review", input: { diff: DIFF } });
    const body = (await res.json()) as { text: string; review: { findings: unknown[]; dropped: number } };
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.review.findings.length, 1);
    assert.equal(body.review.dropped, 1);
    assert.match(body.text, /\[high\] src\/pay\.ts:11 — division by zero/);
    await lease.release();
  });
});

test("refused before anything is sent: no grant, a tool not granted, no lease, a GET, the step's budget, and the same provider", async () => {
  await withUpstream(reply("never"), async (seen) => {
    const plain = (await egressHooks.lease({ tenant: "acme", runId: "r3", grant: { secrets: anthropicKey() } }))!;
    let res = await ask(tokenOf(plain.url), { tool: "debate", input: { topic: "x" } });
    assert.equal(res.status, 403);
    assert.match(((await res.json()) as { message: string }).message, /holds neither debate nor review/);
    const debateOnly = (await egressHooks.lease({ tenant: "acme", runId: "r3", grant: { secrets: anthropicKey() }, secondModel: { tools: ["debate"], model: "deepseek/deep-y" } }))!;
    res = await ask(tokenOf(debateOnly.url), { tool: "review", input: { diff: DIFF } });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: string }).error, "not_granted");
    res = await ask("z".repeat(32), { tool: "debate", input: { topic: "x" } });
    assert.equal(res.status, 401);
    assert.equal((await fetch(`${base()}/second/${tokenOf(debateOnly.url)}`)).status, 405);
    // The step has a cent left; the worst case of 4096 output tokens at $4/MTok is more.
    res = await ask(tokenOf(debateOnly.url), { tool: "debate", input: { topic: "x" }, max_usd: 0.01 });
    assert.equal(res.status, 402);
    assert.match(((await res.json()) as { message: string }).message, /could cost up to \$0\.01\d+ and the step has \$0\.0100 left/);
    res = await ask(tokenOf(debateOnly.url), { tool: "debate", input: {} });
    assert.equal(res.status, 400);
    // A step on deepseek may not ask deepseek for a second opinion.
    const same = (await egressHooks.lease({ tenant: "acme", runId: "r3", grant: { secrets: { K: { value: "m", hosts: ["api.foldrun.internal"], supply: { provider: "deepseek" } } } }, secondModel: { tools: ["debate"], model: "deepseek/deep-y" } }))!;
    res = await ask(tokenOf(same.url), { tool: "debate", input: { topic: "x" } });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: string }).error, "model_not_allowed");
    assert.equal(seen.length, 0, "nothing reached the second provider");
    for (const l of [plain, debateOnly, same]) await l.release();
  });
});

test("a test run: the second provider's host is not read-safe, so refused before it is sent", async () => {
  await withUpstream(reply("never"), async (seen) => {
    const lease = (await egressHooks.lease({ tenant: "acme", runId: "r4", test: true, grant: { secrets: anthropicKey() }, secondModel: { tools: ["debate"], model: "deepseek/deep-y" } }))!;
    const res = await ask(tokenOf(lease.url), { tool: "debate", input: { topic: "x" } });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: string }).error, "model_not_allowed");
    assert.equal(seen.length, 0);
    await lease.release();
  });
});

test("held at the door whatever the sandbox sends: the lease's ceiling and limits, atomically; a step on its own key by its resolved provider", async () => {
  await withUpstream(reply("It does not stand."), async (seen) => {
    // limits: {debate: 1} — the second is refused, the sandbox's say-so or not.
    const capped = (await egressHooks.lease({ tenant: "acme", runId: "r5", step: 0, grant: { secrets: anthropicKey() }, secondModel: { tools: ["debate"], model: "deepseek/deep-y", uses: { debate: 1 } } }))!;
    assert.equal((await ask(tokenOf(capped.url), { tool: "debate", input: { topic: "x" } })).status, 200);
    let res = await ask(tokenOf(capped.url), { tool: "debate", input: { topic: "y" } });
    assert.equal(res.status, 402);
    assert.match(((await res.json()) as { message: string }).message, /limits: debate 1/);
    // The step's ceiling on the lease, with no max_usd in the body: two calls at once cannot both spend it.
    const tight = (await egressHooks.lease({ tenant: "acme", runId: "r5", step: 1, grant: { secrets: anthropicKey() }, secondModel: { tools: ["debate"], model: "deepseek/deep-y", maxUsd: 0.03 } }))!;
    // One at a time: a second call while the first is still with the provider is refused, so each call's
    // budget is read after the one before it is counted.
    let open!: () => void;
    hold = new Promise<void>((r) => (open = r));
    const before = seen.length;
    const first = ask(tokenOf(tight.url), { tool: "debate", input: { topic: "a" } });
    while (seen.length === before) await new Promise((r) => setTimeout(r, 5));
    res = await ask(tokenOf(tight.url), { tool: "debate", input: { topic: "b" } });
    assert.equal(res.status, 402);
    assert.match(((await res.json()) as { message: string }).message, /one debate or review at a time/);
    open();
    hold = null;
    assert.equal((await first).status, 200);
    // Its own key: the provider the runner resolved. The same one as second_model is refused; none at all too.
    const own = (await egressHooks.lease({ tenant: "acme", runId: "r5", grant: { secrets: {} }, secondModel: { tools: ["debate"], model: "deepseek/deep-y", firstProvider: "deepseek" } }))!;
    res = await ask(tokenOf(own.url), { tool: "debate", input: { topic: "x" } });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: string }).error, "model_not_allowed");
    const unknown = (await egressHooks.lease({ tenant: "acme", runId: "r5", grant: { secrets: {} }, secondModel: { tools: ["debate"], model: "deepseek/deep-y" } }))!;
    res = await ask(tokenOf(unknown.url), { tool: "debate", input: { topic: "x" } });
    assert.equal(res.status, 403);
    assert.match(((await res.json()) as { message: string }).message, /not known/);
    const other = (await egressHooks.lease({ tenant: "acme", runId: "r5", grant: { secrets: {} }, secondModel: { tools: ["debate"], model: "deepseek/deep-y", firstProvider: "openai" } }))!;
    assert.equal((await ask(tokenOf(other.url), { tool: "debate", input: { topic: "x" } })).status, 200);
    assert.equal(seen.length, 3, "only the three that were held reached the second provider");
    // The door's own count of what was spent, for the runner to read back at the step's end.
    const lines = (await capped.drainLog()).filter((l): l is string => typeof l === "string" && l.startsWith("second opinion spent:"));
    assert.equal(lines.length, 1, lines.join("\n"));
    assert.match(lines[0]!, /^second opinion spent: debate \$\d+\.\d{6}$/);
    for (const l of [capped, tight, own, unknown, other]) await l.release();
  });
});
