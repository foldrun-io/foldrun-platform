// The platform's own provider keys for foldrun's models: set by an operator
// in the console, sealed at rest, bound to their provider, shown back only
// as a hint — and never read from the environment.
//
//   node --test tests/model-keys.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-model-keys-"));
process.env.FOLDRUN_SECRET_KEY = "model-keys-test-install-key";
delete process.env.FOLDRUN_DATABASE_URL;

const keys = await import("../src/model-keys.ts");
const { supplyKeyOf } = await import("../src/model-gateway.ts");
const { egressKeyValues } = await import("../src/egress-keys.ts");

const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz-WXYZ";

test("a key set in the console is sealed at rest and opens for its provider alone", async () => {
  keys.resetModelKeysForTests();
  const st = await keys.setModelKey("anthropic", KEY, "operator:ana", 0);
  assert.deepEqual({ set: st.set, hint: st.hint, version: st.version, by: st.updatedBy }, { set: true, hint: "…WXYZ", version: 1, by: "operator:ana" });
  assert.ok(!JSON.stringify(st).includes(KEY), "the status never carries the key");

  const disk = fs.readFileSync(path.join(process.env.FOLDRUN_DATA!, ".model-keys.json"), "utf8");
  assert.ok(!disk.includes(KEY) && !disk.includes("abcdefghijklmnop"), "not in the clear at rest");

  assert.equal(keys.supplyKey("anthropic"), KEY);
  assert.equal(supplyKeyOf("anthropic"), KEY, "the gateway's fill reads the store");
  assert.equal(keys.supplyKeySet("openai"), false);

  // The anthropic row copied onto openai does not open there.
  const all = JSON.parse(disk);
  all.openai = all.anthropic;
  fs.writeFileSync(path.join(process.env.FOLDRUN_DATA!, ".model-keys.json"), JSON.stringify(all));
  assert.equal(keys.supplyKey("openai"), null);
});

test("the environment is not a way in", async () => {
  keys.resetModelKeysForTests();
  process.env.FOLDRUN_SUPPLY_OPENAI_API_KEY = ["sk", "from", "the", "env", "xxxxxxxxxxxx"].join("-");
  try {
    assert.equal(supplyKeyOf("openai"), null);
    assert.equal(keys.supplyKeySet("openai"), false);
  } finally {
    delete process.env.FOLDRUN_SUPPLY_OPENAI_API_KEY;
  }
});

test("replace and remove, by version; a stale version is refused", async () => {
  keys.resetModelKeysForTests();
  await keys.setModelKey("openai", "sk-proj-first-0123456789", "operator:ana", 0);
  await assert.rejects(keys.setModelKey("openai", "sk-proj-second-0123456789", "operator:ben", 0), keys.ModelKeyConflict);
  const b = await keys.setModelKey("openai", "sk-proj-second-0123456789", "operator:ben", 1);
  assert.equal(b.version, 2);
  assert.equal(keys.supplyKey("openai"), "sk-proj-second-0123456789", "the new one is what goes out");
  await keys.setModelKey("openai", null, "operator:ben", 2);
  assert.equal(keys.supplyKey("openai"), null);
  const gone = keys.modelKeyStatuses().find((s) => s.provider === "openai")!;
  assert.deepEqual({ set: gone.set, hint: gone.hint, version: gone.version, by: gone.updatedBy }, { set: false, hint: null, version: 3, by: "operator:ben" });
  // Removed, then set again: a form read before the removal does not match.
  await keys.setModelKey("openai", "sk-proj-third-0123456789", "operator:ana", 3);
  await assert.rejects(keys.setModelKey("openai", "sk-proj-stale-0123456789", "operator:ben", 1), keys.ModelKeyConflict);
  // The audit sees what changed, never the value.
  const seen: unknown[] = [];
  await keys.setModelKey("openai", null, "operator:ana", 4, async (c) => void seen.push(c));
  assert.deepEqual(seen, [{ provider: "openai", removed: true, hint: null, version: 5, previousVersion: 4 }]);
  await keys.setModelKey("openai", null, "operator:ana", undefined, async (c) => void seen.push(c));
  assert.equal(seen.length, 1, "removing what is not there is no change, and no audit line");
});

test("what is not a key is refused before it is sealed", async () => {
  for (const bad of ["short", "sk-has a space-0123456789", "sk-line\nbreak-0123456789", "x".repeat(600)]) {
    await assert.rejects(keys.setModelKey("gemini", bad, "operator:ana"), /provider key/, JSON.stringify(bad));
  }
  await assert.rejects(keys.setModelKey("mistral", KEY, "operator:ana"), /provider is one of/);
});

test("an egress pod without the install key opens them with FOLDRUN_SUPPLY_SEAL_KEY; another install's will not", async () => {
  keys.resetModelKeysForTests();
  await keys.setModelKey("gemini", KEY, "operator:ana");
  const derived = egressKeyValues("model-keys-test-install-key").FOLDRUN_SUPPLY_SEAL_KEY;
  assert.match(derived, /^[0-9a-f]{64}$/);
  const keep = process.env.FOLDRUN_SECRET_KEY;
  delete process.env.FOLDRUN_SECRET_KEY;
  process.env.FOLDRUN_SUPPLY_SEAL_KEY = derived;
  try {
    const sealed = fs.readFileSync(path.join(process.env.FOLDRUN_DATA!, ".model-keys.json"), "utf8");
    keys.resetModelKeysForTests();
    fs.writeFileSync(path.join(process.env.FOLDRUN_DATA!, ".model-keys.json"), sealed);
    assert.equal(keys.supplyKey("gemini"), KEY);

    process.env.FOLDRUN_SUPPLY_SEAL_KEY = egressKeyValues("another-install").FOLDRUN_SUPPLY_SEAL_KEY;
    keys.resetModelKeysForTests();
    fs.writeFileSync(path.join(process.env.FOLDRUN_DATA!, ".model-keys.json"), sealed);
    assert.equal(keys.supplyKey("gemini"), null, "refused, never sent as garbage");
  } finally {
    process.env.FOLDRUN_SECRET_KEY = keep;
    delete process.env.FOLDRUN_SUPPLY_SEAL_KEY;
  }
});
