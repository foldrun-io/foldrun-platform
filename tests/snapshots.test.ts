// Snapshots (Part B3): stored once by hash, scoped to an account and a
// workspace, secrets refused on the server too, quotas, expiry and pinning.
// File mode always; Postgres too when FOLDRUN_TEST_DATABASE_URL is set.
//
//   node --test tests/snapshots.test.ts
//   FOLDRUN_TEST_DATABASE_URL=postgres://foldrun:test@localhost:55432/foldrun node --test tests/snapshots.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { takeTurnsOnLiveDb } from "./live-db-lock.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
takeTurnsOnLiveDb(url);
process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-snapshots-"));
if (url) {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  process.env.FOLDRUN_SECRET_KEY ??= "test-install-key";
} else {
  delete process.env.FOLDRUN_DATABASE_URL;
}

const { packSnapshot } = await import("../../foldrun-core/src/snapshot-archive.ts");
const snaps = await import("../src/snapshots.ts");
if (url) await (await import("../src/db.ts")).migrate();

const f = (p: string, text: string) => ({ path: p, mode: 0o644, content: Buffer.from(text) });
const tenant = `snap${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const mode = url ? "postgres" : "files";

test(`[${mode}] a folder is stored once by its hash and found only in its own workspace`, async () => {
  const a = packSnapshot([f("src/index.ts", "export const x = 1;\n"), f("README.md", "hello\n")]);
  const saved = await snaps.saveSnapshot(tenant, "desk", a.archive);
  assert.equal(saved.snapshotId, a.sha256);
  assert.equal(saved.files, 2);
  assert.equal(saved.reused, false);
  const again = await snaps.saveSnapshot(tenant, "desk", a.archive);
  assert.equal(again.reused, true, "the same folder twice is one snapshot");

  assert.ok(await snaps.getSnapshot(tenant, "desk", a.sha256));
  assert.equal(await snaps.getSnapshot(tenant, "other", a.sha256), null, "another workspace does not see it, even with its id");
  assert.equal(await snaps.getSnapshot(`${tenant}x`, "desk", a.sha256), null, "nor another account");
  assert.equal(await snaps.getSnapshot(tenant, "desk", "../../etc"), null, "an id that is not a hash finds nothing");

  const entries = await snaps.snapshotEntries(tenant, "desk", a.sha256);
  assert.deepEqual(entries.map((e) => e.path), ["README.md", "src/index.ts"]);
  assert.equal(entries[1]!.content.toString(), "export const x = 1;\n");
});

test(`[${mode}] the server refuses a secret, a bad archive and past the quota — whatever the client checked`, async () => {
  const key = ["sk", "live", "abcdefghijklmnopqrstuvwxyzAB"].join("_");
  const leaky = packSnapshot([f("config.ts", `// foldrun-ignore-file secret/hardcoded: not here\nexport const k = "${key}";\n`)]);
  await assert.rejects(snaps.saveSnapshot(tenant, "desk", leaky.archive), (e: unknown) => e instanceof snaps.SnapshotRefused && /looks like a secret \(config\.ts:2\)/.test((e as Error).message) && !(e as Error).message.includes(key));
  await assert.rejects(snaps.saveSnapshot(tenant, "desk", Buffer.from("not an archive")), /not a gzip/);

  const q = { ...snaps.SNAPSHOT_QUOTA };
  try {
    snaps.SNAPSHOT_QUOTA.count = 2;
    const t2 = `${tenant}q`;
    await snaps.saveSnapshot(t2, "desk", packSnapshot([f("a.txt", "1")]).archive);
    await snaps.saveSnapshot(t2, "desk", packSnapshot([f("a.txt", "2")]).archive);
    await assert.rejects(snaps.saveSnapshot(t2, "desk", packSnapshot([f("a.txt", "3")]).archive), /the most is 2/);
    assert.equal((await snaps.saveSnapshot(t2, "desk", packSnapshot([f("a.txt", "1")]).archive)).reused, true, "sending one it already has is not a new one");
  } finally {
    Object.assign(snaps.SNAPSHOT_QUOTA, q);
  }
});

