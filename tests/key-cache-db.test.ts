// A key the pod knows costs no statement; a revocation reaches the cache at
// once; "last used" for many keys is one statement (FOL-476).
//
//   FOLDRUN_TEST_DATABASE_URL=postgres://foldrun:test@localhost:55432/foldrun \
//     node --test tests/key-cache-db.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
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

const pg = createRequire(import.meta.url)("pg") as typeof import("pg");
const proto = pg.Client.prototype as unknown as { query: (...a: unknown[]) => unknown };
const original = proto.query;
let seen: string[] = [];
proto.query = function (this: unknown, ...a: unknown[]) {
  const t = typeof a[0] === "string" ? a[0] : String((a[0] as { text?: string } | undefined)?.text ?? "");
  if (!/^\s*(BEGIN|COMMIT|ROLLBACK|LISTEN|UNLISTEN|SELECT 1\s*$|SET\s)/i.test(t)) seen.push(t.replace(/\s+/g, " ").trim().slice(0, 40));
  return original.apply(this, a);
};
const count = async (fn: () => Promise<unknown>) => {
  seen = [];
  await fn();
  return seen.length;
};

test("a known key is read once; a revocation drops it at once; last use is one statement", opts, async () => {
  const { migrate } = await import("../src/db.ts");
  await migrate();
  const k = await import("../src/api-keys-db.ts");
  const cache = await import("../src/key-cache.ts");
  const { listening, stopListening } = await import("../src/pg-listen.ts");
  const stamp = Date.now();
  const ids = [`kc-a-${stamp}`, `kc-b-${stamp}`, `kc-c-${stamp}`];
  for (const id of ids) await k.insertApiKeyDb({ id, hash: `h-${id}`, prefix: "mda_x", label: "ci", tenant: "acme", createdAt: new Date().toISOString(), revokedAt: null, role: "editor", workspaces: null });
  try {
    cache.resetKeyCacheForTests();
    assert.equal(await count(() => cache.cachedKeyByHash(`h-${ids[0]}`)), 1, "the first call reads the key");
    for (let i = 0; i < 50 && !listening(k.API_KEY_CHANNEL); i++) await new Promise((r) => setTimeout(r, 40));
    assert.ok(listening(k.API_KEY_CHANNEL), "LISTEN is in effect");
    await cache.cachedKeyByHash(`h-${ids[0]}`); // the LISTEN coming up dropped what was cached
    assert.equal(await count(() => cache.cachedKeyByHash(`h-${ids[0]}`)), 0, "a known key costs no statement");
    assert.equal(await count(() => cache.cachedKeyByHash(`h-nope-${stamp}`)), 1);
    assert.equal(await count(() => cache.cachedKeyByHash(`h-nope-${stamp}`)), 0, "an unknown hash is remembered too");

    await k.revokeApiKeyDb("acme", ids[0]);
    for (let i = 0; i < 50 && (await cache.cachedKeyByHash(`h-${ids[0]}`))?.revokedAt === null; i++) await new Promise((r) => setTimeout(r, 40));
    assert.ok((await cache.cachedKeyByHash(`h-${ids[0]}`))?.revokedAt, "the revocation reached the cache without waiting for its expiry");

    const at = new Date();
    assert.equal(await count(() => k.touchApiKeysDb(ids.map((id) => ({ id, at, ip: "203.0.113.0" })))), 1, "last use of three keys is one statement");
    const after = await k.listApiKeysDb("acme");
    for (const id of ids) assert.equal(after.find((r) => r.id === id)?.lastIp, "203.0.113.0");
  } finally {
    for (const id of ids) await k.deleteApiKeyDb("acme", id);
    await stopListening();
    proto.query = original;
  }
});
