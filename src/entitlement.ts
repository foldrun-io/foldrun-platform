// The one decision on whether an account may start new paid work (23 Nov
// 2026, SUBSCRIPTION-BILLING-PLAN.md).
//
// A hosted account needs an active subscription — Pro or Max — for every
// kind of new paid work: a direct model call, foldrun code on this computer
// or in the cloud, a cloud agent, a scheduled or hooked automation, and the
// compute under any of them. A positive balance alone no longer authorises
// any of it: the balance is extra usage, spent only past the allowance and
// only when the account turned that on.
//
// Asked at every door before anything costs money:
//   - a run's admission (reservations.ts), whoever starts it;
//   - a queued run again at dispatch (queue.ts), before compute is taken —
//     a schedule fired while the plan was live may be claimed after it ended;
//   - every model call (model-gateway.ts admitCall), before the provider;
//   - the assistant and flow drafting, before the platform's models.
//
// Never asked for what keeps an account whole: signing in, billing (buying
// the subscription itself), history, cancelling, deleting, and cleanup.
//
// A self-hosted install (no billing) is exempt, and so is an account the
// operator charges nothing. A billing state that cannot be read is said as
// that — a 503 to try again — never as "no subscription" and never as room.

import { billing, type Entitlement } from "./billing.ts";

export type { Entitlement };

/** What a program branches on, beside the sentence. */
export const SUBSCRIPTION_REQUIRED = "subscription_required";
export const BILLING_UNREADABLE = "billing_unreadable";

export const SUBSCRIPTION_REQUIRED_MESSAGE =
  "this account has no active foldrun subscription — choose Pro or Max under Billing → Plans (or `foldrun billing plan pro`) to start new work; your balance, billing and history stay as they are";
export const BILLING_UNREADABLE_MESSAGE = "this account's subscription could not be read just now — nothing was started or charged; try again in a moment";

/** A refusal before any work or money: an HTTP status and a code. */
export class BillingRefusal extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "BillingRefusal";
    this.status = status;
    this.code = code;
  }
}

/** The account's standing now. A build without billing, or with billing off,
 *  is exempt; a throw from the billing module reads as unreadable. */
let forTests: ((tenant: string) => Entitlement | Promise<Entitlement>) | null = null;
/** For tests: answer every account's entitlement (null: the billing's own). */
export function setEntitlementForTests(fn: ((tenant: string) => Entitlement | Promise<Entitlement>) | null): void {
  forTests = fn;
}

export async function entitlementOf(tenant: string, opts: { fresh?: boolean } = {}): Promise<Entitlement> {
  const b = billing();
  if (forTests && b.enabled()) return forTests(tenant);
  if (!b.enabled() || !b.entitlement) return { kind: "exempt", reason: "self-hosted" };
  try {
    return await b.entitlement(tenant, opts);
  } catch {
    return { kind: "unreadable" };
  }
}

/** The refusal an entitlement gives new paid work, or null when it may go. */
export function refusalOf(e: Entitlement): BillingRefusal | null {
  if (e.kind === "none") return new BillingRefusal(SUBSCRIPTION_REQUIRED_MESSAGE, 402, SUBSCRIPTION_REQUIRED);
  if (e.kind === "unreadable") return new BillingRefusal(BILLING_UNREADABLE_MESSAGE, 503, BILLING_UNREADABLE);
  return null;
}

/** Refuse new paid work for an account without a subscription. Fresh by
 *  default: admission must see a plan that ended a second ago. */
export async function requireSubscription(tenant: string, opts: { fresh?: boolean } = { fresh: true }): Promise<Entitlement> {
  const e = await entitlementOf(tenant, opts);
  const refused = refusalOf(e);
  if (refused) throw refused;
  return e;
}

/**
 * A queued run, again, as a worker is about to take compute for it: the
 * subscription may have ended, the allowance filled or extra usage reached
 * its limit since it was admitted — a schedule fired on Monday and claimed
 * after the plan ended must not start on Tuesday. Null: it may start.
 * "retry": the billing state could not be read; the run waits its turn
 * again rather than starting or failing.
 */
export async function dispatchRefusal(tenant: string): Promise<BillingRefusal | "retry" | null> {
  const b = billing();
  if (!b.enabled()) return null;
  const e = await entitlementOf(tenant, { fresh: true });
  if (e.kind === "unreadable") return "retry";
  if (e.kind === "none") return refusalOf(e);
  if (e.kind !== "active") return null;
  let cover;
  try {
    cover = (await b.computeCover?.(tenant)) ?? null;
  } catch {
    return "retry";
  }
  if (cover?.kind === "unreadable") return "retry";
  if (cover?.kind === "refused") return new BillingRefusal(cover.message, 402, "allowance_used");
  // A wallet-only account (FOL-385): its switch, its limit and its money,
  // again — a refund or a switch turned off since admission stops it here.
  if (e.source === "wallet") {
    try {
      const over = await b.extraUsageRoom?.(tenant, 0, { wallet: true });
      return over ? new BillingRefusal(over.message, over.status, over.code) : null;
    } catch {
      return "retry";
    }
  }
  if (cover?.kind === "wallet") {
    // Extra usage: its limit with what is already held (this run's share
    // among it) — nothing more is added at dispatch.
    const over = await b.extraUsageRoom?.(tenant, 0);
    if (over) return new BillingRefusal(over.message, over.status, over.code);
  }
  return null;
}
