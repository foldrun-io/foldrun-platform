// Snapshots (Part B3, 10 Nov 2026): a folder from a user's machine, sent for
// an agent on foldrun to work on.
//
// The archive arrives from a stranger, so it is unpacked under core's strict
// reader (snapshot-archive.ts) and scanned for secrets here too — the CLI
// refuses one before it leaves the machine, this enforces it for any client.
// Then it is stored ONCE by its hash in the blob store, and a record says
// which account and workspace may use it, until when. An id grants nothing:
// every lookup is scoped to the account and the workspace.
//
//   Postgres: the `snapshots` table (drizzle/0048).
//   No database: <data>/<tenant>/snapshots.json, under a lock.
//
// Unattached snapshots expire after SNAPSHOT_TTL_MS; one a run uses is kept
// with that run (pinSnapshotToRun) and goes when the run does (the sweep, in
// the scheduler's housekeeping pass). deleteTenantSnapshots at account delete.

import fs from "node:fs";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import {
  unpackSnapshot,
  SnapshotRefused,
  SNAPSHOT_LIMITS,
  type SnapshotEntry,
} from "../../foldrun-core/src/snapshot-archive.ts";
import { uploadSecretFindings } from "../../foldrun-core/src/scan.ts";
import { blobStore } from "../../foldrun-core/src/blob-store.ts";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { readRun } from "../../foldrun-core/src/store.ts";
import { opsError, opsLog } from "../../foldrun-core/src/ops-log.ts";
import { databaseEnabled, ormRequired, tx, type Db } from "./db.ts";
import { snapshots } from "./schema.ts";

export const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Per account: how many snapshots, and how many bytes (unpacked), at once. */
export const SNAPSHOT_QUOTA = { count: 50, bytes: 2 * 1024 * 1024 * 1024 };

export { SnapshotRefused };

export interface SnapshotRecord {
  tenant: string;
  workspace: string;
  sha256: string;
  files: number;
  bytes: number;
  compressedBytes: number;
  createdAt: string;
  expiresAt: string;
  /** The runs that use it; any one of them still there keeps it. */
  runIds: string[];
}

const blobKey = (tenant: string, sha: string) =>
  `snapshots/${tenant}/${sha}.tar.gz`;

// ------------------------------------------------------------ the index

function fileIndex(tenant: string): string {
  return path.join(dataRoot(), tenant, "snapshots.json");
}
function readFileIndex(tenant: string): SnapshotRecord[] {
  try {
    return JSON.parse(
      fs.readFileSync(fileIndex(tenant), "utf8"),
    ) as SnapshotRecord[];
  } catch {
    return [];
  }
}
function writeFileIndex(tenant: string, rows: SnapshotRecord[]): void {
  const p = fileIndex(tenant);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2));
  fs.renameSync(tmp, p);
}
// One writer at a time per process (file mode is one process: self-host, a laptop).
let fileLock: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = fileLock.then(fn, fn);
  fileLock = run.catch(() => {});
  return run;
}

const rowOf = (r: typeof snapshots.$inferSelect): SnapshotRecord => ({
  tenant: r.tenant,
  workspace: r.workspace,
  sha256: r.sha256,
  files: r.files,
  bytes: Number(r.bytes),
  compressedBytes: r.compressedBytes,
  createdAt: r.createdAt.toISOString(),
  expiresAt: r.expiresAt.toISOString(),
  runIds: r.runIds ?? [],
});

/**
 * One account's snapshots, one change at a time (Codex): the quota check, the
 * archive write and the record in a save, and the sweeper's "nothing names this
 * archive any more" and its delete, all under this lock — so a re-send cannot
 * land between the sweeper's check and its delete, two sends cannot both pass
 * the quota, and a pin cannot be overwritten. Postgres: a transaction-scoped
 * advisory lock per account (every process); no database: the process lock.
 */
