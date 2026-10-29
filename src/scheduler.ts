// Cron scheduler for flows with `trigger: schedule`.
//
// A single interval ticks every 30s, scans every tenant's flows, and starts
// any flow whose cron expression matched since its last fire. Last-fire
// times are the platform's cursor on each flow (flow-state.ts: a row per
// flow, or data/schedule.json without a database) so restarts don't replay
// history.
//
// Deliberately dependency-free: a 5-field cron parser is ~40 lines and this
// avoids pulling a scheduling library into the platform for one feature.

import { maybeRunJanitor, warmWorkspace } from "./runtime-warm.ts";
import fs from "node:fs";
import path from "node:path";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { DOW_NAMES, parseCron, type Cron } from "../../foldrun-core/src/cron.ts";
import { loadScheduleState, saveScheduleState, type ScheduleState } from "./flow-state.ts";
import { listWorkspaces, listFlows, listTenants, type FlowInfo } from "../../foldrun-core/src/store.ts";
import { reconcileAllRuns } from "../../foldrun-core/src/runner.ts";
import { enqueueFlowRun, liveClaimedRuns, afterReconciled } from "./queue.ts";
import { databaseEnabled } from "./db.ts";
import { cache, cacheEnabled, releaseLease, takeLease } from "./cache.ts";
import { flowHasLiveRun } from "../../foldrun-core/src/store.ts";
import { sweepFinishedRunPods, reapOrphanRunPods } from "./run-k8s.ts";
import { listRunSummaries, readRun } from "../../foldrun-core/src/store.ts";

/** Every run's state by id, read once per sweep: live, over, or unknown.
 *  Off the run index — but "over" is what lets a pod be deleted, so before
 *  answering it for a run the record itself is read: a stale row must never
 *  kill a live step. Only the runs a sweep asks about (those with pods) are
 *  read, once each. */
export function runStateById(): (runId: string) => "live" | "over" | "unknown" {
  const where = new Map<string, { tenant: string; workspace: string; state: "live" | "over" | "checked-over" }>();
  for (const tenant of listTenants()) {
    for (const ws of listWorkspaces(tenant)) {
      for (const r of listRunSummaries(tenant, ws.name)) {
        where.set(r.id, { tenant, workspace: ws.name, state: isLive(r) ? "live" : "over" });
      }
    }
  }
  return (id) => {
    const w = where.get(id);
    if (!w) return "unknown";
    if (w.state === "live") return "live";
    if (w.state === "over") {
      const run = readRun(w.tenant, w.workspace, id);
      if (!run) {
        where.delete(id);
        return "unknown";
      }
      w.state = isLive(run) ? "live" : "checked-over";
      if (w.state === "live") return "live";
    }
    return "over";
  };
}

const isLive = (r: { status: string; stopRequested?: boolean }) =>
  (r.status === "running" || r.status === "queued" || r.status === "awaiting-approval") && !r.stopRequested;
import { reapIdleSearchPods } from "./search-k8s.ts";
import { busyAccountSegments, segmentIndex } from "./account-pod.ts";
import { withHousekeeping } from "./housekeeping.ts";
import { reapIdleBrowserPods } from "./browser-k8s.ts";
import { withTask } from "../../foldrun-core/src/triggers.ts";
import { admitTrigger, rollbackTrigger, dueDebounced } from "./trigger-gate.ts";
import { recordTriggerEvent } from "../../foldrun-core/src/trigger-log.ts";
import { adminState, pauseWindows } from "./admin.ts";
import { sweepGatesAndSlas } from "./watchdog.ts";
import { rescanPass } from "./rescan.ts";
import { gradePass, describePass, setAfterGrades, setEachAccount } from "./grade-pass.ts";
import { improveWorkspace, settleAccount } from "./improve.ts";

// After a workspace is graded: settle its drafting proposals and open one for
// each grader whose failures are due (improve.ts).
setAfterGrades(async (tenant, workspace, graders, now) => {
  await improveWorkspace(tenant, workspace, graders, now);
});
// Every account, graders or not: drafts copied in before their job files are swept.
setEachAccount((tenant, now) => settleAccount(tenant, now));
import { maybeSampleStatus } from "./status.ts";
import crypto from "node:crypto";
import { fetchPublic } from "./ssrf.ts";
import { sweepWebhookDeliveries } from "./webhook-deliveries.ts";
import { settingsEnv } from "./settings.ts";

const TICK_MS = 30_000;

// How often the same interval also closes out abandoned runs. Reconciliation
// used to happen only when the server booted, which assumed the only way to
// abandon a run was for the process to die. It isn't: a step can stop
// emitting — a container that never exits, a model call that never settles —
// while the server carries on serving pages, and nothing then closes the run.
// One was found five hours idle and still rendering as live.
//
// It reads every run file, so it does not belong on the 30s tick. A tenth of
// them is every five minutes, well inside the 30-minute idle window.
export const RECONCILE_EVERY = 10;
let ticksSinceReconcile = 0;
/** Set by the reconcile pass and consumed by the tick that ran it: the
 *  gate/SLA sweep rides the same cadence for the same reason. */
let sweepDue = false;

/** How far back a `once` flow's `at:` may lie at first sighting and still
 *  fire. A deploy of a flow whose moment passed last week is a stale file,
 *  not a request; a platform that was down for an hour is a missed fire. */
const ONCE_CATCHUP_MS = 6 * 3600_000;
const WATCH_DEFAULT_SECS = 15 * 60;
const WATCH_MAX_BYTES = 200_000;
/** The most a watched page may be, read, before its first WATCH_MAX_BYTES
 *  are kept: a large page is still watched, an endless one is not read. */
const WATCH_FETCH_MAX_BYTES = 8 * 1024 * 1024;

/**
 * `trigger: watch` — read the URL when it is due and say whether it changed.
 * Exported for the test; the tick calls it with a real fetch.
 */
