// Whether a signup may proceed, by which door, and in what order the
// question is asked.
//
// The order is the security property. It used to be: is this email taken? …
// then, is signup even open? On an install with signups CLOSED — the default,
// and what a personal install runs — that made the form an address oracle. A
// registered email answered "an account with that email already exists"; an
// unknown one answered "signups are closed on this install". Two different
// sentences from a door that is shut either way, so anyone could work through
// a list of addresses and learn which belonged to customers, without ever
// being able to create an account.
//
// So: decide whether signup is possible AT ALL before asking anything that
// depends on the particular address. A closed install now gives every address
// the same refusal, and there is nothing to learn by asking.
//
// The doors (7 Nov 2026, the sign-up switches). A new account comes in by
// exactly one of them, and the one it came by is recorded on its owner
// (`Admission`) — what it is owed later (the trial credit) is read from that
// record, never from whatever the switches say on the day it is asked:
//
//   bootstrap  the install's first account: there is nobody to ask. Its own
//              capability — never advertised as free sign-up, and decided
//              from the users read under the lock, so two first sign-ups at
//              once make one owner.
//   free       signup.open (FOLDRUN_OPEN_SIGNUP): strangers may open an
//              account without paying.
//   paid       signup.paid (hosted only): strangers may open an account by
//              choosing a plan. Effective only where the hosted business says
//              payments are ready and its paid flow exists (billing().
//              signupOffer); until then it admits nobody.
//   invite     a member chose to let this person in: no switch applies.
//   operator   the hosted operator made the account (foldrun-admin).
//
// Being shown a way in and being let in are different questions:
// `signupModes` answers both — what each switch says, effectively — but only
// `assertSignupAllowed`, with the door asked for, lets anyone in. There is no
// "free or paid" anywhere that admits.
//
// This lives in core rather than beside the users file for the reason
// ownership.ts gives: web/server imports through a bundler alias and cannot be
// loaded by a test runner, and a security rule that cannot be unit-tested is
// one a refactor breaks quietly.

/** The door an account came in by, recorded on its first member. */
export type Admission = "bootstrap" | "free" | "paid" | "invite" | "operator";

/** What a stranger's sign-up asks for: an account without paying, or one on
 *  a plan (Part B, FOL-125 — no route asks for it yet). */
export type SignupRequest = "free" | "paid";

export const SIGNUP_REQUESTS: readonly SignupRequest[] = ["free", "paid"];

/** A plan as the public may see it before signing up (GET /api/signup):
 *  only plans the billing catalogue marks purchasable. Amounts in the
 *  currency's minor units. */
export interface PublicPlan {
  id: string;
  name: string;
  price: { amount: number; currency: string; interval: "month" | "year" };
  credits: number;
  /** Storage included, GB; null where the catalogue does not say. */
  storageGb: number | null;
  vcpu: number;
  memoryGiB: number;
  /** The high-priority lane. */
  priority: boolean;
}

/** What the hosted business says about paid sign-up (billing().signupOffer):
 *  the switch as configured, why it cannot admit anyone when it cannot, and
 *  the plans it would sell. Absent on an install without billing. */
export interface SignupOffer {
  /** signup.paid (FOLDRUN_PAID_SIGNUP), as the operator set it. */
  paidConfigured: boolean;
  /** null when paid sign-up can admit someone now; otherwise why not, for
   *  the operator (never shown to the public). */
  paidBlocked: string | null;
  /** The catalogue's purchasable plans, projected for the public. */
  plans: PublicPlan[];
}

export interface SignupModeInputs {
  /** foldrun's hosted edition (platform.edition() === "hosted"). */
  hosted: boolean;
  /** Does any account exist? Inside the users lock, from the read under it. */
  usersExist: boolean;
  /** signup.open (FOLDRUN_OPEN_SIGNUP) as the settings say now. */
  freeSetting: boolean;
  /** billing().signupOffer?.() — null without billing. */
  offer: SignupOffer | null;
}

/** Each door, effectively, now — and for the paid one, what the operator
 *  set and why it does not admit. */
