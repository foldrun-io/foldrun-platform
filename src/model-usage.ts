// The record of every call made on the platform's model keys ("foldrun's
// models"), and the daily cap that reads it.
//
// The model gateway (model-gateway.ts) writes a row BEFORE it forwards a
// call — `open`, holding the call's estimate — and closes it with what the
// provider reported. So:
//   - a crash or a cut stream still leaves the call charged (at its
//     estimate), never free;
//   - the cap sums settled costs and open estimates together under the
//     account's own advisory lock, so twenty calls at once cannot all pass
//     a cap with room for one. What can overshoot is only what a call
//     reports past its own estimate, and the estimate holds its max_tokens.
//
// Rows are settled into the ledger by id (model-settle in the hosted build);
// nothing here charges money.
//
// Without a database (tests, a self-host) the rows live in one file under
// the data root, serialised in this process.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { databaseEnabled, ormRequired, tx, type Db } from "./db.ts";
import { modelUsage } from "./schema.ts";

/** Dollars as a person reads them: cents, or more places under a cent
 *  (a $0.004 cap read "$0.00 of $0.00"). */
const usdText = (n: number) => `$${n === 0 || n >= 0.01 ? n.toFixed(2) : n.toFixed(4)}`;

export type UsageKind = "run" | "grade" | "judge" | "draft" | "assistant" | "coding";

export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelUsageRow {
  id: string;
  tenant: string;
  day: string;
  kind: UsageKind;
  runId: string | null;
  step: number | null;
  job: string | null;
  provider: string;
  model: string;
  tokens: UsageTokens;
  costUsd: number;
  status: "open" | "closed" | "estimated";
  priceVersion: number;
  createdAt: string;
  closedAt: string | null;
  settledKey: string | null;
  /** When it was claimed for its ledger line. */
  settledAt?: string | null;
  /** The margin in force when it was held: charged at costUsd × margin.
   *  Null on rows from before 10 Nov 2026 (charged at the margin when settled). */
  margin?: number | null;
}

export interface OpenCall {
  tenant: string;
  kind: UsageKind;
  runId?: string | null;
  step?: number | null;
  job?: string | null;
  provider: string;
  model: string;
  estimateUsd: number;
  priceVersion: number;
  /** The margin in force now (what a dollar of the price list is charged
   *  as), kept on the row so a later margin change re-prices nothing. */
  margin?: number;
  /** The job's own limits (a gateway key's), in dollars CHARGED: held on
   *  the key's own counters (model_spend) in the same transaction as the
   *  account's day, each call at its own margin, so calls at once cannot
   *  pass them together. */
  jobLimits?: { capUsd: number | null; dailyUsd: number | null };
}

export type Reserved = { ok: true; id: string } | { ok: false; reason: string; spentUsd: number; capUsd: number };

export const dayOf = (at: Date) => at.toISOString().slice(0, 10);
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const ZERO: UsageTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Hold one call's estimate against the account's day, or refuse it when
 *  the cap (USD; 0 = none) has no room for it. */