export async function checkWatches(
  now: Date,
  state: ScheduleState,
  tenants: string[],
  read: (url: string) => Promise<string | null> = fetchText,
  source: FlowSource = scanSource,
): Promise<{ tenant: string; workspace: string; flow: FlowInfo; body: string }[]> {
  state.watches ??= {};
  const watches = state.watches;
  const todo: { tenant: string; workspace: string; flow: FlowInfo; key: string }[] = [];
  for (const tenant of tenants) {
    for (const workspace of source(tenant)) {
      for (const flow of workspace.flows) {
        if (flow.trigger !== "watch" || !flow.url || flow.steps.length === 0) continue;
        if (!/^https?:\/\//.test(flow.url)) continue;
        const key = `${tenant}/${workspace.workspace}/${flow.name}`;
        const every = (flow.every ?? WATCH_DEFAULT_SECS) * 1000;
        const prev = watches[key];
        if (prev && now.getTime() - new Date(prev.checkedAt).getTime() < every) continue;
        todo.push({ tenant, workspace: workspace.workspace, flow, key });
      }
    }
  }
  // Several at once: one at a time, a tick with thirty watches behind an
  // 8-second timeout each outran its own 30-second interval. Results keep
  // the order the watches were found in, whichever answers first.
  const results: ({ tenant: string; workspace: string; flow: FlowInfo; body: string } | null)[] = new Array(todo.length).fill(null);
  let next = 0;
  const lane = async () => {
    for (let i = next++; i < todo.length; i = next++) {
      const t = todo[i];
      const prev = watches[t.key];
      const body = await read(t.flow.url!);
      if (body === null) continue; // unreachable this time; try again next interval
      const hash = crypto.createHash("sha256").update(body).digest("hex");
      watches[t.key] = { checkedAt: now.toISOString(), hash };
      // First sighting records, never fires: "it exists" is not a change.
      if (prev && prev.hash !== hash) results[i] = { tenant: t.tenant, workspace: t.workspace, flow: t.flow, body };
    }
  };
  await Promise.all(Array.from({ length: Math.min(WATCH_PARALLEL, todo.length) }, lane));
  return results.filter((r): r is NonNullable<typeof r> => r !== null);
}

/** Watch URLs read at once in a tick. */
const WATCH_PARALLEL = 8;

/**
 * How long after its minute a scheduled flow is let into the queue:
 * FOLDRUN_SCHEDULE_SPREAD_SEC (unset is 0, at once). The same offset for
 * the same flow every time — a hash, not a die roll — so an 8:00 desk is an
 * 8:00:23 desk every morning, and fifty desks that all say 8:00 arrive over
 * the minute instead of in one instant behind the same slots.
 */
export function scheduleSpreadMs(key: string, env = settingsEnv()): number {
  const spread = Number(env.FOLDRUN_SCHEDULE_SPREAD_SEC);
  if (!Number.isFinite(spread) || spread <= 0) return 0;
  const window = Math.round(spread * 1000);
  if (window <= 0) return 0; // under a millisecond: no spread, and never h % 0
  const h = crypto.createHash("sha256").update(key).digest().readUInt32BE(0);
  return h % window;
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetchPublic(url, { signal: AbortSignal.timeout(8000), headers: { "user-agent": "foldrun-watch" } }, { maxBytes: WATCH_FETCH_MAX_BYTES });
    if (!res.ok) return null;
    const text = await res.text();
    return text.slice(0, WATCH_MAX_BYTES);
  } catch {
    return null;
  }
}

// ---- the catalogue ----
//
// What a tick reads. It used to walk the disk: every tenant, every
// workspace (with its description and run count), every flow file, every
// 30 seconds. On one box with six desks that is nothing; on a shared
// filesystem with thousands of accounts it is thousands of round trips a
// tick, and the tick outruns its own interval. So the flows live here, in
// the process that holds the lease: rebuilt in full on a slow rescan, and
// patched the moment a workspace changes — every write, deploy, push and
// delete goes through core, and core tells the platform (workspaceChanged),
// which marks the workspace dirty. Across pods the mark travels through
// Redis; in one process a set is enough. The rescan is the safety net for
// a path that forgot to say so: bounded staleness, never a lost schedule.
export interface WorkspaceFlows {
  workspace: string;
  flows: FlowInfo[];
}
export type FlowSource = (tenant: string) => WorkspaceFlows[];

const RESCAN_MS = Number(process.env.FOLDRUN_SCHEDULE_RESCAN_MS) || 5 * 60_000;
const DIRTY_KEY = "sched:dirty";
const catalogue = new Map<string, Map<string, FlowInfo[]>>();
let catalogueBuiltAt = 0;
const dirtyLocal = new Set<string>();

/** Read one workspace's flows off the disk. */
function readWorkspaceFlows(tenant: string, workspace: string): FlowInfo[] {
  return listFlows(tenant, workspace);
}

/** The disk, as a source — what the catalogue is built from, and what the
 *  tests and a local install read directly. */
export const scanSource: FlowSource = (tenant) =>
  listWorkspaces(tenant).map((w) => ({ workspace: w.name, flows: readWorkspaceFlows(tenant, w.name) }));

/** Mark a workspace as changed, from any process. Called through the
 *  platform hook; safe to call from a web pod with no scheduler in it. */
export function markScheduleDirty(tenant: string, workspace: string): void {
  const key = `${tenant}\t${workspace}`;
  dirtyLocal.add(key);
  const c = cache();
  if (c) void c.sadd(DIRTY_KEY, key).catch(() => {});
}

async function takeDirty(): Promise<string[]> {
  const keys = new Set(dirtyLocal);
  dirtyLocal.clear();
  const c = cache();
  if (c) {
    try {
      // Everything marked since the last tick, atomically: SPOP with a count
      // hands them over and removes them in one step.
      for (const k of await c.spop(DIRTY_KEY, 1000)) keys.add(k);
    } catch {
      // Redis away: the local set and the rescan still cover it
    }
  }
  return [...keys];
}

