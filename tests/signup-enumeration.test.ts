// The signup form must not say which addresses are registered.
//
// It did, and worst of all with signups CLOSED — the default, and what the
// production box runs. A registered email answered "an account with that
// email already exists"; an unknown one answered "signups are closed on this
// install". Two different sentences from a door that is shut either way, so
// anyone could work through a list and learn which addresses were customers
// without ever being able to sign up.
//
// The order of the gates is the whole fix, which is why it lives in core
// rather than beside the users file: web/server imports through a bundler
// alias and cannot be loaded here.
//
//   node --test tests/signup-enumeration.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSignupAllowed, type SignupState } from "../src/signup.ts";

/** The refusal for one attempt, or "(allowed)". */
const refusal = (state: Partial<SignupState>): string => {
  const full: SignupState = {
    joining: false,
    open: false,
    accountExists: false,
    emailTaken: false,
    nameTaken: false,
    ...state,
  };
  try {
    assertSignupAllowed(full);
    return "(allowed)";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};

test("with signups closed, a registered address and an unknown one are indistinguishable", () => {
  const known = refusal({ open: false, emailTaken: true });
  const unknown = refusal({ open: false, emailTaken: false });
  assert.equal(known, unknown, "the refusals differ — the form says which addresses exist");
  assert.match(known, /signups are closed/);

  // And the account name cannot stand in for the address either: every
  // combination on a closed install gives the same sentence.
  for (const emailTaken of [true, false]) {
    for (const nameTaken of [true, false]) {
      assert.equal(refusal({ open: false, emailTaken, nameTaken }), known, `emailTaken=${emailTaken} nameTaken=${nameTaken}`);
    }
  }
});

test("with signups open, a fresh address is allowed and a taken one says so", () => {
  assert.equal(refusal({ open: true }), "(allowed)");
  assert.match(refusal({ open: true, emailTaken: true }), /email already exists/);
  // An open install cannot hide a registered address without an email
  // verification step it does not have — that is a product decision, not a
  // patch. What it must not do is leak it through a different question, so
  // the address is answered before the account name whatever the name is.
  assert.match(refusal({ open: true, emailTaken: true, nameTaken: true }), /email already exists/);
  assert.match(refusal({ open: true, emailTaken: true, nameTaken: false }), /email already exists/);
  assert.match(refusal({ open: true, emailTaken: false, nameTaken: true }), /account name is taken/);
});

test("an invite bypasses the closed gate, and is judged on the invite first", () => {
  // The point of an invite: a member chose to let this person in, so a closed
  // install does not apply to them.
  assert.equal(refusal({ joining: true, open: false, accountExists: true }), "(allowed)");
  // An invite to an account that no longer exists fails on the invite — not
  // on whether the address is registered, which would leak again.
  assert.match(refusal({ joining: true, open: false, accountExists: false }), /invite's account no longer exists/);
  assert.equal(
    refusal({ joining: true, open: false, accountExists: false, emailTaken: true }),
    refusal({ joining: true, open: false, accountExists: false, emailTaken: false }),
    "a dead invite must answer the same way whoever presents it",
  );
  // A joiner is never refused for the account NAME being taken — of course it
  // is taken; it is the account they are joining.
  assert.equal(refusal({ joining: true, open: false, accountExists: true, nameTaken: true }), "(allowed)");
  // But an address already registered still cannot join twice.
  assert.match(refusal({ joining: true, open: false, accountExists: true, emailTaken: true }), /email already exists/);
});
