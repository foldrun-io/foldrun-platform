// People, as rows — the database side of the web server's users store.
//
// The shape is the file's shape (UserRecord) so the callers that read and
// mutate members, roles, scopes and passwords change nothing but `await`.
// One row per person; the array-shaped reads the file offered are a SELECT;
// the write-back-the-whole-array pattern the file forced becomes an upsert
// of the one record that changed and a delete of the one that left.

import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Membership } from "./people.ts";
import { orm, type Db } from "./db.ts";
import { memberships, sessions, users, type UserDbRow } from "./schema.ts";

/** Mirrors web/server/users.ts UserRecord — declared here so the platform
 *  needs nothing from the web package. */
export interface UserRow {
  id: string;
  email: string;
  tenant: string;
  salt: string;
  hash: string;
  createdAt: string;
  /** How they want to be addressed (users.firstName on the web's record). */
  firstName?: string | null;
  lastName?: string | null;
  timezone?: string | null;
  owner?: boolean;
  role?: string;
  workspaces?: string[] | null;
  emailVerifiedAt?: string | null;
  /** Sealed (AES-GCM under the install key), never the raw base32. */
  mfaSecret?: string | null;
  /** sha256 hex of each unused backup code. */
  mfaBackup?: string[] | null;
  mfaEnabledAt?: string | null;
  /** A person's own small settings (onboarding dismissed, …). */
  prefs?: Record<string, unknown> | null;
  /** The door their account came in by (signup.ts Admission). Absent on
   *  people from before it was recorded. A value this release does not know
   *  is kept as written, and — the trial's allowlist (trialEligible) not
   *  naming it — earns nothing. */
  admission?: string;
  /** Their stay's id in `tenant` (people.ts); absent for the account they signed up into. */
  membership?: string;
  /** Counts the accounts the login opened after its first; a reset link names it. */
  recoveryGen?: number;
  /** The accounts they joined after their first (people.ts, FOL-464). */
  also?: Membership[];
}

function fromRow(r: UserDbRow): UserRow {
  return {
    id: r.id,
    email: r.email,
    tenant: r.tenant,
    salt: r.salt,
    hash: r.hash,
    createdAt: r.createdAt.toISOString(),
    ...(r.firstName !== null ? { firstName: r.firstName } : {}),
    ...(r.lastName !== null ? { lastName: r.lastName } : {}),
    ...(r.timezone !== null ? { timezone: r.timezone } : {}),
    ...(r.owner ? { owner: true } : {}),
    ...(r.role ? { role: r.role } : {}),
    ...(r.workspaces !== null ? { workspaces: r.workspaces as string[] } : {}),
    ...(r.emailVerifiedAt ? { emailVerifiedAt: r.emailVerifiedAt.toISOString() } : {}),
    ...(r.mfaSecret ? { mfaSecret: r.mfaSecret } : {}),
    ...(r.mfaBackup ? { mfaBackup: r.mfaBackup as string[] } : {}),
    ...(r.mfaEnabledAt ? { mfaEnabledAt: r.mfaEnabledAt.toISOString() } : {}),
    ...(r.prefs ? { prefs: r.prefs as Record<string, unknown> } : {}),
    ...(r.admission !== null && r.admission !== "" ? { admission: r.admission } : {}),
    ...(r.membershipId ? { membership: r.membershipId } : {}),
    ...(r.recoveryGen ? { recoveryGen: r.recoveryGen } : {}),
  };
}

/** A UserRow as the columns the table wants. One place turns ISO strings
 *  into Dates and absent optionals into NULLs. */
function toRow(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    tenant: u.tenant,
    salt: u.salt,
    hash: u.hash,
    createdAt: new Date(u.createdAt),
    firstName: u.firstName ?? null,
    lastName: u.lastName ?? null,
    timezone: u.timezone ?? null,
    owner: Boolean(u.owner),
    role: u.role ?? null,
    workspaces: u.workspaces === undefined || u.workspaces === null ? null : u.workspaces,
    emailVerifiedAt: u.emailVerifiedAt ? new Date(u.emailVerifiedAt) : null,
    mfaSecret: u.mfaSecret ?? null,
    mfaBackup: u.mfaBackup ?? null,
    mfaEnabledAt: u.mfaEnabledAt ? new Date(u.mfaEnabledAt) : null,
    prefs: u.prefs && Object.keys(u.prefs).length ? u.prefs : null,
    admission: u.admission ?? null,
    membershipId: u.membership ?? null,
    recoveryGen: u.recoveryGen ?? 0,
  };
}

