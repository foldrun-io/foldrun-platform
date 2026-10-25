// Who may do what, in one table.
//
// Ownership (ownership.ts) answered one question — who owns the account — and
// gated one act with it: removing a member. Everything else was open to every
// member and every API key: writing secrets, deploying, approving a run,
// spending the wallet. Fine for one person; wrong the day a second one is
// invited, and wrong in the specific way that the person approving a run and
// the person who asked for approval were the same role.
//
// Four roles, ordered, and a list of actions each with the least role that
// may do it. The API asks `can(role, action)` at one chokepoint per route and
// the dashboard asks the same function to decide which controls to draw, so
// the two cannot disagree. Rules about changing roles live here too, for the
// reason ownership.ts gave: a security rule that cannot be unit-tested is one
// a refactor breaks quietly, and web/server cannot be loaded by a test runner.
//
// What a member without a role means is the one deliberate compromise. Every
// account that exists was built when all members were equal, so an unmarked
// member reads as `admin` — the power they had — rather than being demoted by
// a deploy. New invites carry a role; the owner can lower anyone's.

import { ownerOf, OwnershipError, type Membership } from "./ownership.ts";

export const ROLES = ["viewer", "editor", "admin", "owner"] as const;
export type Role = (typeof ROLES)[number];

/** Is this string one of the roles? For request bodies and invite tokens. */
export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

/** Roles a person may be given by someone else. `owner` is transferred, never
 *  assigned — there is exactly one, and that is a different act. */
export const ASSIGNABLE: readonly Role[] = ["viewer", "editor", "admin"];

/**
 * Everything the platform gates, and the least role that may do it.
 *
 *   viewer   sees everything: the dashboard, runs and their output, files,
 *            history. Changes nothing, starts nothing, spends nothing.
 *   editor   the working role: edits files, uploads, deploys, runs flows,
 *            approves and stops runs, tests tools, promotes runs to evals.
 *   admin    runs the account: workspaces come and go, secrets and
 *            credentials, API keys, the team below admin level.
 *   owner    the one who pays: billing, the admins, the account itself.
 */
export const ACTIONS = {
  /** Read anything in the account: workspaces, runs, files, history, usage. */
  "workspace:read": "viewer",
  /** Change source: files, storage, evals, flows, agents, library, deploys, git push. */
  "workspace:write": "editor",
  /** Start, stop, re-run, approve or promote a run; test a tool. */
  "run:start": "editor",
  /** Create, rename or delete a workspace; rotate its hook. */
  "workspace:manage": "admin",
  /** Write or delete a secret; connect or disconnect an OAuth credential. */
  "secrets:write": "admin",
  /** Invite; remove or re-role members below admin. */
  "team:manage": "admin",
  /** Mint or revoke API keys. */
  "keys:manage": "admin",
  /** Read the account's audit log: who signed in, minted, invited, deployed. */
  "audit:read": "admin",
  /** Make someone an admin, or an admin something else; remove an admin. */
  "admins:manage": "owner",
  /** The wallet, the card, checkout, auto top-up. */
  "billing:manage": "owner",
  /** Hand the account to another member. */
  "owner:transfer": "owner",
} as const satisfies Record<string, Role>;

export type Action = keyof typeof ACTIONS;

export function can(role: Role, action: Action): boolean {
  return RANK[role] >= RANK[ACTIONS[action]];
}

/** Does `a` outrank `b`? Strictly — an admin does not outrank an admin. */
export function outranks(a: Role, b: Role): boolean {
  return RANK[a] > RANK[b];
}

export interface RoleMembership extends Membership {
  /** Absent on members from before roles existed — see roleOf. */
  role?: Role;
}

/**
 * A member's effective role. The owner is whoever ownership.ts says, whatever
 * their record claims — ownership was never a role field and an account with
 * two owners is a bug, not a state. Anyone else is what they were marked, or
 * `admin` when unmarked, which is the power every member had before roles.
 */
