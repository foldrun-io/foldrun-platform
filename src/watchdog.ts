// The three things nobody is told about, because nothing happened.
//
// A run notification fires when a run finishes or parks. Every failure mode
// underneath that is silent by construction:
//
//   a gate nobody answered      the run is "waiting", forever, holding a slot
//   a run far past its `sla:`   the run is "running", and looks fine
//   a budget nearly spent       nothing at all, until work starts being refused
//
// None of them is an error, which is exactly why none of them alerted
// anyone. This module is the tick that notices, and it says something once
// per occurrence rather than once per tick — an alarm that repeats every
// thirty seconds gets muted, and a muted alarm is the same as none.
//
// It is called from the scheduler's tick as housekeeping: a failure here
// must never stop a flow from firing.

import { getNotice, setNotice, pruneNotices, resetNotices } from "./notices.ts";
import {
  listTenants,
  listWorkspaces,
  listRunSummaries,
  readRun,
  readFlow,
  runCost,
  listAgents,
  type RunRecord,
  type RunSummary,
} from "../../foldrun-core/src/store.ts";
import { agentLastRuns } from "../../foldrun-core/src/agent-activity.ts";
import { sweepRunTraces, pruneTraceClaims } from "./otel-export.ts";
import fs from "node:fs";
import path from "node:path";
import { expireStaleGate } from "../../foldrun-core/src/approvals.ts";
import { sendPlainNotification, sendPlainNotificationOutcome } from "../../foldrun-core/src/notify.ts";
import { workspaceBudget, workspaceWindowSpendUsd, accountBudget, accountWindowSpendUsd, budgetCalendar } from "./limits.ts";
import { windowStartMs, windowName, windowTurnsHint, formatBudget } from "../../foldrun-core/src/budget.ts";
import { checkAccountProviders, type ProviderCheck } from "../../foldrun-core/src/provider-health.ts";
import { parseAlerts, evaluateAlerts } from "../../foldrun-core/src/alerts.ts";
import { readAgentsMd } from "../../foldrun-core/src/runner.ts";
import { accountDir, workspaceDir, runDisplayStatus, runVerdict } from "../../foldrun-core/src/store.ts";
import { outcomeOf } from "../../foldrun-core/src/outcome.ts";
import { readLedger } from "./ledger.ts";

/** Fractions of a budget worth a warning. Two, not five: the first is "plan
 *  the rest of the month", the second is "this stops soon". More than that
 *  and the warnings become the noise they exist to cut through. */
const BUDGET_MARKS = [0.8, 0.95];

/** What the provider check keeps per account. */
interface ProviderNotice {
  checkedAt: number;
  results: (ProviderCheck & { declaredIn: string })[];
  reported: string[];
}

/**
 * One pass over every account. Returns what it did, for the log and the
 * test; never throws, because it runs inside the scheduler's tick.
 *
 * NOT every tick. listRuns parses every run file in a workspace, and a scan
 * of every workspace every thirty seconds is exactly what the scheduler's
 * reconcile is deliberately kept off the tick for. The caller spaces it the
 * same way the reconcile is spaced; a gate expiring or an SLA tripping a
 * few minutes late costs nothing, a filesystem walk twice a minute does.
 */
let sweeping = false;

export async function sweepGatesAndSlas(now = Date.now()): Promise<{
  expired: number;
  slaBreached: number;
  budgetWarned: number;
  providersChecked: number;
  alerted?: number;
  roomWaits?: number;
}> {
  // One at a time. A provider check waits up to fifteen seconds per
  // endpoint, serially, and its state is written only when the account's
  // checks finish — a second sweep starting meanwhile would read the old
  // state, check the same providers again and mail the same alert twice.
  if (sweeping) return { expired: 0, slaBreached: 0, budgetWarned: 0, providersChecked: 0 };
  sweeping = true;
  try {
    return await sweepOnce(now);
  } finally {
    sweeping = false;
  }
}

