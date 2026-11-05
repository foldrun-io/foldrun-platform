// The run's wide event in Postgres, its SLIs, and its ops trace (FOL-122).
//
// One row per run in `run_events` (schema.ts), built by core's pure
// run-event.ts from the run record and written at three moments:
//
//   1. the first enqueue — queued_at and queue_eligible_at, in the same
//      transaction as the run's job, so no claim can come before it;
//   2. the first claim — claimed_at (a claim can still be handed back:
//      scheduled_at, the record's drivenAt, is when driving began);
//   3. the end — everything the record says, at the places a run's
//      settlement already happens (the worker after a drive, reconcile,
//      a stop of a run nobody drives); the hourly sweep catches a run
//      that ended without it.
//
// The end write never touches the queue columns, and a row the end write
// creates (a run lined up before this existed) has none: unknown, not
// guessed. Nothing here throws into the queue: a failed write is logged and
// the run goes on.
//
// Without a database there is no row and no ops trace: the hosted platform
// always has Postgres, and a self-hosted install without one keeps working
// exactly as before (the pure builder still answers for one run).
//
// The SLIs (runSlis) come from these rows, over a window, and reach
// Grafana as gauges on /api/metrics (runEventMetricsText): the worker
// finishes runs and the web serves the scrape, so there is no in-process
// counter to keep — the rows are the counter. The operator console's Run
// health page (foldrun-admin, internal admin API runs.health / runs.event)
// reads runSlis, runSliBreakdown, listRunEvents and readRunEvent.
//
// The ops trace is OUR operations trace, not the account's `telemetry:`
// export (otel-export.ts): off unless FOLDRUN_OPS_OTLP_URL names a
// collector (the cluster's Alloy), sent once per run under a lease, retried
// by the sweep, and built from ops-log-shaped attributes only (core
// run-event.ts opsTrace).

import crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { readRun, type RunRecord } from "../../foldrun-core/src/store.ts";
import { ERROR_CLASSES, opsError, opsLog } from "../../foldrun-core/src/ops-log.ts";
import { opsTrace, runWideEvent, type RunWideEvent } from "../../foldrun-core/src/run-event.ts";
import { databaseEnabled, orm, type Db } from "./db.ts";
import { runEvents } from "./schema.ts";

const pk = (tenant: string, workspace: string, runId: string) =>
  and(eq(runEvents.tenant, tenant), eq(runEvents.workspace, workspace), eq(runEvents.runId, runId));
const ts = (s: string | null | undefined) => (s ? new Date(s) : null);

// ------------------------------------------------------------------ writes

/**
 * The first enqueue's facts, inside the caller's transaction (the one that
 * lines the job up). Under a savepoint: a refusal here rolls back only
 * this insert, never the job.
 */
export async function recordEnqueued(t: Db, job: { tenant: string; workspace: string; runId: string; notBefore?: string }): Promise<void> {
  try {
    await t.transaction(async (sp) => {
      await sp
        .insert(runEvents)
        .values({
          tenant: job.tenant,
          workspace: job.workspace,
          runId: job.runId,
          queuedAt: sql`now()`,
          queueEligibleAt: job.notBefore ? sql`GREATEST(now(), ${new Date(job.notBefore)}::timestamptz)` : sql`now()`,
        })
        .onConflictDoNothing();
    });
  } catch (err) {
    opsError("run_events.enqueue_write_failed", err, { runId: job.runId });
  }
}

