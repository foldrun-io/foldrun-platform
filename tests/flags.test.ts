// Feature flags: the registry, the order an answer is decided in (account,
// then install-wide, then rollout, then default), the rollout's stable
// hash, the cache dropped on write, the audit of every change, and the
// refusals.
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
const { readAudit } = await import("../src/admin.ts");

const fresh = () => {
  fs.rmSync(path.join(process.env.FOLDRUN_DATA!, ".feature-flags.json"), { force: true });
  f.resetFlagCache();
};

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
  await f.setGlobalFlag("example-flag", { rollout: 100 }, "root@foldrun.test");
  assert.equal(await f.flagOn("acme", "example-flag"), true, "100% rollout reaches everyone");
  assert.equal((await f.effectiveFlags("acme"))[0].source, "rollout");
  await f.setGlobalFlag("example-flag", { enabled: false }, "root@foldrun.test");
  assert.equal(await f.flagOn("acme", "example-flag"), false, "global off beats the rollout");
  assert.equal((await f.flagOverview())[0].global?.rollout, 100, "a field left out is kept");
  await f.setAccountFlag("acme", "example-flag", true, "root@foldrun.test");
  assert.equal(await f.flagOn("acme", "example-flag"), true, "the account's own wins");
  assert.equal(await f.flagOn("other", "example-flag"), false);
  await f.clearAccountFlag("acme", "example-flag", "root@foldrun.test");
  assert.equal(await f.flagOn("acme", "example-flag"), false);
  await f.clearGlobalFlag("example-flag", "root@foldrun.test");
  assert.equal((await f.flagOverview())[0].global, null, "both null removes the row");
  assert.equal((await f.effectiveFlags("acme"))[0].source, "default");
});

test("rollout: a stable bucket per account and flag; raising the percentage only adds accounts", async () => {
  fresh();
  assert.equal(f.rolloutBucket("acme", "example-flag"), f.rolloutBucket("acme", "example-flag"));
  const tenants = Array.from({ length: 400 }, (_, i) => `t${i}`);
  await f.setGlobalFlag("example-flag", { rollout: 25 }, "root@foldrun.test");
  const at25 = new Set<string>();
  for (const t of tenants) if (await f.flagOn(t, "example-flag")) at25.add(t);
  assert.ok(at25.size > 60 && at25.size < 140, `about a quarter, got ${at25.size}/400`);
  await f.setGlobalFlag("example-flag", { rollout: 60 }, "root@foldrun.test");
  for (const t of at25) assert.equal(await f.flagOn(t, "example-flag"), true, `${t} stays in`);
  await f.setGlobalFlag("example-flag", { rollout: 0 }, "root@foldrun.test");
  for (const t of tenants.slice(0, 50)) assert.equal(await f.flagOn(t, "example-flag"), false);
});

test("the cache answers between writes and is dropped by one", async () => {
  fresh();
  assert.equal(await f.flagOn("acme", "example-flag"), false);
  // A change behind the module's back is not seen while the cache is warm…
  fs.writeFileSync(path.join(process.env.FOLDRUN_DATA!, ".feature-flags.json"), JSON.stringify([{ flag: "example-flag", tenant: "", enabled: true, rollout: null, updatedBy: "x", updatedAt: new Date().toISOString() }]));
  assert.equal(await f.flagOn("acme", "example-flag"), false, "cached");
  f.resetFlagCache();
  assert.equal(await f.flagOn("acme", "example-flag"), true);
  // …and a write through the module is seen at once.
  await f.setAccountFlag("acme", "example-flag", false, "root@foldrun.test");
  assert.equal(await f.flagOn("acme", "example-flag"), false);
});

test("every write is audited, against the account or the platform", async () => {
  fresh();
  await f.setGlobalFlag("example-flag", { enabled: true }, "root@foldrun.test");
  await f.setAccountFlag("acme", "example-flag", false, "root@foldrun.test");
  await f.clearAccountFlag("acme", "example-flag", "root@foldrun.test");
  await f.clearGlobalFlag("example-flag", "root@foldrun.test");
  const log = (await readAudit({ limit: 4 })).map((e) => [e.action, e.tenant, e.by]);
  assert.deepEqual(log, [
    ["flag.global_cleared", "foldrun", "root@foldrun.test"],
    ["flag.account_cleared", "acme", "root@foldrun.test"],
    ["flag.account", "acme", "root@foldrun.test"],
    ["flag.global", "foldrun", "root@foldrun.test"],
  ]);
  const before = (await readAudit({ limit: 100 })).length;
  await f.clearAccountFlag("acme", "example-flag", "root@foldrun.test");
  assert.equal((await readAudit({ limit: 100 })).length, before, "clearing nothing writes nothing");
});

test("refusals: an unknown flag is 404, bad values 400", async () => {
  fresh();
  const status = (n: number) => (e: Error & { status?: number }) => e.status === n;
  await assert.rejects(f.setGlobalFlag("nope", { enabled: true }, "r"), status(404));
  await assert.rejects(f.setAccountFlag("acme", "nope", true, "r"), status(404));
  await assert.rejects(f.setGlobalFlag("example-flag", {}, "r"), status(400));
  await assert.rejects(f.setGlobalFlag("example-flag", { enabled: "yes" }, "r"), status(400));
  for (const rollout of [-1, 101, 2.5, "50"]) await assert.rejects(f.setGlobalFlag("example-flag", { rollout }, "r"), status(400));
  await assert.rejects(f.setAccountFlag("acme", "example-flag", "on", "r"), status(400));
  await assert.rejects(f.setAccountFlag("../etc", "example-flag", true, "r"), status(400));
});

test("tenant-delete takes the account's overrides and leaves everyone else's", async () => {
  fresh();
  await f.setAccountFlag("gone", "example-flag", true, "r");
  await f.setAccountFlag("kept", "example-flag", true, "r");
  await f.deleteTenantFlags("gone");
  assert.deepEqual((await f.flagOverview())[0].accounts.map((a) => a.tenant), ["kept"]);
});
