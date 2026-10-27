// The run queue. A job is a file; claiming it is renaming it. That is the
// whole mechanism, and it is chosen to match how everything else here works:
// the run record on disk is already the source of truth for a run's state,
// so the queue only has to remember one thing the record cannot — that
// nobody is driving this run yet.
//
// Layout, under dataRoot():
//
//   queue/
//   ├── pending/<startedMs>-<tenant>.json     waiting for a worker
//   └── claimed/<startedMs>-<tenant>.json     a worker is driving it
//
// rename() within one filesystem is atomic, so two workers racing for the
// same job cannot both win: one rename succeeds, the other throws ENOENT and
// moves on. There are no locks, no leases and no heartbeats — this queue
// serves one host, and on that host a claimed job whose worker died is
// recovered by the only sweep that can be wrong about it: the one at boot,
// before any worker has started. (Multi-host is a different product tier and
// a different queue.)
//
// The timestamp prefix makes a plain directory listing FIFO. The tenant in
// the name is cosmetic — the job body is authoritative.

import { assertAccountActive, assertNotPaused, adminState, pauseOf } from "./admin.ts";
import { noteNewHosts } from "./host-watch.ts";
import { exportRunTrace } from "./otel-export.ts";
import { ensureBaseline, headRevision } from "../../foldrun-core/src/history.ts";
import fs from "node:fs";
import path from "node:path";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import {
  accountDir,
  listTenants,
  listWorkspaces,
  listRunSummaries,
  workspaceDir,
  listFlows as listWorkspaceFlows,
  readRun,
  runFilePath,
  writeRun,
  type FlowStep,
  type RunRecord,
  isSplicedRecord,
} from "../../foldrun-core/src/store.ts";
import {
  loadFlow, createFlowRun, driveRun, drivingRuns } from "../../foldrun-core/src/runner.ts";
import { killRunSandboxes } from "../../foldrun-core/src/run-container.ts";
import { detachFromRunPods, killRunPods } from "./run-k8s.ts";
import { redriveUnsettled, settleRun } from "./settle.ts";
import { withHousekeeping } from "./housekeeping.ts";
import { billingMetrics } from "./billing-metrics.ts";
import { egressUrl, renewEgressLeases, startEgressProxy } from "./egress-proxy.ts";
import { sendRunNotification } from "../../foldrun-core/src/notify.ts";
import { fireChainedFlows } from "../../foldrun-core/src/triggers.ts";
import { accountConcurrency, accountPriority, accountWeight, priorityWeight } from "./limits.ts";
import { billing } from "./billing.ts";
import { bindReservation, dropReservation, heldUsd, releaseReservation, reserveAdmission, sweepReservations } from "./reservations.ts";
import { accountUsage } from "./usage.ts";
import { noteRunStarted } from "./trigger-gate.ts";
import { databaseEnabled, orm } from "./db.ts";
import { queue as queueTable } from "./schema.ts";
import { anyLeaseHeld, cacheEnabled, leaseHeld, leaseOwner, releaseLease, takeLease } from "./cache.ts";
import os from "node:os";
import {
  claimNextDb,
  claimedCountDb,
  queuedRunIdsDb,
  touchClaimDb,
  claimedRowsDb,
  enqueueDb,
  handBackDb,
  lineUpDb,
  recoverStaleDb,
  releaseDb,
  removeDb,
  statsDb,
  takeJobDb,
} from "./queue-db.ts";

export interface QueueJob {
  tenant: string;
  workspace: string;
  runId: string;
  modelOverride?: string | null;
  tags?: string[];
  /** Claimable only from this ISO time — how a `wait:` parks in the queue
   *  instead of in a process. */
  notBefore?: string;
}

function queueDir(state: "pending" | "claimed") {
  return path.join(dataRoot(), "queue", state);
}

// Two enqueues in the same millisecond used to sort by the run id's random
// suffix, so "first in, first out" was a coin toss on a fast box — the deploy
// gate caught it, the dev laptop never had. A per-process sequence after the
// milliseconds settles the tie in the order the calls were made. Nothing
// parses the prefix (readers match `-${runId}.json`; claiming sorts the
// names), so it is wider and nothing else changes. Across processes a
// same-millisecond order was never defined and still is not.
let enqueueSeq = 0;
function jobFileName(job: QueueJob) {
  // Millisecond prefix for FIFO ordering, sequence for ties, runId for
  // uniqueness (it already carries its own randomness). Re-enqueueing the
  // same run overwrites any pending file for it — see await enqueue().
  enqueueSeq = (enqueueSeq + 1) % 1_000_000;
  const ms = Date.now().toString().padStart(14, "0");
  return `${ms}${String(enqueueSeq).padStart(6, "0")}-${job.runId}.json`;
}

/**
 * Runs of this tenant executing right now, not counting the one asking.
 * On the database: its claimed rows, one indexed count — a claim IS a run
 * being driven, on whichever worker. On the file store: status running on
 * disk, which is the record the one process agrees with itself on. This
 * used to parse every run file of the account on every claim.
 */
async function countRunning(tenant: string, exceptRunId: string): Promise<number> {
  if (databaseEnabled()) return claimedCountDb(tenant, exceptRunId);
  let n = 0;
  for (const ws of listWorkspaces(tenant)) {
    for (const r of listRunSummaries(tenant, ws.name)) if (r.status === "running" && r.id !== exceptRunId) n += 1;
  }
  return n;
}

/** How much of the balance is held against runs admitted and not settled:
 *  the sum of their reservations. The number the wallet shows as "held",
 *  so a balance lower than the last top-up has a reason. */
export async function heldForRunsUsd(tenant: string): Promise<number> {
  return Number((await heldUsd(tenant)).usd.toFixed(2));
}

/**
 * The money gate, the account's `budget:` and the workspace's, judged and
 * HELD in one transaction (reservations.ts) — then the record, then the
 * hold bound to it. If the record cannot be written the hold is dropped,
 * so a crash between the two never keeps an account's money for a run
 * that does not exist. `assertAccountActive` stays outside: a suspended
 * account is refused before any money is read.
 */
async function admit<T extends RunRecord>(tenant: string, workspace: string, flow: string | null | undefined, create: () => T): Promise<T> {
  const hold = await reserveAdmission(tenant, workspace, flow);
  let run: T;
  try {
    run = create();
  } catch (err) {
    await dropReservation(tenant, hold).catch(() => {});
    throw err;
  }
  await bindReservation(tenant, hold, run.id);
  return run;
}

/** A pending job for this run, if one exists. Claimed jobs don't count — the
 *  run is being driven, which is not a state enqueueing should duplicate. */
function pendingFileFor(runId: string): string | null {
  const dir = queueDir("pending");
  if (!fs.existsSync(dir)) return null;
  const hit = fs.readdirSync(dir).find((f) => f.endsWith(`-${runId}.json`));
  return hit ? path.join(dir, hit) : null;
}

