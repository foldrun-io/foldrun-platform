// Running spend counters (model_spend, 10 Nov 2026): each model call's hold
// is one conditional UPDATE of a counter row per limit, in the same
// transaction as its model_usage row — no lock over the account, no sum of
// the day. These tests hold the counters to what the old sums said.
//
//   FOLDRUN_TEST_DATABASE_URL=postgres://foldrun:test@localhost:55432/foldrun \
//     node --test tests/model-spend-db.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { takeTurnsOnLiveDb } from "./live-db-lock.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
const opts = { skip: url ? false : "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" };
takeTurnsOnLiveDb(url);

if (url) {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  process.env.FOLDRUN_SECRET_KEY ??= "test-install-key";
}

const TOK = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 };

async function setup() {
  const { migrate, ormRequired } = await import("../src/db.ts");
  await migrate();
  const { sql } = await import("drizzle-orm");
  const usage = await import("../src/model-usage.ts");
  const tenant = `spend${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const counter = async (scope: string) => {
    const [r] = (await ormRequired().execute(sql`SELECT usd::text AS usd FROM model_spend WHERE tenant = ${tenant} AND scope = ${scope}`)).rows as { usd: string }[];
    return r ? Number(r.usd) : null;
  };
  const sumDay = async (day: string) => {
    const [r] = (await ormRequired().execute(sql`SELECT coalesce(sum(cost_usd), 0)::text AS s FROM model_usage WHERE tenant = ${tenant} AND day = ${day}`)).rows as { s: string }[];
    return Number(r!.s);
  };
  return { usage, tenant, counter, sumDay, ormRequired, sql };
}

test("concurrent calls cannot pass the account's daily cap together, and the counter equals the day's sum", opts, async () => {
  const { usage, tenant, counter, sumDay } = await setup();
  const day = usage.dayOf(new Date());
  // 40 calls at once, each held at $0.10, under a $1.00 cap: exactly 10 fit.
  const res = await Promise.all(Array.from({ length: 40 }, () => usage.reserveCall({ tenant, kind: "coding", provider: "anthropic", model: "claude-x", estimateUsd: 0.1, priceVersion: 1 }, 1)));
  const ok = res.filter((r) => r.ok);
  assert.equal(ok.length, 10, "exactly the calls that fit");
  const refused = res.find((r) => !r.ok);
  assert.ok(refused && !refused.ok && /daily limit/.test(refused.reason));
  assert.equal(await counter(`day:${day}`), 1);
  assert.equal(await sumDay(day), 1, "the refused calls left no hold behind");
  // Each closes for less than it held: the counter follows the sum down.
  await Promise.all(ok.map((r) => r.ok && usage.closeCall(r.id, { tokens: TOK, costUsd: 0.04 })));
  assert.equal(await counter(`day:${day}`), 0.4);
  assert.equal(await sumDay(day), 0.4);
  assert.equal(await usage.spentToday(tenant), 0.4);
  // A second close of the same row changes nothing.
  await usage.closeCall(ok[0]!.ok ? ok[0]!.id : "", { tokens: TOK, costUsd: 9 });
  assert.equal(await counter(`day:${day}`), 0.4, "a closed row is final");
});

test("a gateway key's limits are held charged (cost × margin), total and per day", opts, async () => {
  const { usage, tenant, counter } = await setup();
  const day = usage.dayOf(new Date());
  const job = "gateway:kspend";
  const call = { tenant, kind: "coding" as const, job, provider: "anthropic", model: "claude-x", estimateUsd: 0.1, priceVersion: 1, margin: 1.5, jobLimits: { capUsd: 1.2, dailyUsd: null } };
  // Each held at $0.15 charged: 8 fit under $1.20.
  const res = await Promise.all(Array.from({ length: 20 }, () => usage.reserveCall(call, 0)));
  assert.equal(res.filter((r) => r.ok).length, 8);
  const no = res.find((r) => !r.ok);
  assert.ok(no && !no.ok && /spending limit/.test(no.reason) && no.capUsd === 1.2);
  assert.equal(await counter(`job:${job}`), 1.2);
  assert.equal(await counter(`jobday:${job}:${day}`), 1.2);
  assert.equal(await counter(`day:${day}`), 0.8, "the account's day is at list price");
  const first = res.find((r) => r.ok)!;
  await usage.closeCall(first.ok ? first.id : "", { tokens: TOK, costUsd: 0.02 });
  assert.equal(await counter(`job:${job}`), 1.08, "0.15 held → 0.03 charged");
  assert.equal(await usage.spentByJob(tenant, job, undefined, 1.5), 1.08, "the counter equals the sum");
  // The key's daily limit refuses on its own.
  const daily = await usage.reserveCall({ ...call, jobLimits: { capUsd: null, dailyUsd: 1.1 } }, 0);
  assert.ok(!daily.ok && /daily limit/.test(daily.reason) && daily.spentUsd === 1.08);
});

test("a counter made part-way through a day starts from the rows already there", opts, async () => {
  const { usage, tenant, counter, ormRequired, sql } = await setup();
  const day = usage.dayOf(new Date());
  // Rows from before the counters (as after the deploy that adds them).
  await ormRequired().execute(sql`
    INSERT INTO model_usage (id, tenant, day, kind, job, provider, model, cost_usd, status, price_version, margin)
    SELECT 'mu_seed_' || ${tenant} || '_' || g, ${tenant}, ${day}, 'coding', 'gateway:kseed', 'anthropic', 'claude-x', 0.25, 'closed', 1, CASE WHEN g = 1 THEN NULL ELSE 2 END
    FROM generate_series(1, 4) g`);
  // Many first calls at once: the counter is made once and every hold is on it.
  const res = await Promise.all(Array.from({ length: 12 }, () => usage.reserveCall({ tenant, kind: "coding", job: "gateway:kseed", provider: "anthropic", model: "claude-x", estimateUsd: 0.1, priceVersion: 1, margin: 3, jobLimits: { capUsd: null, dailyUsd: null } }, 2)));
  assert.equal(res.filter((r) => r.ok).length, 10, "$1.00 already spent: ten $0.10 holds fit under $2.00");
  assert.equal(await counter(`day:${day}`), 2);
  // job: 0.25 × 3 (no margin on the row: the call's) + 3 × 0.25 × 2 + 10 × 0.1 × 3
  assert.equal(await counter(`job:gateway:kseed`), 0.75 + 1.5 + 3);
});

test("a call that closes after its row was settled leaves the counter at the hold", opts, async () => {
  const { usage, tenant, counter } = await setup();
  const day = usage.dayOf(new Date());
  const r = await usage.reserveCall({ tenant, kind: "coding", provider: "anthropic", model: "claude-x", estimateUsd: 0.5, priceVersion: 1 }, 0);
  assert.ok(r.ok);
  await usage.markSettled([r.id], `settle-${tenant}`);
  await usage.closeCall(r.id, { tokens: TOK, costUsd: 0.01 });
  assert.equal(await counter(`day:${day}`), 0.5, "the settled estimate is the charge");
  const e = await usage.reserveCall({ tenant, kind: "coding", provider: "anthropic", model: "claude-x", estimateUsd: 0.2, priceVersion: 1 }, 0);
  assert.ok(e.ok);
  await usage.closeCall(e.id, { estimated: true });
  assert.equal(await counter(`day:${day}`), 0.7, "an estimated close keeps its hold");
});

test("first calls at once with no cap are never refused, and a close during the first fill is counted once (Codex)", opts, async () => {
  const { usage, ormRequired, sql } = await setup();
  const day = usage.dayOf(new Date());
  for (let round = 0; round < 15; round++) {
    const tenant = `race${Date.now()}${round}${Math.floor(Math.random() * 1e6)}`;
    const job = "gateway:krace";
    // Two calls held before the counters existed: one with a margin, one without.
    await ormRequired().execute(sql`
      INSERT INTO model_usage (id, tenant, day, kind, job, provider, model, cost_usd, status, price_version, margin)
      VALUES (${`mu_old1_${tenant}`}, ${tenant}, ${day}, 'coding', ${job}, 'anthropic', 'claude-x', 1, 'open', 1, 2),
             (${`mu_old2_${tenant}`}, ${tenant}, ${day}, 'coding', ${job}, 'anthropic', 'claude-x', 1, 'open', 1, NULL)`);
    const call = { tenant, kind: "coding" as const, job, provider: "anthropic", model: "claude-x", estimateUsd: 0.1, priceVersion: 1, margin: 3, jobLimits: { capUsd: null, dailyUsd: null } };
    const [res] = await Promise.all([
      Promise.all(Array.from({ length: 8 }, () => usage.reserveCall(call, 0))),
      usage.closeCall(`mu_old1_${tenant}`, { tokens: TOK, costUsd: 0.25 }),
      usage.closeCall(`mu_old2_${tenant}`, { tokens: TOK, costUsd: 0 }),
    ]);
    assert.equal(res.filter((r) => r.ok).length, 8, `round ${round}: no cap, nothing refused`);
    const read = async (scope: string) => {
      const [r] = (await ormRequired().execute(sql`SELECT usd::text AS usd FROM model_spend WHERE tenant = ${tenant} AND scope = ${scope}`)).rows as { usd: string }[];
      return Number(r!.usd);
    };
    const [d] = (await ormRequired().execute(sql`SELECT coalesce(sum(cost_usd), 0)::text AS s FROM model_usage WHERE tenant = ${tenant} AND day = ${day}`)).rows as { s: string }[];
    // A close that lands while its counter is first made may leave its hold
    // there (more than it cost); never less than the rows hold.
    const dayCounter = await read(`day:${day}`);
    assert.ok(dayCounter >= Number(d!.s) && dayCounter <= Number(d!.s) + 1 + 1, `round ${round}: the day's counter ${dayCounter} against the sum ${d!.s}`);
    // 0.25 × 2 + 8 × 0.1 × 3, and the row with no margin stays at its hold
    // (1 × 3, as the first fill valued it) whenever the fill ran — before or
    // after its close.
    const job0 = await read(`job:${job}`);
    assert.ok([0.5 + 2.4, 0.5 + 2.4 + 3, 2 + 2.4, 2 + 2.4 + 3].some((v) => Math.abs(v - job0) < 1e-9), `round ${round}: the key's counter ${job0}`);
    assert.ok(job0 >= (await usage.spentByJob(tenant, job, undefined, 3)), "never under the rows' sum");
  }
});

