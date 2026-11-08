// The blob sweeper's memory on Postgres (FOL-126): core blob-sweeper.ts
// SweepMarks over `blob_sweep_marks` and `blob_sweep_runs`. Every time is the
// database's own clock, so a pod with a drifting clock cannot make an object
// look old.

import type { Pool } from "pg";
import type { Mark, MarkKind, SweepMarks, SweepReport } from "../../foldrun-core/src/blob-sweeper.ts";
import { db } from "./db.ts";

export function pgSweepMarks(pool: () => Pool | null = db): SweepMarks {
  const p = (): Pool => {
    const x = pool();
    if (!x) throw new Error("the sweeper's marks need FOLDRUN_DATABASE_URL");
    return x;
  };
  return {
    async now() {
      return new Date((await p().query<{ t: Date }>(`SELECT now() AS t`)).rows[0].t);
    },
    async load(tenant, kind) {
      const r = await p().query<{ ref: string; size: string; first_seen: Date }>(`SELECT ref, size, first_seen FROM blob_sweep_marks WHERE tenant=$1 AND kind=$2`, [tenant, kind]);
      return new Map<string, Mark>(r.rows.map((x) => [x.ref, { firstSeen: new Date(x.first_seen), size: Number(x.size) }]));
    },
    async put(tenant, kind, entries, at) {
      for (let i = 0; i < entries.length; i += 500) {
        const slice = entries.slice(i, i + 500);
        await p().query(
          `INSERT INTO blob_sweep_marks (tenant, kind, ref, size, first_seen)
           SELECT $1, $2, ref, size, $5 FROM unnest($3::text[], $4::bigint[]) AS t(ref, size)
           ON CONFLICT DO NOTHING`,
          [tenant, kind as MarkKind, slice.map((e) => e.ref), slice.map((e) => e.size), at],
        );
      }
    },
    async clear(tenant, kind, refs) {
      for (let i = 0; i < refs.length; i += 1000) await p().query(`DELETE FROM blob_sweep_marks WHERE tenant=$1 AND kind=$2 AND ref = ANY($3::text[])`, [tenant, kind, refs.slice(i, i + 1000)]);
    },
    async lastRunAt() {
      const r = await p().query<{ at: Date }>(`SELECT max(at) AS at FROM blob_sweep_runs`);
      return r.rows[0]?.at ? new Date(r.rows[0].at) : null;
    },
    async recordRun(report: SweepReport) {
      await p().query(`INSERT INTO blob_sweep_runs (report) VALUES ($1::jsonb)`, [JSON.stringify(report)]);
      // the log is for people: the newest 200
      await p().query(`DELETE FROM blob_sweep_runs WHERE id < (SELECT coalesce(max(id), 0) - 200 FROM blob_sweep_runs)`);
    },
  };
}
