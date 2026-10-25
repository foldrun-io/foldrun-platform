// The ledger, in Postgres.
//
// Same entries, same meaning, same append-only discipline — what changes is
// that the balance can be computed inside a transaction. That is the property
// the file could not offer: assertFunds summed a file it had just read, so two
// runs admitted at the same moment could each be judged against the same
// untouched balance and both pass. The queue worked around it by counting
// admitted-but-unsettled jobs; the database makes the workaround unnecessary.
//
// And that ONCE is decided here. A run is one row by (tenant, run_id); every
// other once-only fact — a day's base fee, a pod's session, a plan's grant —
// carries a `key` that names it, and an insert that finds its key already
// there inserts nothing and says so. The file marker under the account
// directory stays as a fast path on one pod; across pods only the index can
// refuse the second write.
//
// The file remains the fallback for an install with no database, and remains
// the thing the backfill reads once. Nothing here deletes it.

import crypto from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import { orm, ormRequired, type Db } from "./db.ts";
import { ledger, type LedgerRow } from "./schema.ts";
import type { LedgerEntry } from "./ledger.ts";

type Cols = Pick<LedgerRow, "at" | "kind" | "usd" | "cost" | "workspace" | "runId" | "note" | "meter" | "key" | "split" | "flow" | "agents" | "waived" | "carriedUsd" | "reason">;

/** A row as the rest of the code already expects to see it. */
function toEntry(r: Cols): LedgerEntry {
  return {
    t: r.at.toISOString(),
    kind: r.kind as LedgerEntry["kind"],
    // NUMERIC comes back as a string, deliberately — it is exact and Number()
    // is the only place that decision gets made.
    usd: Number(r.usd),
    ...(r.cost === null ? {} : { cost: Number(r.cost) }),
    ...(r.meter ? { meter: r.meter as LedgerEntry["meter"] } : {}),
    ...(r.split ? { split: r.split as LedgerEntry["split"] } : {}),
    ...(r.carriedUsd === null ? {} : { carriedUsd: Number(r.carriedUsd) }),
    ...(r.waived ? { waived: r.waived as LedgerEntry["waived"] } : {}),
    ...(r.workspace ? { workspace: r.workspace } : {}),
    ...(r.runId ? { runId: r.runId } : {}),
    ...(r.flow ? { flow: r.flow } : {}),
    ...(r.agents ? { agents: r.agents as LedgerEntry["agents"] } : {}),
    ...(r.note ? { note: r.note } : {}),
    ...(r.key ? { key: r.key } : {}),
    ...(r.reason ? { reason: r.reason as LedgerEntry["reason"] } : {}),
  };
}

/**
 * The once-only handle of an entry. Its own `key` when the writer gave it
 * one; otherwise derived from what the line says — kind, instant, run,
 * note — exactly as 0002_ledger_keys derives it for rows written before
 * the column existed. The two derivations MUST agree: that agreement is
 * what makes importing the file history a no-op on every boot after the
 * first, instead of a second copy of every old line.
 */
export function entryKey(entry: LedgerEntry): string {
  if (entry.key) return entry.key;
  if (entry.kind === "run" && entry.runId) return `run:${entry.runId}`;
  const at = new Date(entry.t).toISOString();
  const note = crypto.createHash("md5").update(entry.note ?? "").digest("hex");
  return `row:${entry.kind}:${at}:${entry.runId ?? ""}:${note}`;
}

/**
 * Insert one entry, once. True when the row landed; false when a row with
 * the same run (for a charge) or the same key was already there — and then
 * the caller must not write it to the file either, or the two stores
 * disagree by exactly the double charge this exists to prevent.
 */
