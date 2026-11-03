// What each account chose to run on — its own key, or foldrun's models for
// one provider — and what the platform says to that now (core
// platform.modelSupply, asked by the runner for every step).
//
// The choice is a record (account_model_choice), written in one validated
// write by PUT /api/account/model only. Every pod keeps all of them in
// memory (a row per account that ever chose; small), reloaded every
// SETTINGS_POLL_MS and at once after a write here, because the runner asks
// synchronously. An outage keeps the last snapshot: a choice is not an
// entitlement — the gateway decides each call — so a stale one costs
// nothing that is not then refused there.

import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { SUPPLY_PROVIDERS, SUPPLY_TITLES, isSupplyProvider, type SupplyAnswer, type SupplyProviderName } from "../../foldrun-core/src/model-supply.ts";
import { databaseEnabled, ormRequired } from "./db.ts";
import { accountModelChoice } from "./schema.ts";
import { SETTINGS_POLL_MS, setting, supplyStanding } from "./settings.ts";
import { offeredProviders } from "./model-gateway.ts";
import { supplyKeySet } from "./model-keys.ts";
import { spentToday } from "./model-usage.ts";
import { billing, type CustomerModelPrice } from "./billing.ts";
import { edition } from "./ledger.ts";

export type ModelSource = "own" | "foldrun";

export interface ModelChoice {
  source: ModelSource;
  provider: SupplyProviderName | null;
  version: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

const OWN: ModelChoice = { source: "own", provider: null, version: 0, updatedBy: null, updatedAt: null };

let snap: Map<string, ModelChoice> | null = null;
/** Choices this pod wrote, with when: a read that started before one of
 *  them may not have it yet, so it is laid over that read. Older ones are
 *  dropped, so a row deleted elsewhere leaves every pod within a poll. */
const localWrites = new Map<string, { choice: ModelChoice; at: number }>();
/** Reads can overlap (a slow poll and the next): one that STARTED before the
 *  one already applied is dropped, as settings.ts does (Codex review). */
let loadsStarted = 0;
let loadApplied = 0;
let poll: NodeJS.Timeout | null = null;

const file = () => path.join(dataRoot(), ".model-choice.json");

function readFile(): Record<string, ModelChoice> {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8")) as Record<string, ModelChoice>;
  } catch {
    return {};
  }
}

async function readAll(): Promise<Map<string, ModelChoice>> {
  if (!databaseEnabled()) return new Map(Object.entries(readFile()));
  const rows = await ormRequired().select().from(accountModelChoice);
  return new Map(
    rows.map((r) => [
      r.tenant,
      {
        source: r.source === "foldrun" ? "foldrun" : "own",
        provider: isSupplyProvider(r.provider) ? r.provider : null,
        version: r.version,
        updatedBy: r.updatedBy,
        updatedAt: r.updatedAt.toISOString(),
      } satisfies ModelChoice,
    ]),
  );
}

/** Read every choice into this process; keep the last on failure. Only a
 *  complete read makes the snapshot (a write before one does not), and a
 *  read never puts back an older version of a choice this pod has newer —
 *  a read that started before a write here finishes after it (Codex review). */
export async function loadModelChoices(): Promise<void> {
  const started = Date.now();
  const gen = ++loadsStarted;
  try {
    const read = await readAll();
    if (gen < loadApplied) return;
    loadApplied = gen;
    for (const [tenant, w] of localWrites) {
      if (w.at < started) {
        localWrites.delete(tenant);
        continue;
      }
      const theirs = read.get(tenant);
      if (!theirs || theirs.version < w.choice.version) read.set(tenant, w.choice);
    }
    snap = read;
  } catch (err) {
    console.error("[model-choice] could not read the account choices; keeping the last:", err instanceof Error ? err.message : err);
  }
}

export async function startModelChoices(): Promise<void> {
  await loadModelChoices();
  if (poll) return;
  poll = setInterval(() => void loadModelChoices(), SETTINGS_POLL_MS);
  poll.unref?.();
}

/** The account's choice as this pod knows it. */
export function modelChoiceOf(tenant: string): ModelChoice {
  return snap?.get(tenant) ?? (databaseEnabled() ? OWN : readFile()[tenant] ?? OWN);
}

export class ChoiceConflict extends Error {}

/**
 * Write the account's choice — one row, one version step. `ifVersion`, when
 * given, must be the version read (0: never chosen), or ChoiceConflict.
 * Validated here as well as at the route: "foldrun" needs a known provider.
 */
