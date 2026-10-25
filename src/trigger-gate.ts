// Between a thing happening and a run existing.
//
// Every trigger in the format answers "what starts this flow". None of them
// answered "how many of those starts are real", and the answer was always
// "all of them": a webhook delivered twice ran twice, a watched page that
// flapped ran on every flap, and a nightly desk that had failed all week
// kept failing on schedule, spending money and sending mail each time.
//
// Four gates, all declared in the flow file, all literals:
//
//   idempotency: x-github-delivery   the same delivery twice is one run
//   throttle: 15m                    at most one run per window
//   debounce: 2m                     a burst becomes one run, once it stops
//   disable_after: 5                 stop firing a flow that only fails
//
// They are checked in that order, because that is the order in which they
// get cheaper to be wrong about: a duplicate delivery should never have
// been an event at all, while a quarantine is a judgement about a flow.
//
// State: one row per flow in the database (flow-state.ts) — the throttle's
// floor, the burst a debounce holds, when disable_after switched it off —
// or data/triggers.json on an install without one. Delivery ids live in
// Redis where there is one, so every pod answers "seen it" the same way.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { markerPresent, workspaceDir, type FlowInfo, type RunRecord } from "../../foldrun-core/src/store.ts";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { recordTriggerEvent, type TriggerOutcome } from "../../foldrun-core/src/trigger-log.ts";
import { matchFilter } from "../../foldrun-core/src/trigger-filter.ts";
import { cache } from "./cache.ts";
import { databaseEnabled } from "./db.ts";
import { adminState, pauseOf } from "./admin.ts";
import {
  getCursor,
  setCursor,
  heldBursts,
  readTriggerFile,
  writeTriggerFile,
  resetFlowState,
  keyOf,
  type Seen,
  type Pending,
} from "./flow-state.ts";
export { quarantinedFlows } from "./flow-state.ts";
export type { Pending } from "./flow-state.ts";

/** How long a delivery id is remembered. Long enough to cover every retry
 *  policy a sender plausibly has, short enough that the store stays small.
 *  A duplicate arriving after this is genuinely a new event as far as
 *  anyone can tell. */
const IDEMPOTENCY_TTL_MS = 24 * 3600_000;

/** The most deliveries remembered at once, oldest dropped first. A bound,
 *  not a policy: without one, a busy hook grows the list forever. */
const IDEMPOTENCY_MAX = 5000;

// ---- delivery ids, without Redis.
//
// The file when the install has no database (one process, one file); this
// process's memory when it has a database but no Redis — dedup then holds
// within a pod, which is the most a pod can promise without a shared
// atomic store, and the boot log says so.
let memorySeen: Seen[] = [];
let warnedNoRedis = false;

function loadSeen(): Seen[] {
  if (!databaseEnabled()) return readTriggerFile().seen ?? [];
  if (!warnedNoRedis) {
    warnedNoRedis = true;
    console.warn("[triggers] no Redis: delivery ids are remembered per pod, not across the fleet");
  }
  return memorySeen;
}

function storeSeen(seen: Seen[]): void {
  if (!databaseEnabled()) {
    const f = readTriggerFile();
    f.seen = seen;
    writeTriggerFile(f);
    return;
  }
  memorySeen = seen;
}


// "Have we seen this?" has to be answered atomically across pods, or two
// web pods receiving the same retried delivery both look, both see nothing,
// and both start a run — defeating idempotency exactly when it matters,
// because senders retry in parallel on a timeout. Redis SET NX is that
// answer when the install has Redis; the file is the fallback for one box,
// where there is one process to race with and it is this one.
async function seenBefore(h: string, now: number, runId?: string): Promise<{ dup: boolean; runId?: string }> {
  const c = cache();
  if (c) {
    const k = `idem:${h}`;
    try {
      const taken = await c.set(k, runId ?? "", "PX", IDEMPOTENCY_TTL_MS, "NX");
      if (taken === "OK") return { dup: false };
      return { dup: true, runId: (await c.get(k)) ?? "" };
    } catch {
      // Redis unreachable: fall through to the file rather than admit
      // everything or refuse everything.
    }
  }
  const seen = pruneSeen(loadSeen(), now);
  const hit = seen.find((s) => s.h === h);
  if (hit) return { dup: true, runId: hit.runId ?? "" };
  return { dup: false };
}