/** The first claim. Idempotent; never throws. */
export async function recordClaimed(tenant: string, workspace: string, runId: string): Promise<void> {
  const q = orm();
  if (!q) return;
  try {
    await q
      .update(runEvents)
      .set({ claimedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(pk(tenant, workspace, runId), sql`${runEvents.claimedAt} IS NULL`));
  } catch (err) {
    opsError("run_events.claim_write_failed", err, { runId });
  }
}

/** The columns the record decides — everything but the queue's. */
function recordColumns(e: RunWideEvent) {
  return {
    flow: e.flow,
    kind: e.kind,
    test: e.test,
    status: e.status,
    errorClass: e.errorClass,
    failureKind: e.failureKind,
    failureScope: e.failureScope,
    slo: e.slo,
    sloReason: e.sloReason,
    rulesVersion: e.rulesVersion,
    image: e.image,
    model: e.model,
    size: e.size,
    submittedAt: ts(e.at.submitted),
    scheduledAt: ts(e.at.scheduled),
    podReadyAt: ts(e.at.podReady),
    sandboxUpAt: ts(e.at.sandboxUp),
    firstOutputAt: ts(e.at.firstOutput),
    earliestOutputAt: ts(e.earliestOutput),
    finishedAt: ts(e.at.finished),
    funnelStep: e.funnelStep,
    startup: e.startup,
    startupAt: ts(e.startupAt),
    origin: e.origin,
    steps: e.steps,
    sandboxedSteps: e.sandboxedSteps,
    attempts: e.attempts,
    costUsd: String(e.costUsd),
    computeSecs: e.computeSecs,
    startupSecs: e.startupSecs,
    cpuLimit: e.cpuLimit,
    cpuBusySecs: e.cpuBusySecs,
    cpuThrottledSecs: e.cpuThrottledSecs,
    memLimitGib: e.memLimitGiB,
    memPeakBytes: e.memPeakBytes === null ? null : Math.round(e.memPeakBytes),
    diskLimitGib: e.diskLimitGiB,
    diskUsedBytes: e.diskUsedBytes,
  };
}

const finishedStatus = (run: Pick<RunRecord, "status">) => run.status === "completed" || run.status === "failed";

/**
 * A run ended: its wide event, from the record. Safe to repeat — the row is
 * replaced from the same record, a sent trace stays sent. Never throws.
 */
export async function recordRunEnded(tenant: string, workspace: string, run: RunRecord): Promise<void> {
  const q = orm();
  if (!q || !databaseEnabled()) return;
  if (!finishedStatus(run)) return;
  try {
    const cols = recordColumns(runWideEvent(tenant, workspace, run));
    const traced = opsTraceUrl() !== null;
    await q
      .insert(runEvents)
      .values({ tenant, workspace, runId: run.id, ...cols, ...(traced ? { traceState: "pending" } : {}) })
      .onConflictDoUpdate({
        target: [runEvents.tenant, runEvents.workspace, runEvents.runId],
        set: {
          ...cols,
          updatedAt: sql`now()`,
          // Asked for once; a sent or abandoned trace keeps its state.
          ...(traced ? { traceState: sql`COALESCE(${runEvents.traceState}, 'pending')` } : {}),
        },
      });
    if (traced) void exportOpsTrace(tenant, workspace, run.id);
  } catch (err) {
    opsError("run_events.end_write_failed", err, { runId: run.id });
  }
}

/** One run's row, for a person debugging it (the operator console, psql). */
export async function readRunEvent(tenant: string, workspace: string, runId: string) {
  const q = orm();
  if (!q) return null;
  const [row] = await q.select().from(runEvents).where(pk(tenant, workspace, runId)).limit(1);
  return row ?? null;
}

// ------------------------------------------------------------- the sweep

/** How long an open row may sit untouched before the sweep reads its record. */
const OPEN_GRACE_MIN = 10;

/**
 * The hourly pass (queue.ts hourlyHousekeeping): rows whose run ended
 * without its end write are finished from the record, and traces still to
 * send are sent. Bounded per pass. Never throws.
 */
export async function sweepRunEvents(): Promise<{ finished: number; traced: number }> {
  const q = orm();
  const out = { finished: 0, traced: 0 };
  if (!q || !databaseEnabled()) return out;
  try {
    const open = await q
      .select({ tenant: runEvents.tenant, workspace: runEvents.workspace, runId: runEvents.runId })
      .from(runEvents)
      .where(sql`${runEvents.finishedAt} IS NULL AND ${runEvents.updatedAt} < now() - make_interval(mins => ${OPEN_GRACE_MIN})`)
      .orderBy(runEvents.updatedAt)
      .limit(500);
    for (const r of open) {
      let run: RunRecord | null = null;
      try {
        run = readRun(r.tenant, r.workspace, r.runId);
      } catch {
        run = null;
      }
      if (run && finishedStatus(run)) {
        await recordRunEnded(r.tenant, r.workspace, run);
        out.finished += 1;
      } else {
        // Still going (parked on a person, say) or its record is gone: to
        // the back of the line, so a pile of parked runs never keeps the
        // pass from the rows behind them.
        await q.update(runEvents).set({ updatedAt: sql`now()` }).where(pk(r.tenant, r.workspace, r.runId));
      }
    }
    if (opsTraceUrl()) {
      // A trace whose last try died with its sender (or whose settlement
      // failed) is pending with no tries left: retired, so it never holds a
      // place in the batch below (Codex review).
      await q
        .update(runEvents)
        .set({ traceState: "abandoned", traceClaim: null })
        .where(sql`${runEvents.traceState} = 'pending' AND ${runEvents.traceAttempts} >= ${MAX_TRACE_ATTEMPTS}
                   AND (${runEvents.traceClaimedAt} IS NULL OR ${runEvents.traceClaimedAt} < now() - make_interval(mins => ${LEASE_MIN}))`);
      const pending = await q
        .select({ tenant: runEvents.tenant, workspace: runEvents.workspace, runId: runEvents.runId })
        .from(runEvents)
        .where(sql`${runEvents.traceState} = 'pending' AND ${runEvents.traceAttempts} < ${MAX_TRACE_ATTEMPTS} AND (${runEvents.traceClaimedAt} IS NULL OR ${runEvents.traceClaimedAt} < now() - make_interval(mins => ${LEASE_MIN}))`)
        .limit(100);
      for (const r of pending) if ((await exportOpsTrace(r.tenant, r.workspace, r.runId)) === "sent") out.traced += 1;
    }
  } catch (err) {
    opsError("run_events.sweep_failed", err);
  }
  if (out.finished || out.traced) opsLog("info", "run_events.swept", { count: out.finished, tries: out.traced });
  return out;
}

/** Rows of runs that ended before the cutoff deleted, with run history
 *  (retention.ts). A row whose run has not ended goes only once its record
 *  is gone: run history keeps a live run however old, and so does this —
 *  a run parked past the window keeps its queue facts (Codex review). */
export async function pruneRunEvents(cutoff: number): Promise<number> {
  const q = orm();
  if (!q || !databaseEnabled()) return 0;
  const before = new Date(cutoff);
  try {
    const a = await q.delete(runEvents).where(sql`${runEvents.finishedAt} < ${before}`).returning({ id: runEvents.runId });
    const open = await q
      .select({ tenant: runEvents.tenant, workspace: runEvents.workspace, runId: runEvents.runId })
      .from(runEvents)
      .where(sql`${runEvents.finishedAt} IS NULL AND ${runEvents.createdAt} < ${before}`)
      .orderBy(runEvents.updatedAt)
      .limit(1000);
    let gone = 0;
    for (const r of open) {
      let exists = true;
      try {
        exists = readRun(r.tenant, r.workspace, r.runId) !== null;
      } catch {
        exists = true; // unreadable is not gone
      }
      if (exists) {
        // Kept: to the back of the line, so the next pass reaches the rows
        // behind it (Codex review).
        await q.update(runEvents).set({ updatedAt: sql`now()` }).where(pk(r.tenant, r.workspace, r.runId));
        continue;
      }
      gone += (await q.delete(runEvents).where(and(pk(r.tenant, r.workspace, r.runId), sql`${runEvents.finishedAt} IS NULL`)).returning({ id: runEvents.runId })).length;
    }
    return a.length + gone;
  } catch (err) {
    opsError("run_events.prune_failed", err);
    return 0;
  }
}

/** The account's rows, with the account (tenant-delete.ts). */
export async function deleteTenantRunEvents(tenant: string): Promise<number> {
  const q = orm();
  if (!q || !databaseEnabled()) return 0;
  return (await q.delete(runEvents).where(eq(runEvents.tenant, tenant)).returning({ id: runEvents.runId })).length;
}

// --------------------------------------------------------------- ops trace

/** How long one sender holds a trace before another may try it. */
const LEASE_MIN = 5;
/** Tries before a trace is given up on. */
const MAX_TRACE_ATTEMPTS = 5;
const TIMEOUT_MS = 10_000;

/** Where ops traces go (OTLP/HTTP, …/v1/traces), or null: off. */
export function opsTraceUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.FOLDRUN_OPS_OTLP_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** A row as the event opsTrace draws. */
function eventOfRow(r: typeof runEvents.$inferSelect): RunWideEvent {
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  const n = (v: number | null) => (typeof v === "number" ? v : null);
  return {
    runId: r.runId,
    tenant: r.tenant,
    workspace: r.workspace,
    flow: r.flow ?? "",
    kind: r.kind === "agent" ? "agent" : "flow",
    test: r.test,
    status: (r.status ?? "failed") as RunWideEvent["status"],
    errorClass: (ERROR_CLASSES as readonly string[]).includes(r.errorClass ?? "") ? (r.errorClass as RunWideEvent["errorClass"]) : null,
    failureKind: r.failureKind as RunWideEvent["failureKind"],
    failureScope: r.failureScope as RunWideEvent["failureScope"],
    slo: r.slo as RunWideEvent["slo"],
    sloReason: r.sloReason as RunWideEvent["sloReason"],
    rulesVersion: r.rulesVersion ?? 0,
    image: r.image === "full" || r.image === "slim" ? r.image : null,
    model: r.model,
    size: r.size,
    at: {
      submitted: iso(r.submittedAt),
      queued: iso(r.queuedAt),
      eligible: iso(r.queueEligibleAt),
      claimed: iso(r.claimedAt),
      scheduled: iso(r.scheduledAt),
      podReady: iso(r.podReadyAt),
      sandboxUp: iso(r.sandboxUpAt),
      firstOutput: iso(r.firstOutputAt),
      finished: iso(r.finishedAt),
    },
    earliestOutput: iso(r.earliestOutputAt),
    funnelStep: r.funnelStep,
    startup: (r.startup as Record<string, number> | null) ?? null,
    startupAt: iso(r.startupAt),
    origin: r.origin === "exact" || r.origin === "estimated" ? r.origin : null,
    steps: r.steps ?? 0,
    sandboxedSteps: r.sandboxedSteps ?? 0,
    attempts: r.attempts ?? 0,
    costUsd: Number(r.costUsd ?? 0),
    computeSecs: r.computeSecs ?? 0,
    startupSecs: n(r.startupSecs),
    cpuLimit: n(r.cpuLimit),
    cpuBusySecs: n(r.cpuBusySecs),
    cpuThrottledSecs: n(r.cpuThrottledSecs),
    memLimitGiB: n(r.memLimitGib),
    memPeakBytes: n(r.memPeakBytes),
    diskLimitGiB: n(r.diskLimitGib),
    diskUsedBytes: n(r.diskUsedBytes),
  };
}

/**
 * Send one run's ops trace, under a lease: claimed with a token (a try
 * counted), settled only by that token — `sent`, or back to `pending` for
 * the sweep after the lease, or `abandoned` after MAX_TRACE_ATTEMPTS. A
 * collector's answer is read for its status and its rejected-span count,
 * never logged. Never throws.
 */
export async function exportOpsTrace(tenant: string, workspace: string, runId: string): Promise<"sent" | "failed" | "skipped"> {
  const url = opsTraceUrl();
  const q = orm();
  if (!url || !q) return "skipped";
  const token = crypto.randomBytes(12).toString("hex");
  let rows: (typeof runEvents.$inferSelect)[];
  try {
    rows = await q
      .update(runEvents)
      .set({ traceClaim: token, traceClaimedAt: sql`now()`, traceAttempts: sql`${runEvents.traceAttempts} + 1` })
      .where(
        and(
          pk(tenant, workspace, runId),
          sql`${runEvents.traceState} = 'pending' AND ${runEvents.traceAttempts} < ${MAX_TRACE_ATTEMPTS}
              AND (${runEvents.traceClaimedAt} IS NULL OR ${runEvents.traceClaimedAt} < now() - make_interval(mins => ${LEASE_MIN}))`,
        ),
      )
      .returning();
  } catch (err) {
    opsError("ops_trace.claim_failed", err, { runId });
    return "failed";
  }
  const row = rows[0];
  if (!row) return "skipped";
  const settle = async (state: "sent" | "retry") => {
    const next = state === "sent" ? sql`'sent'` : sql`CASE WHEN ${runEvents.traceAttempts} >= ${MAX_TRACE_ATTEMPTS} THEN 'abandoned' ELSE 'pending' END`;
    await q
      .update(runEvents)
      // A failed try keeps its claim time: the next try waits out the lease.
      .set({ traceState: next, traceClaim: null })
      .where(and(pk(tenant, workspace, runId), eq(runEvents.traceClaim, token)))
      .catch((err) => opsError("ops_trace.settle_failed", err, { runId }));
  };
  const body = opsTrace(eventOfRow(row));
  if (!body) {
    await q.update(runEvents).set({ traceState: "abandoned", traceClaim: null }).where(and(pk(tenant, workspace, runId), eq(runEvents.traceClaim, token))).catch(() => {});
    return "skipped";
  }
  const spans = body.resourceSpans.reduce((n, r) => n + r.scopeSpans[0]!.spans.length, 0);
  try {
    const bearer = process.env.FOLDRUN_OPS_OTLP_TOKEN?.trim();
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      opsLog("warn", "ops_trace.refused", { runId, status: res.status, attempt: row.traceAttempts });
      await settle("retry");
      return "failed";
    }
    const answer = (await res.json().catch(() => null)) as { partialSuccess?: { rejectedSpans?: string | number } } | null;
    const rejected = Number(answer?.partialSuccess?.rejectedSpans ?? 0);
    if (rejected > 0) {
      // Some spans refused (a collector's filter, say): sent as far as it
      // goes — a resend would be refused the same way.
      opsLog("warn", "ops_trace.partial", { runId, count: rejected });
    }
    await settle("sent");
    return "sent";
  } catch (err) {
    opsError("ops_trace.send_failed", err, { runId, count: spans }, "warn");
    await settle("retry");
    return "failed";
  }
}