export async function setModelChoice(
  tenant: string,
  next: { source: ModelSource; provider?: string | null },
  by: string,
  ifVersion?: number,
): Promise<ModelChoice> {
  if (next.source !== "own" && next.source !== "foldrun") throw new Error("source is own or foldrun");
  const provider = next.source === "foldrun" ? next.provider : null;
  if (next.source === "foldrun" && !isSupplyProvider(provider)) throw new Error(`provider is one of ${Object.keys(SUPPLY_PROVIDERS).join(", ")}`);
  const at = new Date();
  let written: ModelChoice;
  if (databaseEnabled()) {
    // Conditional writes never write before saying so (Codex review): with
    // ifVersion 0 only an insert (nothing chosen yet); with another only an
    // update of that version; without one, the upsert.
    const res =
      ifVersion === undefined
        ? await ormRequired().execute(sql`
            INSERT INTO account_model_choice (tenant, source, provider, version, updated_by, updated_at)
            VALUES (${tenant}, ${next.source}, ${provider ?? null}, 1, ${by}, ${at})
            ON CONFLICT (tenant) DO UPDATE SET source = EXCLUDED.source, provider = EXCLUDED.provider,
              version = account_model_choice.version + 1, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
            RETURNING version`)
        : ifVersion === 0
          ? await ormRequired().execute(sql`
              INSERT INTO account_model_choice (tenant, source, provider, version, updated_by, updated_at)
              VALUES (${tenant}, ${next.source}, ${provider ?? null}, 1, ${by}, ${at})
              ON CONFLICT (tenant) DO NOTHING
              RETURNING version`)
          : await ormRequired().execute(sql`
              UPDATE account_model_choice SET source = ${next.source}, provider = ${provider ?? null},
                version = version + 1, updated_by = ${by}, updated_at = ${at}
              WHERE tenant = ${tenant} AND version = ${ifVersion}
              RETURNING version`);
    const row = res.rows[0] as { version: number } | undefined;
    if (!row) throw new ChoiceConflict("the choice changed since it was read");
    written = { source: next.source, provider: (provider as SupplyProviderName) ?? null, version: row.version, updatedBy: by, updatedAt: at.toISOString() };
  } else {
    const all = readFile();
    const cur = all[tenant] ?? OWN;
    if (ifVersion !== undefined && cur.version !== ifVersion) throw new ChoiceConflict("the choice changed since it was read");
    written = { source: next.source, provider: (provider as SupplyProviderName) ?? null, version: cur.version + 1, updatedBy: by, updatedAt: at.toISOString() };
    all[tenant] = written;
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(all));
  }
  // Into the snapshot only once one is complete; before that the runner
  // still refuses everyone rather than guess from a partial map.
  localWrites.set(tenant, { choice: written, at: Date.now() });
  if (snap && (snap.get(tenant)?.version ?? 0) < written.version) snap.set(tenant, written);
  return written;
}

/** The account is being deleted: its choice goes with it. (Its
 *  model_usage rows stay, like the ledger: the record of money spent,
 *  naming no person.) */
export async function deleteModelChoice(tenant: string): Promise<void> {
  if (databaseEnabled()) await ormRequired().delete(accountModelChoice).where(eq(accountModelChoice.tenant, tenant));
  else {
    const all = readFile();
    if (tenant in all) {
      delete all[tenant];
      fs.writeFileSync(file(), JSON.stringify(all));
    }
  }
  snap?.delete(tenant);
  localWrites.delete(tenant);
}

/** A provider's tier map from its setting: `fast=a,default=b,max=c`. */
export function supplyTiers(provider: SupplyProviderName): Partial<Record<"fast" | "default" | "max", string>> {
  const raw = String(setting(`models.supply.${provider}.tiers`) ?? "");
  const out: Partial<Record<"fast" | "default" | "max", string>> = {};
  for (const part of raw.split(",")) {
    const [k, v] = part.split("=").map((x) => x?.trim());
    if ((k === "fast" || k === "default" || k === "max") && v) out[k] = v;
  }
  return out;
}

/** Why a provider cannot be offered now, or null when it can: listed, the
 *  platform holds its key (set in the console, model-keys.ts), and (except Anthropic, whose tier words the
 *  runtime knows) its tiers are set. */
export function providerUnavailable(provider: SupplyProviderName): string | null {
  if (!offeredProviders().includes(provider)) return `${provider} is not offered on this platform`;
  if (!supplyKeySet(provider)) return `${provider} is not available on this platform right now`;
  if (provider !== "anthropic" && Object.keys(supplyTiers(provider)).length === 0) return `${provider} is not set up on this platform yet`;
  return null;
}