test(`[${mode}] an unused snapshot expires and its archive goes; one a run uses is kept`, async () => {
  const t3 = `${tenant}e`;
  const used = packSnapshot([f("used.txt", "kept")]);
  const idle = packSnapshot([f("idle.txt", "gone")]);
  const sent = new Date("2026-11-01T00:00:00Z");
  await snaps.saveSnapshot(t3, "desk", used.archive, sent);
  await snaps.saveSnapshot(t3, "desk", idle.archive, sent);
  await snaps.pinSnapshotToRun(t3, "desk", used.sha256, "run-1");
  const later = new Date(sent.getTime() + snaps.SNAPSHOT_TTL_MS + 60_000);
  assert.ok((await snaps.sweepSnapshots(later, (_t, _w, id) => id === "run-1")) >= 1);
  assert.ok(await snaps.getSnapshot(t3, "desk", used.sha256, later), "kept: a run uses it");
  assert.equal(await snaps.getSnapshot(t3, "desk", idle.sha256, later), null, "expired");
  await assert.rejects(snaps.snapshotEntries(t3, "desk", idle.sha256), /no snapshot/);
});

test(`[${mode}] at once: parallel sends cannot pass the quota together, a re-send keeps a pin, a sweep never deletes a live archive (Codex)`, async () => {
  const q = { ...snaps.SNAPSHOT_QUOTA };
  try {
    snaps.SNAPSHOT_QUOTA.count = 3;
    const t4 = `${tenant}c`;
    const sends = Array.from({ length: 8 }, (_, i) => snaps.saveSnapshot(t4, "desk", packSnapshot([f("n.txt", String(i))]).archive));
    const settled = await Promise.allSettled(sends);
    assert.equal(settled.filter((s) => s.status === "fulfilled").length, 3, "exactly the quota, however many arrive together");
  } finally {
    Object.assign(snaps.SNAPSHOT_QUOTA, q);
  }

  const t5 = `${tenant}p`;
  const one = packSnapshot([f("p.txt", "pinned")]);
  await snaps.saveSnapshot(t5, "desk", one.archive);
  await Promise.all([snaps.pinSnapshotToRun(t5, "desk", one.sha256, "run-9"), snaps.saveSnapshot(t5, "desk", one.archive), snaps.saveSnapshot(t5, "desk", one.archive)]);
  assert.deepEqual((await snaps.getSnapshot(t5, "desk", one.sha256))?.runIds, ["run-9"], "the pin survives re-sends around it");

  const t6 = `${tenant}s`;
  const old = packSnapshot([f("s.txt", "resent")]);
  const sent = new Date("2026-11-01T00:00:00Z");
  const later = new Date(sent.getTime() + snaps.SNAPSHOT_TTL_MS + 60_000);
  for (let i = 0; i < 5; i++) {
    await snaps.saveSnapshot(t6, "desk", old.archive, sent);
    await Promise.all([snaps.sweepSnapshots(later, () => true), snaps.saveSnapshot(t6, "desk", old.archive, later)]);
    // Whichever ran first, the record that is left must still read back.
    if (await snaps.getSnapshot(t6, "desk", old.sha256, later)) {
      const e = await snaps.snapshotEntries(t6, "desk", old.sha256);
      assert.equal(e[0]!.content.toString(), "resent");
    }
  }
  assert.ok(await snaps.getSnapshot(t6, "desk", old.sha256, later), "re-sent last: it is there");
});

const archiveFile = (t: string, sha: string) => path.join(process.env.FOLDRUN_DATA!, ".objects", "snapshots", t, `${sha}.tar.gz`);

