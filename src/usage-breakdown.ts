// The Usage page's two questions (7 Nov 2026, FOL-125): what did I use and
// pay for in TOKENS, and what in COMPUTE — by provider and model, and by
// meter, with the quantity, the rate and the credits on every line.
//
// Two views of one number, kept apart on purpose:
//
//   · CONSUMPTION (tokens.byModel, compute.meters): what the period's runs
//     and model calls used, priced at the rates in force now. Read from the
//     run records and model_usage, which already hold every fact.
//   · BILLED (billed): what the ledger charged over the period, which is
//     the bill. A run admitted before a price change, or a waiver, makes the
//     two differ; the page says so rather than hiding it.
//
// A caller limited to some workspaces gets their own runs' usage, and none of
// the account's money: credits, the plan fee and the ledger total are null.
//
// Without billing (an install that bills nothing) the quantities are still
// reported; rates and credits are null/0.

import { listRuns, listWorkspaces, billedTokenCost, type RunRecord } from "../../foldrun-core/src/store.ts";
import { readLedger, entryReason, micro } from "./ledger.ts";
import { billing, type AccountCredits, type MeterRates } from "./billing.ts";
import { callsInDays } from "./model-usage.ts";
import { scopeAllows, type Scope } from "./scope.ts";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const GB = 1e9;
const MONTH_HOURS = 30 * 24;

export interface TokenRow {
  /** foldrun: the platform's keys (billed); operator: the operator's key on
   *  this account (billed); own: the account's own key (not billed). */
  supply: "foldrun" | "operator" | "own";
  provider: string;
  model: string;
  calls: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  billedCredits: number;
  /** foldrun's models: what the provider charged foldrun, before the margin. */
  providerCostUsd?: number;
  /** Calls charged at their estimate because no usage came back. */
  estimatedCalls?: number;
  billedNote?: string;
}

export interface MeterLine {
  meter: "vcpu" | "ram" | "disk" | "storage" | "network" | "pods";
  quantity: number | null;
  unit: string;
  /** Credits per unit; null where nothing is priced here. */
  rateCreditsPerUnit: number | null;
  credits: number;
  includedGb?: number;
  overGb?: number;
}

export interface SizeLine {
  size: "small" | "large" | "heavy" | "unrecorded";
  steps: number;
  hours: number;
  /** The reservation these steps held, averaged. */
  vcpu: number;
  memGiB: number;
  diskGiB: number;
  creditsPerHour: number | null;
}

