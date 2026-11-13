// The platform's own small bookkeeping, as rows (FOL-126, 13 Nov 2026): what
// was a file per account on the shared volume and read by whichever pod came
// next — the day an account's daily lines were written (`.accrued`), runs
// whose charge did not settle (`unsettled/<run>.json`), which pause each flow
// was told about (`.paused-notices.json`), what the runtime warm-up found
// (`.runtime-status.json`), the day the audit log was last pruned. With a
// database each is a `platform_marks` row; without one, the caller keeps its
// file. A row is read before its file, and the old files are still read
// until they are gone, so nothing written before the change is missed.
//
// Synchronous on purpose: several callers are (the scheduler's gate, the
// warm-up status a page renders), so this goes through the same bridge as the
// records port (pg-sync.ts).

import { databaseEnabled } from "./db.ts";
import { pgSyncOne } from "./pg-sync.ts";

export type MarkKind = "accrued" | "unsettled" | "pause-notice" | "runtime-status" | "audit-pruned" | "avatar" | "assistant-end";

/** Rows to use: true with a database. */
export const marksInDatabase = (): boolean => databaseEnabled();

export function markGet<T>(tenant: string, kind: MarkKind, key = ""): T | undefined {
  const r = pgSyncOne("SELECT data FROM platform_marks WHERE tenant = $1 AND kind = $2 AND key = $3", [tenant, kind, key]);
  return r.rows[0] ? (r.rows[0].data as T) : undefined;
}

let failWrites = false;
/** Tests: every write throws, as with the database gone. */
export function failMarkWritesForTests(on: boolean): void {
  failWrites = on;
}

export function markPut(tenant: string, kind: MarkKind, key: string, data: unknown): void {
  if (failWrites) throw new Error("the database is not answering");
  pgSyncOne(
    `INSERT INTO platform_marks (tenant, kind, key, data) VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (tenant, kind, key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [tenant, kind, key, JSON.stringify(data)],
  );
}

/** Set the key to `data` unless it already holds exactly that: true for the
 *  one caller that changed it (a notice is sent once, however many pods ask). */
export function markClaim(tenant: string, kind: MarkKind, key: string, data: unknown): boolean {
  const r = pgSyncOne(
    `INSERT INTO platform_marks (tenant, kind, key, data) VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (tenant, kind, key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
       WHERE platform_marks.data IS DISTINCT FROM EXCLUDED.data
     RETURNING 1 AS changed`,
    [tenant, kind, key, JSON.stringify(data)],
  );
  return r.rows.length > 0;
}

/** Insert only when the key has no row: true for the one caller that wrote it. */
export function markInsert(tenant: string, kind: MarkKind, key: string, data: unknown): boolean {
  if (failWrites) throw new Error("the database is not answering");
  const r = pgSyncOne(
    `INSERT INTO platform_marks (tenant, kind, key, data) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (tenant, kind, key) DO NOTHING RETURNING 1 AS made`,
    [tenant, kind, key, JSON.stringify(data)],
  );
  return r.rows.length > 0;
}

export function markDelete(tenant: string, kind: MarkKind, key: string): void {
  pgSyncOne("DELETE FROM platform_marks WHERE tenant = $1 AND kind = $2 AND key = $3", [tenant, kind, key]);
}

/** Every mark of a kind, for one account or (tenant null) all of them. */
export function markList<T>(tenant: string | null, kind: MarkKind): { tenant: string; key: string; data: T }[] {
  const r =
    tenant === null
      ? pgSyncOne("SELECT tenant, key, data FROM platform_marks WHERE kind = $1 ORDER BY tenant, key", [kind])
      : pgSyncOne("SELECT tenant, key, data FROM platform_marks WHERE tenant = $1 AND kind = $2 ORDER BY key", [tenant, kind]);
  return r.rows.map((x) => ({ tenant: x.tenant as string, key: x.key as string, data: x.data as T }));
}

/** An account is deleted: its marks go with it. */
export function deleteTenantMarks(tenant: string): void {
  if (marksInDatabase()) pgSyncOne("DELETE FROM platform_marks WHERE tenant = $1", [tenant]);
}
