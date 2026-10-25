// The backup index an account's Backups page reads, and the restore asks.
//
//   node --test tests/backups.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  backupPolicy,
  createRestoreRequest,
  listBackups,
  listRestoreRequests,
  markRestoreRequestNotified,
  recordBackup,
} from "../src/backups.ts";

async function inTempData<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const previous = process.env.FOLDRUN_DATA;
  const db = process.env.FOLDRUN_DATABASE_URL;
  delete process.env.FOLDRUN_DATABASE_URL;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-backups-test-"));
  process.env.FOLDRUN_DATA = root;
  try {
    return await fn(root);
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    if (db !== undefined) process.env.FOLDRUN_DATABASE_URL = db;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("an account sees only the archives it is in, newest first", async () => {
  await inTempData(async () => {
    await recordBackup({ at: "2026-09-29T17:30:00Z", archive: "foldrun-data-20260930-0330.tar.gz", accounts: ["acme", "other"], kinds: ["files", "database", "keys"], verified: true, offsite: "r2" });
    await recordBackup({ at: "2026-09-30T17:30:00Z", archive: "foldrun-data-20261001-0330.tar.gz", accounts: ["acme"], kinds: ["files", "database"], verified: true, offsite: null });
    await recordBackup({ at: "2026-09-30T17:30:00Z", archive: "foldrun-data-x.tar.gz", accounts: ["other"] });
    const acme = await listBackups("acme");
    assert.deepEqual(acme.map((b) => b.archive), ["foldrun-data-20261001-0330.tar.gz", "foldrun-data-20260930-0330.tar.gz"]);
    assert.equal(acme[1].offsite, "r2");
    assert.deepEqual(acme[1].kinds, ["files", "database", "keys"]);
    assert.deepEqual(acme[1].accounts, ["acme"], "an archive holding other accounts does not name them to this one");
    assert.equal((await listBackups("nobody")).length, 0);
  });
});

test("a line backup.sh appended by hand reads back, and a torn line is skipped", async () => {
  await inTempData(async (root) => {
    fs.writeFileSync(
      path.join(root, "backups.jsonl"),
      `{"id":"a","at":"2026-10-01T03:30:00+10:00","archive":"a.tar.gz","bytes":123,"accounts":["acme"],"kinds":["files"],"verified":true,"offsite":"r2","keepDays":15}\n{"torn`,
    );
    const [b] = await listBackups("acme");
    assert.equal(b.at, "2026-09-30T17:30:00.000Z");
    assert.equal(b.bytes, 123);
    assert.equal(b.keepDays, 15);
  });
});

test("each archive says whether it was sealed, and to which key; older rows read as not encrypted", async () => {
  await inTempData(async (root) => {
    await recordBackup({ at: "2026-10-01T17:30:00Z", archive: "foldrun-data-20261002-0330.tar.gz.age", accounts: ["acme"], verified: true, encrypted: true, recipient: "sha256:0123456789abcdef" });
    fs.appendFileSync(path.join(root, "backups.jsonl"), `{"id":"old","at":"2026-09-30T17:30:00Z","archive":"old.tar.gz","accounts":["acme"],"verified":true}\n`);
    const [sealed, old] = await listBackups("acme");
    assert.equal(sealed.encrypted, true);
    assert.equal(sealed.recipient, "sha256:0123456789abcdef");
    assert.equal(old.encrypted, false);
    assert.equal(old.recipient, null);
    assert.equal(backupPolicy().encrypted, true);
  });
});

test("a restore request is recorded for its account and can be marked notified", async () => {
  await inTempData(async () => {
    const r = await createRestoreRequest({ tenant: "acme", workspace: "sales", target: "2026-09-30T00:00:00Z", what: "runs", by: "a@b.c" });
    await createRestoreRequest({ tenant: "other", target: "yesterday", what: "everything", by: "x@y.z" });
    await markRestoreRequestNotified(r.id, true);
    const mine = await listRestoreRequests("acme");
    assert.equal(mine.length, 1);
    assert.equal(mine[0].notified, true);
    assert.equal(mine[0].status, "requested");
  });
});

test("the policy says storage bytes are not in the archive when they live in S3", () => {
  const prev = process.env.FOLDRUN_STORAGE_DRIVER;
  process.env.FOLDRUN_STORAGE_DRIVER = "s3";
  try {
    const p = backupPolicy();
    assert.equal(p.keepLocal, 14);
    assert.ok(p.excludes.some((e) => /object storage/.test(e)));
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_STORAGE_DRIVER;
    else process.env.FOLDRUN_STORAGE_DRIVER = prev;
  }
});
