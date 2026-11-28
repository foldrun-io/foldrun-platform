// People, as rows — the database side of the web server's users store.
//
// The shape is the file's shape (UserRecord) so the callers that read and
// mutate members, roles, scopes and passwords change nothing but `await`.
// One row per person; the array-shaped reads the file offered are a SELECT;
// the write-back-the-whole-array pattern the file forced becomes an upsert
// of the one record that changed and a delete of the one that left.

import { asc, eq, sql } from "drizzle-orm";
import type { Membership } from "./people.ts";
import { orm, type Db } from "./db.ts";
import { memberships, users, type UserDbRow } from "./schema.ts";

/** Mirrors web/server/users.ts UserRecord — declared here so the platform
 *  needs nothing from the web package. */
export interface UserRow {
  id: string;
  email: string;
  tenant: string;
  salt: string;
  hash: string;
  createdAt: string;
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
  };
}

/** Every person, ordered. Pass a transaction to read inside it — the web
 *  store's mutations read under their lock, never before taking it. */
export async function allUsersDb(on?: Db): Promise<UserRow[]> {
  const q = on ?? orm();
  if (!q) return [];
  // ONE statement, so the people and their joined accounts are one moment's:
  // read as two, a transfer of ownership landing between them showed an
  // account with no marked owner, and the earliest member read as its owner
  // (Codex, FOL-464).
  const rows = await q
    .select({
      u: users,
      also: sql<{ tenant: string; role: string | null; workspaces: string[] | null; owner: boolean; at: string }[] | null>`(
        select json_agg(json_build_object('tenant', m.tenant, 'role', m.role, 'workspaces', m.workspaces, 'owner', m.owner, 'at', m.created_at) order by m.created_at, m.tenant)
        from ${memberships} m where m.user_id = ${users.id})`,
    })
    .from(users)
    .orderBy(asc(users.createdAt), asc(users.id));
  return rows.map(({ u: r, also }) => {
    const u = fromRow(r);
    if (!also?.length) return u;
    return {
      ...u,
      also: also.map((m) => ({
        tenant: m.tenant,
        ...(m.role ? { role: m.role } : {}),
        ...(m.workspaces !== null ? { workspaces: m.workspaces } : {}),
        ...(m.owner ? { owner: true } : {}),
        createdAt: new Date(m.at).toISOString(),
      })),
    };
  });
}

/** A person's joined accounts, as rows: what is listed stays, the rest goes.
 *  Call it in the transaction that writes the person. */
export async function setMembershipsDb(userId: string, also: Membership[], on?: Db): Promise<void> {
  const q = on ?? orm();
  if (!q) return;
  await q.delete(memberships).where(eq(memberships.userId, userId));
  if (!also.length) return;
  await q.insert(memberships).values(also.map((m) => ({ userId, tenant: m.tenant, role: m.role ?? null, workspaces: m.workspaces ?? null, owner: Boolean(m.owner), createdAt: new Date(m.createdAt) })));
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
 * The file's people, moved in once — like the ledger's history. Rows that
 * already exist are left alone (the database is authoritative the moment it
 * has them; a re-import must never revert a password changed since). Returns
 * how many were inserted, so the boot log can say so.
 */
export async function importUsersToDatabase(fromFile: UserRow[]): Promise<number> {
  const q = orm();
  if (!q || fromFile.length === 0) return 0;
  return q.transaction(async (t) => {
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