test("a key's counter moves by the charge rounded at each end, as its hold was (Codex)", opts, async () => {
  const { usage, tenant, counter } = await setup();
  const job = "gateway:kround";
  for (let i = 0; i < 50; i++) {
    const r = await usage.reserveCall({ tenant, kind: "coding", job, provider: "anthropic", model: "claude-x", estimateUsd: 0.000003, priceVersion: 1, margin: 1.2, jobLimits: { capUsd: null, dailyUsd: null } }, 0);
    assert.ok(r.ok);
    await usage.closeCall(r.id, { tokens: TOK, costUsd: 0.000002 });
  }
  // Each call: held 0.000004 (0.0000036 rounded), charged 0.000002 (0.0000024 rounded).
  assert.equal(await counter(`job:${job}`), 0.0001, "50 × 0.000002");
});

test("a write the counting code did not make (the last release, after a rollback) clears the counters; the next call fills them from the rows (Codex)", opts, async () => {
  const { usage, tenant, counter, sumDay, ormRequired, sql } = await setup();
  const day = usage.dayOf(new Date());
  const first = await usage.reserveCall({ tenant, kind: "coding", provider: "anthropic", model: "claude-x", estimateUsd: 0.5, priceVersion: 1 }, 2);
  assert.ok(first.ok);
  assert.equal(await counter(`day:${day}`), 0.5);
  // The previous release: a row written with no counter moved, then a close.
  await ormRequired().execute(sql`INSERT INTO model_usage (id, tenant, day, kind, provider, model, cost_usd, status, price_version) VALUES (${`mu_prev_${tenant}`}, ${tenant}, ${day}, 'coding', 'anthropic', 'claude-x', 1, 'open', 1)`);
  assert.equal(await counter(`day:${day}`), null, "cleared by the guard");
  await usage.reserveCall({ tenant, kind: "coding", provider: "anthropic", model: "claude-x", estimateUsd: 0.1, priceVersion: 1 }, 2);
  assert.equal(await counter(`day:${day}`), 1.6, "refilled: 0.5 + 1 + 0.1");
  await ormRequired().execute(sql`UPDATE model_usage SET cost_usd = 0.2, status = 'closed' WHERE id = ${`mu_prev_${tenant}`}`);
  assert.equal(await counter(`day:${day}`), null, "a close by the previous release clears them too");
  const over = await usage.reserveCall({ tenant, kind: "coding", provider: "anthropic", model: "claude-x", estimateUsd: 1.5, priceVersion: 1 }, 2);
  assert.ok(!over.ok, "0.8 spent + 1.5 is past the $2 cap");
  assert.equal(await counter(`day:${day}`), 0.8);
  assert.equal(await sumDay(day), 0.8);
  // The counting code's own writes leave the counters in place.
  await usage.closeCall(first.ok ? first.id : "", { tokens: TOK, costUsd: 0.1 });
  assert.equal(await counter(`day:${day}`), 0.4);
});

