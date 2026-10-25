// What an account may run, and how much it may spend: the engine's limits.
//
// Queue lanes (`priority:`), how many runs at once (`concurrency:`) and spend
// budgets (`budget:`) are read from the account's and workspace's AGENTS.md
// on every install. Where foldrun's operator placed a plan on a customer
// (billing.ts plan()), its lane and cap win over what the account asks.

import fs from "node:fs";
import path from "node:path";
import { accountDir, workspaceDir } from "../../foldrun-core/src/store.ts";
import { readLedger } from "./ledger.ts";
import { billing } from "./billing.ts";
import { parseBudget, windowStartMs, windowName, windowTurnsHint, formatBudget, type Budget, type BudgetPeriod } from "../../foldrun-core/src/budget.ts";
import { resolveTimezone } from "../../foldrun-core/src/runner.ts";
import { configMatter } from "../../foldrun-core/src/matter.ts";

/**
 * How many runs this account may drive at once: the operator's plan, else
 * `concurrency:` in the account's AGENTS.md (Settings writes it there; never
 * above the install's per-account share — selfCapCeiling), else the install's
 * FOLDRUN_PLAN_CONCURRENCY, else no cap. A number the operator can set per
 * customer — a plan is a policy, not a property of the hardware — and the
 * one knob that stops being "hardware" the day a cluster adds nodes on
 * demand: the install-wide FOLDRUN_CONCURRENCY still bounds the worker.
 */
/** Where this account's runs stand in the queue: `priority:` in the
 *  account's AGENTS.md — high | normal | low — as a number the queue can
 *  order by (10, 0, -10). A plan's lane, set by the operator per customer;
 *  a flow's own `priority:` adds to it. The account's cap still bounds how
 *  many of its runs are live, which is what keeps a high lane from
 *  starving everyone else outright. */
export async function accountPriority(tenant: string): Promise<number> {
  return priorityWeight(await accountLane(tenant));
}

/** The account's lane: the operator's plan, else the account's own ask —
 *  which may lower it (`low`) but never raise it. On an install with open
 *  signup, a `priority: high` anyone can type into their own AGENTS.md
 *  put them ahead of every paying account; the fast lane is a plan's. */
async function accountLane(tenant: string): Promise<"high" | "normal" | "low"> {
  const plan = await billing().plan(tenant);
  if (plan?.priority) return plan.priority;
  try {
    const raw = configMatter(fs.readFileSync(path.join(accountDir(tenant), "AGENTS.md"), "utf8")).data?.priority;
    return raw === "low" ? "low" : "normal";
  } catch {
    return "normal";
  }
}

/** The account's share of a contended fleet — high 3, normal 2, low 1. The
 *  queue serves whoever has the fewest claimed jobs per unit of weight, so
 *  a fast-lane account gets half again a normal one's share when both are
 *  waiting, and never all of it (queue-db.ts claimNextDb). */
export async function accountWeight(tenant: string): Promise<number> {
  const lane = await accountLane(tenant);
  return lane === "high" ? 3 : lane === "low" ? 1 : 2;
}

export function priorityWeight(level: unknown): number {
  return level === "high" ? 10 : level === "low" ? -10 : 0;
}

export async function accountConcurrency(tenant: string): Promise<{ cap: number; source: "account" | "plan" } | null> {
  const plan = await billing().plan(tenant);
  if (plan?.concurrency && Number.isInteger(plan.concurrency) && plan.concurrency > 0) {
    return { cap: plan.concurrency, source: "plan" };
  }
  try {
    const raw = configMatter(fs.readFileSync(path.join(accountDir(tenant), "AGENTS.md"), "utf8")).data?.concurrency;
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) {
      const ceiling = selfCapCeiling();
      return { cap: ceiling ? Math.min(n, ceiling) : n, source: "account" };
    }
  } catch {
    // no account file, or no key — fall through to the plan
  }
  const installPlan = Number(process.env.FOLDRUN_PLAN_CONCURRENCY);
  return Number.isInteger(installPlan) && installPlan > 0 ? { cap: installPlan, source: "plan" } : null;
}

