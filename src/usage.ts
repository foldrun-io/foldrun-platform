// The account's consumption, as a report: what ran, what it used, what it
// cost, and where the bytes live — rolled up from the run records and the
// file stores that already hold every fact, never from a second counter
// that could drift from them.
//
// Two honesties the numbers carry:
//
//   · CPU and RAM are *reservations*, not measurements. A step's pod is
//     scheduled with a CPU and memory limit, and what the platform pays for
//     is that reservation for the sandbox's lifetime — the same quantity
//     Fargate or Cloud Run bills. Actual peak RSS is not recorded, and
//     inventing it would be worse than saying "reserved".
//
//   · Token counts exist only on steps recorded since they were persisted;
//     older steps still carry their dollar cost. The report sums what is
//     there and never extrapolates.

import fs from "node:fs";
import path from "node:path";
import { listWorkspaces, listRuns, workspaceDir, type RunRecord, type TokenUsage } from "../../foldrun-core/src/store.ts";
import { STORAGE_DIR, accountDir } from "../../foldrun-core/src/store.ts";
import { readLedger, micro } from "./ledger.ts";
import { billing } from "./billing.ts";
import { scopeAllows, type Scope } from "./scope.ts";

export interface UsageBucket {
  runs: number;
  steps: number;
  tokenCostUsd: number;
  /** All input, cache reads and writes included. */
  inputTokens: number;
  outputTokens: number;
  /** The part of inputTokens the prompt cache served (a tenth of the price) and stored. */
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** The input of the steps that report the cache split (18 Oct 2026 on).
   *  The hit rate is reads over this, so older steps, which cannot say, do
   *  not dilute it. */
  measuredInputTokens: number;
  /** cacheReadTokens ÷ measuredInputTokens, 0–1; null when nothing measured. */
  cacheHitRate: number | null;
  computeSecs: number;
  /** Reserved CPU-seconds and GiB-seconds: computeSecs × the pod limits in
   *  force now. Reported as reservation, which is the billable quantity. */
  cpuSecs: number;
  gibSecs: number;
  /** What this usage lists at, at the install's rates: tokens with the
   *  margin plus the compute hold. What a customer would pay for the same
   *  again — the ledger says what they did pay. */
  listUsd: number;
  /** The same, in the two halves a customer asks about. On their own model
   *  key the first is zero and the second is the whole bill. */
  modelUsd: number;
  platformUsd: number;
}

export interface WorkspaceUsage extends UsageBucket {
  workspace: string;
  byFlow: Record<string, UsageBucket>;
  byAgent: Record<string, UsageBucket>;
  storage: { sourceBytes: number; filesBytes: number; runsBytes: number };
}

export interface AccountUsage {
  tenant: string;
  generatedAt: string;
  podLimits: { cpus: number; memoryGiB: number };
  totals: UsageBucket & { storageBytes: number };
  workspaces: WorkspaceUsage[];
  /** The account's balance and what it was charged — named field by field,
   *  so nothing else a billing implementation returns reaches the caller. */
  ledger: { balanceUsd: number; chargedUsd: number };
  /** Charges this account does not pay. The meters still count; these are
   *  the legs the bill leaves out, so a page can show the usage and say
   *  plainly that it is not billed. */
  waived: ("models" | "compute" | "network")[];
}

const bucket = (): UsageBucket => ({
  runs: 0, steps: 0, tokenCostUsd: 0, inputTokens: 0, outputTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0, measuredInputTokens: 0, cacheHitRate: null,
  computeSecs: 0, cpuSecs: 0, gibSecs: 0, listUsd: 0, modelUsd: 0, platformUsd: 0,
});

function podLimits(): { cpus: number; memoryGiB: number } {
  const cpus = Number(process.env.FOLDRUN_RUNNER_CPUS);
  const memRaw = process.env.FOLDRUN_RUNNER_MEMORY ?? "2Gi";
  const m = memRaw.match(/^(\d+(?:\.\d+)?)\s*(Gi?|Mi?|g|m)?/i);
  const n = m ? Number(m[1]) : 2;
  const unit = (m?.[2] ?? "Gi").toLowerCase();
  return {
    cpus: Number.isFinite(cpus) && cpus > 0 ? cpus : 2,
    memoryGiB: unit.startsWith("m") ? n / 1024 : n,
  };
}

