// The queue, in Postgres.
//
// Same job, same shape, same fairness. What changes is that a claim is a row
// lock rather than a rename, which is the difference between one worker and
// several: `rename()` is atomic on one filesystem and is not something to bet
// N workers on across a network one, whereas `FOR UPDATE SKIP LOCKED` is the
// primitive this problem was named after.
//
// FAIRNESS WITHOUT A WINDOW FUNCTION. `seq` is the job's position within its
// own account's pending jobs, assigned at insert. Ordering by (seq,
// enqueued_at) takes every account's oldest job before anyone's second — the
// same round-robin the file queue does — and it does it with a plain ORDER BY,
// which matters because Postgres refuses FOR UPDATE alongside a window
// function, and SKIP LOCKED is the entire reason to be here.
//
// The claim stays as one SQL statement, on purpose. It is the one query in
// the platform whose exact shape is the feature — the locking clause, the
// scalar subquery the cap needs, the ORDER BY the fairness needs — and an
// ORM's builder would either not express it or express it in a way that has
// to be checked against the SQL anyway. Drizzle's `sql` template keeps it
// typed at the edges and verbatim in the middle.

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { orm, ormRequired, tx, type Db } from "./db.ts";
import { queue } from "./schema.ts";

export interface QueueJobRow {
  tenant: string;
  workspace: string;
  runId: string;
  modelOverride?: string | null;
  tags?: string[];
  notBefore?: string;
  /** The account's own parallelism cap, when it has one; null lets the
   *  install's default apply at claim time. */
  accountCap?: number | null;
  /** Queue lane: account priority + flow priority (high 10, low -10). */
  priority?: number;
  /** The account's share when the fleet is contended: high 3, normal 2,
   *  low 1 (wallet.ts accountWeight). Null is normal. */
  accountWeight?: number | null;
}

interface ClaimedRow extends Record<string, unknown> {
  tenant: string;
  workspace: string;
  run_id: string;
  model_override: string | null;
  tags: unknown;
  not_before: Date | string | null;
}

function toJob(r: ClaimedRow): QueueJobRow {
  return {
    tenant: r.tenant,
    workspace: r.workspace,
    runId: r.run_id,
    ...(r.model_override ? { modelOverride: r.model_override } : {}),
    ...(Array.isArray(r.tags) && r.tags.length ? { tags: r.tags as string[] } : {}),
    ...(r.not_before ? { notBefore: new Date(r.not_before).toISOString() } : {}),
  };
}

/**
 * Add or replace a job for a run.
 *
 * Upsert, because re-enqueueing a run that is already waiting must not queue it
 * twice — the file queue got that by overwriting a filename, and here the
 * unique index says it outright. A re-enqueue keeps the account's ORIGINAL
 * position: a run that parks on a `wait:` and comes back should not lose its
 * place to everyone who arrived while it waited.
 */
export async function enqueueDb(job: QueueJobRow, on?: Db): Promise<void> {
  const q = on ?? ormRequired();
  await q
    .insert(queue)
    .values({
      runId: job.runId,
      tenant: job.tenant,
      workspace: job.workspace,
      modelOverride: job.modelOverride ?? null,
      tags: job.tags ?? [],
      notBefore: job.notBefore ? new Date(job.notBefore) : null,
      accountCap: job.accountCap ?? null,
      priority: job.priority ?? 0,
      accountWeight: job.accountWeight ?? null,
      // The next position among this account's pending jobs.
      seq: sql`COALESCE((SELECT MAX(${queue.seq}) FROM ${queue} WHERE ${queue.tenant} = ${job.tenant} AND ${queue.claimedAt} IS NULL), 0) + 1`,
    })
    .onConflictDoUpdate({
      target: queue.runId,
      set: {
        workspace: sql`excluded.workspace`,
        modelOverride: sql`excluded.model_override`,
        tags: sql`excluded.tags`,
        notBefore: sql`excluded.not_before`,
        accountCap: sql`excluded.account_cap`,
        priority: sql`excluded.priority`,
        accountWeight: sql`excluded.account_weight`,
        claimedAt: null,
        claimedBy: null,
        resumeRequested: false,
      },
    });
}

