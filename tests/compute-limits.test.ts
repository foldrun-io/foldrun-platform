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
import { accountCompute, computeInUse, computeHeld, workspaceCompute, roomWaiting } from "../src/limits.ts";
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
    assert.deepEqual(await accountCompute("acme", NONE), { vcpu: null, memGiB: null, diskGiB: null, stepVcpu: null, stepMemGiB: null, stepDiskGiB: null, source: null });
  }));

test("the install's defaults are every account's pool and step maximum", () =>
  withAccount(null, async () => {
    assert.deepEqual(await accountCompute("acme", INSTALL), { vcpu: 8, memGiB: 16, diskGiB: null, stepVcpu: 4, stepMemGiB: 8, stepDiskGiB: null, source: "install" });
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
    assert.deepEqual(await accountCompute("acme", NONE), { vcpu: 6, memGiB: 12, diskGiB: null, stepVcpu: null, stepMemGiB: null, stepDiskGiB: null, source: "account" });
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
    assert.deepEqual(computeInUse("acme"), { vcpu: 4, memGiB: 7, diskGiB: 0, steps: 2 });
    assert.deepEqual(computeInUse("acme", ["other"]), { vcpu: 1, memGiB: 1, diskGiB: 0, steps: 1 }, "a scoped caller sees its workspaces");
  }));

// ---- 27 Oct 2026: disk, and the workspace's and run's own pools.

test("disk is an account figure like cores and GiB: the install's, lowered by the account's own", () =>
  withAccount("---\ncompute: { disk: 30Gi }\n---\n", async () => {
    const c = await accountCompute("acme", { FOLDRUN_ACCOUNT_DISK_GIB: "80", FOLDRUN_STEP_MAX_DISK_GIB: "20" } as NodeJS.ProcessEnv);
    assert.equal(c.diskGiB, 30, "asked for less: honoured");
    assert.equal(c.stepDiskGiB, 20);
    assert.equal(c.source, "account");
    assert.equal((await accountCompute("acme", { FOLDRUN_ACCOUNT_DISK_GIB: "20" } as NodeJS.ProcessEnv)).diskGiB, 20, "asked for more: the install's");
  }));

test("a workspace's own pool is its AGENTS.md compute:, and holdings are summed at every level", () =>
  withAccount(null, async () => {
    const ws = path.join(accountDir("acme"), "workspaces", "desk");
    fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\ncompute: { vcpu: 2, memory: 4Gi, disk: 20Gi }\n---\n");
    assert.deepEqual(workspaceCompute("acme", "desk"), { vcpu: 2, memGiB: 4, diskGiB: 20 });
    assert.deepEqual(workspaceCompute("acme", "nowhere"), { vcpu: null, memGiB: null, diskGiB: null });
    const step = (holding: { cpus: number; memGiB: number; diskGiB?: number } | null) =>
      ({ agent: "a", instruction: "x", group: 1, optional: false, status: "running", events: [], result: null, holding }) as unknown as RunRecord["steps"][number];
    writeRun("acme", "desk", { id: "r1", flow: "f", status: "running", startedAt: new Date().toISOString(), compute: { vcpu: 2 }, steps: [step({ cpus: 1, memGiB: 2, diskGiB: 8 }), step({ cpus: 1, memGiB: 1, diskGiB: 2 })] } as unknown as RunRecord);
    writeRun("acme", "desk", { id: "r2", flow: "g", status: "running", startedAt: new Date().toISOString(), steps: [step(null)] } as unknown as RunRecord);
    const held = computeHeld("acme");
    assert.deepEqual(held.total, { vcpu: 2, memGiB: 3, diskGiB: 10, steps: 2 });
    assert.deepEqual(held.workspaces.desk, { vcpu: 2, memGiB: 3, diskGiB: 10, steps: 2 });
    assert.deepEqual(held.runs, [{ workspace: "desk", runId: "r1", flow: "f", pool: { vcpu: 2, memGiB: null, diskGiB: null }, inUse: { vcpu: 2, memGiB: 3, diskGiB: 10, steps: 2 } }], "a run with no pool and nothing held is left out");
  }));

test("a caller scoped to some workspaces sees only theirs: holdings, runs and waiting steps", () =>
  withAccount(null, async () => {
    const step = (status: string, extra: Record<string, unknown>) =>
      ({ agent: "a", instruction: "x", group: 1, optional: false, status, events: [], result: null, ...extra }) as unknown as RunRecord["steps"][number];
    for (const ws of ["mine", "theirs"]) {
      const dir = path.join(accountDir("acme"), "workspaces", ws);
      fs.mkdirSync(path.join(dir, "runs"), { recursive: true });
      fs.writeFileSync(path.join(dir, "AGENTS.md"), `---\nname: ${ws}\n---\n`);
      writeRun("acme", ws, {
        id: `run-${ws}`, flow: `${ws}-flow`, status: "running", startedAt: new Date().toISOString(),
        steps: [
          step("running", { holding: { cpus: 1, memGiB: 1, diskGiB: 2 } }),
          step("pending", { roomWait: { since: new Date().toISOString(), why: `${ws} is full`, cpus: 1, memGiB: 1, diskGiB: 2 } }),
        ],
      } as unknown as RunRecord);
    }
    const held = computeHeld("acme", ["mine"]);
    assert.deepEqual(Object.keys(held.workspaces), ["mine"]);
    assert.deepEqual(held.runs.map((r) => r.workspace), ["mine"]);
    assert.equal(held.total.steps, 1);
    const waiting = roomWaiting("acme", ["mine"]);
    assert.deepEqual(waiting.map((w) => w.workspace), ["mine"]);
    assert.ok(!JSON.stringify({ held, waiting }).includes("theirs"), "nothing of the other workspace, not even its name");
  }));
