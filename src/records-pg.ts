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
import { pgSync, pgSyncOne, RecordsTimeout, StaleFence, timeoutDefault, type Stmt, type Fenced } from "./pg-sync.ts";
import { withFencedLock } from "./fenced-lock.ts";
import { databaseEnabled, connectionConfig } from "./db.ts";
import { Pool } from "pg";
import { opsError } from "../../foldrun-core/src/ops-log.ts";
import { routeOf, routeForLifecycle, anyInDatabase } from "./records-routing.ts";
import { RUN_CHANNEL, RUN_NOTIFY_PAYLOAD_SQL } from "./run-notify.ts";

const KEEP_TRIGGER_EVENTS = 500;

/** Is this workspace served from its files? The routing every process shares
 *  (records-routing.ts) says so. Queue recovery asks it before it drops a job
 *  whose run it cannot read: when the routing cannot be read either, the
 *  answer is yes, so the job is kept. */
export function workspaceOnFiles(tenant: string, workspace: string): boolean {
  try {
    return routeOf(tenant, workspace) !== "database";
  } catch {
    return true;
  }
}

/** Does this process MOVE records into Postgres (the boot import)? A
 *  database, unless FOLDRUN_RECORDS=files. Either way, a process with a
 *  database registers the port and follows the shared routing
 *  (records-routing.ts): FOLDRUN_RECORDS=files no longer means "read the
 *  files" — a workspace another process moved is read and written as rows
 *  here too, or the two would part ways. It means "never start a move". */
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

/** The pool of the async reads: its own, so the deadline can be a property of
 *  the connection (statement_timeout) without touching what the shared pool's
 *  other users see. Small on purpose: reads are short. */
let readPool: Pool | null = null;
function reads(): Pool {
  if (!readPool) {
    readPool = new Pool({
      ...connectionConfig(),
      max: Number(process.env.FOLDRUN_RECORDS_POOL) || 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: timeoutDefault(),
      statement_timeout: timeoutDefault(),
      query_timeout: timeoutDefault() + 1_500,
    });
    readPool.on("error", (err) => opsError("db.idle_client_error", err));
  }
  return readPool;
}

/** Close the async reads' pool (tests, shutdown). */
export async function closeRecordsReads(): Promise<void> {
  const p = readPool;
  readPool = null;
  await p?.end().catch(() => {});
}

/** One read, the event loop free while it waits (the async half of the
 *  port). The server cancels the statement at the deadline and the client
 *  stops waiting a moment after; either is a RecordsTimeout, named in the ops
 *  log like the bridge's. */
async function ask(text: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
  if (!databaseEnabled()) throw new Error("no database");
  try {
    return await reads().query(text, values);
  } catch (err) {
    const m = err instanceof Error ? err.message : "";
    if (/statement timeout|Query read timeout|timeout exceeded when trying to connect/i.test(m)) {
      const t = new RecordsTimeout(timeoutDefault());
      opsError("db.records_timeout", t, { ms: t.ms, op: (text.trim().split(/\s+/)[0] ?? "").toLowerCase().replace(/[^a-z]/g, "") || "query" });
      throw t;
    }
    throw err;
  }
}

/** A write off the bridge (the async half of the port). Same statement and same
 *  deadline as pgSync's: the server cancels it at the deadline, so a write the
 *  caller gave up on cannot commit later. Under a lock (`held`) it runs in a
 *  transaction that first checks the lock's fence, exactly as the bridge does:
 *  a holder that was taken over while stalled is refused. */
async function write(text: string, values: unknown[]): Promise<void> {
  const fence = held.getStore();
  if (!fence) {
    await ask(text, values);
    return;
  }
  if (!databaseEnabled()) throw new Error("no database");
  let c;
  try {
    c = await reads().connect();
  } catch (err) {
    if (/timeout exceeded when trying to connect/i.test(err instanceof Error ? err.message : "")) throw new RecordsTimeout(timeoutDefault());
    throw err;
  }
  try {
    await c.query("BEGIN");
    try {
      const f = await c.query("SELECT token FROM lock_fences WHERE name = $1 FOR SHARE", [fence.name]);
      if (!f.rows[0] || Number(f.rows[0].token) !== fence.token) throw new StaleFence(fence.name);
      await c.query(text, values);
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    }
  } catch (err) {
    const m = err instanceof Error ? err.message : "";
    if (/statement timeout|Query read timeout/i.test(m)) {
      const t = new RecordsTimeout(timeoutDefault());
      opsError("db.records_timeout", t, { ms: t.ms, op: "insert" });
      throw t;
    }
    throw err;
  } finally {
    c.release();
  }
}

/**
 * A rename's routing (core renameWorkspace calls workspaceMove AFTER the
 * folder moved, and puts it back if this throws). Both names must route the
 * same way: a workspace on files renamed onto a name in the database would
 * have its files out of sight, and one in the database renamed onto a name
 * still on files would need that name switched while other processes may
 * still answer `files` for it — a switch only the import's barrier makes
 * safely. So until the move has reached both, such a rename is refused. The
 * old name's row stays either way: core moves the storage index after this
 * and asks the old name where it is. Its `legacy` mark goes with the rows.
 */