/** Bring the catalogue up to date: a full rebuild when it is stale or
 *  empty, otherwise only the workspaces marked dirty since the last tick.
 *  Returns the tenants to tick over. */
export async function refreshCatalogue(now: number, tenants: string[]): Promise<string[]> {
  // Once a day at most, behind any warm in progress: prune the shared runtime
  // layer of entries nobody has used or built for (runtime-warm.ts).
  try {
    maybeRunJanitor(now);
  } catch (err) {
    console.warn("[scheduler] runtime janitor:", err instanceof Error ? err.message : err);
  }
  if (catalogue.size === 0 || now - catalogueBuiltAt >= RESCAN_MS) {
    catalogue.clear();
    for (const tenant of tenants) {
      const m = new Map<string, FlowInfo[]>();
      for (const w of scanSource(tenant)) m.set(w.workspace, w.flows);
      catalogue.set(tenant, m);
    }
    catalogueBuiltAt = now;
    // Whatever was marked is in the rebuild — but a rebuild does not build
    // runtimes, so a workspace marked in the same window must still be
    // warmed. Dropping them here lost every deploy that landed in a rescan
    // tick, and the first tick of a freshly rolled worker is always one.
    for (const key of await takeDirty()) {
      const [tenant, workspace] = key.split("\t");
      if (tenant && workspace) warmSafely(tenant, workspace);
    }
    return tenants;
  }
  for (const key of await takeDirty()) {
    const [tenant, workspace] = key.split("\t");
    if (!tenant || !workspace) continue;
    const m = catalogue.get(tenant) ?? new Map<string, FlowInfo[]>();
    catalogue.set(tenant, m);
    try {
      m.set(workspace, readWorkspaceFlows(tenant, workspace));
    } catch {
      m.delete(workspace); // gone, or unreadable — the rescan will say which
    }
    warmSafely(tenant, workspace);
  }
  return [...catalogue.keys()];
}

/**
 * A changed workspace may need an environment its steps have never had:
 * build it now, behind the tick, so the first scheduled step finds it ready
 * and a package that will not install is known at deploy time. Never throws,
 * never waits (runtime-warm.ts). Injectable for the test that proves both
 * paths through refreshCatalogue reach it.
 */
let warm: (tenant: string, workspace: string) => void = warmWorkspace;
export function setWarmForTest(fn: ((tenant: string, workspace: string) => void) | null): void {
  warm = fn ?? warmWorkspace;
}
function warmSafely(tenant: string, workspace: string): void {
  try {
    warm(tenant, workspace);
  } catch (err) {
    console.warn(`[scheduler] runtime warm for ${tenant}/${workspace} failed:`, err instanceof Error ? err.message : err);
  }
}

/** The catalogue as a source: what the tick reads. */
const catalogueSource: FlowSource = (tenant) =>
  [...(catalogue.get(tenant) ?? new Map<string, FlowInfo[]>()).entries()].map(([workspace, flows]) => ({ workspace, flows }));

/** For a test that changed the disk and wants the next tick to see it. */
export function resetCatalogue(): void {
  catalogue.clear();
  catalogueBuiltAt = 0;
  dirtyLocal.clear();
}

// ---- cron ----
//
// The parser lives in core (cron.ts) so `foldrun check` and the deploy read a
// schedule with the same function this scheduler runs.

export { parseCron, type Cron };

// Wall-clock fields for a date in an IANA timezone.
// One formatter per zone, kept.
//
// Constructing an Intl.DateTimeFormat is expensive — far more so than using
// one — and this function is called once per minute examined. The scheduler
// asks it for every flow on every tick, and the settings page walks forty
// days a minute at a time to preview the next fire: 57,600 formatters per
// flow, twice, which took tens of seconds and blocked the event loop long
// enough that a pooled database connection timed out underneath it. The
// formatter for a zone never changes, so there is nothing to invalidate.
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = FORMATTERS.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
      hour12: false,
    });
    FORMATTERS.set(timeZone, fmt);
  }
  return fmt;
}

function zoned(date: Date, timeZone: string) {
  const fmt = formatterFor(timeZone);
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour) % 24,
    dom: Number(parts.day),
    month: Number(parts.month),
    dow: DOW_NAMES.indexOf(parts.weekday.toLowerCase().slice(0, 3)),
  };
}

/**
 * When a cron next fires after `from`, or null when it does not within
 * `maxDays`. Walks hours, not minutes: a day and hour that cannot match are
 * skipped in one step, and only a matching hour is examined a minute at a
 * time — a few thousand formatter reads for two months, not ninety thousand.
 */
export function nextFire(cron: Cron, from: Date, timeZone = "UTC", maxDays = 60): Date | null {
  const start = new Date(from);
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1);
  const end = start.getTime() + maxDays * 24 * 60 * 60 * 1000;
  // The first (partial) hour from `start`, then whole hours from the top.
  let hourStart = new Date(start);
  while (hourStart.getTime() < end) {
    const hourEnd = new Date(hourStart);
    hourEnd.setUTCMinutes(60, 0, 0);
    // A zone's offset is a multiple of fifteen minutes, so inside one UTC
    // hour the local hour can change at :15, :30 or :45 — probe each.
    let hourOk = false;
    for (const offset of [0, 15, 30, 45]) {
      const at = new Date(hourStart.getTime() + offset * 60_000);
      if (at.getTime() >= hourEnd.getTime()) break;
      let probe;
      try {
        probe = zoned(at, timeZone);
      } catch {
        probe = zoned(at, "UTC");
      }
      if (cron.hour.has(probe.hour) && cron.month.has(probe.month) && domDowMatch(cron, probe.dom, probe.dow)) {
        hourOk = true;
        break;
      }
    }
    // A skipped hour's fire lands at the first instant after the gap, in an
    // hour the cron does not name; ask the probes that, too. The first,
    // partial hour is not aligned to the probes, so it is simply walked.
    if (!hourOk && cron.fixedTime) {
      hourOk = hourStart.getUTCMinutes() !== 0;
      for (const offset of [0, 15, 30, 45]) {
        const at = new Date(hourStart.getTime() + offset * 60_000);
        if (hourOk || at.getTime() >= hourEnd.getTime()) break;
        hourOk = skippedFire(cron, at, wall(at, timeZone), timeZone);
      }
    }
    if (hourOk) {
      for (let t = new Date(hourStart); t.getTime() < hourEnd.getTime(); t.setUTCMinutes(t.getUTCMinutes() + 1)) {
        if (cronMatches(cron, t, timeZone)) return new Date(t);
      }
    }
    hourStart = hourEnd;
  }
  return null;
}