export function roleOf(members: RoleMembership[], tenant: string, userId: string): Role | null {
  const m = members.find((x) => x.tenant === tenant && x.id === userId);
  if (!m) return null;
  const owner = ownerOf(members, tenant);
  if (owner && owner.id === userId) return "owner";
  // A record claiming `owner` that ownership does not confirm is read as
  // the default, not honoured: two owners is a bug, and the fix for it is
  // never to believe the field.
  return m.role && m.role !== "owner" ? m.role : "admin";
}

/**
 * May `actorId` give `targetId` the role `next`? Throws the reason if not.
 *
 * Nobody re-roles themselves: an admin demoting themselves to viewer locks
 * the account's only administrator out, and an owner has transfer for the
 * one change they are allowed. Admins manage editors and viewers; making or
 * unmaking an admin is the owner's, because an admin who can promote peers is
 * an owner with extra steps.
 */
export function assertCanChangeRole(
  members: RoleMembership[],
  tenant: string,
  targetId: string,
  next: Role,
  actorId: string,
): void {
  const actor = roleOf(members, tenant, actorId);
  const target = roleOf(members, tenant, targetId);
  if (!actor) throw new OwnershipError("you are not a member of this account", 403);
  if (!target) throw new OwnershipError("no such member", 404);
  if (!can(actor, "team:manage")) throw new OwnershipError("only an admin or the owner can change roles", 403);
  if (targetId === actorId) throw new OwnershipError("you cannot change your own role", 400);
  if (target === "owner") throw new OwnershipError("the owner's role is changed by transferring the account", 400);
  if (next === "owner") throw new OwnershipError("ownership is transferred, not assigned", 400);
  if (!ASSIGNABLE.includes(next)) throw new OwnershipError(`not a role: ${next}`, 400);
  if ((next === "admin" || target === "admin") && !can(actor, "admins:manage")) {
    throw new OwnershipError("only the owner can make or unmake an admin", 403);
  }
}

/**
 * May `actorId` remove `targetId`? The rules ownership.ts had, widened so an
 * admin can remove the people below them, and no wider: an admin removing
 * another admin is the founder-deletion bug one level down.
 */
export function assertCanRemoveMember(
  members: RoleMembership[],
  tenant: string,
  targetId: string,
  actorId: string,
): void {
  const ours = members.filter((m) => m.tenant === tenant);
  const actor = roleOf(members, tenant, actorId);
  const target = roleOf(members, tenant, targetId);
  if (!actor) throw new OwnershipError("you are not a member of this account", 403);
  if (!target) throw new OwnershipError("no such member", 404);
  if (!can(actor, "team:manage")) throw new OwnershipError("only an admin or the owner can remove a member", 403);
  if (target === "owner") {
    // Leaving would either orphan the account or silently promote whoever
    // happens to be next by date. Neither is a thing to do on a click
    // labelled "Remove".
    throw new OwnershipError("the owner cannot be removed — transfer the account first", 400);
  }
  if (targetId === actorId) throw new OwnershipError("you cannot remove yourself", 400);
  if (target === "admin" && !can(actor, "admins:manage")) {
    throw new OwnershipError("only the owner can remove an admin", 403);
  }
  if (ours.length <= 1) throw new OwnershipError("an account keeps its last member", 400);
}

/**
 * May `actorId` hand the account to `targetId`? Only the owner, only to a
 * member, and not to themselves. The old owner becomes an admin — they keep
 * running the account, they just stop being the one who pays for it.
 */
export function assertCanTransfer(
  members: RoleMembership[],
  tenant: string,
  targetId: string,
  actorId: string,
): void {
  const actor = roleOf(members, tenant, actorId);
  const target = roleOf(members, tenant, targetId);
  if (!actor || !can(actor, "owner:transfer")) throw new OwnershipError("only the owner can transfer the account", 403);
  if (!target) throw new OwnershipError("no such member", 404);
  if (targetId === actorId) throw new OwnershipError("you already own this account", 400);
}
