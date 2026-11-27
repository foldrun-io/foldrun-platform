// One review per Idempotency-Key on POST /v1/foldrun/review (FOL-417).
//
// A laptop that lost the answer to a review sends it again with the same
// key: it gets the review it paid for, never a second model call and never a
// second charge. The same key for a different review is refused. A review
// still running answers "in progress" to a second caller; one stuck past
// STALE_MS (its gateway died, maybe after paying) is never taken over: the
// caller is told to use a new key. A review refused before the reviewer was
// paid leaves no row, so its retry runs again. Rows go after a day.
//
// Postgres when the platform has a database; a map in memory otherwise (one
// process, the tests).

import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { databaseEnabled, ormRequired } from "./db.ts";

const STALE_MS = 10 * 60_000;
const KEEP = "1 day";

export type Claim =
  | { kind: "new"; owner: string }
  | { kind: "replay"; result: unknown }
  | { kind: "conflict" }
  | { kind: "running" }
  /** Running past STALE_MS: its gateway may have died after paying for the
   *  review. Never taken over (that could buy it twice): the caller is told
   *  to use a new key, and pays again only by choosing to (Codex, FOL-417). */
  | { kind: "lost" };

type Row = { inputHash: string; owner: string; state: string; result: unknown; at: number };
const mem = new Map<string, Row>();
const memKey = (tenant: string, invocation: string) => `${tenant}\u0000${invocation}`;

/** Take the key for this review, or say what it already holds. */
export async function claimReview(tenant: string, invocation: string, inputHash: string, now = Date.now()): Promise<Claim> {
  const owner = crypto.randomUUID();
  if (!databaseEnabled()) {
    const k = memKey(tenant, invocation);
    for (const [key, r] of mem) if (now - r.at > 24 * 3600_000) mem.delete(key);
    const had = mem.get(k);
    if (had && had.inputHash !== inputHash) return { kind: "conflict" };
    if (had?.state === "done") return { kind: "replay", result: had.result };
    if (had) return now - had.at < STALE_MS ? { kind: "running" } : { kind: "lost" };
    mem.set(k, { inputHash, owner, state: "running", result: null, at: now });
    return { kind: "new", owner };
  }
  const db = ormRequired();
  await db.execute(sql`DELETE FROM review_calls WHERE created_at < now() - ${KEEP}::interval`);
  const took = await db.execute(sql`
    INSERT INTO review_calls (tenant, invocation, input_hash, owner, state)
    VALUES (${tenant}, ${invocation}, ${inputHash}, ${owner}, 'running')
    ON CONFLICT (tenant, invocation) DO NOTHING
    RETURNING tenant`);
  if (took.rows.length) return { kind: "new", owner };
  const r = await db.execute(sql`SELECT input_hash, state, result, created_at < now() - ${`${STALE_MS / 1000} seconds`}::interval AS stale FROM review_calls WHERE tenant = ${tenant} AND invocation = ${invocation}`);
  const row = r.rows[0] as { input_hash: string; state: string; result: unknown; stale: boolean } | undefined;
  if (!row) return claimReview(tenant, invocation, inputHash, now);
  if (row.input_hash !== inputHash) return { kind: "conflict" };
  if (row.state === "done") return { kind: "replay", result: row.result };
  return row.stale ? { kind: "lost" } : { kind: "running" };
}

/** The review is done: its answer is what a retry gets. Only the claim's own owner writes it. */
export async function finishReview(tenant: string, invocation: string, owner: string, result: unknown): Promise<void> {
  if (!databaseEnabled()) {
    const had = mem.get(memKey(tenant, invocation));
    if (had && had.owner === owner && had.state === "running") Object.assign(had, { state: "done", result });
    return;
  }
  await ormRequired().execute(sql`UPDATE review_calls SET state = 'done', result = ${JSON.stringify(result)}::jsonb WHERE tenant = ${tenant} AND invocation = ${invocation} AND owner = ${owner} AND state = 'running'`);
}

/** The review was refused before anything was paid: no row, so a retry runs it again. */
export async function forgetReview(tenant: string, invocation: string, owner: string): Promise<void> {
  if (!databaseEnabled()) {
    const k = memKey(tenant, invocation);
    if (mem.get(k)?.owner === owner && mem.get(k)?.state === "running") mem.delete(k);
    return;
  }
  await ormRequired().execute(sql`DELETE FROM review_calls WHERE tenant = ${tenant} AND invocation = ${invocation} AND owner = ${owner} AND state = 'running'`);
}

export function resetReviewCallsForTests(): void {
  mem.clear();
}