// The reservation a step's seconds are priced at. A step records what it
// actually held (`reserved`), because a size is a price: bigger job, more
// GiB-seconds, higher bill — which is what keeps authors honest about asking
// for `heavy`. Steps from before sizes existed have no record, so they fall
// back to the install's flat limit.
function stepLimits(
  s: RunRecord["steps"][number],
  fallback: { cpus: number; memoryGiB: number },
): { cpus: number; memoryGiB: number } {
  return s.reserved ? { cpus: s.reserved.cpus, memoryGiB: s.reserved.memGiB } : fallback;
}

function addTokens(b: UsageBucket, t: TokenUsage | null | undefined) {
  if (!t) return;
  b.inputTokens += t.input;
  b.outputTokens += t.output;
  if (t.cacheRead === undefined) return;
  b.cacheReadTokens += t.cacheRead;
  b.cacheWriteTokens += t.cacheWrite ?? 0;
  b.measuredInputTokens += t.input;
}
function addRun(b: UsageBucket, run: RunRecord, fallback: { cpus: number; memoryGiB: number }) {
  b.runs += 1;
  for (const s of run.steps) {
    if (s.status !== "completed" && s.status !== "failed") continue;
    if (s.carriedFrom) continue; // ran — and was counted — in another run
    b.steps += 1;
    b.tokenCostUsd += s.costUsd ?? 0;
    addTokens(b, s.tokens);
    const secs = s.computeSecs ?? 0;
    const lim = stepLimits(s, fallback);
    b.computeSecs += secs;
    b.cpuSecs += secs * lim.cpus;
    b.gibSecs += secs * lim.memoryGiB;
  }
}

/** Bytes under a directory. Skips what it cannot stat rather than failing
 *  the report over one unreadable file. */
function du(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) total += fs.statSync(full).size;
      } catch { /* unreadable entry — skip */ }
    }
  };
  walk(dir);
  return total;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

function rounded(b: UsageBucket): UsageBucket {
  return {
    ...b,
    tokenCostUsd: r6(b.tokenCostUsd),
    cacheHitRate: b.measuredInputTokens > 0 ? Math.round((b.cacheReadTokens / b.measuredInputTokens) * 1000) / 1000 : null,
    computeSecs: r2(b.computeSecs),
    cpuSecs: r2(b.cpuSecs),
    gibSecs: r2(b.gibSecs),
    ...(() => {
      const p = billing().listPrice(b);
      return { listUsd: micro(p.modelUsd + p.computeUsd), modelUsd: p.modelUsd, platformUsd: p.computeUsd };
    })(),
  };
}

/**
 * What the file store holds, from its index — not from disk. The bytes live
 * wherever the driver put them (R2 on the hosted platform), so a du of the
 * local directory sees only the index and reports a store full of CSVs as
 * one kilobyte. The index records every file's true size and is the same
 * record the Files page lists; a du of the local blobs/ is the fallback for
 * the fs driver's pre-index files.
 */
function fileStoreBytes(tenant: string, workspace: string): number {
  const root = path.join(accountDir(tenant), STORAGE_DIR, workspace);
  const index = path.join(root, "index.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(index, "utf8")) as { files?: { size?: number }[] };
    const list = Array.isArray(parsed) ? parsed : (parsed.files ?? []);
    return list.reduce((sum, f) => sum + (typeof f.size === "number" ? f.size : 0), 0);
  } catch {
    return du(root);
  }
}

/** `workspaces` narrows the report to a scoped caller's workspaces — the
 *  totals are theirs; the ledger stays the account's, as the wallet does. */
