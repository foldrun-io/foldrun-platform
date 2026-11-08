// BlobPins on Postgres (FOL-126, phase 2). The argument is in core
// blob-pins.ts; this is the table behind it.
//
// Pinning and sweeping meet on a per-object advisory lock (transaction scoped,
// keyed by tenant + kind + ref): a pin takes it for the insert, guardDelete
// takes it for the check-and-delete. So either the pin is visible to the
// sweeper's check, or the delete has finished before the pin lands — and a
// publisher pins BEFORE it looks for its blobs, so it then sees them gone and
// uploads them again.

import type { Pool } from "pg";
import type { BlobPins, PinHolder, PinKind } from "../../foldrun-core/src/blob-pins.ts";
import { db } from "./db.ts";

export function pgBlobPins(pool: () => Pool | null = db): BlobPins {
  const p = (): Pool => {
    const x = pool();
    if (!x) throw new Error("blob pins need FOLDRUN_DATABASE_URL");
    return x;
  };
  const lockKey = (tenant: string, kind: string, ref: string) => `pin:${tenant}:${kind}:${ref}`;

  async function pin(kind: PinKind, tenant: string, refs: readonly string[], holder: PinHolder, ttlMs?: number) {
    // One transaction per object, so no two pins (or a pin and a sweep) of the
    // same object wait on each other for longer than one insert, and no lock
    // order can deadlock: each transaction holds exactly one lock.
    for (const ref of new Set(refs)) {
      const c = await p().connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey(tenant, kind, ref)]);
        await c.query(
          `INSERT INTO blob_pins (tenant, kind, ref, holder_kind, holder_id, expires_at)
           VALUES ($1,$2,$3,$4,$5, CASE WHEN $6::bigint IS NULL THEN NULL ELSE now() + ($6::bigint * interval '1 millisecond') END)
           ON CONFLICT (tenant, kind, ref, holder_kind, holder_id) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
          [tenant, kind, ref, holder.kind, holder.id, ttlMs ?? null],
        );
        await c.query("COMMIT");
      } catch (err) {
        await c.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        c.release();
      }
    }
  }

  return {
    pinBlobs: (tenant, shas, holder, opts) => pin("blob", tenant, shas, holder, opts?.ttlMs),
    pinManifests: (tenant, ids, holder, opts) => pin("manifest", tenant, ids, holder, opts?.ttlMs),
    async release(tenant, holder) {
      const r = await p().query(`DELETE FROM blob_pins WHERE tenant=$1 AND holder_kind=$2 AND holder_id=$3`, [tenant, holder.kind, holder.id]);
      return r.rowCount ?? 0;
    },
    async renew(tenant, holder, ttlMs) {
      const r = await p().query(
        `UPDATE blob_pins SET expires_at = now() + ($4::bigint * interval '1 millisecond')
          WHERE tenant=$1 AND holder_kind=$2 AND holder_id=$3 AND expires_at IS NOT NULL`,
        [tenant, holder.kind, holder.id, ttlMs],
      );
      return r.rowCount ?? 0;
    },
    async isPinned(tenant, kind, ref) {
      const r = await p().query(
        `SELECT 1 FROM blob_pins WHERE tenant=$1 AND kind=$2 AND ref=$3 AND (expires_at IS NULL OR expires_at > now()) LIMIT 1`,
        [tenant, kind, ref],
      );
      return (r.rowCount ?? 0) > 0;
    },
    async live(tenant) {
      const r = await p().query<{ kind: string; ref: string }>(
        `SELECT DISTINCT kind, ref FROM blob_pins WHERE tenant=$1 AND (expires_at IS NULL OR expires_at > now())`,
        [tenant],
      );
      return { manifests: r.rows.filter((x) => x.kind === "manifest").map((x) => x.ref), blobs: r.rows.filter((x) => x.kind === "blob").map((x) => x.ref) };
    },
    async isPinnedBeyondRevisions(tenant, kind, ref) {
      const r = await p().query(
        `SELECT 1 FROM blob_pins WHERE tenant=$1 AND kind=$2 AND ref=$3 AND holder_kind <> 'revision' AND (expires_at IS NULL OR expires_at > now()) LIMIT 1`,
        [tenant, kind, ref],
      );
      return (r.rowCount ?? 0) > 0;
    },
    async guardDelete(tenant, kind, ref, del) {
      const c = await p().connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey(tenant, kind, ref)]);
        const r = await c.query(
          `SELECT 1 FROM blob_pins WHERE tenant=$1 AND kind=$2 AND ref=$3 AND (expires_at IS NULL OR expires_at > now()) LIMIT 1`,
          [tenant, kind, ref],
        );
        if ((r.rowCount ?? 0) > 0) {
          await c.query("ROLLBACK");
          return false;
        }
        // Still holding the lock: a pin for this object waits for us.
        await del();
        await c.query("COMMIT");
        return true;
      } catch (err) {
        await c.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        c.release();
      }
    },
  };
}

/** Housekeeping: drop pins whose lease ran out (a crashed publisher or run).
 *  They protect nothing already; this keeps the table small. */
export async function expirePins(pool: Pool | null = db()): Promise<number> {
  if (!pool) return 0;
  const r = await pool.query(`DELETE FROM blob_pins WHERE expires_at IS NOT NULL AND expires_at < now() - interval '1 hour'`);
  return r.rowCount ?? 0;
}
