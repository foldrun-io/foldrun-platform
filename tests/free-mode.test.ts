// The engine without foldrun's billing — what a public checkout and a
// self-hosted install run.
//
// The first tests check freeBilling itself and run everywhere. The rest run
// only where billing is absent (billing() answers freeBilling), which is the
// public repository's CI: there they are the proof that a run is recorded at
// its model tokens, that spend budgets still hold, and that nothing asks for
// money. Where billing is present they are skipped, and the billing tests in
// foldrun-admin cover the same paths with prices.
//
//   node --test tests/free-mode.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { billing, freeBilling } from "../src/billing.ts";
import { edition, readLedger, recordRunCost, attributeToAgents } from "../src/ledger.ts";
import { accountConcurrency } from "../src/limits.ts";
import { enqueueFlowRun, heldForRunsUsd } from "../src/queue.ts";
import { settleRun } from "../src/settle.ts";
import { readRun, writeRun } from "../../foldrun-core/src/store.ts";

const withBilling = billing() !== freeBilling ? "foldrun's billing is present here; its own tests cover this" : false;
const STEP = { agent: "writer", instruction: "draft it", group: 1, optional: false };
const VARS = ["FOLDRUN_DATA", "FOLDRUN_BILLING", "FOLDRUN_EDITION", "STRIPE_SECRET_KEY", "FOLDRUN_MARGIN", "FOLDRUN_COMPUTE_USD_PER_SEC", "FOLDRUN_RUN_FEE", "FOLDRUN_MIN_RUN_FEE", "FOLDRUN_PLAN_CONCURRENCY", "FOLDRUN_ACCOUNT_CONCURRENCY", "FOLDRUN_MAX_RUN_EXPOSURE", "FOLDRUN_REDIS_URL"] as const;

async function withInstall(front: string, body: (root: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-free-"));
  const prev = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  for (const k of VARS) delete process.env[k];
  process.env.FOLDRUN_DATA = root;
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "agents/writer"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), `---\nname: desk\n${front}---\n`);
    fs.writeFileSync(path.join(ws, "agents/writer/agent.md"), "---\nname: writer\n---\nWrite.\n");
    await body(root);
  } finally {
    for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v as string);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- freeBilling

test("free pricing is the model tokens and nothing else", () => {
  const meter = { tokenCostUsd: 0.1234567, steps: 3, computeSecs: 90, netBytes: 5 * 1024 ** 3, compute: { coreSecs: 90, gibSecs: 180, busyCpuSecs: 40, flatSecs: 0 } };
  assert.deepEqual(freeBilling.price(meter), { totalUsd: 0.123457, modelUsd: 0.123457, computeUsd: 0, networkUsd: 0 });
  assert.deepEqual(freeBilling.price(0.5), { totalUsd: 0.5, modelUsd: 0.5, computeUsd: 0, networkUsd: 0 }, "a bare number is a token-only run");
  assert.equal(freeBilling.price({ tokenCostUsd: 0, steps: 4, computeSecs: 600 }).totalUsd, 0, "a BYOK run costs the install nothing");
  assert.equal(freeBilling.price(meter, { models: true }).totalUsd, 0, "a waived model leg is waived");
  assert.deepEqual(freeBilling.listPrice({ tokenCostUsd: 2, cpuSecs: 100, gibSecs: 100, computeSecs: 100 }), { modelUsd: 2, computeUsd: 0 });
  assert.equal(freeBilling.stepWeight(0.3, 999), 0.3, "a step weighs what its tokens cost");
});

test("free billing asks for nothing and holds nothing", async () => {
  assert.equal(freeBilling.enabled(), false);
  await freeBilling.assertFunds("acme", { heldUsd: 1e6, inFlight: 100, expectedUsd: 1e6, balance: -1e6 });
  assert.equal(await freeBilling.balanceUsd("acme"), 0);
  assert.equal(await freeBilling.plan("acme"), null);
  assert.equal(await freeBilling.waive("acme"), null);
  assert.equal(await freeBilling.planStanding("acme"), null);
  assert.equal(await freeBilling.hourly("acme"), "off");
  assert.deepEqual(freeBilling.bootImports(), []);
  assert.equal(freeBilling.trialCredits(), 0);
  assert.equal(await freeBilling.grantTrial("acme"), false);
  assert.equal(await freeBilling.liveSupportView("acme", "v1"), null);
  assert.equal(await freeBilling.endSupportView("acme", "v1", "op@x.test"), false);
});

