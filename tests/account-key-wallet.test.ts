// FOL-208: an "account" gateway key's wallet budget. Calls the plan covers
// never count against it; calls the wallet pays do, held at the most they
// could cost, closed at what they cost; 0 means the plan alone pays. Every
// call keeps the reason its payer was chosen.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { takeTurnsOnLiveDb } from "./live-db-lock.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
const live = { skip: !url ? "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" : false };
takeTurnsOnLiveDb(url);

process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-account-key-"));
if (url) {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  process.env.FOLDRUN_SECRET_KEY ??= "test-install-key";
}

async function setup() {
  const { migrate, orm } = await import("../src/db.ts");
  await migrate();
  await orm()!.execute("TRUNCATE model_usage, model_spend");
  return import("../src/model-usage.ts");
}

const call = (over: Record<string, unknown> = {}) => ({
  tenant: "acme",
  kind: "coding" as const,
  job: "gateway:acct1",
  provider: "deepseek",
  model: "deepseek-v4",
  estimateUsd: 0.4,
  priceVersion: 1,
  margin: 1,
  ...over,
});
const tokens = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 };

test("an account key with no wallet budget is the plan's alone: covered calls pass, a wallet call is refused and says why", live, async () => {
  const usage = await setup();
  const limits = { capUsd: 100, dailyUsd: null, walletUsd: 0 };
  const covered = await usage.reserveCall({ ...call(), covered: true, jobLimits: limits, payerReason: "plan" }, 1000);
  assert.equal(covered.ok, true, "the plan pays: the wallet budget does not count it");
  const paid = await usage.reserveCall({ ...call(), jobLimits: limits, payerReason: "wallet-extra-usage" }, 1000);
  assert.equal(paid.ok, false);
  assert.match((paid as { reason: string }).reason, /paid by the plan only/);
});

test("a wallet budget holds wallet calls at their hold, frees what a close did not cost, and ignores covered calls", live, async () => {
  const usage = await setup();
  const limits = { capUsd: 100, dailyUsd: null, walletUsd: 1 };
  const a = await usage.reserveCall({ ...call(), jobLimits: limits, payerReason: "wallet" }, 1000);
  const b = await usage.reserveCall({ ...call(), jobLimits: limits, payerReason: "wallet" }, 1000);
  assert.equal(a.ok && b.ok, true, "two holds of 0.40 fit 1.00");
  const c = await usage.reserveCall({ ...call(), jobLimits: limits, payerReason: "wallet" }, 1000);
  assert.equal(c.ok, false, "a third does not: 1.20 > 1.00");
  assert.match((c as { reason: string }).reason, /wallet budget has no room/);
  // Covered calls go by, whatever the wallet budget holds.
  for (let i = 0; i < 3; i++) assert.equal((await usage.reserveCall({ ...call(), covered: true, jobLimits: limits, payerReason: "plan" }, 1000)).ok, true);
  // A close at what it cost frees the rest of its hold.
  await usage.closeCall((a as { id: string }).id, { tokens, costUsd: 0.05 });
  const d = await usage.reserveCall({ ...call(), jobLimits: limits, payerReason: "wallet" }, 1000);
  assert.equal(d.ok, true, "0.05 + 0.40 + 0.40 fits");
});

test("the payer's reason is kept on each call", live, async () => {
  const usage = await setup();
  const r = await usage.reserveCall({ ...call(), covered: true, payerReason: "plan-finishing" }, 1000);
  const { orm } = await import("../src/db.ts");
  const got = (await orm()!.execute(`SELECT payer_reason FROM model_usage WHERE id = '${(r as { id: string }).id}'`)).rows as { payer_reason: string }[];
  assert.equal(got[0]?.payer_reason, "plan-finishing");
});

test("a key with no wallet budget field (metered, login) has no wallet counter", live, async () => {
  const usage = await setup();
  const limits = { capUsd: 100, dailyUsd: null };
  for (let i = 0; i < 4; i++) assert.equal((await usage.reserveCall({ ...call(), jobLimits: limits }, 1000)).ok, true);
  const { orm } = await import("../src/db.ts");
  const scopes = ((await orm()!.execute("SELECT scope FROM model_spend")).rows as { scope: string }[]).map((r) => r.scope);
  assert.ok(!scopes.some((s) => s.startsWith("jobwallet:")), scopes.join(", "));
});

test("a grant's field changes against the row as it is now: two edits never undo each other; walletUsd only on an account key", live, async () => {
  await setup();
  const keys = await import("../src/api-keys-db.ts");
  const { orm } = await import("../src/db.ts");
  await orm()!.execute("DELETE FROM api_keys WHERE tenant = 'acme'");
  const row = (id: string, gateway: Record<string, unknown>) => ({ id, hash: `h-${id}`, prefix: `fr_gw_${id}`, label: id, tenant: "acme", createdAt: new Date().toISOString(), revokedAt: null, role: "viewer" as const, purpose: "gateway" as const, gateway: gateway as never });
  await keys.insertApiKeyDb(row("acct", { capUsd: null, dailyUsd: 50, credential: "account", walletUsd: 20 }));
  await keys.insertApiKeyDb(row("meter", { capUsd: 10, dailyUsd: null }));
  await Promise.all([keys.patchGatewayGrantDb("acme", "acct", "walletUsd", 0, "account"), keys.patchGatewayGrantDb("acme", "acct", "models", { sonnet: "deepseek/deepseek-v4" })]);
  const g = ((await orm()!.execute("SELECT gateway FROM api_keys WHERE id = 'acct'")).rows[0] as { gateway: Record<string, unknown> }).gateway;
  assert.equal(g.walletUsd, 0, "the lowered budget stands");
  assert.deepEqual(g.models, { sonnet: "deepseek/deepseek-v4" });
  assert.equal(g.dailyUsd, 50);
  assert.equal(await keys.patchGatewayGrantDb("acme", "meter", "walletUsd", 5, "account"), false, "not an account key");
  assert.equal(await keys.patchGatewayGrantDb("acme", "acct", "models", null), true);
  const h = ((await orm()!.execute("SELECT gateway FROM api_keys WHERE id = 'acct'")).rows[0] as { gateway: Record<string, unknown> }).gateway;
  assert.equal("models" in h, false, "null removes the field");
});

