// FOL-124: the platform's failure sentences, read by the one place that turns
// them into the customer's reason (core failure.ts). The room gate writes a
// step that can never fit as prose; this holds every variant of that prose
// to what explainFailure reads out of it — the figures, the scope, and a fix
// that names a plan only where a plan is what limits it.
//
//   node --test tests/failure-reasons.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { tooBig, type RoomLimits } from "../src/pod-room.ts";
import { explainFailure } from "../../foldrun-core/src/failure.ts";
import { refusalText } from "../../foldrun-core/src/network.ts";

const base: RoomLimits = { budgetGiB: 0, accountPods: 0 };

test("every room-gate 'never fits' sentence reads back as its figures and its scope", () => {
  const cases: { limits: Partial<RoomLimits>; need: [number, number, number]; kind: string; used: number; allowed: number; scope: string; plan: boolean }[] = [
    { limits: { stepGiB: 4 }, need: [8, 1, 0], kind: "memory", used: 8, allowed: 4, scope: "step", plan: true },
    { limits: { stepVcpu: 2 }, need: [1, 6, 0], kind: "cpu", used: 6, allowed: 2, scope: "step", plan: true },
    { limits: { stepDiskGiB: 40 }, need: [1, 1, 60], kind: "disk", used: 60, allowed: 40, scope: "step", plan: true },
    { limits: { stepGiB: 2.5 }, need: [3.5, 1, 0], kind: "memory", used: 3.5, allowed: 2.5, scope: "step", plan: true },
    { limits: { runGiB: 4 }, need: [6, 1, 0], kind: "memory", used: 6, allowed: 4, scope: "run", plan: false },
    { limits: { runVcpu: 2 }, need: [1, 4, 0], kind: "cpu", used: 4, allowed: 2, scope: "run", plan: false },
    { limits: { workspaceGiB: 8 }, need: [12, 1, 0], kind: "memory", used: 12, allowed: 8, scope: "workspace", plan: false },
    { limits: { accountGiB: 8 }, need: [16, 1, 0], kind: "memory", used: 16, allowed: 8, scope: "account", plan: true },
    { limits: { accountVcpu: 4 }, need: [1, 8, 0], kind: "cpu", used: 8, allowed: 4, scope: "account", plan: true },
    { limits: { accountDiskGiB: 20 }, need: [1, 1, 30], kind: "disk", used: 30, allowed: 20, scope: "account", plan: true },
    { limits: { budgetDiskGiB: 50 }, need: [1, 1, 80], kind: "disk", used: 80, allowed: 50, scope: "install", plan: false },
    { limits: { nodeGiB: 32 }, need: [64, 1, 0], kind: "memory", used: 64, allowed: 32, scope: "node", plan: false },
  ];
  for (const c of cases) {
    const said = tooBig(c.need[0], c.need[1], { ...base, ...c.limits }, c.need[2]);
    assert.ok(said, JSON.stringify(c.limits));
    // As the step's trail has it: the room gate's error, and the runner's
    // "sandbox ended:" line after it.
    for (const reason of [said, `sandbox ended: ${said}`]) {
      const f = explainFailure(reason);
      assert.equal(f.class, "policy_denied", reason);
      assert.deepEqual([f.kind, f.used, f.allowed, f.scope], [c.kind, c.used, c.allowed, c.scope], reason);
      assert.equal(/plan/.test(f.fix ?? ""), c.plan, `${c.scope}: ${f.fix}`);
    }
  }
});

test("the egress proxy's refusal names its site, and only that site", () => {
  const f = explainFailure(`${refusalText({ level: "none" }, "Files.Example.COM")} Refused.`);
  assert.equal(f.kind, "network");
  assert.equal(f.host, "files.example.com");
  assert.match(f.fix!, /network: \[files\.example\.com\]/);
});
