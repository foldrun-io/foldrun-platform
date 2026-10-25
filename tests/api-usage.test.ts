// API usage: requests counted per account, day and version, a deprecated
// route's callers by credential, the sums written on flush and added to what
// is there, the window, pruning, warnings marked once, and an account's rows
// gone with it. On the file store; tests/postgres-live.test.ts has the table.
//
//   node --test tests/api-usage.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-api-usage-"));
delete process.env.FOLDRUN_DATABASE_URL;

const u = await import("../src/api-usage.ts");

const fresh = () => {
  u.resetApiUsageForTests();
  for (const f of [".api-usage.json", ".api-deprecation-notices.json"]) fs.rmSync(path.join(process.env.FOLDRUN_DATA!, f), { force: true });
};
const NOW = new Date("2026-10-13T10:00:00Z");
const at = (iso: string) => new Date(iso);

test("requests are counted by version; a deprecated route also by who called it", async () => {
  fresh();
  for (let i = 0; i < 3; i++) u.recordApiCall({ tenant: "acme", version: "2026-10-01", at: at("2026-10-13T09:00:00Z") });
  u.recordApiCall({ tenant: "acme", version: "2027-01-15", at: at("2026-10-12T09:00:00Z") });
  u.recordApiCall({ tenant: "acme", version: "2026-10-01", route: "DELETE /api/old", credential: 'key "ci" (fr_ab12…)', at: at("2026-10-13T08:00:00Z") });
  u.recordApiCall({ tenant: "acme", version: "2026-10-01", route: "DELETE /api/old", credential: 'key "ci" (fr_ab12…)', at: at("2026-10-13T09:30:00Z") });
  u.recordApiCall({ tenant: "other", version: "2026-10-01", at: at("2026-10-13T09:00:00Z") });
  const usage = await u.apiUsageFor("acme", 30, NOW);
  assert.deepEqual(usage.versions, [
    { version: "2026-10-01", requests: 5, lastSeen: "2026-10-13T09:30:00.000Z" },
    { version: "2027-01-15", requests: 1, lastSeen: "2026-10-12T09:00:00.000Z" },
  ]);
  assert.deepEqual(usage.deprecated, [
    { route: "DELETE /api/old", requests: 2, lastSeen: "2026-10-13T09:30:00.000Z", callers: [{ credential: 'key "ci" (fr_ab12…)', requests: 2, lastSeen: "2026-10-13T09:30:00.000Z" }] },
  ]);
  assert.equal((await u.apiUsageFor("other", 30, NOW)).deprecated.length, 0, "one account never sees another's");
});

test("a credential is kept only on a deprecated route's rows", async () => {
  fresh();
  u.recordApiCall({ tenant: "acme", version: "2026-10-01", credential: "key secret-ish", at: NOW });
  await u.flushApiUsage();
  const rows = JSON.parse(fs.readFileSync(path.join(process.env.FOLDRUN_DATA!, ".api-usage.json"), "utf8"));
  assert.equal(rows[0].credential, "");
});

test("flushes add to what is already written — two pods, one total", async () => {
  fresh();
  u.recordApiCall({ tenant: "acme", version: "2026-10-01", at: NOW });
  assert.equal(await u.flushApiUsage(), 1);
  u.recordApiCall({ tenant: "acme", version: "2026-10-01", at: NOW });
  u.recordApiCall({ tenant: "acme", version: "2026-10-01", at: NOW });
  await u.flushApiUsage();
  assert.equal((await u.apiUsageFor("acme", 30, NOW)).versions[0].requests, 3);
  assert.equal(await u.flushApiUsage(), 0, "nothing left to write");
});

test("the window counts whole UTC days back from today; pruning drops what is past keeping", async () => {
  fresh();
  u.recordApiCall({ tenant: "acme", version: "v", at: at("2026-09-14T00:00:00Z") }); // 30th day back, inside
  u.recordApiCall({ tenant: "acme", version: "v", at: at("2026-09-13T23:59:00Z") }); // outside
  u.recordApiCall({ tenant: "acme", version: "v", at: at("2026-06-01T00:00:00Z") }); // past 90 days
  assert.equal((await u.apiUsageFor("acme", 30, NOW)).versions[0].requests, 1);
  assert.equal(await u.pruneApiUsage(NOW), 1);
  assert.equal((await u.apiUsageFor("acme", 365, NOW)).versions[0].requests, 2);
});

test("callersOf lists the accounts that called a deprecated route lately", async () => {
  fresh();
  u.recordApiCall({ tenant: "acme", version: "v", route: "DELETE /api/old", credential: "key a", at: NOW });
  u.recordApiCall({ tenant: "beta", version: "v", route: "DELETE /api/old", credential: "key b", at: NOW });
  u.recordApiCall({ tenant: "beta", version: "v", route: "GET /api/other-old", credential: "key b", at: NOW });
  u.recordApiCall({ tenant: "gamma", version: "v", at: NOW });
  const callers = await u.callersOf("DELETE /api/old", 30, NOW);
  assert.deepEqual([...callers.keys()].sort(), ["acme", "beta"]);
  assert.equal(callers.get("beta")!.callers[0].credential, "key b");
});

test("a warning step is recorded once, per account and route", async () => {
  fresh();
  assert.deepEqual([...(await u.noticesSent("acme", "DELETE /api/old"))], []);
  await u.markNoticesSent("acme", "DELETE /api/old", ["seen", "90d"], NOW);
  await u.markNoticesSent("acme", "DELETE /api/old", ["90d"], NOW);
  assert.deepEqual([...(await u.noticesSent("acme", "DELETE /api/old"))].sort(), ["90d", "seen"]);
  assert.equal((await u.noticesSent("acme", "GET /api/other")).size, 0);
  assert.equal((await u.noticesSent("beta", "DELETE /api/old")).size, 0);
});

test("deleting an account deletes its counts and its warnings, nobody else's", async () => {
  fresh();
  u.recordApiCall({ tenant: "acme", version: "v", at: NOW });
  u.recordApiCall({ tenant: "beta", version: "v", at: NOW });
  await u.markNoticesSent("acme", "DELETE /api/old", ["seen"], NOW);
  await u.deleteApiUsageFor("acme");
  assert.equal((await u.apiUsageFor("acme", 30, NOW)).versions.length, 0);
  assert.equal((await u.apiUsageFor("beta", 30, NOW)).versions.length, 1);
  assert.equal((await u.noticesSent("acme", "DELETE /api/old")).size, 0);
});
