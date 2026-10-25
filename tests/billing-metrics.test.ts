// The two billing gauges: runs owed a charge, and money held for runs in
// flight — in the text /api/metrics speaks.
//
//   node --test tests/billing-metrics.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { billingMetrics, billingMetricsText } from "../src/billing-metrics.ts";
import { reserveAdmission } from "../src/reservations.ts";

test("unsettled runs and reservations are counted across every account and rendered as gauges", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-metrics-"));
  const prev = { FOLDRUN_DATA: process.env.FOLDRUN_DATA, FOLDRUN_REDIS_URL: process.env.FOLDRUN_REDIS_URL, FOLDRUN_MAX_RUN_EXPOSURE: process.env.FOLDRUN_MAX_RUN_EXPOSURE };
  process.env.FOLDRUN_DATA = root;
  delete process.env.FOLDRUN_REDIS_URL;
  process.env.FOLDRUN_MAX_RUN_EXPOSURE = "0.25";
  try {
    fs.mkdirSync(path.join(root, "acme/workspaces/desk"), { recursive: true });
    fs.mkdirSync(path.join(root, "beta/workspaces/desk"), { recursive: true });
    assert.deepEqual(await billingMetrics(), { unsettledRuns: 0, reservedUsd: 0, reservedCount: 0 });
    fs.mkdirSync(path.join(root, "acme/unsettled"), { recursive: true });
    fs.writeFileSync(path.join(root, "acme/unsettled/run-1.json"), JSON.stringify({ tenant: "acme", workspace: "desk", runId: "run-1", at: "", error: "x", attempts: 3 }));
    fs.mkdirSync(path.join(root, "beta/unsettled"), { recursive: true });
    fs.writeFileSync(path.join(root, "beta/unsettled/run-2.json"), "{}");
    fs.writeFileSync(path.join(root, "beta/workspaces/desk/AGENTS.md"), "---\nname: desk\nbudget: 100\n---\n");
    await reserveAdmission("beta", "desk", "nightly");
    await reserveAdmission("beta", "desk", "nightly");
    assert.deepEqual(await billingMetrics(), { unsettledRuns: 2, reservedUsd: 0.5, reservedCount: 2 });
    const text = await billingMetricsText();
    assert.ok(text.includes("foldrun_billing_unsettled_runs 2"));
    assert.ok(text.includes("foldrun_billing_reserved_usd 0.5"));
    assert.ok(text.includes("foldrun_billing_reserved_count 2"));
    assert.equal(text.filter((l) => l.startsWith("# TYPE")).length, 3, "every gauge typed, the way the route already renders");
  } finally {
    for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
