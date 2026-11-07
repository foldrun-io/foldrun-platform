// The revision contract (foldrun-core tests/revision-contract.ts) against the
// Postgres RevisionStore, with fs blobs. Runs only when a database is offered,
// like postgres-live.test.ts:
//
//   FOLDRUN_TEST_DATABASE_URL=postgres://foldrun@localhost:55432/foldrun npm test
//
// The tables come from the migrations (drizzle/0039). A workspace name per case,
// so nothing is truncated.

import { test, before, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { takeTurnsOnLiveDb } from "./live-db-lock.ts";
import { fsBlobStore, bounded } from "../../foldrun-core/src/blob-store.ts";
import { revisionContract } from "../../foldrun-core/tests/revision-contract.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
takeTurnsOnLiveDb(url);

if (!url) {
  test("pg revision store (set FOLDRUN_TEST_DATABASE_URL to run)", { skip: "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" }, () => {});
} else {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  const dirs: string[] = [];
  before(async () => {
    const { migrate } = await import("../src/db.ts");
    await migrate();
  });
  after(async () => {
    dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
    const { db } = await import("../src/db.ts");
    await db()?.end();
  });
  revisionContract("fs + pg", async () => {
    const { pgRevisionStore } = await import("../src/revision-store-pg.ts");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-pgrev-"));
    dirs.push(root);
    return { blobs: bounded(fsBlobStore(path.join(root, "objects")), { backoffMs: 1 }), revisions: pgRevisionStore(), cleanup: async () => {} };
  });
}
