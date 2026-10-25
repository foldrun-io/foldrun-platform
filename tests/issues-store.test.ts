// FOL-54 step 3: what people did to issues is stored one notice per issue
// and read back for the whole account.
//
//   node --test tests/issues-store.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-issues-"));
delete process.env.FOLDRUN_DATABASE_URL;
const { actOnIssue, issueStates } = await import("../src/issues.ts");

test("acts are kept per issue, per account, in order; a bad id and a past snooze are refused", async () => {
  const now = Date.parse("2026-10-19T00:00:00Z");
  await actOnIssue("acme", "iss_abc123", { action: "acknowledge", by: "a@x" }, now);
  await actOnIssue("acme", "iss_abc123", { action: "snooze", by: "a@x", until: "2026-10-20T00:00:00Z", note: " later " }, now + 1);
  await actOnIssue("acme", "iss_other1", { action: "resolve", by: "b@x" }, now + 2);
  await actOnIssue("beta", "iss_abc123", { action: "resolve", by: "c@x" }, now + 3);
  const s = await issueStates("acme");
  assert.deepEqual(Object.keys(s).sort(), ["iss_abc123", "iss_other1"]);
  assert.deepEqual(s.iss_abc123.history.map((e) => e.action), ["acknowledge", "snooze"]);
  assert.equal(s.iss_abc123.history[1].note, "later");
  assert.deepEqual(Object.keys(await issueStates("beta")), ["iss_abc123"]);
  await assert.rejects(actOnIssue("acme", "../x", { action: "resolve", by: "a" }, now), /not an issue id/);
  await assert.rejects(actOnIssue("acme", "iss_abc123", { action: "snooze", by: "a", until: "2026-10-18T00:00:00Z" }, now), /future/);
});

test("two acts on one issue at once both land in its history (Codex review)", async () => {
  const now = Date.parse("2026-10-19T00:00:00Z");
  await Promise.all([
    actOnIssue("gamma", "iss_race01", { action: "acknowledge", by: "a@x" }, now),
    actOnIssue("gamma", "iss_race01", { action: "resolve", by: "b@x" }, now + 1),
    actOnIssue("gamma", "iss_race01", { action: "reopen", by: "c@x" }, now + 2),
  ]);
  assert.equal((await issueStates("gamma")).iss_race01.history.length, 3);
});