export async function accountUsage(tenant: string, opts: { workspaces?: Scope } = {}): Promise<AccountUsage> {
  const limits = podLimits();
  const totals = bucket();
  let storageBytes = 0;
  const workspaces: WorkspaceUsage[] = [];

  for (const ws of listWorkspaces(tenant)) {
    if (!scopeAllows(opts.workspaces ?? null, ws.name)) continue;
    const wsBucket = bucket();
    const byFlow: Record<string, UsageBucket> = {};
    const byAgent: Record<string, UsageBucket> = {};

    for (const run of listRuns(tenant, ws.name)) {
      addRun(wsBucket, run, limits);
      addRun((byFlow[run.flow] ??= bucket()), run, limits);
      // Steps attribute to their agent; the run count on an agent bucket
      // means "runs this agent took part in".
      const seen = new Set<string>();
      for (const s of run.steps) {
        if (s.status !== "completed" && s.status !== "failed") continue;
        if (s.carriedFrom) continue;
        const a = (byAgent[s.agent] ??= bucket());
        if (!seen.has(s.agent)) { a.runs += 1; seen.add(s.agent); }
        a.steps += 1;
        a.tokenCostUsd += s.costUsd ?? 0;
        addTokens(a, s.tokens);
        const secs = s.computeSecs ?? 0;
        const lim = stepLimits(s, limits);
        a.computeSecs += secs;
        a.cpuSecs += secs * lim.cpus;
        a.gibSecs += secs * lim.memoryGiB;
      }
    }

    const dir = workspaceDir(tenant, ws.name);
    const storage = {
      // Source is everything but the run history; runs are their own line
      // because they grow forever and source does not.
      sourceBytes: du(dir) - du(path.join(dir, "runs")),
      filesBytes: fileStoreBytes(tenant, ws.name),
      runsBytes: du(path.join(dir, "runs")),
    };
    storageBytes += storage.sourceBytes + storage.filesBytes + storage.runsBytes;

    totals.runs += wsBucket.runs;
    totals.steps += wsBucket.steps;
    totals.tokenCostUsd += wsBucket.tokenCostUsd;
    totals.inputTokens += wsBucket.inputTokens;
    totals.outputTokens += wsBucket.outputTokens;
    totals.cacheReadTokens += wsBucket.cacheReadTokens;
    totals.cacheWriteTokens += wsBucket.cacheWriteTokens;
    totals.measuredInputTokens += wsBucket.measuredInputTokens;
    totals.computeSecs += wsBucket.computeSecs;
    totals.cpuSecs += wsBucket.cpuSecs;
    totals.gibSecs += wsBucket.gibSecs;

    workspaces.push({
      workspace: ws.name,
      ...rounded(wsBucket),
      byFlow: Object.fromEntries(Object.entries(byFlow).map(([k, v]) => [k, rounded(v)])),
      byAgent: Object.fromEntries(Object.entries(byAgent).map(([k, v]) => [k, rounded(v)])),
      storage,
    });
  }

  const ledger = await billing().ledgerTotals(tenant);
  return {
    tenant,
    generatedAt: new Date().toISOString(),
    podLimits: limits,
    totals: { ...rounded(totals), storageBytes },
    workspaces: workspaces.sort((a, b) => b.tokenCostUsd - a.tokenCostUsd),
    ledger: { balanceUsd: await billing().balanceUsd(tenant), chargedUsd: ledger.chargedUsd },
    waived: await (async () => {
      const w = await billing().waive(tenant);
      return w ? (["models", "compute", "network"] as const).filter((k) => w[k]) : [];
    })(),
  };
}

// ---------------------------------------------------------------- history
//
// What accountUsage() answers above is "what is in the run records now".
// That is the right source for step counts and pod seconds, and the wrong
// one for money over time, for two reasons: run records are pruned at
// FOLDRUN_RETENTION_DAYS, so a desk's cost history disappears exactly when
// it becomes interesting, and a run record holds what a run consumed rather
// than what it was charged.
//
// The ledger holds neither problem. It is append-only, it survives pruning,
// and every line is the actual charge. Since charges carry `flow` and
// `agents`, "what does this desk cost me a week" is a read rather than a
// reconstruction — which is the question that decides whether a desk stays.

export interface SpendBucket {
  /** ISO date of the week's Monday, or of the day for a daily series. */
  period: string;
  usd: number;
  runs: number;
}

export interface SpendSeries {
  name: string;
  totalUsd: number;
  runs: number;
  periods: SpendBucket[];
  /** The most recent full period against the one before it, as a fraction:
   *  0.5 is half again as expensive. Null when there is nothing to compare,
   *  which is most of the first fortnight and should read as "not yet". */
  change: number | null;
}

export interface SpendHistory {
  from: string;
  to: string;
  bucket: "day" | "week";
  periods: string[];
  byFlow: SpendSeries[];
  byAgent: SpendSeries[];
  byWorkspace: SpendSeries[];
  /** Charges too old to carry attribution, or that never had any. Shown as
   *  a line of its own rather than silently dropped: a breakdown that does
   *  not add up to the invoice is worse than one that admits a remainder. */
  unattributedUsd: number;
  totalUsd: number;
  /** The window's charge in its two halves, from the split each run's
   *  ledger line carries. Entries written before the split existed count
   *  as `unsplitUsd` rather than being guessed at — a breakdown that
   *  invents a number is worse than one that says it does not know. */
  modelUsd: number;
  platformUsd: number;
  unsplitUsd: number;
}

/** The Monday of an ISO date's week, in UTC. Weeks because a desk that runs
 *  on Tuesdays has no daily shape worth reading. */
