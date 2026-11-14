// The one door between the open engine and foldrun's billing and operator
// tools.
//
// Billing — credits, the wallet, top-ups, plans, Stripe, dunning — and the
// operator's per-customer levers (a plan placed by hand, waived charges,
// an overdraft) are not part of the engine. They are foldrun's hosted
// business, and they will live in a private repository. Everything the open
// code needs from them goes through `billing()`, and nothing else in the
// open code imports them (tests/billing-boundary.test.ts holds that line).
//
// Two implementations answer:
//   - the hosted one (billing-hosted.ts), wired to the real modules, which
//     the hosted image carries;
//   - `freeBilling` below, for an install without them: no credit wallet, no
//     funds check, no plan. Spend budgets (`budget:`, which still hold a
//     run's expected share while it runs), what a run costs at list price,
//     pausing and the account's own `priority:` and `concurrency:` are the
//     engine's and work the same either way.
//
// Every method of the hosted one is a thin call into the module that owns
// it, so routing a call through here changes nothing about what it does.

import fs from "node:fs";
import path from "node:path";
import type { Db } from "./db.ts";
import { accountDir } from "../../foldrun-core/src/store.ts";
import { configMatter } from "../../foldrun-core/src/matter.ts";
import { readLedger, asMeter, micro, type RunMeter, type LedgerEntry } from "./ledger.ts";
import type { PriceSnapshot } from "../../foldrun-core/src/store.ts";
import { hosted } from "./billing-hosted.ts";
import type { ModelPrice } from "./model-gateway.ts";
import type { SignupOffer } from "./signup.ts";

/** The operator's plan for one customer, where one was placed. */
/** One model on foldrun's models' price list, as an account pays for it:
 *  USD per million tokens, the margin applied. Null: a cache price this
 *  model has none of. */
export interface CustomerModelPrice {
  provider: string;
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number | null;
  cacheWritePerMTok: number | null;
}

/** What the meters cost, in dollars, as the account is charged now (7 Nov
 *  2026, FOL-125). The hosted build reads them from its operator settings, so
 *  a page and the public catalogue show the number charging uses. */
export interface MeterRates {
  /** Dollars per credit (0.01). */
  creditUsd: number;
  vcpuUsdPerHour: number;
  ramUsdPerGibHour: number;
  /** Per GiB-month of step disk (the per-second hold, over a 30-day month). */
  diskUsdPerGibMonth: number;
  /** Per GB-month of stored files over the plan's allowance. */
  storageUsdPerGbMonth: number;
  networkUsdPerGb: number;
  /** The multiple on provider token prices on foldrun's models. */
  margin: number;
}

/** The two pots of an account's balance, USD (credits.ts). */
export interface CreditPots {
  planUsd: number;
  boughtUsd: number;
}

/** What a plan promises, as a customer or a public page reads it. The
 *  anti-abuse run cap is deliberately not here. */
export interface PlanTerms {
  id: string;
  name: string;
  feeUsd: number;
  creditsPerMonth: number;
  rollover: boolean;
  /** Most credits a rollover keeps: twice the monthly amount; 0 without. */
  rolloverCapCredits: number;
  storageGb: number;
  computeAtOnce: { vcpu: number; memGiB: number };
  lane: "normal" | "fast";
  /** Plan credits never pay for tokens on foldrun's models. */
  paysForTokens: false;
}

/** The account's credits as the Usage page shows them. */
export interface AccountCredits {
  pots: CreditPots;
  plan: (PlanTerms & { status: "active" | "past_due" | "cancelled" | null; resetsAt: string | null }) | null;
  /** When the oldest bought credit still unspent expires, if any. */
  boughtOldestExpiresAt: string | null;
}

/** The public catalogue: everything foldrun.io and foldrun.ir show. */
export interface PricingCatalogue {
  /** The operator-settings version the figures were read at. */
  version: number;
  creditUsd: number;
  plans: PlanTerms[];
  contact: { label: string };
  meters: { meter: "vcpu" | "ram" | "disk" | "storage" | "network"; unit: string; usd: number; over?: string }[];
  example: { name: string; vcpu: number; memGiB: number; creditsPerHour: number };
  models: { margin: number; providers: string[]; soon: string[]; prices: CustomerModelPrice[] };
}