function rememberSeen(entry: Seen): void {
  storeSeen([...pruneSeen(loadSeen(), entry.at), entry]);
}

async function forgetSeen(h: string): Promise<void> {
  const c = cache();
  if (c) {
    try {
      await c.del(`idem:${h}`);
    } catch {
      // best effort
    }
  }
  storeSeen(loadSeen().filter((s) => s.h !== h));
}

/** Drop what has expired, then bound each tenant to its own newest
 *  IDEMPOTENCY_MAX. A single ring across accounts let one busy hook push
 *  every other account's keys out inside their twenty-four hours. */
function pruneSeen(seen: Seen[] | undefined, now: number): Seen[] {
  const live = (seen ?? []).filter((s) => now - s.at < IDEMPOTENCY_TTL_MS);
  const perTenant = new Map<string, number>();
  const kept: Seen[] = [];
  // Newest first, so the first MAX of each tenant are the ones to keep.
  for (const s of [...live].reverse()) {
    const t = s.t ?? "";
    const n = (perTenant.get(t) ?? 0) + 1;
    perTenant.set(t, n);
    if (n <= IDEMPOTENCY_MAX) kept.push(s);
  }
  return kept.reverse();
}

const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 32);

export type Admission =
  | { admit: true }
  /** Dropped. `reason` is what the caller tells the sender, and what goes in
   *  the log — a hook that answers 200 with no explanation looks broken. */
  | { admit: false; reason: "duplicate" | "throttled" | "quarantined" | "paused" | "halted" | "filtered"; detail: string }
  /** Held. It will fire from the scheduler's tick when the burst stops. */
  | { admit: false; reason: "debounced"; detail: string; firesAt: number };

/**
 * Should this trigger become a run?
 *
 * `deliveryKey` is the value the flow's `idempotency:` field named, already
 * read off the request by whoever received it — this module never sees a
 * request, only the identifier one carried.
 *
 * `body` is the task the run would have been given, kept only when the flow
 * debounces, because that is the one case where the event has to survive
 * until later.
 *
 * A manual run never comes here. Someone clicking Run has decided, and a
 * throttle that argued with them would be a bug, not a policy.
 */
