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

test(
  "a default provider: only for an account with a plan that holds no key and never chose — and only while it can be had",
  env({ ...ON, FOLDRUN_MODEL_SUPPLY_DEFAULT_PROVIDER_PLAN: "deepseek", FOLDRUN_MODEL_SUPPLY_DEEPSEEK_TIERS: "fast=deepseek-flash,default=deepseek-v4-pro" }, async () => {
    const { setSecret, deleteSecret } = await import("../../foldrun-core/src/secrets.ts");
    const { ACCOUNT_MODEL_SECRETS } = await import("../../foldrun-core/src/model-credential.ts");
    mc.resetModelChoicesForTests();
    await platformKeys(["deepseek", "anthropic"]);
    setSupplyLeversForTest([]);
    const tiers = { fast: "deepseek-flash", default: "deepseek-v4-pro" };
    const none = { kind: "none" };

    // Not read yet; no plan; a plan with no bought credit; nothing billed
    // here at all: it runs as before, and is not refused.
    await mc.setSupplyFundsForTests(async () => ({ usd: 5, plan: "pro" }));
    assert.deepEqual(mc.modelSupplyFor("lab"), none);
    for (const f of [{ usd: 5, plan: null }, { usd: 0, plan: "pro" }, { usd: null, plan: null }]) {
      await mc.setSupplyFundsForTests(async () => f, "lab");
      assert.deepEqual(mc.modelSupplyFor("lab"), none);
    }

    // A live plan, credit bought, no key of its own, never chose: the default.
    await mc.setSupplyFundsForTests(async () => ({ usd: 5, plan: "pro" }), "lab");
    assert.equal(mc.defaultSupplyProvider("lab"), "deepseek");
    assert.deepEqual(mc.modelSupplyFor("lab"), { kind: "foldrun", provider: "deepseek", tiers });

    // Its own stored key wins: bring-your-own is not taken over.
    setSecret("lab", ACCOUNT_MODEL_SECRETS.key, "sk-own-key-0123456789");
    assert.deepEqual(mc.modelSupplyFor("lab"), none);
    deleteSecret("lab", ACCOUNT_MODEL_SECRETS.key);
    assert.equal(mc.defaultSupplyProvider("lab"), "deepseek");

    // Refused to this account, or the provider's key gone: as before, not refused.
    setSupplyLeversForTest(["lab"]);
    assert.deepEqual(mc.modelSupplyFor("lab"), none);
    setSupplyLeversForTest([]);
    await keys.setModelKey("deepseek", null, "operator:test");
    assert.deepEqual(mc.modelSupplyFor("lab"), none);
    await keys.setModelKey("deepseek", "sk-deepseek-platform-0123456789", "operator:test");

    // A choice on record is a choice: "own" stays own, another provider stays.
    const own = await mc.setModelChoice("lab", { source: "own" }, "user:1");
    assert.deepEqual(mc.modelSupplyFor("lab"), none);
    await mc.setModelChoice("lab", { source: "foldrun", provider: "anthropic" }, "user:1", own.version);
    assert.deepEqual(mc.modelSupplyFor("lab"), { kind: "foldrun", provider: "anthropic", tiers: {} });

    // The setting empty, or naming nothing we know: nothing changes.
    mc.resetModelChoicesForTests();
    await env({ FOLDRUN_MODEL_SUPPLY_DEFAULT_PROVIDER_PLAN: undefined }, () => assert.deepEqual(mc.modelSupplyFor("lab"), none))();
    await env({ FOLDRUN_MODEL_SUPPLY_DEFAULT_PROVIDER_PLAN: "mistral" }, () => assert.deepEqual(mc.modelSupplyFor("lab"), none))();
    await mc.setSupplyFundsForTests(null);
  }),
);

test(
  "an account holding a Claude Code plan runs on its Claude subscription (16 Nov 2026) — unless it brought a key, chose foldrun's models, or is the operator's",
  env({ FOLDRUN_EDITION: "hosted", FOLDRUN_PLATFORM_KEY_ACCOUNTS: "ops" }, async () => {
    const { setSecret, deleteSecret } = await import("../../foldrun-core/src/secrets.ts");
    const { ACCOUNT_MODEL_SECRETS } = await import("../../foldrun-core/src/model-credential.ts");
    mc.resetModelChoicesForTests();
    await mc.loadModelChoices();
    mc.setSubscribedForTests(["planned", "keyed", "chooser", "ops"]);
    try {
      assert.deepEqual(mc.modelSupplyFor("planned"), { kind: "foldrun", provider: "anthropic", tiers: {}, via: "login" });
      assert.equal(mc.onSubscription("planned"), true);
      // Without a plan: as before.
      assert.deepEqual(mc.modelSupplyFor("someone"), { kind: "none" });
      // Its own key stands.
      setSecret("keyed", ACCOUNT_MODEL_SECRETS.key, "sk-ant-api03-own-key-0000000000");
      assert.equal(mc.onSubscription("keyed"), false);
      assert.deepEqual(mc.modelSupplyFor("keyed"), { kind: "none" });
      deleteSecret("keyed", ACCOUNT_MODEL_SECRETS.key);
      // A written choice of foldrun's models stands; a written "own" with no key does not keep it off Claude.
      await platformKeys(["openai"]);
      await mc.setModelChoice("chooser", { source: "foldrun", provider: "openai" }, "test");
      assert.equal(mc.onSubscription("chooser"), false);
      await mc.setModelChoice("chooser", { source: "own" }, "test");
      assert.equal(mc.onSubscription("chooser"), true);
      // The operator's own accounts run on the platform's credential, as before.
      assert.equal(mc.onSubscription("ops"), false);
    } finally {
      mc.setSubscribedForTests(null);
      mc.resetModelChoicesForTests();
    }
  }),
);
