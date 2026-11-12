// How long the platform keeps what (FOL-124, 5 Nov 2026).
//
// Two kinds of record, two periods, both operator settings:
//
//   · customer content — a run's record (its prompts, replies, tool input
//     and output, errors), its captured calls and its archived outputs:
//     `runs.retention_days` days after the run finished (unset/0: kept for ever; hosted: 90).
//     The customer deletes sooner themselves (`foldrun runs rm`, the run
//     page, the bulk delete). What a run wrote to storage/, memory/ or
//     state/ is the customer's own files, kept until they delete them.
//   · security evidence — the audit log (sign-ins, refusals, keys, roles,
//     secrets by name, deploys, the operator's own levers):
//     `audit.retention_days` days (unset/0: kept for ever; hosted: 365). On a database only: a
//     file-backed audit log (an install without Postgres) numbers its
//     entries by line, so it is kept until the account is deleted.
//
// The ledger — what was charged — is a financial record and is never
// pruned. The platform's own logs carry no customer content (ops-log.ts);
// their retention is the operations stack's.
//
// 0 keeps either for ever. Age is from when the run finished (an entry was
// written); the prune is the worker's daily pass, so a record goes on the
// first pass after its day, not at that second.

import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { deleteRun, listRunSummaries, listWorkspaces, readRun } from "../../foldrun-core/src/store.ts";
import { opsError, opsLog } from "../../foldrun-core/src/ops-log.ts";
import { databaseEnabled, orm } from "./db.ts";
import { listUnsettled } from "./settle.ts";
import { setting } from "./settings.ts";
import { markGet, markPut } from "./marks.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The setting's days as a cutoff instant, or null when it keeps for ever. */
function cutoffOf(key: string, now: number): number | null {
  const days = Number(setting(key));
  return Number.isFinite(days) && days > 0 ? now - days * DAY_MS : null;
}

/** Runs that finished before this are pruned, or null: kept for ever. */
export function runRetentionCutoff(now = Date.now()): number | null {
  return cutoffOf("runs.retention_days", now);
}

/** Audit entries written before this are pruned, or null: kept for ever. */
export function auditRetentionCutoff(now = Date.now()): number | null {
  return cutoffOf("audit.retention_days", now);
}

/**
 * One account's finished runs older than the window, deleted — record,
 * archived outputs and captured calls, the index noted. Policy, not a
 * person erasing history: no per-run ledger note, and the charges stand.
 * Live runs are never touched, and neither is a run whose charge is still
 * to be recorded (an unsettled marker): the record is what settles it.
 */
export function pruneRunHistory(tenant: string, cutoff: number): number {
  const unsettled = new Set(listUnsettled(tenant).map((u) => u.runId));
  let pruned = 0;
  for (const ws of listWorkspaces(tenant)) {
    for (const r of listRunSummaries(tenant, ws.name)) {
      if (r.status !== "completed" && r.status !== "failed") continue;
      if (!r.finishedAt || new Date(r.finishedAt).getTime() >= cutoff) continue;
      if (unsettled.has(r.id)) continue;
      // The index picked it; the record confirms it before it goes.
      const whole = readRun(tenant, ws.name, r.id);
      if (!whole || (whole.status !== "completed" && whole.status !== "failed") || !whole.finishedAt || new Date(whole.finishedAt).getTime() >= cutoff) continue;
      if (deleteRun(tenant, ws.name, r.id, { pruned: true })) pruned++;
    }
  }
  return pruned;
}

const AUDIT_MARK = () => path.join(dataRoot(), "operator", ".audit-pruned");

/**
 * The audit log's window, once a day for every row — the account's and the
 * platform's own (no tenant, or an account since deleted), which a pass
 * over the live accounts would never reach. Batched, so one day's backlog
 * cannot hold a lock for long; a day that failed is not marked and runs
 * again next hour.
 */
export async function pruneAuditLog(now = Date.now()): Promise<number | null> {
  const cutoff = auditRetentionCutoff(now);
  const q = orm();
  if (cutoff === null || !databaseEnabled() || !q) return null;
  const day = new Date(now).toISOString().slice(0, 10);
  try {
    if ((markGet<{ day: string }>("", "audit-pruned")?.day ?? fs.readFileSync(AUDIT_MARK(), "utf8").trim()) === day) return null;
  } catch {
    // never pruned on this install
  }
  const before = new Date(cutoff).toISOString();
  let total = 0;
  try {
    for (let i = 0; i < 100; i++) {
      const r = await q.execute(sql`DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE at < ${before}::timestamptz LIMIT 5000)`);
      const n = r.rowCount ?? 0;
      total += n;
      if (n < 5000) break;
    }
  } catch (err) {
    opsError("audit.prune_failed", err);
    return null;
  }
  // A database is certain here (above): the day is a row, seen by every pod.
  markPut("", "audit-pruned", "", { day });
  if (total) opsLog("info", "audit.pruned", { count: total });
  return total;
}
