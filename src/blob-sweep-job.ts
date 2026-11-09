// The blob sweeper on a schedule (FOL-126): off unless the operator turns it on,
// a dry run first, one pod at a time (the housekeeping lease), and at most once
// per interval however many pods tick. The sweeping itself is core
// blob-sweeper.ts; this is the settings, the lease and the clock.

import { blobStore } from "../../foldrun-core/src/blob-store.ts";
import { sweepBlobs, type SweepReport } from "../../foldrun-core/src/blob-sweeper.ts";
import { opsError, opsLog } from "../../foldrun-core/src/ops-log.ts";
import { cleanOrphanedHistory, revisionBackend } from "../../foldrun-core/src/workspace-revisions.ts";
import { databaseEnabled } from "./db.ts";
import { withHousekeeping } from "./housekeeping.ts";
import { pgBlobPins } from "./blob-pins.ts";
import { pgRevisionStore } from "./revision-store-pg.ts";
import { pgSweepMarks } from "./sweep-marks-pg.ts";
import { setting } from "./settings.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const num = (key: string, fallback: number) => {
  const v = setting(key);
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
};

/** One look: is it on, is it due, and if so run it under the lease. `force`
 *  skips the on-switch and the schedule (an operator's "run it now"). */
export async function runBlobSweep(opts: { force?: boolean; dryRun?: boolean } = {}): Promise<SweepReport | null> {
  if (!databaseEnabled()) return null;
  if (!opts.force && setting("blobs.sweep") !== true) return null;
  const marks = pgSweepMarks();
  if (!opts.force) {
    const last = await marks.lastRunAt();
    if (last && Date.now() - last.getTime() < num("blobs.sweep_interval_hours", 24) * HOUR) return null;
  }
  const out = await withHousekeeping("blob-sweep", async () => {
    const dryRun = opts.dryRun ?? setting("blobs.sweep_dry_run") !== false;
    // The history of workspaces deleted before the delete took it along goes
    // first, so its manifests are unreferenced by the time they are looked at.
    if (!dryRun && revisionBackend()) {
      await cleanOrphanedHistory(marks, { graceMs: HOUR }).catch((err) => opsError("revisions.orphans_failed", err, {}, "warn"));
    }
    return sweepBlobs(
      { blobs: blobStore(), revisions: pgRevisionStore(), pins: pgBlobPins() },
      marks,
      { dryRun, delayMs: num("blobs.sweep_delay_days", 7) * DAY, maxDeletes: num("blobs.sweep_max_deletes", 10_000) },
    );
  });
  return out ?? null;
}

let timer: ReturnType<typeof setInterval> | null = null;
/** Look every ten minutes; the schedule and the lease decide whether anything runs. */
export function startBlobSweepLoop(): void {
  if (timer || !databaseEnabled()) return;
  const tick = () => void runBlobSweep().catch((err) => opsError("blobs.sweep_failed", err, { stage: "schedule" }));
  timer = setInterval(tick, 10 * 60_000);
  timer.unref?.();
  const first = setTimeout(tick, 5 * 60_000);
  first.unref?.();
  opsLog("info", "blobs.sweep_scheduled", {});
}
export function stopBlobSweepLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
