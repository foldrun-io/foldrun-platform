// LISTEN/NOTIFY across copies of the platform (12 Nov 2026): a run write
// wakes whoever watches that run (a live run page), and a key revocation
// reaches the gateway's key cache at once rather than within KEY_CACHE_MS.
//
//   FOLDRUN_TEST_DATABASE_URL=postgres://foldrun:test@localhost:55432/foldrun \
//     node --test tests/pg-listen-db.test.ts

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { takeTurnsOnLiveDb } from "./live-db-lock.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
const opts = { skip: url ? false : "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" };
takeTurnsOnLiveDb(url);

if (url) {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  process.env.FOLDRUN_SECRET_KEY ??= "test-install-key";
}

const T = "pglisten";
const until = async (ok: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
};

before(async () => {
  if (!url) return;
  const { migrate } = await import("../src/db.ts");
  await migrate();
});

after(async () => {
  if (!url) return;
  const { stopListening } = await import("../src/pg-listen.ts");
  await stopListening();
  const { closePgSync } = await import("../src/pg-sync.ts");
  await closePgSync();
  const { db } = await import("../src/db.ts");
  await db()?.end();
});

test("a run write wakes its watchers, and only its own", opts, async () => {
  const { pgRecords } = await import("../src/records-pg.ts");
  const { watchRun, runNotifyLive } = await import("../src/run-notify.ts");
  const port = pgRecords({ routed: false });
  let mine = 0;
  let other = 0;
  const stopMine = watchRun(T, "desk", "run-1", () => mine++);
  const stopOther = watchRun(T, "desk", "run-2", () => other++);
  assert.ok(await until(runNotifyLive), "the listener connects");
  // Coming up wakes every watcher once (a write before LISTEN went unheard).
  await new Promise((r) => setTimeout(r, 100));
  mine = 0;
  other = 0;

  const at = new Date().toISOString();
  const run = { id: "run-1", flow: "f", status: "running", startedAt: at, steps: [] };
  port.runPut(T, "desk", run as never, { id: "run-1", flow: "f", status: "running", startedAt: at } as never, true);
  assert.ok(await until(() => mine > 0), "the watcher of run-1 is woken on commit");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(other, 0, "a watcher of another run is not");

  stopMine();
  const before = mine;
  port.runPut(T, "desk", { ...run, status: "completed" } as never, { id: "run-1", flow: "f", status: "completed", startedAt: at } as never, false);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(mine, before, "a stopped watcher hears nothing more");
  stopOther();
  port.runDelete(T, "desk", "run-1");
});

test("a revoked gateway key is refused at once, not after the cache's 10 s", opts, async () => {
  const k = await import("../src/api-keys-db.ts");
  const door = await import("../src/gateway-door.ts");
  const { listening } = await import("../src/pg-listen.ts");
  door.resetGatewayKeyCacheForTests();
  const secret = `fgw_${crypto.randomBytes(12).toString("hex")}`;
  const id = `gw-${Date.now()}`;
  await k.insertApiKeyDb({
    id, hash: crypto.createHash("sha256").update(secret).digest("hex"), prefix: secret.slice(0, 8), label: "cc", tenant: T,
    createdAt: new Date().toISOString(), revokedAt: null, role: "editor", workspaces: null, purpose: "gateway", gateway: { capUsd: null, dailyUsd: null },
  });
  const headers = { "x-api-key": secret };
  const first = await door.authenticate(headers);
  assert.ok("who" in first, "the live key is honoured (and now cached)");
  assert.ok(await until(listening), "the listener connects");

  assert.equal(await k.revokeApiKeyDb(T, id), true);
  const t0 = Date.now();
  let r = await door.authenticate(headers);
  while (!("status" in r) && Date.now() - t0 < 2_000) {
    await new Promise((res) => setTimeout(res, 20));
    r = await door.authenticate(headers);
  }
  assert.ok("status" in r && r.reason === "key_revoked", "refused within 2 s of the revocation, well inside the 10 s cache");
  await k.revokeApiKeyDb(T, id);
});

test("a lost listener wakes run watchers at once, and again when it is back", opts, async () => {
  const { watchRun, runNotifyLive } = await import("../src/run-notify.ts");
  const { dropConnectionForTests } = await import("../src/pg-listen.ts");
  let woken = 0;
  const stop = watchRun(T, "desk", "run-gap", () => woken++);
  assert.ok(await until(runNotifyLive), "the listener is up");
  const before = woken;
  dropConnectionForTests();
  assert.equal(runNotifyLive(), false, "no longer trusted");
  assert.ok(woken > before, "woken on the loss, so it polls now instead of at the end of a long wait");
  const atLoss = woken;
  assert.ok(await until(runNotifyLive, 5_000), "it reconnects");
  assert.ok(woken > atLoss, "woken again once LISTEN is back, since a write may have gone unheard");
  stop();
});

test("a key revoked while the listener was down is not honoured from the cache once it is back", opts, async () => {
  const k = await import("../src/api-keys-db.ts");
  const door = await import("../src/gateway-door.ts");
  const { listening, dropConnectionForTests } = await import("../src/pg-listen.ts");
  door.resetGatewayKeyCacheForTests();
  const secret = `fgw_${crypto.randomBytes(12).toString("hex")}`;
  const id = `gw-gap-${Date.now()}`;
  await k.insertApiKeyDb({
    id, hash: crypto.createHash("sha256").update(secret).digest("hex"), prefix: secret.slice(0, 8), label: "cc", tenant: T,
    createdAt: new Date().toISOString(), revokedAt: null, role: "editor", workspaces: null, purpose: "gateway", gateway: { capUsd: null, dailyUsd: null },
  });
  const headers = { "x-api-key": secret };
  assert.ok("who" in (await door.authenticate(headers)), "honoured, and cached");
  assert.ok(await until(() => listening()), "the listener is up");
  dropConnectionForTests();
  await k.revokeApiKeyDb(T, id); // announced to nobody
  assert.ok(await until(() => listening(), 5_000), "it reconnects");
  const r = await door.authenticate(headers);
  assert.ok("status" in r && r.reason === "key_revoked", "the cache was dropped when LISTEN came back");
});