/**
 * Line a run up unless it already is — the enqueue for a new run and for a
 * resume alike. Three cases, and the middle one is why this exists:
 *
 * - no job: insert one.
 * - a job a worker has CLAIMED: flag it, and the worker's release puts it
 *   back instead of deleting it. An approval that lands while the worker
 *   that parked the run is still in its finally (or the runner's own
 *   resume, made from inside that drive) used to find the claimed row,
 *   decide the run was lined up, and do nothing — then the release deleted
 *   the row and the approved run sat with no job.
 * - a pending job: nothing; it will be claimed and read the record fresh.
 *
 * Insert-or-nothing, never the upsert: the upsert clears a claim, and a
 * row claimed between the flag and the insert belongs to a worker that is
 * about to read the record — which already carries whatever asked for this.
 */
export async function lineUpDb(job: QueueJobRow): Promise<"flagged" | "inserted" | "present"> {
  const q = ormRequired();
  const flagged = await q
    .update(queue)
    .set({ resumeRequested: true })
    .where(and(eq(queue.runId, job.runId), isNotNull(queue.claimedAt)))
    .returning({ id: queue.id });
  if (flagged.length) return "flagged";
  const inserted = await q
    .insert(queue)
    .values({
      runId: job.runId,
      tenant: job.tenant,
      workspace: job.workspace,
      modelOverride: job.modelOverride ?? null,
      tags: job.tags ?? [],
      notBefore: job.notBefore ? new Date(job.notBefore) : null,
      accountCap: job.accountCap ?? null,
      priority: job.priority ?? 0,
      accountWeight: job.accountWeight ?? null,
      seq: sql`COALESCE((SELECT MAX(${queue.seq}) FROM ${queue} WHERE ${queue.tenant} = ${job.tenant} AND ${queue.claimedAt} IS NULL), 0) + 1`,
    })
    .onConflictDoNothing({ target: queue.runId })
    .returning({ id: queue.id });
  return inserted.length ? "inserted" : "present";
}

/**
 * Take the next job, fairly, without two workers taking the same one.
 *
 * Fair is weighted round robin: a job's turn is (its account's claimed jobs
 * + its place in the account's own queue) / the account's weight — high 3,
 * normal 2, low 1 — lowest first, then priority, then arrival. So every
 * account's first job goes before anyone's second, a fast lane takes three
 * turns to a slow lane's one, and an account that has work running waits
 * behind one that has none. Priority used to come first outright, and a
 * fast-lane account with a queue of work took every slot that came free.
 * Counting claimed jobs alone (the first cut, 17 Oct) let an account whose
 * run had just finished outrank a slow lane's first run on priority; the
 * simulation (scripts/load-sim.ts) showed it, and the queue position fixed
 * it — in the simulation (100 accounts at one minute; a direction, not a
 * production timing), normal accounts' first run moved from p50 30 to 19
 * min. And a job ages: every whole AGING_SECS_PER_TURN it has waited counts
 * as one turn (whole, so jobs a moment apart still tie and priority decides), so a steady stream of other accounts' first jobs cannot hold an
 * account's third one back forever (reviewed with Codex, 17 Oct 2026). In a
 * burst every job ages alike and the order is the round robin's.
 *
 * SKIP LOCKED rather than a plain FOR UPDATE: a second worker steps over the
 * row a first has locked instead of blocking behind it, so N workers scale
 * rather than serialise. The `claimed_at IS NULL` in the outer UPDATE is
 * belt-and-braces against a row that changed between the subquery and the
 * write.
 *
 * How many runs one account may have claimed at once, across every worker:
 * the job's own account_cap, else the install's default; 0 is no cap. A row
 * whose account is at its cap is stepped over, so a tenant fanning a flow
 * out to a hundred sites takes its share of the fleet and no one else's turn.
 * The count comes from a WITH query, which the row lock does not reach (a
 * window function or GROUP BY in the locked query it forbids). Two workers
 * claiming for the same account in the same instant can both pass the count
 * and overshoot by one; bounded by the number of workers, and the exact
 * check at run start still holds.
 */
/** How long a job waits for its turn to count one more (claimNextDb). */
const AGING_SECS_PER_TURN = 600;