async function enqueue(job: QueueJob) {
  // One pending job per run, ever. Approving two steps in quick succession, or
  // reconcile racing the approval API, must not line the same run up twice —
  // driveRun on an already-finished record would find no pending steps and
  // mark everything skipped. The file queue got this from a filename check;
  // the table gets it from a unique index, which cannot race.
  //
  // A CLAIMED row is not "lined up" on the table, though: its worker
  // deletes it on release. lineUpDb flags it instead, and the release puts
  // it back — the approval that lands as a run parks is not lost. The file
  // queue has no such trap: a claimed file is not a pending one, so a fresh
  // pending file is written and the release removes only the claimed one.
  if (databaseEnabled()) {
    await lineUpDb({ ...job, ...(await laneOf(job)) });
    return;
  }

  const dir = queueDir("pending");
  fs.mkdirSync(dir, { recursive: true });
  const existing = pendingFileFor(job.runId);
  if (existing) return;

  const file = path.join(dir, jobFileName(job));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Put a job this worker HOLDS back in the queue — deferred by overlap: or
 * the plan cap, or parked on a wait: with its deadline.
 *
 * Not enqueue(): its "already lined up" guard sees the very row this worker
 * has claimed and does nothing, the row stays claimed, and the finally's
 * release then deletes it — the run sat `queued` with an empty queue, and
 * on Postgres every wait: step did exactly that. The upsert is the right
 * verb here: it clears the claim, keeps the run's original position, and
 * sets the not-before. The file store has no such guard problem — a fresh
 * pending file is written and the finally removes the claimed one.
 */
async function handBack(job: QueueJob) {
  if (databaseEnabled()) {
    // With its lane, cap and weight, read now — the claimed row read back
    // carries none of them, and the upsert wrote NULL and 0, so a deferred
    // fast-lane run came back as a normal one with no cap. Read now, not
    // copied from when it was first lined up: a plan the operator changed
    // meanwhile applies to the run's next turn.
    await enqueueDb({ ...job, ...(await laneOf(job)) });
    return;
  }
  await enqueue(job);
}

/**
 * Is this run a test run? Only when asked for outright. (A branch preview's
 * runs were test runs by default; previews went with the platform's own git
 * on 17 Oct 2026, and come back with a connected GitHub.)
 */
export function isTestRun(_tenant: string, _workspace: string, _flowName: string, opts: { test?: boolean }): boolean {
  return opts.test ?? false;
}

/**
 * Create a `queued` run and line it up for a worker. The record exists on
 * disk before the job does, so a claimed job always finds its run.
 */
export async function enqueueFlowRun(
  tenant: string,
  workspace: string,
  steps: FlowStep[],
  flowName: string,
  modelOverride?: string | null,
  tags: string[] = [],
  startedBy: string | null = null,
  opts: { test?: boolean; notBefore?: string } = {},
): Promise<RunRecord> {
  // Money is checked where work is added, and only where work is added —
  // resuming a parked run skips this on purpose. No-op unless the install
  // enforces billing (FOLDRUN_BILLING=1).
  await assertAccountActive(tenant);
  await assertNotPaused(tenant, workspace);
  const run = await admit(tenant, workspace, flowName, () =>
    createFlowRun(tenant, workspace, steps, flowName, "queued", tags, startedBy, { test: isTestRun(tenant, workspace, flowName, opts) }),
  );
  await enqueue({ tenant, workspace, runId: run.id, modelOverride, tags, ...(opts.notBefore ? { notBefore: opts.notBefore } : {}) });
  // `throttle:` measures from the last run of this flow however it started.
  // A person's run resets the window too: the window is about how often the
  // work happens, not about who asked for it.
  await noteRunStarted(tenant, workspace, flowName);
  return run;
}

/**
 * Line an existing run back up — the approval API calls this for a parked
 * run once a decision lands. driveRun re-enters on the record as saved, so
 * the job carries no model override: a resumed step's model was already
 * resolved onto the record's events the first time through, and the
 * override, if any, came from the flow file which is re-read regardless.
 */
export async function enqueueResume(tenant: string, workspace: string, runId: string) {
  await enqueue({ tenant, workspace, runId });
}

/**
 * Stop a run a person no longer wants.
 *
 * Three things, in the order that makes them true: drop any queued job so
 * nothing picks it up next, destroy the sandbox any in-flight step is
 * burning money in, and mark the record. A stop that only set a flag would
 * be a promise to stop *eventually* — a browser step can have fifteen
 * minutes left, and the pod is the thing actually spending.
 *
 * `stopRequested` stays on the record beside the failed status, because
 * "failed" and "someone stopped it" are different facts. The driver reads
 * it at the next group boundary and skips the rest, which is what stops a
 * multi-step flow rather than just its current step.
 *
 * The steps already finished keep their results and their costs: they ran,
 * and they are billed. Who bills them depends on whether anyone is driving
 * the run. A driver (a claim, this process's own loop, a record that says
 * `running`) finishes its drive, sees the stop, and settles as it always
 * does — settling here first would close the run's one ledger line before
 * the killed step's cost reached the record. A run nobody is driving — one
 * parked on an approval or a `wait:`, one still queued — has no worker left
 * to settle it once its job is gone, so it is settled here. Settling is
 * once per run id either way (recordRunCost), so the two can never both
 * charge.
 */
export function stopRun(tenant: string, workspace: string, runId: string): RunRecord {
  const run = readRun(tenant, workspace, runId);
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.status === "completed" || run.status === "failed") {
    throw new Error(`run ${runId} already ${run.status} — nothing to stop`);
  }
  let driven = run.status === "running" || drivingRuns.has(runId);

  const pending = pendingFileFor(runId);
  if (pending) fs.rmSync(pending, { force: true });
  for (const state of ["pending", "claimed"] as const) {
    const dir = queueDir(state);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(`-${runId}.json`)) continue;
      if (state === "claimed") driven = true;
      fs.rmSync(path.join(dir, name), { force: true });
    }
  }

  let killed = 0;
  try {
    killed =
      process.env.FOLDRUN_RUN_ISOLATION === "k8s"
        ? killRunPods(runId)
        : killRunSandboxes(runId);
  } catch {
    // A sandbox we cannot reach must not stop us from stopping the run.
  }

  const now = new Date().toISOString();
  for (const step of run.steps) {
    if (step.status === "pending" || step.status === "running" || step.status === "awaiting-approval") {
      if (step.status === "running") {
        step.events.push({ t: now, type: "error", text: "stopped by a person — sandbox destroyed" });
      }
      step.status = "skipped";
      step.skipReason = "run stopped";
    }
  }
  run.status = "failed";
  run.stopRequested = true;
  run.parkedAt = null;
  run.finishedAt = now;
  run.steps[0]?.events.push({
    t: now,
    type: "info",
    text: killed ? `run stopped — ${killed} sandbox(es) destroyed` : "run stopped",
  });
  writeRun(tenant, workspace, run);
  // The record says stopped from here on; the rest does not have to finish
  // before the person hears so, and settleRun never throws.
  void settleStopped(tenant, workspace, runId, driven).catch((err) =>
    console.error(`[foldrun] stop: settling ${runId}:`, err),
  );
  return run;
}

/**
 * The half of a stop that talks to the stores. The queue row goes (the
 * file queue's job was removed above; the table's was not, and a claim
 * left in it counted against the account's cap until recovery dropped
 * it). Then the bill: a driven run's worker settles it; otherwise it is
 * settled here — which also lets go of its hold on the caps. A driven
 * run's hold is let go now, as before: its worker settles it, and the
 * hourly sweep is the backstop.
 */
async function settleStopped(tenant: string, workspace: string, runId: string, driven: boolean): Promise<void> {
  if (databaseEnabled()) {
    const removed = await takeJobDb(runId);
    if (removed?.claimed) driven = true;
  }
  if (driven) {
    await releaseReservation(tenant, runId).catch(() => {});
    return;
  }
  await settleRun(tenant, workspace, runId);
  // A run stopped while parked never returns through the worker, so its
  // trace leaves from here (a driven one's leaves when the driver ends).
  const stopped = readRun(tenant, workspace, runId);
  if (stopped) void exportRunTrace(tenant, workspace, stopped);
}

/**
 * What the worker does when a run it drove ends, for a run that ended
 * without it — closed by reconcile after its process died, or resumed by
 * reconcile and driven to its end. Settled (billed), told, its new sites
 * noted, its trace sent and its chained flows started. Each part is safe to
 * repeat: the ledger takes one run once, the trace is claimed once.
 */
export async function afterReconciled(tenant: string, workspace: string, runId: string): Promise<void> {
  const run = readRun(tenant, workspace, runId);
  if (!run || (run.status !== "completed" && run.status !== "failed")) return;
  await settleRun(tenant, workspace, runId);
  await noteNewHosts(tenant, workspace, run);
  void exportRunTrace(tenant, workspace, run);
  await sendRunNotification(tenant, workspace, run);
  await fireChainedFlows(tenant, workspace, run);
}

/**
 * Start a flow from one of its steps, fresh — the current flow file, not a
 * recorded run. The steps before the starting point are marked skipped with
 * the reason on them: they did not run in THIS run, and pretending
 * otherwise would put results in the record that nothing produced. Later
 * steps find their inputs where these flows actually keep them — files/ —
 * which is what makes a partial start meaningful at all.
 *
 * This is also the cheap way to iterate on a late step: fixture runs, with
 * the workspace's own files as the fixtures, without paying for the steps
 * that produce them.
 */
export async function startFlowFromStep(
  tenant: string,
  workspace: string,
  flowName: string,
  fromStep: number, // the step number as the flow file numbers it — a GROUP,
  //                   so "from step 3" keeps all of step 3's parallel agents
  startedBy: string | null = null,
  opts: { test?: boolean } = {},
): Promise<RunRecord> {
  const flow = listWorkspaceFlows(tenant, workspace).find((f) => f.name === flowName);
  if (!flow) throw new Error(`flow ${flowName} not found`);
  const maxGroup = Math.max(...flow.steps.map((s) => s.group));
  if (fromStep < 1 || fromStep > maxGroup) {
    throw new Error(`flow ${flowName} has no step ${fromStep} (it has ${maxGroup})`);
  }
  await assertAccountActive(tenant);
  await assertNotPaused(tenant, workspace);
  // Who asked, same as a plain start: a person who starts a gated flow from
  // step 2 is still the person who started it, and the gate's "not your own
  // run" rule has to see that.
  const run = await admit(tenant, workspace, flowName, () => {
    const r = createFlowRun(tenant, workspace, flow.steps, flowName, "queued", [], startedBy, { test: isTestRun(tenant, workspace, flowName, opts) });
    for (const step of r.steps) {
      if (step.group < fromStep) {
        step.status = "skipped";
        step.skipReason = `started from step ${fromStep}`;
      }
    }
    writeRun(tenant, workspace, r);
    return r;
  });
  await enqueue({ tenant, workspace, runId: run.id });
  return run;
}