export interface OperatorPlan {
  name?: string;
  priority?: "high" | "normal" | "low";
  concurrency?: number;
  workspaces?: number;
  /** Runs that may wait for their turn at once; a start past it is refused
   *  (limits.ts waitingRunsCap). Set per plan. */
  waitingRuns?: number;
  /** GB of stored files the plan includes; beyond it storage is charged by
   *  the GB-month. */
  storageGb?: number;
  /** Cores the account's running steps may hold together (limits.ts
   *  accountCompute; the room gate in pod-room.ts holds a step that would
   *  pass it until another finishes). */
  vcpu?: number;
  /** GiB of memory, the same way. */
  memGiB?: number;
  /** GiB of disk the same way (27 Oct 2026): the allowances (ephemeral-
   *  storage limits) its running steps may hold together. */
  diskGiB?: number;
  /** The most one step may hold — a step asking for more fails at once,
   *  naming the plan, since waiting could never make room for it. */
  stepVcpu?: number;
  stepMemGiB?: number;
  stepDiskGiB?: number;
}

/** Charges a customer does not pay, leg by leg. */
export interface OperatorWaive {
  compute?: boolean;
  models?: boolean;
  network?: boolean;
}

/** An account pod's session (search, browser) as it is charged: its life,
 *  its bytes, and the prices stamped on it when it was made. */
export interface PodSession {
  kind: string;
  podName: string;
  secs: number;
  netBytes: number;
  from: string;
  /** What the pod held while it lived (pod-sizes.ts): vCPU, GiB of memory,
   *  GiB of disk. The session is billed at these, seconds × each, at the
   *  same per-vCPU and per-GiB rates a step pays. Absent on a session from
   *  before 8 Nov 2026 that is replayed: it falls back to the flat rate. */
  vcpu?: number;
  memGiB?: number;
  diskGiB?: number;
  pricing?: PriceSnapshot | null;
}

/** What admission knows when it asks whether the money is there. */
export interface FundsHold {
  heldUsd: number;
  inFlight: number;
  expectedUsd: number;
  balance: number;
}

/** The subscription an account is on, as far as the open code needs it. */
export interface PlanStanding {
  id: string;
  status: "active" | "past_due" | "cancelled";
}

/** A run's price and its parts: the models, the platform under them, the
 *  wire. `totalUsd` is the charge. */
export interface PriceParts {
  totalUsd: number;
  modelUsd: number;
  computeUsd: number;
  networkUsd: number;
}

/** A quantity of usage, as the Usage page sums it. */
export interface UsageQuantity {
  tokenCostUsd: number;
  cpuSecs: number;
  gibSecs: number;
  /** GiB of disk allowed × seconds (27 Oct 2026). */
  diskGibSecs?: number;
  computeSecs: number;
}

/** The account's money as the account may see it (the Usage page's
 *  `ledger`): its balance and what it was charged. The platform's own
 *  accounting view of the same lines (cost, margin) is the operator's, and
 *  stays in foldrun-admin. */
export interface LedgerTotals {
  balanceUsd: number;
  chargedUsd: number;
}

/** Who a login gateway key's call is for. */
export interface LoginCaller {
  tenant: string;
  keyId: string;
  /** The key's size (GatewayGrant.plan); absent is "pro". */
  plan?: "pro" | "max";
}

/** What one reply used, as Anthropic reported it. */
export interface LoginUse {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** A key's share of the operator's Claude logins, per window: what it has
 *  used, what it may use (null: counted, not limited) and when the window
 *  ends. `used` and `share` are in the pool's own unit. */
export interface LoginShare {
  windows: { name: string; used: number; share: number | null; resetsAt: string }[];
}

/**
 * The operator's Claude logins behind login gateway keys (14 Nov 2026),
 * where an install has more than the one the gateway reads by itself
 * (gateway-door.ts loginToken): which login a call is sent on, what each
 * key and login used, and a key's share. Absent: the single login, nothing
 * counted, as before.
 */
export interface LoginPool {
  /** The login to send this call on, or the refusal to answer with. */
  pick(who: LoginCaller, model: string | null, now: Date): Promise<{ login: string; token: string } | { refuse: { status: number; message: string } }>;
  /** What came back: `usage` when the reply reported it, the provider's
   *  status, and its rate-limit headers (lower-cased names). */
  record(who: LoginCaller, call: { login: string; model: string | null; usage: LoginUse | null; status: number; headers: Record<string, string> }, now: Date): Promise<void>;
  /** The key's share now, for GET /v1/usage. Null: no share is kept. */
  shareOf(who: LoginCaller, now: Date): Promise<LoginShare | null>;
  /** Whether this account may use a login key for a reason of the pool's
   *  own (a plan it bought), beside the accounts the operator allows. */
  allows?(tenant: string): Promise<boolean>;
}

/** A one-time import the platform runs at boot (boot.ts importOnce). */
export interface BootImport {
  label: string;
  run: () => Promise<string | null>;
}

export interface Billing {
  /** True when this install charges for runs (FOLDRUN_BILLING=1). */
  enabled(): boolean;

