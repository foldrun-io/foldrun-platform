// FOL-479: a web copy that cannot get a database connection at boot (Postgres
// 53300 "too many connections", 28 Nov 2026) waits and tries again instead of
// failing its start; a failure that is not about reaching the database is
// still fatal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { transientDatabaseError, retryWhileTransient, bootComplete, markBooted } from "../src/boot.ts";

const pgError = (code: string, message = "boom") => Object.assign(new Error(message), { code });

test("which errors mean the database is full or out of reach", () => {
  for (const code of ["53300", "57P03", "08006", "ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "ENOTFOUND"]) {
    assert.equal(transientDatabaseError(pgError(code)), true, code);
  }
  assert.equal(transientDatabaseError(new Error("timeout exceeded when trying to connect")), true);
  assert.equal(transientDatabaseError(new Error("Connection terminated unexpectedly")), true);
  assert.equal(transientDatabaseError(new Error("sorry, too many clients already")), true);
});

test("a failure that is not about reaching the database stays fatal", () => {
  assert.equal(transientDatabaseError(new Error("migration 0042_x.sql failed: syntax error at or near")), false);
  assert.equal(transientDatabaseError(new Error("no migration files at /app/drizzle")), false);
  assert.equal(transientDatabaseError(pgError("42P01", 'relation "x" does not exist')), false);
  assert.equal(transientDatabaseError(pgError("28P01", "password authentication failed")), false);
  assert.equal(transientDatabaseError(null), false);
  assert.equal(transientDatabaseError("53300"), false);
});

test("it keeps trying while the database is full, resets before each new try, and returns the answer", async () => {
  let calls = 0;
  let resets = 0;
  const pauses: number[] = [];
  const got = await retryWhileTransient(
    async () => {
      calls++;
      if (calls < 4) throw pgError("53300", "sorry, too many clients already");
      return "booted";
    },
    (n) => {
      pauses.push(n);
      return 1;
    },
    () => resets++,
  );
  assert.equal(got, "booted");
  assert.equal(calls, 4);
  assert.equal(resets, 3);
  assert.deepEqual(pauses, [1, 2, 3], "the pause is asked for with the attempt number, so it can grow");
});

test("a migration that failed in SQL is thrown at the first attempt, not retried", async () => {
  let calls = 0;
  await assert.rejects(
    retryWhileTransient(
      async () => {
        calls++;
        throw new Error("migration 0042_x.sql failed: syntax error");
      },
      () => 1,
    ),
    /migration 0042_x.sql failed/,
  );
  assert.equal(calls, 1);
});

test("booted only goes one way", () => {
  assert.equal(bootComplete(), false);
  markBooted();
  assert.equal(bootComplete(), true);
});
