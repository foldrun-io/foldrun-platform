// What each account chose to run on — its own key, or foldrun's models for
// one provider — and what the platform says to that now (core
// platform.modelSupply, asked by the runner for every step).
//
// The choice is a record (account_model_choice), written in one validated
// write by PUT /v1/account/model only. Every pod keeps all of them in
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
import { SUPPLY_PROVIDERS, SUPPLY_TITLES, isSupplyProvider, providerOfModel, type SupplyAnswer, type SupplyProviderName } from "../../foldrun-core/src/model-supply.ts";
import { databaseEnabled, ormRequired } from "./db.ts";
import { accountModelChoice } from "./schema.ts";
import { SETTINGS_POLL_MS, platformKeyAllowedFor, setting, supplyStanding } from "./settings.ts";
import { accountModelBlock } from "../../foldrun-core/src/model-credential.ts";
import { getSecret } from "../../foldrun-core/src/secrets.ts";
import { offeredProviders } from "./model-gateway.ts";
import { MODEL_CONFIG_CHANNEL, RECONCILE_EVERY_TICKS, supplyKeySet } from "./model-keys.ts";
import { listen, listening } from "./pg-listen.ts";
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
  if (ownModelKeysOn() && accountModelBlock((n) => getSecret(tenant, n)?.value ?? null)) return false;
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

let unlisten: (() => void) | null = null;

/** Stop looking for changes (shutdown, tests). A later start begins again. */
export function stopModelChoices(): void {
  if (poll) clearInterval(poll);
  poll = null;
  unlisten?.();
  unlisten = null;
}

