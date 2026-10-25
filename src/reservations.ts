// A run's expected share of the account's money and caps, held from the
// moment it is admitted until it settles.
//
// The funds gate and the budget caps were read-then-admit. Each read the
// ledger, judged the number, and let the run in — and ten webhook runs in
// one second all read $4.99 against a $5/day cap and all passed, because
// none of them had yet written the line the others would have needed to
// see. The exposure hold (FOLDRUN_MAX_RUN_EXPOSURE × jobs in flight) was a
// count of jobs, not a reservation, and counted after the check.
//
// Now admission RESERVES. The run's expected share is written as a row in
// the same transaction as the check, under a per-tenant advisory lock, so
// two workers judging the same account are serialised by the database and
// the second one reads the first one's hold. The expected share is the
// exposure ceiling where the install sets one, else what this flow's last
// runs cost, else nothing — and a reservation of nothing still counts the
// run as one more in flight, which is what the exposure gate needs.
//
// The reservation is bound to the run once its record exists (the id is
// minted after the gate), released when the run's charge lands, and swept
// by the hourly pass if the run ended some other way — a stop, a deletion,
// a driver that died.
//
// Without a database the platform is one process on one box; the same
// gate runs under a per-tenant in-process lock over a small file, which
// closes the race between concurrent enqueues in that process.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { accountDir, listTenants, readRun } from "../../foldrun-core/src/store.ts";
import { windowStartMs, windowName, windowTurnsHint, formatBudget, type Budget } from "../../foldrun-core/src/budget.ts";
import { databaseEnabled, tx, orm, type Db } from "./db.ts";
import { reservations } from "./schema.ts";
import { windowSpendDb } from "./ledger-db.ts";
import { readLedger } from "./ledger.ts";
import { billing } from "./billing.ts";
import { accountBudget, workspaceBudget, budgetCalendar, workspaceWindowSpendUsd, accountWindowSpendUsd } from "./limits.ts";

export interface Reservation {
  id: string;
  tenant: string;
  workspace: string;
  flow: string | null;
  runId: string | null;
  usd: number;
  createdAt: string;
}

/** How many of a flow's last charges the estimate averages. */
const SAMPLE = 10;

/** The least a run is held for when nothing better is known: one credit.
 *  A hold of nothing would let a burst at $4.99 of a $5 cap admit every
 *  run again; a hold of a cent admits exactly one, which is the point. */
const FLOOR_USD = 0.01;

/**
 * What one run of this flow is expected to cost. The exposure ceiling
 * when the install sets one — that is what the operator said a run may
 * run to. Else the mean of this flow's last charges on this workspace,
 * which the ledger carries by name. Else the floor: a flow that has never
 * run has no history to hold against, but it is still one more run in
 * flight, and the next admission must see it.
 */
export async function expectedRunUsd(tenant: string, workspace: string, flow: string | null | undefined): Promise<number> {
  const exposure = Number(process.env.FOLDRUN_MAX_RUN_EXPOSURE);
  if (Number.isFinite(exposure) && exposure > 0) return exposure;
  if (!flow) return FLOOR_USD;
  const charges = (await readLedger(tenant))
    .filter((e) => e.kind === "run" && e.workspace === workspace && e.flow === flow && e.usd < 0)
    .slice(-SAMPLE)
    .map((e) => -e.usd);
  if (!charges.length) return FLOOR_USD;
  return Math.max(FLOOR_USD, Number((charges.reduce((n, v) => n + v, 0) / charges.length).toFixed(6)));
}

// ------------------------------------------------------------ the file store

const fileOf = (tenant: string) => path.join(accountDir(tenant), "reservations.json");

function readFile(tenant: string): Reservation[] {
  try {
    return JSON.parse(fs.readFileSync(fileOf(tenant), "utf8")) as Reservation[];
  } catch {
    return [];
  }
}

