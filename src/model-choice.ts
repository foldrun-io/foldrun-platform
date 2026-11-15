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

import { opsError } from "../../foldrun-core/src/ops-log.ts";
import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { SUPPLY_PROVIDERS, SUPPLY_TITLES, isSupplyProvider, type SupplyAnswer, type SupplyProviderName } from "../../foldrun-core/src/model-supply.ts";
import { databaseEnabled, ormRequired } from "./db.ts";
import { accountModelChoice } from "./schema.ts";
import { SETTINGS_POLL_MS, platformKeyAllowedFor, setting, supplyStanding } from "./settings.ts";
import { accountModelBlock } from "../../foldrun-core/src/model-credential.ts";
import { getSecret } from "../../foldrun-core/src/secrets.ts";
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
    opsError("model_choice.unreadable", err, { outcome: "kept_last" });
  }
}

// ------------------------------------------------- the Claude subscription

/** The accounts holding a live plan (billing().livePlanTenants), read with
 *  the choices; null until the first read. */
let subscribed: Set<string> | null = null;

async function loadSubscribed(): Promise<void> {
  const b = billing();
  // Only where the platform keeps a pool of Claude logins to send them on.
  if (!b.enabled() || !b.livePlanTenants || !b.loginPool?.()) {
    subscribed = new Set();
    return;
  }
  try {
    subscribed = new Set(await b.livePlanTenants());
  } catch (err) {
    // The last reading stands: the egress proxy asks the plan again on
    // every call, so a stale yes costs a refused call, never a free one.
    opsError("model_choice.plans_unreadable", err, { outcome: "kept_last" });
  }
}

/**
 * Does this account run on its Claude subscription (16 Nov 2026, owner: "they
 * can use claude tokens using their subscription")? An account holding a
 * live Claude Code plan runs its routines and sessions on Claude, counted in
 * the plan's monthly and weekly windows like its Claude Code calls — unless it
 * brought a key of its own or chose foldrun's models for a provider (both
 * stand), or it is one the operator runs on the platform's own credential.
 * Only where the platform keeps a pool of Claude logins (loadSubscribed).
 */
export function onSubscription(tenant: string): boolean {
  if (edition() !== "hosted") return false;
  if (!subscribed?.has(tenant)) return false;
  const chosen = modelChoiceOf(tenant);
  if (chosen.source === "foldrun" && chosen.provider) return false;
  if (accountModelBlock((n) => getSecret(tenant, n)?.value ?? null)) return false;
  return !platformKeyAllowedFor(tenant, true);
}

/** The same, with the plan read now: for a person's screen right after a
 *  purchase, which must not wait for the next poll. */
export async function onSubscriptionNow(tenant: string): Promise<boolean> {
  const b = billing();
  if (b.enabled() && b.livePlan && b.loginPool?.()) {
    const live = await b.livePlan(tenant).catch(() => null);
    subscribed ??= new Set();
    if (live) subscribed.add(tenant);
    else subscribed.delete(tenant);
  }
  return onSubscription(tenant);
}

/** Tests: who holds a plan (null: read it from billing). */
export function setSubscribedForTests(tenants: string[] | null): void {
  subscribed = tenants ? new Set(tenants) : null;
}

