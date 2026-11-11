// End customers (FOL-168): the block list and the limits an account sets for
// its own users, and the run-start check — file store (no database here;
// the Postgres store runs the same calls in the DB-gated suite).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-customers-"));
delete process.env.FOLDRUN_DATABASE_URL;
const c = await import("../src/customers.ts");

test("blocks: idempotent, listed with who and why, undone; limits: defaults, an admin's own, null back to the default, bad values refused", async () => {
  c.forgetBlocks();
  assert.equal(await c.isBlocked("acme", "c-1"), false);
  await c.blockCustomer("acme", "c-1", "ana@acme.test", "  spam  ");
  await c.blockCustomer("acme", "c-1", "bob@acme.test", "again");
  const list = await c.listBlocked("acme");
  assert.equal(list.length, 1);
  assert.equal(list[0]!.by, "ana@acme.test", "a second block keeps the first one's who");
  assert.equal(list[0]!.reason, "spam");
  assert.equal(await c.isBlocked("acme", "c-1"), true);
  assert.equal(await c.isBlocked("rival", "c-1"), false, "an account's blocks are its own");
  assert.equal(await c.unblockCustomer("acme", "c-1"), true);
  assert.equal(await c.unblockCustomer("acme", "c-1"), false);
  assert.equal(await c.isBlocked("acme", "c-1"), false);

  assert.deepEqual(await c.customerLimits("acme"), c.CUSTOMER_DEFAULTS);
  const set = await c.setCustomerLimits("acme", { startsPerMinute: 5 }, "ana@acme.test");
  assert.equal(set.startsPerMinute, 5);
  assert.equal(set.gatewayRpm, c.CUSTOMER_DEFAULTS.gatewayRpm);
  assert.equal((await c.setCustomerLimits("acme", { startsPerMinute: null }, "ana@acme.test")).startsPerMinute, c.CUSTOMER_DEFAULTS.startsPerMinute);
  assert.match(c.limitsProblem({ startsPerMinute: 0 }) ?? "", /whole number from 1/);
  assert.match(c.limitsProblem({ nope: 1 }) ?? "", /not a customer limit/);
  await assert.rejects(c.setCustomerLimits("acme", { gatewayRpm: 2.5 }, "x"), /whole number/);
});

test("a run start: refused for a blocked customer (403) and past its starts a minute (429); another customer is not held", async () => {
  c.forgetBlocks();
  await c.blockCustomer("acme", "c-bad", "ana@acme.test");
  await assert.rejects(c.admitCustomerStart("acme", "c-bad"), (e: unknown) => e instanceof c.CustomerRefused && e.status === 403 && e.code === "customer_blocked");
  await c.setCustomerLimits("acme", { startsPerMinute: 2 }, "ana@acme.test");
  await c.admitCustomerStart("acme", "c-busy");
  await c.admitCustomerStart("acme", "c-busy");
  await assert.rejects(c.admitCustomerStart("acme", "c-busy"), (e: unknown) => e instanceof c.CustomerRefused && e.status === 429 && e.code === "customer_rate" && typeof e.retryAfter === "number");
  await c.admitCustomerStart("acme", "c-calm");
});

test("an unreadable customers file refuses rather than reading as 'nobody is blocked' (Codex review)", async () => {
  c.forgetBlocks();
  const f = path.join(process.env.FOLDRUN_DATA!, "broken", ".foldrun", "customers.json");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "{ not json");
  await assert.rejects(c.isBlocked("broken", "c-1"));
  await assert.rejects(c.blockCustomer("broken", "c-2", "x"), "a write after it does not replace the blocks with nothing");
  assert.equal(fs.readFileSync(f, "utf8"), "{ not json");
});
