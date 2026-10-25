// FOL-54 step 3, against Postgres: issue acts are stored and read back, and
// two at once on one issue both land (the advisory lock in updateNotice).
//
//   FOLDRUN_TEST_DATABASE_URL=postgres://foldrun:test@localhost:55432/foldrun \
//     node --test tests/issues-store-db.test.ts

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

test("issue acts in the database: stored per issue, concurrent acts all kept, a refused one writes nothing", opts, async () => {
  const { migrate } = await import("../src/db.ts");
  await migrate();
  const { actOnIssue, issueStates } = await import("../src/issues.ts");
  const tenant = `iss-${Date.now()}`;
  const now = Date.now();
  await Promise.all(
    Array.from({ length: 8 }, (_, k) => actOnIssue(tenant, "iss_dbrace1", { action: k % 2 ? "acknowledge" : "reopen", by: `p${k}@x` }, now + k)),
  );
  await actOnIssue(tenant, "iss_other22", { action: "resolve", by: "a@x" }, now);
  await assert.rejects(actOnIssue(tenant, "iss_other22", { action: "snooze", by: "a@x", until: new Date(now - 1000).toISOString() }, now), /future/);
  const s = await issueStates(tenant);
  assert.equal(s.iss_dbrace1.history.length, 8, "none lost to another");
  assert.deepEqual(s.iss_other22.history.map((e) => e.action), ["resolve"]);
});