// -------------------------------------------------------------------- SLIs

/** Window rows: finished in the last `hours`, test runs left out — the
 *  population every SLI below is over (a window of 1 hour to 90 days). */
const windowOf = (hours: number) => sql`${runEvents.finishedAt} >= now() - make_interval(hours => ${hours}) AND NOT ${runEvents.test}`;
const hoursOf = (windowHours: number) => Math.max(1, Math.min(24 * 90, Math.floor(windowHours)));

export interface RunSlis {
  windowHours: number;
  /** Finished, non-test runs in the window by SLO outcome. */
  good: number;
  bad: number;
  excluded: number;
  /** good / (good + bad); null with no eligible run. */
  successRatio: number | null;
  /** eligible → scheduled, p95 and how many runs it is over. */
  queueWaitP95Secs: number | null;
  queueWaitObserved: number;
  /** pod ready → first output (the same step's), p95, how many runs it is
   *  over, and how many finished runs had a pod at all: the gap between the
   *  two is the runs whose pod never produced output. */
  readyToOutputP95Secs: number | null;
  readyToOutputObserved: number;
  sandboxed: number;
  /** Finished runs by status, SLO outcome and error class. */
  finished: { status: string; slo: string; errorClass: string; count: number }[];
}

/** The SLIs over the last `windowHours`, from the rows. Null without a
 *  database. Test runs are left out: a test run is the author's rehearsal. */