function weekOf(iso: string): string {
  const d = new Date(iso);
  d.setUTCHours(0, 0, 0, 0);
  // getUTCDay: 0 is Sunday, so Sunday belongs to the week that began six
  // days earlier rather than starting a new one.
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

const dayOf = (iso: string) => iso.slice(0, 10);

function seriesFrom(
  rows: Map<string, Map<string, { usd: number; runs: number }>>,
  periods: string[],
): SpendSeries[] {
  const out: SpendSeries[] = [];
  for (const [name, byPeriod] of rows) {
    const buckets = periods.map((period) => ({
      period,
      usd: Number((byPeriod.get(period)?.usd ?? 0).toFixed(6)),
      runs: byPeriod.get(period)?.runs ?? 0,
    }));
    const totalUsd = Number(buckets.reduce((n, b) => n + b.usd, 0).toFixed(6));
    // The last period is usually partial — comparing a Tuesday against a
    // whole week would report every desk as collapsing. Compare the last
    // two COMPLETE periods instead.
    const complete = buckets.slice(0, -1);
    const latest = complete.at(-1);
    const before = complete.at(-2);
    const change = latest && before && before.usd > 0 ? (latest.usd - before.usd) / before.usd : null;
    out.push({ name, totalUsd, runs: buckets.reduce((n, b) => n + b.runs, 0), periods: buckets, change });
  }
  return out.sort((a, b) => b.totalUsd - a.totalUsd);
}

/**
 * Charged spend by flow, by agent and by workspace over a window, read from
 * the ledger alone.
 *
 * `days` is how far back to look; anything over about eight weeks buckets by
 * week rather than by day, because a hundred daily columns is a table nobody
 * reads.
 *
 * `workspaces` narrows it to a scoped caller's: charges in other workspaces,
 * and charges that name none, are left out.
 */
export async function spendHistory(tenant: string, days = 56, opts: { workspaces?: Scope } = {}): Promise<SpendHistory> {
  const scope = opts.workspaces ?? null;
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400_000);
  const bucket: "day" | "week" = days > 21 ? "week" : "day";
  const keyFor = bucket === "week" ? weekOf : dayOf;

  const byFlow = new Map<string, Map<string, { usd: number; runs: number }>>();
  const byAgent = new Map<string, Map<string, { usd: number; runs: number }>>();
  const byWorkspace = new Map<string, Map<string, { usd: number; runs: number }>>();
  const periods = new Set<string>();
  let unattributedUsd = 0;
  let totalUsd = 0;
  let modelUsd = 0;
  let platformUsd = 0;
  let unsplitUsd = 0;

  const add = (
    map: Map<string, Map<string, { usd: number; runs: number }>>,
    name: string,
    period: string,
    usd: number,
    runs: number,
  ) => {
    const byPeriod = map.get(name) ?? new Map();
    map.set(name, byPeriod);
    const cell = byPeriod.get(period) ?? { usd: 0, runs: 0 };
    cell.usd += usd;
    cell.runs += runs;
    byPeriod.set(period, cell);
  };

  for (const e of await readLedger(tenant)) {
    // Charges only. A top-up is money in and belongs on the wallet page.
    if (e.kind !== "run" || e.usd >= 0) continue;
    if (scope !== null && (!e.workspace || !scope.includes(e.workspace))) continue;
    const at = new Date(e.t);
    if (at < from || at > to) continue;
    const period = keyFor(e.t);
    periods.add(period);
    const usd = -e.usd;
    totalUsd += usd;
    if (e.split) {
      modelUsd += e.split.modelUsd;
      platformUsd += e.split.computeUsd + e.split.networkUsd;
    } else {
      unsplitUsd += usd;
    }
    if (e.workspace) add(byWorkspace, e.workspace, period, usd, 1);
    // Named by workspace as well: two desks each with a `daily` flow are two
    // flows, and merging them reported one row with a meaningless trend.
    const ws = e.workspace ?? "?";
    if (e.flow) add(byFlow, `${ws}/${e.flow}`, period, usd, 1);
    else unattributedUsd += usd;
    for (const [agent, share] of Object.entries(e.agents ?? {})) {
      add(byAgent, `${ws}/${agent}`, period, share, 0);
    }
  }

  const ordered = [...periods].sort();
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    bucket,
    periods: ordered,
    byFlow: seriesFrom(byFlow, ordered),
    byAgent: seriesFrom(byAgent, ordered),
    byWorkspace: seriesFrom(byWorkspace, ordered),
    unattributedUsd: Number(unattributedUsd.toFixed(6)),
    totalUsd: Number(totalUsd.toFixed(6)),
    modelUsd: Number(modelUsd.toFixed(6)),
    platformUsd: Number(platformUsd.toFixed(6)),
    unsplitUsd: Number(unsplitUsd.toFixed(6)),
  };
}
