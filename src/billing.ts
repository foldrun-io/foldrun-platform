// The one door between the open engine and foldrun's billing and operator
// tools.
//
// Billing — credits, the wallet, top-ups, plans, Stripe, dunning — and the
// super admin's per-customer levers (a plan placed by hand, waived charges,
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
import { readLedger, asMeter, micro, type RunMeter } from "./ledger.ts";
import { hosted } from "./billing-hosted.ts";

/** The operator's plan for one customer, where one was placed. */
export interface OperatorPlan {
  name?: string;
  priority?: "high" | "normal" | "low";
  concurrency?: number;
  workspaces?: number;
}

/** Charges a customer does not pay, leg by leg. */
export interface OperatorWaive {
  compute?: boolean;
  models?: boolean;
  network?: boolean;
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

/** The wallet as the dashboard's home page shows it. */
export interface WalletGlance {
  balanceUsd: number;
  /** Below this the customer is warned. */
  warnBelowUsd: number;
  /** Days until empty at the current burn; null when nothing is burning. */
  daysLeft: number | null;
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
  computeSecs: number;
}

/** The account's money in one shape (the Usage page's `ledger`). */
export interface LedgerTotals {
  balanceUsd: number;
  chargedUsd: number;
  providerCostUsd: number;
  marginUsd: number;
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
  /** What a run's meter is charged, with any legs the operator waived.
   *  Pure and synchronous: core asks it for every run it lists. */
  price(meter: RunMeter | number, waive?: OperatorWaive | null): PriceParts;
  /** One step's share of its run's charge, before normalising: what its
   *  tokens and seconds list at, without the per-run fee or floor. */
  stepWeight(tokenCostUsd: number, computeSecs: number): number;
  /** What a quantity of usage lists at (no per-run fee or floor). */
  listPrice(q: UsageQuantity): { modelUsd: number; computeUsd: number };

  // ---- admission
  /** Throws when the account cannot pay for what is about to run. */
  assertFunds(tenant: string, hold?: number | FundsHold): Promise<void>;
  /** The account's credit balance in dollars; `on` is the open transaction. */
  balanceUsd(tenant: string, on?: Db): Promise<number>;

  /** What the account was charged and what it cost, from the ledger. */
  ledgerTotals(tenant: string): Promise<LedgerTotals>;

  // ---- the operator's levers on one customer
  plan(tenant: string): Promise<OperatorPlan | null>;
  waive(tenant: string): Promise<OperatorWaive | null>;
  planStanding(tenant: string): Promise<PlanStanding | null>;

  // ---- after a run's cost is written
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
  wallet(tenant: string): Promise<WalletGlance | null>;
  /** True when nothing is left for the customer to set up to pay: a card
   *  saved or a plan chosen — or, without billing, nothing to set up. The
   *  onboarding list asks only on a hosted install. */
  paymentSetUp(tenant: string): Promise<boolean>;
  /** Credits a new hosted account starts with; 0 where none are given. */
  trialCredits(): number;
  /** Give a new account its trial credit, once. */
  grantTrial(tenant: string): Promise<boolean>;
  /** A super admin's view-as grant that is still live, for a session that
   *  claims one; null when it ended, lapsed or never existed. */
  liveSupportView(tenant: string, id: string): Promise<{ id: string; by: string; reason: string; expiresAt: string } | null>;
  /** End a super admin's view-as session, on logout: true when one ended. */
  endSupportView(tenant: string, id: string, by: string): Promise<boolean>;
  /** Where mail about the account goes when no owner can be found: the
   *  wallet's warning address, else the account's `notify:` email. */
  contactEmail(tenant: string): Promise<string | null>;
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
  // spent, nothing owed, no balance and no margin.
  async ledgerTotals(tenant) {
    let spent = 0;
    for (const e of await readLedger(tenant)) if (e.kind === "run") spent += -e.usd;
    const r = Math.round(spent * 1e6) / 1e6;
    return { balanceUsd: 0, chargedUsd: r, providerCostUsd: r, marginUsd: 0 };
  },
  plan: async () => null,
  waive: async () => null,
  planStanding: async () => null,
  afterCharge: async () => null,
  hourly: async () => "off",
  daily: async () => {},
  bootImports: () => [],
  wallet: async () => null,
  paymentSetUp: async () => true,
  trialCredits: () => 0,
  grantTrial: async () => false,
  liveSupportView: async () => null,
  endSupportView: async () => false,
  contactEmail: async (tenant) => accountNotifyEmail(tenant),
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
