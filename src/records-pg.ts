// Runs, the trigger log and the storage file index, in Postgres (FOL-126, phase 2).
//
// The implementation of core's RecordsPort (core src/records.ts) for an install
// with a database. Every call is one statement, or one small transaction, asked
// through pg-sync.ts so the synchronous callers in core keep their shape.
//
//   run_records     one row per run: the whole record (events included) and the
//                   row a list reads, with `live` marking queued/running/parked
//   trigger_events  one row per firing; the newest 500 per workspace are kept
//   workspace_files one row per storage/ path; two writers of different paths
//                   never touch each other's row
//   lock_fences     the fence a short lock hands out (fenced-lock.ts)
//
// Last write wins on a run, as the file did: one process drives one run.

import { AsyncLocalStorage } from "node:async_hooks";
import type { RecordsPort } from "../../foldrun-core/src/records.ts";
import type { RunRecord, RunSummary } from "../../foldrun-core/src/store.ts";
import type { TriggerEvent } from "../../foldrun-core/src/trigger-log.ts";
import type { FileRecord } from "../../foldrun-core/src/storage.ts";
import { pgSync, pgSyncOne, type Stmt, type Fenced } from "./pg-sync.ts";
import { withFencedLock } from "./fenced-lock.ts";
import { databaseEnabled } from "./db.ts";

const KEEP_TRIGGER_EVENTS = 500;

/** Do runs and the other records live in Postgres on this install? A database,
 *  unless FOLDRUN_RECORDS=files (the way back to the files). */
export function recordsInDatabase(): boolean {
  return databaseEnabled() && process.env.FOLDRUN_RECORDS !== "files";
}

/** The lock this async context holds, if any: writes made under it carry its fence. */
const held = new AsyncLocalStorage<Fenced>();

const one = (text: string, values: unknown[]) => pgSyncOne(text, values, { fence: held.getStore() });

function asRun(v: unknown): RunRecord {
  return v as RunRecord;
}

/** Rows of `from` become rows of `to`; what `to` already held (when `from` has rows) is dropped first. */
function moveRows(tables: string[], tenant: string, from: string, to: string): void {
  if (from === to) return;
  const stmts: Stmt[] = [];
  for (const table of tables) {
    // What a workspace of the new name once left is not this one's.
    stmts.push({ text: `DELETE FROM ${table} WHERE tenant = $1 AND workspace = $2 AND EXISTS (SELECT 1 FROM ${table} WHERE tenant = $1 AND workspace = $3)`, values: [tenant, to, from] });
    stmts.push({ text: `UPDATE ${table} SET workspace = $2 WHERE tenant = $1 AND workspace = $3`, values: [tenant, to, from] });
  }
  pgSync(stmts, { fence: held.getStore() });
}

