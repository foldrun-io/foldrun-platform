// The beta opt-in on real Postgres (13 Nov 2026): setBetaProgram's upsert of
// the account's beta-program row, read back through flagOn by every pod's
// cache, and tenant-delete taking it.
//
//   FOLDRUN_TEST_DATABASE_URL=postgres://… node --test tests/flags-beta-pg.test.ts

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { takeTurnsOnLiveDb } from "./live-db-lock.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
takeTurnsOnLiveDb(url);
const live = { skip: url ? false : "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" };

if (url) {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-beta-"));
  before(async () => {
    const { migrate, db } = await import("../src/db.ts");
    await migrate();
    await db()!.query("DELETE FROM feature_flags WHERE tenant LIKE 'beta-%'");
  });
  after(async () => {
    const { db } = await import("../src/db.ts");
    await db()!.query("DELETE FROM feature_flags WHERE tenant LIKE 'beta-%'");
    await db()?.end();
  });
}

test("an account joins and leaves the beta: one row, upserted; its beta flags follow; tenant-delete takes it", live, async () => {
  const f = await import("../src/flags.ts");
  const { db } = await import("../src/db.ts");
  f.resetFlagCache();
  assert.equal(await f.flagOn("beta-a", "example-beta"), false);
  assert.equal(await f.setBetaProgram("beta-a", true, "ana@a.test"), true);
  assert.equal(await f.flagOn("beta-a", "example-beta"), true);
  assert.equal(await f.setBetaProgram("beta-a", false, "ana@a.test"), true);
  assert.equal(await f.flagOn("beta-a", "example-beta"), false);
  const rows = (await db()!.query("SELECT enabled, updated_by FROM feature_flags WHERE flag = 'beta-program' AND tenant = 'beta-a'")).rows;
  assert.deepEqual(rows, [{ enabled: false, updated_by: "ana@a.test" }], "one row, updated in place");
  await f.setBetaProgram("beta-a", true, "ana@a.test");
  await f.deleteTenantFlags("beta-a");
  assert.equal(await f.betaProgram("beta-a"), false);
});
