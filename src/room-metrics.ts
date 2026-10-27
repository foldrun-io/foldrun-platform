// Steps waiting for room, as Prometheus gauges (27 Oct 2026) — for
// /api/metrics beside the queue's own. A run parked for room carries a
// future recheck, so the queue counts it as "scheduled" and no queue metric
// saw it; a step waiting in its driver was invisible too.
//
// These are PRE-POD waits only — what `roomWait` records on the run (core
// runner.ts): a step whose pod exists but that no node can place yet clears
// it, and the Pending-pod alert covers that. By `level`, because a wait is
// not always a full cluster: `run`, `workspace` and `account` are a cap the
// customer or the plan set; `node` is the install's budget; `turn` is a step
// waiting behind an older one. Read from every account's live run records,
// once per scrape, one clock.

import { listTenants } from "../../foldrun-core/src/store.ts";
import { roomWaiting } from "./limits.ts";

const LEVELS = ["run", "workspace", "account", "node", "turn"] as const;

export function roomMetricsText(now = Date.now()): string[] {
  const count: Record<(typeof LEVELS)[number], number> = { run: 0, workspace: 0, account: 0, node: 0, turn: 0 };
  let oldest = 0;
  let failed = 0;
  for (const tenant of listTenants()) {
    let rows: ReturnType<typeof roomWaiting>;
    try {
      rows = roomWaiting(tenant);
    } catch {
      // Unreadable is not "nothing waiting": said below, never a quiet zero.
      failed += 1;
      continue;
    }
    for (const w of rows) {
      count[w.level ?? "turn"] += 1;
      const since = Date.parse(w.since);
      if (Number.isFinite(since)) oldest = Math.max(oldest, (now - since) / 1000);
    }
  }
  return [
    "# HELP foldrun_room_waiting_steps Steps waiting for room to start, before their pod exists, by the cap that holds them (turn: behind an older step).",
    "# TYPE foldrun_room_waiting_steps gauge",
    ...LEVELS.map((l) => `foldrun_room_waiting_steps{level="${l}"} ${count[l]}`),
    "# HELP foldrun_room_oldest_wait_seconds How long the longest-waiting step has waited for room.",
    "# TYPE foldrun_room_oldest_wait_seconds gauge",
    `foldrun_room_oldest_wait_seconds ${Math.round(oldest)}`,
    "# HELP foldrun_room_metrics_errors Accounts whose run records could not be read for these gauges this scrape.",
    "# TYPE foldrun_room_metrics_errors gauge",
    `foldrun_room_metrics_errors ${failed}`,
  ];
}