/**
 * Does the cron fire at this instant?
 *
 * Daylight saving, as Vixie cron does it, for a job at a time of day
 * (neither minute nor hour a wildcard): a time the clocks skip fires once,
 * at the first instant after the gap — 02:30 on the Sunday Sydney springs
 * from 02:00 to 03:00 fires at 03:00 — and a time the clocks repeat fires
 * once, the first time. Matching wall clock alone did neither: the skipped
 * 02:30 never fired and the repeated one fired twice. A wildcard job
 * (every fifteen minutes, every hour) follows the clock as it is, which is
 * already right for it.
 */
export function cronMatches(cron: Cron, date: Date, timeZone = "UTC"): boolean {
  const t = wall(date, timeZone);
  if (cron.minute.has(t.minute) && cron.hour.has(t.hour) && cron.month.has(t.month) && domDowMatch(cron, t.dom, t.dow)) {
    return !(cron.fixedTime && repeatedWallTime(date, t, timeZone));
  }
  return cron.fixedTime && skippedFire(cron, date, t, timeZone);
}

type Wall = ReturnType<typeof zoned>;

function wall(date: Date, timeZone: string): Wall {
  try {
    return zoned(date, timeZone);
  } catch {
    return zoned(date, "UTC"); // unknown timezone → UTC rather than never firing
  }
}

/** This wall-clock minute already happened earlier today: the clocks went
 *  back over it. Zones step by thirty minutes, an hour, or (rarely) two. */
function repeatedWallTime(date: Date, t: Wall, timeZone: string): boolean {
  for (const back of [30, 60, 120]) {
    const p = wall(new Date(date.getTime() - back * 60_000), timeZone);
    if (p.minute === t.minute && p.hour === t.hour && p.dom === t.dom && p.month === t.month) return true;
  }
  return false;
}

/** This instant is the first after the clocks skipped forward, and a time
 *  the cron names fell in the skipped stretch. Transitions happen on a
 *  quarter hour of UTC, so any other minute is answered without a lookup. */
function skippedFire(cron: Cron, date: Date, t: Wall, timeZone: string): boolean {
  if (date.getUTCMinutes() % 15 !== 0) return false;
  const p = wall(new Date(date.getTime() - 60_000), timeZone);
  // Minutes of the day, the previous minute's counted back from midnight
  // when the gap straddles it, so everything skipped lies on t's day.
  const prev = p.hour * 60 + p.minute - (p.dom !== t.dom ? 1440 : 0);
  const now = t.hour * 60 + t.minute;
  if (now - prev <= 1 || !cron.month.has(t.month) || !domDowMatch(cron, t.dom, t.dow)) return false;
  for (let m = Math.max(0, prev + 1); m < now; m++) {
    if (cron.hour.has(Math.floor(m / 60)) && cron.minute.has(m % 60)) return true;
  }
  return false;
}

// Standard cron: when both day fields are restricted, either may match.
function domDowMatch(cron: Cron, dom: number, dow: number): boolean {
  const domOk = cron.dom.has(dom);
  const dowOk = cron.dow.has(dow);
  if (cron.domRestricted && cron.dowRestricted) return domOk || dowOk;
  if (cron.domRestricted) return domOk;
  if (cron.dowRestricted) return dowOk;
  return true;
}

// The LAST minute in (after, now] this cron matched, or null. Bounded to 24h
// of catch-up so a long downtime doesn't fire hundreds of runs.
//
// The last rather than the first, and a time rather than a boolean, because
// `catchup:` needs to know HOW LATE the fire it is about to make is. A cron
// that matched four minutes ago is this tick running slightly behind; one
// that matched at 05:00 and is being noticed at 11:00 is a make-up run for
// an outage, and some flows would rather skip that than run it at lunchtime.
export function lastFireIn(cron: Cron, after: Date, now: Date, timeZone: string): Date | null {
  const start = Math.max(after.getTime(), now.getTime() - 24 * 60 * 60_000);
  let hit: Date | null = null;
  for (let t = Math.floor(start / 60_000) * 60_000 + 60_000; t <= now.getTime(); t += 60_000) {
    if (cronMatches(cron, new Date(t), timeZone)) hit = new Date(t);
  }
  return hit;
}

/** How late a fire may be and still count as "now" rather than a make-up
 *  run. Ten minutes: a tick that ran long behind a dozen slow watched URLs,
 *  a pod that rolled, a lease that failed over — none of those are an
 *  outage, and `catchup: none` is about the 07:00 report noticed at 11:00,
 *  not at 07:02. */
const ON_TIME_MS = 10 * 60_000;

