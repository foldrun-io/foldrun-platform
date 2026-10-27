// Steps waiting for room, as /api/metrics gauges (27 Oct 2026).
//
//   node --test tests/room-metrics.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-roommetrics-"));
const { roomMetricsText } = await import("../src/room-metrics.ts");
const { accountDir, writeRun } = await import("../../foldrun-core/src/store.ts");
import type { RunRecord } from "../../foldrun-core/src/store.ts";

const NOW = Date.parse("2026-10-27T03:00:00Z");
const step = (status: string, roomWait?: Record<string, unknown>) =>
  ({ agent: "a", instruction: "", group: 1, optional: false, status, events: [], result: null, ...(roomWait ? { roomWait } : {}) }) as unknown as RunRecord["steps"][number];
const wait = (minsAgo: number, level?: string) => ({ since: new Date(NOW - minsAgo * 60_000).toISOString(), why: "full", cpus: 1, memGiB: 1, ...(level ? { level } : {}) });

test("waiting steps are counted by the cap that holds them, with the oldest wait — parked ones included", () => {
  for (const [tenant, ws] of [["acme", "desk"], ["zeta", "ops"]]) {
    fs.mkdirSync(path.join(accountDir(tenant), "workspaces", ws, "runs"), { recursive: true });
    fs.writeFileSync(path.join(accountDir(tenant), "workspaces", ws, "AGENTS.md"), `---\nname: ${ws}\n---\n`);
  }
  // parked in the queue for its workspace's cap, and one in its driver for the node
  writeRun("acme", "desk", { id: "r1", flow: "f", status: "queued", parkedAt: "x", startedAt: new Date(NOW).toISOString(), steps: [step("pending", wait(45, "workspace"))] } as unknown as RunRecord);
  writeRun("acme", "desk", { id: "r2", flow: "f", status: "running", startedAt: new Date(NOW).toISOString(), steps: [step("running", wait(5, "node")), step("running")] } as unknown as RunRecord);
  writeRun("zeta", "ops", { id: "r3", flow: "g", status: "running", startedAt: new Date(NOW).toISOString(), steps: [step("pending", wait(2))] } as unknown as RunRecord);
  // finished: never counted
  writeRun("zeta", "ops", { id: "r4", flow: "g", status: "completed", startedAt: new Date(NOW).toISOString(), steps: [step("completed", wait(90, "account"))] } as unknown as RunRecord);
  const text = roomMetricsText(NOW).join("\n");
  assert.match(text, /foldrun_room_waiting_steps\{level="workspace"\} 1/);
  assert.match(text, /foldrun_room_waiting_steps\{level="node"\} 1/);
  assert.match(text, /foldrun_room_waiting_steps\{level="turn"\} 1/, "no recorded level: it waited its turn");
  assert.match(text, /foldrun_room_waiting_steps\{level="account"\} 0/, "a finished run is not waiting");
  assert.match(text, /foldrun_room_oldest_wait_seconds 2700/);
  assert.match(text, /foldrun_room_metrics_errors 0/);
  assert.doesNotMatch(text, /acme|zeta|desk|r1/, "no tenant, workspace or run in a label");
});