async function withTenantLock<T>(
  tenant: string,
  fn: (t: Db | null) => Promise<T>,
): Promise<T> {
  if (databaseEnabled()) {
    return tx(async (t) => {
      await t.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${"snapshots:" + tenant}))`,
      );
      return fn(t);
    });
  }
  return locked(() => fn(null));
}

/** The account's live snapshots (not expired, or kept by a run). */
async function liveOf(
  tenant: string,
  now: Date,
  t: Db | null = null,
): Promise<SnapshotRecord[]> {
  if (databaseEnabled()) {
    const rows = await (t ?? ormRequired())
      .select()
      .from(snapshots)
      .where(eq(snapshots.tenant, tenant));
    return rows
      .map(rowOf)
      .filter(
        (r) => r.runIds.length > 0 || Date.parse(r.expiresAt) > now.getTime(),
      );
  }
  return readFileIndex(tenant).filter(
    (r) =>
      (r.runIds ?? []).length > 0 || Date.parse(r.expiresAt) > now.getTime(),
  );
}

// ------------------------------------------------------------ save

export interface Saved {
  snapshotId: string;
  files: number;
  bytes: number;
  compressedBytes: number;
  expiresAt: string;
  /** This workspace already had this exact folder: no new copy was made. */
  reused: boolean;
}

/**
 * Take an archive a client sent: unpack it strictly, refuse secrets, check
 * the account's quota, store it once by hash, record it for this workspace.
 * Throws SnapshotRefused (a 400/413 for the caller) naming why.
 */
export async function saveSnapshot(
  tenant: string,
  workspace: string,
  archive: Buffer,
  now = new Date(),
): Promise<Saved> {
  const { entries, sha256, bytes } = unpackSnapshot(archive);
  const secrets = uploadSecretFindings(
    entries.map((e) => ({ path: e.path, content: e.content.toString("utf8") })),
  );
  if (secrets.findings.length) {
    const where = secrets.findings
      .slice(0, 5)
      .map((f) => `${f.file}${f.line ? `:${f.line}` : ""}`)
      .join(", ");
    throw new SnapshotRefused(
      `it holds what looks like a secret (${where}${secrets.findings.length > 5 ? ", …" : ""}) — remove it, or leave that file out, and send it again`,
    );
  }
  const expiresAt = new Date(now.getTime() + SNAPSHOT_TTL_MS);
  return withTenantLock(tenant, async (t) => {
    const live = await liveOf(tenant, now, t);
    const mine = live.find(
      (r) => r.workspace === workspace && r.sha256 === sha256,
    );
    if (!mine) {
      const others = live.filter(
        (r) => !(r.workspace === workspace && r.sha256 === sha256),
      );
      if (others.length + 1 > SNAPSHOT_QUOTA.count)
        throw new SnapshotRefused(
          `this account has ${others.length} snapshots — the most is ${SNAPSHOT_QUOTA.count}; they expire ${SNAPSHOT_TTL_MS / 86_400_000} days after they were sent`,
        );
      const used = others.reduce((n, r) => n + r.bytes, 0);
      if (used + bytes > SNAPSHOT_QUOTA.bytes)
        throw new SnapshotRefused(
          `this account's snapshots would hold ${used + bytes} bytes — the most is ${SNAPSHOT_QUOTA.bytes}`,
        );
    }
    const put = await blobStore().putIfAbsent(blobKey(tenant, sha256), archive);
    const record: SnapshotRecord = {
      tenant,
      workspace,
      sha256,
      files: entries.length,
      bytes,
      compressedBytes: archive.length,
      createdAt: mine?.createdAt ?? now.toISOString(),
      // Sent again: it lives another full term from now.
      expiresAt:
        mine && Date.parse(mine.expiresAt) > expiresAt.getTime()
          ? mine.expiresAt
          : expiresAt.toISOString(),
      runIds: mine?.runIds ?? [],
    };
    try {
      if (t) {
        await t
          .insert(snapshots)
          .values({
            tenant,
            workspace,
            sha256,
            files: record.files,
            bytes: record.bytes,
            compressedBytes: record.compressedBytes,
            expiresAt: new Date(record.expiresAt),
          })
          .onConflictDoUpdate({
            target: [snapshots.tenant, snapshots.workspace, snapshots.sha256],
            set: { expiresAt: new Date(record.expiresAt) },
          });
      } else {
        // Read under the same lock: a pin made since is kept, never overwritten.
        const rows = readFileIndex(tenant);
        const current = rows.find(
          (r) => r.workspace === workspace && r.sha256 === sha256,
        );
        const rest = rows.filter((r) => r !== current);
        rest.push({ ...record, runIds: current?.runIds ?? record.runIds });
        writeFileIndex(tenant, rest);
      }
    } catch (err) {
      // The record could not be written: an archive this save made is named by
      // nothing, so it goes now (created means no record of this account had
      // it — a record implies its archive). A process that dies right here is
      // the orphan pass's (sweepSnapshots).
      if (put.created)
        await blobStore()
          .delete(blobKey(tenant, sha256))
          .catch(() => {});
      throw err;
    }
    return {
      snapshotId: sha256,
      files: record.files,
      bytes: record.bytes,
      compressedBytes: record.compressedBytes,
      expiresAt: record.expiresAt,
      reused: Boolean(mine),
    };
  });
}