export async function admitTrigger(
  tenant: string,
  workspace: string,
  flow: FlowInfo,
  opts: { deliveryKey?: string | null; body?: string; tag?: string; fields?: unknown; now?: number } = {},
): Promise<Admission> {
  const now = opts.now ?? Date.now();
  const key = keyOf(tenant, workspace, flow.name);
  const cursor = await getCursor(tenant, workspace, flow.name);

  // Every decision is written down, admits included: the page that answers
  // "why did nothing run" needs the ratio, not just the refusals.
  const note = (outcome: TriggerOutcome, detail: string) =>
    recordTriggerEvent(tenant, workspace, {
      t: new Date(now).toISOString(),
      flow: flow.name,
      trigger: flow.trigger,
      outcome,
      detail,
    });

  // ---- halted: the account or the workspace is paused by its people (the
  // kill switch). First, before a delivery is remembered or a window
  // started: nothing about this fire happened except that it was refused.
  const halt = pauseOf(await adminState(tenant), workspace);
  if (halt) {
    const detail = `${halt.scope === "account" ? "the account" : "this workspace"} is paused by ${halt.by}${halt.reason ? ` — ${halt.reason}` : ""}; resume it to run again`;
    note("halted", detail);
    return { admit: false, reason: "halted", detail };
  }

  // ---- filter: a delivery the flow's own file says is not for it. After
  // the kill switch (a paused account is told so, whatever arrives), before
  // a delivery is remembered or a window started: an event that does
  // not match is not one of this flow's events, so it counts toward no
  // idempotency key, throttle, debounce or disable_after. Written down all
  // the same — "the hook fired and nothing ran" is this page's question.
  if (flow.filter != null && opts.fields !== undefined) {
    const v = matchFilter(flow.filter, opts.fields);
    if (!v.match) {
      const detail = `filter: ${v.reason} — no run started`;
      note("filtered", detail);
      return { admit: false, reason: "filtered", detail };
    }
  }

  // ---- idempotency: the same delivery is one event, however many times
  // the sender says it.
  if (flow.idempotency && opts.deliveryKey) {
    const h = hash(`${key}/${opts.deliveryKey}`);
    const seen = await seenBefore(h, now);
    if (seen.dup) {
      const detail = `already handled this ${flow.idempotency} — no run started`;
      note("duplicate", detail);
      return { admit: false, reason: "duplicate", detail };
    }
    rememberSeen({ h, at: now, t: tenant });
  }

  // ---- disable_after: a flow that only fails stops being fired.
  const quarantine = quarantineReason(tenant, workspace, flow);
  if (quarantine) {
    // Told once per outage, whichever trigger tripped it — a webhook flow
    // switching itself off used to be silent, because the notice lived in
    // the cron loop.
    const announce = !cursor.quarantinedAt;
    if (announce) await setCursor(tenant, workspace, flow.name, { ...cursor, quarantinedAt: now });
    note("quarantined", quarantine);
    if (announce) {
      void import("../../foldrun-core/src/notify.ts")
        .then(({ sendPlainNotification }) =>
          sendPlainNotification(tenant, workspace, {
            event: "quarantined",
            headline: `\u26d4 ${flow.name} has been switched off`,
            detail: quarantine,
            flow: flow.name,
          }),
        )
        .catch(() => false);
    }
    return { admit: false, reason: "quarantined", detail: quarantine };
  }
  // ---- pause_when: a flow whose work is finished stops being fired.
  const pause = pauseReason(tenant, workspace, flow);
  if (pause) {
    note("paused", pause.detail);
    // Told once per finish: keyed by the run that said so, so the same
    // pause is not re-announced on every tick, and a later finish is.
    if (claimPauseNotice(tenant, workspace, flow.name, pause.runId)) {
      void import("../../foldrun-core/src/notify.ts")
        .then(({ sendPlainNotification }) =>
          sendPlainNotification(tenant, workspace, {
            event: "paused",
            headline: `\u23f8 ${flow.name} has paused itself: its work is done`,
            detail: pause.detail,
            flow: flow.name,
            runId: pause.runId,
          }),
        )
        .catch(() => false);
    }
    return { admit: false, reason: "paused", detail: pause.detail };
  }

  // Not quarantined any more — forget that it ever was, so the next outage
  // is announced as its own rather than swallowed as a repeat. Cleared here
  // rather than when a run completes, because "is it still off" is asked
  // exactly here and nowhere else.
  let dirty = false;
  if (cursor.quarantinedAt) {
    delete cursor.quarantinedAt;
    dirty = true;
  }

  // ---- throttle: a floor between two runs.
  if (flow.throttle) {
    const last = cursor.lastRunAt ?? 0;
    const wait = last + flow.throttle * 1000 - now;
    if (wait > 0) {
      if (dirty) await setCursor(tenant, workspace, flow.name, cursor);
      const detail = `throttle: ${flow.throttle}s — the last run of this flow started ${Math.round((now - last) / 1000)}s ago`;
      note("throttled", detail);
      return { admit: false, reason: "throttled", detail };
    }
  }

  // ---- debounce: wait for the burst to stop, then fire once.
  if (flow.debounce) {
    const prev = cursor.pending;
    cursor.pending = {
      firesAt: now + flow.debounce * 1000,
      body: (opts.body ?? "").slice(0, 20_000),
      tag: opts.tag ?? "event",
      count: (prev?.count ?? 0) + 1,
    };
    await setCursor(tenant, workspace, flow.name, cursor);
    const detail = `debounce: ${flow.debounce}s — held, and fires once the events stop`;
    note("debounced", detail);
    return { admit: false, reason: "debounced", detail, firesAt: cursor.pending.firesAt };
  }

  cursor.lastRunAt = now;
  await setCursor(tenant, workspace, flow.name, cursor);
  note("started", "");
  return { admit: true };
}

