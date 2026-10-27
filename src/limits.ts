// What an account may run, and how much it may spend: the engine's limits.
//
// Queue lanes (`priority:`), how many runs at once (`concurrency:`) and spend
// budgets (`budget:`) are read from the account's and workspace's AGENTS.md
// on every install. Where foldrun's operator placed a plan on a customer
// (billing.ts plan()), its lane and cap win over what the account asks.

import fs from "node:fs";
import path from "node:path";
import { accountDir, workspaceDir, listWorkspaces, liveRuns, type RoomLevel } from "../../foldrun-core/src/store.ts";
import { readCompute } from "../../foldrun-core/src/resources.ts";
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

// ---------------------------------------------------------------- compute
//
// How much an account's running steps may hold together — cores and GiB,
// the figures each step's sandbox is capped at and billed by — and the most
// one step may hold. Daytona's model: a pool per account, sized by plan.
// The room gate (pod-room.ts) holds a step that would pass the pool until
// another finishes, and fails one that alone is bigger than it or than the
// plan's step maximum. A step's own figures are its class's or its
// `resources:` (core resources.ts).

export interface AccountCompute {
  /** Cores all running steps may hold together; null is no cap. */
  vcpu: number | null;
  /** GiB the same way. */
  memGiB: number | null;
  /** GiB of disk the same way — the allowances (ephemeral-storage limits)
   *  its running steps hold (27 Oct 2026). */
  diskGiB: number | null;
  /** The most one step may hold; null is no cap beyond the pool. */
  stepVcpu: number | null;
  stepMemGiB: number | null;
  stepDiskGiB: number | null;
  /** Where the pool's figures came from: the operator's plan, the
   *  account's own `compute:` (lower only), or the install's defaults. */
  source: "plan" | "account" | "install" | null;
}

const positive = (v: unknown): number | null => {
  const n = Number(v);
  return v !== undefined && v !== null && v !== "" && Number.isFinite(n) && n > 0 ? n : null;
};
const lower = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));

/**
 * The account's compute pool and step maximum. Per figure: the operator's
 * plan (billing.ts plan()) wins; else the install's default
 * (FOLDRUN_ACCOUNT_VCPU, FOLDRUN_ACCOUNT_MEMORY_GIB, FOLDRUN_STEP_MAX_VCPU,
 * FOLDRUN_STEP_MAX_MEMORY_GIB). The account's own `compute:` in AGENTS.md
 * may lower the pool, never raise it — the same rule as `concurrency:`, for
 * the same reason: on an install with open signup a number anyone can type
 * is not a limit. With neither a plan nor an install default, the account's
 * own number stands (a self-hoster capping their own box).
 */
export async function accountCompute(tenant: string, env = process.env): Promise<AccountCompute> {
  const plan = await billing().plan(tenant);
  const ceiling = {
    vcpu: positive(plan?.vcpu) ?? positive(env.FOLDRUN_ACCOUNT_VCPU),
    memGiB: positive(plan?.memGiB) ?? positive(env.FOLDRUN_ACCOUNT_MEMORY_GIB),
    diskGiB: positive(plan?.diskGiB) ?? positive(env.FOLDRUN_ACCOUNT_DISK_GIB),
  };
  let own: { vcpu?: number; memGiB?: number; diskGiB?: number } = {};
  try {
    own = readCompute(configMatter(fs.readFileSync(path.join(accountDir(tenant), "AGENTS.md"), "utf8")).data?.compute).value;
  } catch {
    // no account file — nothing of its own
  }
  const vcpu = lower(ceiling.vcpu, positive(own.vcpu));
  const memGiB = lower(ceiling.memGiB, positive(own.memGiB));
  const diskGiB = lower(ceiling.diskGiB, positive(own.diskGiB));
  const lowered =
    (own.vcpu !== undefined && vcpu === own.vcpu && vcpu !== ceiling.vcpu) ||
    (own.memGiB !== undefined && memGiB === own.memGiB && memGiB !== ceiling.memGiB) ||
    (own.diskGiB !== undefined && diskGiB === own.diskGiB && diskGiB !== ceiling.diskGiB);
  const fromPlan = positive(plan?.vcpu) !== null || positive(plan?.memGiB) !== null || positive(plan?.diskGiB) !== null;
  return {
    vcpu,
    memGiB,
    diskGiB,
    stepVcpu: positive(plan?.stepVcpu) ?? positive(env.FOLDRUN_STEP_MAX_VCPU),
    stepMemGiB: positive(plan?.stepMemGiB) ?? positive(env.FOLDRUN_STEP_MAX_MEMORY_GIB),
    stepDiskGiB: positive(plan?.stepDiskGiB) ?? positive(env.FOLDRUN_STEP_MAX_DISK_GIB),
    source: vcpu === null && memGiB === null && diskGiB === null ? null : lowered ? "account" : fromPlan ? "plan" : "install",
  };
}

/** A pool's three figures; null is no cap of its own. */
export interface ComputePool {
  vcpu: number | null;
  memGiB: number | null;
  diskGiB: number | null;
}

const poolOf = (raw: unknown): ComputePool => {
  const c = readCompute(raw).value;
  return { vcpu: positive(c.vcpu), memGiB: positive(c.memGiB), diskGiB: positive(c.diskGiB) };
};

/** A workspace's own pool (27 Oct 2026): `compute:` in its AGENTS.md — what
 *  the steps running in it may hold together. It only narrows the account's:
 *  a figure above the account's grants nothing, since every step must also
 *  fit the account's pool. Null figures: no cap of its own. */
