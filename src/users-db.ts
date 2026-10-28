// People, as rows — the database side of the web server's users store.
//
// The shape is the file's shape (UserRecord) so the callers that read and
// mutate members, roles, scopes and passwords change nothing but `await`.
// One row per person; the array-shaped reads the file offered are a SELECT;
// the write-back-the-whole-array pattern the file forced becomes an upsert
// of the one record that changed and a delete of the one that left.

import { asc, eq, sql } from "drizzle-orm";
import { orm, ormRequired, type Db } from "./db.ts";
import { users, type UserDbRow } from "./schema.ts";

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
  };
}

/** Every person, ordered. Pass a transaction to read inside it — the web
 *  store's mutations read under their lock, never before taking it. */
export async function allUsersDb(on?: Db): Promise<UserRow[]> {
  const q = on ?? orm();
  if (!q) return [];
  const rows = await q.select().from(users).orderBy(asc(users.createdAt), asc(users.id));
  return rows.map(fromRow);
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
        updatedAt: sql`now()`,
      },
    });
}

export async function deleteUserDb(id: string): Promise<void> {
  const q = orm();
  if (!q) return;
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
      const { id, email, tenant, salt, hash, createdAt, timezone, owner, role, workspaces } = toRow(u);
      const r = await t
        .insert(users)
        .values({ id, email, tenant, salt, hash, createdAt, timezone, owner, role, workspaces })
        .onConflictDoNothing({ target: users.id })
        .returning({ id: users.id });
      inserted += r.length;
    }
    return inserted;
  });
}
