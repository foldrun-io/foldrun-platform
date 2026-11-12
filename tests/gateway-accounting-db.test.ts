// Accounting, end to end, on Postgres (10 Nov 2026): Claude Code's calls
// through the gateway door to a provider that reports exact usage, and every
// dollar checked — each call's cost from the price list, the margin kept on
// its row, the key's and the account's spend and running counters, the
// limits under concurrent calls, a cut-off reply, a provider's error, a
// margin changed half way, and the settlement into the ledger.
//
//   FOLDRUN_TEST_DATABASE_URL=postgres://foldrun:test@localhost:55432/foldrun \
//     node --test tests/gateway-accounting-db.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { takeTurnsOnLiveDb } from "./live-db-lock.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
// Paid gateway accounting is the hosted build's (foldrun-admin lays
// src/model-settle.ts and the price list over this repo). The public build
// has neither, so with a database but no billing — GitHub CI here — every
// case failed (402s, a missing module) from 3f34f25 on. The hosted check
// (foldrun-admin scripts/check.sh) and the deploy gate run it.
const hosted = fs.existsSync(path.join(import.meta.dirname, "../src/model-settle.ts"));
const opts = { skip: !url ? "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" : !hosted ? "needs the hosted build's billing (foldrun-admin overlay)" : false };
takeTurnsOnLiveDb(url);

process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-gw-accounting-"));
process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE = "1";
if (url) {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  process.env.FOLDRUN_SECRET_KEY ??= "test-install-key";
}
// The price list (USD per million tokens: input, output, cache read, cache
// write; max output) and the margin, as the operator sets them.
const IN = 3, OUT = 15, CR = 0.3, CW = 3.75;
process.env.FOLDRUN_MODEL_PRICES = JSON.stringify({ "anthropic/claude-x": [IN, OUT, CR, CW, 8000] });
process.env.FOLDRUN_MARGIN = "1.2";
process.env.FOLDRUN_BILLING = "1";
process.env.FOLDRUN_MODEL_SUPPLY = "1";

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const costOf = (u: { in: number; out: number; cr?: number; cw?: number }) => r6((u.in * IN + u.out * OUT + (u.cr ?? 0) * CR + (u.cw ?? 0) * CW) / 1e6);

/** A provider that answers with exactly the usage the prompt asks for:
 *  "in=1000 out=200 cr=0 cw=0", "cut" (no last word on usage), "fail" (a
 *  500), "slow" (300 ms before answering). */
function provider() {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const j = JSON.parse(body || "{}");
      const text: string = j.messages?.[0]?.content ?? "";
      seen.push(text);
      const n = (k: string) => Number(text.match(new RegExp(`${k}=(\\d+)`))?.[1] ?? 0);
      const answer = () => {
        if (text.includes("fail")) {
          res.writeHead(500, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "provider broke" } }));
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const ev = (o: object) => res.write(`event: x\ndata: ${JSON.stringify(o)}\n\n`);
        ev({ type: "message_start", message: { usage: { input_tokens: n("in"), cache_read_input_tokens: n("cr"), cache_creation_input_tokens: n("cw"), output_tokens: 1 } } });
        ev({ type: "content_block_delta", delta: { type: "text_delta", text: "ok" } });
        if (text.includes("cut")) return void res.end();
        ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: n("out") } });
        res.end(`event: x\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      };
      if (text.includes("slow")) setTimeout(answer, 300);
      else answer();
    });
  });
  return new Promise<{ host: string; seen: string[]; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ host: `127.0.0.1:${(server.address() as { port: number }).port}`, seen, close: () => server.close() }));
  });
}

async function setup(gateway: { capUsd: number | null; dailyUsd: number | null }, accountDaily?: number) {
  const { migrate, ormRequired } = await import("../src/db.ts");
  await migrate();
  const { sql } = await import("drizzle-orm");
  const door = await import("../src/gateway-door.ts");
  const gw = await import("../src/model-gateway.ts");
  const usage = await import("../src/model-usage.ts");
  const { setSupplyLeversForTest } = await import("../src/settings.ts");
  const tenant = `acct${Date.now()}${crypto.randomInt(1e6)}`;
  const keyId = `k${crypto.randomInt(1e9)}`;
  const secret = `mda_${crypto.randomBytes(12).toString("hex")}`;
  const hash = crypto.createHash("sha256").update(secret).digest("hex");
  door.setGatewayKeyLookupForTests(async (h) =>
    h === hash ? ({ id: keyId, hash, prefix: "mda_test", label: "acct", tenant, createdAt: new Date().toISOString(), revokedAt: null, role: "viewer", workspaces: null, purpose: "gateway", gateway } as never) : null,
  );
  door.setGatewayTouchForTests(async () => {});
  setSupplyLeversForTest([], accountDaily === undefined ? {} : { [tenant]: accountDaily });
  const up = await provider();
  gw.setGatewayDepsForTests({ balance: async () => 1000, key: () => "platform-key", host: () => up.host, plainHttp: () => true });
  const d = await door.startGatewayDoor(0);
  const base = `http://127.0.0.1:${d.port}`;
  const send = (content: string, maxTokens = 4000) =>
    fetch(`${base}/v1/messages?beta=true`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": secret },
      body: JSON.stringify({ model: "claude-x", max_tokens: maxTokens, stream: true, messages: [{ role: "user", content }] }),
    }).then(async (r) => ({ status: r.status, text: await r.text() }));
  const rows = async () =>
    (await ormRequired().execute(sql`SELECT status, cost_usd::float8 AS cost, margin::float8 AS margin, input_tokens AS i, output_tokens AS o, cache_read_tokens AS cr, cache_write_tokens AS cw, job, kind, settled_key FROM model_usage WHERE tenant = ${tenant} ORDER BY created_at`)).rows as {
      status: string; cost: number; margin: number; i: number; o: number; cr: number; cw: number; job: string; kind: string; settled_key: string | null;
    }[];
  const counter = async (scope: string) => {
    const [r] = (await ormRequired().execute(sql`SELECT usd::float8 AS usd FROM model_spend WHERE tenant = ${tenant} AND scope = ${scope}`)).rows as { usd: number }[];
    return r?.usd ?? null;
  };
  const day = usage.dayOf(new Date());
  const job = `gateway:${keyId}`;
  const close = async () => {
    await d.close();
    up.close();
    gw.setGatewayDepsForTests(null);
    door.setGatewayKeyLookupForTests(null);
    door.setGatewayTouchForTests(null);
  };
  return { tenant, job, day, send, rows, counter, usage, close, up, base, secret };
}