/**
 * Re-run a finished flow from one of its steps, as a new run.
 *
 * The old record is never mutated — it is history, its outputs are archived
 * under its id, and its ledger line already paid for it. Instead the steps
 * before the chosen one are *carried*: copied with their results so later
 * steps read the same context they would have, marked `carriedFrom` so the
 * meter never bills them twice, their per-step costs zeroed because those
 * dollars are on the original run's line. Everything from the chosen step
 * on is reset to pending and simply runs.
 *
 * Everything after, not just the step itself, because a later step consumed
 * the earlier one's result — an emailer re-sent against a stale extraction
 * is the bug this exists to fix, not a feature.
 *
 * Fan-out instances in the reset range are dropped and their template step
 * restored, so the fan-out re-expands against the fresh result.
 */
export async function rerunFrom(
  tenant: string,
  workspace: string,
  runId: string,
  from: { agent?: string; step?: number },
  startedBy: string | null = null,
  /** `instruction`: what the step it starts from is told this once, in
   *  place of the flow's (FOL-72 step 6) — try a fix before writing it in. */
  opts: { instruction?: string } = {},
): Promise<RunRecord> {
  const edited = typeof opts.instruction === "string" && opts.instruction.trim() ? opts.instruction.trim().slice(0, 20_000) : null;
  const source = readRun(tenant, workspace, runId);
  if (!source) throw new Error(`run ${runId} not found`);
  if (source.status !== "completed" && source.status !== "failed") {
    throw new Error(`run ${runId} is ${source.status} — only a finished run can be re-run`);
  }

  const idx =
    typeof from.step === "number"
      ? from.step - 1 // 1-based on the API, because the trace numbers steps from 1
      : source.steps.findIndex((s) => s.agent === from.agent && !s.item && !isSplicedRecord(s));
  if (idx < 0 || idx >= source.steps.length) {
    throw new Error(
      from.agent
        ? `no step in run ${runId} runs agent "${from.agent}"`
        : `run ${runId} has no step ${from.step}`,
    );
  }
  if (isSplicedRecord(source.steps[idx])) {
    const s = source.steps[idx];
    throw new Error(
      s.subagentOf
        ? `step ${idx + 1} of run ${runId} is a job ${s.subagentOf} handed to ${s.agent}, not a step of the flow — re-run from ${s.subagentOf}'s step`
        : `step ${idx + 1} of run ${runId} is an on-fail rescue, not a step of the flow — re-run from the step it took over`,
    );
  }

  await assertAccountActive(tenant);
  await assertNotPaused(tenant, workspace);

  // Re-runs exist to iterate: fix the flow, re-run the step. So the reset
  // steps take their orders from the flow file as it reads *now*, not as it
  // read when the source run started — a re-run that replays a stale
  // instruction re-fails for the exact reason the author just fixed. That is
  // the instruction AND the step's options: a re-run that kept the old
  // `verify:` re-failed a fixed check (outreach, 2026-09-24), and one that
  // kept no `on-fail:` could not hand a BAD verifier to the rescuer just
  // added for it (medium-desk run-mv76fk77-ok5d, 2026-10-14). Matched
  // positionally over the run's template steps (fan-out instances aside) and
  // only where the agent still agrees; a reshaped flow falls back to the
  // recorded step, because guessing at alignment would rewrite the wrong
  // step's orders. Carried steps keep their history either way — they ran.
  const currentFlow = listWorkspaceFlows(tenant, workspace).find((f) => f.name === source.flow);
  const freshStep = (runIdx: number) => {
    if (!currentFlow) return null;
    const templates = source.steps.filter((st) => !st.item && !isSplicedRecord(st));
    if (templates.length !== currentFlow.steps.length) return null;
    const tIdx = templates.indexOf(source.steps[runIdx]);
    const now_ = currentFlow.steps[tIdx];
    return now_ && now_.agent === source.steps[runIdx].agent ? now_ : null;
  };
  // Every option a flow step carries onto its run record (createRun in core),
  // so a fresh step replaces all of them — an option deleted from the flow
  // is deleted from the re-run too, not inherited from the source.
  const freshOptions = (f: NonNullable<ReturnType<typeof freshStep>>) => ({
    instruction: f.instruction,
    optional: f.optional ?? false,
    model: f.model, effort: f.effort, approve: f.approve,
    when: f.when, case: f.case, else: f.else,
    retry: f.retry, timeout: f.timeout, verify: f.verify,
    loop: f.loop, until: f.until,
    each: f.each, eachPath: f.eachPath, max: f.max,
    onFail: f.onFail, waitSecs: f.waitSecs, waitFor: f.waitFor, ask: f.ask,
    preview: f.preview, delegate: f.delegate, output: f.output,
    schema: f.schema, schemaPath: f.schemaPath, parallel: f.parallel,
    maxTurns: f.maxTurns, limits: f.limits,
  });

  const now = new Date().toISOString();
  const steps: RunRecord["steps"] = [];
  // sandbox: own jobs sit at the end of the record, whatever step asked for
  // them: those of a carried step are carried with it.
  const carriedJobs = new Set(source.steps.slice(0, idx).flatMap((st) => (st.delegations ?? []).map((d) => d.id)));
  for (let i = 0; i < source.steps.length; i++) {
    const s = source.steps[i];
    if (i < idx || (s.subagentOf && s.delegation && carriedJobs.has(s.delegation))) {
      steps.push({
        ...s,
        carriedFrom: runId,
        costUsd: null,
        computeSecs: null,
        startupSecs: null,
        // Ran there: its model calls are on that run, like its events.
        calls: undefined,
        events: [
          { t: now, type: "info", text: `carried from ${runId} — ran there, shown here as context` },
        ],
      });
      continue;
    }
    if (s.item) continue; // an instance of a fan-out that will re-expand
    // An on-fail rescue in the reset range is not work of the flow: its step
    // is reset to pending and will be rescued afresh if it fails again. Copied,
    // it ran as an ordinary step (21 Oct 2026: blog-desk rerun
    // run-mvho48lc-l1cd started with 77 fixers pending). Rescues BEFORE the
    // chosen step are kept, carried like the rest: they ran, and the step
    // they took over shows their result, so the trace stays truthful.
    if (isSplicedRecord(s)) continue;
    const fresh = freshStep(i);
    const step = { ...(fresh ? { ...s, ...freshOptions(fresh) } : s), ...(i === idx && edited ? { instruction: edited } : {}) };
    steps.push({
      ...step,
      status: "pending",
      events: [],
      result: null,
      costUsd: null,
      computeSecs: null,
      startupSecs: null,
      // The source run's model calls are that run's (FOL-54 step 4).
      calls: undefined,
      attempts: 0,
      skipReason: undefined,
      approvedAt: undefined,
      item: undefined,
      // A fresh loop budget, not none: the runner reads an unset
      // loopRemaining as zero, so `undefined` here exhausted every critic
      // loop on its first cycle and no re-run ever sent a draft back to
      // its writer (2026-09-22: three desks, "failed after 3 cycles" with
      // the validator run exactly once).
      loopRemaining: step.loop,
      // The source step's sandbox is that run's, and long gone: carrying the
      // ref made the runner try to re-attach ("sandbox foldrun-run-… is
      // gone — the step cannot be resumed") instead of renting a fresh one.
      sandbox: null,
      carriedFrom: undefined,
      // Its jobs were that run's; this run's are its own.
      delegations: undefined,
    });
  }

  const run = await admit(tenant, workspace, source.flow, () => {
    const r: RunRecord = {
      id: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      flow: source.flow,
      tags: source.tags,
      status: "queued",
      startedAt: now,
      finishedAt: null,
      // The re-run is a new run and the person re-running it is who started
      // it — not whoever started the source. Without this a person could
      // re-run their own failed gated flow and approve the gate themselves.
      ...(startedBy ? { startedBy: startedBy.trim().toLowerCase() } : {}),
      // A test run's re-run is a test run: the carried steps' results came
      // from a run that sent nothing, and the fresh steps must not be the
      // first to act on them for real.
      ...(source.test ? { test: true } : {}),
      rerunOf: { run: runId, step: idx + 1, ...(edited ? { instruction: edited } : {}) },
      steps,
    };
    writeRun(tenant, workspace, r);
    return r;
  });
  await enqueue({ tenant, workspace, runId: run.id });
  return run;
}

