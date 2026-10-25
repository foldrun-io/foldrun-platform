// Who may do what — the table, and the rules for changing who is who.
//
// The bug this widens ownership.ts against: every member and every API key
// could write secrets, deploy, approve runs and spend the wallet, so the
// person approving a run and the person who asked were the same role. These
// pin the matrix, the legacy default, and the three role-change rules.
//
//   node --test tests/permissions.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIONS,
  ASSIGNABLE,
  ROLES,
  assertCanChangeRole,
  assertCanRemoveMember,
  assertCanTransfer,
  can,
  isRole,
  outranks,
  roleOf,
  type RoleMembership,
} from "../src/permissions.ts";

let clock = 0;
const member = (id: string, tenant = "acme", extra: Partial<RoleMembership> = {}): RoleMembership => ({
  id,
  tenant,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString(),
  ...extra,
});
const fresh = () => {
  clock = 0;
};

const fails = (fn: () => void, status: number, re: RegExp) => {
  assert.throws(fn, (e: unknown) => {
    const err = e as { status?: number; message: string };
    assert.equal(err.status, status, err.message);
    assert.match(err.message, re);
    return true;
  });
};

test("the matrix reads as a ladder: each role has everything below it", () => {
  for (const action of Object.keys(ACTIONS) as (keyof typeof ACTIONS)[]) {
    const least = ACTIONS[action];
    for (const role of ROLES) {
      assert.equal(can(role, action), ROLES.indexOf(role) >= ROLES.indexOf(least), `${role} ${action}`);
    }
  }
  // The four lines that matter most, spelled out.
  assert.ok(can("viewer", "workspace:read"));
  assert.ok(!can("viewer", "run:start"), "a viewer starts nothing");
  assert.ok(can("editor", "run:start") && !can("editor", "secrets:write"), "an editor runs but never touches credentials");
  assert.ok(can("admin", "secrets:write") && !can("admin", "billing:manage"), "an admin never spends the owner's money");
  assert.ok(outranks("owner", "admin") && !outranks("admin", "admin"));
  assert.ok(isRole("editor") && !isRole("root") && !isRole(undefined));
  assert.ok(!ASSIGNABLE.includes("owner"), "ownership is transferred, never assigned");
});

test("the owner is derived from ownership, not from a role field; unmarked members are admins", () => {
  fresh();
  const members = [
    member("founder"),                       // earliest, no flag — the founder on every old account
    member("early", "acme"),                 // unmarked invitee: the power they always had
    member("ed", "acme", { role: "editor" }),
    member("liar", "acme", { role: "owner" }), // a record can claim it; ownership decides
    member("other", "zeta"),
  ];
  assert.equal(roleOf(members, "acme", "founder"), "owner");
  assert.equal(roleOf(members, "acme", "early"), "admin");
  assert.equal(roleOf(members, "acme", "ed"), "editor");
  assert.equal(roleOf(members, "acme", "liar"), "admin", "a claimed owner role is read as the default, not honoured");
  assert.equal(roleOf(members, "acme", "other"), null, "another account's member is nobody here");
});

test("changing roles: admins manage below admin, only the owner touches admins, nobody re-roles themselves", () => {
  fresh();
  const m = [
    member("own", "acme", { owner: true }),
    member("adm", "acme", { role: "admin" }),
    member("ed", "acme", { role: "editor" }),
    member("view", "acme", { role: "viewer" }),
  ];
  // An admin promotes a viewer to editor, and back.
  assertCanChangeRole(m, "acme", "view", "editor", "adm");
  assertCanChangeRole(m, "acme", "ed", "viewer", "adm");
  // …but cannot make an admin, or unmake one.
  fails(() => assertCanChangeRole(m, "acme", "ed", "admin", "adm"), 403, /only the owner/);
  fails(() => assertCanChangeRole(m, "acme", "adm", "editor", "adm"), 400, /your own role/);
  // The owner can do both.
  assertCanChangeRole(m, "acme", "ed", "admin", "own");
  assertCanChangeRole(m, "acme", "adm", "viewer", "own");
  // Nobody assigns ownership, and nobody re-roles the owner.
  fails(() => assertCanChangeRole(m, "acme", "ed", "owner", "own"), 400, /transferred/);
  fails(() => assertCanChangeRole(m, "acme", "own", "admin", "adm"), 400, /transferring/);
  // An editor manages nobody.
  fails(() => assertCanChangeRole(m, "acme", "view", "editor", "ed"), 403, /admin or the owner/);
  // Strangers and ghosts.
  fails(() => assertCanChangeRole(m, "acme", "view", "editor", "nobody"), 403, /not a member/);
  fails(() => assertCanChangeRole(m, "acme", "ghost", "editor", "own"), 404, /no such member/);
});

test("removing: the founder stays, admins remove below them, the owner removes anyone but themselves", () => {
  fresh();
  const m = [
    member("own", "acme", { owner: true }),
    member("adm", "acme", { role: "admin" }),
    member("adm2", "acme", { role: "admin" }),
    member("ed", "acme", { role: "editor" }),
  ];
  assertCanRemoveMember(m, "acme", "ed", "adm");
  fails(() => assertCanRemoveMember(m, "acme", "adm2", "adm"), 403, /only the owner can remove an admin/);
  fails(() => assertCanRemoveMember(m, "acme", "own", "adm"), 400, /cannot be removed/);
  fails(() => assertCanRemoveMember(m, "acme", "adm", "adm"), 400, /remove yourself/);
  assertCanRemoveMember(m, "acme", "adm2", "own");
  fails(() => assertCanRemoveMember(m, "acme", "own", "own"), 400, /cannot be removed/);
  fails(() => assertCanRemoveMember(m, "acme", "adm", "ed"), 403, /admin or the owner/);
  // The legacy shape — two unmarked invitees — still cannot delete each other.
  fresh();
  const legacy = [member("founder"), member("a"), member("b")];
  fails(() => assertCanRemoveMember(legacy, "acme", "b", "a"), 403, /only the owner can remove an admin/);
  fails(() => assertCanRemoveMember(legacy, "acme", "founder", "a"), 400, /cannot be removed/);
});

test("transfer: the owner, to a member, never to themselves", () => {
  fresh();
  const m = [member("own", "acme", { owner: true }), member("adm", "acme", { role: "admin" })];
  assertCanTransfer(m, "acme", "adm", "own");
  fails(() => assertCanTransfer(m, "acme", "adm", "adm"), 403, /only the owner/);
  fails(() => assertCanTransfer(m, "acme", "own", "own"), 400, /already own/);
  fails(() => assertCanTransfer(m, "acme", "ghost", "own"), 404, /no such member/);
});