export interface SignupModes {
  bootstrap: boolean;
  free: boolean;
  paid: boolean;
  paidConfigured: boolean;
  /** null when `paid` is on; otherwise the reason it is off. */
  paidReason: string | null;
}

/** The doors as they stand. Pure: every input is passed in. */
export function signupModes(i: SignupModeInputs): SignupModes {
  const paidConfigured = i.hosted && Boolean(i.offer?.paidConfigured);
  const paidReason = !i.hosted
    ? "paid sign-up is foldrun's hosted platform's"
    : !i.offer
      ? "this build has no billing"
      : !i.offer.paidConfigured
        ? "paid sign-up is off"
        : i.offer.paidBlocked;
  return {
    bootstrap: !i.usersExist,
    free: i.freeSetting,
    paid: paidReason === null,
    paidConfigured,
    paidReason,
  };
}

/** Is there any way in for a stranger right now? For deciding whether to
 *  SHOW an entry point — never to let anyone in (assertSignupAllowed does). */
export function anyWayIn(m: Pick<SignupModes, "bootstrap" | "free" | "paid">): boolean {
  return m.bootstrap || m.free || m.paid;
}

export interface SignupState {
  /** Did this signup arrive on a valid invite? An invite bypasses the
   *  switches: a member chose to let this person in. */
  joining: boolean;
  /** For a new account: the door asked for. Anything else is refused with
   *  the closed sentence. Ignored for a joiner. */
  request?: unknown;
  /** The doors, effectively — `bootstrap` from the users read under the
   *  lock, so two first sign-ups cannot both be the first. */
  modes: Pick<SignupModes, "bootstrap" | "free" | "paid">;
  /** For a joiner: does the account they were invited to still exist? */
  accountExists: boolean;
  /** Is this email already registered anywhere on the install? */
  emailTaken: boolean;
  /** Is the requested account name taken? Only asked of a new account. */
  nameTaken: boolean;
}

export class SignupError extends Error {}

const CLOSED = "signups are closed on this install";

/**
 * The door this signup comes in by, or a throw saying why it cannot.
 *
 * Throws rather than returning a message because every caller must refuse,
 * and a returned string is a thing a caller can forget to check.
 */
export function assertSignupAllowed(state: SignupState): Admission {
  // 1. May anyone come in here at all, by the door asked for? Nothing
  //    address-specific yet.
  let admission: Admission;
  if (state.joining) {
    if (!state.accountExists) throw new SignupError("that invite's account no longer exists");
    admission = "invite";
  } else if (state.request === "free") {
    // The first account comes in as the install's own bootstrap, whatever
    // the switches say; after it, only an open free door admits.
    if (state.modes.bootstrap) admission = "bootstrap";
    else if (state.modes.free) admission = "free";
    else throw new SignupError(CLOSED);
  } else if (state.request === "paid") {
    if (!state.modes.paid) throw new SignupError(CLOSED);
    admission = "paid";
  } else {
    // No door named, or one that does not exist: the same sentence as a
    // closed install, so nothing is learnt from the shape of the refusal.
    throw new SignupError(CLOSED);
  }

  // 2. Only now, once we know the door is open, is this address's own
  //    situation worth answering. An open install cannot hide that an address
  //    is registered without an email-verification step it does not have —
  //    that is a product decision rather than a patch — but a CLOSED one
  //    never reaches this line, which is where the leak was.
  if (state.emailTaken) throw new SignupError("an account with that email already exists");

  // 3. And the account name, which is a different question about a different
  //    thing, asked last so it can never stand in for the address.
  if (!state.joining && state.nameTaken) throw new SignupError("that account name is taken");
  return admission;
}

/**
 * Does an account that came in by this door get the hosted trial credit when
 * its owner proves their address? An allowlist: a door added later gets
 * nothing until someone decides it should. A paid sign-up does not — its
 * plan is what it bought (and an account still waiting to pay must not be
 * able to run on free credit). Accounts from before admission was recorded
 * (undefined) keep what they always had.
 */
export function trialEligible(admission: Admission | null | undefined): boolean {
  return admission === undefined || admission === null || admission === "bootstrap" || admission === "free" || admission === "invite" || admission === "operator";
}