export async function runSlis(windowHours: number): Promise<RunSlis | null> {
  const q = orm();
  if (!q || !databaseEnabled()) return null;
  const hours = hoursOf(windowHours);
  const window = windowOf(hours);
  const [agg] = (await q.execute(sql`
    SELECT
      count(*) FILTER (WHERE slo = 'good')::int AS good,
      count(*) FILTER (WHERE slo = 'bad')::int AS bad,
      count(*) FILTER (WHERE slo = 'excluded')::int AS excluded,
      count(*) FILTER (WHERE scheduled_at >= queue_eligible_at)::int AS queue_n,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM scheduled_at - queue_eligible_at))
        FILTER (WHERE scheduled_at >= queue_eligible_at) AS queue_p95,
      count(*) FILTER (WHERE pod_ready_at IS NOT NULL)::int AS sandboxed,
      count(*) FILTER (WHERE first_output_at >= pod_ready_at)::int AS output_n,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM first_output_at - pod_ready_at))
        FILTER (WHERE first_output_at >= pod_ready_at) AS output_p95
    FROM run_events WHERE ${window}`)).rows as Record<string, unknown>[];
  const groups = (await q.execute(sql`
    SELECT status, slo, error_class, count(*)::int AS n
    FROM run_events WHERE ${window}
    GROUP BY status, slo, error_class`)).rows as { status: string | null; slo: string | null; error_class: string | null; n: number }[];
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const good = Number(agg?.good ?? 0);
  const bad = Number(agg?.bad ?? 0);
  return {
    windowHours: hours,
    good,
    bad,
    excluded: Number(agg?.excluded ?? 0),
    successRatio: good + bad > 0 ? good / (good + bad) : null,
    queueWaitP95Secs: num(agg?.queue_p95),
    queueWaitObserved: Number(agg?.queue_n ?? 0),
    readyToOutputP95Secs: num(agg?.output_p95),
    readyToOutputObserved: Number(agg?.output_n ?? 0),
    sandboxed: Number(agg?.sandboxed ?? 0),
    finished: groups.map((g) => ({ status: g.status ?? "unknown", slo: g.slo ?? "unknown", errorClass: g.error_class ?? "none", count: Number(g.n) })),
  };
}

