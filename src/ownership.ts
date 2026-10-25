// Who owns an account, and what only they may do.
//
// The gap this closes: removing a teammate was guarded only by "the last
// member stays", so any member could delete any other — including the person
// who created the account, kept the workspaces and pays the bill. An invite is
// the cheapest thing on the platform to hand out, which made it the sharpest
// edge in it.
//
// The rules live here, in core, rather than beside the users file in the web
// server, for one reason: the web server's modules import through a bundler
// alias and cannot be loaded by a test runner. A security rule that cannot be
// unit-tested is a security rule that will be quietly broken by a refactor.
// The store stays where it is; only the decision moved.
//
// A boolean, not a role table: ownership is a fact about one member, and it
// stays that way now that roles exist beside it (permissions.ts). The owner
// is whoever this file says; their role is derived from that, never stored,
// so an account can never carry two.

export interface Membership {
  id: string;
  tenant: string;
  createdAt: string;
  /** Absent on accounts created before this field existed — see ownerOf. */
  owner?: boolean;
}

/**
 * The owner of an account: whoever is marked, else its earliest member.
 *
 * The fallback is what keeps this a code change rather than a data migration
 * over live accounts. On every account that already exists the earliest
 * member is its founder, so the derived answer is the right one, and no
 * one-way rewrite of anybody's users file is needed to get it.
 */
export function ownerOf<T extends Membership>(members: T[], tenant: string): T | null {
  const ours = members
    .filter((m) => m.tenant === tenant)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return ours.find((m) => m.owner) ?? ours[0] ?? null;
}

export function isOwner(members: Membership[], tenant: string, userId: string): boolean {
  const owner = ownerOf(members, tenant);
  return owner !== null && owner.id === userId;
}

export class OwnershipError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * May `actorId` remove `targetId` from this account? Throws the reason if not.
 *
 * Throws rather than returning a boolean because every caller of this must
 * refuse, and a boolean is a thing a caller can forget to check — which is
 * the exact shape of the bug being fixed.
 *
 * The owner-only form. With roles, the rule is assertCanRemoveMember in
 * permissions.ts, which lets an admin remove the people below them; this
 * stays as the stricter check for a caller that wants owner-only semantics.
 */
export function assertCanRemove(
  members: Membership[],
  tenant: string,
  targetId: string,
  actorId: string,
): void {
  const ours = members.filter((m) => m.tenant === tenant);
  const owner = ownerOf(members, tenant);

  if (!owner || owner.id !== actorId) {
    throw new OwnershipError("only the account owner can remove a member", 403);
  }
  if (targetId === owner.id) {
    // Leaving would either orphan the account or silently promote whoever
    // happens to be next by date. Neither is a thing to do on a click
    // labelled "Remove".
    throw new OwnershipError("the owner cannot be removed — transfer the account first", 400);
  }
  if (ours.length <= 1) {
    throw new OwnershipError("an account keeps its last member", 400);
  }
}
