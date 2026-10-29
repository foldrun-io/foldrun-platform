// Operator settings (settings.ts): the registry, the reader's precedence
// (row → environment → default), resets, the poll, the cross-key rules and
// the platform-key lever's fail-closed rule. On the file store; the
// Postgres half is in tests/settings-db.test.ts.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-settings-"));
delete process.env.FOLDRUN_DATABASE_URL;

const s = await import("../src/settings.ts");

const row = (key: string, value: unknown, version: number) => ({ key, value, version, updatedBy: "op@example.com", updatedAt: new Date().toISOString() }) as never;

beforeEach(() => {
  s.writeSettingsFile([]);
  s.resetSettingsSnapshot();
  for (const k of ["FOLDRUN_PLAN_WORKSPACES", "FOLDRUN_OPEN_SIGNUP", "FOLDRUN_RUNNER_MEMORY", "FOLDRUN_RUNNER_MEMORY_HEAVY", "FOLDRUN_RUN_MEMORY_GIB", "FOLDRUN_PLATFORM_KEY_ACCOUNTS", "FOLDRUN_NODE_MAX_MEMORY_GIB", "FOLDRUN_RETENTION_DAYS"]) delete process.env[k];
});

test("every open key is dotted, has a legacy variable, and keys and variables are unique", () => {
  const defs = s.settingDefs();
  assert.ok(defs.length >= 30, "the open registry");
  assert.equal(new Set(defs.map((d) => d.key)).size, defs.length);
  assert.equal(new Set(defs.map((d) => d.env)).size, defs.length);
  for (const d of defs) {
    assert.match(d.key, /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/);
    assert.match(d.env, /^[A-Z][A-Z0-9_]+$/);
    assert.ok(s.SETTING_GROUPS.some((g) => g.id === d.group), `${d.key}: a known group`);
    assert.ok(d.help.length > 10, `${d.key}: says what it does`);
  }
});

test("a key registered twice under another variable is refused", () => {
  assert.throws(() => s.registerSettings([{ ...s.settingDef("plan.workspaces")!, env: "FOLDRUN_SOMETHING_ELSE" }]), /collides/);
});

test("precedence: the row, else the environment, else the default — and a reset falls back", async () => {
  assert.equal(s.settingText("FOLDRUN_PLAN_WORKSPACES"), undefined);
  assert.deepEqual([s.setting("plan.workspaces"), s.effectiveSettings().find((e) => e.def.key === "plan.workspaces")!.source], [null, "default"]);

  process.env.FOLDRUN_PLAN_WORKSPACES = "3";
  assert.equal(s.settingText("FOLDRUN_PLAN_WORKSPACES"), "3", "no row: the variable, as before");
  assert.equal(s.setting("plan.workspaces"), 3);

  s.writeSettingsFile([row("plan.workspaces", 5, 1)]);
  await s.loadSettings();
  assert.equal(s.settingText("FOLDRUN_PLAN_WORKSPACES"), "5", "the row over the variable");
  assert.equal(s.effectiveSettings().find((e) => e.def.key === "plan.workspaces")!.source, "row");

  s.writeSettingsFile([row("plan.workspaces", null, 2)]);
  await s.loadSettings();
  assert.equal(s.settingText("FOLDRUN_PLAN_WORKSPACES"), "3", "a reset (tombstone): the variable again");
  const e = s.effectiveSettings().find((x) => x.def.key === "plan.workspaces")!;
  assert.equal(e.version, 2, "the tombstone's version is what the next write names");
});

test("booleans are spelled as the variable was: 1 and 0", async () => {
  s.writeSettingsFile([row("signup.open", true, 1)]);
  await s.loadSettings();
  assert.equal(s.settingText("FOLDRUN_OPEN_SIGNUP"), "1");
  s.writeSettingsFile([row("signup.open", false, 2)]);
  await s.loadSettings();
  assert.equal(s.settingText("FOLDRUN_OPEN_SIGNUP"), "0");
  process.env.FOLDRUN_OPEN_SIGNUP = "1";
  assert.equal(s.settingText("FOLDRUN_OPEN_SIGNUP"), "0", "the operator closed it, whatever the variable says");
});

test("settingsEnv lays rows over process.env for env-shaped readers, and passes other variables through", async () => {
  s.writeSettingsFile([row("room.run_memory_gib", 22, 1)]);
  await s.loadSettings();
  const env = s.settingsEnv();
  assert.equal(env.FOLDRUN_RUN_MEMORY_GIB, "22");
  process.env.FOLDRUN_SOME_OTHER = "x";
  assert.equal(env.FOLDRUN_SOME_OTHER, "x");
  delete process.env.FOLDRUN_SOME_OTHER;
  const { roomLimits } = await import("../src/pod-room.ts");
  assert.equal(roomLimits().budgetGiB, 22, "the room gate reads the setting");
});