/**
 * Has this exact request already been handled?
 *
 * For the manual run API, where the caller supplies the key rather than a
 * delivery carrying one. A client that retries a start call — a dropped
 * response, a proxy timeout, a CI step run twice — otherwise gets two runs
 * and pays for both, and the second one is invisible until the bill.
 *
 * Returns the run id already started, or null for a request nobody has seen.
 * Claiming and answering are one call so two simultaneous retries cannot
 * both find nothing.
 */
export async function claimRequestKey(
  tenant: string,
  workspace: string,
  scope: string,
  key: string,
  runId: string,
  now = Date.now(),
): Promise<string | null> {
  const h = hash(`${tenant}/${workspace}/${scope}/${key}`);
  const seen = await seenBefore(h, now, runId);
  if (seen.dup) return seen.runId ?? "";
  rememberSeen({ h, at: now, t: tenant, runId });
  return null;
}

/** Fill in which run a claimed key started. Claiming happens before the run
 *  exists — so two simultaneous retries cannot both win — and this closes
 *  the loop, so a later retry is answered with the run rather than a bare
 *  "duplicate". */
export async function noteRequestRun(
  tenant: string,
  workspace: string,
  scope: string,
  key: string,
  runId: string,
): Promise<void> {
  try {
    const h = hash(`${tenant}/${workspace}/${scope}/${key}`);
    const c = cache();
    if (c) {
      try {
        // Only if still claimed: XX, so a claim that was released meanwhile
        // is not resurrected.
        await c.set(`idem:${h}`, runId, "PX", IDEMPOTENCY_TTL_MS, "XX");
      } catch {
        // fall through to the file
      }
    }
    const seen = loadSeen();
    const hit = seen.find((s) => s.h === h);
    if (!hit || hit.runId) return;
    hit.runId = runId;
    storeSeen(seen);
  } catch {
    // best effort: the claim already stopped the second run, which is the job
  }
}

/** Give a claim back. For the caller whose start failed AFTER claiming —
 *  a budget refusal, a queue error — where leaving the key claimed would
 *  answer every retry for a day with "duplicate" and no run at all. Only a
 *  claim that never got a run is released: one that did has done its job. */
export async function releaseRequestKey(tenant: string, workspace: string, scope: string, key: string): Promise<void> {
  try {
    const h = hash(`${tenant}/${workspace}/${scope}/${key}`);
    const c = cache();
    if (c) {
      try {
        // Release only a claim that never got a run. A Lua script would be
        // exact; a GET then DEL is close enough for a window this narrow.
        if (((await c.get(`idem:${h}`)) ?? "") === "") await c.del(`idem:${h}`);
      } catch {
        // fall through
      }
    }
    const seen = loadSeen();
    const i = seen.findIndex((s) => s.h === h && !s.runId);
    if (i === -1) return;
    seen.splice(i, 1);
    storeSeen(seen);
  } catch {
    // best effort
  }
}

/**
 * An admitted trigger whose run never started. The admission recorded the
 * delivery as seen and started the throttle window; if the start then
 * threw — out of funds, over budget — a sender's retry would be answered
 * "duplicate" for a day and the flow's window would be counting from a run
 * that does not exist. Undo both, and record that it was the start that
 * failed rather than the gate that refused.
 */