function writeFile(tenant: string, rows: Reservation[]): void {
  fs.mkdirSync(accountDir(tenant), { recursive: true });
  const tmp = `${fileOf(tenant)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2));
  fs.renameSync(tmp, fileOf(tenant));
}

/** One admission at a time per tenant in this process: a promise chain. */
const locks = new Map<string, Promise<unknown>>();
async function withTenantLock<T>(tenant: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(tenant) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(tenant, run.catch(() => {}));
  try {
    return await run;
  } finally {
    if (locks.get(tenant) === run) locks.delete(tenant);
  }
}

// -------------------------------------------------------------- the gate

function refuse(msg: string): never {
  const err = new Error(msg);
  (err as Error & { status: number }).status = 402;
  throw err;
}

/** The cap's rule, unchanged in shape — a run is admitted while the window
 *  is under the cap — with what is HELD counted as spent. This run's own
 *  share is not: "$4.99 of $5 and you may not run" is not what a cap
 *  means, but the second run of a burst reads the first one's hold and
 *  is refused, which is what it does mean. */
function checkBudget(scope: string, budget: Budget | null, spent: number, held: number, where: string): void {
  if (!budget) return;
  if (spent + held < budget.usd) return;
  refuse(
    `${scope} is at its budget — $${spent.toFixed(2)} spent ${windowName(budget.period)}` +
      (held > 0 ? ` and $${held.toFixed(2)} held for runs in flight` : "") +
      ` of ${formatBudget(budget)} (budget: in ${where}; raise it or ${windowTurnsHint(budget.period)})`,
  );
}

/**
 * Admit a run, or refuse it with a 402 — and if admitted, hold its share.
 *
 * Every cap in one place, in one transaction: the account's balance (when
 * billing is enforced), the account's `budget:` and the workspace's. Each
 * is judged against what is spent PLUS what is held for runs already
 * admitted PLUS this run's expected share, and the hold is written before
 * the lock is let go. Returns the reservation id, to bind to the run once
 * its record exists; nothing when the install enforces no money at all
 * and neither file sets a budget, so the self-hoster's path costs nothing.
 */
export async function reserveAdmission(tenant: string, workspace: string, flow: string | null | undefined): Promise<string | null> {
  const wsBudget = workspaceBudget(tenant, workspace);
  const acBudget = accountBudget(tenant);
  const money = billing().enabled();
  if (!money && !wsBudget && !acBudget) return null;
  const expected = await expectedRunUsd(tenant, workspace, flow);
  const id = `rsv-${crypto.randomBytes(8).toString("hex")}`;
  const row: Reservation = { id, tenant, workspace, flow: flow ?? null, runId: null, usd: expected, createdAt: new Date().toISOString() };

  if (databaseEnabled()) {
    await tx(async (t) => {
      // The account's admissions are serialised here: the second worker
      // waits for the first's hold to be visible before it judges.
      await t.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tenant}))`);
      const held = await heldDb(tenant, null, t);
      if (money) {
        const balance = await billing().balanceUsd(tenant, t);
        await billing().assertFunds(tenant, { heldUsd: held.usd, inFlight: held.count, expectedUsd: expected, balance });
      }
      if (acBudget) {
        const since = new Date(windowStartMs(acBudget.period, budgetCalendar(tenant)) ?? 0);
        checkBudget("this account", acBudget, await windowSpendDb(tenant, null, since, t), held.usd, "the account's AGENTS.md");
      }
      if (wsBudget) {
        const since = new Date(windowStartMs(wsBudget.period, budgetCalendar(tenant, workspace)) ?? 0);
        const wsHeld = await heldDb(tenant, workspace, t);
        checkBudget(`workspace ${workspace}`, wsBudget, await windowSpendDb(tenant, workspace, since, t), wsHeld.usd, "its AGENTS.md");
      }
      await t.insert(reservations).values({ id, tenant, workspace, flow: flow ?? null, runId: null, usd: expected.toString() });
    });
    return id;
  }

  return withTenantLock(tenant, async () => {
    const rows = readFile(tenant);
    const heldUsd = rows.reduce((n, r) => n + r.usd, 0);
    if (money) await billing().assertFunds(tenant, { heldUsd, inFlight: rows.length, expectedUsd: expected, balance: await billing().balanceUsd(tenant) });
    if (acBudget) checkBudget("this account", acBudget, await accountWindowSpendUsd(tenant, acBudget.period), heldUsd, "the account's AGENTS.md");
    if (wsBudget) {
      const wsHeld = rows.filter((r) => r.workspace === workspace).reduce((n, r) => n + r.usd, 0);
      checkBudget(`workspace ${workspace}`, wsBudget, await workspaceWindowSpendUsd(tenant, workspace, wsBudget.period), wsHeld, "its AGENTS.md");
    }
    writeFile(tenant, [...rows, row]);
    return id;
  });
}