/**
 * A window around the model credential's refresh in which scheduled runs
 * are not started. The box refreshes its Claude OAuth token every four hours
 * and Anthropic revokes the old one the moment the new one is minted, so a
 * step mid-turn at that minute gets a 401 (every 4-hourly refresh on
 * 2026-09-18..23 failed the step it landed on). A run that has not started
 * yet cannot be caught out, so the 08:00 desks start at 08:12 instead.
 *
 * Only `trigger: schedule` is held: a person, a webhook or a rerun asked for
 * a run now and gets it now. Configured by the host, not hard-coded, because
 * the refresh is the host's timer:
 *
 *   FOLDRUN_SCHEDULE_HOLD_CRON    when the refresh fires ("7 0,4,8,12,16,20 * * *")
 *   FOLDRUN_SCHEDULE_HOLD_TZ      its zone (default UTC)
 *   FOLDRUN_SCHEDULE_HOLD_BEFORE  minutes held before it (default 17)
 *   FOLDRUN_SCHEDULE_HOLD_AFTER   minutes held after it (default 5: the
 *                                 timer's 60s jitter and the ~60s the kubelet
 *                                 takes to deliver the new token)
 *
 * Returns when the hold ends, or null when `at` is outside every window.
 */
export function scheduleHold(at: Date, env: NodeJS.ProcessEnv = process.env): Date | null {
  const expr = env.FOLDRUN_SCHEDULE_HOLD_CRON?.trim();
  if (!expr) return null;
  const cron = parseCron(expr);
  if (!cron) return null;
  const minutes = (v: string | undefined, d: number) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : d);
  const before = minutes(env.FOLDRUN_SCHEDULE_HOLD_BEFORE, 17) * 60_000;
  const after = minutes(env.FOLDRUN_SCHEDULE_HOLD_AFTER, 5) * 60_000;
  // The refresh this instant could belong to: the first one after
  // (at - after), which is either just behind `at` or still ahead of it.
  const refresh = nextFire(cron, new Date(at.getTime() - after - 60_000), env.FOLDRUN_SCHEDULE_HOLD_TZ || "UTC", 1);
  if (!refresh) return null;
  const from = refresh.getTime() - before;
  const until = refresh.getTime() + after;
  return at.getTime() >= from && at.getTime() < until ? new Date(until) : null;
}
const heldNoted = new Set<string>();

export interface DueFlow {
  tenant: string;
  workspace: string;
  flow: FlowInfo;
}

export function findDueFlows(
  now: Date,
  state: ScheduleState,
  tenants: string[],
  live?: ReadonlySet<string>,
  source: FlowSource = scanSource,
  /** Was this fire inside a pause its people set (admin.ts pauseWindows)?
   *  Such a fire is consumed and logged as halted — never made up after a
   *  resume, never called missed. */
  paused: (tenant: string, workspace: string, at: number) => boolean = () => false,
): DueFlow[] {
  const due: DueFlow[] = [];
  for (const tenant of tenants) {
    for (const { workspace: wsName, flows } of source(tenant)) {
      const workspace = { name: wsName };
      for (const flow of flows) {
        // trigger: once — a single instant. Fires on the first tick at or
        // after it, and the record of having fired is what stops a second.
        if (flow.trigger === "once") {
          if (!flow.at || flow.steps.length === 0) continue;
          const key = `${tenant}/${workspace.name}/${flow.name}@${flow.at}`;
          if (state.lastFired[key]) continue;
          const at = new Date(flow.at).getTime();
          if (now.getTime() < at) continue;
          state.lastFired[key] = now.toISOString();
          if (now.getTime() - at > ONCE_CATCHUP_MS) {
            console.log(`[scheduler] ${key}: its moment passed more than six hours ago — recorded, not fired`);
            continue;
          }
          if (paused(tenant, workspace.name, at)) {
            const detail = `its moment (${flow.at}) fell while the ${workspace.name} workspace or its account was paused, so it is not run`;
            console.log(`[scheduler] ${key}: ${detail}`);
            recordTriggerEvent(tenant, workspace.name, { t: now.toISOString(), flow: flow.name, trigger: flow.trigger, outcome: "halted", detail });
            continue;
          }
          due.push({ tenant, workspace: workspace.name, flow });
          continue;
        }
        if (flow.trigger !== "schedule" || !flow.schedule || flow.steps.length === 0) continue;
        const cron = parseCron(flow.schedule);
        if (!cron) continue;
        const key = `${tenant}/${workspace.name}/${flow.name}`;
        const last = state.lastFired[key];
        // First sighting: record now, don't backfire.
        if (!last) {
          state.lastFired[key] = now.toISOString();
          continue;
        }
        const fired = lastFireIn(cron, new Date(last), now, flow.timezone ?? "UTC");
        if (fired) {
          // Held around the credential refresh: the tick is NOT consumed, so
          // the first tick after the window finds the same fire and starts it.
          const hold = scheduleHold(now);
          if (hold) {
            const note = `${key}@${fired.toISOString()}`;
            if (!heldNoted.has(note)) {
              heldNoted.add(note);
              console.log(`[scheduler] ${key}: held until ${hold.toISOString()} — the model credential refreshes inside this window`);
            }
            continue;
          }
          if (paused(tenant, workspace.name, fired.getTime())) {
            const detail = `its ${fired.toISOString()} fire fell while the ${workspace.name} workspace or its account was paused, so it is not run`;
            console.log(`[scheduler] ${key}: ${detail}`);
            recordTriggerEvent(tenant, workspace.name, { t: now.toISOString(), flow: flow.name, trigger: flow.trigger, outcome: "halted", detail });
            state.lastFired[key] = now.toISOString();
            continue;
          }
          // A fire that fell inside a hold is due from the end of that hold,
          // not from its cron minute, or catchup: none would drop it.
          const dueFrom = Math.max(fired.getTime(), scheduleHold(fired)?.getTime() ?? 0);
          // catchup: none — a fire the platform slept through is dropped
          // rather than made up. The tick is consumed either way: the flow
          // waits for its next real occurrence.
          if (flow.catchup === "none" && now.getTime() - dueFrom > ON_TIME_MS) {
            const detail = `catchup: none — its ${fired.toISOString()} fire was missed while nothing was running, so it waits for the next`;
            console.log(`[scheduler] ${key}: ${detail}`);
            recordTriggerEvent(tenant, workspace.name, {
              t: now.toISOString(),
              flow: flow.name,
              trigger: flow.trigger,
              outcome: "missed",
              detail,
            });
            state.lastFired[key] = now.toISOString();
            continue;
          }
          // overlap: skip — a cron refiring while yesterday's run is still
          // going almost never means "run two". The tick is consumed either
          // way: when the long run finally ends, the flow waits for its next
          // scheduled time rather than firing a stale make-up run.
          if (flow.overlap === "skip" && flowHasLiveRun(tenant, workspace.name, flow.name)) {
            const detail = "overlap: skip — a run of this flow is still live, so this occurrence was consumed";
            console.log(`[scheduler] ${key}: ${detail}`);
            recordTriggerEvent(tenant, workspace.name, {
              t: now.toISOString(),
              flow: flow.name,
              trigger: flow.trigger,
              outcome: "overlap-skipped",
              detail,
            });
            state.lastFired[key] = now.toISOString();
            continue;
          }
          due.push({ tenant, workspace: workspace.name, flow });
          state.lastFired[key] = now.toISOString();
        }
      }
    }
  }
  if (++ticksSinceReconcile >= RECONCILE_EVERY) {
    ticksSinceReconcile = 0;
    // The chores ride this cadence too — from tick(), under their own lease.
    sweepDue = true;
    try {
      for (const closed of reconcileAllRuns(now.getTime(), live, afterReconciled)) {
        console.log(
          `[scheduler] closed abandoned run ${closed.tenant}/${closed.workspace}/${closed.runId}` +
            (closed.interrupted.length ? ` — interrupted: ${closed.interrupted.join(", ")}` : ""),
        );
      }
    } catch (err) {
      // A run that cannot be reconciled must not stop flows from firing.
      console.error("[scheduler] reconcile failed:", err);
    }
  }

  return due;
}