export async function rollbackTrigger(
  tenant: string,
  workspace: string,
  flow: FlowInfo,
  opts: { deliveryKey?: string | null; reason?: string } = {},
): Promise<void> {
  try {
    const key = keyOf(tenant, workspace, flow.name);
    if (flow.idempotency && opts.deliveryKey) {
      await forgetSeen(hash(`${key}/${opts.deliveryKey}`));
    }
    const cursor = await getCursor(tenant, workspace, flow.name);
    if (cursor.lastRunAt) {
      delete cursor.lastRunAt;
      await setCursor(tenant, workspace, flow.name, cursor);
    }
    recordTriggerEvent(tenant, workspace, {
      t: new Date().toISOString(),
      flow: flow.name,
      trigger: flow.trigger,
      outcome: "failed",
      detail: opts.reason ?? "the run could not be started",
    });
  } catch {
    // best effort
  }
}

/**
 * Bursts whose quiet window has passed. The scheduler calls this on its tick
 * and starts each one; taking them removes them, so a tick that crashes
 * after this point loses a run rather than firing it forever.
 */
export async function dueDebounced(now = Date.now()): Promise<{
  tenant: string;
  workspace: string;
  flow: string;
  body: string;
  tag: string;
  count: number;
}[]> {
  const out: Awaited<ReturnType<typeof dueDebounced>> = [];
  for (const { tenant, workspace, flow, pending: p } of await heldBursts()) {
    if (p.firesAt > now) continue;
    out.push({ tenant, workspace, flow, body: p.body, tag: p.tag, count: p.count });
    // Taken as it is read: a tick that crashes after this point loses a
    // run rather than firing it forever. Taking it starts the throttle
    // window, as any start does.
    const cursor = await getCursor(tenant, workspace, flow);
    delete cursor.pending;
    cursor.lastRunAt = now;
    await setCursor(tenant, workspace, flow, cursor);
  }
  return out;
}

/**
 * Why this flow is quarantined, or null.
 *
 * Derived from the runs themselves rather than stored as a flag, so it is
 * self-healing: one successful run — a person clicking Run after a fix —
 * clears it, with nothing to remember to un-set. A flag would need a button,
 * and a button nobody knows about is a flow that never runs again.
 *
 * A run someone started by hand counts only when it succeeds: that is the
 * evidence the fix works, and the one thing that should clear a quarantine.
 * A hand-started failure is a test and never extends the streak.
 */
export function quarantineReason(tenant: string, workspace: string, flow: FlowInfo): string | null {
  if (!flow.disableAfter) return null;
  let consecutive = 0;
  for (const run of recentRuns(tenant, workspace, flow.name)) {
    // A run a person stopped is recorded as failed, and is not evidence of
    // anything about the flow. Bulk-stopping forty runs after a bad deploy
    // must not switch off every flow that has a disable_after:.
    if (run.stopRequested) continue;
    // A run a person started: its success is exactly the evidence that
    // clears a quarantine — the owner fixed it and clicked Run — and its
    // failure is a test, not a verdict on the schedule. So a success by
    // anyone breaks the streak, and only automatic failures extend it.
    if (run.status === "completed") break;
    if (run.status === "failed" && !run.startedBy) consecutive++;
    else continue; // a person's failed test, or queued/running/parked
    if (consecutive >= flow.disableAfter) {
      return `disable_after: ${flow.disableAfter} — the last ${consecutive} runs of this flow failed; it will not fire again until one succeeds`;
    }
  }
  return null;
}

/**
 * Why this flow is paused, or null: its latest finished run — started by the
 * schedule or by a person, but not a test run and not one a person stopped —
 * has a step whose reply leads a line with the `pause_when:` marker.
 *
 * Derived, like quarantineReason, so nothing has to be un-set: when there is
 * work again, a person runs the flow once, that run's planner no longer says
 * DONE, and the schedule resumes from the next tick. A run still going is
 * looked through — it has not said anything yet.
 */