async function sweepOnce(now: number) {
  let expired = 0;
  let slaBreached = 0;
  let budgetWarned = 0;
  let providersChecked = 0;
  let alerted = 0;
  let roomWaits = 0;

  for (const tenant of safely(() => listTenants(), [])) {
    if (await checkProvidersDaily(tenant, now)) providersChecked++;
    if (await warnOnAccountBudget(tenant, now)) budgetWarned++;
    for (const ws of safely(() => listWorkspaces(tenant), [])) {
      const workspace = ws.name;
      if (await warnOnBudget(tenant, workspace, now)) budgetWarned++;
      alerted += await safelyAsync(() => warnOnAlerts(tenant, workspace, now), 0);
      // telemetry: — traces of finished runs the worker did not send. Not
      // awaited: a slow collector must not hold gate expiry and SLAs below.
      void safelyAsync(() => sweepRunTraces(tenant, workspace, safely(() => listRunSummaries(tenant, workspace), []), (id) => safely(() => readRun(tenant, workspace, id), null), now), 0);
      for (const summary of safely(() => listRunSummaries(tenant, workspace), [])) {
        if (summary.status !== "awaiting-approval" && summary.status !== "running" && summary.status !== "queued") continue;
        const run = safely(() => readRun(tenant, workspace, summary.id), null);
        if (!run) continue;
        if (await reportRoomWait(tenant, workspace, run, now)) roomWaits++;
        if (summary.status === "queued") continue;
        if (await expireGate(tenant, workspace, run, now)) expired++;
        else if (await reportSla(tenant, workspace, run, now)) slaBreached++;
      }
    }
  }
  await safelyAsync(() => pruneNotices("alert", now - 7 * 86_400_000), undefined);
  await safelyAsync(() => pruneTraceClaims(now), undefined);
  return { expired, slaBreached, budgetWarned, providersChecked, alerted, roomWaits };
}

const DAY_MS = 86_400_000;

/**
 * `alerts:` (FOL-72 step 7): the thresholds a workspace asked to hear about —
 * its failure rate and the credits it was charged over the last 24 hours,
 * and any run going past a time — told to its `notify:` as event `alert`,
 * each rule at most once a day and each slow run once. Returns how many it sent.
 */
async function warnOnAlerts(tenant: string, workspace: string, now: number): Promise<number> {
  const front = readAgentsMd(workspaceDir(tenant, workspace))?.data?.alerts !== undefined
    ? readAgentsMd(workspaceDir(tenant, workspace))!.data
    : (readAgentsMd(accountDir(tenant))?.data ?? {});
  const { config } = parseAlerts(front.alerts);
  if (!config) return 0;
  const since = new Date(now - DAY_MS).toISOString();
  const runs = safely(() => listRunSummaries(tenant, workspace), []);
  const recent = runs.filter((r) => r.startedAt >= since && !r.test);
  const chargedUsd = config.creditsDay === undefined
    ? 0
    : (await safelyAsync(() => readLedger(tenant), [])).filter((e) => e.kind === "run" && e.workspace === workspace && e.t >= since).reduce((n, e) => n + Math.max(0, -e.usd), 0);
  const alerts = evaluateAlerts(
    config,
    {
      outcomes: recent.map((r) => outcomeOf(runDisplayStatus(r as unknown as RunRecord), runVerdict(r as unknown as RunRecord))),
      chargedUsd,
      live: runs.filter((r) => r.status === "running" && !r.test).map((r) => ({ id: r.id, flow: r.flow, startedAt: r.startedAt })),
      ...(config.staleDays !== undefined ? { agents: agentFacts(tenant, workspace, runs) } : {}),
      ...(config.costSpike !== undefined || config.runsPerHour !== undefined
        ? {
            runs: runs
              .filter((r) => !r.test && Date.parse(r.startedAt) >= now - 7 * DAY_MS)
              .map((r) => ({ id: r.id, flow: r.flow, startedAt: r.startedAt, finishedAt: r.finishedAt, costUsd: (r.steps ?? []).reduce((n, st) => n + (st.costUsd ?? 0), 0) })),
          }
        : {}),
    },
    workspace,
    now,
  );
  let sent = 0;
  for (const a of alerts) {
    const scope = `${workspace}/${a.key}`;
    const seen = (await getNotice<{ at: number }>(tenant, "alert", scope))?.payload;
    // A rate or a day's spend once a day; a slow run or an idle spell once
    // (the notice is pruned after a week, so a lasting one comes back weekly).
    if (seen && (a.runId || a.once || now - seen.at < DAY_MS)) continue;
    // Remembered only once it arrived, or a webhook retry holds it: a send
    // that failed, or a notify: not set up yet, is tried again next sweep
    // rather than silenced for a day — or, for a slow run, for good (Codex review).
    const outcome = await sendPlainNotificationOutcome(tenant, workspace, { event: "alert", headline: a.headline, detail: a.detail, ...(a.flow ? { flow: a.flow } : {}), ...(a.runId ? { runId: a.runId } : {}) }).catch(() => ({ ok: false, retrying: false }));
    if (!outcome.ok && !outcome.retrying) continue;
    await setNotice(tenant, "alert", scope, { at: now }, now);
    console.log(`[watchdog] ${tenant}/${workspace}: alert ${a.key}`);
    sent++;
  }
  return sent;
}