/** Claim the oldest pending job, or null. Loses every race gracefully. */
/**
 * Order the pending queue FAIRLY across accounts, not by arrival alone.
 *
 * A plain `readdir().sort()` is FIFO by the timestamp in each filename, which
 * is correct for one account and wrong the moment there are two: an account
 * enqueuing five hundred jobs puts every other customer behind all five
 * hundred of them. That is the difference between "the platform is slow" and
 * "that account is slow", and it is the complaint you cannot answer once you
 * have it.
 *
 * So: round-robin by account, FIFO within each. Every account's oldest job
 * before anyone's second, every account's second before anyone's third. A busy
 * account still finishes all its work and still takes more of the queue than a
 * quiet one — it simply cannot make the quiet one wait behind its whole
 * backlog.
 *
 * The tenant comes from the job BODY, not the filename: the name is
 * `<ms>-<runId>.json` and every runId begins `run-`, so a name-derived tenant
 * would put every account in one bucket and silently degrade to the FIFO this
 * replaces. claimNext already reads each candidate for its notBefore, so this
 * costs the same reads, done once.
 */
export function fairOrder(entries: { name: string; tenant: string }[]): string[] {
  const byTenant = new Map<string, string[]>();
  for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const list = byTenant.get(e.tenant);
    if (list) list.push(e.name);
    else byTenant.set(e.tenant, [e.name]);
  }
  // Accounts taken in the order their OLDEST job arrived, so round-robin does
  // not quietly become alphabetical-by-account.
  const queues = [...byTenant.values()].sort((a, b) => a[0].localeCompare(b[0]));
  const out: string[] = [];
  for (let round = 0; ; round += 1) {
    let moved = false;
    for (const q of queues) {
      if (round < q.length) {
        out.push(q[round]);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return out;
}

/** Pending jobs with the tenant each belongs to, unreadable ones last so a
 *  file caught mid-write is retried rather than dropped from the ordering. */
function pendingWithTenant(dir: string): { name: string; tenant: string }[] {
  const out: { name: string; tenant: string }[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const job = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as QueueJob;
      // Held by its own deadline: not a candidate, and not counted against
      // its account's share either.
      if (job.notBefore && new Date(job.notBefore).getTime() > Date.now()) continue;
      out.push({ name, tenant: job.tenant });
    } catch {
      out.push({ name, tenant: "" }); // mid-write; the claim path settles it
    }
  }
  return out;
}

/**
 * Take the next job, or null.
 *
 * `release` replaces the claimed FILE the caller used to delete: with a
 * database the claim is a row, and handing back a closure means the worker
 * does not have to know which store it is talking to — the one place that
 * could get "finished with this job" wrong is here, not at every call site.
 * `touch` is the heartbeat's, for the same reason.
 *
 * On the table a claim is signed with its own token, the worker's name and
 * a sequence: `<host>:<pid>-<rand>/<n>`. Signed with the worker's name
 * alone, a slot that handed a run back (overlap:, the plan cap, a wait:)
 * and was slow to reach its finally could release — delete — the row a
 * second slot of the SAME worker had just claimed for that run, since both
 * carried one owner. The token makes a release and a heartbeat this
 * claim's and no other's.
 */
export async function claimNext(): Promise<
  { job: QueueJob; release: () => Promise<void>; touch: () => Promise<void> } | null
> {
  if (databaseEnabled()) {
    claimSeq = (claimSeq + 1) % 1_000_000_000;
    const token = `${WORKER_OWNER}/${claimSeq}`;
    const job = await claimNextDb(token, defaultAccountCap());
    if (!job) return null;
    return {
      job: job as QueueJob,
      release: () => releaseDb(job.runId, token),
      touch: () => touchClaimDb(job.runId, token),
    };
  }

  const pending = queueDir("pending");
  if (!fs.existsSync(pending)) return null;
  // A job with an unexpired notBefore stays where it is: a wait: is a deadline
  // in the queue, and skipping is cheaper than claim-and-repark. That filter
  // now lives in pendingWithTenant, which has to open each job anyway.
  for (const name of fairOrder(pendingWithTenant(pending))) {
    const from = path.join(pending, name);
    const to = path.join(queueDir("claimed"), name);
    fs.mkdirSync(queueDir("claimed"), { recursive: true });
    try {
      fs.renameSync(from, to);
    } catch {
      continue; // someone else claimed it between readdir and rename
    }
    try {
      const job = JSON.parse(fs.readFileSync(to, "utf8")) as QueueJob;
      return { job, release: async () => fs.rmSync(to, { force: true }), touch: async () => {} };
    } catch {
      fs.rmSync(to, { force: true }); // unreadable job — drop it, the run
      continue; //                       record survives for reconcile to see
    }
  }
  return null;
}

/** How long a `queued` record with no job row must have sat unchanged
 *  before recovery lines it up (the Postgres queue; see recoverQueue). */
const QUEUED_GRACE_MS = Number(process.env.FOLDRUN_QUEUED_GRACE_MS) || 2 * 60_000;

export interface QueueRecovery {
  requeued: string[];
  dropped: string[];
}

/**
 * Boot-time sweep, before any worker starts. Two repairs:
 *
 * - claimed/ is emptied back into pending/. On a single host, a claimed job
 *   with no live worker process is an interrupted one; re-driving is safe
 *   because driveRun continues a partly-finished record rather than
 *   restarting it. (reconcileRuns will separately have failed the steps that
 *   were mid-flight, which is correct — their processes are gone.)
 *
 * - every `queued` run with no job file gets one. The record is authority;
 *   a lost queue directory must not strand runs in `queued` forever.
 *
 * Also drops pending jobs whose run is already terminal — the inverse
 * orphan, from an approval decided while its resume job still sat pending.
 */
export async function recoverQueue(): Promise<QueueRecovery> {
  const requeued: string[] = [];
  const dropped: string[] = [];

  if (databaseEnabled()) {
    // Two differences from the file path, and both are the point of the move.
    //
    // A claim carries WHEN it was made, so an abandoned one is recoverable at
    // any time rather than only at boot before any worker starts — which is
    // what lets a second worker pick up after a first is killed, instead of the
    // run waiting for someone to restart the platform.
    //
    // And a run that finished while its job sat there is dropped by asking the
    // record, exactly as before: the queue's one fact is "nobody is driving
    // this yet", and the record is still the source of truth for the rest.
    const dead = await recoverDeadClaims();
    if (dead.length) requeued.push(`${dead.length} claim(s) of dead worker(s)`);
    const stale = await recoverStaleDb(CLAIM_STALE_MS);
    if (stale) requeued.push(`${stale} stale claim(s)`);
    const q = orm();
    if (q) {
      const rows = await q.select({ runId: queueTable.runId, tenant: queueTable.tenant, workspace: queueTable.workspace }).from(queueTable);
      for (const r of rows) {
        const run = readRun(r.tenant, r.workspace, r.runId);
        if (!run || run.status === "completed" || run.status === "failed") {
          await removeDb(r.runId);
          dropped.push(r.runId);
        }
      }
      // And the file path's second repair: a `queued` run with no row gets
      // one. Only once its record has sat still for a while — this boot is
      // one pod of several, and a run another pod admitted a moment ago has
      // its record written before its row (enqueueFlowRun), so a young
      // record is an enqueue in flight, not a stranded run.
      const lined = await queuedRunIdsDb();
      const now = Date.now();
      for (const tenant of listTenants()) {
        for (const workspace of listWorkspaces(tenant)) {
          for (const summary of listRunSummaries(tenant, workspace.name)) {
            if (summary.status !== "queued" || lined.has(summary.id)) continue;
            let age = 0;
            try {
              age = now - fs.statSync(runFilePath(tenant, workspace.name, summary.id)).mtimeMs;
            } catch {
              continue;
            }
            if (age < QUEUED_GRACE_MS) continue;
            await enqueue({ tenant, workspace: workspace.name, runId: summary.id, tags: summary.tags });
            requeued.push(summary.id);
          }
        }
      }
    }
    return { requeued, dropped };
  }

  const claimed = queueDir("claimed");
  if (fs.existsSync(claimed)) {
    for (const name of fs.readdirSync(claimed)) {
      if (!name.endsWith(".json")) continue;
      fs.mkdirSync(queueDir("pending"), { recursive: true });
      try {
        fs.renameSync(path.join(claimed, name), path.join(queueDir("pending"), name));
        requeued.push(name);
      } catch {
        // a racing recovery already moved it
      }
    }
  }

  const pending = queueDir("pending");
  if (fs.existsSync(pending)) {
    for (const name of fs.readdirSync(pending)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(pending, name);
      try {
        const job = JSON.parse(fs.readFileSync(file, "utf8")) as QueueJob;
        const run = readRun(job.tenant, job.workspace, job.runId);
        if (!run || run.status === "completed" || run.status === "failed") {
          fs.rmSync(file, { force: true });
          dropped.push(name);
        }
      } catch {
        fs.rmSync(file, { force: true });
        dropped.push(name);
      }
    }
  }

  for (const tenant of listTenants()) {
    for (const workspace of listWorkspaces(tenant)) {
      for (const summary of listRunSummaries(tenant, workspace.name)) {
        if (summary.status !== "queued") continue;
        if (pendingFileFor(summary.id)) continue;
        await enqueue({ tenant, workspace: workspace.name, runId: summary.id, tags: summary.tags });
        requeued.push(summary.id);
      }
    }
  }

  return { requeued, dropped };
}

/** When a run that parked goes back to the queue to be claimed again: its
 *  earliest `wait:` deadline still ahead, or — parked for room (27 Oct
 *  2026) — FOLDRUN_ROOM_RECHECK_SEC from now, whichever is sooner. Null for
 *  a run that is not parked on either (a gate's park waits for its answer). */
export function parkedNotBefore(run: Pick<RunRecord, "status" | "parkedAt" | "steps">, now = Date.now()): string | null {
  if (run.status !== "queued" || !run.parkedAt) return null;
  const due = run.steps
    .filter((st) => st.status === "pending" && st.waitUntil)
    .map((st) => new Date(st.waitUntil!).getTime())
    .filter((t) => t > now);
  if (run.steps.some((st) => st.status === "pending" && st.roomWait)) due.push(now + roomRecheckMs());
  return due.length ? new Date(Math.min(...due)).toISOString() : null;
}

/** How long a run parked for room waits in the queue before it is claimed
 *  to look again: FOLDRUN_ROOM_RECHECK_SEC, default 20 s. */
function roomRecheckMs() {
  const n = Number(process.env.FOLDRUN_ROOM_RECHECK_SEC);
  return Number.isFinite(n) && n > 0 ? n * 1000 : 20_000;
}

// How many runs drive at once. A run is mostly waiting on a model, so this
// is about memory and fairness, not CPU. Overridable per install.
function concurrency() {
  const n = Number(process.env.FOLDRUN_CONCURRENCY);
  return Number.isInteger(n) && n > 0 ? n : 2;
}

/** The install's default for how many runs ONE account may have in flight
 *  across the whole fleet, for an account with no cap of its own.
 *  FOLDRUN_CONCURRENCY is a pod's slots; this is a tenant's share of all of
 *  them, enforced at claim time in the database, so it holds however many
 *  worker pods there are. Unset is no cap — right for a single-account box,
 *  wrong for a platform, where a fan-out flow would otherwise take every
 *  slot in the fleet until it finished. */
function defaultAccountCap() {
  const n = Number(process.env.FOLDRUN_ACCOUNT_CONCURRENCY);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** Where the job stands: the account's lane plus the flow's own. A run
 *  with no flow (an ad-hoc agent run) carries the account's alone. */
async function priorityFor(tenant: string, workspace: string, flowName: string | null | undefined): Promise<number> {
  let flowLevel: unknown = null;
  if (flowName) {
    try {
      flowLevel = loadFlow(tenant, workspace, flowName)?.priority ?? null;
    } catch {
      // an unreadable flow is not a reason to refuse the run; it queues at normal
    }
  }
  return (await accountPriority(tenant)) + priorityWeight(flowLevel);
}

/** Where a job stands in the queue: its account's cap, its lane and its
 *  account's weight — what every row a worker writes must carry. */
async function laneOf(job: QueueJob) {
  return {
    accountCap: await accountCapFor(job.tenant),
    priority: await priorityFor(job.tenant, job.workspace, readRun(job.tenant, job.workspace, job.runId)?.flow),
    accountWeight: await accountWeight(job.tenant),
  };
}

/** The cap to carry on a job: the account's own number, or the plan's when
 *  billing is on — the same rule the run-start check applies. */
async function accountCapFor(tenant: string): Promise<number | null> {
  const limit = await accountConcurrency(tenant);
  if (limit && (limit.source === "account" || billing().enabled())) return limit.cap;
  return null;
}

const POLL_MS = 1000;

/**
 * The worker's hourly pass over every account.
 *
 * The engine's half runs on every install: holds a spend budget no longer
 * needs (a run stopped, deleted or never written), run costs that could not
 * be recorded when the run finished, and the history window
 * (FOLDRUN_RETENTION_DAYS). Billing's half — the wallet guard, dunning, a
 * hand-placed plan's renewal, the daily lines and expired credit — runs
 * only where this install charges for runs (billing.ts). Until 25 Oct 2026
 * the whole pass sat behind that check, so an install without billing never
 * released an orphaned budget hold, never re-drove a run's cost and never
 * pruned old runs.
 */
export async function hourlyHousekeeping(): Promise<void> {
  const money = billing().enabled();
  const retentionDays = Number(process.env.FOLDRUN_RETENTION_DAYS);
  const cutoff = Number.isFinite(retentionDays) && retentionDays > 0
    ? Date.now() - retentionDays * 24 * 60 * 60 * 1000
    : null;
  const day = new Date().toISOString().slice(0, 10);
  const guarded: Record<string, number> = {};
  const tenants = listTenants();
  for (const tenant of tenants) {
    try {
      // Holds whose run is over some other way — stopped, deleted, a
      // driver that died — and holds whose run never came to exist.
      const freed = await sweepReservations(tenant);
      if (freed) console.log(`[foldrun] billing: released ${freed} stale reservation(s) for ${tenant}`);
      // Runs whose charge could not be recorded when they finished: the
      // marker is the promise, this is where it is kept.
      const owed = await redriveUnsettled(tenant);
      if (owed.settled.length) console.log(`[foldrun] billing: settled ${owed.settled.length} run(s) for ${tenant} on re-drive`);
      // The wallet guard, dunning and a hand-placed plan's renewal:
      // billing's hourly look at this account (billing.ts).
      if (money) {
        const guard = await billing().hourly(tenant);
        if (guard) guarded[guard] = (guarded[guard] ?? 0) + 1;
      }
      // The daily lines and the retention prune read every run file of
      // the account (accountUsage sums them; the prune walks them). They
      // are idempotent per day, so they run ONCE per day per account —
      // the marker below — and the other twenty-three sweeps skip them.
      // A day that errored is not marked and is retried next hour.
      if (accruedToday(tenant) === day) continue;
      if (money) {
        const usage = await accountUsage(tenant);
        // The daily lines and credit that expired unused (billing.ts).
        await billing().daily(tenant, usage.totals.storageBytes);
      }
      // The plan's history window. Policy pruning, not a person erasing
      // history, so no per-run ledger note — the charges stand and the
      // ledger itself is never pruned. Live runs are never touched.
      if (cutoff !== null) {
        for (const ws of listWorkspaces(tenant)) {
          for (const r of listRunSummaries(tenant, ws.name)) {
            if ((r.status === "completed" || r.status === "failed") &&
                r.finishedAt && new Date(r.finishedAt).getTime() < cutoff) {
              // The index picked it; the record confirms it before it goes.
              const whole = readRun(tenant, ws.name, r.id);
              if (!whole || (whole.status !== "completed" && whole.status !== "failed") ||
                  !whole.finishedAt || new Date(whole.finishedAt).getTime() >= cutoff) continue;
              const dir = path.join(workspaceDir(tenant, ws.name), "runs");
              fs.rmSync(path.join(dir, `${r.id}.json`), { force: true });
              fs.rmSync(path.join(dir, r.id), { recursive: true, force: true });
            }
          }
        }
      }
      markAccruedToday(tenant, day);
    } catch (err) {
      console.error(`[foldrun] accrual for ${tenant} failed`, err);
    }
  }
  // One line an hour that says the guard looked, and at what: the proof
  // on the box that it runs hourly and not once a day.
  if (money) console.log(`[foldrun] wallet guard: ${tenants.length} account(s) checked — ${Object.entries(guarded).map(([k, n]) => `${n} ${k}`).join(", ") || "none"}`);
  const { unsettledRuns, reservedUsd, reservedCount } = await billingMetrics();
  console.log(`[foldrun] billing: ${unsettledRuns} unsettled run(s), $${reservedUsd.toFixed(2)} held across ${reservedCount} reservation(s)`);
}

/** The day the account's daily lines were last written, or null. */
function accruedToday(tenant: string): string | null {
  try {
    return fs.readFileSync(path.join(accountDir(tenant), ".accrued"), "utf8").trim() || null;
  } catch {
    return null;
  }
}
function markAccruedToday(tenant: string, day: string): void {
  fs.mkdirSync(accountDir(tenant), { recursive: true });
  fs.writeFileSync(path.join(accountDir(tenant), ".accrued"), day);
}

/** How long a claim may go unrenewed before another worker may take the job.
 *  Checked at boot only (recoverQueue), never while a worker is live — which
 *  is what makes it safe for a step with no `timeout:` to run for hours. */
const CLAIM_STALE_MS = Number(process.env.FOLDRUN_CLAIM_STALE_MS) || 30 * 60_000;

// One worker per data directory, enforced at runtime rather than by a YAML
// comment. Same shape as the scheduler's lease: a file naming its holder,
// renewed each tick, stale after three missed renewals, takeover by
// read-then-write. The worst case is one bounded double-claim attempt during
// a handover — and claimNext's rename already makes a double-claim lose
// cleanly. What this prevents is the quiet catastrophe: a second worker
// replica double-DRIVING every run on shared storage.
// Observed 2026-08-28: Next bundles this module more than once, each bundle
// runs its own worker loop, and they share the lease file — one holds it and
// drains, the others defer. When the holder's interval dies (its bundle was
// torn down) the queue sits idle until the lease goes stale and a surviving
// loop takes over. At 90s that handover window read as a stalled platform —
// runs queued for minutes with healthz green. 30s is still thirty missed
// renewals (the tick is 1s), far beyond jitter, and it bounds the outage a
// dead holder can cause to half a minute.
const WORKER_LEASE_STALE_MS = 30_000;
// The hostname first, because it is also the worker lease's key: a claim
// signed `<host>:<pid>-<rand>` names the lease that proves its driver is
// alive, which is what lets a dead worker's claims be handed back at once
// instead of after CLAIM_STALE_MS (2026-09-15: a worker roll with three runs
// in flight parked them for half an hour).
const WORKER_OWNER = `${os.hostname()}:${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
/** The per-claim part of a claim's token (claimNext). */
let claimSeq = 0;

/**
 * Is a claim's driver gone? `holder` is who holds the worker lease under the
 * claimant's hostname right now (null: nobody). The claimant is alive only
 * if it is that very holder — the worker, so a claim's `/<n>` is set aside
 * before comparing. A claim with no hostname in it predates this shape and
 * is left to the stale window. Pure, so the rule is testable.
 */
export function claimOwnerDead(claimedBy: string | null, holder: string | null, self = WORKER_OWNER): boolean {
  if (!claimedBy) return false;
  const worker = claimedBy.split("/")[0];
  if (worker === self) return false;
  const host = worker.split(":")[0];
  if (!host || host === worker) return false;
  return holder !== worker;
}

/**
 * Hand back every claim whose worker is dead. Postgres queue with Redis
 * only: that is where more than one worker exists and where the lease can
 * be asked. Elsewhere the stale window in recoverQueue still applies.
 */
export async function recoverDeadClaims(): Promise<string[]> {
  if (!databaseEnabled() || !cacheEnabled()) return [];
  const back: string[] = [];
  for (const row of await claimedRowsDb()) {
    if (!row.claimedBy) continue;
    const host = row.claimedBy.split(":")[0];
    if (!host || host === row.claimedBy) continue;
    const holder = await leaseOwner(`worker:${host}`);
    if (holder === undefined) continue; // Redis unreadable: decide nothing
    if (!claimOwnerDead(row.claimedBy, holder)) continue;
    if (await handBackDb(row.runId, row.claimedBy)) {
      back.push(row.runId);
      console.error(`[foldrun] claim on ${row.runId} handed back: its worker ${row.claimedBy} no longer holds a lease`);
    }
  }
  return back;
}

// What the lease is scoped to. On the file queue there can only ever be one
// driver per data directory, so the lease is global. On the Postgres queue
// a claim is `FOR UPDATE SKIP LOCKED` and heartbeated, so N pods may each
// drive their own runs — and the global lease was the one thing left
// serialising them: with three worker replicas, two idled. What a lease
// still has to prevent there is the in-process case (Next bundles this
// module more than once, each bundle runs its own loop), and that is per
// pod: the hostname. A worker HPA becomes real capacity instead of standby.
function workerLeaseKey(): string {
  return databaseEnabled() ? `worker:${os.hostname()}` : "worker";
}

function workerLeaseFile() {
  return path.join(dataRoot(), ".worker-lease");
}

/**
 * True when this process holds (or just took) the worker lease.
 *
 * Redis when there is one, the file otherwise. The difference is not
 * cosmetic: the file version reads, decides, then writes, so two workers can
 * both read "stale" and both write — its own comment admits the worst case is
 * one bounded double-claim during a handover. `SET NX PX` has no such window,
 * which is what makes more than one worker replica safe at all.
 */
export async function holdsWorkerLease(now = Date.now()): Promise<boolean> {
  if (cacheEnabled()) {
    const state = await takeLease(workerLeaseKey(), WORKER_OWNER, WORKER_LEASE_STALE_MS);
    return state.held;
  }

  const file = workerLeaseFile();
  try {
    const current = JSON.parse(fs.readFileSync(file, "utf8")) as { owner: string; renewedAt: number };
    if (current.owner !== WORKER_OWNER && now - current.renewedAt < WORKER_LEASE_STALE_MS) return false;
  } catch {
    // no lease yet, or unreadable — claimable
  }
  // A takeover — the previous holder stopped renewing. Say so: a queue that
  // sat idle through a handover window is otherwise indistinguishable from
  // one that never had work, and this line is how the next stall gets a
  // timestamped trail instead of a shrug.
  try {
    const prev = JSON.parse(fs.readFileSync(file, "utf8")) as { owner: string; renewedAt: number };
    if (prev.owner !== WORKER_OWNER) {
      console.error(
        `[foldrun] worker lease taken over from ${prev.owner} (idle ${Math.round((now - prev.renewedAt) / 1000)}s)`,
      );
    }
  } catch {
    /* no previous lease — first boot */
  }
  const tmp = `${file}.${WORKER_OWNER}`;
  fs.writeFileSync(tmp, JSON.stringify({ owner: WORKER_OWNER, renewedAt: now }));
  fs.renameSync(tmp, file);
  return true;
}

/**
 * Runs that have, or are about to have, a driver — for a reconcile that
 * must not close them. Any row in the queue: a claimed one is being driven
 * by some worker, a pending one (a hand-back from a rolled worker, a
 * parked run whose wait ended) will be claimed within a second. On the
 * file queue there is one worker, whose own drivingRuns set says what it
 * holds; its pending files are read the same way.
 */
export async function liveClaimedRuns(): Promise<Set<string>> {
  if (!databaseEnabled()) return new Set();
  try {
    return await queuedRunIdsDb();
  } catch {
    return new Set();
  }
}

/** Hand the lease back on a clean shutdown, so the next worker starts driving
 *  immediately instead of waiting out the TTL. */
export async function releaseWorkerLease(): Promise<void> {
  if (cacheEnabled()) await releaseLease(workerLeaseKey(), WORKER_OWNER);
}

/**
 * Whether a LIVE worker holds the lease on this data directory — a pure
 * read that never writes (a probe taking a stale lease would hold it while
 * running no worker, quietly stopping every run). Deliberately not "is it
 * me": Next bundles this module separately for routes and for the worker's
 * process hook, so identity comparison across bundles always said false.
 * The operational question is that a worker exists, not which copy asked.
 */
export async function peekWorkerLease(now = Date.now()): Promise<boolean> {
  if (cacheEnabled()) return databaseEnabled() ? anyLeaseHeld("worker:") : leaseHeld("worker");
  try {
    const current = JSON.parse(fs.readFileSync(workerLeaseFile(), "utf8")) as { renewedAt: number };
    return now - current.renewedAt < WORKER_LEASE_STALE_MS;
  } catch {
    return false;
  }
}

let started = false;

/**
 * The worker loop: claim → drive → delete the job. One per process, started
 * beside the scheduler. Parked and finished runs both end with the job file
 * deleted — for a parked run the *approval* mints the next job, so a job in
 * claimed/ always means "a driver is (or died) on it", never "waiting".
 */
/**
 * Refuse to serve more than one tenant without step isolation.
 *
 * Without FOLDRUN_RUN_ISOLATION, a step runs in the platform's own process:
 * correct on a laptop, where there is nothing to isolate from, and
 * catastrophic for a multi-tenant install, where one tenant's agent would run
 * with the platform's filesystem, its vault and every other tenant's data in
 * reach. Nothing used to refuse that configuration — a missing or misspelled
 * env var degraded silently from "sandboxed" to "shared", and the only symptom
 * was a run trace nobody was reading.
 *
 * So it is a boot condition now, not a footnote. A single-tenant install (the
 * CLI, a developer's box) is unaffected; the moment a second account exists,
 * or FOLDRUN_MULTI_TENANT=1 says one is coming, isolation must be configured.
 */
export function assertIsolationSafe(): void {
  const isolation = process.env.FOLDRUN_RUN_ISOLATION;
  if (isolation === "container" || isolation === "k8s") return;

  const declared = process.env.FOLDRUN_MULTI_TENANT === "1";
  let tenants: string[] = [];
  try {
    tenants = listTenants();
  } catch {
    // An unreadable data root is a different problem; do not mask it as this one.
    return;
  }
  if (!declared && tenants.length <= 1) return;

  const why = declared
    ? "FOLDRUN_MULTI_TENANT=1 is set"
    : `${tenants.length} accounts exist (${tenants.slice(0, 4).join(", ")}${tenants.length > 4 ? ", …" : ""})`;
  throw new Error(
    `refusing to start: ${why}, but FOLDRUN_RUN_ISOLATION is ` +
      `${isolation ? `"${isolation}", which is not a recognised mode` : "unset"}. ` +
      `Steps would run in this process, sharing the platform's filesystem, vault and ` +
      `every account's data. Set FOLDRUN_RUN_ISOLATION=k8s (a cluster) or =container ` +
      `(one box). Single-account installs may run without it.`,
  );
}

