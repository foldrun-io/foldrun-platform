// The revision journal in Postgres (FOL-126 phase 4).
//
// core's JournalStore (journal-store.ts) over the `revision_journal` table, so
// a change is written down BEFORE its commit without a file on the shared
// volume. The calls are synchronous like the journal's callers, so each is one
// statement through pg-sync.ts (the same bridge and the same 3 s deadline as
// the records).
//
// One row per entry, keyed by (tenant, workspace, entry id): putting an id
// that is there answers the existing row, so a step whose copy-back is applied
// twice is one entry. `aside` keeps a torn entry out of every later replay.
// Age is the database's clock (now() - created_at), the same clock for every
// pod, which is what "left by a process that died" is measured against.

import type { JournalRecord, JournalStore } from "../../foldrun-core/src/journal-store.ts";
import { pgSyncOne } from "./pg-sync.ts";

export function pgJournalStore(): JournalStore {
  return {
    kind: "database",
    put(rec) {
      pgSyncOne(
        `INSERT INTO revision_journal (tenant, workspace, entry_id, entry) VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (tenant, workspace, entry_id) DO NOTHING`,
        [rec.tenant, rec.workspace, rec.id, JSON.stringify(rec)],
      );
      return rec.id;
    },
    remove(tenant, workspace, handle) {
      pgSyncOne(`DELETE FROM revision_journal WHERE tenant = $1 AND workspace = $2 AND entry_id = $3`, [tenant, workspace, handle]);
    },
    workspaces() {
      return pgSyncOne(`SELECT DISTINCT tenant, workspace FROM revision_journal WHERE NOT aside`).rows.map((r) => ({ tenant: String(r.tenant), workspace: String(r.workspace) }));
    },
    entries(tenant, workspace) {
      return pgSyncOne(
        `SELECT entry_id, (extract(epoch FROM (now() - created_at)) * 1000)::float8 AS age_ms
           FROM revision_journal WHERE tenant = $1 AND workspace = $2 AND NOT aside ORDER BY seq`,
        [tenant, workspace],
      ).rows.map((r) => ({ handle: String(r.entry_id), ageMs: Number(r.age_ms) }));
    },
    read(tenant, workspace, handle) {
      const row = pgSyncOne(`SELECT entry FROM revision_journal WHERE tenant = $1 AND workspace = $2 AND entry_id = $3`, [tenant, workspace, handle]).rows[0];
      if (!row) throw new Error("the journal entry is gone");
      return row.entry as JournalRecord;
    },
    setAside(tenant, workspace, handle) {
      pgSyncOne(`UPDATE revision_journal SET aside = true WHERE tenant = $1 AND workspace = $2 AND entry_id = $3`, [tenant, workspace, handle]);
    },
    sweep() {
      // nothing is left half written in a table
    },
    drop(tenant, workspace) {
      if (workspace === undefined) pgSyncOne(`DELETE FROM revision_journal WHERE tenant = $1`, [tenant]);
      else pgSyncOne(`DELETE FROM revision_journal WHERE tenant = $1 AND workspace = $2`, [tenant, workspace]);
    },
  };
}
