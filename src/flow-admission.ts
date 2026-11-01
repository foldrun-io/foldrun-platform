// Starting a flow on request — one function for every door a caller can
// knock on: POST /api/workspaces/<ws>/flows/<f>/run (a person, a key, the CLI)
// and A2A's SendMessage (an outside agent, foldrun-web server/a2a-service.ts).
//
// Before 1 Nov 2026 the run route held `overlap: skip` itself, as a read of
// the runs list followed by an enqueue: two requests at once both read "no
// live run" and both started one. Here the read and the enqueue happen under
// one lock per flow — a Postgres advisory lock across every web pod when the
// install has a database, a per-flow queue in this process always — so of
// two starts of an `overlap: skip` flow at once exactly one is admitted.
//
// Everything else a start must pass — a suspended account, a paused
// workspace or account, the money gate and `budget:` (reservations.ts), the
// plan's limits — is enqueueFlowRun's, as before; this adds nothing to it and
// skips none of it.

import type { FlowInfo, FlowStep, RunRecord } from "../../foldrun-core/src/store.ts";
import { listRunSummaries } from "../../foldrun-core/src/store.ts";
import { runOfA2aTask } from "./a2a-tasks.ts";
import { databaseEnabled, withNamedLock } from "./db.ts";
import { enqueueFlowRun, startFlowFromStep } from "./queue.ts";

/** A start refused before any run existed: the status the API answers, and
 *  for an overlap the live run's id. Nothing was created or held. */
export class AdmissionRefused extends Error {
  status: number;
  code: "overlap" | "no-steps" | "bad-from";
  runId?: string;
  constructor(message: string, status: number, code: AdmissionRefused["code"], runId?: string) {
    super(message);
    this.status = status;
    this.code = code;
    if (runId) this.runId = runId;
  }
}

export interface FlowStart {
  tenant: string;
  workspace: string;
  /** The flow as loaded (loadFlow — subflows expanded). */
  flow: FlowInfo;
  /** The steps to run: the flow's, with any task stapled to the first.
   *  Unsaid, the flow's own. Ignored with `from`. */
  steps?: FlowStep[];
  /** Start at this step group (the flow file's numbering); 1 is the start. */
  from?: number;
  tags?: string[];
  /** Who asked, when a person did. */
  startedBy?: string | null;
  test?: boolean;
  /** An A2A task's correlation, written onto the run record. */
  a2a?: { task: string; key: string };
}

const LIVE = new Set<RunRecord["status"]>(["running", "queued", "awaiting-approval"]);

export { runOfA2aTask };

/** A run of this flow that is live now, or null — what `overlap: skip` holds to. */
export function liveRunOf(tenant: string, workspace: string, flowName: string): string | null {
  return listRunSummaries(tenant, workspace).find((r) => r.flow === flowName && LIVE.has(r.status))?.id ?? null;
}

// This process's queue per flow: the advisory lock serialises pods, but two
// requests in one pod would otherwise each open a connection to wait on it.
const local = new Map<string, Promise<unknown>>();

/** Run `fn` alone for `key`: a Postgres advisory lock across every pod when
 *  the install has a database, a queue in this process always. What A2A
 *  holds its claim and its open-task count under (server/a2a-service.ts). */
export function withAdmissionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return serialised(key, fn);
}

async function serialised<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = local.get(key) ?? Promise.resolve();
  const turn = prev.catch(() => undefined).then(() => (databaseEnabled() ? withNamedLock(key, fn, 15_000) : fn()));
  local.set(key, turn);
  try {
    return await turn;
  } finally {
    if (local.get(key) === turn) local.delete(key);
  }
}

/**
 * Admit one start of a flow and line its run up, or refuse it — never both.
 * Throws AdmissionRefused for an overlap (409), a flow with no steps (400) or
 * a step number it does not have (400); a paused workspace (423), a spent
 * budget or wallet (402) and the like come from enqueueFlowRun with their
 * own status, as they always have.
 */
export async function admitFlowRun(start: FlowStart): Promise<RunRecord> {
  const { tenant, workspace, flow } = start;
  if (flow.steps.length === 0) throw new AdmissionRefused(`flow ${flow.name} has no steps`, 400, "no-steps");
  const from = start.from ?? 1;
  const lastStep = Math.max(...flow.steps.map((s) => s.group));
  if (!Number.isInteger(from) || from < 1 || from > lastStep) {
    throw new AdmissionRefused(`from must be a step number between 1 and ${lastStep}`, 400, "bad-from");
  }
  const go = async (): Promise<RunRecord> => {
    // Idempotent on the A2A task: a task already served by a run gets that
    // run, never a second — read under the same lock as the create, so a
    // retry that takes over a claim cannot race the start it took over.
    if (start.a2a) {
      const existing = runOfA2aTask(tenant, workspace, start.a2a.task);
      if (existing) return existing;
    }
    if (flow.overlap === "skip") {
      // A second start while one is live is almost always a double click
      // or a retried command, and two copies bill twice and write the same
      // state files at once.
      const live = liveRunOf(tenant, workspace, flow.name);
      if (live) {
        throw new AdmissionRefused(`${flow.name} is already running (${live}) — overlap: skip allows one run at a time`, 409, "overlap", live);
      }
    }
    if (from > 1) {
      return startFlowFromStep(tenant, workspace, flow.name, from, start.startedBy ?? null, { test: start.test });
    }
    return enqueueFlowRun(tenant, workspace, start.steps ?? flow.steps, flow.name, flow.model, start.tags ?? [], start.startedBy ?? null, {
      test: start.test,
      ...(start.a2a ? { a2a: start.a2a } : {}),
    });
  };
  // An overlap: skip flow and an A2A start need the read and the write
  // together; every other start goes straight through, as it did.
  if (flow.overlap !== "skip" && !start.a2a) return go();
  // JSON for the lock's name: a NUL cannot be held by Postgres text.
  return serialised(JSON.stringify(["flow-admission", tenant, workspace, flow.name]), go);
}
