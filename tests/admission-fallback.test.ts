// Valkey that does not answer: admission falls back to this process's own
// count — never an open door, never a locked one (FOL-477).
//
//   node --test tests/admission-fallback.test.ts

import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.FOLDRUN_REDIS_URL = "redis://127.0.0.1:1";
process.env.FOLDRUN_ADMISSION_RUN_START = "1";
const { admit, Busy } = await import("../src/admission.ts");
const { cache } = await import("../src/cache.ts");

// The client keeps trying a port nobody listens on; stop it so the run ends.
after(() => {
  cache()?.disconnect();
});

test("a Valkey that is down still holds the account's limit on this process", async () => {
  const p = await admit("run_start", "acct-down");
  await assert.rejects(admit("run_start", "acct-down"), Busy);
  assert.equal((await admit("run_start", "someone-else")).release !== undefined, true, "another account is untouched");
  await p.release();
  await (await admit("run_start", "acct-down")).release();
});