// ------------------------------------------------------------ use

/** This workspace's snapshot by id, if it is still there. Scoped: an id from
 *  another account or workspace is not found, whatever it is. */
export async function getSnapshot(
  tenant: string,
  workspace: string,
  id: string,
  now = new Date(),
): Promise<SnapshotRecord | null> {
  if (!/^[0-9a-f]{64}$/.test(id)) return null;
  const live = await liveOf(tenant, now);
  return live.find((r) => r.workspace === workspace && r.sha256 === id) ?? null;
}

/** The files of a snapshot, read back and checked again (the store is not
 *  trusted to have kept the bytes it was given: the hash must still match). */
export async function snapshotEntries(
  tenant: string,
  workspace: string,
  id: string,
): Promise<SnapshotEntry[]> {
  const rec = await getSnapshot(tenant, workspace, id);
  if (!rec)
    throw new SnapshotRefused(
      `no snapshot ${id.slice(0, 12)}… in ${workspace} — send the folder again`,
    );
  const stream = await blobStore().get(blobKey(tenant, id));
  const chunks: Uint8Array[] = [];
  for await (const c of stream as unknown as AsyncIterable<Uint8Array>)
    chunks.push(c);
  const { entries, sha256 } = unpackSnapshot(Buffer.concat(chunks));
  if (sha256 !== id)
    throw new SnapshotRefused(
      `snapshot ${id.slice(0, 12)}… does not match its hash any more`,
    );
  return entries;
}

/** A run uses this snapshot: keep it as long as the run is kept. Added to
 *  the runs already keeping it, never in place of them; under the account
 *  lock, so a sweep cannot act on what it read before the pin (Codex). */
export async function pinSnapshotToRun(
  tenant: string,
  workspace: string,
  id: string,
  runId: string,
): Promise<void> {
  await withTenantLock(tenant, async (t) => {
    if (t) {
      await t
        .update(snapshots)
        .set({ runIds: sql`array_append(${snapshots.runIds}, ${runId}::text)` })
        .where(
          and(
            eq(snapshots.tenant, tenant),
            eq(snapshots.workspace, workspace),
            eq(snapshots.sha256, id),
            sql`NOT (${runId}::text = ANY(${snapshots.runIds}))`,
          ),
        );
      return;
    }
    const rows = readFileIndex(tenant);
    const r = rows.find((x) => x.workspace === workspace && x.sha256 === id);
    if (r && !(r.runIds ??= []).includes(runId)) {
      r.runIds.push(runId);
      writeFileIndex(tenant, rows);
    }
  });
}

/** Does this run still exist? A pin lasts as long as its run (deleted by a
 *  person, or pruned by retention: either way the pin is released). */
export type RunExists = (
  tenant: string,
  workspace: string,
  runId: string,
) => boolean;
const runStillThere: RunExists = (tenant, workspace, runId) => {
  try {
    return readRun(tenant, workspace, runId) !== null;
  } catch {
    return true; // cannot tell: keep it, the next sweep asks again
  }
};

/**
 * Forget expired snapshots no run keeps, and delete each archive no record
 * still names. The archive goes FIRST and the record only once it is gone, so
 * a delete that fails leaves the record for the next sweep to try again — the
 * other order orphaned the archive with nothing pointing at it (Codex).
 * Returns how many records went.
 */