export async function reserveCall(call: OpenCall, capUsd: number, now = new Date()): Promise<Reserved> {
  const id = `mu_${crypto.randomBytes(12).toString("hex")}`;
  const day = dayOf(now);
  const row: ModelUsageRow = {
    id,
    tenant: call.tenant,
    day,
    kind: call.kind,
    runId: call.runId ?? null,
    step: call.step ?? null,
    job: call.job ?? null,
    provider: call.provider,
    model: call.model,
    tokens: { ...ZERO },
    costUsd: round6(call.estimateUsd),
    status: "open",
    priceVersion: call.priceVersion,
    createdAt: now.toISOString(),
    closedAt: null,
    settledKey: null,
    margin: call.margin ?? null,
  };
  // What this call is held at, charged.
  const heldCharge = row.costUsd * (call.margin ?? 1);
  const refuse = (spent: number): Reserved => ({
    ok: false,
    spentUsd: round6(spent),
    capUsd,
    reason: `this account's daily limit on foldrun's models is reached (${usdText(spent)} of ${usdText(capUsd)} today, UTC) — it resets at 00:00 UTC; the operator can raise it`,
  });
  const keyFull = (spent: number, cap: number): Reserved => ({ ok: false, spentUsd: round6(spent), capUsd: cap, reason: "this key's spending limit has no room for this call (each call is held at the most it could cost) — raise it or mint a new key" });
  const keyDayFull = (spent: number, cap: number): Reserved => ({ ok: false, spentUsd: round6(spent), capUsd: cap, reason: "this key's daily limit has no room for this call today (each call is held at the most it could cost) — it resets at 00:00 UTC" });
  const jobRefusal = (total: number, today: number): Reserved | null => {
    const l = call.jobLimits;
    if (!l) return null;
    if (l.capUsd !== null && total + heldCharge > l.capUsd) return keyFull(total, l.capUsd);
    if (l.dailyUsd !== null && today + heldCharge > l.dailyUsd) return keyDayFull(today, l.dailyUsd);
    return null;
  };
  if (databaseEnabled()) {
    // Running totals (model_spend, 10 Nov 2026): each limit is one
    // conditional UPDATE of its row, in the same transaction as this call's
    // model_usage row — no sum over the day, no lock over the account.
    // Counters are taken in one order (the day, the key, the key's day), so
    // two calls never wait on each other in a circle.
    const margin = call.margin ?? 1;
    const job = call.jobLimits && row.job ? row.job : null;
    const scopes: { scope: string; add: number; cap: number | null; full: (spent: number, cap: number) => Reserved }[] = [
      { scope: `day:${day}`, add: row.costUsd, cap: capUsd > 0 ? capUsd : null, full: (spent) => refuse(spent) },
    ];
    if (job) {
      scopes.push({ scope: `job:${job}`, add: round6(heldCharge), cap: call.jobLimits!.capUsd, full: keyFull });
      scopes.push({ scope: `jobday:${job}:${day}`, add: round6(heldCharge), cap: call.jobLimits!.dailyUsd, full: keyDayFull });
    }
    // A counter not made yet is filled in a transaction of its own
    // (fillCounters), holding no counter row, then the hold is tried again.
    // A guard-cleared counter can go missing again in between; a few rounds
    // settle it, and a call that still finds none is refused, never let by.
    for (let round = 0; ; round++) {
      const got = await holdCall(call.tenant, scopes, (t) =>
        t.insert(modelUsage).values({
          id,
          tenant: row.tenant,
          day,
          kind: row.kind,
          runId: row.runId,
          step: row.step,
          job: row.job,
          provider: row.provider,
          model: row.model,
          costUsd: row.costUsd.toFixed(6),
          status: "open",
          priceVersion: row.priceVersion,
          createdAt: now,
          // A key's hold is taken at a margin, so its row keeps that margin:
          // its close moves the key's counters at the same one (Codex).
          margin: call.margin !== undefined || job ? margin.toFixed(6) : null,
        }),
      );
      if (got === "ok") return { ok: true as const, id };
      if (typeof got !== "string") return got;
      if (round >= 3) return { ok: false, spentUsd: 0, capUsd, reason: "foldrun's models: this account's spend is being recounted — try the call again in a moment" };
      await fillCounters(call.tenant, scopes.map((sc) => sc.scope), day, job, margin);
    }
  }
  return fileLocked(() => {
    const rows = readFile();
    const spent = rows.filter((x) => x.tenant === call.tenant && x.day === day).reduce((n, x) => n + x.costUsd, 0);
    if (capUsd > 0 && spent + row.costUsd > capUsd) return refuse(spent);
    if (call.jobLimits && row.job) {
      const mine = rows.filter((x) => x.tenant === call.tenant && x.job === row.job);
      const charged = (x: ModelUsageRow) => x.costUsd * (x.margin ?? call.margin ?? 1);
      const refused = jobRefusal(mine.reduce((n, x) => n + charged(x), 0), mine.filter((x) => x.day === day).reduce((n, x) => n + charged(x), 0));
      if (refused) return refused;
    }
    rows.push(row);
    writeFile(rows);
    return { ok: true as const, id };
  });
}

/** Close a call with what it cost. `estimated` when no usage came back:
 *  the estimate it held stands as the charge. */
