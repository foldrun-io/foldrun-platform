// Blob pins and fenced locks on a real Postgres (FOL-126, phase 2). DB-gated
// like postgres-live.test.ts: FOLDRUN_TEST_DATABASE_URL=postgres://… npm test

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { takeTurnsOnLiveDb } from "./live-db-lock.ts";
import { fsBlobStore, bounded } from "../../foldrun-core/src/blob-store.ts";
import { publish } from "../../foldrun-core/src/publish.ts";
import { sha256Hex, MODE_FILE } from "../../foldrun-core/src/manifest.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
takeTurnsOnLiveDb(url);

if (!url) {
  test("blob pins + fenced locks (set FOLDRUN_TEST_DATABASE_URL to run)", { skip: "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" }, () => {});
} else {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  const dirs: string[] = [];
  const tenant = () => `pin${crypto.randomBytes(4).toString("hex")}`;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  before(async () => {
    const { migrate } = await import("../src/db.ts");
    await migrate();
  });
  after(async () => {
    dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
    const { db } = await import("../src/db.ts");
    await db()?.end();
  });

  test("a pin protects until released; a lapsed lease protects nothing; a revision's pin has no lease", async () => {
    const { pgBlobPins } = await import("../src/blob-pins.ts");
    const pins = pgBlobPins();
    const t = tenant();
    const sha = "a".repeat(64);
    assert.equal(await pins.isPinned(t, "blob", sha), false);
    await pins.pinBlobs(t, [sha], { kind: "publish", id: "op-1" }, { ttlMs: 60_000 });
    assert.equal(await pins.isPinned(t, "blob", sha), true);
    assert.equal(await pins.isPinned(t, "manifest", sha), false, "a blob pin is not a manifest pin");
    assert.equal(await pins.release(t, { kind: "publish", id: "op-1" }), 1);
    assert.equal(await pins.isPinned(t, "blob", sha), false);

    await pins.pinBlobs(t, [sha], { kind: "run", id: "run-1" }, { ttlMs: 30 });
    await sleep(80);
    assert.equal(await pins.isPinned(t, "blob", sha), false, "the lease ran out");
    assert.equal(await pins.renew(t, { kind: "run", id: "run-1" }, 60_000), 1);
    assert.equal(await pins.isPinned(t, "blob", sha), true, "renewed");

    await pins.pinManifests(t, ["b".repeat(64)], { kind: "revision", id: "rev_x" });
    assert.equal(await pins.renew(t, { kind: "revision", id: "rev_x" }, 10), 0, "no lease to renew");
    await sleep(30);
    assert.equal(await pins.isPinned(t, "manifest", "b".repeat(64)), true);
    // another holder's pin on the same object keeps it protected
    await pins.pinManifests(t, ["b".repeat(64)], { kind: "run", id: "run-2" }, { ttlMs: 60_000 });
    await pins.release(t, { kind: "revision", id: "rev_x" });
    assert.equal(await pins.isPinned(t, "manifest", "b".repeat(64)), true);
  });

  test("the sweeper deletes through guardDelete: pinned objects stay, unpinned go", async () => {
    const { pgBlobPins } = await import("../src/blob-pins.ts");
    const pins = pgBlobPins();
    const t = tenant();
    const deleted: string[] = [];
    await pins.pinBlobs(t, ["1".repeat(64)], { kind: "publish", id: "op-keep" }, { ttlMs: 60_000 });
    assert.equal(await pins.guardDelete(t, "blob", "1".repeat(64), async () => void deleted.push("1")), false);
    assert.equal(await pins.guardDelete(t, "blob", "2".repeat(64), async () => void deleted.push("2")), true);
    assert.deepEqual(deleted, ["2"]);
    // a delete that throws leaves no half state and releases the lock
    await assert.rejects(() => pins.guardDelete(t, "blob", "3".repeat(64), async () => { throw new Error("s3 down"); }), /s3 down/);
    assert.equal(await pins.guardDelete(t, "blob", "3".repeat(64), async () => void deleted.push("3")), true);
  });

  test("a pin racing a sweep: the pin waits for the delete in flight, and sees nothing pinned before it", async () => {
    const { pgBlobPins } = await import("../src/blob-pins.ts");
    const pins = pgBlobPins();
    const t = tenant();
    const sha = "c".repeat(64);
    const order: string[] = [];
    const sweep = pins.guardDelete(t, "blob", sha, async () => {
      order.push("delete-start");
      await sleep(250);
      order.push("delete-end");
    });
    await sleep(60); // the sweeper holds the object's lock now
    const pinned = pins.pinBlobs(t, [sha], { kind: "publish", id: "op-late" }, { ttlMs: 60_000 }).then(() => order.push("pinned"));
    await Promise.all([sweep, pinned]);
    assert.deepEqual(order, ["delete-start", "delete-end", "pinned"], "the pin could not land in the middle of a delete");
    assert.equal(await pins.isPinned(t, "blob", sha), true);
  });

  test("publish through the pg store: the revision pins its manifests; the publish's blob pins are released", async () => {
    const { pgBlobPins } = await import("../src/blob-pins.ts");
    const { pgRevisionStore } = await import("../src/revision-store-pg.ts");
    const { db } = await import("../src/db.ts");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-pins-"));
    dirs.push(root);
    const deps = { blobs: bounded(fsBlobStore(path.join(root, "objects")), { backoffMs: 1 }), revisions: pgRevisionStore(), pins: pgBlobPins() };
    const ws = { tenant: tenant(), workspace: "w1" };
    const bytes = Buffer.from("memory note");
    const res = await publish(deps, {
      ws,
      opId: `op-${crypto.randomBytes(4).toString("hex")}`,
      by: "user:t",
      message: "m",
      changes: { "memory/a.md": { op: "put", base: null, sha: sha256Hex(bytes), size: bytes.length, mode: MODE_FILE } },
      bytesOf: async () => bytes,
    });
    assert.equal(res.status, "committed");
    const rows = (await db()!.query(`SELECT kind, holder_kind, holder_id, expires_at FROM blob_pins WHERE tenant=$1`, [ws.tenant])).rows;
    assert.equal(rows.length, 1, "one manifest pin; the publish's own blob pin is gone (state side empty → no second manifest)");
    assert.equal(rows[0].kind, "manifest");
    assert.equal(rows[0].holder_kind, "revision");
    assert.equal(rows[0].holder_id, res.revision!.id);
    assert.equal(rows[0].expires_at, null);
    // a state-only publish pins the state manifest under its own revision
    const stateBytes = Buffer.from("{}");
    const st = await publish(deps, {
      ws,
      opId: `op-${crypto.randomBytes(4).toString("hex")}`,
      by: "run:r1:a",
      message: "checkpoint",
      changes: { "state/s.json": { op: "put", base: null, sha: sha256Hex(stateBytes), size: 2, mode: MODE_FILE } },
      bytesOf: async () => stateBytes,
    });
    assert.equal(st.status, "committed");
    const n = (await db()!.query(`SELECT count(*)::int AS n FROM blob_pins WHERE tenant=$1 AND holder_kind='revision'`, [ws.tenant])).rows[0].n;
    assert.equal(n, 2);
  });

  test("a fenced lock: tokens only go up, and a holder whose lock was taken over is refused", async () => {
    const { withFencedLock, assertFence, StaleLock } = await import("../src/fenced-lock.ts");
    const { tx, db } = await import("../src/db.ts");
    const name = `t/${tenant()}/job`;
    const seen: number[] = [];
    await withFencedLock(name, async (f) => {
      seen.push(f.token);
      await tx((t) => assertFence(t, f)); // the holder passes while it is the newest
    });
    await withFencedLock(name, async (f) => seen.push(f.token));
    assert.ok(seen[1] > seen[0], `tokens increase: ${seen}`);
    // a stalled holder: its lock is taken over behind its back (here by bumping
    // the token, as a newer holder's acquisition does), then it tries to write
    await withFencedLock(name, async (f) => {
      await db()!.query(`UPDATE lock_fences SET token = token + 1 WHERE name = $1`, [name]);
      await assert.rejects(() => tx((t) => assertFence(t, f)), StaleLock);
    });
  });

  test("two holders of one fenced lock never overlap", async () => {
    const { withFencedLock } = await import("../src/fenced-lock.ts");
    const name = `t/${tenant()}/exclusive`;
    let inside = 0;
    let worst = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        withFencedLock(name, async () => {
          inside++;
          worst = Math.max(worst, inside);
          await sleep(15);
          inside--;
        }),
      ),
    );
    assert.equal(worst, 1);
  });
}