export async function startModelChoices(): Promise<void> {
  await Promise.all([loadModelChoices(), loadSubscribed()]);
  if (poll) return;
  poll = setInterval(() => void Promise.all([loadModelChoices(), loadSubscribed()]), SETTINGS_POLL_MS);
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

const FUNDS_EVERY_MS = 15_000;
const FUNDS_STALE_MS = 60_000;
const FUNDS_WATCH_MS = 30 * 60_000;
interface Funds { usd: number | null; plan: string | null; covered?: boolean }
const funds = new Map<string, Funds & { at: number; asked: number; reading: boolean }>();
let fundsReader: ((tenant: string) => Promise<Funds>) | null = null;
let fundsTimer: ReturnType<typeof setInterval> | null = null;

/** The bought credit an account holds (null where nothing is billed) and
 *  the plan it holds now (null: none). */
async function readFunds(tenant: string): Promise<Funds> {
  if (fundsReader) return fundsReader(tenant);
  const b = billing();
  if (!b.enabled()) return { usd: null, plan: null };
  const name = String(setting("models.supply.default_provider.plan") ?? "").trim();
  const [usd, plan, cover] = await Promise.all([b.boughtBalanceUsd ? b.boughtBalanceUsd(tenant) : b.balanceUsd(tenant), b.livePlan?.(tenant) ?? null, (name && b.planCover?.(tenant, name)) || null]);
  return { usd, plan, covered: cover?.kind === "covered" };
}

function refreshFunds(tenant: string): void {
  const entry = funds.get(tenant);
  if (!entry || entry.reading) return;
  entry.reading = true;
  void readFunds(tenant)
    .then((f) => Object.assign(entry, { at: Date.now(), usd: f.usd, plan: f.plan, covered: f.covered === true, reading: false }))
    // Unknown is a no: the last reading is not kept past a failed one.
    .catch(() => Object.assign(entry, { at: 0, usd: 0, plan: null, covered: false, reading: false }));
}

/** Does this account hold a plan, and can it pay for metered calls? The runner asks without waiting
 *  (modelSupplyFor is synchronous), so this answers from a reading kept
 *  fresh in the background: an account that was asked about is re-read
 *  every 15 seconds for half an hour after its last ask. Never read yet,
 *  the read failed, or the reading is over a minute old: false — the
 *  account runs as it did before until it is known. What is left is the
 *  few seconds between the credit running out and the next reading; a call
 *  in them is refused by the gateway (402), as for an account that chose
 *  foldrun's models, and the next step is back on the old credential. */
function planWithFunds(tenant: string): boolean {
  const now = Date.now();
  let entry = funds.get(tenant);
  if (!entry) {
    entry = { at: 0, usd: 0, plan: null, asked: now, reading: false };
    funds.set(tenant, entry);
    refreshFunds(tenant);
  }
  entry.asked = now;
  if (!fundsTimer) {
    fundsTimer = setInterval(() => {
      for (const [t, e] of funds) {
        if (Date.now() - e.asked > FUNDS_WATCH_MS) funds.delete(t);
        else refreshFunds(t);
      }
      if (funds.size === 0 && fundsTimer) {
        clearInterval(fundsTimer);
        fundsTimer = null;
      }
    }, FUNDS_EVERY_MS);
    fundsTimer.unref?.();
  }
  if (now - entry.at > FUNDS_STALE_MS) {
    refreshFunds(tenant);
    return false;
  }
  // null is an install that bills nothing: the gateway does not offer
  // foldrun's models there at all (standingOf, 403), so that is a no too.
  // Paid by the plan's allowance while it has room, else by bought credit.
  return entry.plan !== null && entry.usd !== null && (entry.covered === true || entry.usd > 0);
}

/** Tests: the reading itself, and wait for it. null puts the real one back. */
export async function setSupplyFundsForTests(reader: ((tenant: string) => Promise<Funds>) | null, tenant?: string): Promise<void> {
  fundsReader = reader;
  funds.clear();
  if (fundsTimer) clearInterval(fundsTimer);
  fundsTimer = null;
  if (tenant) funds.set(tenant, { ...(await readFunds(tenant)), at: Date.now(), asked: Date.now(), reading: false });
}

/** The provider an account runs on without having chosen (15 Nov 2026,
 *  setting models.supply.default_provider.plan), or null. Only an account
 *  with a live plan, holding no model key of its own, and with no choice on
 *  record — a written "own" is a choice and is left alone. And only while
 *  the provider can be had: a default is not a choice, so where it cannot
 *  (no key, no tiers, foldrun's models off or refused to this account, no
 *  bought credit to pay for a call) the account runs as it did before, and
 *  is not refused. */
export function defaultSupplyProvider(tenant: string): SupplyProviderName | null {
  const name = String(setting("models.supply.default_provider.plan") ?? "").trim();
  if (!name || !isSupplyProvider(name)) return null;
  if (modelChoiceOf(tenant).version !== 0) return null;
  if (accountModelBlock((n) => getSecret(tenant, n)?.value ?? null)) return null;
  if (!supplyStanding(tenant).ok || providerUnavailable(name) !== null) return null;
  // Metered calls are paid from bought credit, and one with none is refused
  // (model-gateway admitCall, 402). An account with nothing to pay with is
  // not moved onto them: it keeps running as before (Codex review).
  if (!planWithFunds(tenant)) return null;
  return name;
}

/** core platform.modelSupply: the runner's answer for one account. */
export function modelSupplyFor(tenant: string): SupplyAnswer {
  // Never read yet (the store would not answer at boot): which key this
  // account chose is unknown, so nothing runs as if it were "own" — the
  // account's stored key could be spent against its choice (Codex review).
  if (!snap && databaseEnabled()) return { kind: "refused", reason: "the platform could not read this account's model choice yet — try again in a minute" };
  const chosen = modelChoiceOf(tenant);
  // The account's Claude subscription: on a login, never the platform's
  // API key, and not metered — the egress proxy sends it through the
  // gateway's login path (SupplyGrant.via "login"), which asks the plan
  // again and counts the call in the plan's windows.
  if (onSubscription(tenant)) return { kind: "foldrun", provider: "anthropic", tiers: {}, via: "login" };
  const byDefault = chosen.source !== "foldrun" || !chosen.provider ? defaultSupplyProvider(tenant) : null;
  const choice = byDefault ? { ...chosen, source: "foldrun" as const, provider: byDefault } : chosen;
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
  subscribed = null;
  localWrites.clear();
  try {
    fs.rmSync(file(), { force: true });
  } catch {}
}