export function pauseReason(
  tenant: string,
  workspace: string,
  flow: FlowInfo,
): { detail: string; runId: string } | null {
  if (!flow.pauseWhen) return null;
  for (const run of recentRuns(tenant, workspace, flow.name)) {
    if (run.status !== "completed" && run.status !== "failed") continue;
    if (run.stopRequested || run.test) continue;
    const said = (run.steps ?? []).some((s) => markerPresent(s.result, flow.pauseWhen!));
    if (!said) return null;
    return {
      runId: run.id,
      detail:
        `pause_when: ${flow.pauseWhen} — run ${run.id} reported ${flow.pauseWhen}, so the schedule is paused. ` +
        `Run the flow once by hand when there is new work; a run that does not say ${flow.pauseWhen} resumes it.`,
    };
  }
  return null;
}

/** True the first time a given run's pause is seen, false after: one notice
 *  per finish. A small file per account, beside the runs it refers to. */
function claimPauseNotice(tenant: string, workspace: string, flow: string, runId: string): boolean {
  const file = path.join(dataRoot(), tenant, ".paused-notices.json");
  let seen: Record<string, string> = {};
  try {
    seen = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
  } catch {
    seen = {};
  }
  const key = `${workspace}/${flow}`;
  if (seen[key] === runId) return false;
  seen[key] = runId;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(seen));
  } catch {
    // an unwritable file means a repeated notice, never a missed pause
  }
  return true;
}

/**
 * This flow's recent runs, newest first.
 *
 * NOT listRuns: that parses every run file in the workspace, and this is
 * called on every delivery to a hook with `disable_after:` set — a busy
 * hook on a workspace with a few thousand runs would parse a few thousand
 * files per POST. Run ids are `run-<base36 time>-<random>`, so sorting the
 * file names sorts them by time, and only the newest handful need opening.
 *
 * The newest handful OF THIS FLOW. The window used to be the workspace's
 * newest sixty files, whatever flow they were — so sixty runs of a busy
 * neighbour pushed the deciding run out, and a quarantine or a pause lifted
 * by itself. Which flow a run belongs to never changes, so it is learnt
 * once per file (FLOW_OF) and the walk skips other flows' files unopened.
 */
const RECENT_FILES = 60;

/** Run file name → its flow, per runs directory. Pruned to the directory's
 *  current listing on every read, so a pruned run is forgotten too. */
const FLOW_OF = new Map<string, Map<string, string>>();

function recentRuns(tenant: string, workspace: string, flow: string): RunRecord[] {
  try {
    const dir = path.join(workspaceDir(tenant, workspace), "runs");
    const names = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json") && !f.startsWith("."))
      .sort()
      .reverse();
    const known = FLOW_OF.get(dir) ?? new Map<string, string>();
    const seen = new Map<string, string>();
    const out: RunRecord[] = [];
    for (const name of names) {
      const cached = known.get(name);
      if (cached !== undefined) seen.set(name, cached);
      if (out.length >= RECENT_FILES || (cached !== undefined && cached !== flow)) continue;
      let run: RunRecord;
      try {
        run = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as RunRecord;
      } catch {
        continue; // mid-write or torn: not remembered, read again next time
      }
      seen.set(name, run.flow);
      if (run.flow === flow) out.push(run);
    }
    FLOW_OF.set(dir, seen);
    return out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  } catch {
    return [];
  }
}

/** Record that a run of this flow started, so `throttle:` has a floor to
 *  measure from. Called for admitted triggers and for manual runs alike —
 *  a person's run still resets the window, because the window is about how
 *  often the work happens, not about who asked. */
export async function noteRunStarted(tenant: string, workspace: string, flow: string, now = Date.now()): Promise<void> {
  const cursor = await getCursor(tenant, workspace, flow);
  cursor.lastRunAt = now;
  await setCursor(tenant, workspace, flow, cursor);
}

/** For tests: nothing remembered about any flow. */
export async function resetTriggerState(): Promise<void> {
  memorySeen = [];
  await resetFlowState();
}
