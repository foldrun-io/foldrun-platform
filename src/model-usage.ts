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
import { databaseEnabled, ormRequired, tx } from "./db.ts";
import { modelUsage } from "./schema.ts";

/** Dollars as a person reads them: cents, or more places under a cent
 *  (a $0.004 cap read "$0.00 of $0.00"). */
const usdText = (n: number) => `$${n === 0 || n >= 0.01 ? n.toFixed(2) : n.toFixed(4)}`;

export type UsageKind = "run" | "grade" | "judge" | "draft" | "assistant";

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
  };
  const refuse = (spent: number): Reserved => ({
    ok: false,
    spentUsd: round6(spent),
    capUsd,
    reason: `this account's daily limit on foldrun's models is reached (${usdText(spent)} of ${usdText(capUsd)} today, UTC) — it resets at 00:00 UTC; the operator can raise it`,
  });
  if (databaseEnabled()) {
    return tx(async (t) => {
      await t.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"model-supply:" + call.tenant}))`);
      const [r] = (await t.execute(sql`SELECT coalesce(sum(cost_usd), 0)::text AS s FROM model_usage WHERE tenant = ${call.tenant} AND day = ${day}`)).rows as { s: string }[];
      const spent = Number(r?.s ?? 0);
      if (capUsd > 0 && spent + row.costUsd > capUsd) return refuse(spent);
      await t.insert(modelUsage).values({
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
      });
      return { ok: true as const, id };
    });
  }
  return fileLocked(() => {
    const rows = readFile();
    const spent = rows.filter((x) => x.tenant === call.tenant && x.day === day).reduce((n, x) => n + x.costUsd, 0);
    if (capUsd > 0 && spent + row.costUsd > capUsd) return refuse(spent);
    rows.push(row);
    writeFile(rows);
    return { ok: true as const, id };
  });
}

/** Close a call with what it cost. `estimated` when no usage came back:
 *  the estimate it held stands as the charge. */
export async function closeCall(id: string, outcome: { tokens: UsageTokens; costUsd: number } | { estimated: true }, now = new Date()): Promise<void> {
  if (databaseEnabled()) {
    if ("estimated" in outcome) {
      await ormRequired().update(modelUsage).set({ status: "estimated", closedAt: now }).where(and(eq(modelUsage.id, id), eq(modelUsage.status, "open"), isNull(modelUsage.settledKey)));
      return;
    }
    await ormRequired()
      .update(modelUsage)
      .set({
        status: "closed",
        closedAt: now,
        inputTokens: outcome.tokens.input,
        outputTokens: outcome.tokens.output,
        cacheReadTokens: outcome.tokens.cacheRead,
        cacheWriteTokens: outcome.tokens.cacheWrite,
        costUsd: round6(outcome.costUsd).toFixed(6),
      })
      .where(and(eq(modelUsage.id, id), eq(modelUsage.status, "open"), isNull(modelUsage.settledKey)));
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

/** What the account's calls cost today (UTC), open estimates included. */
export async function spentToday(tenant: string, now = new Date()): Promise<number> {
  const day = dayOf(now);
  if (databaseEnabled()) {
    const [r] = (await ormRequired().execute(sql`SELECT coalesce(sum(cost_usd), 0)::text AS s FROM model_usage WHERE tenant = ${tenant} AND day = ${day}`)).rows as { s: string }[];
    return round6(Number(r?.s ?? 0));
  }
  return round6(readFile().filter((x) => x.tenant === tenant && x.day === day).reduce((n, x) => n + x.costUsd, 0));
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
