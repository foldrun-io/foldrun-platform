// The grade pass: every workspace's graders (evals with `trigger: runs`,
// core grades.ts) holding a sample of its finished runs to their checks.
//
// Off the scheduler's tick, like the security rescan: a judge is a model
// call that can take a minute, and the next minute's flows must not wait on
// it. One pass at a time, at most PASS_LIMIT judges' worth of runs a pass
// and accountLimit() for any one account, so a busy account cannot spend the
// pass and no pass can spend much — a backlog drains a few runs every five
// minutes rather than all at once. The pass asks before every run whether
// this pod still holds the scheduler, and stops between runs when it does
// not, never in the middle of one.
//
// A paused account or workspace is not graded: the kill switch stops what
// spends, and a judge spends.
//
// What comes after a grade — a proposed fix once a grader's failures add
// up (improve.ts) — hangs off `afterGrades`, so this file only grades.

import { listTenants, listWorkspaces } from "../../foldrun-core/src/store.ts";
import { gradeWorkspace, listGraders, type Grade } from "../../foldrun-core/src/grades.ts";
import type { EvalInfo, judgeCall } from "../../foldrun-core/src/evals.ts";
import { adminState, pauseOf } from "./admin.ts";
import { settingText } from "./settings.ts";

export const PASS_LIMIT = Number(process.env.FOLDRUN_GRADE_PASS_LIMIT ?? 12) || 12;
/** Read each pass (an operator setting, settings.ts). */
export const accountLimit = (): number => Number(settingText("FOLDRUN_GRADE_ACCOUNT_LIMIT") ?? 4) || 4;

export interface GradePassResult {
  graded: number;
  failed: number;
  workspaces: number;
  errors: string[];
  stopped: boolean;
}

type AfterGrades = (tenant: string, workspace: string, graders: EvalInfo[], now: number) => Promise<void>;
let afterGrades: AfterGrades | null = null;
/** Once per account per pass, whatever its graders or its pause: what
 *  costs nothing and must not wait (improve.ts settleAccount). */
let eachAccount: ((tenant: string, now: number) => Promise<unknown>) | null = null;
export function setEachAccount(fn: typeof eachAccount) {
  eachAccount = fn;
}
/** improve.ts registers what follows grading — a proposal when failures
 *  add up. Here, not imported, so the pass runs without it in tests. */
export function setAfterGrades(fn: AfterGrades | null) {
  afterGrades = fn;
}

/** Passes so far in this process: where the next one starts, so a busy
 *  account cannot hold the front of every pass. And per account, its own
 *  visits — so an account skipped by a full pass does not skip a workspace. */
let passes = 0;
const visits = new Map<string, number>();
const rotate = <T,>(list: T[], by: number): T[] => (list.length ? [...list.slice(by % list.length), ...list.slice(0, by % list.length)] : list);

export async function gradePass(
  now: number,
  stillScheduler: () => Promise<boolean> | boolean,
  opts: { judge?: typeof judgeCall } = {},
): Promise<GradePassResult> {
  const out: GradePassResult = { graded: 0, failed: 0, workspaces: 0, errors: [], stopped: false };
  let left = PASS_LIMIT;
  const turn = passes++;
  // Every account first, whatever the grading budget leaves: settling costs
  // nothing and must not wait behind busy accounts' judges.
  if (eachAccount) {
    for (const tenant of listTenants()) {
      await eachAccount(tenant, now).catch((err) => out.errors.push(`${tenant}: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
  for (const tenant of rotate(listTenants(), turn)) {
    if (left <= 0) break;
    let state: Awaited<ReturnType<typeof adminState>>;
    try {
      state = await adminState(tenant);
    } catch {
      continue;
    }
    let accountLeft = Math.min(accountLimit(), left);
    const visit = visits.get(tenant) ?? 0;
    visits.set(tenant, visit + 1);
    for (const ws of rotate(listWorkspaces(tenant), visit)) {
      if (accountLeft <= 0 || left <= 0) break;
      if (pauseOf(state, ws.name)) continue;
      let graders: EvalInfo[];
      try {
        graders = listGraders(tenant, ws.name);
      } catch {
        continue;
      }
      if (graders.length === 0) continue;
      out.workspaces++;
      const r = await gradeWorkspace(tenant, ws.name, {
        now,
        limit: accountLeft,
        keepGoing: async () => {
          const ok = await stillScheduler();
          if (!ok) out.stopped = true;
          // A pause set while a judge was answering stops the next one.
          return ok && !(await pausedNow(tenant, ws.name));
        },
        ...(opts.judge ? { judge: opts.judge } : {}),
      }).catch((err) => {
        out.errors.push(`${tenant}/${ws.name}: ${err instanceof Error ? err.message : String(err)}`);
        return { graded: 0, failed: 0, errors: [] as string[] };
      });
      out.graded += r.graded;
      out.failed += r.failed;
      out.errors.push(...r.errors.map((e) => `${tenant}/${ws.name}: ${e}`));
      accountLeft -= r.graded + r.errors.length;
      left -= r.graded + r.errors.length;
      if (out.stopped) return out;
      // What follows grading can open a proposal, which spends: asked again
      // whether this pod still holds the scheduler, whatever grading did.
      if (afterGrades && !(await stillScheduler())) {
        out.stopped = true;
        return out;
      }
      if (afterGrades && !(await pausedNow(tenant, ws.name))) {
        await afterGrades(tenant, ws.name, graders, now).catch((err) =>
          out.errors.push(`${tenant}/${ws.name}: after grading — ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    }
  }
  return out;
}

/** For the log line: a pass that graded nothing says nothing. */
export function describePass(r: GradePassResult): string | null {
  if (!r.graded && !r.errors.length) return null;
  return `graded ${r.graded} run(s) in ${r.workspaces} workspace(s), ${r.failed} failed${r.errors.length ? `; ${r.errors.length} could not be graded: ${r.errors.slice(0, 3).join(" · ")}` : ""}${r.stopped ? " (stopped: no longer the scheduler)" : ""}`;
}

/** The kill switch as it stands now, read fresh — a judge can take minutes. */
async function pausedNow(tenant: string, workspace: string): Promise<boolean> {
  try {
    return !!pauseOf(await adminState(tenant), workspace);
  } catch {
    return true; // unreadable: do not start paid work on a guess
  }
}

export type { Grade };
