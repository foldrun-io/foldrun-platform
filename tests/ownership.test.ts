// Who owns an account, and what only they can do.
//
// The gap this closes: `removeMember` guarded only "the last member stays",
// so any member could delete any other — including the person who created the
// account, kept the workspaces and pays the bill. An invite is the cheapest
// thing on the platform to hand out, which made it the sharpest edge in it.
//
//   node --test tests/ownership.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertCanRemove,
  isOwner,
  ownerOf,
  type Membership,
} from "../src/ownership.ts";

// The store's shape, minus the parts ownership does not read. `web/server`
// imports through a bundler alias and cannot be loaded here, which is exactly
// why the rules live in core: a security rule that cannot be unit-tested is
// one a refactor breaks quietly.
let clock = 0;
const member = (id: string, tenant: string, owner?: boolean): Membership => ({
  id,
  tenant,
  // Distinct, increasing, and in the order they were created — the fallback
  // rule reads this.
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString(),
  ...(owner === undefined ? {} : { owner }),
});

function withUsers(body: () => void) {
  clock = 0;
  body();
}

test("the account's creator owns it; someone joining on an invite does not", () =>
  withUsers(() => {
    const boss = member("boss", "acme", true);
    const guest = member("guest", "acme", false);
    const all = [boss, guest];

    assert.equal(ownerOf(all, "acme")!.id, "boss");
    assert.equal(isOwner(all, "acme", "boss"), true);
    assert.equal(isOwner(all, "acme", "guest"), false);
  }));

test("an invitee cannot delete the founder", () =>
  withUsers(() => {
    const all = [member("boss", "acme", true), member("guest", "acme", false)];
    assert.throws(
      () => assertCanRemove(all, "acme", "boss", "guest"),
      /only the account owner can remove a member/,
      "this is the whole bug: it used to succeed",
    );
  }));

test("an invitee cannot delete another invitee either", () =>
  withUsers(() => {
    const all = [
      member("boss", "acme", true),
      member("one", "acme", false),
      member("two", "acme", false),
    ];
    assert.throws(() => assertCanRemove(all, "acme", "two", "one"), /only the account owner/);
  }));

test("the owner can remove a member, but never themselves", () =>
  withUsers(() => {
    const all = [member("boss", "acme", true), member("guest", "acme", false)];
    assert.throws(
      () => assertCanRemove(all, "acme", "boss", "boss"),
      /the owner cannot be removed/,
      "leaving would orphan the account or silently promote whoever is next by date",
    );
    // The permitted case throws nothing.
    assertCanRemove(all, "acme", "guest", "boss");
  }));

test("the last member stays, even for the owner", () =>
  withUsers(() => {
    const all = [member("solo", "acme", true)];
    assert.throws(() => assertCanRemove(all, "acme", "solo", "solo"), /owner cannot be removed/);
  }));

test("an account created before the field has its founder as owner", () =>
  withUsers(() => {
    // The old shape: nobody marked. Ownership is derived from creation order
    // so the fix needs no one-way rewrite of anybody's users file.
    const all = [member("boss", "acme"), member("guest", "acme")];
    assert.equal(ownerOf(all, "acme")!.id, "boss", "the earliest member is the founder");
    assert.throws(() => assertCanRemove(all, "acme", "boss", "guest"), /only the account owner/);
    assertCanRemove(all, "acme", "guest", "boss");
  }));

test("an explicit owner beats creation order", () =>
  withUsers(() => {
    // If the account was ever transferred, the mark is the answer — not
    // whoever happens to be oldest.
    const all = [member("first", "acme", false), member("second", "acme", true)];
    assert.equal(ownerOf(all, "acme")!.id, "second");
  }));

test("an empty account has no owner and no crash", () =>
  withUsers(() => {
    assert.equal(ownerOf([], "acme"), null);
    assert.equal(isOwner([], "acme", "anyone"), false);
    assert.throws(() => assertCanRemove([], "acme", "x", "y"), /only the account owner/);
  }));

test("accounts do not leak into each other's ownership", () =>
  withUsers(() => {
    const all = [
      member("boss", "acme", true),
      member("guest", "acme", false),
      member("other", "beta", true),
    ];
    assert.equal(ownerOf(all, "beta")!.id, "other");
    assert.equal(isOwner(all, "acme", "other"), false, "owning beta is not owning acme");
    assert.throws(() => assertCanRemove(all, "acme", "boss", "other"), /only the account owner/);
  }));
