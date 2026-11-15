// workspace_logs "newest N" (DocsPort.tail) on Postgres. The query selects the
// id as text; ORDER BY id then sorts that text ("9" > "20"), so once ids reach
// two digits the newest rows are not what comes back — and the refusal fold,
// eval history and grades all read the tail.
//
//   FOLDRUN_TEST_DATABASE_URL=postgres://… node --test tests/docs-tail-pg.test.ts

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { takeTurnsOnLiveDb } from "./live-db-lock.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
takeTurnsOnLiveDb(url);
const live = { skip: url ? false : "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" };
if (url) {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-doctail-"));
  process.env.FOLDRUN_SECRET_KEY ??= "test-install-key";
  after(async () => {
    const { closePgSync } = await import("../src/pg-sync.ts");
    await closePgSync();
    const { db } = await import("../src/db.ts");
    await db()?.end();
  });
}

test("tail returns the newest rows by number, not by the text of the number", live, async () => {
  const { migrate } = await import("../src/db.ts");
  await migrate();
  const { pgRecords } = await import("../src/records-pg.ts");
  const docs = pgRecords({ routed: false }).docs;
  const T = "tailt1";
  const W = "desk";
  for (let i = 1; i <= 25; i++) docs.append(T, W, "hook-delivery", { n: i }, 0);
  const last3 = docs.tail(T, W, "hook-delivery", 3).map((r) => (r.data as { n: number }).n);
  assert.deepEqual(last3, [25, 24, 23]);
  const ids = docs.tail(T, W, "hook-delivery", 25).map((r) => Number(r.id));
  assert.deepEqual(ids, [...ids].sort((a, b) => b - a), "newest first, numerically");
});
