// A provider key or an account's model choice written on one pod reaches the
// others by NOTIFY, not at their next 10 s poll (FOL-476, plan section 3).
//
//   FOLDRUN_TEST_DATABASE_URL=postgres://foldrun:test@localhost:55432/foldrun \
//     node --test tests/model-config-notify-db.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { takeTurnsOnLiveDb } from "./live-db-lock.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
const opts = { skip: url ? false : "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" };
takeTurnsOnLiveDb(url);

if (url) {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  process.env.FOLDRUN_SECRET_KEY ??= "test-install-key";
  delete process.env.FOLDRUN_PG_LISTEN;
}

const until = async (ok: () => boolean, ms = 3000) => {
  for (let t = 0; t < ms && !ok(); t += 25) await new Promise((r) => setTimeout(r, 25));
  return ok();
};

test("a choice written elsewhere is heard at once; both writers announce themselves", opts, async () => {
  const { migrate, ormRequired } = await import("../src/db.ts");
  await migrate();
  const { sql } = await import("drizzle-orm");
  const choice = await import("../src/model-choice.ts");
  const keys = await import("../src/model-keys.ts");
  const { listen, listening, stopListening } = await import("../src/pg-listen.ts");
  const tenant = `mc${Date.now()}`;
  const heard: string[] = [];
  try {
    await choice.startModelChoices();
    await keys.startModelKeys();
    listen(keys.MODEL_CONFIG_CHANNEL, (what) => heard.push(what));
    assert.ok(await until(() => listening(keys.MODEL_CONFIG_CHANNEL)), "LISTEN is in effect");
    assert.equal(choice.modelChoiceOf(tenant).source, "own");

    // Another pod's write: the row, and its announcement.
    await ormRequired().execute(sql`INSERT INTO account_model_choice (tenant, source, provider, version, updated_by, updated_at) VALUES (${tenant}, 'foldrun', 'anthropic', 1, 'other-pod', now())`);
    await ormRequired().execute(sql`SELECT pg_notify(${keys.MODEL_CONFIG_CHANNEL}, 'choice')`);
    assert.ok(await until(() => choice.modelChoiceOf(tenant).source === "foldrun"), "heard within the test's 3 s, long before a 10 s poll");

    // This process's own writers announce themselves.
    heard.length = 0;
    await choice.setModelChoice(tenant, { source: "own" }, "me");
    assert.ok(await until(() => heard.includes("choice")), "setModelChoice announces");
    await keys.setModelKey("anthropic", "sk-test-0123456789abcdefghij", "me");
    assert.ok(await until(() => heard.includes("keys")), "setModelKey announces, in its transaction");
    await keys.setModelKey("anthropic", null, "me");
  } finally {
    await ormRequired().execute(sql`DELETE FROM account_model_choice WHERE tenant = ${tenant}`);
    choice.stopModelChoices();
    keys.stopModelKeys();
    await stopListening();
  }
});
