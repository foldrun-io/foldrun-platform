// The Usage page's breakdowns (FOL-125): tokens by provider and model — the
// account's own key at 0 billed — and compute by meter with quantity and
// credits; a period; a caller limited to some workspaces sees their runs and
// none of the account's money.
//
//   node --test tests/usage-breakdown.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-usage-breakdown-"));
process.env.FOLDRUN_DATA = root;
delete process.env.FOLDRUN_DATABASE_URL;

const { writeRun } = await import("../../foldrun-core/src/store.ts");
const { accountUsage } = await import("../src/usage.ts");
const { usagePeriod } = await import("../src/usage-breakdown.ts");
const { reserveCall, closeCall } = await import("../src/model-usage.ts");

const TODAY = new Date().toISOString().slice(0, 10);

function run(id: string, step: Record<string, unknown>, startedAt = new Date().toISOString()) {
  return {
    id, flow: "daily", tags: [], status: "completed", startedAt, finishedAt: startedAt,
    steps: [{
      agent: "writer", instruction: "x", group: 1, optional: false, status: "completed", events: [], result: "ok", costUsd: 0.5,
      computeSecs: 3600, reserved: { cpus: 2, memGiB: 2, diskGiB: 8 }, size: "small", actual: { rxBytes: 1e9, txBytes: 1e9, busyCpuSecs: 0 },
      ...step,
    }],
  };
}

test("a period is days, defaults to the month so far, and refuses nonsense", () => {
  const p = usagePeriod(undefined, undefined, new Date("2026-11-17T10:00:00Z"));
  assert.deepEqual(p, { from: "2026-11-01", to: "2026-11-17" });
  assert.throws(() => usagePeriod("2026-11-30", "2026-11-01"), /after/);
  assert.throws(() => usagePeriod("yesterday", undefined), /YYYY-MM-DD/);
  assert.throws(() => usagePeriod("2024-01-01", "2026-11-01"), /at most a year/);
});

test("tokens by provider and model: the account's own key is listed at 0 billed; foldrun's models carry the gateway's calls", async () => {
  fs.mkdirSync(path.join(root, "acme/workspaces/desk/runs"), { recursive: true });
  fs.mkdirSync(path.join(root, "acme/workspaces/lab/runs"), { recursive: true });
  writeRun("acme", "desk", run("run-own", {
    supply: "own", credential: "provider: anthropic (your key)", model: "claude-test",
    tokens: { input: 1000, output: 200, cacheRead: 500, cacheWrite: 50 },
  }) as never);
  writeRun("acme", "lab", run("run-lab", { supply: "own", credential: "provider: openai (your key)", model: "gpt-test", tokens: { input: 10, output: 5 } }) as never);
  const open = await reserveCall({ tenant: "acme", kind: "run", runId: "run-fold", step: 0, provider: "anthropic", model: "claude-fold", estimateUsd: 0.2, priceVersion: 1 }, 0);
  assert.ok(open.ok);
  await closeCall(open.id, { tokens: { input: 2000, output: 100, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.04 });

  const u = await accountUsage("acme");
  assert.equal(u.period.to, TODAY);
  const own = u.tokens.byModel.find((r) => r.model === "claude-test")!;
  assert.deepEqual([own.supply, own.provider, own.calls, own.inputTokens, own.cacheReadTokens, own.cacheWriteTokens, own.outputTokens, own.billedCredits], ["own", "anthropic", 1, 1000, 500, 50, 200, 0]);
  assert.match(own.billedNote!, /provider bills you/);
  const fold = u.tokens.byModel.find((r) => r.model === "claude-fold")!;
  assert.deepEqual([fold.supply, fold.calls, fold.inputTokens, fold.providerCostUsd], ["foldrun", 1, 2000, 0.04]);
  assert.ok(fold.billedCredits >= 4, "at least the provider's price, in credits");
  assert.equal(u.tokens.totals.byokTokens, 1000 + 200 + 10 + 5);
  assert.equal(u.tokens.byModel[0]!.supply, "foldrun", "foldrun's models first, the account's own key last");
  assert.equal(u.tokens.byModel.at(-1)!.billedCredits, 0);
});

test("compute by meter: reserved vCPU, RAM and disk hours and the network GB, each with its quantity", async () => {
  const u = await accountUsage("acme");
  const m = Object.fromEntries(u.compute.meters.map((x) => [x.meter, x]));
  assert.equal(m.vcpu!.quantity, 4, "two steps of one hour on 2 vCPU");
  assert.equal(m.ram!.quantity, 4);
  assert.equal(m.disk!.quantity, 16);
  assert.equal(m.network!.quantity, 4, "2 GB each way, twice");
  assert.equal(m.vcpu!.unit, "vCPU-hour");
  const small = u.compute.bySize.find((s) => s.size === "small")!;
  assert.deepEqual([small.steps, small.hours, small.vcpu, small.memGiB, small.diskGiB], [2, 2, 2, 2, 8]);
});

test("a period outside the runs sees none of them; a scoped caller sees its own workspaces and none of the account's money", async () => {
  const none = await accountUsage("acme", { from: "2020-01-01", to: "2020-01-31" });
  assert.equal(none.tokens.totals.calls, 0);
  assert.equal(none.compute.meters.find((x) => x.meter === "vcpu")!.quantity, 0);

  const scoped = await accountUsage("acme", { workspaces: ["lab"] });
  assert.equal(scoped.credits, null, "the wallet is not theirs");
  assert.equal(scoped.billed, null);
  assert.equal(scoped.compute.planFee, null);
  assert.deepEqual(scoped.tokens.byModel.map((r) => r.model), ["gpt-test"], "their run only; no host jobs or other workspaces");
  assert.equal(scoped.compute.meters.find((x) => x.meter === "vcpu")!.quantity, 2);
});