/** When this process last finished a queue tick. A worker whose event
 *  loop is blocked — a stalled NFS read inside a sync fs call, on
 *  2026-09-25 — keeps its lease and its health endpoint's "ok" while
 *  driving nothing; the health endpoint reads this and says so. */
let lastTickAt = 0;

/** Milliseconds since the last completed tick; 0 before the worker starts. */
export function workerTickAge(now = Date.now()): number {
  return started && lastTickAt ? now - lastTickAt : 0;
}

export function startWorker() {
  if (started || process.env.FOLDRUN_DISABLE_WORKER === "1") return;
  started = true;
  lastTickAt = Date.now();

  // The egress proxy lives with the worker: the process that drives a step
  // is the one holding that step's lease. Listens only when pods have been
  // told where to find it; otherwise steps materialise secrets as before.
  // FOLDRUN_EGRESS_IN_WORKER=0: the proxy runs as its own pods (egress.ts,
  // FOLDRUN_ROLE=egress) and the Service routes there, so a worker restart
  // no longer cuts every step's model call (6 Oct 2026). Leases are in
  // Redis either way, so the worker still writes and renews them.
  if (egressUrl() && process.env.FOLDRUN_EGRESS_IN_WORKER !== "0") {
    startEgressProxy()
      .then(({ port }) => console.log(`[foldrun] egress proxy on :${port}, reached by pods at ${egressUrl()}`))
      .catch((err) => console.error("[foldrun] egress proxy failed to start:", err));
  }

  let inFlight = 0;
  // The jobs this process is driving, so a shutdown can hand them back.
  const driving = new Map<string, QueueJob>();

  const tickOnce = async () => {
    // Not the holder → not a worker this tick. A web replica pointed at the
    // same data, or a second worker from a misapplied manifest, idles here
    // instead of double-driving runs.
    if (!(await holdsWorkerLease())) return;
    while (inFlight < concurrency()) {
      // Reserve the slot BEFORE awaiting the claim. The await yields, and a
      // second tick arriving in that window would read the same inFlight and
      // claim past the concurrency cap — the file queue never showed this
      // because its claim was synchronous.
      inFlight += 1;
      const claim = await claimNext();
      if (!claim) {
        inFlight -= 1;
        return;
      }

      driving.set(claim.job.runId, claim.job);
      void (async () => {
        // Renew the claim for as long as this run is driven. recoverStaleDb
        // hands back any claim older than the stale window, and nothing used
        // to renew one — so a run longer than that window was handed to the
        // next worker to boot while this one was still driving it, and both
        // drove. No-op on the file queue, where a claim is a renamed file.
        // The same beat renews the run's egress leases: a step's
        // credentials stay reachable for exactly as long as it is driven,
        // however long that is — the platform sets no clock on user work.
        const heartbeat = setInterval(() => {
          void claim.touch().catch(() => {});
          void renewEgressLeases(claim.job.runId).catch(() => {});
        }, Math.max(10_000, Math.floor(CLAIM_STALE_MS / 3)));
        heartbeat.unref?.();
        try {
          const { tenant, workspace, runId, modelOverride, tags } = claim.job;
          const run = readRun(tenant, workspace, runId);
          if (run && drivingRuns.has(runId)) {
            // Already being driven in this process: reconcile resumes an
            // idle parked run directly, outside the queue, and this job was
            // minted for the same resume while every slot was busy. Two
            // loops on one record run every remaining step twice. The live
            // driver re-enqueues the run if it parks again, so the job is
            // simply dropped.
            console.log(`[foldrun] worker: run ${runId} is already being driven here — dropping the duplicate job`);
            return;
          }
          // Drive anything not finished and not still waiting on a person.
          // `queued` and (via boot recovery) `running` trivially qualify; a
          // parked run qualifies once no step is still asking — and if one
          // still is, dropping the job is right, because the decision that
          // resolves it will enqueue a fresh one.
          const stillAsking = run?.steps.some((s) => s.status === "awaiting-approval");
          // The kill switch: a run lined up before its account or workspace
          // was paused, and not begun, waits out the pause instead of
          // starting (Codex review — a backlog drained past the switch).
          // A minute, not at once: a paused queue would otherwise spin.
          // A run already under way goes on; `stop` is for that.
          // "Not begun" is queued and never parked: a run parked on a `wait:`
          // carries parkedAt, and a rerun's copied step times say nothing
          // about whether the new run itself ever ran.
          if (run && run.status === "queued" && !run.parkedAt && pauseOf(await adminState(tenant), workspace)) {
            await handBack({ ...claim.job, notBefore: new Date(Date.now() + 60_000).toISOString() });
            return;
          }
          // overlap: queue — one run of this flow at a time; later ones keep
          // their place and start when the live one finishes. Same shape as
          // the plan cap below: back to the tail, when not whether.
          const flowInfo = run
            ? listWorkspaceFlows(tenant, workspace).find((f) => f.name === run.flow)
            : null;
          if (
            run && run.status === "queued" && flowInfo?.overlap === "queue" &&
            listRunSummaries(tenant, workspace).some(
              (r) => r.flow === run.flow && r.id !== run.id && r.status === "running",
            )
          ) {
            // The finally below removes the claim file and gives the slot
            // back — doing either here double-counted: every deferral
            // leaked inFlight downward, quietly raising real concurrency.
            await handBack(claim.job);
            return;
          }

          // The account's parallelism, enforced where a run would actually
          // start. At the cap, the job returns to the queue's tail rather
          // than running — admission was already paid for at enqueue; this
          // only decides when, never whether. `concurrency:` on the account
          // beats the install's plan number, and applies whether or not
          // billing is on: an operator who wrote it meant it.
          // An account's own number always applies; the plan's only where
          // billing is on, as before — a self-hoster's install is not a plan.
          const limit = await accountConcurrency(tenant);
          const capApplies = limit !== null && (limit.source === "account" || billing().enabled());
          if (
            run && run.status !== "completed" && run.status !== "failed" && !stillAsking &&
            capApplies && (await countRunning(tenant, runId)) >= limit!.cap
          ) {
            // The finally below removes the claim file and gives the slot
            // back — doing either here double-counted: every deferral
            // leaked inFlight downward, quietly raising real concurrency.
            await handBack(claim.job);
            return;
          }
          if (run && run.status !== "completed" && run.status !== "failed" && !stillAsking) {
            await driveRun(tenant, workspace, run, modelOverride, tags ?? run.tags ?? [], {
              parkOnApproval: true,
            });
            // Settle the bill once the run is genuinely over. Idempotent by
            // run id, so a parked run settling on its *final* drive is safe
            // even if an earlier drive raced it.
            const settled = readRun(tenant, workspace, runId);
            // A run that parked on a wait: goes back to the queue carrying
            // the earliest deadline — without notBefore this would busy-loop
            // claim → park → claim until the wait expired.
            // A run parked for room (27 Oct 2026) goes back the same way and
            // looks again after FOLDRUN_ROOM_RECHECK_SEC; its row keeps its
            // seq, so its place in line is the one it had.
            const notBefore = settled ? parkedNotBefore(settled) : null;
            if (notBefore) {
              // Cleanup is the finally's; see the gates above.
              await handBack({ ...claim.job, notBefore });
              return;
            }
            if (settled && (settled.status === "completed" || settled.status === "failed")) {
              // Awaited, retried, and marked unsettled if it still fails:
              // a database blink here used to be an unhandled rejection
              // and a run that was never billed (settle.ts).
              await settleRun(tenant, workspace, runId);
              // alerts: new_host — the sites its agents reached, against before.
              await noteNewHosts(tenant, workspace, settled);
              // telemetry: — the run as an OpenTelemetry trace, to the account's
              // collector. Not awaited: a slow collector must not hold the
              // chained flows below (it never throws, and times out at 10s).
              void exportRunTrace(tenant, workspace, settled);
            }
            // Tell whoever asked to be told. Terminal states and parks alike
            // — "waiting for your approval" is the one message that cannot
            // wait for someone to happen to open the dashboard.
            if (settled) await sendRunNotification(tenant, workspace, settled);
            // trigger: flow — whatever chains on this run starts now, from
            // the same settle that told a person about it.
            if (settled) await fireChainedFlows(tenant, workspace, settled);
          }
        } catch (err) {
          console.error(`[foldrun] worker: run ${claim.job.runId} threw`, err);
        } finally {
          driving.delete(claim.job.runId);
          clearInterval(heartbeat);
          // A detached run was handed back already; releasing it here would
          // delete the job the next driver is about to claim (release is by
          // owner, and the hand-back cleared ours — but say it outright).
          if (!detached) {
            // Whichever store this came from knows how to let it go.
            await claim.release().catch((err) =>
              console.error(`[foldrun] worker: releasing ${claim.job.runId}:`, err),
            );
          }
          inFlight -= 1;
        }
      })();
    }
  };

  const tick = async () => {
    await tickOnce();
    lastTickAt = Date.now();
  };
  const ticker = setInterval(() => void tick().catch((err) => console.error("[foldrun] worker tick:", err)), POLL_MS);
  // A surviving worker takes over a dead peer's runs within a lease window,
  // not a stale window: every 30s, hand back claims whose owner's lease is gone.
  const undertaker = setInterval(
    () => void recoverDeadClaims().catch((err) => console.error("[foldrun] dead-claim pass:", err)),
    WORKER_LEASE_STALE_MS,
  );
  undertaker.unref?.();
  ticker.unref();
  void tick().catch((err) => console.error("[foldrun] worker tick:", err));

  // Shutdown: stop claiming, then HAND BACK what is in flight rather than
  // waiting for it. A run's step is a pod that outlives this process and
  // carries its own log; the record says which pod and how far we got. So
  // the job goes back to the queue unclaimed, this process stops reading,
  // and the next worker — seconds away in a rollout — claims it and
  // re-attaches (run-k8s.ts resume). Before this, a deploy waited 25 s and
  // then abandoned the rest to a thirty-minute stale-claim sweep that
  // re-ran their steps from the start; the deploy guard existed for that.
  // A short grace first, for a step that is a second from its done line.
  let stopping = false;
  let detached = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    clearInterval(ticker);
    console.log(`[foldrun] worker: ${signal} — no new claims; ${inFlight} in flight`);
    const started = Date.now();
    const graceMs = Number(process.env.FOLDRUN_SHUTDOWN_GRACE_MS) || 3_000;
    const poll = setInterval(async () => {
      if (inFlight > 0 && Date.now() - started < graceMs) return;
      clearInterval(poll);
      if (inFlight > 0) {
        detached = true;
        detachFromRunPods();
        for (const job of driving.values()) {
          try {
            await handBack(job);
            console.log(`[foldrun] worker: handed back ${job.runId} — the next worker re-attaches to its sandbox`);
          } catch (err) {
            console.error(`[foldrun] worker: could not hand back ${job.runId}:`, err);
          }
        }
      }
      await releaseWorkerLease().catch(() => {});
      console.log("[foldrun] worker: lease released, exiting");
      process.exit(0);
    }, 250);
    poll.unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  // The hourly housekeeping (hourlyHousekeeping below), under the lease:
  // one worker's hour, however many run.
  const accrue = () => withHousekeeping("hourly-accrual", hourlyHousekeeping, { tries: 3 });
  setInterval(() => void accrue().catch((err) => console.error("[foldrun] hourly accrual:", err)), 60 * 60 * 1000).unref();
  accrue().catch((err) => console.error("[foldrun] startup accrual:", err));

  // Every workspace and library a point to restore to (core history.ts
  // ensureBaseline): history moved off git on 17 Oct 2026 and started fresh,
  // and a scope no save has touched since has no snapshot until one exists.
  // Once per boot, under the lease; a no-op for a scope that has one.
  void withHousekeeping("history-baseline", async () => {
    let made = 0;
    for (const tenant of listTenants()) {
      for (const scope of [...listWorkspaces(tenant).map((w) => w.name), "@library"]) {
        try {
          const before = headRevision(tenant, scope);
          if (!before && ensureBaseline(tenant, scope)) made += 1;
        } catch (err) {
          console.error(`[foldrun] history baseline ${tenant}/${scope}:`, err);
        }
      }
    }
    if (made) console.log(`[foldrun] history: ${made} baseline snapshot(s) recorded — history starts there`);
  }, { tries: 3 }).catch((err) => console.error("[foldrun] history baseline:", err));
}