/** The most an account may give itself: the install's per-account share
 *  (FOLDRUN_ACCOUNT_CONCURRENCY) and, where billing is on, the plan number,
 *  whichever is smaller. An account's own `concurrency:` may lower its
 *  share, never raise it — on an install with open signup, a number anyone
 *  can type into their own AGENTS.md is not a limit. Raising one account
 *  is the operator's plan. 0 is no ceiling. */
function selfCapCeiling(): number {
  const limits = [
    Number(process.env.FOLDRUN_ACCOUNT_CONCURRENCY),
    billing().enabled() ? Number(process.env.FOLDRUN_PLAN_CONCURRENCY) : NaN,
  ].filter((n) => Number.isInteger(n) && n > 0);
  return limits.length ? Math.min(...limits) : 0;
}

// ---------------------------------------------------------------- budgets
//
// `budget:` in a workspace's AGENTS.md or the account's: a number and a
// period — `60` (per month), `60/day`, `60/week`, `unlimited`. The grammar
// is core's (budget.ts), so the lint, the editor and this gate agree. The
// window is measured in the account's own calendar (`timezone:`,
// nearest-wins like every other key), which is what a customer means by
// "today". Unset is no limit.

function frontOf(file: string): Record<string, unknown> {
  try {
    return (configMatter(fs.readFileSync(file, "utf8")).data ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** A cap over time, or null. A per-run period written here is nobody's
 *  cap (the lint says where it belongs); it is not silently a month. */
function timedBudget(raw: unknown): Budget | null {
  const b = parseBudget(raw, "month");
  return b && b.period !== "run" ? b : null;
}

/** The calendar a budget window is measured in: the workspace's `timezone:`,
 *  else the account's, else the install's, else UTC. */
export function budgetCalendar(tenant: string, workspace?: string): string {
  const account = frontOf(path.join(accountDir(tenant), "AGENTS.md"));
  const ws = workspace ? frontOf(path.join(workspaceDir(tenant, workspace), "AGENTS.md")) : {};
  return resolveTimezone({ ...account, ...(typeof ws.timezone === "string" ? { timezone: ws.timezone } : {}) });
}

/** `budget:` in a workspace's AGENTS.md — a cap over a day, week or month,
 *  or null when the workspace declares none. */
export function workspaceBudget(tenant: string, workspace: string): Budget | null {
  return timedBudget(frontOf(path.join(workspaceDir(tenant, workspace), "AGENTS.md")).budget);
}

/** `budget:` in the account's AGENTS.md — the cap across everything. */
export function accountBudget(tenant: string): Budget | null {
  return timedBudget(frontOf(path.join(accountDir(tenant), "AGENTS.md")).budget);
}

/** The amount alone. Kept for the callers that only need the number. */
export function workspaceBudgetUsd(tenant: string, workspace: string): number | null {
  return workspaceBudget(tenant, workspace)?.usd ?? null;
}
export function accountBudgetUsd(tenant: string): number | null {
  return accountBudget(tenant)?.usd ?? null;
}

/** What one workspace has spent since its window began — today, this week
 *  or this month, in the account's calendar. */
export async function workspaceWindowSpendUsd(tenant: string, workspace: string, period: BudgetPeriod = "month"): Promise<number> {
  const since = windowStartMs(period, budgetCalendar(tenant, workspace)) ?? 0;
  let spend = 0;
  for (const e of await readLedger(tenant)) {
    if (e.usd >= 0 || e.workspace !== workspace) continue;
    if (new Date(e.t).getTime() >= since) spend += -e.usd;
  }
  return Number(spend.toFixed(4));
}

/** What the whole account has spent since its window began, across every
 *  workspace. The number the account's own `budget:` is measured against. */
export async function accountWindowSpendUsd(tenant: string, period: BudgetPeriod = "month"): Promise<number> {
  const since = windowStartMs(period, budgetCalendar(tenant)) ?? 0;
  let spend = 0;
  for (const e of await readLedger(tenant)) {
    // Charges for WORK: what the workspace cap counts, summed across every
    // workspace. A top-up is money in. The base fee and storage accruals
    // carry no workspace and are not spend the customer can stop by
    // running less — a $99 base fee against a $100 budget would refuse
    // every run from the second day.
    if (e.usd >= 0 || !e.workspace) continue;
    if (new Date(e.t).getTime() >= since) spend += -e.usd;
  }
  return Number(spend.toFixed(4));
}

/** This calendar month's spend — the figure a workspace page and a
 *  statement lead with, whatever period the cap uses. */
export function workspaceMonthSpendUsd(tenant: string, workspace: string): Promise<number> {
  return workspaceWindowSpendUsd(tenant, workspace, "month");
}
export function accountMonthSpendUsd(tenant: string): Promise<number> {
  return accountWindowSpendUsd(tenant, "month");
}

/** Where a cap stands: the budget, what is spent in ITS window, and the
 *  window's name — one call, so a page cannot pair a daily cap with a
 *  monthly figure. No budget: the month's spend, for the number alone. */
export interface BudgetStanding {
  budget: Budget | null;
  spentUsd: number;
  /** "today" | "this week" | "this month". */
  window: string;
  /** "$60/day", or null. */
  label: string | null;
}
export async function workspaceBudgetStanding(tenant: string, workspace: string): Promise<BudgetStanding> {
  const budget = workspaceBudget(tenant, workspace);
  const period = budget?.period ?? "month";
  return {
    budget,
    spentUsd: await workspaceWindowSpendUsd(tenant, workspace, period),
    window: windowName(period),
    label: budget ? formatBudget(budget) : null,
  };
}
export async function accountBudgetStanding(tenant: string): Promise<BudgetStanding> {
  const budget = accountBudget(tenant);
  const period = budget?.period ?? "month";
  return {
    budget,
    spentUsd: await accountWindowSpendUsd(tenant, period),
    window: windowName(period),
    label: budget ? formatBudget(budget) : null,
  };
}

/**
 * The account's own cap, refused at admission exactly like the
 * workspace one.
 *
 * This was documented as one of the three caps and was never implemented:
 * a customer reading the billing page believed their whole account stopped
 * at $500 a month while nothing anywhere enforced it. A safety control that
 * exists only in prose is worse than none, because it is trusted.
 */
export async function assertAccountBudget(tenant: string) {
  const budget = accountBudget(tenant);
  if (budget === null) return;
  const spent = await accountWindowSpendUsd(tenant, budget.period);
  if (spent < budget.usd) return;
  const err = new Error(
    `this account is at its budget — $${spent.toFixed(2)} spent ${windowName(budget.period)} of ` +
      `${formatBudget(budget)} (budget: in the account's AGENTS.md; raise it or ${windowTurnsHint(budget.period)})`,
  );
  (err as Error & { status: number }).status = 402;
  throw err;
}

/**
 * The budget gate, refused at admission like assertFunds. A cap the customer
 * wrote in their own file is honoured whether or not platform billing is
 * armed — it is their control on their spend, not ours on our revenue.
 * Runs already going always finish; the cap stops the next one starting.
 */
export async function assertWorkspaceBudget(tenant: string, workspace: string) {
  const budget = workspaceBudget(tenant, workspace);
  if (budget === null) return;
  const spent = await workspaceWindowSpendUsd(tenant, workspace, budget.period);
  if (spent < budget.usd) return;
  const err = new Error(
    `workspace ${workspace} is at its budget — $${spent.toFixed(2)} spent ${windowName(budget.period)} of ` +
      `${formatBudget(budget)} (budget: in its AGENTS.md; raise it or ${windowTurnsHint(budget.period)})`,
  );
  (err as Error & { status: number }).status = 402;
  throw err;
}