test(`[${mode}] a pin goes with its run; a failed archive delete is tried again; an account delete takes them all (Codex)`, async () => {
  const sent = new Date("2026-11-01T00:00:00Z");
  const later = new Date(sent.getTime() + snaps.SNAPSHOT_TTL_MS + 60_000);

  // The run that pinned it was deleted (or pruned): the pin no longer keeps it.
  const t7 = `${tenant}r`;
  const pinned = packSnapshot([f("r.txt", "run gone")]);
  await snaps.saveSnapshot(t7, "desk", pinned.archive, sent);
  await snaps.pinSnapshotToRun(t7, "desk", pinned.sha256, "run-deleted");
  await snaps.sweepSnapshots(later, () => true); // every account: the count is not this one's alone
  assert.ok(fs.existsSync(archiveFile(t7, pinned.sha256)));
  await snaps.sweepSnapshots(later, (tn) => tn !== t7);
  assert.equal(await snaps.getSnapshot(t7, "desk", pinned.sha256, later), null, "once the run is gone, so is the snapshot");
  assert.equal(fs.existsSync(archiveFile(t7, pinned.sha256)), false);

  // The archive cannot be deleted: the record stays, so the next sweep finds it.
  const t8 = `${tenant}f`;
  const stuck = packSnapshot([f("f.txt", "stuck")]);
  await snaps.saveSnapshot(t8, "desk", stuck.archive, sent);
  const dir = path.dirname(archiveFile(t8, stuck.sha256));
  fs.chmodSync(dir, 0o555);
  try {
    await snaps.sweepSnapshots(later, () => true);
  } finally {
    fs.chmodSync(dir, 0o755);
  }
  assert.ok(fs.existsSync(archiveFile(t8, stuck.sha256)), "the archive could not go");
  const idx = () => (url ? null : JSON.parse(fs.readFileSync(path.join(process.env.FOLDRUN_DATA!, t8, "snapshots.json"), "utf8")).length);
  if (!url) assert.equal(idx(), 1, "so its record stayed");
  assert.ok((await snaps.sweepSnapshots(later, () => true)) >= 1, "tried again, and gone");
  if (!url) assert.equal(idx(), 0);
  assert.equal(fs.existsSync(archiveFile(t8, stuck.sha256)), false);

  // Account delete: pinned or not, every archive and every record.
  const t9 = `${tenant}d`;
  const a = packSnapshot([f("a.txt", "a")]);
  const b = packSnapshot([f("b.txt", "b")]);
  await snaps.saveSnapshot(t9, "desk", a.archive);
  await snaps.saveSnapshot(t9, "other", b.archive);
  await snaps.pinSnapshotToRun(t9, "desk", a.sha256, "run-1");
  assert.equal(await snaps.deleteTenantSnapshots(t9), 2);
  assert.equal(await snaps.getSnapshot(t9, "desk", a.sha256), null);
  assert.equal(await snaps.getSnapshot(t9, "other", b.sha256), null);
  assert.equal(fs.existsSync(archiveFile(t9, a.sha256)) || fs.existsSync(archiveFile(t9, b.sha256)), false);
});

test(`[${mode}] two runs on one snapshot: it stays while either is there (Codex)`, async () => {
  const t10 = `${tenant}m`;
  const shared = packSnapshot([f("m.txt", "shared")]);
  const sent = new Date("2026-11-01T00:00:00Z");
  const later = new Date(sent.getTime() + snaps.SNAPSHOT_TTL_MS + 60_000);
  await snaps.saveSnapshot(t10, "desk", shared.archive, sent);
  await Promise.all([snaps.pinSnapshotToRun(t10, "desk", shared.sha256, "run-a"), snaps.pinSnapshotToRun(t10, "desk", shared.sha256, "run-b")]);
  await snaps.pinSnapshotToRun(t10, "desk", shared.sha256, "run-a");
  assert.deepEqual([...(await snaps.getSnapshot(t10, "desk", shared.sha256))!.runIds].sort(), ["run-a", "run-b"], "both pins, once each");
  const alive = new Set(["run-a"]);
  await snaps.sweepSnapshots(later, (tn, _w, id) => tn !== t10 || alive.has(id));
  assert.deepEqual((await snaps.getSnapshot(t10, "desk", shared.sha256, later))?.runIds, ["run-a"], "run-b is gone, run-a still keeps it");
  assert.ok(fs.existsSync(archiveFile(t10, shared.sha256)));
  alive.clear();
  await snaps.sweepSnapshots(later, (tn) => tn !== t10);
  assert.equal(await snaps.getSnapshot(t10, "desk", shared.sha256, later), null);
  assert.equal(fs.existsSync(archiveFile(t10, shared.sha256)), false);
});

test(`[${mode}] an archive no record names (a save that died between its two writes) goes after a day (Codex)`, async () => {
  const t11 = `${tenant}o`;
  const { blobStore } = await import("../../foldrun-core/src/blob-store.ts");
  const lost = packSnapshot([f("o.txt", "orphan")]);
  await blobStore().putIfAbsent(`snapshots/${t11}/${lost.sha256}.tar.gz`, lost.archive);
  const named = packSnapshot([f("o.txt", "named")]);
  await snaps.saveSnapshot(t11, "desk", named.archive);
  await snaps.sweepSnapshots(new Date());
  assert.ok(fs.existsSync(archiveFile(t11, lost.sha256)), "not within the day: a save may still be writing its record");
  await snaps.sweepSnapshots(new Date(Date.now() + 2 * 86_400_000), () => true);
  assert.equal(fs.existsSync(archiveFile(t11, lost.sha256)), false, "named by nothing after a day: gone");
  assert.ok(fs.existsSync(archiveFile(t11, named.sha256)), "one a record names stays, however old");
});
