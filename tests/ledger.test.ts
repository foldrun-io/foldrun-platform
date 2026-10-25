// The money ledger: append-only lines whose sum is the balance.
//
//   node --test tests/ledger.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readLedger, recordRunCost, noteRunDeleted } from "../src/ledger.ts";
import { updateAdminState } from "../src/admin.ts";
import { accountUsage } from "../src/usage.ts";

async function withAccount(body: () => void | Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-ledger-"));
  const prevData = process.env.FOLDRUN_DATA;
  const prevBilling = process.env.FOLDRUN_BILLING;
  const priceVars = [
    "FOLDRUN_MARGIN",
    "FOLDRUN_MIN_RUN_FEE",
    "FOLDRUN_RUN_FEE",
    "FOLDRUN_NET_USD_PER_GB",
    "FOLDRUN_COMPUTE_USD_PER_SEC",
    "FOLDRUN_COMPUTE_USD_PER_CORE_SEC",
    "FOLDRUN_COMPUTE_USD_PER_GIB_SEC",
    "FOLDRUN_CPU_USD_PER_BUSY_SEC",
    "FOLDRUN_MAX_RUN_EXPOSURE",
  ];
  const prevPrices = priceVars.map((k) => [k, process.env[k]] as const);
  for (const k of priceVars) delete process.env[k];
  process.env.FOLDRUN_DATA = root;
  try {
    fs.mkdirSync(path.join(root, "acme/workspaces"), { recursive: true });
    await body();
  } finally {
    if (prevData === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prevData;
    if (prevBilling === undefined) delete process.env.FOLDRUN_BILLING;
    else process.env.FOLDRUN_BILLING = prevBilling;
    for (const [k, v] of prevPrices) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("a free run writes nothing", async () => {
  await withAccount(async () => {
    assert.equal(await recordRunCost("acme", "desk", "run-a", 0), null);
    assert.equal((await readLedger("acme")).length, 0);
  });
});

test("a run priced at zero writes no line, however many steps it ran", async () => {
  await withAccount(async () => {
    // Self-host, no pricing configured, BYOK: nothing to charge and nothing
    // to observe, so the ledger stays empty rather than filling with $0.
    assert.equal(await recordRunCost("acme", "desk", "run-a", { tokenCostUsd: 0, steps: 9, computeSecs: 300 }), null);
    assert.equal((await readLedger("acme")).length, 0);
  });
});

// --------------------------------------------------- the two billing races

test("the usage report cuts one set of facts three ways that agree", async () => {
  await withAccount(async () => {
    process.env.FOLDRUN_RUNNER_CPUS = "2";
    process.env.FOLDRUN_RUNNER_MEMORY = "4Gi";
    try {
      const ws = path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk");
      fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
      fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
      fs.writeFileSync(
        path.join(ws, "runs/run-a.json"),
        JSON.stringify({
          id: "run-a", flow: "publish", status: "completed",
          startedAt: "2026-08-26T00:00:00.000Z", finishedAt: "2026-08-26T00:05:00.000Z",
          steps: [
            { agent: "writer", instruction: "", group: 1, optional: false, status: "completed",
              events: [], result: "x", costUsd: 0.5, computeSecs: 30,
              tokens: { input: 1000, output: 400 } },
            { agent: "editor", instruction: "", group: 2, optional: false, status: "completed",
              events: [], result: "y", costUsd: 0.25, computeSecs: 10,
              // Recorded after the cache split: 375 of its 500 input tokens came from the cache.
              tokens: { input: 500, output: 100, cacheRead: 375, cacheWrite: 0 } },
            // A carried step ran — and was counted — in another run.
            { agent: "writer", instruction: "", group: 3, optional: false, status: "completed",
              events: [], result: "z", costUsd: null, computeSecs: null, carriedFrom: "run-0" },
          ],
        }),
      );

      const u = await accountUsage("acme");
      assert.equal(u.totals.runs, 1);
      assert.equal(u.totals.steps, 2, "the carried step is not consumption");
      assert.equal(u.totals.tokenCostUsd, 0.75);
      assert.equal(u.totals.inputTokens, 1500);
      assert.equal(u.totals.cacheReadTokens, 375);
      // Over the step that reports the split only: the writer's older record cannot say, and does not dilute it.
      assert.equal(u.totals.measuredInputTokens, 500);
      assert.equal(u.totals.cacheHitRate, 0.75);
      assert.equal(u.totals.computeSecs, 40);
      // Reservations: computeSecs × the limits in force.
      assert.equal(u.totals.cpuSecs, 80);
      assert.equal(u.totals.gibSecs, 160);

      const desk = u.workspaces.find((w) => w.workspace === "desk")!;
      // The flow cut and the agent cut are the same facts sliced twice.
      assert.equal(desk.byFlow.publish.tokenCostUsd, 0.75);
      assert.equal(desk.byAgent.writer.tokenCostUsd, 0.5);
      assert.equal(desk.byAgent.editor.tokenCostUsd, 0.25);
      assert.equal(
        Object.values(desk.byAgent).reduce((s, b) => s + b.computeSecs, 0),
        desk.computeSecs,
      );
      // Storage sees the files just written.
      assert.ok(desk.storage.runsBytes > 0);
      assert.ok(desk.storage.sourceBytes > 0);
    } finally {
      delete process.env.FOLDRUN_RUNNER_CPUS;
      delete process.env.FOLDRUN_RUNNER_MEMORY;
    }
  });
});