export function workspaceCompute(tenant: string, workspace: string): ComputePool {
  try {
    return poolOf(configMatter(fs.readFileSync(path.join(workspaceDir(tenant, workspace), "AGENTS.md"), "utf8")).data?.compute);
  } catch {
    return { vcpu: null, memGiB: null, diskGiB: null };
  }
}

/** A run's own pool: its flow's `compute:` as copied onto the run when it
 *  was first driven (core runner.ts). */
export function runCompute(run: { compute?: { vcpu?: number; memGiB?: number; diskGiB?: number } | null }): ComputePool {
  const c = run.compute ?? {};
  return { vcpu: positive(c.vcpu), memGiB: positive(c.memGiB), diskGiB: positive(c.diskGiB) };
}

/** What the account's running steps hold now, from their records: each
 *  step's `holding`, set once its sandbox is past the room gate and cleared
 *  when the attempt ends — so a step still waiting for room holds nothing.
 *  Read from the run records rather than the cluster, so it is the same on
 *  a Docker install as on k8s; the room gate itself counts the pods.
 *  `workspaces` limits it to a scoped caller's (null is every workspace). */
export function computeInUse(tenant: string, workspaces: readonly string[] | null = null): { vcpu: number; memGiB: number; diskGiB: number; steps: number } {
  return computeHeld(tenant, workspaces).total;
}

/** What a scope's running steps hold, from their records. */
export interface HeldFigures {
  vcpu: number;
  memGiB: number;
  diskGiB: number;
  steps: number;
}

const round = (h: HeldFigures): HeldFigures => ({ vcpu: Number(h.vcpu.toFixed(2)), memGiB: Number(h.memGiB.toFixed(2)), diskGiB: Number(h.diskGiB.toFixed(2)), steps: h.steps });

/** computeInUse at every level (27 Oct 2026): the account's total, each
 *  workspace's, and each live run's — with the run's own pool beside it,
 *  for runs whose flow set one or that hold anything. */
export function computeHeld(tenant: string, workspaces: readonly string[] | null = null): {
  total: HeldFigures;
  workspaces: Record<string, HeldFigures>;
  runs: { workspace: string; runId: string; flow: string; pool: ComputePool; inUse: HeldFigures }[];
} {
  const zero = (): HeldFigures => ({ vcpu: 0, memGiB: 0, diskGiB: 0, steps: 0 });
  const total = zero();
  const byWs: Record<string, HeldFigures> = {};
  const runs: { workspace: string; runId: string; flow: string; pool: ComputePool; inUse: HeldFigures }[] = [];
  for (const ws of listWorkspaces(tenant)) {
    if (workspaces && !workspaces.includes(ws.name)) continue;
    const w = (byWs[ws.name] = zero());
    for (const run of liveRuns(tenant, ws.name)) {
      const r = zero();
      for (const s of run.steps) {
        if (s.status !== "running" || !s.holding) continue;
        for (const h of [total, w, r]) {
          h.vcpu += s.holding.cpus;
          h.memGiB += s.holding.memGiB;
          h.diskGiB += s.holding.diskGiB ?? 0;
          h.steps += 1;
        }
      }
      const pool = runCompute(run);
      if (r.steps || pool.vcpu !== null || pool.memGiB !== null || pool.diskGiB !== null) {
        runs.push({ workspace: ws.name, runId: run.id, flow: run.flow, pool, inUse: round(r) });
      }
    }
    byWs[ws.name] = round(w);
  }
  return { total: round(total), workspaces: byWs, runs };
}

/** One step waiting for room, as its record says. */
export interface RoomWaitRow {
  workspace: string;
  runId: string;
  flow: string;
  step: number;
  agent: string;
  since: string;
  why: string;
  cpus: number;
  memGiB: number;
  diskGiB: number;
  /** The cap that held it back when it last looked — run, workspace,
   *  account or node; absent when it waited its turn. An explanation only:
   *  the room gate judges every waiter afresh. */
  level?: RoomLevel;
  /** Its run's own pool (the flow's compute:, copied onto the run). */
  runPool: ComputePool;
}

/** The account's steps waiting for room to start, from their records
 *  (`roomWait`, 27 Oct 2026): those waiting in a driver and those whose
 *  runs wait in the queue for it. Oldest first. What the room gate's fair
 *  order reads, and what Settings and `foldrun usage compute` show. */
export function roomWaiting(tenant: string, workspaces: readonly string[] | null = null): RoomWaitRow[] {
  const out: RoomWaitRow[] = [];
  for (const ws of listWorkspaces(tenant)) {
    if (workspaces && !workspaces.includes(ws.name)) continue;
    for (const run of liveRuns(tenant, ws.name)) {
      run.steps.forEach((s, step) => {
        if ((s.status !== "running" && s.status !== "pending") || !s.roomWait) return;
        const w = s.roomWait;
        out.push({
          workspace: ws.name, runId: run.id, flow: run.flow, step, agent: s.agent,
          since: w.since, why: w.why, cpus: w.cpus, memGiB: w.memGiB, diskGiB: w.diskGiB ?? 0,
          ...(w.level ? { level: w.level } : {}),
          runPool: runCompute(run),
        });
      });
    }
  }
  return out.sort((a, b) => Date.parse(a.since) - Date.parse(b.since) || `${a.runId}#${a.step}`.localeCompare(`${b.runId}#${b.step}`));
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
