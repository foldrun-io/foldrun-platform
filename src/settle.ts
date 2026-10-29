// Settling a run's bill: the one write that must not be lost.
//
// The worker used to call recordRunCost and move on. A database that blinked
// at that moment, or a disk that refused the append, became an unhandled
// rejection in a log nobody reads — and the run was never billed, with no
// record anywhere that it had not been. That is the worst shape a billing
// failure can take: silent, and indistinguishable from a free run.
//
// Now the settle is awaited, retried a bounded number of times, and when it
// still fails it leaves two marks: an `unsettled/<runId>.json` under the
// account (what the hourly pass re-drives, and what the metrics count) and
// an error line on the run record's own trail (what a person reading the run
// sees). Nothing is charged twice for it — recordRunCost is idempotent by
// run id — so re-driving is always safe.

import fs from "node:fs";
import path from "node:path";
import { accountDir, listTenants, readRun, writeRun, runComputeMeter, runMeter, type RunRecord } from "../../foldrun-core/src/store.ts";
import { recordRunCost, type LedgerEntry } from "./ledger.ts";
import { releaseReservation } from "./reservations.ts";
import { billing } from "./billing.ts";

export interface Unsettled {
  tenant: string;
  workspace: string;
  runId: string;
  /** When the settle gave up. */
  at: string;
  /** The last error, for the person and the alert. */
  error: string;
  /** How many settles have failed in all, across re-drives. */
  attempts: number;
}

const dir = (tenant: string) => path.join(accountDir(tenant), "unsettled");
const file = (tenant: string, runId: string) => path.join(dir(tenant), `${runId}.json`);

/** What settling calls to charge; injectable so the failure path is testable
 *  without breaking a database. */
export type Charge = (tenant: string, workspace: string, runId: string, run: RunRecord) => Promise<LedgerEntry | null>;

const chargeRun: Charge = (tenant, workspace, runId, run) =>
  recordRunCost(
    tenant,
    workspace,
    runId,
    { ...runMeter(run), compute: runComputeMeter(run) },
    // What this cost is only half the question; which desk and which agent
    // it cost it on is the half that decides anything. Stamped on the line,
    // so it survives the run record being pruned. At the prices the run
    // was admitted under, when it was stamped with them.
    { flow: run.flow, steps: run.steps, pricing: run.pricing ?? null },
  );

/** Short, so a worker slot is not held for long over a database that is
 *  down — the hourly pass is the long retry. Overridable for tests. */
const BACKOFF_MS = [200, 800, 2000];

function trail(tenant: string, workspace: string, run: RunRecord, type: "info" | "error", text: string): void {
  const step = run.steps[run.steps.length - 1] ?? run.steps[0];
  if (!step) return;
  step.events.push({ t: new Date().toISOString(), type, text });
  writeRun(tenant, workspace, run);
}

/**
 * Charge a finished run, or record that it could not be charged.
 *
 * Returns the ledger line, null when there was nothing to bill (or it was
 * billed already), and `false` when every attempt failed and the run is
 * now marked unsettled. Never throws: the worker calls this in its settle
 * path and a billing failure must not be mistaken for a run failure.
 */
