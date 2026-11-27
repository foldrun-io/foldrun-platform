// One review per Idempotency-Key on POST /v1/foldrun/review (FOL-417), on
// Postgres: a key taken once, a finished review replayed, another review
// under the key refused, a running one answered "running", a stuck one
// answered "lost" (never run twice), a refused one freed; only the claim's
// owner finishes or frees it.
//
//   FOLDRUN_TEST_DATABASE_URL=postgres://foldrun:test@localhost:55432/foldrun \
//     node --test tests/review-calls-db.test.ts

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
}

test("review_calls: claim, replay, conflict, running, lost, owner-only finish and forget", opts, async () => {
  const { migrate, ormRequired } = await import("../src/db.ts");
  const { sql } = await import("drizzle-orm");
  await migrate();
  const rc = await import("../src/review-calls.ts");
  const t = `acme-${Date.now()}`;
  const a = await rc.claimReview(t, "k1", "h1");
  assert.equal(a.kind, "new");
  const ownerA = (a as { owner: string }).owner;
  assert.deepEqual(await rc.claimReview(t, "k1", "h1"), { kind: "running" }, "a second caller while it runs");
  assert.deepEqual(await rc.claimReview(t, "k1", "h2"), { kind: "conflict" }, "another review under the key");
  // Only the claim's owner finishes or frees it.
  await rc.finishReview(t, "k1", "someone-else", { summary: "wrong" });
  await rc.forgetReview(t, "k1", "someone-else");
  assert.deepEqual(await rc.claimReview(t, "k1", "h1"), { kind: "running" });
  await rc.finishReview(t, "k1", ownerA, { summary: "s", findings: [] });
  assert.deepEqual(await rc.claimReview(t, "k1", "h1"), { kind: "replay", result: { summary: "s", findings: [] } });
  assert.deepEqual(await rc.claimReview(t, "k1", "h2"), { kind: "conflict" });
  // A late finish never overwrites a finished answer; forget never removes one.
  await rc.finishReview(t, "k1", ownerA, { summary: "late" });
  await rc.forgetReview(t, "k1", ownerA);
  assert.deepEqual(await rc.claimReview(t, "k1", "h1"), { kind: "replay", result: { summary: "s", findings: [] } });
  // Another account's same key is its own.
  assert.equal((await rc.claimReview(`${t}-b`, "k1", "h2")).kind, "new");
  // A refused review frees its key.
  const b = (await rc.claimReview(t, "k2", "h1")) as { owner: string };
  await rc.forgetReview(t, "k2", b.owner);
  const c = await rc.claimReview(t, "k2", "h1");
  assert.equal(c.kind, "new");
  // Stuck past ten minutes: never taken over (it may have been paid), for anyone.
  await ormRequired().execute(sql`UPDATE review_calls SET created_at = now() - interval '11 minutes' WHERE tenant = ${t} AND invocation = 'k2'`);
  assert.deepEqual(await rc.claimReview(t, "k2", "h1"), { kind: "lost" });
  assert.deepEqual(await rc.claimReview(t, "k2", "h9"), { kind: "conflict" });
  // Rows older than a day go.
  await ormRequired().execute(sql`UPDATE review_calls SET created_at = now() - interval '2 days' WHERE tenant = ${t} AND invocation = 'k1'`);
  assert.equal((await rc.claimReview(t, "k1", "h7")).kind, "new", "a day-old answer is gone");
  await ormRequired().execute(sql`DELETE FROM review_calls WHERE tenant LIKE ${`${t}%`}`);
});
