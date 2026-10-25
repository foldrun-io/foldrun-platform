// One lease for the chores.
//
// The scheduler's lease says who fires flows. It used to say, by accident,
// who did everything else on the same tick — reaping idle account pods,
// sweeping gates and SLAs, and, in the worker, the hourly accrual — and
// those jobs ran on every process that ever held the scheduler lease, with
// the handover window as the moment two of them overlapped: a pod-session
// charge read-then-appended by both, a warning emailed twice.
//
// This is the lease those chores hold instead. Separate from the scheduler's
// so a chore that takes a minute never delays a flow, and taken per JOB for
// the job's duration — `SET NX` on Redis, so two pods cannot both hold it;
// released when the job is done, expired by its TTL if the process dies
// mid-job. A job that finds the lease held skips this round: every chore
// here is idempotent and on a cadence, so "next time" is the right answer.
//
// Without Redis it is a file, read-then-write like the scheduler's, whose
// worst case is one bounded overlap during a handover on one box — and on
// one box the ledger's marker files close the money side of that.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { cacheEnabled, releaseLease, takeLease } from "./cache.ts";

const OWNER = `${os.hostname()}:${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const KEY = "housekeeping";

/** How long a job may hold the lease before a dead holder is assumed. A
 *  chore that runs longer renews by taking the lease again. */
const TTL_MS = Number(process.env.FOLDRUN_HOUSEKEEPING_TTL_MS) || 10 * 60_000;

const leaseFile = () => path.join(dataRoot(), ".housekeeping-lease");

function fileTake(now: number): boolean {
  const file = leaseFile();
  try {
    const current = JSON.parse(fs.readFileSync(file, "utf8")) as { owner: string; renewedAt: number };
    if (current.owner !== OWNER && now - current.renewedAt < TTL_MS) return false;
  } catch {
    // no lease yet, or unreadable — claimable
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${OWNER}`;
  fs.writeFileSync(tmp, JSON.stringify({ owner: OWNER, renewedAt: now }));
  fs.renameSync(tmp, file);
  return true;
}

function fileRelease(): void {
  try {
    const current = JSON.parse(fs.readFileSync(leaseFile(), "utf8")) as { owner: string };
    if (current.owner === OWNER) fs.rmSync(leaseFile(), { force: true });
  } catch {
    // nothing to release
  }
}

/** Take the lease for a job, or say it is held. Renews if we hold it. */
export async function takeHousekeeping(now = Date.now()): Promise<boolean> {
  if (cacheEnabled()) return (await takeLease(KEY, OWNER, TTL_MS)).held;
  return fileTake(now);
}

export async function releaseHousekeeping(): Promise<void> {
  if (cacheEnabled()) return releaseLease(KEY, OWNER);
  fileRelease();
}

/**
 * Run a chore under the lease. Returns the chore's result, or `undefined`
 * when the lease was held elsewhere and the chore was skipped — the caller
 * logs nothing for a skip, because a skip is the system working. `tries`
 * is a brief patience for the hourly jobs, whose next chance is an hour
 * away: three tries two seconds apart outlasts a reaper pass.
 */
export async function withHousekeeping<T>(name: string, job: () => Promise<T>, opts: { tries?: number; waitMs?: number; now?: () => number } = {}): Promise<T | undefined> {
  const tries = Math.max(1, opts.tries ?? 1);
  const now = opts.now ?? Date.now;
  for (let i = 0; i < tries; i++) {
    if (await takeHousekeeping(now())) {
      try {
        return await job();
      } finally {
        await releaseHousekeeping().catch(() => {});
      }
    }
    if (i + 1 < tries) await new Promise((r) => setTimeout(r, opts.waitMs ?? 2000));
  }
  console.log(`[housekeeping] ${name} skipped: the lease is held elsewhere`);
  return undefined;
}

/** For tests: this process's owner id, to read the lease file against. */
export const housekeepingOwner = () => OWNER;
