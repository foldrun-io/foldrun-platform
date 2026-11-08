// FOL-145 phase A: the vendor egress door's own credentials. Never the lease
// token; one vendor session under one lease; 15 minutes at most; revoked with
// the lease; fail-closed when the store cannot answer.
//
//   node --test tests/vendor-egress-credentials.test.ts
//   FOLDRUN_TEST_REDIS_URL=redis://… also runs the Redis store.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  memoryVendorCredentialStore,
  mintVendorCredential,
  parseVendorAuth,
  redisVendorCredentialStore,
  revokeVendorCredential,
  revokeVendorCredentialsForLease,
  saveVendorCredential,
  VENDOR_SESSION_MAX_MS,
  verifyVendorCredential,
  type VendorCredentialStore,
} from "../src/vendor-egress-credentials.ts";

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
const NOW = 1_800_000_000_000;
const lease = { tenant: "acme", runId: "run-1", step: "browser#1", vendor: "browserbase", leaseKey: "lease-key-1" };

test("a credential: random id and password, only the hash kept, 15 minutes at most", () => {
  const a = mintVendorCredential({ ...lease, leaseExpiresAt: NOW + 3_600_000, now: NOW });
  const b = mintVendorCredential({ ...lease, leaseExpiresAt: NOW + 3_600_000, now: NOW });
  assert.notEqual(a.username, b.username);
  assert.notEqual(a.password, b.password);
  assert.match(a.username, /^fv_[A-Za-z0-9_-]{22}$/);
  assert.ok(Buffer.from(a.password, "base64url").length === 32, "256-bit password");
  assert.ok(!JSON.stringify(a.record).includes(a.password), "the record never holds the password");
  assert.equal(a.expiresAt, NOW + VENDOR_SESSION_MAX_MS);
  const short = mintVendorCredential({ ...lease, leaseExpiresAt: NOW + 60_000, now: NOW });
  assert.equal(short.expiresAt, NOW + 60_000, "never outlives its lease");
});

async function roundTrip(s: VendorCredentialStore) {
  const c = mintVendorCredential({ ...lease, leaseKey: `lease-${Math.random()}`, leaseExpiresAt: Date.now() + 600_000 });
  await saveVendorCredential(c, s);
  const ok = await verifyVendorCredential(basic(c.username, c.password), s);
  assert.ok("record" in ok, JSON.stringify(ok));
  assert.equal(ok.record.vendor, "browserbase");
  assert.equal(ok.record.leaseKey, c.record.leaseKey);

  const wrong = await verifyVendorCredential(basic(c.username, c.password.replace(/.$/, (ch) => (ch === "A" ? "B" : "A"))), s);
  assert.deepEqual("status" in wrong && wrong.status, 407);

  // A second credential under the same lease; the lease ends; both go.
  const c2 = mintVendorCredential({ ...lease, leaseKey: c.record.leaseKey, leaseExpiresAt: Date.now() + 600_000 });
  await saveVendorCredential(c2, s);
  assert.equal(await revokeVendorCredentialsForLease(c.record.leaseKey, s), 2);
  for (const x of [c, c2]) {
    const gone = await verifyVendorCredential(basic(x.username, x.password), s);
    assert.ok("status" in gone && gone.status === 407, "revoked with its lease");
  }

  const c3 = mintVendorCredential({ ...lease, leaseKey: `lease-${Math.random()}`, leaseExpiresAt: Date.now() + 600_000 });
  await saveVendorCredential(c3, s);
  await revokeVendorCredential(c3.record.id, s);
  const gone3 = await verifyVendorCredential(basic(c3.username, c3.password), s);
  assert.ok("status" in gone3 && gone3.status === 407);
}

test("memory store: verify, a wrong password, revoke one, revoke a lease's all", async () => {
  await roundTrip(memoryVendorCredentialStore());
});

test("a lease token, or anything that is not fv_<id>, is refused before the store is asked", async () => {
  let asked = 0;
  const s: VendorCredentialStore = { put: async () => {}, get: async () => { asked++; return null; }, del: async () => {}, idsForLease: async () => [], markLeaseRevoked: async () => {}, leaseRevoked: async () => false };
  for (const h of [basic("foldrun", "a".repeat(43)), basic("x", "y"), "Bearer abc", undefined, basic("fv_short", "p".repeat(43)), basic(`fv_${"a".repeat(22)}`, "short")]) {
    const r = await verifyVendorCredential(h, s);
    assert.ok("status" in r && r.status === 407, String(h));
  }
  assert.equal(asked, 0);
  assert.equal(parseVendorAuth(basic(`fv_${"a".repeat(22)}`, "b".repeat(43)))?.id, "a".repeat(22));
});

