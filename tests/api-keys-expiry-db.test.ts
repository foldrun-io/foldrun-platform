// A rotation's grace brings the old key's end forward, never back — in the
// database as in keys.json (foldrun-web server/auth.ts shortenExpiry). The
// table version set whatever it was given, so rotating a key that ended in
// ten minutes with a 24h grace gave it another day.
//
//   FOLDRUN_TEST_DATABASE_URL=postgres://foldrun:test@localhost:55432/foldrun \
//     node --test tests/api-keys-expiry-db.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
const opts = { skip: url ? false : "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" };

if (url) {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  process.env.FOLDRUN_SECRET_KEY ??= "test-install-key";
}

test("setApiKeyExpiryDb shortens a key's life and never extends it", opts, async () => {
  const { migrate } = await import("../src/db.ts");
  await migrate();
  const k = await import("../src/api-keys-db.ts");
  const id = `exp-${Date.now()}`;
  const soon = new Date(Date.now() + 10 * 60_000);
  await k.insertApiKeyDb({ id, hash: `h-${id}`, prefix: "mda_x", label: "ci", tenant: "acme", createdAt: new Date().toISOString(), revokedAt: null, role: "editor", workspaces: null, expiresAt: soon.toISOString() });
  const endOf = async () => (await k.listApiKeysDb("acme")).find((r) => r.id === id)?.expiresAt;

  assert.equal(await k.setApiKeyExpiryDb("acme", id, new Date(Date.now() + 24 * 3600_000)), true, "still this account's key");
  assert.equal(Date.parse((await endOf())!), soon.getTime(), "a later end is not applied");

  const sooner = new Date(Date.now() + 60_000);
  await k.setApiKeyExpiryDb("acme", id, sooner);
  assert.equal(Date.parse((await endOf())!), sooner.getTime(), "an earlier end is");

  const open = `open-${Date.now()}`;
  await k.insertApiKeyDb({ id: open, hash: `h-${open}`, prefix: "mda_y", label: "ci", tenant: "acme", createdAt: new Date().toISOString(), revokedAt: null, role: "editor", workspaces: null });
  const end = new Date(Date.now() + 3600_000);
  await k.setApiKeyExpiryDb("acme", open, end);
  assert.equal(Date.parse((await k.listApiKeysDb("acme")).find((r) => r.id === open)!.expiresAt!), end.getTime(), "a key with no end gets one");

  assert.equal(await k.setApiKeyExpiryDb("beta", id, new Date()), false, "not another account's");
});

// A rotated key names the key that replaced it, and is claimed once: a second
// rotation of the same old key is refused (foldrun-web rotateApiKey answers 409).
test("markApiKeyReplacedDb records the replacement once, and only on a live key of this account", opts, async () => {
  const { migrate } = await import("../src/db.ts");
  await migrate();
  const k = await import("../src/api-keys-db.ts");
  const id = `rot-${Date.now()}`;
  await k.insertApiKeyDb({ id, hash: `h-${id}`, prefix: "mda_r", label: "ci", tenant: "acme", createdAt: new Date().toISOString(), revokedAt: null, role: "editor", workspaces: null });
  assert.equal((await k.listApiKeysDb("acme")).find((r) => r.id === id)?.replacedBy, null, "a fresh key replaced by nothing");
  assert.equal(await k.markApiKeyReplacedDb("beta", id, "new-1"), false, "not another account's");
  assert.equal(await k.markApiKeyReplacedDb("acme", id, "new-1"), true);
  assert.equal(await k.markApiKeyReplacedDb("acme", id, "new-2"), false, "a second claim loses");
  assert.equal((await k.listApiKeysDb("acme")).find((r) => r.id === id)?.replacedBy, "new-1");
  assert.equal((await k.findApiKeyByHashDb(`h-${id}`))?.replacedBy, "new-1");
});
