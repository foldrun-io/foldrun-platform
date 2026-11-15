// How long the mirror loop waits before its next pass (15 Nov 2026).
//
// The loop (boot.ts) copies every workspace's heads to this pod's disk every
// few seconds. When the store cannot be read at all — staging's assistant had
// no S3 identity for a day — every pass failed for every workspace and logged
// each one: ~595,000 lines a day, ~$11 a month of CloudWatch, and an S3/Postgres
// request per workspace every 3 s for nothing. The standard answer is capped
// exponential backoff with jitter (AWS Builders' Library, "Timeouts, retries
// and backoff with jitter"): after a pass in which every workspace failed,
// wait twice as long, up to a cap; one pass that is not all failures puts the
// loop straight back on its normal pace. A pass with only SOME failures keeps
// the normal pace, so the healthy workspaces stay current.

export interface MirrorPass {
  failed: number;
  total: number;
}

/** The next wait before jitter: `base` after a pass that worked (or an empty
 *  one), double the last wait after a pass where everything failed, never
 *  more than `max`. `pass` null means the pass threw before it could count. */
export function nextMirrorDelay(prev: number, base: number, max: number, pass: MirrorPass | null): number {
  const allFailed = pass === null || (pass.total > 0 && pass.failed >= pass.total);
  if (!allFailed) return base;
  return Math.min(Math.max(prev, base) * 2, max);
}

/** Full-range-but-not-zero jitter: 50–100% of the wait, so several pods that
 *  failed together do not retry together. `rand` is for tests. */
export function withJitter(delay: number, rand: () => number = Math.random): number {
  return Math.round(delay * (0.5 + rand() / 2));
}