  // ---- price
  /** The prices in force now, to stamp on a run as it is admitted (and on
   *  an account pod or an assistant job as it starts), so it is charged at
   *  what it started under (30 Oct 2026). null where nothing is priced. */
  priceSnapshot?(): PriceSnapshot | null;
  /** What a run's meter is charged, with any legs the operator waived, at
   *  the run's own snapshot when it has one (else the live prices).
   *  Pure and synchronous: core asks it for every run it lists. */
  price(meter: RunMeter | number, waive?: OperatorWaive | null, snapshot?: PriceSnapshot | null): PriceParts;
  /** One step's share of its run's charge, before normalising: what its
   *  tokens and seconds list at, without the per-run fee or floor. */
  stepWeight(tokenCostUsd: number, computeSecs: number, snapshot?: PriceSnapshot | null): number;
  /** What a quantity of usage lists at (no per-run fee or floor). */
  listPrice(q: UsageQuantity): { modelUsd: number; computeUsd: number };
  /** foldrun's models: one model's entry on the platform's price list
   *  (model-gateway.ts), or null where it has none — then the gateway
   *  refuses the call. Synchronous: the hosted build keeps the list in
   *  memory. Absent (an install without billing): nothing is priced, so
   *  nothing runs on the platform's keys. */
  modelPrice?(provider: string, model: string): ModelPrice | null;
  /** foldrun's models: charge the calls the model gateway recorded
   *  (model_usage) into the ledger — claimed under a key, one line per run
   *  or host job, idempotent, and claims whose line never landed written
   *  again. Run every few minutes under the housekeeping lease. Absent: an
   *  install that bills nothing has nothing to settle. */
  settleModelCalls?(): Promise<{ lines: number; calls: number }>;
  /** foldrun's models: the price list as an account pays it (the margin
   *  in force applied), for its Settings page and the API. Absent or empty:
   *  nothing is priced. */
  modelPriceList?(): CustomerModelPrice[];
  /** foldrun's models: what an amount at the price list is charged at now
   *  (today's spend and the daily cap, in what the account pays). */
  modelChargeOf?(costUsd: number): number;

  /** The operator's Claude logins as a pool (LoginPool). Absent or null:
   *  the gateway's single login. */
  loginPool?(): LoginPool | null;

  // ---- admission
  /** Throws when the account cannot pay for what is about to run. */
  assertFunds(tenant: string, hold?: number | FundsHold): Promise<void>;
  /** The account's credit balance in dollars; `on` is the open transaction. */
  balanceUsd(tenant: string, on?: Db): Promise<number>;
  /** The part of the balance that is BOUGHT credit (7 Nov 2026, FOL-125):
   *  what pays for tokens on foldrun's models — plan credit never does. It
   *  can be negative (a run finishing past zero). Absent: the install has
   *  one pot, and the total is what the gateway asks. */
  boughtBalanceUsd?(tenant: string): Promise<number>;
  /** The rates in force (see MeterRates). Absent: nothing is priced. */
  meterRates?(): MeterRates;
  /** The account's credits as the Usage page shows them. Absent: none. */
  accountCredits?(tenant: string): Promise<AccountCredits | null>;
  /** The public catalogue of plans and rates. Absent: nothing is sold. */
  catalogue?(): PricingCatalogue;

  /** What the account was charged and what it cost, from the ledger. */
  ledgerTotals(tenant: string): Promise<LedgerTotals>;

  // ---- the operator's levers on one customer
  plan(tenant: string): Promise<OperatorPlan | null>;
  /** The most one step may hold on an account whose plan says nothing of
   *  it — none placed yet, or one placed by hand without step figures
   *  (FOL-100, 5 Nov 2026). The hosted build answers the smallest plan's
   *  per-step maximum, so an account that has not chosen a plan cannot ask
   *  for a step no plan allows. Absent (an install without billing): no
   *  default — the install's FOLDRUN_STEP_MAX_* and the largest node
   *  (FOLDRUN_NODE_MAX_MEMORY_GIB) are the only limits. */
  stepMaxDefault?(): Pick<OperatorPlan, "stepVcpu" | "stepMemGiB" | "stepDiskGiB"> | null;
  waive(tenant: string): Promise<OperatorWaive | null>;
  planStanding(tenant: string): Promise<PlanStanding | null>;