function moveRouting(tenant: string, from: string, to: string): void {
  if (from === to) return;
  const a = routeForLifecycle(tenant, from);
  const b = routeForLifecycle(tenant, to);
  if (a === b) {
    // Rows of an earlier release travel with the name (moveRows): so does
    // the mark that keeps a move from deleting them for having no file.
    if (a === "files") {
      pgSync(
        [
          {
            text: `INSERT INTO records_routing (tenant, workspace, state, legacy)
                   SELECT $1, $3, 'files', true WHERE EXISTS (SELECT 1 FROM records_routing WHERE tenant = $1 AND workspace = $2 AND legacy)
                   ON CONFLICT (tenant, workspace) DO UPDATE SET legacy = true WHERE records_routing.state = 'files'`,
            values: [tenant, from, to],
          },
        ],
        { fence: held.getStore() },
      );
    }
    return;
  }
  throw new Error(
    a === "files"
      ? `the records of ${from} are still on files and ${to} keeps its records in the database — rename it once the import has moved ${from}`
      : `${to} still keeps its records on files and ${from} keeps them in the database — rename it once the import has moved the rest`,
  );
}

// The write also announces itself (run-notify.ts): every copy of the platform
// watching this run (a live run page) is woken on commit instead of polling.
// Same statement, so a rolled-back write announces nothing.
const RUN_UPSERT = `WITH up AS (
         INSERT INTO run_records (tenant, workspace, run_id, flow, status, live, started_at, finished_at, summary, record, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, clock_timestamp())
         ON CONFLICT (tenant, workspace, run_id) DO UPDATE SET
           flow = EXCLUDED.flow, status = EXCLUDED.status, live = EXCLUDED.live,
           started_at = EXCLUDED.started_at, finished_at = EXCLUDED.finished_at,
           summary = EXCLUDED.summary, record = EXCLUDED.record, updated_at = clock_timestamp()
         RETURNING tenant, workspace, run_id)
       SELECT pg_notify('${RUN_CHANNEL}', ${RUN_NOTIFY_PAYLOAD_SQL}) FROM up`;
const runValues = (tenant: string, workspace: string, run: RunRecord, summary: RunSummary, live: boolean) => [
  tenant, workspace, run.id, run.flow ?? null, run.status, live, run.startedAt, run.finishedAt ?? null, JSON.stringify(summary), JSON.stringify(run),
];

/** The port. `routed: false` (tests of the port itself) puts every workspace
 *  in the database; otherwise the shared routing decides, and a call that
 *  cannot learn it throws rather than guess (records-routing.ts). */
export function pgRecords(opts: { routed?: boolean } = {}): RecordsPort {
  const routed = opts.routed !== false;
  return {
    onFiles: (tenant, workspace) => routed && routeOf(tenant, workspace) !== "database",
    // The hot reads, off the bridge: one run, the list, the live runs.
    async: {
      async runGet(tenant, workspace, id) {
        const r = await ask("SELECT record FROM run_records WHERE tenant = $1 AND workspace = $2 AND run_id = $3", [tenant, workspace, id]);
        return r.rows[0] ? asRun(r.rows[0].record) : null;
      },
      async runSummaries(tenant, workspace) {
        const r = await ask("SELECT summary FROM run_records WHERE tenant = $1 AND workspace = $2 ORDER BY started_at DESC, run_id DESC", [tenant, workspace]);
        return r.rows.map((x) => x.summary as RunSummary);
      },
      async runLive(tenant, workspace) {
        const r = await ask("SELECT record FROM run_records WHERE tenant = $1 AND workspace = $2 AND live ORDER BY started_at DESC, run_id DESC", [tenant, workspace]);
        return r.rows.map((x) => asRun(x.record));
      },
      async runPut(tenant, workspace, run, summary, live) {
        await write(RUN_UPSERT, runValues(tenant, workspace, run, summary, live));
      },
    },
    runPut(tenant, workspace, run, summary, live) {
      one(RUN_UPSERT, runValues(tenant, workspace, run, summary, live));
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
      // Nothing of this account is in the database: the list counts files.
      if (routed && !anyInDatabase(tenant)) return {};
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
    runsInContext(tenant, workspace, key, before, test, limit) {
      // FOL-162: one conversation's earlier turns, on run_records_context_idx.
      // The cutoff is the asking run's startedAt: started before it AND
      // finished no later — so every step of that run reads the same turns.
      const r = pgSyncOne(
        `SELECT record FROM run_records
          WHERE tenant = $1 AND workspace = $2 AND (summary -> 'context' ->> 'key') = $3
            AND status IN ('completed', 'failed') AND started_at < $4 AND finished_at IS NOT NULL AND finished_at <= $4
            AND COALESCE((summary ->> 'test')::boolean, false) = $5
          ORDER BY started_at DESC, run_id DESC LIMIT $6`,
        [tenant, workspace, key, before, test, limit],
      );
      return r.rows.map((x) => asRun(x.record));
    },
    openRunsOfCustomer(tenant, customer) {
      // FOL-168: an end customer's open runs across the account, on
      // run_records_customer_live_idx. `live` is queued, running or parked.
      const r = pgSyncOne("SELECT count(*)::int AS n FROM run_records WHERE tenant = $1 AND live AND (summary ->> 'customer') = $2", [tenant, customer]);
      return Number(r.rows[0]?.n ?? 0);
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
      // Not while its records are moving (refused at once, see
      // routeForLifecycle). The routing row stays: a workspace made again
      // under this name lives where this one did, so no process can hold an
      // answer for the name that is now wrong.
      if (routed) routeForLifecycle(tenant, workspace);
      pgSync(
        ["run_records", "trigger_events", "workspace_files"].map((table) => ({ text: `DELETE FROM ${table} WHERE tenant = $1 AND workspace = $2`, values: [tenant, workspace] })),
        { fence: held.getStore() },
      );
    },
    workspaceMove(tenant, from, to) {
      if (routed) moveRouting(tenant, from, to);
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