test("free ledger totals are what was spent, with no balance and no margin", async () => {
  await withInstall("", async () => {
    fs.writeFileSync(
      path.join(process.env.FOLDRUN_DATA!, "acme/ledger.jsonl"),
      [
        { t: "2026-10-01T00:00:00Z", kind: "run", usd: -0.25, cost: 0.25, runId: "r1", workspace: "desk" },
        { t: "2026-10-02T00:00:00Z", kind: "run", usd: -0.5, cost: 0.5, runId: "r2", workspace: "desk" },
        { t: "2026-10-03T00:00:00Z", kind: "topup", usd: 100 },
      ].map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    assert.deepEqual(await freeBilling.ledgerTotals("acme"), { balanceUsd: 0, chargedUsd: 0.75 });
  });
});

test("free contact email is the account's notify: address", async () => {
  await withInstall("", async (root) => {
    assert.equal(await freeBilling.contactEmail("acme"), null, "none set");
    fs.writeFileSync(path.join(root, "acme/AGENTS.md"), "---\nnotify: ops@acme.test\n---\n");
    assert.equal(await freeBilling.contactEmail("acme"), "ops@acme.test");
    fs.writeFileSync(path.join(root, "acme/AGENTS.md"), "---\nnotify: { email: team@acme.test }\n---\n");
    assert.equal(await freeBilling.contactEmail("acme"), "team@acme.test");
  });
});

// ---------------------------------------------------- the engine, unbilled

test("without billing, a run is recorded at its model tokens, once", { skip: withBilling }, async () => {
  await withInstall("", async () => {
    // Pricing env is billing's: it means nothing to an install without it.
    process.env.FOLDRUN_MARGIN = "3";
    process.env.FOLDRUN_COMPUTE_USD_PER_SEC = "1";
    const meter = { tokenCostUsd: 0.4, steps: 2, computeSecs: 30 };
    const line = await recordRunCost("acme", "desk", "r1", meter, { flow: "publish", steps: [{ agent: "writer", costUsd: 0.4, status: "completed" }] });
    assert.ok(line);
    assert.equal(line!.usd, -0.4, "tokens at cost: no margin, nothing for compute");
    assert.deepEqual(line!.split, { modelUsd: 0.4, computeUsd: 0, networkUsd: 0 });
    assert.deepEqual(line!.agents, { writer: 0.4 });
    assert.equal(await recordRunCost("acme", "desk", "r1", meter), null, "settled once");
    assert.equal((await readLedger("acme")).filter((e) => e.kind === "run").length, 1);
    assert.equal(await recordRunCost("acme", "desk", "r2", { tokenCostUsd: 0, steps: 5, computeSecs: 60 }), null, "a BYOK run costs the install nothing: no line");
  });
});

test("without billing, a spend budget still refuses the run that would pass it", { skip: withBilling }, async () => {
  await withInstall("budget: 1/day\n", async () => {
    process.env.FOLDRUN_MAX_RUN_EXPOSURE = "0.3";
    await recordRunCost("acme", "desk", "old", { tokenCostUsd: 0.5, steps: 1, computeSecs: 1 });
    // Admitted while spent + held is under the cap; a run's own share is not
    // counted against itself (reservations.ts checkBudget).
    const first = await enqueueFlowRun("acme", "desk", [STEP], "hook");
    assert.ok(first.id, "0.50 spent, nothing held");
    assert.ok((await enqueueFlowRun("acme", "desk", [STEP], "hook")).id, "0.50 spent + 0.30 held is under 1.00");
    await assert.rejects(enqueueFlowRun("acme", "desk", [STEP], "hook"), (err: { status?: number }) => err.status === 402, "0.50 + 0.60 held is past the cap");
    // The first run finishes and its cost lands: its hold goes, its cost
    // counts, and the cap is judged on what was spent.
    const rec = readRun("acme", "desk", first.id)!;
    rec.status = "completed";
    rec.finishedAt = new Date().toISOString();
    rec.steps[0].status = "completed";
    rec.steps[0].costUsd = 0.1;
    writeRun("acme", "desk", rec);
    assert.equal(await heldForRunsUsd("acme"), 0.6, "two runs held");
    assert.ok(await settleRun("acme", "desk", first.id), "its cost is recorded");
    assert.equal(await heldForRunsUsd("acme"), 0.3, "its hold went with it");
    const run = (await readLedger("acme")).find((e) => e.kind === "run" && e.runId === first.id);
    assert.equal(run?.usd, -0.1, "at its model tokens");
    // 0.60 spent + 0.30 held is under 1.00 again: one more is admitted.
    assert.ok((await enqueueFlowRun("acme", "desk", [STEP], "hook")).id);
  });
});

test("without billing, the edition is self-hosted whatever the environment says", { skip: withBilling }, async () => {
  await withInstall("", async () => {
    process.env.FOLDRUN_EDITION = "hosted";
    process.env.STRIPE_SECRET_KEY = "sk_test_unused";
    process.env.FOLDRUN_BILLING = "1";
    assert.equal(edition(), "self-hosted", "the hosted pages are not in this build");
    assert.equal(billing().enabled(), false, "FOLDRUN_BILLING cannot switch on billing that is not here");
  });
});

test("without billing, an account's own concurrency: is its cap, and no plan applies", { skip: withBilling }, async () => {
  await withInstall("", async (root) => {
    process.env.FOLDRUN_PLAN_CONCURRENCY = "2";
    fs.writeFileSync(path.join(root, "acme/AGENTS.md"), "---\nconcurrency: 5\n---\n");
    assert.deepEqual(await accountConcurrency("acme"), { cap: 5, source: "account" }, "the plan's number is billing's");
    process.env.FOLDRUN_ACCOUNT_CONCURRENCY = "3";
    assert.deepEqual(await accountConcurrency("acme"), { cap: 3, source: "account" }, "the install's per-account share still bounds it");
  });
});

test("attribution splits a run's cost by token cost without billing", { skip: withBilling }, () => {
  const agents = attributeToAgents(
    [
      { agent: "researcher", costUsd: 0.3, computeSecs: 500, status: "completed" },
      { agent: "writer", costUsd: 0.1, computeSecs: 10, status: "completed" },
    ],
    0.4,
  );
  assert.deepEqual(agents, { researcher: 0.3, writer: 0.1 }, "seconds weigh nothing when they cost nothing");
});