export async function claimNextDb(owner: string, defaultAccountCap = 0): Promise<QueueJobRow | null> {
  const q = orm();
  if (!q) return null;
  // Each account's claimed count, once per claim rather than once per
  // candidate row: a locking clause cannot sit on an aggregate, but it does
  // not reach into a WITH query either, so the count lives there and the
  // lock is FOR UPDATE OF q alone (postgresql.org/docs/current/sql-select.html,
  // The Locking Clause).
  const { rows } = await q.execute<ClaimedRow>(sql`
    WITH load AS (
      SELECT tenant, count(*)::int AS n FROM queue WHERE claimed_at IS NOT NULL GROUP BY tenant
    )
    UPDATE queue SET claimed_at = now(), claimed_by = ${owner}, resume_requested = false
     WHERE id = (
       SELECT q.id FROM queue q
         LEFT JOIN load l ON l.tenant = q.tenant
        WHERE q.claimed_at IS NULL
          AND (q.not_before IS NULL OR q.not_before <= now())
          AND (COALESCE(q.account_cap, ${defaultAccountCap}::int) <= 0 OR
               COALESCE(l.n, 0) < COALESCE(q.account_cap, ${defaultAccountCap}::int))
        ORDER BY (COALESCE(l.n, 0) + q.seq)::float8 / GREATEST(COALESCE(q.account_weight, 2), 1)
                   - FLOOR(EXTRACT(EPOCH FROM now() - q.enqueued_at) / ${AGING_SECS_PER_TURN}),
                 q.priority DESC, q.seq, q.enqueued_at, q.id
        FOR UPDATE OF q SKIP LOCKED
        LIMIT 1
     )
       AND claimed_at IS NULL
     RETURNING tenant, workspace, run_id, model_override, tags, not_before`);
  return rows[0] ? toJob(rows[0]) : null;
}

/**
 * The job is finished with — parked, completed or failed.
 *
 * Only a row that is still CLAIMED goes: a run that parked on a `wait:`
 * re-enqueues itself under the same run_id before the worker's finally
 * reaches here, and the upsert clears claimed_at. Deleting by run_id alone
 * took that resume job with it. And only OUR claim: between handBack's
 * upsert and the worker's finally another worker can legitimately claim the
 * row, and deleting it would leave a run being driven with nothing to
 * recover from.
 *
 * A claim flagged for a resume (lineUpDb) is put back instead: unclaimed,
 * in its old place. Row-locked first, so a flag set concurrently lands
 * either before the decision (and is honoured) or after the delete (and
 * finds no row, and inserts one).
 */
export async function releaseDb(runId: string, owner?: string): Promise<void> {
  if (!orm()) return;
  await tx(async (t) => {
    const mine = owner ? and(eq(queue.runId, runId), eq(queue.claimedBy, owner)) : and(eq(queue.runId, runId), isNotNull(queue.claimedAt));
    const [row] = await t.select({ id: queue.id, resume: queue.resumeRequested }).from(queue).where(mine).for("update");
    if (!row) return;
    if (row.resume) {
      await t.update(queue).set({ claimedAt: null, claimedBy: null, resumeRequested: false }).where(eq(queue.id, row.id));
      return;
    }
    await t.delete(queue).where(eq(queue.id, row.id));
  });
}

/**
 * Every run with a job in the queue — claimed (being driven) or pending (a
 * driver is a second away). What a reconcile on any pod must leave alone.
 */
export async function queuedRunIdsDb(): Promise<Set<string>> {
  const q = orm();
  if (!q) return new Set();
  const rows = await q.select({ runId: queue.runId }).from(queue);
  return new Set(rows.map((r) => r.runId));
}

/** Drop a run's job wherever it sits, for a stop. */
export async function removeDb(runId: string): Promise<boolean> {
  return (await takeJobDb(runId)) !== null;
}

/** Drop a run's job and say whether a worker had it claimed — null when
 *  there was no job. A stop asks, because a claimed run's worker settles it. */
export async function takeJobDb(runId: string): Promise<{ claimed: boolean } | null> {
  const q = orm();
  if (!q) return null;
  const gone = await q.delete(queue).where(eq(queue.runId, runId)).returning({ claimedAt: queue.claimedAt });
  return gone.length ? { claimed: gone[0].claimedAt !== null } : null;
}

/**
 * Hand back jobs whose worker died.
 *
 * A row carries when it was claimed, so a stale claim is recoverable at ANY
 * time — which is what lets a second worker pick up after a first is killed
 * rather than the run waiting for someone to restart the platform.
 */