test("every call is charged exactly the price list's cost of what the provider reported, at the margin kept on its row", opts, async () => {
  const t = await setup({ capUsd: 100, dailyUsd: null });
  try {
    const calls = [
      { in: 1000, out: 200 },
      { in: 12345, out: 678, cr: 50000, cw: 2000 },
      { in: 1, out: 1 },
      { in: 0, out: 0, cr: 200000 },
      { in: 300000, out: 8000, cw: 100000 },
    ];
    for (const c of calls) {
      const r = await t.send(`in=${c.in} out=${c.out} cr=${c.cr ?? 0} cw=${c.cw ?? 0}`);
      assert.equal(r.status, 200, r.text);
    }
    const rows = await t.rows();
    assert.equal(rows.length, calls.length);
    rows.forEach((row, i) => {
      const c = calls[i]!;
      assert.equal(row.status, "closed");
      assert.equal(row.kind, "coding");
      assert.equal(row.job, t.job, "booked to the key's own job");
      assert.deepEqual([row.i, row.o, row.cr, row.cw], [c.in, c.out, c.cr ?? 0, c.cw ?? 0], `call ${i}: the tokens the provider reported`);
      assert.equal(row.cost, costOf(c), `call ${i}: cost = tokens × the list's price`);
      assert.equal(row.margin, 1.2, `call ${i}: the margin in force, kept on the row`);
    });
    const list = r6(calls.reduce((n, c) => n + costOf(c), 0));
    const charged = r6(calls.reduce((n, c) => n + r6(costOf(c) * 1.2), 0));
    assert.equal(await t.usage.spentToday(t.tenant), list, "the account's day, at list price");
    assert.equal(await t.counter(`day:${t.day}`), list, "its running counter agrees");
    assert.equal(await t.usage.spentByJob(t.tenant, t.job, undefined, 1.2), charged, "the key's spend, charged (× 1.2)");
    assert.equal(await t.counter(`job:${t.job}`), charged, "the key's running counter agrees");
    assert.equal(await t.counter(`jobday:${t.job}:${t.day}`), charged);
  } finally {
    await t.close();
  }
});

