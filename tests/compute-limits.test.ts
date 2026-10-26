// An account's compute pool: the install's defaults, the account's own
// `compute:` (lower only), and what its running steps hold now. The plan's
// figures are billing's (foldrun-admin tests/admin-billing.test.ts); the
// room gate that enforces the pool is tests/pod-room.test.ts.
//
//   node --test tests/compute-limits.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountCompute, computeInUse } from "../src/limits.ts";
import { accountDir, writeRun, type RunRecord } from "../../foldrun-core/src/store.ts";

async function withAccount(agentsMd: string | null, body: () => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-compute-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    fs.mkdirSync(accountDir("acme"), { recursive: true });
    if (agentsMd !== null) fs.writeFileSync(path.join(accountDir("acme"), "AGENTS.md"), agentsMd);
    await body();
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const NONE = {} as NodeJS.ProcessEnv;
const INSTALL = { FOLDRUN_ACCOUNT_VCPU: "8", FOLDRUN_ACCOUNT_MEMORY_GIB: "16", FOLDRUN_STEP_MAX_VCPU: "4", FOLDRUN_STEP_MAX_MEMORY_GIB: "8" } as NodeJS.ProcessEnv;

test("no plan, no install default, nothing of its own: no pool", () =>
  withAccount("---\nname: acme\n---\n", async () => {
    assert.deepEqual(await accountCompute("acme", NONE), { vcpu: null, memGiB: null, stepVcpu: null, stepMemGiB: null, source: null });
  }));

test("the install's defaults are every account's pool and step maximum", () =>
  withAccount(null, async () => {
    assert.deepEqual(await accountCompute("acme", INSTALL), { vcpu: 8, memGiB: 16, stepVcpu: 4, stepMemGiB: 8, source: "install" });
  }));

test("an account's own compute: lowers the install's pool, never raises it", () =>
  withAccount("---\ngovernance:\n  compute: { vcpu: 2, memory: 64Gi }\n---\n", async () => {
    const c = await accountCompute("acme", INSTALL);
    assert.equal(c.vcpu, 2, "asked for less: honoured");
    assert.equal(c.memGiB, 16, "asked for more: the install's");
    assert.equal(c.source, "account");
    assert.equal(c.stepMemGiB, 8, "the step maximum is not the account's to set");
  }));

test("with no ceiling at all, an account's own number stands — a self-hoster capping their box", () =>
  withAccount("---\ncompute: { vcpu: 6, memory: 12Gi }\n---\n", async () => {
    assert.deepEqual(await accountCompute("acme", NONE), { vcpu: 6, memGiB: 12, stepVcpu: null, stepMemGiB: null, source: "account" });
  }));

test("an unreadable compute: is no compute:, not a crash", () =>
  withAccount("---\ncompute: lots\n---\n", async () => {
    assert.equal((await accountCompute("acme", INSTALL)).vcpu, 8);
  }));

test("what the account holds now is its running steps' sandboxes, across workspaces — not a step waiting for room", () =>
  withAccount(null, async () => {
    const step = (status: string, holding: { cpus: number; memGiB: number } | null, reserved = holding) =>
      ({ agent: "a", instruction: "x", group: 1, optional: false, status, events: [], result: null, holding, ...(reserved ? { reserved } : {}) }) as unknown as RunRecord["steps"][number];
    for (const [ws, id, steps] of [
      ["desk", "r1", [step("running", { cpus: 3, memGiB: 6 }), step("completed", null, { cpus: 4, memGiB: 8 })]],
      // a running step whose sandbox is still waiting for room: no holding,
      // though an earlier attempt left its reservation on the record
      ["other", "r2", [step("running", { cpus: 1, memGiB: 1 }), step("running", null, { cpus: 4, memGiB: 8 })]],
    ] as const) {
      fs.mkdirSync(path.join(accountDir("acme"), "workspaces", ws, "runs"), { recursive: true });
      fs.writeFileSync(path.join(accountDir("acme"), "workspaces", ws, "AGENTS.md"), `---\nname: ${ws}\n---\n`);
      writeRun("acme", ws, { id, flow: "f", status: "running", startedAt: new Date().toISOString(), steps: [...steps] } as unknown as RunRecord);
    }
    assert.deepEqual(computeInUse("acme"), { vcpu: 4, memGiB: 7, steps: 2 });
    assert.deepEqual(computeInUse("acme", ["other"]), { vcpu: 1, memGiB: 1, steps: 1 }, "a scoped caller sees its workspaces");
  }));