export interface UsageBreakdowns {
  period: { from: string; to: string; basis: "consumption" };
  credits: (AccountCredits & { unit: "credit"; usdPerCredit: number }) | null;
  tokens: {
    totals: { calls: number; billedCredits: number; byokTokens: number };
    byModel: TokenRow[];
  };
  compute: {
    meters: MeterLine[];
    planFee: { usd: number; credits: number; label: string; includedCredits: number } | null;
    bySize: SizeLine[];
  };
  billed: { totalCredits: number; waived: ("models" | "compute" | "network")[] } | null;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** The period, validated: `from`/`to` are UTC days, default the month so
 *  far. A plain Error is a 400 at the API. */
export function usagePeriod(from?: string, to?: string, now = new Date()): { from: string; to: string } {
  const today = now.toISOString().slice(0, 10);
  const f = from ?? `${today.slice(0, 7)}-01`;
  const t = to ?? today;
  if (!DAY.test(f) || !DAY.test(t) || Number.isNaN(Date.parse(f)) || Number.isNaN(Date.parse(t))) throw new Error("from and to are days, YYYY-MM-DD");
  if (f > t) throw new Error("from is after to");
  if ((Date.parse(t) - Date.parse(f)) / 86_400_000 > 366) throw new Error("a period is at most a year");
  return { from: f, to: t };
}

function providerOf(s: RunRecord["steps"][number]): string {
  if (s.supplyProvider) return s.supplyProvider;
  const m = /^provider:\s*([a-z0-9_.-]+)/i.exec(s.credential ?? "");
  return m ? m[1]!.toLowerCase() : "unknown";
}

function rateCredits(rates: MeterRates | null, perUnitUsd: number | undefined): number | null {
  if (!rates || perUnitUsd === undefined) return null;
  return r3(perUnitUsd / rates.creditUsd);
}

export async function usageBreakdowns(
  tenant: string,
  opts: { workspaces?: Scope; from?: string; to?: string; storageBytes: number },
): Promise<UsageBreakdowns> {
  const period = usagePeriod(opts.from, opts.to);
  const b = billing();
  const rates = b.meterRates?.() ?? null;
  const creditUsd = rates?.creditUsd ?? 0.01;
  const accountWide = (opts.workspaces ?? null) === null;

  // ---- the runs of the period, in the caller's workspaces
  const runs: RunRecord[] = [];
  for (const ws of listWorkspaces(tenant)) {
    if (!scopeAllows(opts.workspaces ?? null, ws.name)) continue;
    for (const run of listRuns(tenant, ws.name)) {
      const day = (run.startedAt ?? "").slice(0, 10);
      if (day >= period.from && day <= period.to) runs.push(run);
    }
  }
  const runIds = new Set(runs.map((r) => r.id));

  // ---- tokens
  const rows = new Map<string, TokenRow>();
  const row = (supply: TokenRow["supply"], provider: string, model: string): TokenRow => {
    const k = `${supply}/${provider}/${model}`;
    let r = rows.get(k);
    if (!r) {
      r = { supply, provider, model, calls: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, billedCredits: 0 };
      if (supply === "foldrun") { r.providerCostUsd = 0; r.estimatedCalls = 0; }
      if (supply === "own") r.billedNote = "your own key; the provider bills you";
      rows.set(k, r);
    }
    return r;
  };

  for (const c of await callsInDays(tenant, period.from, period.to)) {
    // A scoped caller sees the calls of their own runs, never host jobs.
    if (!accountWide && !(c.runId && runIds.has(c.runId))) continue;
    const r = row("foldrun", c.provider, c.model);
    r.calls += 1;
    r.inputTokens += c.tokens.input;
    r.cacheReadTokens += c.tokens.cacheRead;
    r.cacheWriteTokens += c.tokens.cacheWrite;
    r.outputTokens += c.tokens.output;
    r.providerCostUsd = micro((r.providerCostUsd ?? 0) + c.costUsd);
    if (c.status === "estimated" || c.status === "open") r.estimatedCalls = (r.estimatedCalls ?? 0) + 1;
    r.billedCredits += (b.modelChargeOf?.(c.costUsd) ?? c.costUsd) / creditUsd;
  }

  let byokTokens = 0;
  const comp = { coreSecs: 0, gibSecs: 0, diskGibSecs: 0, netBytes: 0 };
  const sizes = new Map<string, { steps: number; secs: number; core: number; gib: number; disk: number }>();
  for (const run of runs) {
    for (const s of run.steps) {
      if (s.status !== "completed" && s.status !== "failed") continue;
      if (s.carriedFrom) continue;
      const secs = s.computeSecs ?? 0;
      if (s.reserved && secs > 0) {
        comp.coreSecs += secs * s.reserved.cpus;
        comp.gibSecs += secs * s.reserved.memGiB;
        comp.diskGibSecs += secs * (s.reserved.diskGiB ?? 0);
      }
      comp.netBytes += (s.actual?.rxBytes ?? 0) + (s.actual?.txBytes ?? 0);
      const sz = sizes.get(s.size ?? "unrecorded") ?? { steps: 0, secs: 0, core: 0, gib: 0, disk: 0 };
      sz.steps += 1;
      sz.secs += secs;
      sz.core += (s.reserved?.cpus ?? 0) * secs;
      sz.gib += (s.reserved?.memGiB ?? 0) * secs;
      sz.disk += (s.reserved?.diskGiB ?? 0) * secs;
      sizes.set(s.size ?? "unrecorded", sz);

      // Tokens on foldrun's models are in model_usage (above); the account's
      // own key and the operator's are read off the step.
      if (s.supply === "foldrun" || !s.tokens) continue;
      const supply = s.supply === "operator" ? "operator" : "own";
      const r = row(supply, providerOf(s), s.model ?? "unknown");
      r.calls += 1;
      r.inputTokens += s.tokens.input;
      r.outputTokens += s.tokens.output;
      r.cacheReadTokens += s.tokens.cacheRead ?? 0;
      r.cacheWriteTokens += s.tokens.cacheWrite ?? 0;
      if (supply === "own") byokTokens += s.tokens.input + s.tokens.output;
      else r.billedCredits += b.listPrice({ tokenCostUsd: billedTokenCost(s), cpuSecs: 0, gibSecs: 0, computeSecs: 0 }).modelUsd / creditUsd;
    }
  }
  const byModel = [...rows.values()]
    .map((r) => ({ ...r, billedCredits: r3(r.billedCredits) }))
    .sort((x, y) => (x.supply === y.supply ? y.billedCredits - x.billedCredits || (x.provider + x.model).localeCompare(y.provider + y.model) : x.supply === "own" ? 1 : y.supply === "own" ? -1 : 0));

  // ---- the account's credits, and the plan's storage allowance
  const credits = accountWide ? await b.accountCredits?.(tenant) ?? null : null;
  const includedGb = credits?.plan?.storageGb ?? 0;
  const storageGb = opts.storageBytes / GB;
  const overGb = Math.max(0, storageGb - includedGb);

  // ---- the ledger over the period: pod sessions, the bill, the plan fee
  const ledger = accountWide ? (await readLedger(tenant)).filter((e) => e.t.slice(0, 10) >= period.from && e.t.slice(0, 10) <= period.to) : [];
  const podCredits = ledger.filter((e) => e.usd < 0 && entryReason(e) === "pod").reduce((n, e) => n - e.usd, 0) / creditUsd;
  const billedUsd = ledger.filter((e) => e.usd < 0 && e.kind !== "expire" && entryReason(e) !== "refund" && entryReason(e) !== "dispute").reduce((n, e) => n - e.usd, 0);

  const hours = (secs: number) => secs / 3600;
  const meters: MeterLine[] = [
    { meter: "vcpu", quantity: r3(hours(comp.coreSecs)), unit: "vCPU-hour", rateCreditsPerUnit: rateCredits(rates, rates?.vcpuUsdPerHour), credits: 0 },
    { meter: "ram", quantity: r3(hours(comp.gibSecs)), unit: "GiB-hour", rateCreditsPerUnit: rateCredits(rates, rates?.ramUsdPerGibHour), credits: 0 },
    { meter: "disk", quantity: r3(hours(comp.diskGibSecs)), unit: "GiB-hour", rateCreditsPerUnit: rates ? r3(rates.diskUsdPerGibMonth / MONTH_HOURS / rates.creditUsd) : null, credits: 0 },
    { meter: "storage", quantity: r3(storageGb), unit: "GB", rateCreditsPerUnit: rateCredits(rates, rates?.storageUsdPerGbMonth), credits: 0, includedGb, overGb: r3(overGb) },
    { meter: "network", quantity: r3(comp.netBytes / GB), unit: "GB", rateCreditsPerUnit: rateCredits(rates, rates?.networkUsdPerGb), credits: 0 },
    { meter: "pods", quantity: null, unit: "pod-hour", rateCreditsPerUnit: null, credits: r3(podCredits) },
  ];
  for (const m of meters) {
    if (m.meter === "pods" || m.rateCreditsPerUnit === null || m.quantity === null) continue;
    m.credits = r3((m.meter === "storage" ? overGb : m.quantity) * m.rateCreditsPerUnit);
  }

  const perHour = (core: number, gib: number, disk: number): number | null =>
    rates ? r3((core * rates.vcpuUsdPerHour + gib * rates.ramUsdPerGibHour + disk * (rates.diskUsdPerGibMonth / MONTH_HOURS)) / rates.creditUsd) : null;
  const bySize: SizeLine[] = [...sizes.entries()].map(([size, z]) => {
    const secs = z.secs || 1;
    const vcpu = z.core / secs, memGiB = z.gib / secs, diskGiB = z.disk / secs;
    return { size: size as SizeLine["size"], steps: z.steps, hours: r3(hours(z.secs)), vcpu: r3(vcpu), memGiB: r3(memGiB), diskGiB: r3(diskGiB), creditsPerHour: z.secs > 0 ? perHour(vcpu, memGiB, diskGiB) : null };
  });

  const planFee = credits?.plan && credits.plan.feeUsd > 0
    ? { usd: credits.plan.feeUsd, credits: Math.round(credits.plan.feeUsd / creditUsd), label: `${credits.plan.name} plan`, includedCredits: credits.plan.creditsPerMonth }
    : null;

  const waived = accountWide ? await (async () => { const w = await b.waive(tenant); return w ? (["models", "compute", "network"] as const).filter((k) => w[k]) : []; })() : null;

  return {
    period: { ...period, basis: "consumption" },
    credits: credits ? { ...credits, unit: "credit", usdPerCredit: creditUsd } : null,
    tokens: {
      totals: { calls: byModel.reduce((n, r) => n + r.calls, 0), billedCredits: r3(byModel.reduce((n, r) => n + r.billedCredits, 0)), byokTokens },
      byModel,
    },
    compute: { meters, planFee, bySize },
    billed: accountWide ? { totalCredits: r3(billedUsd / creditUsd), waived: waived ?? [] } : null,
  };
}
