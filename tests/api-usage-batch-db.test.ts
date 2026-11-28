// Usage counts go out as one statement per batch and are never counted twice
// (FOL-476, plan section 3): a batch whose answer was lost, sent again, adds
// nothing the second time; one that failed adds once.
//
//   FOLDRUN_TEST_DATABASE_URL=postgres://foldrun:test@localhost:55432/foldrun \
//     node --test tests/api-usage-batch-db.test.ts

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
}

const pg = createRequire(import.meta.url)("pg") as { Client: { prototype: object } };
const proto = pg.Client.prototype as unknown as { query: (...a: unknown[]) => unknown };
const original = proto.query;
let statements: string[] = [];
proto.query = function (this: unknown, ...a: unknown[]) {
  const t = typeof a[0] === "string" ? a[0] : String((a[0] as { text?: string } | undefined)?.text ?? "");
  if (/api_usage/.test(t)) statements.push(t.replace(/\s+/g, " ").trim().slice(0, 60));
  return original.apply(this, a);
};

test("many counters are one statement; a batch sent again after a lost answer counts once", opts, async () => {
  const { migrate } = await import("../src/db.ts");
  await migrate();
  const U = await import("../src/api-usage.ts");
  const tenant = `ub${Date.now()}`;
  const at = new Date();
  try {
    U.resetApiUsageForTests();
    for (let i = 0; i < 40; i++) for (let n = 0; n <= i % 3; n++) U.recordApiCall({ tenant, version: `v${i}`, at });
    const expected = Array.from({ length: 40 }, (_, i) => (i % 3) + 1).reduce((a, b) => a + b, 0);

    statements = [];
    const db = (await import("../src/db.ts")).ormRequired();
    const real = db.execute.bind(db);
    const set = (fn: unknown) => ((db as unknown as { execute: unknown }).execute = fn);
    // The write commits, and the answer is lost.
    set(async (q: never) => {
      await real(q);
      set(real);
      throw new Error("connection terminated after commit");
    });
    await assert.rejects(() => U.flushApiUsage(), /terminated after commit/);
    assert.equal(statements.length, 1, "40 counters, one statement");
    // The next call counted while the batch was unconfirmed goes in its own batch.
    U.recordApiCall({ tenant, version: "v0", at });
    await U.flushApiUsage();

    const total = async () => (await U.apiUsageFor(tenant, 2, at)).versions.reduce((n, v) => n + v.requests, 0);
    assert.equal(await total(), expected + 1, "the batch whose answer was lost landed once, the later call once");

    // A plain failure (nothing written) is sent again and lands once.
    U.recordApiCall({ tenant, version: "vx", at });
    set(async () => {
      set(real);
      throw new Error("could not connect");
    });
    await assert.rejects(() => U.flushApiUsage(), /could not connect/);
    await U.flushApiUsage();
    assert.equal(await total(), expected + 2);
  } finally {
    await U.deleteApiUsageFor(tenant);
    proto.query = original;
  }
});
