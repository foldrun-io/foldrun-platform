// Which accounts may run on the platform's own model credential.
//
//   node --test tests/platform-key-accounts.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { platformKeyAllowed } from "../src/index.ts";

test("unset or * means every account: a laptop and a self-hosted install are unchanged", () => {
  assert.equal(platformKeyAllowed("anyone", {}), true);
  assert.equal(platformKeyAllowed("anyone", { FOLDRUN_PLATFORM_KEY_ACCOUNTS: "*" }), true);
});

test("set, only the listed accounts may; spaces are forgiven, prefixes are not", () => {
  const env = { FOLDRUN_PLATFORM_KEY_ACCOUNTS: " alpha, ops-account ,deploy-smoke" };
  assert.equal(platformKeyAllowed("alpha", env), true);
  assert.equal(platformKeyAllowed("ops-account", env), true);
  assert.equal(platformKeyAllowed("deploy-smoke", env), true);
  assert.equal(platformKeyAllowed("new-customer", env), false);
  assert.equal(platformKeyAllowed("mat", env), false);
});
