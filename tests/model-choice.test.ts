// What an account chose to run on, and what the platform answers the runner
// for it (core platform.modelSupply): its own key; foldrun's models for a
// provider; or refused, and why — never quietly something else.
//
//   node --test tests/model-choice.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-model-choice-"));
delete process.env.FOLDRUN_DATABASE_URL;

const mc = await import("../src/model-choice.ts");
const { setSupplyLeversForTest } = await import("../src/settings.ts");
const keys = await import("../src/model-keys.ts");

/** The platform's keys, as an operator sets them in the console. */
async function platformKeys(providers: string[]) {
  keys.resetModelKeysForTests();
  for (const p of providers) await keys.setModelKey(p, `sk-${p}-platform-0123456789`, "operator:test");
}

function env(vars: Record<string, string | undefined>, body: () => void | Promise<void>) {
  return async () => {
    const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      await body();
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
}

const ON = { FOLDRUN_MODEL_SUPPLY: "1" };

test("no choice, or the own key: the runner is told none", () => {
  mc.resetModelChoicesForTests();
  assert.deepEqual(mc.modelSupplyFor("acme"), { kind: "none" });
});

test(
  "a choice is written once per change, versioned, validated",
  env(ON, async () => {
    mc.resetModelChoicesForTests();
    const a = await mc.setModelChoice("acme", { source: "foldrun", provider: "anthropic" }, "user:1", 0);
    assert.equal(a.version, 1);
    assert.equal(mc.modelChoiceOf("acme").provider, "anthropic");
    await assert.rejects(mc.setModelChoice("acme", { source: "own" }, "user:1", 0), mc.ChoiceConflict, "a stale version is refused");
    const b = await mc.setModelChoice("acme", { source: "own", provider: "anthropic" }, "user:1", 1);
    assert.equal(b.version, 2);
    assert.equal(b.provider, null, "own carries no provider");
    await assert.rejects(mc.setModelChoice("acme", { source: "foldrun", provider: "mistral" }, "user:1"), /provider is one of/);
  }),
);

test(
  "foldrun's models when they stand; refused with why when they do not",
  env(ON, async () => {
    mc.resetModelChoicesForTests();
    await platformKeys(["anthropic", "openai"]);
    setSupplyLeversForTest([]);
    await mc.setModelChoice("acme", { source: "foldrun", provider: "anthropic" }, "user:1");
    assert.deepEqual(mc.modelSupplyFor("acme"), { kind: "foldrun", provider: "anthropic", tiers: {} });

    setSupplyLeversForTest(["acme"]);
    const denied = mc.modelSupplyFor("acme");
    assert.equal(denied.kind, "refused");
    setSupplyLeversForTest([]);

    await env({ FOLDRUN_MODEL_SUPPLY: "0" }, () => {
      const off = mc.modelSupplyFor("acme");
      assert.ok(off.kind === "refused" && /switched off/.test(off.reason));
    })();

    // OpenAI without its tiers set is not offered: the tier words would mean nothing there.
    await mc.setModelChoice("acme", { source: "foldrun", provider: "openai" }, "user:1");
    const noTiers = mc.modelSupplyFor("acme");
    assert.ok(noTiers.kind === "refused" && /not set up/.test(noTiers.reason));
    await env({ FOLDRUN_MODEL_SUPPLY_OPENAI_TIERS: "fast=gpt-mini,default=gpt-x" }, () => {
      assert.deepEqual(mc.modelSupplyFor("acme"), { kind: "foldrun", provider: "openai", tiers: { fast: "gpt-mini", default: "gpt-x" } });
      assert.deepEqual(mc.availableProviders().sort(), ["anthropic", "openai"], "gemini, deepseek and moonshot hold no key here");
    })();

    // The platform's key removed in the console: refused, not run on something else.
    await mc.setModelChoice("acme", { source: "foldrun", provider: "anthropic" }, "user:1");
    await keys.setModelKey("anthropic", null, "operator:test");
    const gone = mc.modelSupplyFor("acme");
    assert.ok(gone.kind === "refused" && /not available/.test(gone.reason));
    await keys.setModelKey("anthropic", "sk-anthropic-platform-0123456789", "operator:test");
    await env({ FOLDRUN_MODEL_SUPPLY_PROVIDERS: "openai" }, () => {
      const unlisted = mc.modelSupplyFor("acme");
      assert.ok(unlisted.kind === "refused" && /not offered/.test(unlisted.reason));
    })();
  }),
);
