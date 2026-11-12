// The vault in Postgres (FOL-126 phase 6): a scope's secrets — the
// account's, or one workspace's — as one row of the same sealed records its
// secrets.json held (core secrets.ts VaultStore). Nothing here opens a value.
//
// Which scopes: with `secrets.store` on, every scope. A scope that has no row
// yet is imported from its file the first time it is asked for — under the
// file's own lock, INSERT … ON CONFLICT DO NOTHING — so two pods importing at
// once end with one row, and a scope with neither file nor row starts empty.
//
// A read-change-write is a compare-and-set on the row's `gen`: read, change in
// this process, `UPDATE … WHERE gen = $read`. Another writer got in first: do
// it again with what is stored now, for up to ten seconds, then the vault's
// own "busy" error. One statement, so it is all or nothing.
//
// While files remain the fallback (until the contract release removes the
// volume), every committed change is also written to the scope's file, so
// switching `secrets.store` off — or rolling back to a release that only
// knows files — reads current secrets. A file written while the switch is
// off deletes the scope's row (forget), so switching on again imports the
// file as it then is. The mirror is best effort and says so when it fails.
//
// `secrets.mirror` off stops the mirror: a commit writes the row and nothing
// else, and the files go stale. Then the rows are the only current copy, so
// the store keeps serving while any row exists, whatever `secrets.store` says
// (`on()` below) — going back to the files starts with `vault-fleet.ts export`.

import fs from "node:fs";
import path from "node:path";
import { opsError, opsLog } from "../../foldrun-core/src/ops-log.ts";
import { lockFileExclusive, mutateVaultFile, readVaultFile, vaultFilePath, type SecretsFile, type VaultStore } from "../../foldrun-core/src/secrets.ts";
import { pgSyncOne } from "./pg-sync.ts";

const BUSY_MS = 10_000;
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const ws = (workspace?: string) => workspace ?? "";

type Row = { gen: string | number; records: SecretsFile };

function row(tenant: string, workspace?: string): Row | null {
  return (pgSyncOne(`SELECT gen, records FROM vault_scopes WHERE tenant = $1 AND workspace = $2`, [tenant, ws(workspace)]).rows[0] as Row | undefined) ?? null;
}

/** The scope's row, importing its file first when there is none yet. */
function ensure(tenant: string, workspace: string | undefined, create: boolean): Row {
  const have = row(tenant, workspace);
  if (have) return have;
  const file = vaultFilePath(tenant, workspace);
  let records: SecretsFile = {};
  if (fs.existsSync(file)) {
    // Under the file's lock: a file writer (an older pod, or this one before
    // the switch) finishes first, and what it wrote is what is imported.
    const release = lockFileExclusive(file);
    try {
      records = readVaultFile(file);
      pgSyncOne(`INSERT INTO vault_scopes (tenant, workspace, records) VALUES ($1, $2, $3::jsonb) ON CONFLICT DO NOTHING`, [tenant, ws(workspace), JSON.stringify(records)]);
    } finally {
      release();
    }
  } else if (!create) {
    // Nothing anywhere, and only a read: no row for a scope nobody wrote.
    return { gen: -1, records };
  } else {
    pgSyncOne(`INSERT INTO vault_scopes (tenant, workspace, records) VALUES ($1, $2, '{}'::jsonb) ON CONFLICT DO NOTHING`, [tenant, ws(workspace)]);
  }
  return row(tenant, workspace) ?? { gen: 0, records };
}

/** Keep the scope's file equal to its row (see the header). Never throws. */
function mirror(tenant: string, workspace: string | undefined, records: SecretsFile): void {
  try {
    const file = vaultFilePath(tenant, workspace);
    // Not for a workspace whose folder is gone (deleted meanwhile): writing
    // would bring the folder back.
    if (workspace && !fs.existsSync(path.dirname(file))) return;
    // The row as it is NOW, read under the file's lock: with two writers on
    // two pods, the one that committed first may get here last, and writing
    // its own snapshot would leave the file a step behind (review, 12 Nov
    // 2026). Whoever holds the lock writes the latest.
    mutateVaultFile(file, () => row(tenant, workspace)?.records ?? records);
  } catch (err) {
    opsError("vault.mirror_failed", err, { tenant, ...(workspace ? { workspace } : {}), outcome: "file_stale" }, "warn");
  }
}

const ROWS_TTL_MS = 5_000;
const HELD_LOG_MS = 60_000;

/** Is there any row at all? Asked at most every few seconds; a database that
 *  does not answer counts as yes (the safe side: the rows hold the secrets). */
function anyRow(cache: { at: number; has: boolean }): boolean {
  const now = Date.now();
  if (now - cache.at < ROWS_TTL_MS) return cache.has;
  try {
    cache.has = pgSyncOne(`SELECT 1 FROM vault_scopes LIMIT 1`).rows.length > 0;
  } catch {
    cache.has = true;
  }
  cache.at = now;
  return cache.has;
}

/** `serving`: is `secrets.store` on. `mirror`: do commits also write the file
 *  (default yes). */
export function pgVaultStore(serving: () => boolean, mirrored: () => boolean = () => true): VaultStore {
  const rows = { at: 0, has: false };
  let heldLogged = 0;
  const mirrorOn = () => {
    try {
      return mirrored();
    } catch {
      return true; // an unreadable setting is not a reason to let the files go stale
    }
  };
  return {
    on: () => {
      let wanted = false;
      try {
        wanted = serving();
      } catch {
        wanted = false;
      }
      if (wanted) return true;
      // Off, but the files are not being kept current: the rows are the only
      // copy that is, so they keep serving until `export` brings the files up.
      if (mirrorOn() || !anyRow(rows)) return false;
      if (Date.now() - heldLogged > HELD_LOG_MS) {
        heldLogged = Date.now();
        opsLog("warn", "vault.store_held_by_rows", { outcome: "store_off_mirror_off_rows_serve" });
      }
      return true;
    },
    read: (tenant, workspace) => ensure(tenant, workspace, false).records ?? {},
    mutate(tenant, workspace, change) {
      const deadline = Date.now() + BUSY_MS;
      for (;;) {
        const cur = ensure(tenant, workspace, true);
        const next = change(structuredClone(cur.records ?? {}));
        if (next === null) return cur.records ?? {};
        const done = pgSyncOne(`UPDATE vault_scopes SET records = $3::jsonb, gen = gen + 1, updated_at = now() WHERE tenant = $1 AND workspace = $2 AND gen = $4`, [tenant, ws(workspace), JSON.stringify(next), cur.gen]);
        if (done.rowCount > 0) {
          if (mirrorOn()) mirror(tenant, workspace, next);
          return next;
        }
        if (Date.now() > deadline) throw new Error("secrets.json is busy — another writer holds it; try again");
        sleep(15 + Math.floor(Math.random() * 25));
      }
    },
    workspaces: (tenant) => (pgSyncOne(`SELECT workspace FROM vault_scopes WHERE tenant = $1 AND workspace <> ''`, [tenant]).rows as { workspace: string }[]).map((r) => r.workspace),
    forget(tenant, workspace) {
      try {
        pgSyncOne(`DELETE FROM vault_scopes WHERE tenant = $1 AND workspace = $2`, [tenant, ws(workspace)]);
      } catch (err) {
        // The row would be read again once the switch is on: say so loudly.
        opsError("vault.forget_failed", err, { tenant, ...(workspace ? { workspace } : {}), outcome: "row_stale" });
        throw err;
      }
    },
  };
}
