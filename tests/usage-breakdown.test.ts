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
  assert.equal(m.network!.quantity, Math.round((4e9 / 2 ** 30) * 1000) / 1000, "1e9 bytes each way, twice, in GB of 2^30 bytes");
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

// ---------------------------------------------------------------- pods and storage (8 Nov 2026)

const { append } = await import("../src/ledger.ts");
const { setStorageMeasurer } = await import("../src/storage-measure.ts");

const podLine = (kind: string, pod: string, secs: number, netBytes: number, usd: number) => ({
  t: new Date().toISOString(), kind: "adjustment" as const, usd: -usd, cost: 0,
  meter: { steps: 0, computeSecs: secs, ...(netBytes ? { netBytes } : {}) },
  note: `${kind} ${pod} ${secs}s ${(netBytes / 1048576).toFixed(1)}MB since 2026-11-08T00:00:00Z`, key: `pod:${kind}:${pod}:x`, reason: "pod" as const,
});

test("search, browser and warm builds are their own meters: hours, sessions, network GB and the credits the ledger charged", async () => {
  await append("pods", podLine("search", "s-1", 3600, 0, 0.011));
  await append("pods", podLine("search", "s-2", 1800, 2 ** 30, 0.006));
  await append("pods", podLine("browser", "b-1", 7200, 0, 0.05));
  await append("pods", podLine("browse", "b-step", 1800, 2 ** 29, 0.03));
  await append("pods", podLine("warm", "w-1", 90, 2 ** 30, 0.002));
  const u = await accountUsage("pods");
  const m = Object.fromEntries(u.compute.meters.map((x) => [x.meter, x]));
  assert.deepEqual(u.compute.meters.map((x) => x.meter), ["vcpu", "ram", "disk", "storage", "network", "search", "browser", "warm"], "every meter has its line, in this order");
  assert.deepEqual([m.search!.quantity, m.search!.sessions, m.search!.networkGb, m.search!.credits], [1.5, 2, 1, 1.7]);
  assert.deepEqual([m.browser!.quantity, m.browser!.sessions, m.browser!.networkGb, m.browser!.credits], [2.5, 2, 0.5, 8], "the pool pod and the per-step browse pod are both the browser");
  assert.deepEqual([m.warm!.quantity, m.warm!.sessions, m.warm!.networkGb, m.warm!.credits], [0.025, 1, 1, 0.2]);
  assert.match(m.warm!.note!, /account pays/);
});

test("a caller scoped to some workspaces sees no pod hours or credits of the account's", async () => {
  const u = await accountUsage("pods", { workspaces: ["nothing"] });
  for (const k of ["search", "browser", "warm"]) {
    const l = u.compute.meters.find((x) => x.meter === k)!;
    assert.deepEqual([l.quantity, l.credits, l.sessions], [null, 0, 0]);
  }
});

test("storage: one measure (the seam FOL-126 replaces), shown with where it came from and the plan's allowance; credits are the daily lines over the period", async () => {
  fs.mkdirSync(path.join(root, "stor/workspaces/desk"), { recursive: true });
  fs.writeFileSync(path.join(root, "stor/workspaces/desk/AGENTS.md"), "---\nname: desk\n---\n");
  const first = (await accountUsage("stor")).compute.meters.find((x) => x.meter === "storage")!;
  assert.equal(first.basis, "filesystem");
  assert.ok([undefined, 2].includes(first.includedGb), "no allowance on an install without plans; Free's 2 GB on the hosted one");
  const prev = setStorageMeasurer((_t, fs0) => ({ bytes: 3 * 2 ** 30 + fs0 * 0, basis: "revisions" }));
  try {
    await append("stor", { t: new Date().toISOString(), kind: "adjustment", usd: -0.02, cost: 0, note: "storage 3.00GB, 1.00GB over 2GB included 2026-11-08", key: "accrual:storage:2026-11-08", reason: "fee" });
    const u = await accountUsage("stor");
    const s = u.compute.meters.find((x) => x.meter === "storage")!;
    assert.deepEqual([s.quantity, s.basis, s.credits], [3, "revisions", 2]);
    assert.equal(u.totals.storageBytes, 3 * 2 ** 30, "the totals and the meter say one number");
    const scoped = await accountUsage("stor", { workspaces: ["desk"] });
    assert.notEqual(scoped.compute.meters.find((x) => x.meter === "storage")!.basis, "revisions", "the measure is the account's; a scoped caller sees their own bytes");
  } finally {
    setStorageMeasurer(prev);
  }
});