/** The providers an account could choose now. */
export function availableProviders(): SupplyProviderName[] {
  return (Object.keys(SUPPLY_PROVIDERS) as SupplyProviderName[]).filter((p) => providerUnavailable(p) === null);
}

/** core platform.modelSupply: the runner's answer for one account. */
export function modelSupplyFor(tenant: string): SupplyAnswer {
  // Never read yet (the store would not answer at boot): which key this
  // account chose is unknown, so nothing runs as if it were "own" — the
  // account's stored key could be spent against its choice (Codex review).
  if (!snap && databaseEnabled()) return { kind: "refused", reason: "the platform could not read this account's model choice yet — try again in a minute" };
  const choice = modelChoiceOf(tenant);
  if (choice.source !== "foldrun" || !choice.provider) return { kind: "none" };
  const standing = supplyStanding(tenant);
  if (!standing.ok) return { kind: "refused", reason: standing.reason };
  const gone = providerUnavailable(choice.provider);
  if (gone) return { kind: "refused", reason: gone };
  const tiers = supplyTiers(choice.provider);
  // Each tier model's output ceiling from the price list, so the runner
  // tells the runtime its real limit up front (max_output_tokens).
  const ceilings: Record<string, number> = {};
  for (const id of Object.values(tiers)) {
    const max = id ? billing().modelPrice?.(choice.provider, id)?.maxOutputTokens : undefined;
    if (id && max) ceilings[id] = max;
  }
  return { kind: "foldrun", provider: choice.provider, tiers, ...(Object.keys(ceilings).length ? { ceilings } : {}) };
}

/** foldrun's models as an account sees them (GET /api/account/model):
 *  whether the platform offers them, whether this account may use them,
 *  each provider and why one is not available, the price list and the day's
 *  spend against the cap — the money in what the account pays (the margin
 *  applied). Never a key. */
export interface FoldrunModelsView {
  /** The platform offers foldrun's models at all: hosted, switched on, and
   *  at least one provider ready. */
  offered: boolean;
  /** Why this account cannot use them now, or null when it can. */
  refused: string | null;
  providers: { name: SupplyProviderName; title: string; available: boolean; reason: string | null; tiers: Partial<Record<"fast" | "default" | "max", string>> }[];
  prices: CustomerModelPrice[];
  /** The day's cap (UTC), in what the account pays; null: no cap. */
  dailyCapUsd: number | null;
  /** Spent today (UTC) on foldrun's models, in what the account pays. */
  spentTodayUsd: number;
}

export async function foldrunModelsView(tenant: string): Promise<FoldrunModelsView> {
  const hosted = edition() === "hosted";
  const providers = (Object.keys(SUPPLY_PROVIDERS) as SupplyProviderName[]).map((name) => {
    const reason = hosted ? providerUnavailable(name) : "foldrun's models are offered on foldrun's own platform only";
    return { name, title: SUPPLY_TITLES[name], available: reason === null, reason, tiers: reason === null ? supplyTiers(name) : {} };
  });
  const standing = supplyStanding(tenant);
  const offered = hosted && setting("models.supply.enabled") === true && providers.some((p) => p.available);
  const charge = (usd: number) => billing().modelChargeOf?.(usd) ?? usd;
  let spent = 0;
  try {
    spent = await spentToday(tenant);
  } catch {
    spent = 0;
  }
  return {
    offered,
    refused: !hosted ? "foldrun's models are offered on foldrun's own platform only" : standing.ok ? null : standing.reason,
    providers,
    prices: hosted ? (billing().modelPriceList?.() ?? []) : [],
    dailyCapUsd: standing.ok && standing.dailyUsd > 0 ? charge(standing.dailyUsd) : null,
    spentTodayUsd: charge(spent),
  };
}

/** Why the account may not choose foldrun's models for this provider now,
 *  or null when it may (PUT /api/account/model). A choice is not an
 *  entitlement — each call is still decided at the gateway — but choosing
 *  what cannot run would only fail every step. */
export function choiceRefused(tenant: string, provider: string): string | null {
  if (edition() !== "hosted") return "foldrun's models are offered on foldrun's own platform only";
  if (!isSupplyProvider(provider)) return `supply is one of ${Object.keys(SUPPLY_PROVIDERS).join(", ")}`;
  const standing = supplyStanding(tenant);
  if (!standing.ok) return standing.reason;
  return providerUnavailable(provider);
}

/** For tests: forget the snapshot. */
export function resetModelChoicesForTests(): void {
  snap = null;
  localWrites.clear();
  try {
    fs.rmSync(file(), { force: true });
  } catch {}
}