test("a reply cut short is charged at its hold; a provider's error at nothing; the free routes write no row", opts, async () => {
  const t = await setup({ capUsd: 100, dailyUsd: null });
  try {
    const cut = await t.send("in=500 out=100 cut");
    assert.equal(cut.status, 200);
    const fail = await t.send("in=500 out=100 fail");
    assert.equal(fail.status, 500);
    assert.match(fail.text, /provider broke/);
    const count = await fetch(`${t.base}/v1/messages/count_tokens`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": t.secret }, body: JSON.stringify({ model: "claude-x", messages: [{ role: "user", content: "hi" }] }) });
    await count.text();
    const models = await fetch(`${t.base}/v1/models`, { headers: { "x-api-key": t.secret } });
    await models.text();
    const rows = await t.rows();
    assert.equal(rows.length, 2, "only the two metered calls");
    assert.equal(rows[0]!.status, "estimated", "no last word on usage: the hold stands");
    assert.ok(rows[0]!.cost > costOf({ in: 500, out: 100 }), "the hold is above what it reported so far");
    assert.equal(rows[1]!.status, "closed");
    assert.equal(rows[1]!.cost, 0, "the provider's error costs nothing");
    assert.equal(await t.counter(`day:${t.day}`), r6(rows[0]!.cost), "the counter holds the cut call's hold alone");
    assert.equal(await t.counter(`job:${t.job}`), r6(rows[0]!.cost * 1.2));
  } finally {
    await t.close();
  }
});

test("concurrent calls never spend past the key's limit, and each refusal is a 402 that says so", opts, async () => {
  // Each call is held at its most (4000 output tokens: $0.06 + input, × 1.2
  // ≈ $0.072); 30 at once (under the 32 a key may have open) against a
  // $0.50 limit.
  const t = await setup({ capUsd: 0.5, dailyUsd: null });
  try {
    const all = await Promise.all(Array.from({ length: 30 }, () => t.send("in=1000 out=200 slow")));
    const ok = all.filter((r) => r.status === 200).length;
    const refused = all.filter((r) => r.status === 402);
    assert.equal(ok + refused.length, 30, `only 200 or 402: ${[...new Set(all.map((r) => r.status))]}`);
    assert.ok(ok >= 1 && ok <= 6, `the calls held at once fit under $0.50: ${ok}`);
    assert.match(refused[0]!.text, /spending limit/);
    const rows = await t.rows();
    assert.equal(rows.length, ok, "a refused call leaves no row");
    const charged = r6(rows.reduce((n, r) => n + r6(r.cost * r.margin), 0));
    assert.ok(charged <= 0.5, `spent ${charged} under a $0.50 limit`);
    assert.equal(await t.counter(`job:${t.job}`), charged, "the counter agrees with the rows after every close");
    // The holds released: the key has room again for calls one at a time.
    const later = await t.send("in=1000 out=200");
    assert.equal(later.status, 200, "room again once the holds closed at what they cost");
  } finally {
    await t.close();
  }
});

test("the account's daily cap (list price) stops calls from every key with a 402", opts, async () => {
  const t = await setup({ capUsd: null, dailyUsd: null }, 0.2);
  try {
    const all = await Promise.all(Array.from({ length: 20 }, () => t.send("in=1000 out=200 slow")));
    const ok = all.filter((r) => r.status === 200).length;
    assert.ok(all.every((r) => r.status === 200 || r.status === 402), JSON.stringify([...new Set(all.map((r) => r.status))]));
    assert.match(all.find((r) => r.status === 402)!.text, /daily limit/);
    const spent = await t.usage.spentToday(t.tenant);
    assert.ok(spent <= 0.2, `the day's list-price spend ${spent} is within $0.20`);
    assert.ok(ok >= 1);
  } finally {
    await t.close();
  }
});

test("settlement charges each call at its own margin, once — a margin changed half way re-prices nothing", opts, async () => {
  const t = await setup({ capUsd: 100, dailyUsd: null });
  const { settleModelCalls } = await import("../src/model-settle.ts");
  const { readLedger } = await import("../src/ledger.ts");
  try {
    await t.send("in=10000 out=2000"); // $0.06 at 1.2
    await t.send("in=20000 out=1000"); // $0.075 at 1.2
    process.env.FOLDRUN_MARGIN = "1.5";
    await t.send("in=10000 out=2000"); // $0.06 at 1.5
    const rows = await t.rows();
    assert.deepEqual(rows.map((r) => r.margin), [1.2, 1.2, 1.5]);
    const expected = r6(rows.reduce((n, r) => n + r.cost * r.margin, 0));
    const first = await settleModelCalls();
    assert.ok(first.calls >= 3, JSON.stringify(first));
    const lines = (await readLedger(t.tenant)).filter((l) => (l.note ?? "").includes("foldrun's models"));
    const charged = r6(lines.reduce((n, l) => n - l.usd, 0));
    assert.ok(Math.abs(charged - expected) < 0.000011, `ledger ${charged} = Σ cost × each row's margin ${expected}`);
    assert.ok(lines.length >= 1);
    assert.ok((await t.rows()).every((r) => r.settled_key), "every call is marked settled");
    const again = await settleModelCalls();
    const after = (await readLedger(t.tenant)).filter((l) => (l.note ?? "").includes("foldrun's models"));
    assert.equal(after.length, lines.length, `a second sweep charges nothing more (${JSON.stringify(again)})`);
  } finally {
    process.env.FOLDRUN_MARGIN = "1.2";
    await t.close();
  }
});

test("a key has at most 32 calls open at once: the 33rd is a 429 that says so, and nothing is held for it", opts, async () => {
  const t = await setup({ capUsd: 100, dailyUsd: null });
  try {
    const all = await Promise.all(Array.from({ length: 40 }, () => t.send("in=100 out=10 slow")));
    const ok = all.filter((r) => r.status === 200).length;
    const busy = all.filter((r) => r.status === 429);
    assert.equal(ok, 32, "32 open at once");
    assert.equal(busy.length, 8);
    assert.match(busy[0]!.text, /32 calls open at once/);
    assert.equal((await t.rows()).length, 32, "a call turned away for room holds nothing");
    assert.equal((await t.send("in=100 out=10")).status, 200, "the slots come back as calls finish");
  } finally {
    await t.close();
  }
});