test("expired: refused even if the store still has it", async () => {
  const s = memoryVendorCredentialStore();
  const c = mintVendorCredential({ ...lease, leaseExpiresAt: Date.now() + 120_000 });
  await saveVendorCredential(c, s);
  const later = await verifyVendorCredential(basic(c.username, c.password), s, c.expiresAt + 1);
  assert.ok("status" in later && later.status === 407);
  assert.match((later as { message: string }).message, /expired/);
  await assert.rejects(saveVendorCredential(c, s, c.expiresAt + 1), /already expired/);
});

test("a store that cannot answer: 503, never a pass", async () => {
  const s: VendorCredentialStore = { put: async () => {}, get: async () => { throw new Error("down"); }, del: async () => {}, idsForLease: async () => [], markLeaseRevoked: async () => {}, leaseRevoked: async () => false };
  const c = mintVendorCredential({ ...lease, leaseExpiresAt: Date.now() + 600_000 });
  const r = await verifyVendorCredential(basic(c.username, c.password), s);
  assert.ok("status" in r && r.status === 503);
  const none = redisVendorCredentialStore(async () => null);
  const r2 = await verifyVendorCredential(basic(c.username, c.password), none);
  assert.ok("status" in r2 && r2.status === 503, "no Redis client is a 503 too");
});


test("a revoked lease: no new credential under it, and one saved while the revocation ran is taken back out", async () => {
  const s = memoryVendorCredentialStore();
  const leaseKey = `lease-${Math.random()}`;
  const before = mintVendorCredential({ ...lease, leaseKey, leaseExpiresAt: Date.now() + 600_000 });
  await saveVendorCredential(before, s);
  assert.equal(await revokeVendorCredentialsForLease(leaseKey, s), 1);
  const after = mintVendorCredential({ ...lease, leaseKey, leaseExpiresAt: Date.now() + 600_000 });
  await assert.rejects(saveVendorCredential(after, s), /lease has ended/);

  // The race: the revocation lands between the save's check and its put.
  const s2 = memoryVendorCredentialStore();
  const racing = mintVendorCredential({ ...lease, leaseKey: "lease-race", leaseExpiresAt: Date.now() + 600_000 });
  const put = s2.put.bind(s2);
  s2.put = async (rec, ttl) => { await put(rec, ttl); await revokeVendorCredentialsForLease("lease-race", s2); };
  await assert.rejects(saveVendorCredential(racing, s2), /lease has ended/);
  const r = await verifyVendorCredential(basic(racing.username, racing.password), s2);
  assert.ok("status" in r && r.status === 407, "the raced credential does not authenticate");
  assert.equal(await s2.get(racing.record.id), null, "and it was removed");
});

test("verify reads the clock after the lookup: a slow store cannot pass an expired credential", async () => {
  const s = memoryVendorCredentialStore();
  const c = mintVendorCredential({ ...lease, leaseKey: `lease-${Math.random()}`, leaseExpiresAt: Date.now() + 2_000 });
  await saveVendorCredential(c, s);
  const get = s.get.bind(s);
  const realNow = Date.now;
  s.get = async (id) => { const rec = await get(id); Date.now = () => c.expiresAt + 1; return rec; };
  try {
    const r = await verifyVendorCredential(basic(c.username, c.password), s);
    assert.ok("status" in r && r.status === 407, JSON.stringify(r));
  } finally {
    Date.now = realNow;
  }
});

const REDIS = process.env.FOLDRUN_TEST_REDIS_URL;
test("Redis store: the same round trip", { skip: !REDIS && "set FOLDRUN_TEST_REDIS_URL" }, async () => {
  const { Redis } = await import("ioredis");
  const r = new Redis(REDIS!, { lazyConnect: false, maxRetriesPerRequest: 1 });
  try {
    const store = redisVendorCredentialStore(async () => r as never);
    await roundTrip(store);
    // A shorter credential saved after a longer one does not shorten the index.
    const leaseKey = `lease-${Math.random()}`;
    const long = mintVendorCredential({ ...lease, leaseKey, leaseExpiresAt: Date.now() + 600_000 });
    const short = mintVendorCredential({ ...lease, leaseKey, leaseExpiresAt: Date.now() + 5_000 });
    await saveVendorCredential(long, store);
    await saveVendorCredential(short, store);
    const idx = await r.ttl(`foldrun:vendor-egress:lease:${(await import("node:crypto")).createHash("sha256").update(leaseKey).digest("hex")}`);
    assert.ok(idx > 600, `index ttl ${idx}s outlives the longest credential`);
    assert.equal(await revokeVendorCredentialsForLease(leaseKey, store), 2);
  } finally {
    r.disconnect();
  }
});