export async function startModelChoices(): Promise<void> {
  await Promise.all([loadModelChoices(), loadSubscribed()]);
  if (poll) return;
  // A choice is announced when it is written (model-keys.ts MODEL_CONFIG_CHANNEL);
  // while that is heard, the choices are only looked at now and then. Who holds
  // a plan is billing's, with no notice: it keeps its 10 s look.
  unlisten = listen(MODEL_CONFIG_CHANNEL, (what) => what === "choice" && void loadModelChoices(), { up: () => void loadModelChoices() });
  let tick = 0;
  poll = setInterval(() => {
    void loadSubscribed();
    if (!listening(MODEL_CONFIG_CHANNEL) || ++tick % RECONCILE_EVERY_TICKS === 0) void loadModelChoices();
  }, SETTINGS_POLL_MS);
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
    // Told to every pod at once; a missed notice is caught by the slow reconciliation look.
    await ormRequired().execute(sql`SELECT pg_notify(${MODEL_CONFIG_CHANNEL}, 'choice')`).catch((err) => opsError("model_choice.notice_not_sent", err));
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

/** The model a tier word stands for (`foldrun/fast`, `foldrun/default`,
 *  `foldrun/max`, what foldrun code asks for, 20 Nov 2026): the operator's
 *  `models.code.tiers`, else the Claude model of that tier as before. Null:
 *  not a tier word; "": a tier word that is not one of the three. */
const CODE_TIER_DEFAULTS = { fast: "claude-haiku-5-5", default: "claude-sonnet-5-5", max: "claude-opus-5-5" } as const;
export function codeTierModel(named: string): string | null {
  if (!named.toLowerCase().startsWith("foldrun/")) return null;
  const tier = named.slice("foldrun/".length).toLowerCase();
  if (tier !== "fast" && tier !== "default" && tier !== "max") return "";
  for (const part of String(setting("models.code.tiers") ?? "").split(",")) {
    const [k, v] = part.split("=").map((x) => x?.trim());
    if (k === tier && v) return v;
  }
  return CODE_TIER_DEFAULTS[tier];
}

// One list of provider names and model prefixes for the gateway and a
// step's own model: (core model-supply.ts, 23 Nov 2026).
export { PROVIDER_ALIASES, providerOfModel } from "../../foldrun-core/src/model-supply.ts";

/** The provider and model a foldrun code tier is served by, or null. */
export function codeTierServedBy(tier: "fast" | "default" | "max"): { provider: SupplyProviderName; model: string } | null {
  const v = codeTierModel(`foldrun/${tier}`);
  return v ? providerOfModel(v) : null;
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

/** May accounts bring their own model key or endpoint here (models.byok)?
 *  Off — the default (owner, 22 Nov 2026) — "own" is no choice: a stored
 *  key is never read, and an account that has not chosen a provider runs
 *  on the default one. */
export function ownModelKeysOn(): boolean {
  return setting("models.byok") === true;
}

/** The provider an account runs on when own keys are off and it chose none:
 *  the plan's default provider, else the first foldrun's models offers. */
function forcedProvider(): SupplyProviderName | null {
  const named = String(setting("models.supply.default_provider.plan") ?? "").trim();
  if (named && isSupplyProvider(named) && providerUnavailable(named) === null) return named;
  return availableProviders()[0] ?? null;
}

/** core platform.modelSupply: the runner's answer for one account — and,
 *  with `want`, for the provider a step's `model:` names outright (23 Nov
 *  2026: any model behind foldrun's proxy, on one subscription). `want` is
 *  answered only for an account that runs on foldrun's models at all, on
 *  the same terms as a chosen provider: its standing, the provider
 *  offered; Claude on the account's subscription stays on its login. */
export function modelSupplyFor(tenant: string, want?: { provider: SupplyProviderName; model?: string }): SupplyAnswer {
  const base = accountSupply(tenant);
  if (!want || !isSupplyProvider(want.provider)) return base;
  if (base.kind === "none") return base;
  if (base.kind === "refused") {
    // The account chose foldrun's models and its own provider cannot be
    // had now: a step naming another, available one still runs on it — the
    // account's standing is asked again in supplyAnswer (Codex review). Not
    // before the choices are read, and not for an account that never chose.
    const chosen = modelChoiceOf(tenant);
    if ((!snap && databaseEnabled()) || chosen.source !== "foldrun" || !chosen.provider) return base;
    return supplyAnswer(tenant, want.provider, want.model);
  }
  // Claude on the account's subscription stays on its login.
  if (base.via === "login" && want.provider === "anthropic") return base;
  if (want.provider === "anthropic" && onSubscription(tenant)) return { kind: "foldrun", provider: "anthropic", tiers: {}, via: "login" };
  // The same provider too: the answer then carries the named model's own
  // output ceiling, which a tier map may not hold (Codex review).
  return supplyAnswer(tenant, want.provider, want.model);
}

/**
 * How one account's call to `provider` is served (owner, 23 Nov 2026: "one
 * door for everything, local or in cloud" — what is behind the LLM proxy is
 * the proxy's business). The runner's decision for a step with no written
 * provider: block (core runner.ts agentContext), in one place, so the API
 * door serves a call from a computer exactly as the account's cloud step is
 * served:
 * - `supply`: foldrun's models on the platform's provider key, metered;
 * - `login`: Claude on the account's subscription (the login pool);
 * - `own`: the account's own key (Settings → Models), where BYOK is on;
 * - `operator`: the operator's own model credential (the console's "may use
 *   the platform key" lever), unmetered, as its steps run;
 * - `refused`: with the reason a step would fail with.
 */
export type AccountRoute =
  | { kind: "supply"; provider: SupplyProviderName }
  | { kind: "login" }
  | { kind: "own" }
  | { kind: "operator" }
  | { kind: "refused"; reason: string };

export function accountRoute(tenant: string, want?: { provider: SupplyProviderName; model?: string }): AccountRoute {
  const answer = modelSupplyFor(tenant, want);
  if (answer.kind === "foldrun") return answer.via === "login" ? { kind: "login" } : { kind: "supply", provider: answer.provider };
  if (answer.kind === "refused") return { kind: "refused", reason: answer.reason };
  // Not on foldrun's models: the account's stored key where own keys are on,
  // else the operator's credential where the account may use it — the order
  // the runner takes them in.
  if (ownModelKeysOn() && accountModelBlock((n) => getSecret(tenant, n)?.value ?? null)) return { kind: "own" };
  if (platformKeyAllowedFor(tenant, edition() === "hosted")) return { kind: "operator" };
  // Own keys off: there is no key to add. Say what the account can do.
  if (!ownModelKeysOn()) return { kind: "refused", reason: "this account has no plan — pick one in Billing → Plans" };
  return { kind: "refused", reason: "this account has no model key — add one in Settings → Models, or choose foldrun's models there" };
}

function accountSupply(tenant: string): SupplyAnswer {
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
  // Own keys off: an account that chose no provider runs on the default
  // one, unless it is one the operator runs on the platform's credential.
  if (!ownModelKeysOn() && (chosen.source !== "foldrun" || !chosen.provider)) {
    if (platformKeyAllowedFor(tenant, true)) return { kind: "none" };
    const forced = forcedProvider();
    if (!forced) return { kind: "refused", reason: "no model provider is available on this platform right now — try again later" };
    return supplyAnswer(tenant, forced);
  }
  const byDefault = chosen.source !== "foldrun" || !chosen.provider ? defaultSupplyProvider(tenant) : null;
  const choice = byDefault ? { ...chosen, source: "foldrun" as const, provider: byDefault } : chosen;
  if (choice.source !== "foldrun" || !choice.provider) return { kind: "none" };
  return supplyAnswer(tenant, choice.provider);
}

/** The answer for one provider: refused when the account or the provider
 *  cannot have it now, else the provider's tiers and their ceilings. */
function supplyAnswer(tenant: string, provider: SupplyProviderName, model?: string): SupplyAnswer {
  const standing = supplyStanding(tenant);
  if (!standing.ok) return { kind: "refused", reason: standing.reason };
  const gone = providerUnavailable(provider);
  if (gone) return { kind: "refused", reason: gone };
  const choice = { provider };
  const tiers = supplyTiers(choice.provider);
  // Each tier model's output ceiling from the price list, so the runner
  // tells the runtime its real limit up front (max_output_tokens).
  const ceilings: Record<string, number> = {};
  for (const id of [...Object.values(tiers), ...(model ? [model] : [])]) {
    const max = id ? billing().modelPrice?.(choice.provider, id)?.maxOutputTokens : undefined;
    if (id && max) ceilings[id] = max;
  }
  return { kind: "foldrun", provider: choice.provider, tiers, ...(Object.keys(ceilings).length ? { ceilings } : {}) };
}

/** foldrun's models as an account sees them (GET /v1/account/model):
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
  /** Every model behind foldrun's proxy (23 Nov 2026, `/model`): the price
   *  list's models, each as `provider/model` — what a `model:` or a gateway
   *  call names to run on it — whether its provider can be had now, and
   *  whether THIS account's subscription pays for it now (a live plan, the
   *  provider covered, not Fable on Pro). */
  catalog: CatalogModel[];
  /** What foldrun code's tier words run on (models.code.tiers): fast,
   *  default and max, each a catalogue id; a tier left unset is absent. */
  codeTiers: Partial<Record<"fast" | "default" | "max", { id: string; provider: SupplyProviderName; model: string }>>;
}

export interface CatalogModel {
  id: string;
  provider: SupplyProviderName;
  providerTitle: string;
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number | null;
  cacheWritePerMTok: number | null;
  /** On the account's cloud steps (a subscriber's Claude goes on its logins). */
  available: boolean;
  covered: boolean;
  /** Through foldrun's API with an account key — `foldrun code` on a
   *  computer, your own programs: the provider's key, plan cover by provider. */
  api: { available: boolean; covered: boolean };
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
  const prices = hosted ? (billing().modelPriceList?.() ?? []) : [];
  // Through the API a model is named outright: offered and its key here is
  // enough, no tier map (Codex review, round 5).
  const apiReady = new Set(hosted ? offeredProviders().filter((p) => supplyKeySet(p)) : []);
  const ready = new Set(providers.filter((p) => p.available).map((p) => p.name));
  // Claude on the account's subscription is served by the login pool on its
  // cloud steps, with or without an Anthropic API key here (Codex review,
  // round 2); a call through the API uses the key (round 4).
  if (hosted && onSubscription(tenant)) ready.add("anthropic");
  const coveredOf = billing().coveredModel;
  const coverOf = (via: "steps" | "api") =>
    Promise.all(prices.map((p) => (coveredOf && isSupplyProvider(p.provider) ? coveredOf(tenant, p.provider, p.model, via).catch(() => false) : Promise.resolve(false))));
  const [covers, apiCovers] = await Promise.all([coverOf("steps"), coverOf("api")]);
  const catalog: CatalogModel[] = prices.flatMap((p, i) => {
    if (!isSupplyProvider(p.provider)) return [];
    return [{
      id: `${p.provider}/${p.model}`,
      provider: p.provider,
      providerTitle: SUPPLY_TITLES[p.provider],
      model: p.model,
      inputPerMTok: p.inputPerMTok,
      outputPerMTok: p.outputPerMTok,
      cacheReadPerMTok: p.cacheReadPerMTok,
      cacheWritePerMTok: p.cacheWritePerMTok,
      available: ready.has(p.provider),
      covered: covers[i] ?? false,
      api: { available: apiReady.has(p.provider), covered: apiCovers[i] ?? false },
    }];
  });
  const codeTiers: FoldrunModelsView["codeTiers"] = {};
  if (hosted) {
    for (const tier of ["fast", "default", "max"] as const) {
      const r = codeTierServedBy(tier);
      if (r) codeTiers[tier] = { id: `${r.provider}/${r.model}`, provider: r.provider, model: r.model };
    }
  }
  return {
    offered,
    refused: !hosted ? "foldrun's models are offered on foldrun's own platform only" : standing.ok ? null : standing.reason,
    providers,
    prices,
    catalog,
    codeTiers,
    dailyCapUsd: standing.ok && standing.dailyUsd > 0 ? charge(standing.dailyUsd) : null,
    spentTodayUsd: charge(spent),
  };
}

/** Why the account may not choose foldrun's models for this provider now,
 *  or null when it may (PUT /v1/account/model). A choice is not an
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
