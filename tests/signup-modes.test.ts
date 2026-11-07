// The sign-up switches (7 Nov 2026): which door a sign-up comes in by, and
// that being SHOWN a way in never lets anyone in.
//
//   free  — signup.open (FOLDRUN_OPEN_SIGNUP)
//   paid  — signup.paid, hosted only, effective only when the hosted
//           business says payments are ready and its paid flow exists
//   bootstrap — the install's first account, its own capability
//   invite — no switch applies
//
//   node --test tests/signup-modes.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSignupAllowed, signupModes, anyWayIn, trialEligible, type SignupOffer, type SignupState } from "../src/signup.ts";

const offer = (o: Partial<SignupOffer> = {}): SignupOffer => ({ paidConfigured: false, paidBlocked: null, plans: [], ...o });

const door = (state: Partial<SignupState>): string => {
  try {
    return assertSignupAllowed({
      joining: false,
      request: "free",
      modes: { bootstrap: false, free: false, paid: false },
      accountExists: false,
      emailTaken: false,
      nameTaken: false,
      ...state,
    });
  } catch (err) {
    return `refused: ${(err as Error).message}`;
  }
};

test("paid is effective only on hosted, switched on, and not blocked", () => {
  const base = { hosted: true, usersExist: true, freeSetting: false };
  assert.equal(signupModes({ ...base, offer: offer({ paidConfigured: true }) }).paid, true);
  // Configured but blocked (payments not ready, nothing purchasable, the
  // flow not built): off, with the reason for the operator.
  const blocked = signupModes({ ...base, offer: offer({ paidConfigured: true, paidBlocked: "the paid sign-up flow is not built yet" }) });
  assert.equal(blocked.paid, false);
  assert.equal(blocked.paidConfigured, true);
  assert.match(blocked.paidReason ?? "", /not built/);
  // Switched off.
  const off = signupModes({ ...base, offer: offer({ paidConfigured: false }) });
  assert.deepEqual([off.paid, off.paidConfigured, off.paidReason], [false, false, "paid sign-up is off"]);
  // No billing in this build.
  assert.equal(signupModes({ ...base, offer: null }).paid, false);
  // The community edition, whatever an offer says.
  const community = signupModes({ ...base, hosted: false, offer: offer({ paidConfigured: true }) });
  assert.deepEqual([community.paid, community.paidConfigured], [false, false]);
});

test("bootstrap is its own capability, never folded into free", () => {
  const first = signupModes({ hosted: true, usersExist: false, freeSetting: false, offer: null });
  assert.equal(first.bootstrap, true);
  assert.equal(first.free, false, "the first-user exception is not free sign-up");
  assert.equal(anyWayIn(first), true, "but there is a way in to show");
  const later = signupModes({ hosted: true, usersExist: true, freeSetting: false, offer: null });
  assert.equal(later.bootstrap, false);
  assert.equal(anyWayIn(later), false);
});

test("the matrix: request × free × paid × first user × invite", () => {
  const closed = "refused: signups are closed on this install";
  for (const bootstrap of [false, true]) {
    for (const free of [false, true]) {
      for (const paid of [false, true]) {
        const modes = { bootstrap, free, paid };
        const label = JSON.stringify(modes);
        // A free request: the first account bootstraps; after it only the free door.
        assert.equal(door({ modes, request: "free" }), bootstrap ? "bootstrap" : free ? "free" : closed, `free ${label}`);
        // A paid request: only the paid door — never free, never bootstrap.
        assert.equal(door({ modes, request: "paid" }), paid ? "paid" : closed, `paid ${label}`);
        // An invite: no switch applies.
        assert.equal(door({ modes, joining: true, accountExists: true }), "invite", `invite ${label}`);
        // No door named, or one that does not exist: the closed sentence, whatever is open.
        for (const request of [undefined, "", "pro", "FREE", null, 1, { free: true }]) {
          assert.equal(door({ modes, request }), closed, `request ${JSON.stringify(request)} ${label}`);
        }
      }
    }
  }
});

test("paid configured but not effective admits nobody, and says nothing about the address", () => {
  const modes = { bootstrap: false, free: false, paid: false };
  const known = door({ modes, request: "paid", emailTaken: true });
  const unknown = door({ modes, request: "paid", emailTaken: false });
  assert.equal(known, unknown);
  assert.match(known, /signups are closed/);
});

test("with only the paid door open, a free request is closed — whatever the address", () => {
  const modes = { bootstrap: false, free: false, paid: true };
  assert.equal(door({ modes, request: "free", emailTaken: true }), door({ modes, request: "free", emailTaken: false }));
  // And through the paid door the order holds: address before account name.
  assert.match(door({ modes, request: "paid", emailTaken: true, nameTaken: true }), /email already exists/);
  assert.match(door({ modes, request: "paid", nameTaken: true }), /account name is taken/);
});

test("the trial goes to the doors that earn it, and to accounts from before the record", () => {
  for (const a of ["bootstrap", "free", "operator", undefined, null] as const) assert.equal(trialEligible(a), true, String(a));
  assert.equal(trialEligible("paid"), false, "a paid sign-up bought a plan; one still waiting to pay must not run on free credit");
  assert.equal(trialEligible("invite"), false, "an account does not begin on an invite: its founder is gone and how it began is unknown");
  // A value this release does not know (a later release's door) earns nothing.
  assert.equal(trialEligible("waitlist" as never), false);
});
