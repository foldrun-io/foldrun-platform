// telemetry: delivery — which block applies, and a header secret the vault
// does not hold stops the send with the command that fixes it.
//
//   node --test tests/otel-export.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { telemetryConfig, sendTrace, exportRunTrace, sweepRunTraces } from "../src/otel-export.ts";
import type { RunRecord } from "../../foldrun-core/src/store.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-otel-"));
process.env.FOLDRUN_DATA = root;
const ws = path.join(root, "acme/workspaces/desk");
fs.mkdirSync(ws, { recursive: true });
fs.writeFileSync(path.join(root, "acme/AGENTS.md"), "---\ntelemetry:\n  otlp: https://otel.example.com/v1/traces\n  headers:\n    authorization: ${OTEL_TOKEN}\n---\n");
fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");

const run = { id: "r1", flow: "daily", status: "completed", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), steps: [] } as unknown as RunRecord;

test("the account's block applies where the workspace has none; a missing secret is said, not sent", async () => {
  const cfg = telemetryConfig("acme", "desk");
  assert.equal(cfg?.endpoint, "https://otel.example.com/v1/traces");
  const out = await sendTrace("acme", "desk", run, cfg!);
  assert.equal(out.ok, false);
  assert.match(out.error ?? "", /the vault has no OTEL_TOKEN — foldrun secrets set OTEL_TOKEN/);
  assert.equal(await exportRunTrace("acme", "desk", { ...run, test: true } as RunRecord), null, "test runs are not sent");
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\ntelemetry:\n  otlp: https://other.example.com/v1/traces\n---\n");
  assert.equal(telemetryConfig("acme", "desk")?.endpoint, "https://other.example.com/v1/traces", "the workspace's replaces the account's");
});

test("a run's trace is claimed once: the worker and the sweep never both send it", async () => {
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
  const done = { ...run, id: "r-once" } as RunRecord;
  const first = await exportRunTrace("acme", "desk", done);
  assert.equal(first?.ok, false, "tried (the vault has no token here)");
  assert.equal(await exportRunTrace("acme", "desk", done), null, "already claimed");
  assert.equal(await exportRunTrace("acme", "desk", { ...run, id: "r-live", status: "running" } as RunRecord), null, "only finished runs");
  const swept = await sweepRunTraces("acme", "desk", [{ id: "r-once", finishedAt: new Date().toISOString() }], () => done);
  assert.equal(swept, 0);
});