export async function appendDb(tenant: string, entry: LedgerEntry, on?: Db): Promise<boolean> {
  const q = on ?? ormRequired();
  const rows = await q
    .insert(ledger)
    .values({
      tenant,
      at: new Date(entry.t),
      kind: entry.kind,
      // numeric wants a string; a number would be re-parsed as a float.
      usd: entry.usd.toString(),
      cost: entry.cost === undefined ? null : entry.cost.toString(),
      workspace: entry.workspace ?? null,
      runId: entry.runId ?? null,
      note: entry.note ?? null,
      meter: entry.meter ?? null,
      key: entryKey(entry),
      split: entry.split ?? null,
      flow: entry.flow ?? null,
      agents: entry.agents ?? null,
      waived: entry.waived ?? null,
      carriedUsd: entry.carriedUsd === undefined ? null : entry.carriedUsd.toString(),
      reason: entry.reason ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: ledger.id });
  return rows.length > 0;
}

export async function readLedgerDb(tenant: string): Promise<LedgerEntry[]> {
  const q = orm();
  if (!q) return [];
  const rows = await q
    .select({
      at: ledger.at, kind: ledger.kind, usd: ledger.usd, cost: ledger.cost, workspace: ledger.workspace, runId: ledger.runId, note: ledger.note, meter: ledger.meter,
      key: ledger.key, split: ledger.split, flow: ledger.flow, agents: ledger.agents, waived: ledger.waived, carriedUsd: ledger.carriedUsd, reason: ledger.reason,
    })
    .from(ledger)
    .where(eq(ledger.tenant, tenant))
    .orderBy(asc(ledger.at), asc(ledger.id));
  return rows.map(toEntry);
}

/** Has this run been charged? The index is the authority; this is the
 *  read that lets a caller skip building the line at all. */
export async function runChargedDb(tenant: string, runId: string, on?: Db): Promise<boolean> {
  const q = on ?? orm();
  if (!q) return false;
  const rows = await q
    .select({ id: ledger.id })
    .from(ledger)
    .where(sql`${ledger.tenant} = ${tenant} AND ${ledger.runId} = ${runId} AND ${ledger.kind} = 'run'`)
    .limit(1);
  return rows.length > 0;
}

/**
 * What was charged for WORK since an instant: negative lines with a
 * workspace (the base fee and storage accruals carry none and are not
 * spend a customer can stop by running less). One workspace, or every
 * one. Runs on the transaction it is handed, so an admission gate reads
 * the same books it is about to write to.
 */
export async function windowSpendDb(tenant: string, workspace: string | null, since: Date, on?: Db): Promise<number> {
  const q = on ?? orm();
  if (!q) return 0;
  const [row] = await q
    .select({ sum: sql<string>`COALESCE(SUM(-${ledger.usd}), 0)::text` })
    .from(ledger)
    .where(
      workspace === null
        ? sql`${ledger.tenant} = ${tenant} AND ${ledger.usd} < 0 AND ${ledger.workspace} IS NOT NULL AND ${ledger.at} >= ${since}`
        : sql`${ledger.tenant} = ${tenant} AND ${ledger.usd} < 0 AND ${ledger.workspace} = ${workspace} AND ${ledger.at} >= ${since}`,
    );
  return Number(row?.sum ?? 0);
}

async function countDb(tenant: string): Promise<number> {
  const [row] = await ormRequired().select({ c: sql<string>`count(*)::text` }).from(ledger).where(eq(ledger.tenant, tenant));
  return Number(row?.c ?? 0);
}

/**
 * Copy a tenant's JSONL history in, once.
 *
 * Idempotent by the table's own unique indexes rather than by a flag we
 * would have to keep correct: re-running inserts nothing. Called at boot on
 * the worker, so an install that gains a database keeps its history instead
 * of appearing to start from zero — which, for a ledger, would read as every
 * customer's balance being wrong.
 */
export async function backfillLedger(tenant: string, fromFile: LedgerEntry[]): Promise<{ inserted: number }> {
  if (!orm() || fromFile.length === 0) return { inserted: 0 };
  const before = await countDb(tenant);
  for (const e of fromFile) await appendDb(tenant, e);
  const after = await countDb(tenant);
  return { inserted: after - before };
}