/** The SLI window's runs that did not count as good, grouped: the operator
 *  console's breakdown of what went wrong, and whether each counted
 *  against the success rate (bad) or was the customer's own (excluded). */
export interface RunSliBreakdownRow {
  slo: string;
  sloReason: string;
  errorClass: string;
  failureKind: string;
  failureScope: string;
  /** The SLO rule that judged these rows (core SLO_RULES_VERSION). */
  rulesVersion: number;
  count: number;
}

/** The window's not-good runs by outcome, reason, class, kind and scope,
 *  largest first. Null without a database. */
export async function runSliBreakdown(windowHours: number): Promise<RunSliBreakdownRow[] | null> {
  const q = orm();
  if (!q || !databaseEnabled()) return null;
  const rows = (await q.execute(sql`
    SELECT slo, slo_reason, error_class, failure_kind, failure_scope, rules_version, count(*)::int AS n
    FROM run_events WHERE ${windowOf(hoursOf(windowHours))} AND slo IS DISTINCT FROM 'good'
    GROUP BY slo, slo_reason, error_class, failure_kind, failure_scope, rules_version
    ORDER BY n DESC, slo, slo_reason
    LIMIT 200`)).rows as { slo: string | null; slo_reason: string | null; error_class: string | null; failure_kind: string | null; failure_scope: string | null; rules_version: number | null; n: number }[];
  return rows.map((r) => ({
    slo: r.slo ?? "unknown",
    sloReason: r.slo_reason ?? "unknown",
    errorClass: r.error_class ?? "none",
    failureKind: r.failure_kind ?? "none",
    failureScope: r.failure_scope ?? "none",
    rulesVersion: Number(r.rules_version ?? 0),
    count: Number(r.n),
  }));
}

