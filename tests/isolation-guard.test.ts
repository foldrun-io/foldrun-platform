// A multi-tenant install must not boot without step isolation.
//
// Without FOLDRUN_RUN_ISOLATION a step runs in the platform's own process:
// right on a laptop, catastrophic for a SaaS, where one tenant's agent would
// hold the platform's filesystem, its vault and every other account's data.
// Nothing refused that configuration — a missing or misspelled env var
// degraded silently from sandboxed to shared. These pin the refusal.
//
//   node --test tests/isolation-guard.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertIsolationSafe } from "../src/queue.ts";

function withTenants(names: string[], body: () => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-iso-"));
  for (const n of names) fs.mkdirSync(path.join(root, n, "workspaces"), { recursive: true });
  const prevData = process.env.FOLDRUN_DATA;
  const prevIso = process.env.FOLDRUN_RUN_ISOLATION;
  const prevMulti = process.env.FOLDRUN_MULTI_TENANT;
  process.env.FOLDRUN_DATA = root;
  try {
    body();
  } finally {
    prevData === undefined ? delete process.env.FOLDRUN_DATA : (process.env.FOLDRUN_DATA = prevData);
    prevIso === undefined ? delete process.env.FOLDRUN_RUN_ISOLATION : (process.env.FOLDRUN_RUN_ISOLATION = prevIso);
    prevMulti === undefined ? delete process.env.FOLDRUN_MULTI_TENANT : (process.env.FOLDRUN_MULTI_TENANT = prevMulti);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("one account without isolation is fine — a laptop has nothing to isolate from", () => {
  withTenants(["solo"], () => {
    delete process.env.FOLDRUN_RUN_ISOLATION;
    delete process.env.FOLDRUN_MULTI_TENANT;
    assert.doesNotThrow(() => assertIsolationSafe());
  });
});

test("two accounts without isolation refuses to start", () => {
  withTenants(["alice", "bob"], () => {
    delete process.env.FOLDRUN_RUN_ISOLATION;
    delete process.env.FOLDRUN_MULTI_TENANT;
    assert.throws(() => assertIsolationSafe(), /refusing to start/i);
  });
});

test("a misspelled isolation mode is treated as unset, not as configured", () => {
  withTenants(["alice", "bob"], () => {
    process.env.FOLDRUN_RUN_ISOLATION = "kubernetes"; // not "k8s"
    assert.throws(() => assertIsolationSafe(), /not a recognised mode/i);
  });
});

test("declaring multi-tenant refuses even with a single account today", () => {
  withTenants(["solo"], () => {
    delete process.env.FOLDRUN_RUN_ISOLATION;
    process.env.FOLDRUN_MULTI_TENANT = "1";
    assert.throws(() => assertIsolationSafe(), /FOLDRUN_MULTI_TENANT=1 is set/);
  });
});

test("either real isolation mode is accepted", () => {
  withTenants(["alice", "bob"], () => {
    for (const mode of ["k8s", "container"]) {
      process.env.FOLDRUN_RUN_ISOLATION = mode;
      assert.doesNotThrow(() => assertIsolationSafe(), mode);
    }
  });
});
