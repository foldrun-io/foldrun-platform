// The vault's files against its rows, across every account (FOL-126 phase 6,
// retiring the file mirror): which scopes are only a file (never used since
// the switch, so never imported), which differ, which rows will not open.
// Nothing here prints or returns a value: counts, and `tenant/workspace`
// names of scopes. Used by scripts/vault-fleet.ts, in the worker pod.
//
//   verify  compare, read-only. `open`: also try every record with this
//           process's keys. `rowsAuthoritative` (after secrets.mirror went
//           off): files are expected to be stale, so a scope that differs
//           or has no file is fine; one with no ROW is still not.
//   import  copy each file-only scope into its row (the store's own first-use
//           import, under the file's lock, one row however many run at once).
//           A row that exists is never replaced by a file.
//   export  write each row into its file under the file's lock — the way back.

import fs from "node:fs";
import path from "node:path";
import { mutateVaultFile, readVaultFile, vaultFilePath, vaultFileScopes, vaultRecordOpens, type SecretsFile } from "../../foldrun-core/src/secrets.ts";
import { pgSyncOne } from "./pg-sync.ts";
import { pgVaultStore } from "./vault-pg.ts";

export interface ScopeRef {
  tenant: string;
  workspace?: string;
}
const label = (s: ScopeRef) => (s.workspace ? `${s.tenant}/${s.workspace}` : `${s.tenant}/(account)`);
const keyOf = (s: ScopeRef) => `${s.tenant}\u0000${s.workspace ?? ""}`;

/** JSON with every object's keys in order: two records are equal when their
 *  content is, not when their key order is (jsonb reorders). */
function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(",")}]`;
  if (x && typeof x === "object") return `{${Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(x);
}

/** `tenants`: only these accounts (all when absent). */
export interface FleetScope {
  tenants?: string[];
}

/** Every row, in batches, as scope + records. */
function* rows(only?: string[]): Generator<ScopeRef & { records: SecretsFile }> {
  let after: [string, string] | null = null;
  for (;;) {
    const r = (after
      ? pgSyncOne(`SELECT tenant, workspace, records FROM vault_scopes WHERE (tenant, workspace) > ($1, $2) AND ($3::text[] IS NULL OR tenant = ANY($3)) ORDER BY tenant, workspace LIMIT 200`, [...after, only ?? null])
      : pgSyncOne(`SELECT tenant, workspace, records FROM vault_scopes WHERE ($1::text[] IS NULL OR tenant = ANY($1)) ORDER BY tenant, workspace LIMIT 200`, [only ?? null])
    ).rows as { tenant: string; workspace: string; records: SecretsFile }[];
    if (!r.length) return;
    for (const x of r) yield { tenant: x.tenant, ...(x.workspace ? { workspace: x.workspace } : {}), records: x.records ?? {} };
    const last = r[r.length - 1];
    after = [last.tenant, last.workspace];
  }
}

export interface FleetReport {
  /** Scopes with a file and a row holding the same records. */
  equal: number;
  /** A file and no row: never imported. */
  fileOnly: string[];
  /** A row and no file. */
  rowOnly: string[];
  /** A file and a row that disagree. */
  differs: string[];
  /** `tenant/workspace/NAME` of every row record that does not open here (only with `open`). */
  unreadable: string[];
  scopes: number;
  records: number;
  /** Nothing that must be fixed before the next step (see the header). */
  clean: boolean;
}

export function verifyFleet(opts: FleetScope & { open?: boolean; rowsAuthoritative?: boolean } = {}): FleetReport {
  const files = new Map(vaultFileScopes().filter((s) => !opts.tenants || opts.tenants.includes(s.tenant)).map((s) => [keyOf(s), s]));
  const r: FleetReport = { equal: 0, fileOnly: [], rowOnly: [], differs: [], unreadable: [], scopes: 0, records: 0, clean: true };
  for (const row of rows(opts.tenants)) {
    r.scopes++;
    r.records += Object.keys(row.records).length;
    const file = files.get(keyOf(row));
    files.delete(keyOf(row));
    if (!file) r.rowOnly.push(label(row));
    else if (canonical(readVaultFile(vaultFilePath(row.tenant, row.workspace))) === canonical(row.records)) r.equal++;
    else r.differs.push(label(row));
    if (opts.open) for (const [name, rec] of Object.entries(row.records)) if (!vaultRecordOpens(row.tenant, row.workspace, name, rec)) r.unreadable.push(`${label(row)}/${name}`);
  }
  for (const s of files.values()) r.fileOnly.push(label(s));
  // A file with no records and no row is nothing to move.
  r.fileOnly = r.fileOnly.filter((l) => {
    const [tenant, rest] = [l.split("/")[0], l.split("/").slice(1).join("/")];
    return Object.keys(readVaultFile(vaultFilePath(tenant, rest === "(account)" ? undefined : rest))).length > 0;
  });
  r.fileOnly.sort();
  r.rowOnly.sort();
  r.differs.sort();
  r.clean = r.fileOnly.length === 0 && r.unreadable.length === 0 && (opts.rowsAuthoritative || (r.rowOnly.length === 0 && r.differs.length === 0));
  return r;
}

/** Import every file-only scope. Returns what was imported and what failed. */
export function importFileOnly(opts: FleetScope = {}): { imported: string[]; failed: string[] } {
  const store = pgVaultStore(() => true);
  const out = { imported: [] as string[], failed: [] as string[] };
  for (const l of verifyFleet({ tenants: opts.tenants }).fileOnly) {
    const [tenant, rest] = [l.split("/")[0], l.split("/").slice(1).join("/")];
    const workspace = rest === "(account)" ? undefined : rest;
    try {
      store.read(tenant, workspace); // the store's first-use import
      out.imported.push(l);
    } catch {
      out.failed.push(l);
    }
  }
  return out;
}

/** Write every row into its file under the file's lock — the row as it is
 *  WHEN the lock is held, not the list read before (a writer on another pod
 *  may have changed it since, and the mirror writes under the same lock).
 *  A workspace row whose folder is gone is skipped (writing would bring the
 *  folder back) and named. Turn `secrets.mirror` on BEFORE exporting: then
 *  every change after a scope's export also reaches its file (review, 13 Nov
 *  2026). */
export function exportFleet(opts: FleetScope = {}): { written: number; skipped: string[]; failed: string[] } {
  const out = { written: 0, skipped: [] as string[], failed: [] as string[] };
  for (const row of rows(opts.tenants)) {
    const file = vaultFilePath(row.tenant, row.workspace);
    if (row.workspace && !fs.existsSync(path.dirname(file))) {
      out.skipped.push(label(row));
      continue;
    }
    try {
      mutateVaultFile(file, () => {
        const now = pgSyncOne(`SELECT records FROM vault_scopes WHERE tenant = $1 AND workspace = $2`, [row.tenant, row.workspace ?? ""]).rows[0] as { records: SecretsFile } | undefined;
        return now?.records ?? row.records;
      });
      out.written++;
    } catch {
      out.failed.push(label(row));
    }
  }
  return out;
}