export async function settleRun(
  tenant: string,
  workspace: string,
  runId: string,
  opts: { charge?: Charge; backoffMs?: number[]; log?: (line: string) => void; afterCharge?: (tenant: string, entry: LedgerEntry | null) => unknown } = {},
): Promise<LedgerEntry | null | false> {
  const charge = opts.charge ?? chargeRun;
  const backoff = opts.backoffMs ?? BACKOFF_MS;
  const log = opts.log ?? ((line) => console.error(line));
  const run = readRun(tenant, workspace, runId);
  if (!run) return null;
  let lastError = "";
  for (let attempt = 0; attempt <= backoff.length; attempt++) {
    try {
      const entry = await charge(tenant, workspace, runId, run);
      // Settled, or nothing to settle: the run's hold on the caps is over.
      await releaseReservation(tenant, runId).catch(() => {});
      // A charge that took the balance across the warning line starts the
      // wallet guard now — auto top-up or the email — instead of at the
      // next hourly sweep. Not awaited: a card charge is no reason to hold
      // a worker slot, and the guard never throws.
      void (opts.afterCharge ?? ((t: string, e: LedgerEntry | null) => billing().afterCharge(t, e)))(tenant, entry);
      return entry;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < backoff.length) await new Promise((r) => setTimeout(r, backoff[attempt]));
    }
  }
  const previous = readUnsettled(tenant, runId);
  const mark: Unsettled = {
    tenant,
    workspace,
    runId,
    at: new Date().toISOString(),
    error: lastError,
    attempts: (previous?.attempts ?? 0) + backoff.length + 1,
  };
  fs.mkdirSync(dir(tenant), { recursive: true });
  fs.writeFileSync(file(tenant, runId), JSON.stringify(mark, null, 2));
  if (!previous) {
    trail(tenant, workspace, run, "error", `billing: the charge could not be recorded after ${backoff.length + 1} attempts (${lastError}) — marked unsettled; the hourly reconcile re-drives it`);
  }
  log(`[foldrun] billing: run ${tenant}/${workspace}/${runId} unsettled after ${mark.attempts} attempt(s): ${lastError}`);
  return false;
}

function readUnsettled(tenant: string, runId: string): Unsettled | null {
  try {
    return JSON.parse(fs.readFileSync(file(tenant, runId), "utf8")) as Unsettled;
  } catch {
    return null;
  }
}

/** Every run marked unsettled, for one tenant or all. */
export function listUnsettled(tenant?: string): Unsettled[] {
  const tenants = tenant ? [tenant] : safeTenants();
  const out: Unsettled[] = [];
  for (const t of tenants) {
    const d = dir(t);
    if (!fs.existsSync(d)) continue;
    for (const name of fs.readdirSync(d)) {
      if (!name.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(d, name), "utf8")) as Unsettled);
      } catch {
        // a torn marker is re-driven by name on the next pass
        out.push({ tenant: t, workspace: "", runId: name.replace(/\.json$/, ""), at: "", error: "unreadable marker", attempts: 0 });
      }
    }
  }
  return out;
}

function safeTenants(): string[] {
  try {
    return listTenants();
  } catch {
    return [];
  }
}

/**
 * Try again, once per marked run. The hourly pass calls this per tenant;
 * a marker whose run no longer exists is dropped with a log line, because
 * there is nothing left to charge and nothing to charge it to.
 */
export async function redriveUnsettled(tenant: string, opts: { charge?: Charge; log?: (line: string) => void } = {}): Promise<{ settled: string[]; still: string[] }> {
  const log = opts.log ?? ((line) => console.log(line));
  const settled: string[] = [];
  const still: string[] = [];
  for (const u of listUnsettled(tenant)) {
    const run = u.workspace ? readRun(tenant, u.workspace, u.runId) : null;
    if (!run) {
      fs.rmSync(file(tenant, u.runId), { force: true });
      log(`[foldrun] billing: unsettled run ${tenant}/${u.workspace}/${u.runId} has no record any more — marker dropped`);
      continue;
    }
    const result = await settleRun(tenant, u.workspace, u.runId, { charge: opts.charge, backoffMs: [], log });
    if (result === false) {
      still.push(u.runId);
      continue;
    }
    fs.rmSync(file(tenant, u.runId), { force: true });
    trail(tenant, u.workspace, run, "info", `billing: settled by the hourly reconcile${result ? ` — $${(-result.usd).toFixed(4)}` : " — nothing to charge"}`);
    settled.push(u.runId);
  }
  return { settled, still };
}

/** For /api/metrics: how many runs are owed a charge right now. */
export function unsettledCount(): number {
  return listUnsettled().length;
}