export function pgRecords(): RecordsPort {
  return {
    runPut(tenant, workspace, run, summary, live) {
      one(
        `INSERT INTO run_records (tenant, workspace, run_id, flow, status, live, started_at, finished_at, summary, record, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, clock_timestamp())
         ON CONFLICT (tenant, workspace, run_id) DO UPDATE SET
           flow = EXCLUDED.flow, status = EXCLUDED.status, live = EXCLUDED.live,
           started_at = EXCLUDED.started_at, finished_at = EXCLUDED.finished_at,
           summary = EXCLUDED.summary, record = EXCLUDED.record, updated_at = clock_timestamp()`,
        [tenant, workspace, run.id, run.flow ?? null, run.status, live, run.startedAt, run.finishedAt ?? null, JSON.stringify(summary), JSON.stringify(run)],
      );
    },
    runGet(tenant, workspace, id) {
      const r = pgSyncOne("SELECT record FROM run_records WHERE tenant = $1 AND workspace = $2 AND run_id = $3", [tenant, workspace, id]);
      return r.rows[0] ? asRun(r.rows[0].record) : null;
    },
    runDelete(tenant, workspace, id) {
      return one("DELETE FROM run_records WHERE tenant = $1 AND workspace = $2 AND run_id = $3", [tenant, workspace, id]).rowCount > 0;
    },
    runSummaries(tenant, workspace) {
      const r = pgSyncOne("SELECT summary FROM run_records WHERE tenant = $1 AND workspace = $2 ORDER BY started_at DESC, run_id DESC", [tenant, workspace]);
      return r.rows.map((x) => x.summary as RunSummary);
    },
    runLive(tenant, workspace) {
      const r = pgSyncOne("SELECT record FROM run_records WHERE tenant = $1 AND workspace = $2 AND live ORDER BY started_at DESC, run_id DESC", [tenant, workspace]);
      return r.rows.map((x) => asRun(x.record));
    },
    runCount(tenant, workspace) {
      const r = pgSyncOne("SELECT count(*) AS n FROM run_records WHERE tenant = $1 AND workspace = $2", [tenant, workspace]);
      return Number(r.rows[0].n);
    },
    runCounts(tenant) {
      const r = pgSyncOne("SELECT workspace, count(*) AS n FROM run_records WHERE tenant = $1 GROUP BY workspace", [tenant]);
      return Object.fromEntries(r.rows.map((x) => [x.workspace as string, Number(x.n)]));
    },
    runAll(tenant, workspace) {
      const r = pgSyncOne("SELECT record FROM run_records WHERE tenant = $1 AND workspace = $2 ORDER BY started_at DESC, run_id DESC", [tenant, workspace]);
      return r.rows.map((x) => asRun(x.record));
    },
    runRecent(tenant, workspace, flow, limit) {
      const r = pgSyncOne("SELECT record FROM run_records WHERE tenant = $1 AND workspace = $2 AND flow = $3 ORDER BY started_at DESC, run_id DESC LIMIT $4", [tenant, workspace, flow, limit]);
      return r.rows.map((x) => asRun(x.record));
    },
    runsSince(tenant, workspace, sinceMs) {
      const r = pgSyncOne("SELECT record FROM run_records WHERE tenant = $1 AND workspace = $2 AND started_at >= $3 ORDER BY started_at DESC, run_id DESC", [tenant, workspace, new Date(sinceMs).toISOString()]);
      return r.rows.map((x) => asRun(x.record));
    },
    runStamp(tenant, workspace, id) {
      // Microseconds: two writes inside one millisecond still differ.
      const r = pgSyncOne("SELECT (extract(epoch from updated_at) * 1000000)::bigint AS us FROM run_records WHERE tenant = $1 AND workspace = $2 AND run_id = $3", [tenant, workspace, id]);
      return r.rows[0] ? Number(r.rows[0].us) : null;
    },

    triggerAppend(tenant, workspace, e: TriggerEvent) {
      const stmts: Stmt[] = [
        {
          text: `INSERT INTO trigger_events (tenant, workspace, t, flow, trigger, outcome, detail, run_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          values: [tenant, workspace, e.t, e.flow, e.trigger, e.outcome, e.detail ?? null, e.runId ?? null],
        },
        {
          text: `DELETE FROM trigger_events WHERE tenant = $1 AND workspace = $2
                 AND id < (SELECT id FROM trigger_events WHERE tenant = $1 AND workspace = $2 ORDER BY id DESC OFFSET $3 LIMIT 1)`,
          values: [tenant, workspace, KEEP_TRIGGER_EVENTS - 1],
        },
      ];
      pgSync(stmts, { fence: held.getStore() });
    },
    triggerRead(tenant, workspace, limit) {
      const r = pgSyncOne("SELECT t, flow, trigger, outcome, detail, run_id FROM trigger_events WHERE tenant = $1 AND workspace = $2 ORDER BY id DESC LIMIT $3", [tenant, workspace, limit]);
      return r.rows.map((x) => ({
        t: x.t as string,
        flow: x.flow as string,
        trigger: x.trigger as string,
        outcome: x.outcome as TriggerEvent["outcome"],
        ...(x.detail ? { detail: x.detail as string } : {}),
        ...(x.run_id ? { runId: x.run_id as string } : {}),
      }));
    },

    fileList(tenant, workspace) {
      const r = pgSyncOne(`SELECT path, sha, size, mime, updated_at, "by" FROM workspace_files WHERE tenant = $1 AND workspace = $2`, [tenant, workspace]);
      return r.rows.map((x) => ({
        path: x.path as string,
        sha: x.sha as string,
        size: Number(x.size),
        mime: x.mime as string,
        updatedAt: (x.updated_at as Date).toISOString(),
        by: x.by as string,
      }));
    },
    filePut(tenant, workspace, f: FileRecord) {
      one(
        `INSERT INTO workspace_files (tenant, workspace, path, sha, size, mime, updated_at, "by") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant, workspace, path) DO UPDATE SET sha = EXCLUDED.sha, size = EXCLUDED.size, mime = EXCLUDED.mime, updated_at = EXCLUDED.updated_at, "by" = EXCLUDED."by"`,
        [tenant, workspace, f.path, f.sha, f.size, f.mime, f.updatedAt, f.by],
      );
    },
    fileDelete(tenant, workspace, path) {
      return one("DELETE FROM workspace_files WHERE tenant = $1 AND workspace = $2 AND path = $3", [tenant, workspace, path]).rowCount > 0;
    },

    workspaceDrop(tenant, workspace) {
      pgSync(
        ["run_records", "trigger_events", "workspace_files"].map((table) => ({ text: `DELETE FROM ${table} WHERE tenant = $1 AND workspace = $2`, values: [tenant, workspace] })),
        { fence: held.getStore() },
      );
    },
    workspaceMove(tenant, from, to) {
      moveRows(["run_records", "trigger_events"], tenant, from, to);
    },
    fileMove(tenant, from, to) {
      moveRows(["workspace_files"], tenant, from, to);
    },

    async lock(name, fn) {
      try {
        return await withFencedLock(name, (fence) => held.run(fence, fn), 30_000);
      } catch (err) {
        if ((err as { code?: string }).code === "55P03") throw new Error("the file store is busy — try again in a moment");
        throw err;
      }
    },
  };
}

/** An account is deleted: every record this module keeps for it goes. */
export async function deleteTenantRecords(tenant: string): Promise<number> {
  const { ormRequired } = await import("./db.ts");
  const { sql } = await import("drizzle-orm");
  let n = 0;
  for (const table of ["run_records", "trigger_events", "workspace_files"]) {
    const r = await ormRequired().execute(sql`DELETE FROM ${sql.raw(table)} WHERE tenant = ${tenant}`);
    n += r.rowCount ?? 0;
  }
  return n;
}
