// Whether a signup may proceed, and in what order the question is asked.
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
// This lives in core rather than beside the users file for the reason
// ownership.ts gives: web/server imports through a bundler alias and cannot be
// loaded by a test runner, and a security rule that cannot be unit-tested is
// one a refactor breaks quietly.

export interface SignupState {
  /** Did this signup arrive on a valid invite? An invite bypasses the
   *  open-signup gate: a member chose to let this person in. */
  joining: boolean;
  /** FOLDRUN_OPEN_SIGNUP, or "this install has no users yet". */
  open: boolean;
  /** For a joiner: does the account they were invited to still exist? */
  accountExists: boolean;
  /** Is this email already registered anywhere on the install? */
  emailTaken: boolean;
  /** Is the requested account name taken? Only asked of a new account. */
  nameTaken: boolean;
}

export class SignupError extends Error {}

/**
 * Throws the reason a signup cannot proceed, or returns for one that can.
 *
 * Throws rather than returning a message because every caller must refuse,
 * and a returned string is a thing a caller can forget to check.
 */
export function assertSignupAllowed(state: SignupState): void {
  // 1. May anyone sign up here at all? Nothing address-specific yet.
  if (state.joining) {
    if (!state.accountExists) throw new SignupError("that invite's account no longer exists");
  } else if (!state.open) {
    throw new SignupError("signups are closed on this install");
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
}
