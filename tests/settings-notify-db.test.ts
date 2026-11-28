// A setting or an account's operator grant written on another pod is heard
// on NOTIFY, long before the 10 s poll (FOL-476, plan section 3).
//
//   FOLDRUN_TEST_DATABASE_URL=postgres://foldrun:test@localhost:55432/foldrun \
//     node --test tests/settings-notify-db.test.ts

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

test("a setting and a grant written elsewhere are heard at once", opts, async () => {
  const { migrate, ormRequired } = await import("../src/db.ts");
  await migrate();
  const { sql } = await import("drizzle-orm");
  const S = await import("../src/settings.ts");
  const A = await import("../src/admin.ts");
  const { listening, stopListening } = await import("../src/pg-listen.ts");
  const tenant = `sn${Date.now()}`;
  const key = S.settingDefs()[0]?.key;
  assert.ok(key, "the registry has a setting to write");
  try {
    await S.startSettings();
    assert.ok(await until(() => listening(S.SETTINGS_CHANNEL)), "LISTEN is in effect");
    const before = S.settingsVersion();

    // Another pod writes a row and says so (the hosted console does this in its transaction).
    await ormRequired().transaction(async (t) => {
      await t.execute(sql`INSERT INTO platform_settings (key, value, updated_by) VALUES (${key}, NULL, 'other-pod') ON CONFLICT (key) DO UPDATE SET version = nextval('platform_settings_version_seq'), updated_by = 'other-pod'`);
      await S.announceSettings(t, "settings");
    });
    assert.ok(await until(() => S.settingsVersion() > before), "the setting was heard within 3 s, long before a 10 s poll");

    // An operator grant written through the platform's own writer.
    assert.equal(S.platformKeyAccounts().includes(tenant), false);
    await A.updateAdminState(tenant, { platformKey: true }, "test", "platform-key");
    assert.ok(await until(() => S.platformKeyAccounts().includes(tenant)), "the grant was heard");
    await A.updateAdminState(tenant, { platformKey: false }, "test", "platform-key");
    assert.ok(await until(() => !S.platformKeyAccounts().includes(tenant)), "and its withdrawal");
  } finally {
    await A.deleteAdminState(tenant);
    await ormRequired().execute(sql`DELETE FROM platform_settings WHERE updated_by = 'other-pod'`);
    S.stopSettings();
    await stopListening();
  }
});
