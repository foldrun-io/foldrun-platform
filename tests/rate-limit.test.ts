// The login limiter, without a Redis to talk to.
//
// The fallback path is the one that must be right: a laptop install has no
// Redis and must still refuse a brute-force attempt, and a Redis outage must
// degrade to this rather than either locking everyone out or letting everyone
// through unlimited.
//
//   node --test tests/rate-limit.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { rateLimit, rateLimitReset, cacheEnabled } from "../src/cache.ts";

test("no Redis configured means the local counter, not an open door", async () => {
  delete process.env.FOLDRUN_REDIS_URL;
  assert.equal(cacheEnabled(), false);

  const key = `t-${Math.random()}`;
  for (let i = 1; i <= 3; i++) {
    const v = await rateLimit(key, 3, 60);
    assert.equal(v.allowed, true, `attempt ${i} should be allowed`);
  }
  const over = await rateLimit(key, 3, 60);
  assert.equal(over.allowed, false, "the fourth attempt is refused");
  assert.ok(over.retryAfter > 0 && over.retryAfter <= 60, "and says how long to wait");
});

test("remaining counts down and floors at zero", async () => {
  const key = `t-${Math.random()}`;
  assert.equal((await rateLimit(key, 2, 60)).remaining, 1);
  assert.equal((await rateLimit(key, 2, 60)).remaining, 0);
  assert.equal((await rateLimit(key, 2, 60)).remaining, 0, "never negative");
});

test("a success clears the count, so typos do not throttle the person", async () => {
  const key = `t-${Math.random()}`;
  await rateLimit(key, 3, 60);
  await rateLimit(key, 3, 60);
  await rateLimitReset(key);
  const after = await rateLimit(key, 3, 60);
  assert.equal(after.remaining, 2, "the window started over");
});

test("keys do not bleed into each other", async () => {
  const a = `t-${Math.random()}`;
  const b = `t-${Math.random()}`;
  await rateLimit(a, 1, 60);
  assert.equal((await rateLimit(a, 1, 60)).allowed, false, "a is spent");
  assert.equal((await rateLimit(b, 1, 60)).allowed, true, "b is untouched");
});

test("the window expires", async () => {
  const key = `t-${Math.random()}`;
  // A one-second window, so this stays a real test of expiry rather than a
  // test of the clock being mocked.
  assert.equal((await rateLimit(key, 1, 1)).allowed, true);
  assert.equal((await rateLimit(key, 1, 1)).allowed, false);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal((await rateLimit(key, 1, 1)).allowed, true, "allowed again after the window");
});