/** Every person, ordered. Pass a transaction to read inside it — the web
 *  store's mutations read under their lock, never before taking it. */
export async function allUsersDb(on?: Db): Promise<UserRow[]> {
  const q = on ?? orm();
  if (!q) return [];
  // The inner query names "users"."id" in full: drizzle writes a column of a
  // single-table select bare, and a bare "id" in there is the membership's.
  // ONE statement, so the people and their joined accounts are one moment's:
  // read as two, a transfer of ownership landing between them showed an
  // account with no marked owner, and the earliest member read as its owner
  // (Codex, FOL-464).
  const rows = await q
    .select({
      u: users,
      also: sql<{ id: string; tenant: string; role: string | null; workspaces: string[] | null; owner: boolean; at: string }[] | null>`(
        select json_agg(json_build_object('id', m.id, 'tenant', m.tenant, 'role', m.role, 'workspaces', m.workspaces, 'owner', m.owner, 'at', m.created_at) order by m.created_at, m.tenant)
        from ${memberships} m where m.user_id = "users"."id")`,
    })
    .from(users)
    .orderBy(asc(users.createdAt), asc(users.id));
  return rows.map(({ u: r, also }) => withJoined(fromRow(r), also));
}

type AlsoJson = { id: string; tenant: string; role: string | null; workspaces: string[] | null; owner: boolean; at: string }[] | null;

/** A person's joined accounts, as the store hands them out. */
function withJoined(u: UserRow, also: AlsoJson): UserRow {
  if (!also?.length) return u;
  return {
    ...u,
    also: also.map((m) => ({
      id: m.id,
      tenant: m.tenant,
      ...(m.role ? { role: m.role } : {}),
      ...(m.workspaces !== null ? { workspaces: m.workspaces } : {}),
      ...(m.owner ? { owner: true } : {}),
      createdAt: new Date(m.at).toISOString(),
    })),
  };
}

/**
 * A live session, the person it belongs to and the owner of its account, in
 * ONE statement (FOL-476): one indexed read where the dashboard used to
 * update the session, read every person twice or three times and look at the
 * session again. A single statement is one snapshot, so the person cannot be
 * paired with a session a reset revoked between two reads (FOL-320).
 *
 * `ownerId` is the account's owner by the rule in ownership.ts — the member
 * marked owner, else the earliest — over its home members and those who
 * joined; a role is derived from it, never stored. Null when the session is
 * not live or its person is gone. Does not write: last seen is the caller's
 * once a minute (touchSessionDb).
 */
export async function liveSessionDb(id: string): Promise<{
  session: { userId: string; tenant: string; membership: string | null; audience: string | null; mfaAt: Date | null; method: string | null; lastSeenAt: Date };
  user: UserRow;
  ownerId: string | null;
} | null> {
  const q = orm();
  if (!q) return null;
  const [r] = await q
    .select({
      s: sessions,
      u: users,
      also: sql<AlsoJson>`(
        select json_agg(json_build_object('id', m.id, 'tenant', m.tenant, 'role', m.role, 'workspaces', m.workspaces, 'owner', m.owner, 'at', m.created_at) order by m.created_at, m.tenant)
        from ${memberships} m where m.user_id = "users"."id")`,
      ownerId: sql<string | null>`(
        select o.id from (
          select u2.id, u2.owner, u2.created_at from ${users} u2 where u2.tenant = "sessions"."tenant"
          union all
          select m2.user_id, m2.owner, m2.created_at from ${memberships} m2 where m2.tenant = "sessions"."tenant"
        ) o order by o.owner desc, o.created_at asc limit 1)`,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), isNull(sessions.revokedAt), gt(sessions.expiresAt, sql`now()`)))
    .limit(1);
  if (!r) return null;
  return {
    session: { userId: r.s.userId, tenant: r.s.tenant, membership: r.s.membershipId ?? null, audience: r.s.audience ?? null, mfaAt: r.s.mfaAt, method: r.s.method ?? null, lastSeenAt: r.s.lastSeenAt },
    user: withJoined(fromRow(r.u), r.also),
    ownerId: r.ownerId,
  };
}

/** A person's joined accounts, as rows: what is listed stays, the rest goes.
 *  Call it in the transaction that writes the person. */
export async function setMembershipsDb(userId: string, also: Membership[], on?: Db): Promise<void> {
  const q = on ?? orm();
  if (!q) return;
  await q.delete(memberships).where(eq(memberships.userId, userId));
  if (!also.length) return;
  await q.insert(memberships).values(also.map((m) => ({ id: m.id, userId, tenant: m.tenant, role: m.role ?? null, workspaces: m.workspaces ?? null, owner: Boolean(m.owner), createdAt: new Date(m.createdAt) })));
}

