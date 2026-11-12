// Run outputs' records on Postgres (FOL-126 phase 5): core run-outputs.ts
// RunOutputStore over `run_outputs`. One row per (account, workspace, run,
// agent): putting again replaces the manifest (a resumed run's second archive)
// and answers the row it replaced. Dropping a run, a workspace or an account
// also deletes the `blob_pins` those rows held, in the same transaction, so a
// record and its pin cannot disagree after a crash. Time is the database's.

import type { Pool } from "pg";
import type { RunOutputRecord, RunOutputStore } from "../../foldrun-core/src/run-outputs.ts";
import { db } from "./db.ts";
import { pgSyncOne } from "./pg-sync.ts";

const rowOf = (r: { tenant: string; workspace: string; run_id: string; agent: string; manifest: string; files: number; bytes: string; created_at: Date }): RunOutputRecord => ({
  tenant: r.tenant,
  workspace: r.workspace,
  runId: r.run_id,
  agent: r.agent,
  manifest: r.manifest,
  files: Number(r.files),
  bytes: Number(r.bytes),
  at: new Date(r.created_at).toISOString(),
});

/** The pin holders ids of these records (core outputsHolder), for the delete. */
const holderIds = (recs: readonly RunOutputRecord[]) => recs.map((r) => `outputs:${r.runId}:${r.agent}:${r.manifest.slice(0, 16)}`);

export function pgRunOutputStore(pool: () => Pool | null = db): RunOutputStore {
  const p = (): Pool => {
    const x = pool();
    if (!x) throw new Error("run outputs need FOLDRUN_DATABASE_URL");
    return x;
  };
  type Row = Parameters<typeof rowOf>[0];
  return {
    kind: "database",
    async put(rec) {
      const c = await p().connect();
      try {
        await c.query("BEGIN");
        // FOR UPDATE locks no row that does not exist yet: two first writers
        // of one (run, agent) would both read "nothing before" and the
        // overwritten manifest's pin would never be released (review, 12 Nov
        // 2026). The key's advisory lock serialises them, row or not.
        await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`run_outputs:${rec.tenant}:${rec.workspace}:${rec.runId}:${rec.agent}`]);
        const prev = (await c.query<Row>(`SELECT * FROM run_outputs WHERE tenant=$1 AND workspace=$2 AND run_id=$3 AND agent=$4 FOR UPDATE`, [rec.tenant, rec.workspace, rec.runId, rec.agent])).rows[0];
        await c.query(
          `INSERT INTO run_outputs (tenant, workspace, run_id, agent, manifest, files, bytes) VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (tenant, workspace, run_id, agent) DO UPDATE SET manifest = EXCLUDED.manifest, files = EXCLUDED.files, bytes = EXCLUDED.bytes, created_at = now()`,
          [rec.tenant, rec.workspace, rec.runId, rec.agent, rec.manifest, rec.files, rec.bytes],
        );
        await c.query("COMMIT");
        return prev ? rowOf(prev) : null;
      } catch (err) {
        await c.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        c.release();
      }
    },
    async list(tenant, workspace, runId) {
      const r = await p().query<Row>(`SELECT * FROM run_outputs WHERE tenant=$1 AND workspace=$2 AND run_id=$3 ORDER BY agent`, [tenant, workspace, runId]);
      return r.rows.map(rowOf);
    },
    async drop({ tenant, workspace, runId }) {
      const c = await p().connect();
      try {
        await c.query("BEGIN");
        const where = workspace === undefined ? `tenant=$1` : runId === undefined ? `tenant=$1 AND workspace=$2` : `tenant=$1 AND workspace=$2 AND run_id=$3`;
        const args = workspace === undefined ? [tenant] : runId === undefined ? [tenant, workspace] : [tenant, workspace, runId];
        const gone = (await c.query<Row>(`DELETE FROM run_outputs WHERE ${where} RETURNING *`, args)).rows.map(rowOf);
        // The pins go with the rows: a run's holder is its (run, agent, manifest).
        for (let i = 0; i < gone.length; i += 500) {
          await c.query(`DELETE FROM blob_pins WHERE tenant=$1 AND holder_kind='run' AND holder_id = ANY($2::text[])`, [tenant, holderIds(gone.slice(i, i + 500))]);
        }
        await c.query("COMMIT");
        return gone;
      } catch (err) {
        await c.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        c.release();
      }
    },
    bytes(tenant, workspace) {
      return Number(pgSyncOne(`SELECT coalesce(sum(bytes), 0) AS n FROM run_outputs WHERE tenant = $1 AND workspace = $2`, [tenant, workspace]).rows[0]?.n ?? 0);
    },
    async move(tenant, from, to) {
      const c = await p().connect();
      try {
        await c.query("BEGIN");
        // What `to` held belonged to a workspace that no longer exists; its pins go with it.
        const stale = (await c.query<Row>(`DELETE FROM run_outputs WHERE tenant=$1 AND workspace=$2 RETURNING *`, [tenant, to])).rows.map(rowOf);
        if (stale.length) await c.query(`DELETE FROM blob_pins WHERE tenant=$1 AND holder_kind='run' AND holder_id = ANY($2::text[])`, [tenant, holderIds(stale)]);
        await c.query(`UPDATE run_outputs SET workspace=$3 WHERE tenant=$1 AND workspace=$2`, [tenant, from, to]);
        await c.query("COMMIT");
      } catch (err) {
        await c.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        c.release();
      }
    },
  };
}
