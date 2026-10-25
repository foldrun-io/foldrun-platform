// The housekeeping lease: one holder for the chores, separate from the
// scheduler's, taken per job and released after.
//
//   node --test tests/housekeeping.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { takeHousekeeping, releaseHousekeeping, withHousekeeping, housekeepingOwner } from "../src/housekeeping.ts";

async function withData(body: (root: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-housekeeping-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  delete process.env.FOLDRUN_REDIS_URL;
  try {
    await body(root);
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("a chore runs under the lease and releases it; a chore elsewhere skips while it is held", async () => {
  await withData(async (root) => {
    const file = path.join(root, ".housekeeping-lease");
    const ran: string[] = [];
    const out = await withHousekeeping("reap", async () => {
      ran.push("reap");
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).owner, housekeepingOwner(), "held by this process while the job runs");
      return 7;
    });
    assert.equal(out, 7);
    assert.deepEqual(ran, ["reap"]);
    assert.ok(!fs.existsSync(file), "released when the job is done");

    // Another pod holds it, freshly: this one skips and says so.
    fs.writeFileSync(file, JSON.stringify({ owner: "other-pod:1-abc", renewedAt: Date.now() }));
    const skipped = await withHousekeeping("accrual", async () => "ran", { tries: 2, waitMs: 1 });
    assert.equal(skipped, undefined, "skipped, not run twice");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).owner, "other-pod:1-abc", "and the other's lease is untouched");

    // The other pod died mid-job: past the TTL the lease is claimable.
    fs.writeFileSync(file, JSON.stringify({ owner: "other-pod:1-abc", renewedAt: Date.now() - 11 * 60_000 }));
    assert.equal(await takeHousekeeping(), true);
    await releaseHousekeeping();
    assert.ok(!fs.existsSync(file));
  });
});

test("the lease is not the scheduler's — the two files are different, so a chore never delays a flow", async () => {
  await withData(async (root) => {
    fs.writeFileSync(path.join(root, ".scheduler-lease"), JSON.stringify({ owner: "scheduler-elsewhere", renewedAt: Date.now() }));
    assert.equal(await takeHousekeeping(), true, "someone else firing flows does not stop the chores");
    await releaseHousekeeping();
  });
});