test("a wallet call closed with no usage is billed at the estimate: the wallet bound held above it is given back", live, async () => {
  const usage = await setup();
  const { orm } = await import("../src/db.ts");
  const limits = { capUsd: 100, dailyUsd: null, walletUsd: 1 };
  // Held at a wallet bound of 0.90, estimated at 0.30.
  const a = await usage.reserveCall({ ...call(), estimateUsd: 0.9, jobLimits: limits, payerReason: "wallet" }, 1000);
  assert.equal(a.ok, true);
  await usage.closeCall((a as { id: string }).id, { estimated: true, costUsd: 0.3 });
  const row = (await orm()!.execute(`SELECT status, cost_usd::float AS cost FROM model_usage WHERE id = '${(a as { id: string }).id}'`)).rows[0] as { status: string; cost: number };
  assert.equal(row.status, "estimated");
  assert.equal(row.cost, 0.3);
  // 0.30 spent of 1.00: a 0.60 hold fits, a further 0.20 does not.
  const b = await usage.reserveCall({ ...call(), estimateUsd: 0.6, jobLimits: limits, payerReason: "wallet" }, 1000);
  assert.equal(b.ok, true, "the bound's rest came back to the budget");
  const c = await usage.reserveCall({ ...call(), estimateUsd: 0.2, jobLimits: limits, payerReason: "wallet" }, 1000);
  assert.equal(c.ok, false);
  // An estimate never raises a row over its hold.
  await usage.closeCall((b as { id: string }).id, { estimated: true, costUsd: 5 });
  const rb = (await orm()!.execute(`SELECT cost_usd::float AS cost FROM model_usage WHERE id = '${(b as { id: string }).id}'`)).rows[0] as { cost: number };
  assert.equal(rb.cost, 0.6);
});

test("a wallet call still open when settled is billed at its estimate, not its bound; a plan-only key refuses even a call that costs nothing", live, async () => {
  const usage = await setup();
  const { orm } = await import("../src/db.ts");
  const a = await usage.reserveCall({ ...call(), estimateUsd: 0.9, billingEstimateUsd: 0.3, jobLimits: { capUsd: 100, dailyUsd: null, walletUsd: 5 }, payerReason: "wallet" }, 1000);
  assert.equal(a.ok, true);
  const id = (a as { id: string }).id;
  assert.equal(await usage.markSettled([id], "k-stale"), 1);
  const row = (await orm()!.execute(`SELECT status, cost_usd::float AS cost FROM model_usage WHERE id = '${id}'`)).rows[0] as { status: string; cost: number };
  assert.deepEqual(row, { status: "estimated", cost: 0.3 });
  const counters = Object.fromEntries(((await orm()!.execute("SELECT scope, usd::float AS usd FROM model_spend WHERE tenant = 'acme'")).rows as { scope: string; usd: number }[]).map((x) => [x.scope.split(":")[0], x.usd]));
  assert.equal(counters.jobwallet, 0.3, "the wallet counter moved from the bound to the estimate, in place");
  assert.equal(counters.job, 0.3);
  const free = await usage.reserveCall({ ...call(), estimateUsd: 0, jobLimits: { capUsd: 100, dailyUsd: null, walletUsd: 0 }, payerReason: "wallet" }, 1000);
  assert.equal(free.ok, false);
  assert.match((free as { reason: string }).reason, /paid by the plan only/);
});

test("an older release's settlement (which does not know estimate_usd) still bills a still-open wallet call at its estimate", live, async () => {
  const usage = await setup();
  const { orm } = await import("../src/db.ts");
  const a = await usage.reserveCall({ ...call(), estimateUsd: 0.9, billingEstimateUsd: 0.25, jobLimits: { capUsd: 100, dailyUsd: null, walletUsd: 5 }, payerReason: "wallet" }, 1000);
  const id = (a as { id: string }).id;
  // The claim as a release before FOL-208 writes it: no cost in it.
  await orm()!.execute(`UPDATE model_usage SET settled_key = 'old-release', settled_at = now(), status = CASE WHEN status = 'open' THEN 'estimated' ELSE status END, closed_at = coalesce(closed_at, now()) WHERE id = '${id}' AND settled_key IS NULL`);
  const row = (await orm()!.execute(`SELECT status, cost_usd::float AS cost FROM model_usage WHERE id = '${id}'`)).rows[0] as { status: string; cost: number };
  assert.deepEqual(row, { status: "estimated", cost: 0.25 });
  const left = (await orm()!.execute("SELECT count(*)::int AS n FROM model_spend WHERE tenant = 'acme'")).rows[0] as { n: number };
  assert.equal(left.n, 0, "the counters are cleared, to be filled again from the rows");
  // Filled again from the rows: 0.25 spent of 5, so a 4.70 hold fits.
  const b = await usage.reserveCall({ ...call(), estimateUsd: 4.7, jobLimits: { capUsd: 100, dailyUsd: null, walletUsd: 5 }, payerReason: "wallet" }, 1000);
  assert.equal(b.ok, true, "the bound's rest is free again");
});