export async function sweepSnapshots(
  now = new Date(),
  runExists: RunExists = runStillThere,
): Promise<number> {
  const tenants = databaseEnabled()
    ? (
        (
          await ormRequired().execute(
            sql`SELECT DISTINCT tenant FROM snapshots WHERE expires_at < ${now}`,
          )
        ).rows as { tenant: string }[]
      ).map((r) => r.tenant)
    : (fs.existsSync(dataRoot()) ? fs.readdirSync(dataRoot()) : []).filter(
        (t) => fs.existsSync(fileIndex(t)),
      );
  let n = 0;
  for (const tenant of tenants) {
    n += await withTenantLock(tenant, async (t) => {
      const all = t
        ? (
            await t.select().from(snapshots).where(eq(snapshots.tenant, tenant))
          ).map(rowOf)
        : readFileIndex(tenant).map((r) => ({ ...r, runIds: r.runIds ?? [] }));
      // Drop the pins of runs that are gone (deleted, or pruned by retention).
      let pinsChanged = false;
      for (const r of all) {
        const alive = r.runIds.filter((id) =>
          runExists(tenant, r.workspace, id),
        );
        if (alive.length === r.runIds.length) continue;
        r.runIds = alive;
        pinsChanged = true;
        if (t)
          await t
            .update(snapshots)
            .set({ runIds: alive })
            .where(
              and(
                eq(snapshots.tenant, tenant),
                eq(snapshots.workspace, r.workspace),
                eq(snapshots.sha256, r.sha256),
              ),
            );
      }
      const expired = (r: SnapshotRecord) =>
        Date.parse(r.expiresAt) <= now.getTime() && r.runIds.length === 0;
      const goes = all.filter(expired);
      if (!goes.length) {
        if (pinsChanged && !t) writeFileIndex(tenant, all);
        return 0;
      }
      const named = new Set(
        all.filter((r) => !expired(r)).map((r) => r.sha256),
      );
      const failed = new Set<string>();
      for (const sha of new Set(goes.map((g) => g.sha256))) {
        if (named.has(sha)) continue;
        try {
          await blobStore().delete(blobKey(tenant, sha));
        } catch (err) {
          failed.add(sha);
          opsError("snapshots.delete_failed", err, { tenant }, "warn");
        }
      }
      const forgotten = goes.filter((g) => !failed.has(g.sha256));
      if (t) {
        for (const g of forgotten) {
          await t
            .delete(snapshots)
            .where(
              and(
                eq(snapshots.tenant, tenant),
                eq(snapshots.workspace, g.workspace),
                eq(snapshots.sha256, g.sha256),
              ),
            );
        }
      } else if (forgotten.length || pinsChanged) {
        writeFileIndex(
          tenant,
          all.filter((r) => !forgotten.includes(r)),
        );
      }
      return forgotten.length;
    });
  }
  await sweepOrphanArchives(now).catch((err) =>
    opsError("snapshots.orphan_sweep_failed", err, {}, "warn"),
  );
  return n;
}

/** How long an archive may be named by nothing before it is taken for an
 *  orphan: far longer than a save takes between writing it and its record. */
const ORPHAN_AFTER_MS = 24 * 60 * 60 * 1000;
const ARCHIVE_KEY = /^snapshots\/([^/]+)\/([0-9a-f]{64})\.tar\.gz$/;

/** Archives no record names (a save that died between the two writes):
 *  found by listing the store, checked again under the account's lock. */
async function sweepOrphanArchives(now: Date): Promise<number> {
  const store = blobStore();
  if (!store.list) return 0;
  const byTenant = new Map<string, string[]>();
  for await (const o of store.list("snapshots/")) {
    const m = ARCHIVE_KEY.exec(o.key);
    if (!m || now.getTime() - o.modifiedAt.getTime() < ORPHAN_AFTER_MS)
      continue;
    byTenant.set(m[1]!, [...(byTenant.get(m[1]!) ?? []), m[2]!]);
  }
  let n = 0;
  for (const [tenant, shas] of byTenant) {
    n += await withTenantLock(tenant, async (t) => {
      const named = new Set(
        t
          ? (
              await t
                .select({ sha256: snapshots.sha256 })
                .from(snapshots)
                .where(eq(snapshots.tenant, tenant))
            ).map((r) => r.sha256)
          : readFileIndex(tenant).map((r) => r.sha256),
      );
      let gone = 0;
      for (const sha of shas) {
        if (named.has(sha)) continue;
        await store.delete(blobKey(tenant, sha));
        gone++;
      }
      return gone;
    });
  }
  if (n) opsLog("info", "snapshots.orphans_swept", { count: n });
  return n;
}

/**
 * An account is being deleted: every archive it sent and every record of
 * them, pinned or not. The archives are not under the account's `t/` prefix
 * and are not sealed with its key, so destroying the key does not cover them.
 * Archives first, records after (a failure leaves the records to find them by).
 */
export async function deleteTenantSnapshots(tenant: string): Promise<number> {
  return withTenantLock(tenant, async (t) => {
    const rows = t
      ? (
          await t.select().from(snapshots).where(eq(snapshots.tenant, tenant))
        ).map(rowOf)
      : readFileIndex(tenant);
    const keys = new Set(rows.map((r) => blobKey(tenant, r.sha256)));
    const store = blobStore();
    // And any archive whose record never got written (a save that died between the two).
    if (store.list)
      for await (const o of store.list(`snapshots/${tenant}/`)) keys.add(o.key);
    for (const k of keys) await store.delete(k);
    if (t) await t.delete(snapshots).where(eq(snapshots.tenant, tenant));
    else if (rows.length) fs.rmSync(fileIndex(tenant), { force: true });
    return keys.size;
  });
}

export { SNAPSHOT_LIMITS };