export async function upsertUserDb(u: UserRow, on?: Db): Promise<void> {
  const q = on ?? orm();
  if (!q) return;
  const row = toRow(u);
  await q
    .insert(users)
    .values({ ...row, updatedAt: sql`now()` })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        email: row.email,
        tenant: row.tenant,
        // Their first account can move to one they joined later (people.ts):
        // the record is then dated when they joined it, so they never read
        // as the earliest member, and owner, of an account they came to late.
        createdAt: row.createdAt,
        salt: row.salt,
        hash: row.hash,
        firstName: row.firstName,
        lastName: row.lastName,
        timezone: row.timezone,
        owner: row.owner,
        role: row.role,
        workspaces: row.workspaces,
        emailVerifiedAt: row.emailVerifiedAt,
        mfaSecret: row.mfaSecret,
        mfaBackup: row.mfaBackup,
        mfaEnabledAt: row.mfaEnabledAt,
        prefs: row.prefs,
        admission: row.admission,
        membershipId: row.membershipId,
        recoveryGen: row.recoveryGen,
        updatedAt: sql`now()`,
      },
    });
}

export async function deleteUserDb(id: string): Promise<void> {
  const q = orm();
  if (!q) return;
  await q.delete(memberships).where(eq(memberships.userId, id));
  await q.delete(users).where(eq(users.id, id));
}

/**
 * The file's people, moved in once — like the ledger's history, and only
 * into a table with nobody in it (FOL-469). The database is authoritative the
 * moment it has a person: a line still in an old users.json for someone
 * removed here must not bring them back at the next boot, and a re-import
 * must never revert a password changed since. So a table that has anyone —
 * a person, or a stay in a joined account — is left exactly as it is.
 * Returns how many were inserted, so the boot log can say so.
 */
export async function importUsersToDatabase(fromFile: UserRow[]): Promise<number> {
  const q = orm();
  if (!q || fromFile.length === 0) return 0;
  return q.transaction(async (t) => {
    // Two pods booting together: the second waits here, then finds the first's people.
    await t.execute(sql`select pg_advisory_xact_lock(hashtext('foldrun.users.import'))`);
    const someone = await t.execute(sql`select 1 from ${users} union all select 1 from ${memberships} limit 1`);
    if (someone.rows.length > 0) return 0;
    let inserted = 0;
    for (const u of fromFile) {
      // Everything the file holds of them: without the second factor and the
      // confirmed address, a person moved in signed in with a password alone.
      const { id } = toRow(u);
      const r = await t
        .insert(users)
        .values(toRow(u))
        .onConflictDoNothing({ target: users.id })
        .returning({ id: users.id });
      // Their joined accounts come with them, only when the person was new here.
      if (r.length && u.also?.length) await setMembershipsDb(id, u.also, t);
      inserted += r.length;
    }
    return inserted;
  });
}

/**
 * An account's people, gone with it (FOL-469): the stays in it, and the
 * people whose first account it was — unless they are in another, in which
 * case the one they joined earliest becomes their first, as people.ts does
 * when a record is spliced out. Pass the transaction the account's other
 * rows are deleted in. Returns who was removed and who moved on.
 */
export async function deleteTenantPeopleDb(tenant: string, on?: Db): Promise<{ removed: number; moved: number }> {
  const q = on ?? orm();
  if (!q) return { removed: 0, moved: 0 };
  await q.delete(memberships).where(eq(memberships.tenant, tenant));
  let removed = 0;
  let moved = 0;
  for (const person of await q.select({ id: users.id }).from(users).where(eq(users.tenant, tenant))) {
    const [next] = await q.select().from(memberships).where(eq(memberships.userId, person.id)).orderBy(asc(memberships.createdAt), asc(memberships.tenant)).limit(1);
    if (!next) {
      await q.delete(users).where(eq(users.id, person.id));
      removed++;
      continue;
    }
    await q
      .update(users)
      .set({ tenant: next.tenant, createdAt: next.createdAt, owner: next.owner, role: next.role, workspaces: next.workspaces, admission: "invite", membershipId: next.id, updatedAt: sql`now()` })
      .where(eq(users.id, person.id));
    await q.delete(memberships).where(and(eq(memberships.userId, person.id), eq(memberships.tenant, next.tenant)));
    moved++;
  }
  return { removed, moved };
}