  // ---- after a run's cost is written
  /** An account pod's session (search, browser) ended: its line on the
   *  ledger, once, or null when nothing is charged. */
  podSession(tenant: string, session: PodSession): Promise<LedgerEntry | null>;
  /** A charge landed (`usd` negative for a charge): the wallet may top up or
   *  warn now. Never throws. */
  afterCharge(tenant: string, charge: { usd: number } | null | false): Promise<unknown>;

  // ---- the worker's sweeps, under the housekeeping lease
  /** Hourly, per account: the wallet guard, dunning, plan renewal. Logs its
   *  own lines and returns the guard's outcome for the summary line ("" when
   *  the guard itself failed). */
  hourly(tenant: string): Promise<string>;
  /** Once a day, per account: the daily lines and expired credit. */
  daily(tenant: string, storageBytes: number): Promise<void>;
  /** One-time imports of billing files into the database. */
  bootImports(): BootImport[];

  // ---- what the dashboard and sign-up show
  /** Credits a new hosted account starts with; 0 where none are given. */
  trialCredits(): number;
  /** Give a new account its trial credit, once. */
  grantTrial(tenant: string): Promise<boolean>;
  /** Paid sign-up as the hosted business sees it (7 Nov 2026, the sign-up
   *  switches): signup.paid as the operator set it, why it cannot admit
   *  anyone now when it cannot (payments not ready, nothing purchasable, the
   *  paid flow not built), and the plans the catalogue marks purchasable,
   *  for the public. Synchronous: settings and the catalogue are in memory.
   *  Absent (an install without billing): there is no paid sign-up. */
  signupOffer?(): SignupOffer;
  /** Where mail about the account goes when no owner can be found: the
   *  wallet's warning address, else the account's `notify:` email. */
  contactEmail(tenant: string): Promise<string | null>;

  // ---- an account's end (28 Oct 2026)
  /** The owner asked to close the account: stop what would bill it again —
   *  a plan's renewal. What was done, for the record; throws when it could
   *  not be done (the close itself still stands). */
  accountClosing(tenant: string, by: string): Promise<{ subscription?: string; outcome: string }>;
  /** The account is being deleted: erase what billing keeps that names a
   *  person. The ledger stays (tenant-delete.ts says why). */
  accountDeleted(tenant: string): Promise<void>;
}

/** An install without foldrun's billing: nothing charged, nothing held. */
export const freeBilling: Billing = {
  enabled: () => false,
  // Without billing a run costs what its model tokens cost: no margin, no
  // fee, nothing for the machine it ran on — the install's own.
  price(meter, waive) {
    const m = asMeter(meter);
    const model = waive?.models || !(m.tokenCostUsd > 0) ? 0 : micro(m.tokenCostUsd);
    return { totalUsd: model, modelUsd: model, computeUsd: 0, networkUsd: 0 };
  },
  stepWeight: (tokenCostUsd) => tokenCostUsd,
  listPrice: (q) => ({ modelUsd: micro(q.tokenCostUsd), computeUsd: 0 }),
  assertFunds: async () => {},
  balanceUsd: async () => 0,
  // Without billing the ledger holds run costs at list price: what was
  // spent, nothing owed, no balance.
  async ledgerTotals(tenant) {
    let spent = 0;
    for (const e of await readLedger(tenant)) if (e.kind === "run") spent += -e.usd;
    const r = Math.round(spent * 1e6) / 1e6;
    return { balanceUsd: 0, chargedUsd: r };
  },
  plan: async () => null,
  waive: async () => null,
  planStanding: async () => null,
  afterCharge: async () => null,
  podSession: async () => null,
  hourly: async () => "off",
  daily: async () => {},
  bootImports: () => [],
  trialCredits: () => 0,
  grantTrial: async () => false,
  contactEmail: async (tenant) => accountNotifyEmail(tenant),
  accountClosing: async () => ({ outcome: "nothing billed here" }),
  accountDeleted: async () => {},
};

/** The email in the account AGENTS.md's `notify:`, if it names one. */
export function accountNotifyEmail(tenant: string): string | null {
  try {
    const raw = configMatter(fs.readFileSync(path.join(accountDir(tenant), "AGENTS.md"), "utf8")).data
      ?.notify as unknown;
    if (typeof raw === "string" && raw.includes("@") && !raw.includes("/")) return raw;
    if (raw && typeof raw === "object" && typeof (raw as { email?: string }).email === "string") {
      return (raw as { email: string }).email;
    }
  } catch {
    // no account AGENTS.md is normal
  }
  return null;
}

/** The billing this install carries: the hosted one where the image has it. */
export function billing(): Billing {
  return hosted ?? freeBilling;
}