export async function closeCall(id: string, outcome: { tokens: UsageTokens; costUsd: number } | { estimated: true }, now = new Date()): Promise<void> {
  if (databaseEnabled()) {
    await closeCallDb(id, outcome, now);
    return;
  }
  await fileLocked(() => {
    const rows = readFile();
    // A row already charged is final: a call that closes after its estimate
    // was settled does not move the cost the ledger holds (Codex review).
    const r = rows.find((x) => x.id === id && x.status === "open" && x.settledKey === null);
    if (!r) return;
    r.closedAt = now.toISOString();
    if ("estimated" in outcome) r.status = "estimated";
    else {
      r.status = "closed";
      r.tokens = { ...outcome.tokens };
      r.costUsd = round6(outcome.costUsd);
    }
    writeFile(rows);
  });
}

/** Close the row, and move its counters (model_spend) from the hold to what
 *  it cost, in one transaction: the counter of the day the call was held,
 *  and a gateway key's counters at the row's own margin. A row already
 *  closed or settled changes nothing — the hold stands as the charge. */
async function closeCallDb(id: string, outcome: { tokens: UsageTokens; costUsd: number } | { estimated: true }, now: Date): Promise<void> {
  await tx(async (t) => {
    await counting(t);
    const [r] = (
      // The account's spend lock, shared, in the same statement: closes never
      // wait on each other, but a counter's fill (the same lock, exclusive)
      // waits for this close and reads its cost, so a close's move is never
      // lost to a fill running beside it (Codex).
      await t.execute(sql`SELECT tenant, day, job, cost_usd::text AS cost, margin::text AS margin, pg_advisory_xact_lock_shared(hashtext('model-spend:' || tenant)) AS locked FROM model_usage WHERE id = ${id} AND status = 'open' AND settled_key IS NULL FOR UPDATE`)
    ).rows as { tenant: string; day: string; job: string | null; cost: string; margin: string | null }[];
    if (!r) return;
    if ("estimated" in outcome) {
      await t.update(modelUsage).set({ status: "estimated", closedAt: now }).where(eq(modelUsage.id, id));
      return;
    }
    const final = round6(outcome.costUsd);
    await t
      .update(modelUsage)
      .set({
        status: "closed",
        closedAt: now,
        inputTokens: outcome.tokens.input,
        outputTokens: outcome.tokens.output,
        cacheReadTokens: outcome.tokens.cacheRead,
        cacheWriteTokens: outcome.tokens.cacheWrite,
        costUsd: final.toFixed(6),
      })
      .where(eq(modelUsage.id, id));
    const delta = round6(final - Number(r.cost));
    if (delta === 0) return;
    // In the counters' one order: the day, the key, the key's day. A key's
    // counters move by the charge rounded at each end, as the hold was. A
    // row held before margins were kept on rows (none open since 10 Nov
    // 2026) leaves the key's counters at its hold: the margin it was valued
    // at is not known here, and the hold is the most it could cost (Codex).
    await moveCounter(t, r.tenant, `day:${r.day}`, delta);
    if (r.job && r.margin !== null) {
      const m = Number(r.margin);
      const charged = round6(round6(final * m) - round6(Number(r.cost) * m));
      await moveCounter(t, r.tenant, `job:${r.job}`, charged);
      await moveCounter(t, r.tenant, `jobday:${r.job}:${r.day}`, charged);
    }
  });
}

/** Say this transaction moves the counters itself, so the guard on
 *  model_usage (drizzle/0047) leaves them be. Any other write to the table
 *  clears the account's counters, to be filled again from the rows.
 *
 *  A hold (`tenant` given) also takes the release before this one's
 *  admission lock, SHARED: holds never wait on each other, but an older
 *  pod's sum-and-insert (the same lock, exclusive) waits for them and they
 *  for it, so a rollout cannot admit two calls into one limit's last room
 *  (Codex). Contract step, once no release before v2026.11.10 can run:
 *  drop it. */
async function counting(t: Db, tenant?: string): Promise<void> {
  if (tenant === undefined) await t.execute(sql`SELECT set_config('foldrun.spend_counted', 'on', true)`);
  else await t.execute(sql`SELECT set_config('foldrun.spend_counted', 'on', true), pg_advisory_xact_lock_shared(hashtext(${"model-supply:" + tenant}))`);
}