export async function recoverStaleDb(olderThanMs: number): Promise<number> {
  const q = orm();
  if (!q) return 0;
  const ms = Math.max(1, Math.floor(olderThanMs));
  const rows = await q
    .update(queue)
    .set({ claimedAt: null, claimedBy: null })
    .where(and(isNotNull(queue.claimedAt), sql`${queue.claimedAt} < now() - (${ms}::bigint * interval '1 millisecond')`))
    .returning({ id: queue.id });
  return rows.length;
}

/** Every claimed job and who claimed it — for the dead-owner pass. */
export async function claimedRowsDb(): Promise<Array<{ runId: string; claimedBy: string | null }>> {
  const q = orm();
  if (!q) return [];
  return q
    .select({ runId: queue.runId, claimedBy: queue.claimedBy })
    .from(queue)
    .where(isNotNull(queue.claimedAt));
}

/** Hand one claim back to the queue, if it is still held by `owner`: the
 *  next claimNext takes it. Owner-checked so a pass that decided on a stale
 *  read cannot un-claim a job a live worker re-claimed in between. */
export async function handBackDb(runId: string, owner: string): Promise<boolean> {
  const q = orm();
  if (!q) return false;
  const rows = await q
    .update(queue)
    .set({ claimedAt: null, claimedBy: null })
    .where(and(eq(queue.runId, runId), eq(queue.claimedBy, owner)))
    .returning({ id: queue.id });
  return rows.length > 0;
}

/** Renew a claim, so a long run is not mistaken for an abandoned one. */
export async function touchClaimDb(runId: string, owner: string): Promise<void> {
  const q = orm();
  if (!q) return;
  await q
    .update(queue)
    .set({ claimedAt: sql`now()` })
    .where(and(eq(queue.runId, runId), eq(queue.claimedBy, owner)));
}

export async function statsDb(): Promise<{
  pending: number;
  scheduledAhead: number;
  claimed: number;
  oldestPendingSecs: number | null;
}> {
  const q = orm();
  if (!q) return { pending: 0, scheduledAhead: 0, claimed: 0, oldestPendingSecs: null };
  const ready = sql`${queue.claimedAt} IS NULL AND (${queue.notBefore} IS NULL OR ${queue.notBefore} <= now())`;
  const [r] = await q
    .select({
      pending: sql<string>`count(*) FILTER (WHERE ${ready})::text`,
      scheduled: sql<string>`count(*) FILTER (WHERE ${queue.claimedAt} IS NULL AND ${queue.notBefore} > now())::text`,
      claimed: sql<string>`count(*) FILTER (WHERE ${queue.claimedAt} IS NOT NULL)::text`,
      oldest: sql<string | null>`EXTRACT(EPOCH FROM (now() - MIN(${queue.enqueuedAt}) FILTER (WHERE ${ready})))::text`,
    })
    .from(queue);
  return {
    pending: Number(r.pending),
    scheduledAhead: Number(r.scheduled),
    claimed: Number(r.claimed),
    oldestPendingSecs: r.oldest === null ? null : Math.max(0, Math.round(Number(r.oldest))),
  };
}

/** Jobs an account has admitted but not settled — what assertFunds counts. */
export async function inFlightDb(tenant: string): Promise<number> {
  const q = orm();
  if (!q) return 0;
  const [r] = await q.select({ c: sql<string>`count(*)::text` }).from(queue).where(eq(queue.tenant, tenant));
  return Number(r.c);
}

/** How many of an account's runs are claimed — being driven — right now,
 *  across every worker, not counting one run (the caller's own claim). The
 *  cap check at run start used to read every run file of the account for
 *  this number on every claim. */
export async function claimedCountDb(tenant: string, exceptRunId: string): Promise<number> {
  const q = orm();
  if (!q) return 0;
  const [r] = await q
    .select({ c: sql<string>`count(*)::text` })
    .from(queue)
    .where(and(eq(queue.tenant, tenant), isNotNull(queue.claimedAt), sql`${queue.runId} <> ${exceptRunId}`));
  return Number(r.c);
}

/** Is there a job for this run, claimed or not? */
export async function hasJobDb(runId: string): Promise<boolean> {
  const q = orm();
  if (!q) return false;
  const rows = await q.select({ id: queue.id }).from(queue).where(eq(queue.runId, runId)).limit(1);
  return rows.length > 0;
}

