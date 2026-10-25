// The worker's hourly pass on an install that does not charge for runs.
//
// The engine's half — budget holds a finished run no longer needs, run costs
// to re-drive, the history window — used to sit behind the billing check, so
// a self-hosted install with `budget:` set kept every orphaned hold forever
// and never pruned old runs. Billing's half still stays off there.
//
//   node --test tests/housekeeping-free.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { enqueueFlowRun, heldForRunsUsd, hourlyHousekeeping } from "../src/queue.ts";
import { listReservations } from "../src/reservations.ts";
import { readRun, writeRun } from "../../foldrun-core/src/store.ts";

const STEP = { agent: "writer", instruction: "draft it", group: 1, optional: false };
const VARS = ["FOLDRUN_DATA", "FOLDRUN_BILLING", "FOLDRUN_RETENTION_DAYS", "FOLDRUN_MAX_RUN_EXPOSURE", "FOLDRUN_REDIS_URL"] as const;

async function withInstall(body: () => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-housekeeping-"));
  const prev = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  for (const k of VARS) delete process.env[k];
  process.env.FOLDRUN_DATA = root;
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "agents/writer"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\nbudget: 50\n---\n");
    fs.writeFileSync(path.join(ws, "agents/writer/agent.md"), "---\nname: writer\n---\nWrite.\n");
    await body();
  } finally {
    for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v as string);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function logsOf(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.log = log;
  }
  return lines;
}

test("without billing, a budget hold whose run ended some other way is released", async () => {
  await withInstall(async () => {
    process.env.FOLDRUN_MAX_RUN_EXPOSURE = "2";
    const run = await enqueueFlowRun("acme", "desk", [STEP], "hook");
    assert.equal((await listReservations("acme")).length, 1, "a budget holds the run's share, billing or not");
    // The run ends without a settle — a driver that died — so nothing
    // released its hold. Before, nothing ever would on this install.
    const rec = readRun("acme", "desk", run.id)!;
    rec.status = "failed";
    rec.finishedAt = new Date().toISOString();
    writeRun("acme", "desk", rec);
    const lines = await logsOf(() => hourlyHousekeeping());
    assert.equal((await listReservations("acme")).length, 0);
    assert.equal(await heldForRunsUsd("acme"), 0);
    assert.ok(lines.some((l) => l.includes("released 1 stale reservation(s) for acme")), lines.join("\n"));
    assert.ok(!lines.some((l) => l.includes("wallet guard")), "billing's half stays off");
  });
});

test("without billing, the history window still prunes old runs and leaves recent ones", async () => {
  await withInstall(async () => {
    process.env.FOLDRUN_RETENTION_DAYS = "1";
    const old = await enqueueFlowRun("acme", "desk", [STEP], "hook");
    const recent = await enqueueFlowRun("acme", "desk", [STEP], "hook");
    for (const [id, ago] of [[old.id, 3], [recent.id, 0]] as const) {
      const rec = readRun("acme", "desk", id)!;
      rec.status = "completed";
      rec.finishedAt = new Date(Date.now() - ago * 24 * 60 * 60 * 1000).toISOString();
      writeRun("acme", "desk", rec);
    }
    await hourlyHousekeeping();
    assert.equal(readRun("acme", "desk", old.id), null, "three days old, one-day window");
    assert.ok(readRun("acme", "desk", recent.id), "today's run stays");
  });
});