/** Each agent, when it last ran, and since when its file has said what it
 *  says — an agent written yesterday is not stale for never having run. */
function agentFacts(tenant: string, workspace: string, runs: RunSummary[]) {
  const last = agentLastRuns(runs);
  return safely(() => listAgents(tenant, workspace), []).map((a) => {
    let since = new Date(0).toISOString();
    try {
      since = fs.statSync(path.join(workspaceDir(tenant, workspace), "agents", a.name, "agent.md")).mtime.toISOString();
    } catch {
      /* no file time: counted from the epoch, as an agent nobody touched */
    }
    return { name: a.name, lastRunAt: last.get(a.name) ?? null, since };
  });
}

/** How often a key is asked whether it still works. Once a day: a key that
 *  dies is found the same morning, and the whole year's checking costs less
 *  than one ordinary run. */
const PROVIDER_EVERY_MS = 24 * 3600_000;

/**
 * Ask each of this account's model providers whether it still takes our key,
 * at most once a day. Returns whether it checked.
 *
 * Only newly-broken providers are reported. A key that was dead yesterday
 * and is dead today is not news, and an alert that repeats every morning is
 * an alert people filter.
 */
export async function checkProvidersDaily(tenant: string, now = Date.now()): Promise<boolean> {
  const last = (await getNotice<ProviderNotice>(tenant, "provider", ""))?.payload;
  if (last && now - last.checkedAt < PROVIDER_EVERY_MS) return false;

  let results: (ProviderCheck & { declaredIn: string })[];
  try {
    results = await checkAccountProviders(tenant);
  } catch (err) {
    console.error(`[watchdog] provider check for ${tenant}:`, err instanceof Error ? err.message : err);
    return false;
  }
  // Nothing to check is a fact worth recording: it stops the account being
  // re-examined every tick, and it is the answer for an account that uses
  // the platform's own credential.
  const broken = results.filter((r) => !r.ok);
  const previously = new Set(last?.reported ?? []);
  const idOf = (r: ProviderCheck & { declaredIn: string }) => `${r.declaredIn}|${r.provider}|${r.verdict}`;
  const fresh = broken.filter((r) => !previously.has(idOf(r)));

  await setNotice(tenant, "provider", "", { checkedAt: now, results, reported: broken.map(idOf) } satisfies ProviderNotice, now);

  if (fresh.length) {
    const first = safely(() => listWorkspaces(tenant), [])[0]?.name;
    if (first) {
      await sendPlainNotification(tenant, first, {
        event: "provider",
        headline: `\u26a0 ${fresh.length === 1 ? "A model provider is" : `${fresh.length} model providers are`} not answering`,
        detail: fresh
          .map((r) => `${r.provider} (${r.declaredIn}, model ${r.model}): ${r.detail}`)
          .join(" · "),
      }).catch(() => false);
    }
    for (const r of fresh) {
      console.log(`[watchdog] ${tenant}: provider ${r.provider} in ${r.declaredIn} — ${r.verdict}: ${r.detail}`);
    }
  }
  return true;
}

/** The last check, for the page that shows it. Null when none has run. */
export async function lastProviderCheck(
  tenant: string,
): Promise<{ checkedAt: string; results: (ProviderCheck & { declaredIn: string })[] } | null> {
  const entry = (await getNotice<ProviderNotice>(tenant, "provider", ""))?.payload;
  return entry ? { checkedAt: new Date(entry.checkedAt).toISOString(), results: entry.results } : null;
}

/** Force one now, whatever the daily clock says — the button on the page. */
export async function checkProvidersNow(tenant: string, now = Date.now()) {
  const entry = (await getNotice<ProviderNotice>(tenant, "provider", ""))?.payload;
  if (entry) {
    // Only the clock is reset. `reported` stays, so pressing the button does
    // not re-announce every provider that was already known to be broken.
    await setNotice(tenant, "provider", "", { ...entry, checkedAt: 0 }, now);
  }
  await checkProvidersDaily(tenant, now);
  return lastProviderCheck(tenant);
}

/** `approve_within:` came and went. The gate is rejected, the run fails, and
 *  whoever was meant to answer is told what they missed. */