test("a variable no setting owns, or a row for a key nobody registered, changes nothing", async () => {
  s.writeSettingsFile([row("no.such_key", 9, 1)]);
  await s.loadSettings();
  assert.equal(s.settingText("FOLDRUN_DATABASE_URL"), undefined);
  assert.equal(s.effectiveSettings().some((e) => e.def.key === "no.such_key"), false);
});

test("the poll notices a write another pod made, even one numbered lower than the last", async () => {
  s.writeSettingsFile([row("plan.workspaces", 5, 11)]);
  await s.loadSettings();
  // A write that took version 10 but committed after 11: max() would miss
  // it; the sum does not.
  s.writeSettingsFile([row("plan.workspaces", 5, 11), row("plan.concurrency", 2, 10)]);
  await s.pollSettings();
  assert.equal(s.settingText("FOLDRUN_PLAN_CONCURRENCY"), "2");
});

test("a store that will not answer keeps the last snapshot", async () => {
  s.writeSettingsFile([row("plan.workspaces", 7, 1)]);
  await s.loadSettings();
  const file = path.join(process.env.FOLDRUN_DATA!, ".platform-settings.json");
  fs.writeFileSync(file, "{ not json");
  await s.pollSettings();
  assert.equal(s.settingText("FOLDRUN_PLAN_WORKSPACES"), "7");
});

test("values are checked against their key", () => {
  const def = (k: string) => s.settingDef(k)!;
  assert.deepEqual(s.parseSettingValue(def("plan.workspaces"), "4"), { value: 4 });
  assert.ok("error" in s.parseSettingValue(def("plan.workspaces"), 1.5));
  assert.ok("error" in s.parseSettingValue(def("plan.workspaces"), -1));
  assert.ok("error" in s.parseSettingValue(def("signup.open"), "1"), "a boolean is true or false");
  assert.ok("error" in s.parseSettingValue(def("runner.memory"), "lots"));
  assert.deepEqual(s.parseSettingValue(def("runner.memory"), "6Gi"), { value: "6Gi" });
  assert.deepEqual(s.parseSettingValue(def("runner.memory_small"), "0.5Gi"), { value: "0.5Gi" });
  for (const zero of ["0Gi", "0.0g", "00Mi"]) assert.ok("error" in s.parseSettingValue(def("runner.memory_small"), zero), `${zero}: Docker reads 0 as no limit`);
  assert.ok("error" in s.parseSettingValue(def("mail.from"), "x\r\nBcc: a@b.c <a@b.c>"));
  assert.deepEqual(s.parseSettingValue(def("mail.from"), "foldrun <hello@foldrun.io>"), { value: "foldrun <hello@foldrun.io>" });
});

test("the environment is read the way the code reads it", () => {
  const def = (k: string) => s.settingDef(k)!;
  assert.equal(s.parseEnvValue(def("signup.open"), "1"), true);
  assert.equal(s.parseEnvValue(def("signup.open"), "yes"), false, "only 1 is on");
  assert.equal(s.parseEnvValue(def("signup.open"), ""), null);
  assert.equal(s.parseEnvValue(def("plan.workspaces"), "abc"), null);
});

test("cross-key rules: sizes in order, a heavy step fits the namespace and the node", () => {
  let v = s.validateSettingChanges({ "runner.memory": "16Gi" });
  assert.equal(v.ok, false, "default bigger than heavy (8Gi)");
  assert.match(v.errors[0]!.message, /memory must not shrink/);
  v = s.validateSettingChanges({ "room.run_memory_gib": 4 });
  assert.equal(v.ok, false, "a namespace smaller than one heavy step");
  process.env.FOLDRUN_NODE_MAX_MEMORY_GIB = "6";
  v = s.validateSettingChanges({ "runner.memory_heavy": "7Gi" });
  assert.ok(v.errors.some((e) => e.rule === "runner.fits-node"));
  v = s.validateSettingChanges({ "step.max_vcpu": 8, "account.vcpu": 4 });
  assert.ok(v.errors.some((e) => e.rule === "step.within-account"));
  v = s.validateSettingChanges({ "plan.workspaces": 3 });
  assert.deepEqual(v, { ok: true, errors: [], values: { "plan.workspaces": 3 } });
});

test("a reset is validated as what it falls back to", () => {
  process.env.FOLDRUN_RUNNER_MEMORY = "16Gi";
  const v = s.validateSettingChanges({ "runner.memory": null }, [row("runner.memory", "2Gi", 1)]);
  assert.equal(v.values["runner.memory"], "16Gi");
  assert.equal(v.ok, false, "falling back to a variable that breaks a rule is refused like a change");
});