/** The queue, described: what /healthz and the metrics endpoint report.
 *  Cheap enough to call per-scrape — two readdirs and a stat each. */
export async function queueStats(): Promise<{
  pending: number;
  /** Jobs waiting on a wait: deadline rather than a free slot. */
  scheduledAhead: number;
  claimed: number;
  oldestPendingSecs: number | null;
}> {
  if (databaseEnabled()) return statsDb();
  const now = Date.now();
  let pending = 0;
  let scheduledAhead = 0;
  let oldest: number | null = null;
  const dir = queueDir("pending");
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const file = path.join(dir, name);
        const job = JSON.parse(fs.readFileSync(file, "utf8")) as QueueJob;
        if (job.notBefore && new Date(job.notBefore).getTime() > now) {
          scheduledAhead += 1;
          continue; // waiting on its own deadline, not on us
        }
        pending += 1;
        const age = now - fs.statSync(file).mtimeMs;
        if (oldest === null || age > oldest) oldest = age;
      } catch {
        // mid-write or mid-claim — count nothing, next scrape settles it
      }
    }
  }
  const claimedDir = queueDir("claimed");
  const claimed = fs.existsSync(claimedDir)
    ? fs.readdirSync(claimedDir).filter((f) => f.endsWith(".json")).length
    : 0;
  return {
    pending,
    scheduledAhead,
    claimed,
    oldestPendingSecs: oldest === null ? null : Math.round(oldest / 1000),
  };
}


/**
 * Move any jobs still sitting in the file queue into the database, once.
 *
 * Called at boot before the worker starts. Without it, switching an install to
 * Postgres makes every in-flight job invisible in the same instant — the runs
 * stay `queued` on disk forever with nobody driving them, which looks like the
 * platform quietly stopping rather than like a migration.
 *
 * Claimed files come across as unclaimed: whatever was driving them died with
 * the old process, which is exactly what boot recovery already assumed.
 * Idempotent, because enqueueDb upserts on run_id.
 */
export async function importQueueToDatabase(): Promise<number> {
  if (!databaseEnabled()) return 0;
  let moved = 0;
  for (const state of ["claimed", "pending"] as const) {
    const dir = queueDir(state);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(dir, name);
      try {
        const job = JSON.parse(fs.readFileSync(file, "utf8")) as QueueJob;
        await enqueueDb(job);
        fs.rmSync(file, { force: true });
        moved += 1;
      } catch {
        // An unreadable job is dropped exactly as recoverQueue would drop it:
        // the run record survives, and reconcile is what closes it out.
        fs.rmSync(file, { force: true });
      }
    }
  }
  return moved;
}