test("during a rollout, the last release's admission and the counters cannot both take a limit's last room (Codex)", opts, async () => {
  const { usage, ormRequired, sql } = await setup();
  const { tx } = await import("../src/db.ts");
  const day = usage.dayOf(new Date());
  for (let round = 0; round < 25; round++) {
    const tenant = `roll${Date.now()}${round}${Math.floor(Math.random() * 1e6)}`;
    // The release before: an exclusive lock per account, the day's sum, an insert.
    let n = 0;
    const oldAdmit = () =>
      tx(async (t) => {
        await t.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"model-supply:" + tenant}))`);
        const [r] = (await t.execute(sql`SELECT coalesce(sum(cost_usd), 0)::text AS s FROM model_usage WHERE tenant = ${tenant} AND day = ${day}`)).rows as { s: string }[];
        if (Number(r!.s) + 0.1 > 1 + 1e-9) return false;
        await t.execute(sql`INSERT INTO model_usage (id, tenant, day, kind, provider, model, cost_usd, status, price_version) VALUES (${`mu_oldrel_${tenant}_${n++}`}, ${tenant}, ${day}, 'coding', 'anthropic', 'claude-x', 0.1, 'open', 1)`);
        return true;
      });
    const newAdmit = async () => (await usage.reserveCall({ tenant, kind: "coding", provider: "anthropic", model: "claude-x", estimateUsd: 0.1, priceVersion: 1 }, 1)).ok;
    // A new call first, so the counter exists; then both releases at once.
    assert.ok(await newAdmit());
    await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 2 ? oldAdmit() : newAdmit())));
    const [d] = (await ormRequired().execute(sql`SELECT coalesce(sum(cost_usd), 0)::text AS s FROM model_usage WHERE tenant = ${tenant} AND day = ${day}`)).rows as { s: string }[];
    assert.ok(Number(d!.s) <= 1 + 1e-9, `round ${round}: $${d!.s} admitted under a $1 cap`);
  }
});