// One scheduler per data directory, however many processes share it. The
// lease is a file naming its holder; a holder renews by rewriting it, and
// anyone finding it stale (no renewal for three tick intervals) takes over.
// The take-over race is a read-then-write and deliberately so: the worst
// case is two processes firing one tick together, once, during a handover —
// a bounded duplicate, not a corruption — and a lock that could deadlock a
// fleet to prevent it would be the worse trade.
const LEASE_STALE_MS = 90_000;
const OWNER = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

function leaseFile() {
  return path.join(dataRoot(), ".scheduler-lease");
}

function holdsLease(now: number): boolean {
  const file = leaseFile();
  try {
    const current = JSON.parse(fs.readFileSync(file, "utf8")) as {
      owner: string;
      renewedAt: number;
    };
    if (current.owner !== OWNER && now - current.renewedAt < LEASE_STALE_MS) return false;
  } catch {
    // no lease yet, or unreadable — claimable
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${OWNER}`;
  fs.writeFileSync(tmp, JSON.stringify({ owner: OWNER, renewedAt: now }));
  fs.renameSync(tmp, file);
  return true;
}

/** Redis when the install has one — `SET NX PX` has no read-then-write
 *  window, so two pods can never both think they hold it; the file
 *  otherwise. Same shape as the worker's. */
async function holdsSchedulerLease(now: number): Promise<boolean> {
  if (cacheEnabled()) return (await takeLease("scheduler", OWNER, LEASE_STALE_MS)).held;
  return holdsLease(now);
}

/** Hand it back on a clean shutdown so the next pod ticks at once. */
export async function releaseSchedulerLease(): Promise<void> {
  if (cacheEnabled()) await releaseLease("scheduler", OWNER);
}

let sweepingWebhooks = false;
/** The daily security rescan (rescan.ts): a pass every ten minutes at most,
 *  off the tick's path, one at a time. */
let rescanning = false;
let lastRescanPass = 0;
const RESCAN_PASS_EVERY_MS = 10 * 60_000;
/** The grade pass (grade-pass.ts): graders holding a sample of finished
 *  runs to their checks, every five minutes at most, one pass at a time. */
let grading = false;
let lastGradePass = 0;
const GRADE_PASS_EVERY_MS = 5 * 60_000;

export async function tick(now = new Date()): Promise<DueFlow[]> {
  if (!(await holdsSchedulerLease(now.getTime()))) return [];
  const state = await loadScheduleState();
  const before = structuredClone(state);
  // The tenant list is a directory read; the flows come from the catalogue,
  // rebuilt in full every RESCAN_MS and patched per dirty workspace between.
  const tenants = await refreshCatalogue(now.getTime(), listTenants());
  // Runs other worker pods are driving, so the reconcile inside leaves them
  // alone. Asked only when there is a database to ask — on the file queue
  // this process is the only driver, and the call stays synchronous.
  const live = databaseEnabled() ? await liveClaimedRuns() : undefined;
  sweepDue = false;
  // Each account's pause windows, read once a tick: findDueFlows is
  // synchronous, and a fire inside a pause is not one to make up.
  const pauses = new Map<string, Awaited<ReturnType<typeof adminState>>>();
  for (const t of tenants) pauses.set(t, await adminState(t).catch(() => ({})));
  const due = findDueFlows(now, state, tenants, live, catalogueSource, (t, ws, at) =>
    pauseWindows(pauses.get(t) ?? {}, ws).some((w) => at >= w.from && (w.to === null || at <= w.to)),
  );
  // Saved before anything is queued, as before: a tick that dies between
  // the two loses a fire rather than repeating one.
  await saveScheduleState(before, state);
  for (const d of due) {
    try {
      const gate = await admitTrigger(d.tenant, d.workspace, d.flow, { tag: "schedule" });
      if (!gate.admit) {
        console.log(`[scheduler] ${d.tenant}/${d.workspace}/${d.flow.name} due but not started: ${gate.detail}`);
        continue;
      }
      // Spread over FOLDRUN_SCHEDULE_SPREAD_SEC, the same offset each time.
      const spread = scheduleSpreadMs(`${d.tenant}/${d.workspace}/${d.flow.name}`);
      // Through the queue, not straight to driveRun — the scheduler shares a
      // process with the worker, and firing five flows at one minute past
      // midnight should respect the same concurrency cap as everything else.
      try {
        await enqueueFlowRun(d.tenant, d.workspace, d.flow.steps, d.flow.name, undefined, [], null,
          spread ? { notBefore: new Date(now.getTime() + spread).toISOString() } : {});
      } catch (err) {
        await rollbackTrigger(d.tenant, d.workspace, d.flow, { reason: err instanceof Error ? err.message : String(err) });
        throw err;
      }
      console.log(`[scheduler] queued ${d.tenant}/${d.workspace}/${d.flow.name}${spread ? ` (starts +${Math.round(spread / 1000)}s)` : ""}`);
    } catch (err) {
      console.error(`[scheduler] failed ${d.tenant}/${d.workspace}/${d.flow.name}:`, err);
    }
  }
  // trigger: watch — network reads, so after the cron pass is queued: a
  // slow URL must not delay a schedule. (They used to be read first, and a
  // tick of unreachable sites held the 8:00 desks back.)
  let changed: Awaited<ReturnType<typeof checkWatches>> = [];
  try {
    changed = await checkWatches(now, state, tenants, fetchText, catalogueSource);
  } catch (err) {
    console.error("[scheduler] watch check failed:", err);
  }
  // Only what moved: a tick that fired two flows writes two rows.
  await saveScheduleState(before, state);
  for (const w of changed) {
    try {
      const body = w.body.slice(0, 20_000);
      // A page that flaps between two versions is a burst; `debounce:` is
      // what turns it back into one run.
      const gate = await admitTrigger(w.tenant, w.workspace, w.flow, { body, tag: "watched_content" });
      if (!gate.admit) {
        console.log(`[scheduler] ${w.tenant}/${w.workspace}/${w.flow.name} — ${w.flow.url} changed but not started: ${gate.detail}`);
        continue;
      }
      try {
        await enqueueFlowRun(w.tenant, w.workspace, withTask(w.flow.steps, "watched_content", body), w.flow.name, w.flow.model, ["watch"]);
      } catch (err) {
        await rollbackTrigger(w.tenant, w.workspace, w.flow, { reason: err instanceof Error ? err.message : String(err) });
        throw err;
      }
      console.log(`[scheduler] queued ${w.tenant}/${w.workspace}/${w.flow.name} — ${w.flow.url} changed`);
    } catch (err) {
      console.error(`[scheduler] watch ${w.tenant}/${w.workspace}/${w.flow.name}:`, err);
    }
  }
  // Bursts whose quiet window has passed. Taken from the state as they are
  // read, so a failure here loses a run rather than repeating it forever.
  for (const b of await dueDebounced(now.getTime())) {
    const flow = catalogueSource(b.tenant).find((w) => w.workspace === b.workspace)?.flows.find((f) => f.name === b.flow);
    const stamp = (outcome: "started" | "failed", detail: string) =>
      recordTriggerEvent(b.tenant, b.workspace, { t: now.toISOString(), flow: b.flow, trigger: flow?.trigger ?? b.tag, outcome, detail });
    if (!flow || flow.steps.length === 0) {
      // The burst was held and its flow is gone, or is somewhere the
      // scheduler does not look (a preview). Written down: a burst that
      // vanishes with no record is the one thing this page must not do.
      stamp("failed", `${b.count} debounced event(s) dropped — the flow is not in the schedule catalogue any more`);
      continue;
    }
    try {
      const body = b.count > 1 ? `${b.body}\n\n(${b.count} events collapsed by debounce: ${flow.debounce}s)` : b.body;
      await enqueueFlowRun(b.tenant, b.workspace, withTask(flow.steps, b.tag, body), flow.name, flow.model, ["debounced"]);
      stamp("started", b.count > 1 ? `${b.count} events collapsed by debounce:` : "");
      console.log(`[scheduler] queued ${b.tenant}/${b.workspace}/${b.flow} — ${b.count} event(s) debounced`);
    } catch (err) {
      stamp("failed", err instanceof Error ? err.message : String(err));
      console.error(`[scheduler] debounced ${b.tenant}/${b.workspace}/${b.flow}:`, err);
    }
  }
  // The chores, on the reconcile's cadence and under the HOUSEKEEPING
  // lease, not the scheduler's: whichever pod holds that runs them, once,
  // and a pod that just took over the scheduler does not run them a second
  // time over a pass still finishing elsewhere. Fire-and-forget from the
  // tick — a cluster that cannot be reached is not a reason to stop firing
  // flows.
  // notify: webhooks whose next attempt is due (webhook-deliveries.ts).
  // Off the tick's path, one pass at a time: a receiver that takes its full
  // timeout must not hold back the next minute's flows.
  if (started && !sweepingWebhooks) {
    sweepingWebhooks = true;
    void sweepWebhookDeliveries(now.getTime())
      .catch((err) => console.error("[scheduler] webhook retries failed:", err))
      .finally(() => { sweepingWebhooks = false; });
  }
  if (sweepDue) {
    void withHousekeeping("reconcile-pass", () => housekeepingPass(now.getTime())).catch((err) => console.error("[scheduler] housekeeping failed:", err));
  }
  // FOL-58: the daily security rescan. Off the tick: a tenant's slow MCP
  // server or OSV must never hold back the next minute's flows. It asks
  // before each workspace whether this pod is still the scheduler.
  if (started && !rescanning && now.getTime() - lastRescanPass >= RESCAN_PASS_EVERY_MS && process.env.FOLDRUN_RESCAN !== "0") {
    rescanning = true;
    lastRescanPass = now.getTime();
    void rescanPass(now.getTime(), () => holdsSchedulerLease(Date.now()))
      .catch((err) => console.error("[scheduler] security rescan failed:", err))
      .finally(() => {
        rescanning = false;
      });
  }
  // Grading live runs. Off the tick for the same reason as the rescan: a
  // judge is a model call, and the next minute's flows must not wait on it.
  if (started && !grading && now.getTime() - lastGradePass >= GRADE_PASS_EVERY_MS && process.env.FOLDRUN_GRADES !== "0") {
    grading = true;
    lastGradePass = now.getTime();
    void gradePass(now.getTime(), () => holdsSchedulerLease(Date.now()))
      .then((r) => {
        const line = describePass(r);
        if (line) console.log(`[scheduler] ${line}`);
      })
      .catch((err) => console.error("[scheduler] grade pass failed:", err))
      .finally(() => {
        grading = false;
      });
  }
  // The status page's five-minute sample, from the pod holding this lease —
  // so a stale sample is itself the sign that the scheduler stopped. Only
  // from the running loop: a test calling tick() probes nothing.
  if (started) void maybeSampleStatus(now.getTime()).catch((err) => console.error("[scheduler] status sample failed:", err));
  return due;
}

/**
 * Everything the platform tidies that is not a flow firing. One pod list
 * per kind per pass — the reapers take the run-pod listing they are
 * handed rather than asking the cluster once per pod.
 */
export async function housekeepingPass(now: number): Promise<void> {
  // Terminated run pods whose driver died with the process that created them.
  await sweepFinishedRunPods()
    .then((n) => n && console.log(`[scheduler] swept ${n} finished run pod(s)`))
    .catch((err) => console.error("[scheduler] run-pod sweep failed:", err));
  // Running pods whose run is already over — stopped from a process that
  // could not reach the cluster, or orphaned by a driver that died.
  await reapOrphanRunPods(runStateById())
    .then((pods) => pods.length && console.log(`[scheduler] reaped ${pods.length} orphan run pod(s): ${pods.join(" ")}`))
    .catch((err) => console.error("[scheduler] orphan run-pod reap failed:", err));
  // Account pods nobody has used for the idle window: deleted, and their
  // seconds and bytes put on the account's ledger. The label on the pod
  // is a DNS-shaped form of the tenant; map it back through the tenants
  // that exist — by exact segment, computed once for the pass — so a pod
  // is billed to a real account or not at all. The run pods are listed
  // once and shared by both kinds.
  const tenantOfSeg = segmentIndex(listTenants());
  const busy = await busyAccountSegments();
  await reapIdleSearchPods(tenantOfSeg, busy)
    .then((n) => n && console.log(`[scheduler] reaped ${n} idle search pod(s)`))
    .catch((err) => console.error("[scheduler] search-pod reap failed:", err));
  await reapIdleBrowserPods(tenantOfSeg, busy)
    .then((n) => n && console.log(`[scheduler] reaped ${n} idle browser pod(s)`))
    .catch((err) => console.error("[scheduler] browser-pod reap failed:", err));
  // Gates that ran out of time and runs that have outlived their `sla:`.
  await sweepGatesAndSlas(now).catch((err) => console.error("[scheduler] gate/SLA sweep failed:", err));
}



// Started once per server process from instrumentation.ts.
let started = false;

export function startScheduler() {
  if (started || process.env.FOLDRUN_DISABLE_SCHEDULER === "1") return;
  started = true;
  // One tick at a time. A tick's `trigger: watch` pass fetches every watched
  // URL serially, up to 8s each, and lastFired is only written back at the
  // end — so a tick that outran the 30s interval overlapped the next one,
  // which read the OLD state and enqueued every due cron flow a second time.
  let ticking = false;
  setInterval(() => {
    if (ticking) return;
    ticking = true;
    // The tick is async now (enqueueing can be a database write), so its
    // failure is a rejected promise rather than a throw a try/catch here would
    // ever see — an unhandled one takes the process down.
    void tick()
      .catch((err) => console.error("[scheduler] tick failed:", err))
      .finally(() => { ticking = false; });
  }, TICK_MS).unref?.();
  console.log("[scheduler] started (30s tick)");
}

// ------------------------------------------------------------- what is next
//
// "What runs next, and when" is the question a person with scheduled desks
// asks most and could not answer without reading every flow file's cron by
// hand. The answer is a read: every scheduled and one-shot flow, its next
// fire in its own zone, sorted.

export interface UpcomingRun {
  workspace: string;
  flow: string;
  /** ISO instant of the next fire. */
  at: string;
  /** The cron or the `at:`, as written. */
  schedule: string;
  timezone: string;
  trigger: "schedule" | "once";
  /** A run of this flow is live now, and the flow says what happens then. */
  overlap: "skip" | "queue" | null;
  liveNow: boolean;
}

/** The next `count` fires across an account's workspaces, soonest first. */
export function upcomingRuns(tenant: string, count = 5, now = new Date()): UpcomingRun[] {
  const out: UpcomingRun[] = [];
  for (const ws of listWorkspaces(tenant)) {
    let flows: FlowInfo[];
    try {
      flows = listFlows(tenant, ws.name);
    } catch {
      continue;
    }
    for (const flow of flows) {
      if (flow.steps.length === 0) continue;
      if (flow.trigger === "schedule" && flow.schedule) {
        const cron = parseCron(flow.schedule);
        if (!cron) continue;
        const at = nextFire(cron, now, flow.timezone ?? "UTC", 60);
        if (!at) continue;
        out.push({
          workspace: ws.name,
          flow: flow.name,
          at: at.toISOString(),
          schedule: flow.schedule,
          timezone: flow.timezone ?? "UTC",
          trigger: "schedule",
          overlap: flow.overlap,
          liveNow: flow.overlap ? flowHasLiveRun(tenant, ws.name, flow.name) : false,
        });
      } else if (flow.trigger === "once" && flow.at && new Date(flow.at) > now) {
        out.push({ workspace: ws.name, flow: flow.name, at: flow.at, schedule: flow.at, timezone: flow.timezone ?? "UTC", trigger: "once", overlap: null, liveNow: false });
      }
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at)).slice(0, count);
}