async function heldDb(tenant: string, workspace: string | null, on: Db): Promise<{ usd: number; count: number }> {
  const [r] = await on
    .select({ usd: sql<string>`COALESCE(SUM(${reservations.usd}), 0)::text`, count: sql<string>`count(*)::text` })
    .from(reservations)
    .where(workspace === null ? sql`${reservations.tenant} = ${tenant}` : sql`${reservations.tenant} = ${tenant} AND ${reservations.workspace} = ${workspace}`);
  return { usd: Number(r?.usd ?? 0), count: Number(r?.count ?? 0) };
}

/** The record exists: the hold is the run's now. */
export async function bindReservation(tenant: string, id: string | null, runId: string): Promise<void> {
  if (!id) return;
  const q = orm();
  if (q) {
    await q.update(reservations).set({ runId }).where(sql`${reservations.id} = ${id}`);
    return;
  }
  await withTenantLock(tenant, async () => {
    writeFile(tenant, readFile(tenant).map((r) => (r.id === id ? { ...r, runId } : r)));
  });
}

/** The gate admitted but the record was never written: let the hold go. */
export async function dropReservation(tenant: string, id: string | null): Promise<void> {
  if (!id) return;
  const q = orm();
  if (q) {
    await q.delete(reservations).where(sql`${reservations.id} = ${id}`);
    return;
  }
  await withTenantLock(tenant, async () => writeFile(tenant, readFile(tenant).filter((r) => r.id !== id)));
}

/** The run settled (or was stopped, or deleted): its hold is over. */
export async function releaseReservation(tenant: string, runId: string): Promise<void> {
  const q = orm();
  if (q) {
    await q.delete(reservations).where(sql`${reservations.runId} = ${runId}`);
    return;
  }
  await withTenantLock(tenant, async () => {
    const rows = readFile(tenant);
    if (rows.some((r) => r.runId === runId)) writeFile(tenant, rows.filter((r) => r.runId !== runId));
  });
}

/** What is held for one account right now — the wallet's "held" figure. */
export async function heldUsd(tenant: string): Promise<{ usd: number; count: number }> {
  const q = orm();
  if (q) return heldDb(tenant, null, q);
  const rows = readFile(tenant);
  return { usd: Number(rows.reduce((n, r) => n + r.usd, 0).toFixed(6)), count: rows.length };
}

/** Every reservation of a tenant. */
export async function listReservations(tenant: string): Promise<Reservation[]> {
  const q = orm();
  if (!q) return readFile(tenant);
  const rows = await q.select().from(reservations).where(sql`${reservations.tenant} = ${tenant}`);
  return rows.map((r) => ({ id: r.id, tenant: r.tenant, workspace: r.workspace, flow: r.flow, runId: r.runId, usd: Number(r.usd), createdAt: r.createdAt.toISOString() }));
}

/**
 * Holds whose run is over, or never came to exist: released. The hourly
 * pass calls this per tenant. A hold with no run older than an hour was a
 * gate that admitted and a record that was never written — a crash in
 * between — and it must not hold the account's money forever.
 */
export async function sweepReservations(tenant: string, now = Date.now()): Promise<number> {
  let released = 0;
  for (const r of await listReservations(tenant)) {
    if (r.runId) {
      const run = readRun(tenant, r.workspace, r.runId);
      if (run && run.status !== "completed" && run.status !== "failed") continue;
      await releaseReservation(tenant, r.runId);
      released++;
    } else if (now - Date.parse(r.createdAt) > 3600_000) {
      await dropReservation(tenant, r.id);
      released++;
    }
  }
  return released;
}

/** For /api/metrics: what is held across every account. */
export async function reservationTotals(): Promise<{ count: number; usd: number }> {
  const q = orm();
  if (q) {
    const [r] = await q.select({ usd: sql<string>`COALESCE(SUM(${reservations.usd}), 0)::text`, count: sql<string>`count(*)::text` }).from(reservations);
    return { count: Number(r?.count ?? 0), usd: Number(r?.usd ?? 0) };
  }
  let count = 0;
  let usd = 0;
  let tenants: string[] = [];
  try {
    tenants = listTenants();
  } catch {
    return { count, usd };
  }
  for (const t of tenants) for (const r of readFile(t)) { count++; usd += r.usd; }
  return { count, usd: Number(usd.toFixed(6)) };
}