/** How a run list is ordered: newest finished first, or slowest first by
 *  queue wait, pod ready → first output, or submitted → finished. */
export const RUN_EVENT_SORTS = ["newest", "queue_wait", "ready_to_output", "duration"] as const;
export type RunEventSort = (typeof RUN_EVENT_SORTS)[number];

export interface RunEventListRow {
  tenant: string;
  workspace: string;
  runId: string;
  flow: string | null;
  kind: string | null;
  status: string | null;
  slo: string | null;
  sloReason: string | null;
  errorClass: string | null;
  failureKind: string | null;
  failureScope: string | null;
  image: string | null;
  model: string | null;
  size: string | null;
  submittedAt: Date | null;
  finishedAt: Date | null;
  /** The SLIs' own measures, null where the SLI would not count the run
   *  (no queue facts, no pod, no output — or two clocks out of order). */
  queueWaitSecs: number | null;
  readyToOutputSecs: number | null;
  durationSecs: number | null;
  costUsd: number;
  attempts: number;
}

/**
 * The window's runs, for a person looking for the bad ones: filtered by SLO
 * outcome, sorted newest or slowest first, at most `limit` (200). A slowest
 * sort lists only the runs its measure is defined for, so the list is the
 * population behind that p95. Null without a database. Identity, figures
 * and classes only — the table holds no prompt, reply or error text.
 */
