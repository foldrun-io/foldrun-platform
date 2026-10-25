// The two billing numbers that mean "look now" when they are not zero.
//
// An unsettled run is a run the platform did the work for and has not been
// paid for, with a marker saying so (settle.ts). A reservation is money held
// for a run in flight (reservations.ts); a total that only climbs means holds
// are not being released. Both belong on /api/metrics beside the queue's
// numbers, so the Grafana rules in foldrun-infra can alert on them, and both
// are printed by the hourly pass so the log has them too.
//
//   foldrun_billing_unsettled_runs    gauge   runs owed a charge
//   foldrun_billing_reserved_usd      gauge   dollars held for runs in flight
//   foldrun_billing_reserved_count    gauge   holds outstanding
//
// The route in foldrun-web appends `await billingMetricsText()` to the lines
// it already renders.

import { unsettledCount } from "./settle.ts";
import { reservationTotals } from "./reservations.ts";

export interface BillingMetrics {
  unsettledRuns: number;
  reservedUsd: number;
  reservedCount: number;
}

export async function billingMetrics(): Promise<BillingMetrics> {
  const held = await reservationTotals().catch(() => ({ count: 0, usd: 0 }));
  return { unsettledRuns: unsettledCount(), reservedUsd: Number(held.usd.toFixed(6)), reservedCount: held.count };
}

/** Prometheus text, one gauge per line pair, in the shape /api/metrics already speaks. */
export async function billingMetricsText(): Promise<string[]> {
  const m = await billingMetrics();
  return [
    "# HELP foldrun_billing_unsettled_runs Finished runs whose charge could not be recorded and is owed.",
    "# TYPE foldrun_billing_unsettled_runs gauge",
    `foldrun_billing_unsettled_runs ${m.unsettledRuns}`,
    "# HELP foldrun_billing_reserved_usd Dollars held for runs admitted and not yet settled.",
    "# TYPE foldrun_billing_reserved_usd gauge",
    `foldrun_billing_reserved_usd ${m.reservedUsd}`,
    "# HELP foldrun_billing_reserved_count Reservations outstanding.",
    "# TYPE foldrun_billing_reserved_count gauge",
    `foldrun_billing_reserved_count ${m.reservedCount}`,
  ];
}
