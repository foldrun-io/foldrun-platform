// Feature flags as the platform reads them: the registry, the order an
// answer is decided in (account, then install-wide, then rollout, then
// default), the rollout's stable hash, the cache, and tenant-delete.
// (Making a decision — and its audit — is the hosted operator console's:
// foldrun-admin platform/tests/flags-admin.test.ts. The rows are put in
// place directly here.)
//
//   node --test tests/flags.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-flags-"));
delete process.env.FOLDRUN_DATABASE_URL;

const f = await import("../src/flags.ts");

const fresh = () => {
  fs.rmSync(path.join(process.env.FOLDRUN_DATA!, ".feature-flags.json"), { force: true });
  f.resetFlagCache();
};

/** A decision as the console would have stored it: replace this flag and
 *  tenant's row (null removes it). */
function put(tenant: string, row: { enabled: boolean | null; rollout: number | null } | null) {
  const rows = f.readFlagFile().filter((r) => !(r.flag === "example-flag" && r.tenant === tenant));
  if (row) rows.push({ flag: "example-flag", tenant, ...row, updatedBy: "root@foldrun.test", updatedAt: new Date().toISOString() });
  f.writeFlagFile(rows);
  f.resetFlagCache();
}

test("the registry: kebab-case names, an owner and a description each, rollouts in 0–100, the example off", () => {
  const names = new Set<string>();
  for (const d of f.FLAGS as readonly import("../src/flags.ts").FlagDef[]) {
    assert.match(d.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(!names.has(d.name), `${d.name} twice`);
    names.add(d.name);
    assert.ok(d.description.length > 10 && d.owner, d.name);
    if (d.rollout !== undefined) assert.ok(Number.isInteger(d.rollout) && d.rollout >= 0 && d.rollout <= 100, d.name);
  }
  const ex = f.flagDef("example-flag");
  assert.equal(ex?.default, false, "the example ships off");
});

test("nothing set: the default decides; an unknown flag is off", async () => {
  fresh();
  assert.equal(await f.flagOn("acme", "example-flag"), false);
  assert.equal(await f.flagOn("acme", "no-such-flag"), false);
  const [ex] = (await f.effectiveFlags("acme")).filter((x) => x.name === "example-flag");
  assert.deepEqual([ex.on, ex.source, ex.rollout], [false, "default", null]);
});

test("account override beats the install-wide setting, which beats the rollout", async () => {
  fresh();
  put("", { enabled: null, rollout: 100 });
  assert.equal(await f.flagOn("acme", "example-flag"), true, "100% rollout reaches everyone");
  assert.equal((await f.effectiveFlags("acme"))[0].source, "rollout");
  put("", { enabled: false, rollout: 100 });
  assert.equal(await f.flagOn("acme", "example-flag"), false, "global off beats the rollout");
  assert.equal((await f.effectiveFlags("acme"))[0].source, "global");
  put("acme", { enabled: true, rollout: null });
  assert.equal(await f.flagOn("acme", "example-flag"), true, "the account's own wins");
  assert.equal((await f.effectiveFlags("acme"))[0].source, "account");
  assert.equal(await f.flagOn("other", "example-flag"), false);
  put("acme", null);
  assert.equal(await f.flagOn("acme", "example-flag"), false);
  put("", null);
  assert.equal((await f.effectiveFlags("acme"))[0].source, "default");
});

test("rollout: a stable bucket per account and flag; raising the percentage only adds accounts", async () => {
  fresh();
  assert.equal(f.rolloutBucket("acme", "example-flag"), f.rolloutBucket("acme", "example-flag"));
  const tenants = Array.from({ length: 400 }, (_, i) => `t${i}`);
  put("", { enabled: null, rollout: 25 });
  const at25 = new Set<string>();
  for (const t of tenants) if (await f.flagOn(t, "example-flag")) at25.add(t);
  assert.ok(at25.size > 60 && at25.size < 140, `about a quarter, got ${at25.size}/400`);
  put("", { enabled: null, rollout: 60 });
  for (const t of at25) assert.equal(await f.flagOn(t, "example-flag"), true, `${t} stays in`);
  put("", { enabled: null, rollout: 0 });
  for (const t of tenants.slice(0, 50)) assert.equal(await f.flagOn(t, "example-flag"), false);
});

test("the cache answers until it is dropped", async () => {
  fresh();
  assert.equal(await f.flagOn("acme", "example-flag"), false);
  // A change behind the module's back is not seen while the cache is warm…
  fs.writeFileSync(path.join(process.env.FOLDRUN_DATA!, ".feature-flags.json"), JSON.stringify([{ flag: "example-flag", tenant: "", enabled: true, rollout: null, updatedBy: "x", updatedAt: new Date().toISOString() }]));
  assert.equal(await f.flagOn("acme", "example-flag"), false, "cached");
  f.resetFlagCache();
  assert.equal(await f.flagOn("acme", "example-flag"), true);
});

test("tenant-delete takes the account's overrides and leaves everyone else's", async () => {
  fresh();
  put("gone", { enabled: true, rollout: null });
  put("kept", { enabled: true, rollout: null });
  await f.deleteTenantFlags("gone");
  assert.equal(await f.flagOn("gone", "example-flag"), false);
  assert.equal(await f.flagOn("kept", "example-flag"), true);
  assert.deepEqual(f.readFlagFile().map((r) => r.tenant), ["kept"]);
});

// ------------------------------------------------------------------ the beta

/** A row for any flag, as the console would store it. */
function putFlag(flag: string, tenant: string, row: { enabled: boolean | null; rollout: number | null } | null) {
  const rows = f.readFlagFile().filter((r) => !(r.flag === flag && r.tenant === tenant));
  if (row) rows.push({ flag, tenant, ...row, updatedBy: "root@foldrun.test", updatedAt: new Date().toISOString() });
  f.writeFlagFile(rows);
  f.resetFlagCache();
}

test("a beta flag is on for an account in the beta and off for the rest; a plain flag is not touched (13 Nov 2026)", async () => {
  fresh();
  assert.equal(await f.flagOn("acme", "example-beta"), false);
  assert.equal(await f.setBetaProgram("acme", true, "ana@acme.test"), true, "joining changed something");
  assert.equal(await f.setBetaProgram("acme", true, "ana@acme.test"), false, "joining twice does not");
  assert.equal(await f.betaProgram("acme"), true);
  assert.equal(await f.flagOn("acme", "example-beta"), true);
  assert.equal(await f.flagOn("other", "example-beta"), false, "only the account that opted in");
  assert.equal(await f.flagOn("acme", "example-flag"), false, "a flag not marked beta stays as it was");
  const row = (await f.effectiveFlags("acme")).find((x) => x.name === "example-beta")!;
  assert.deepEqual([row.on, row.source, row.beta], [true, "beta", true]);
  assert.equal(await f.setBetaProgram("acme", false, "ana@acme.test"), true);
  assert.equal(await f.flagOn("acme", "example-beta"), false, "leaving the beta turns it off again");
});

test("the operator still decides first: an account or install-wide override beats the beta", async () => {
  fresh();
  await f.setBetaProgram("acme", true, "ana@acme.test");
  putFlag("example-beta", "acme", { enabled: false, rollout: null });
  assert.equal(await f.flagOn("acme", "example-beta"), false, "the account's own override");
  putFlag("example-beta", "acme", null);
  putFlag("example-beta", "", { enabled: false, rollout: null });
  assert.equal(await f.flagOn("acme", "example-beta"), false, "the install-wide off");
  putFlag("example-beta", "", null);
  // The operator may put an account in the beta, or take it out.
  putFlag("beta-program", "zeta", { enabled: true, rollout: null });
  assert.equal(await f.flagOn("zeta", "example-beta"), true);
  putFlag("beta-program", "acme", { enabled: false, rollout: null });
  assert.equal(await f.flagOn("acme", "example-beta"), false);
});

test("tenant-delete takes the account's beta opt-in with its other overrides", async () => {
  fresh();
  await f.setBetaProgram("acme", true, "ana@acme.test");
  await f.deleteTenantFlags("acme");
  assert.equal(await f.betaProgram("acme"), false);
});