/** Hold `add` on a counter if it stays within `cap` (null: no cap): "ok",
 *  "missing" (no row yet), or the spend that left no room. Each statement
 *  reads its own snapshot, so a counter another call made between the
 *  UPDATE and the SELECT is tried again, never taken as full (Codex). */
async function holdOn(t: Db, tenant: string, scope: string, add: number, cap: number | null): Promise<"ok" | "missing" | { spent: number }> {
  for (let tries = 0; ; tries++) {
    const up = (await t.execute(sql`UPDATE model_spend SET usd = usd + ${add}, updated_at = now() WHERE tenant = ${tenant} AND scope = ${scope} AND (${cap}::numeric IS NULL OR usd + ${add} <= ${cap}::numeric) RETURNING usd`)).rows;
    if (up.length) return "ok";
    const [cur] = (await t.execute(sql`SELECT usd::text AS usd FROM model_spend WHERE tenant = ${tenant} AND scope = ${scope}`)).rows as { usd: string }[];
    if (!cur) return "missing";
    const spent = Number(cur.usd);
    if ((cap !== null && spent + add > cap) || tries >= 3) return { spent };
  }
}

/** One call's holds and its usage row, in one transaction: "ok"; the
 *  refusal of the first limit with no room (the holds already taken undone
 *  by the rollback); or "missing" when a counter is not made yet. */
async function holdCall(
  tenant: string,
  scopes: { scope: string; add: number; cap: number | null; full: (spent: number, cap: number) => Reserved }[],
  insert: (t: Db) => Promise<unknown>,
): Promise<"ok" | "missing" | Reserved> {
  try {
    return await tx(async (t) => {
      await counting(t, tenant);
      for (const sc of scopes) {
        const got = await holdOn(t, tenant, sc.scope, sc.add, sc.cap);
        if (got === "missing") throw new Rollback("missing");
        if (got !== "ok") throw new Rollback(sc.full(got.spent, sc.cap ?? 0));
      }
      await insert(t);
      return "ok" as const;
    });
  } catch (err) {
    if (err instanceof Rollback) return err.result;
    throw err;
  }
}

/** Thrown out of a transaction to roll it back with an answer. */
class Rollback extends Error {
  readonly result: "missing" | Reserved;
  constructor(result: "missing" | Reserved) {
    super("rollback");
    this.result = result;
  }
}

/** Make the counters not made yet from model_usage, in a transaction of
 *  their own under the account's spend lock. The guard on model_usage
 *  (drizzle/0047) takes the same lock for a write the counting code did not
 *  make, so a fill waits for such a write and counts it, and a write after
 *  a fill clears what it filled (Codex). Nothing here waits on a counter
 *  row, so the lock cannot close a circle with a held call. */
