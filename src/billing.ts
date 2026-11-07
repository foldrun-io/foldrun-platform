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

export interface OperatorPlan {
  name?: string;
  priority?: "high" | "normal" | "low";
  concurrency?: number;
  workspaces?: number;
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
  small?: boolean;
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

  // ---- admission
  /** Throws when the account cannot pay for what is about to run. */
  assertFunds(tenant: string, hold?: number | FundsHold): Promise<void>;
  /** The account's credit balance in dollars; `on` is the open transaction. */
  balanceUsd(tenant: string, on?: Db): Promise<number>;

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