export async function listRunEvents(o: { windowHours: number; slo?: "good" | "bad" | "excluded"; sort?: RunEventSort; limit?: number }): Promise<RunEventListRow[] | null> {
  const q = orm();
  if (!q || !databaseEnabled()) return null;
  const r = runEvents;
  const queueWait = sql`CASE WHEN ${r.scheduledAt} >= ${r.queueEligibleAt} THEN EXTRACT(EPOCH FROM ${r.scheduledAt} - ${r.queueEligibleAt}) END`;
  const readyToOutput = sql`CASE WHEN ${r.firstOutputAt} >= ${r.podReadyAt} THEN EXTRACT(EPOCH FROM ${r.firstOutputAt} - ${r.podReadyAt}) END`;
  const duration = sql`CASE WHEN ${r.finishedAt} >= ${r.submittedAt} THEN EXTRACT(EPOCH FROM ${r.finishedAt} - ${r.submittedAt}) END`;
  const sort = o.sort ?? "newest";
  const measure = sort === "queue_wait" ? queueWait : sort === "ready_to_output" ? readyToOutput : sort === "duration" ? duration : null;
  const where = [windowOf(hoursOf(o.windowHours))];
  if (o.slo) where.push(sql`${r.slo} = ${o.slo}`);
  if (measure) where.push(sql`${measure} IS NOT NULL`);
  const limit = Math.max(1, Math.min(200, Math.floor(o.limit ?? 50)));
  const secs = (s: ReturnType<typeof sql>) => sql<number | null>`${s}`.mapWith(Number);
  return q
    .select({
      tenant: r.tenant,
      workspace: r.workspace,
      runId: r.runId,
      flow: r.flow,
      kind: r.kind,
      status: r.status,
      slo: r.slo,
      sloReason: r.sloReason,
      errorClass: r.errorClass,
      failureKind: r.failureKind,
      failureScope: r.failureScope,
      image: r.image,
      model: r.model,
      size: r.size,
      submittedAt: r.submittedAt,
      finishedAt: r.finishedAt,
      queueWaitSecs: secs(queueWait),
      readyToOutputSecs: secs(readyToOutput),
      durationSecs: secs(duration),
      costUsd: sql<number>`COALESCE(${r.costUsd}, 0)`.mapWith(Number),
      attempts: sql<number>`COALESCE(${r.attempts}, 0)`.mapWith(Number),
    })
    .from(r)
    .where(and(...where))
    .orderBy(...(measure ? [sql`${measure} DESC`, sql`${r.finishedAt} DESC`] : [sql`${r.finishedAt} DESC`]))
    .limit(limit);
}

// ----------------------------------------------------------------- metrics