async function expireGate(tenant: string, workspace: string, run: RunRecord, now: number): Promise<boolean> {
  let did = false;
  try {
    did = await expireStaleGate(tenant, workspace, run, now);
  } catch (err) {
    console.error(`[watchdog] expiring ${tenant}/${workspace}/${run.id}:`, err instanceof Error ? err.message : err);
    return false;
  }
  if (!did) return false;
  console.log(`[watchdog] ${tenant}/${workspace}/${run.id}: gate expired, run rejected`);
  await sendPlainNotification(tenant, workspace, {
    event: "failed",
    headline: `⏰ ${run.flow} was rejected — nobody answered its gate`,
    detail: `the flow's approve_within: expired at ${run.approveBy}; the run has failed rather than keep waiting`,
    flow: run.flow,
    runId: run.id,
  }).catch(() => false);
  return true;
}

/**
 * A run well past what its flow said it should take.
 *
 * Reported once and then left alone — deliberately not stopped. `sla:` is an
 * expectation, and the platform sets no clock of its own; a run that is
 * slow may still be doing the work, and killing it on a number in a file
 * would be a timeout by another name. The person decides.
 */
async function reportSla(tenant: string, workspace: string, run: RunRecord, now: number): Promise<boolean> {
  if (run.status !== "running") return false;
  const sla = safely(() => readFlow(tenant, workspace, run.flow)?.sla ?? null, null);
  if (!sla) return false;
  const elapsed = (now - new Date(run.startedAt).getTime()) / 1000;
  if (elapsed < sla) return false;

  const scope = `${workspace}/${run.id}`;
  if (await getNotice(tenant, "sla", scope)) return false;
  await setNotice(tenant, "sla", scope, now, now);
  // Forget runs that are long gone, so the list does not grow with every
  // slow run there has ever been. A week is far past any run's lifetime.
  await pruneNotices("sla", now - 7 * 86400_000);
  const step = run.steps.find((s) => s.status === "running");
  await sendPlainNotification(tenant, workspace, {
    event: "sla",
    headline: `⏳ ${run.flow} is taking longer than expected`,
    detail:
      `running ${Math.round(elapsed / 60)} minutes against an sla: of ${Math.round(sla / 60)}` +
      `${step ? `, currently at ${step.agent}` : ""}. It has not been stopped — $${runCost(run).toFixed(2)} so far.`,
    flow: run.flow,
    runId: run.id,
  }).catch(() => false);
  console.log(`[watchdog] ${tenant}/${workspace}/${run.id}: past its sla (${Math.round(elapsed)}s of ${sla}s)`);
  return true;
}

/** How long a step may wait for room before notify: hears of it:
 *  FOLDRUN_ROOM_ALERT_MIN, default 60. */
function roomAlertMs() {
  const n = Number(process.env.FOLDRUN_ROOM_ALERT_MIN);
  return Number.isFinite(n) && n > 0 ? n * 60_000 : 60 * 60_000;
}

/**
 * A run waiting an hour for room to start (27 Oct 2026). Waiting is not a
 * failure — it keeps its place and starts when there is room — but an hour
 * of it is a decision someone should get to make: ask for less, or allow
 * the account more. Once per run. Read off the record, so a run parked in
 * the queue is told about whether or not a worker has claimed it since.
 */
async function reportRoomWait(tenant: string, workspace: string, run: RunRecord, now: number): Promise<boolean> {
  const waiting = run.steps.filter((s) => (s.status === "pending" || s.status === "running") && s.roomWait);
  if (!waiting.length) return false;
  const first = waiting.reduce((a, b) => (Date.parse(b.roomWait!.since) < Date.parse(a.roomWait!.since) ? b : a));
  const waited = now - Date.parse(first.roomWait!.since);
  if (!(waited >= roomAlertMs())) return false;
  const scope = `${workspace}/${run.id}`;
  if (await getNotice(tenant, "room", scope)) return false;
  // Remembered as told once it was — or once a webhook's delivery log holds
  // it for another attempt, so a sweep never starts a second chain (Codex
  // review). A destination that refused outright hears of it next sweep.
  const outcome = await sendPlainNotificationOutcome(tenant, workspace, {
    event: "room",
    headline: `⏳ ${run.flow} is waiting for room to start`,
    detail:
      `${first.agent} has waited ${Math.round(waited / 60_000)} minutes — ${first.roomWait!.why}. ` +
      `It keeps its place in line and starts when there is room; nothing is charged while it waits. ` +
      `To start it sooner, ask for less (size:, resources:) or allow the account more compute.`,
    flow: run.flow,
    runId: run.id,
  }).catch(() => ({ ok: false, retrying: false }));
  if (!outcome.ok && !outcome.retrying) return false;
  await setNotice(tenant, "room", scope, now, now);
  await pruneNotices("room", now - 7 * DAY_MS);
  console.log(`[watchdog] ${tenant}/${workspace}/${run.id}: waiting ${Math.round(waited / 1000)}s for room`);
  return true;
}