test("which changes want a typed reason", () => {
  const def = (k: string) => s.settingDef(k)!;
  assert.equal(s.needsConfirm(def("signup.open"), false, true), true, "opening sign-up");
  assert.equal(s.needsConfirm(def("signup.open"), true, false), false, "closing it");
  assert.equal(s.needsConfirm(def("runs.retention_days"), null, 30), true, "kept for ever → 30 days is lower");
  assert.equal(s.needsConfirm(def("runs.retention_days"), 30, 90), false);
  assert.equal(s.needsConfirm(def("runs.retention_days"), 90, 0), false, "0 is kept for ever");
  assert.equal(s.needsConfirm(def("plan.workspaces"), 1, 9), false);
});

test("platform key, hosted: fail-closed — the lever, else named accounts only; refusal wins; a stale grant lapses", () => {
  const env = { FOLDRUN_PLATFORM_KEY_ACCOUNTS: "ops,smoke" };
  assert.equal(s.platformKeyAllowedFor("anyone", true, {}), false, "unset is nobody, hosted");
  assert.equal(s.platformKeyAllowedFor("anyone", true, { FOLDRUN_PLATFORM_KEY_ACCOUNTS: "*" }), false, "* is nobody, hosted");
  assert.equal(s.platformKeyAllowedFor("ops", true, env), true, "named, for the release the variable is still stated");
  s.setPlatformKeyAccountsForTest(["acme"], ["ops"]);
  assert.equal(s.platformKeyAllowedFor("acme", true, {}), true, "granted by the lever");
  assert.equal(s.platformKeyAllowedFor("other", true, {}), false);
  assert.equal(s.platformKeyAllowedFor("ops", true, env), false, "a refusal beats the legacy list");
  s.ageSnapshotForTest(s.PLATFORM_KEY_MAX_AGE_MS + 1000);
  assert.equal(s.platformKeyAllowedFor("acme", true, {}), false, "a grant the store has not confirmed lately lapses");
  assert.equal(s.platformKeyAllowedFor("ops", true, env), false, "a refusal does not lapse with an outage");
});

test("platform key, self-hosted: the variable as it always was", () => {
  assert.equal(s.platformKeyAllowedFor("anyone", false, {}), true);
  assert.equal(s.platformKeyAllowedFor("anyone", false, { FOLDRUN_PLATFORM_KEY_ACCOUNTS: "*" }), true);
  assert.equal(s.platformKeyAllowedFor("b", false, { FOLDRUN_PLATFORM_KEY_ACCOUNTS: "a" }), false);
});

test("every open key's variable is read through the settings, not process.env, in the code", () => {
  // The fallback is settings.ts's to do: a call site still reading
  // process.env.X would ignore the operator's row.
  const roots = ["../src", "../../foldrun-core/src", "../../foldrun-web/server", "../../foldrun-web/app"].map((r) => path.join(import.meta.dirname, r));
  const files: string[] = [];
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name) && !p.endsWith("settings.ts")) files.push(p);
    }
  };
  roots.forEach(walk);
  const offenders: string[] = [];
  for (const d of s.OPEN_SETTINGS) {
    const re = new RegExp(`process\\.env(\\.${d.env}\\b|\\[["'\`]${d.env}["'\`]\\])`);
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
      if (re.test(src)) offenders.push(`${path.relative(path.join(import.meta.dirname, "../.."), f)}: ${d.env}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("foldrun-infra's list of setting variables is the registry's (when infra is beside this repo)", async (t) => {
  const list = path.join(import.meta.dirname, "../../foldrun-infra/dev/ci/settings-env.txt");
  if (!fs.existsSync(list)) return t.skip("no ../foldrun-infra/dev/ci/settings-env.txt here");
  const hosted = fs.existsSync(path.join(import.meta.dirname, "../src/settings-hosted.ts"));
  if (hosted) await import("../src/settings-hosted.ts" as string);
  const listed = new Set(fs.readFileSync(list, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")));
  const registered = new Set(s.settingDefs().map((d) => d.env));
  assert.deepEqual([...registered].filter((e) => !listed.has(e)), [], "a setting whose variable infra does not know");
  if (hosted) {
    const extra = [...listed].filter((e) => !registered.has(e) && e !== "FOLDRUN_PLATFORM_KEY_ACCOUNTS" && e !== "FOLDRUN_SETTINGS_SEED");
    assert.deepEqual(extra, [], "a listed variable no setting reads");
  }
});