const WINDOWS = [
  ["1h", 1],
  ["24h", 24],
] as const;
const STATUSES = new Set(["completed", "failed"]);
const SLOS = new Set(["good", "bad", "excluded"]);
const CACHE_MS = 30_000;
let cached: { at: number; lines: string[] } | null = null;

/** Prometheus text for /api/metrics: the SLIs over fixed windows, as
 *  gauges (`…_window`: a window's value, never to be rate()d or summed over
 *  time). Every label value is from a closed set — window, status, SLO
 *  outcome, error class — never a run's or an account's (FOL-121, FOL-123).
 *  An empty population is NaN, not a perfect score. Every web replica
 *  answers the same numbers: aggregate with max(), not sum(). Cached for
 *  30 s per process. */
export async function runEventMetricsText(now = Date.now()): Promise<string[]> {
  if (cached && now - cached.at < CACHE_MS) return cached.lines;
  if (!databaseEnabled() || !orm()) return [];
  const g = (v: number | null) => (v === null || !Number.isFinite(v) ? "NaN" : String(Math.round(v * 1000) / 1000));
  const lines: string[] = [];
  const add = (name: string, help: string, rows: [string, string][]) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, ...rows.map(([labels, v]) => `${name}{${labels}} ${v}`));
  };
  let failed = 0;
  const per: [string, RunSlis][] = [];
  for (const [label, hours] of WINDOWS) {
    try {
      const s = await runSlis(hours);
      if (s) per.push([label, s]);
    } catch (err) {
      failed += 1;
      opsError("run_events.metrics_failed", err);
    }
  }
  const each = (f: (s: RunSlis) => string): [string, string][] => per.map(([w, s]) => [`window="${w}"`, f(s)]);
  add("foldrun_run_sli_success_ratio_window", "Finished runs that succeeded, of those that count: good / (good + bad); the customer's own code, settings and stops are excluded (core run-event.ts sloOutcome). NaN with none.", each((s) => g(s.successRatio)));
  add("foldrun_run_sli_eligible_window", "Finished runs that count toward the success ratio (good + bad).", each((s) => String(s.good + s.bad)));
  add("foldrun_run_queue_wait_p95_seconds_window", "p95 of queue wait: from when a run's first job could be claimed to when a worker began driving it. NaN with none.", each((s) => g(s.queueWaitP95Secs)));
  add("foldrun_run_queue_wait_observed_window", "Finished runs the queue wait p95 is over.", each((s) => String(s.queueWaitObserved)));
  add("foldrun_run_ready_to_output_p95_seconds_window", "p95 from the first sandbox's pod ready to its model's first output. NaN with none.", each((s) => g(s.readyToOutputP95Secs)));
  add("foldrun_run_ready_to_output_observed_window", "Finished runs the ready-to-output p95 is over.", each((s) => String(s.readyToOutputObserved)));
  add("foldrun_run_sandboxed_window", "Finished runs that had a pod: those above them never produced output.", each((s) => String(s.sandboxed)));
  const finished: [string, string][] = [];
  for (const [w, s] of per) {
    for (const f of s.finished) {
      const status = STATUSES.has(f.status) ? f.status : "unknown";
      const slo = SLOS.has(f.slo) ? f.slo : "unknown";
      const cls = (ERROR_CLASSES as readonly string[]).includes(f.errorClass) ? f.errorClass : f.errorClass === "none" ? "none" : "unknown";
      finished.push([`window="${w}",status="${status}",slo="${slo}",error_class="${cls}"`, String(f.count)]);
    }
  }
  add("foldrun_runs_finished_window", "Finished non-test runs in the window by status, SLO outcome and error class.", finished);
  lines.push(
    "# HELP foldrun_run_events_metrics_errors Windows whose run SLIs could not be read this scrape.",
    "# TYPE foldrun_run_events_metrics_errors gauge",
    `foldrun_run_events_metrics_errors ${failed}`,
  );
  cached = { at: now, lines };
  return lines;
}

/** For tests: forget the cached scrape. */
export function resetRunEventMetricsCache(): void {
  cached = null;
}
