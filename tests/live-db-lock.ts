// One live-Postgres test file at a time. The test runner runs files in
// parallel, and postgres-live.test.ts drops every table before it migrates
// while postgres-live-billing.test.ts (foldrun-admin) truncates the ledger:
// against one FOLDRUN_TEST_DATABASE_URL they must take turns. The lock is a
// file per database, created exclusively and holding this process's token.
// A lock older than STALE_MS is not stolen — an old file does not prove its
// holder died — so the run fails with what to delete instead.

import { before, after } from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STALE_MS = 15 * 60_000;

export function takeTurnsOnLiveDb(url: string | undefined): void {
  if (!url) return;
  const file = path.join(os.tmpdir(), `foldrun-live-db-${crypto.createHash("sha256").update(url).digest("hex").slice(0, 16)}.lock`);
  const token = `${process.pid}:${crypto.randomBytes(8).toString("hex")}`;
  before(async () => {
    for (;;) {
      try {
        fs.writeFileSync(file, token, { flag: "wx" });
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      let age = 0;
      try {
        age = Date.now() - fs.statSync(file).mtimeMs;
      } catch {
        continue; // released between the two calls: take it now
      }
      if (age > STALE_MS) {
        throw new Error(`${file} is ${Math.round(age / 60_000)} min old — another live-DB test run, or a crashed one. If none is running, delete it and run again.`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  });
  after(() => {
    // Only our own lock: never one a later run took.
    try {
      if (fs.readFileSync(file, "utf8") === token) fs.rmSync(file, { force: true });
    } catch {
      // already gone
    }
  });
}