async function fillCounters(tenant: string, scopes: string[], day: string, job: string | null, margin: number): Promise<void> {
  await tx(async (t) => {
    await counting(t);
    await t.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"model-spend:" + tenant}))`);
    const made = new Set(((await t.execute(sql`SELECT scope FROM model_spend WHERE tenant = ${tenant} AND scope IN (${sql.join(scopes.map((x) => sql`${x}`), sql`, `)})`)).rows as { scope: string }[]).map((r) => r.scope));
    for (const scope of scopes) {
      if (made.has(scope)) continue;
      await t.execute(sql`INSERT INTO model_spend (tenant, scope, usd) SELECT ${tenant}, ${scope}, (${counterSum(tenant, scope, day, job, margin)}) ON CONFLICT DO NOTHING`);
    }
  });
}

/** Move a counter by a close's `delta`. A counter not made yet is left
 *  to its fill: the close holds the account's spend lock shared, so no fill
 *  is running, and the next one waits for this close and reads its cost. */
async function moveCounter(t: Db, tenant: string, scope: string, delta: number): Promise<void> {
  if (delta === 0) return;
  await t.execute(sql`UPDATE model_spend SET usd = usd + ${delta}, updated_at = now() WHERE tenant = ${tenant} AND scope = ${scope}`);
}

/** What a counter holds, summed from model_usage: the account's day at list
 *  price, a key's total and day charged — each row at its own margin
 *  (`margin` for a row from before margins were kept), rounded per row as
 *  its hold was. */
function counterSum(tenant: string, scope: string, day: string, job: string | null, margin: number) {
  return scope.startsWith("day:")
    ? sql`SELECT coalesce(sum(cost_usd), 0) FROM model_usage WHERE tenant = ${tenant} AND day = ${day}`
    : scope.startsWith("jobday:")
      ? sql`SELECT coalesce(sum(round(cost_usd * coalesce(margin, ${margin}::numeric), 6)), 0) FROM model_usage WHERE tenant = ${tenant} AND job = ${job} AND day = ${day}`
      : sql`SELECT coalesce(sum(round(cost_usd * coalesce(margin, ${margin}::numeric), 6)), 0) FROM model_usage WHERE tenant = ${tenant} AND job = ${job}`;
}

/** What the account's calls cost today (UTC), open estimates included. */
export async function spentToday(tenant: string, now = new Date()): Promise<number> {
  const day = dayOf(now);
  if (databaseEnabled()) {
    const [r] = (await ormRequired().execute(sql`SELECT coalesce(sum(cost_usd), 0)::text AS s FROM model_usage WHERE tenant = ${tenant} AND day = ${day}`)).rows as { s: string }[];
    return round6(Number(r?.s ?? 0));
  }
  return round6(readFile().filter((x) => x.tenant === tenant && x.day === day).reduce((n, x) => n + x.costUsd, 0));
}

/** What one job's calls were CHARGED (open estimates included): all time,
 *  or one UTC day — each row at the margin it was held at; a row from before
 *  margins were kept, at `margin` (pass the one in force now). The gateway's
 *  keys are jobs — `gateway:<key id>` — so this is a key's spend against its
 *  limits. `margin` 1 gives the price list's cost for such rows. */
export async function spentByJob(tenant: string, job: string, day?: string, margin = 1): Promise<number> {
  if (databaseEnabled()) {
    const [r] = (
      await ormRequired().execute(
        day
          ? sql`SELECT coalesce(sum(cost_usd * coalesce(margin, ${margin})), 0)::text AS s FROM model_usage WHERE tenant = ${tenant} AND job = ${job} AND day = ${day}`
          : sql`SELECT coalesce(sum(cost_usd * coalesce(margin, ${margin})), 0)::text AS s FROM model_usage WHERE tenant = ${tenant} AND job = ${job}`,
      )
    ).rows as { s: string }[];
    return round6(Number(r?.s ?? 0));
  }
  return round6(readFile().filter((x) => x.tenant === tenant && x.job === job && (!day || x.day === day)).reduce((n, x) => n + x.costUsd * (x.margin ?? margin), 0));
}

/** The calls one run made (for its charge and the per-step trace). */
export async function callsOfRun(tenant: string, runId: string): Promise<ModelUsageRow[]> {
  if (databaseEnabled()) {
    const rows = await ormRequired().select().from(modelUsage).where(and(eq(modelUsage.tenant, tenant), eq(modelUsage.runId, runId)));
    return rows.map(fromDb);
  }
  return readFile().filter((x) => x.tenant === tenant && x.runId === runId);
}

/** Rows no ledger line has charged yet, oldest first. Open rows count once
 *  they are older than `openAfterMs` — a call that never closed (the proxy
 *  died mid-stream) is charged at its estimate, not forgotten. */
export async function unsettledCalls(limit = 500, openAfterMs = 15 * 60_000, now = Date.now()): Promise<ModelUsageRow[]> {
  const cutoff = new Date(now - openAfterMs);
  if (databaseEnabled()) {
    const rows = await ormRequired()
      .select()
      .from(modelUsage)
      .where(and(isNull(modelUsage.settledKey), sql`(${modelUsage.status} <> 'open' OR ${modelUsage.createdAt} < ${cutoff})`))
      .orderBy(modelUsage.createdAt)
      .limit(limit);
    return rows.map(fromDb);
  }
  return readFile()
    .filter((x) => x.settledKey === null && (x.status !== "open" || Date.parse(x.createdAt) < cutoff.getTime()))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, limit);
}

/** The rows one settlement key claimed: what its ledger line charges. */
export async function callsByKey(tenant: string, key: string): Promise<ModelUsageRow[]> {
  if (databaseEnabled()) {
    const rows = await ormRequired().select().from(modelUsage).where(and(eq(modelUsage.tenant, tenant), eq(modelUsage.settledKey, key)));
    return rows.map(fromDb);
  }
  return readFile().filter((x) => x.tenant === tenant && x.settledKey === key);
}

/** The settlement keys CLAIMED in the last `days` (by claim time, not the
 *  call's age — a backlog is claimed late), by account: what a recovery
 *  pass checks against the ledger. */
export async function recentSettledKeys(days: number, now = Date.now()): Promise<{ tenant: string; key: string }[]> {
  const since = new Date(now - days * 24 * 60 * 60 * 1000);
  if (databaseEnabled()) {
    const res = await ormRequired().execute(
      sql`SELECT DISTINCT tenant, settled_key AS key FROM model_usage WHERE settled_key IS NOT NULL AND coalesce(settled_at, created_at) > ${since}`,
    );
    return res.rows as { tenant: string; key: string }[];
  }
  const seen = new Map<string, { tenant: string; key: string }>();
  for (const r of readFile()) {
    if (r.settledKey && Date.parse(r.settledAt ?? r.createdAt) > since.getTime()) seen.set(`${r.tenant}\u0000${r.settledKey}`, { tenant: r.tenant, key: r.settledKey });
  }
  return [...seen.values()];
}

/** Mark rows charged by one ledger line. Only rows not already settled are
 *  touched, so a second settlement of the same rows changes nothing. A row
 *  still open is frozen at its estimate in the same write ("estimated"): a
 *  close that lands later finds it settled and changes nothing. */
export async function markSettled(ids: string[], key: string): Promise<number> {
  if (ids.length === 0) return 0;
  if (databaseEnabled()) {
    const res = await ormRequired()
      .update(modelUsage)
      .set({
        settledKey: key,
        settledAt: sql`now()`,
        status: sql`CASE WHEN ${modelUsage.status} = 'open' THEN 'estimated' ELSE ${modelUsage.status} END`,
        closedAt: sql`coalesce(${modelUsage.closedAt}, now())`,
      })
      .where(and(inArray(modelUsage.id, ids), isNull(modelUsage.settledKey)))
      .returning({ id: modelUsage.id });
    return res.length;
  }
  return fileLocked(() => {
    const rows = readFile();
    let n = 0;
    for (const r of rows) {
      if (ids.includes(r.id) && r.settledKey === null) {
        r.settledKey = key;
        r.settledAt = new Date().toISOString();
        if (r.status === "open") {
          r.status = "estimated";
          r.closedAt ??= new Date().toISOString();
        }
        n++;
      }
    }
    writeFile(rows);
    return n;
  });
}

function fromDb(r: typeof modelUsage.$inferSelect): ModelUsageRow {
  return {
    id: r.id,
    tenant: r.tenant,
    day: r.day,
    kind: r.kind as UsageKind,
    runId: r.runId,
    step: r.step,
    job: r.job,
    provider: r.provider,
    model: r.model,
    tokens: { input: r.inputTokens, output: r.outputTokens, cacheRead: r.cacheReadTokens, cacheWrite: r.cacheWriteTokens },
    costUsd: Number(r.costUsd),
    status: r.status as ModelUsageRow["status"],
    priceVersion: r.priceVersion,
    createdAt: r.createdAt.toISOString(),
    closedAt: r.closedAt ? r.closedAt.toISOString() : null,
    settledKey: r.settledKey,
    settledAt: r.settledAt ? r.settledAt.toISOString() : null,
    margin: r.margin === null || r.margin === undefined ? null : Number(r.margin),
  };
}

// ------------------------------------------------------------ file store

const file = () => path.join(dataRoot(), ".model-usage.json");

function readFile(): ModelUsageRow[] {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8")) as ModelUsageRow[];
  } catch {
    return [];
  }
}

function writeFile(rows: ModelUsageRow[]): void {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rows));
  fs.renameSync(tmp, file());
}

let chain: Promise<unknown> = Promise.resolve();
function fileLocked<T>(fn: () => T): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

/** For tests: forget every row. */
export function resetModelUsageForTests(): void {
  try {
    fs.rmSync(file(), { force: true });
  } catch {}
}