/**
 * A budget most of the way spent.
 *
 * The cap itself has always worked: past it, new runs are refused. The
 * problem is how a customer finds out — by a desk failing to start on a
 * Tuesday. A warning at each mark turns that into a decision they get to
 * make in advance. Each mark warns once per WINDOW — today's, this week's,
 * this month's, whichever the cap is over — and the window is named by the
 * instant it began, so a new day is a clean slate exactly when the cap
 * itself resets.
 */
async function warnOnBudget(tenant: string, workspace: string, now: number): Promise<boolean> {
  const cap = safely(() => workspaceBudget(tenant, workspace), null);
  if (!cap) return false;
  const spent = await safelyAsync(() => workspaceWindowSpendUsd(tenant, workspace, cap.period), 0);
  const fraction = spent / cap.usd;
  const mark = [...BUDGET_MARKS].reverse().find((m) => fraction >= m);
  if (!mark) return false;

  const month = windowKey(cap.period, budgetCalendar(tenant, workspace), now);
  const seen = (await getNotice<{ month: string; mark: number }>(tenant, "budget", workspace))?.payload;
  if (seen && seen.month === month && seen.mark >= mark) return false;
  await setNotice(tenant, "budget", workspace, { month, mark }, now);

  await sendPlainNotification(tenant, workspace, {
    event: "budget",
    headline: `⚠ ${workspace} has spent ${Math.round(mark * 100)}% of its budget ${windowName(cap.period)}`,
    detail:
      `$${spent.toFixed(2)} of ${formatBudget(cap)} (budget: in the workspace AGENTS.md). ` +
      `At the cap, new runs are refused — raise it or ${windowTurnsHint(cap.period)}.`,
  }).catch(() => false);
  console.log(`[watchdog] ${tenant}/${workspace}: budget ${Math.round(fraction * 100)}% spent`);
  return true;
}

/** The window a warning belongs to, as the instant it began — the state
 *  file's `month` field, which predates windows and keeps its name so old
 *  state still reads. */
function windowKey(period: "day" | "week" | "month" | "run", timeZone: string, now: number): string {
  const start = windowStartMs(period, timeZone, new Date(now));
  return start === null ? "run" : new Date(start).toISOString();
}

/** The same warning, for the cap that covers everything. Kept separate
 *  rather than parameterised because the two read different files, are
 *  measured against different totals, and say different sentences — and the
 *  account one is the cap that stops every desk at once. */
async function warnOnAccountBudget(tenant: string, now: number): Promise<boolean> {
  const cap = safely(() => accountBudget(tenant), null);
  if (!cap) return false;
  const spent = await safelyAsync(() => accountWindowSpendUsd(tenant, cap.period), 0);
  const fraction = spent / cap.usd;
  const mark = [...BUDGET_MARKS].reverse().find((m) => fraction >= m);
  if (!mark) return false;

  const month = windowKey(cap.period, budgetCalendar(tenant), now);
  const seen = (await getNotice<{ month: string; mark: number }>(tenant, "budget", ""))?.payload;
  if (seen && seen.month === month && seen.mark >= mark) return false;
  await setNotice(tenant, "budget", "", { month, mark }, now);

  const first = safely(() => listWorkspaces(tenant), [])[0]?.name;
  if (!first) return false;
  await sendPlainNotification(tenant, first, {
    event: "budget",
    headline: `⚠ this account has spent ${Math.round(mark * 100)}% of its budget ${windowName(cap.period)}`,
    detail:
      `$${spent.toFixed(2)} of ${formatBudget(cap)} (budget: in the account AGENTS.md). ` +
      `At the cap, every workspace stops starting new runs — raise it or ${windowTurnsHint(cap.period)}.`,
  }).catch(() => false);
  console.log(`[watchdog] ${tenant}: account budget ${Math.round(fraction * 100)}% spent`);
  return true;
}

function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

async function safelyAsync<T>(fn: () => Promise<T> | T, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/** Exported for the test, which needs a clean slate between cases. */
export async function resetWatchdogState(): Promise<void> {
  await resetNotices();
}
