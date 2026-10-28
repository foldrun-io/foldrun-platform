// API keys in Postgres.
//
// keys.json held every account's keys in one file at the data root: read in
// full on every authenticated request, rewritten whole on every create and
// revoke, with no lock — two keys minted at once could lose one. Here a
// request is one lookup by the hash's unique index, and a create is one
// insert. Only the SHA-256 of a key is ever stored.

import { and, asc, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { ormRequired, type Db } from "./db.ts";
import { apiKeys } from "./schema.ts";

/** The shape the web layer has always used (keys.json's records). */
export interface ApiKeyRow {
  id: string;
  hash: string;
  prefix: string;
  label: string;
  tenant: string;
  createdAt: string;
  createdBy?: string;
  revokedAt: string | null;
  scope?: { workspace: string; access: "read" | "write" };
  role?: "viewer" | "editor" | "admin";
  workspaces?: string[] | null;
  /** When it stops working; null or absent never. */
  expiresAt?: string | null;
  /** When it last authenticated (written at most once a minute), and from
   *  where, coarsely — a /24 or /48, never the address. */
  lastUsedAt?: string | null;
  lastIp?: string | null;
  /** When the owner was mailed that it expires within a week. */
  expiryWarnedAt?: string | null;
  /** The id of the key that replaced it in a rotation; null until then. */
  replacedBy?: string | null;
}

const toRow = (r: typeof apiKeys.$inferSelect): ApiKeyRow => ({
  id: r.id,
  hash: r.hash,
  prefix: r.prefix,
  label: r.label,
  tenant: r.tenant,
  createdAt: r.createdAt.toISOString(),
  ...(r.createdBy ? { createdBy: r.createdBy } : {}),
  revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
  ...(r.scope ? { scope: r.scope as ApiKeyRow["scope"] } : {}),
  ...(r.role ? { role: r.role as ApiKeyRow["role"] } : {}),
  workspaces: (r.workspaces as string[] | null) ?? null,
  expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
  lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
  lastIp: r.lastIp ?? null,
  expiryWarnedAt: r.expiryWarnedAt ? r.expiryWarnedAt.toISOString() : null,
  replacedBy: r.replacedBy ?? null,
});

const toValues = (k: ApiKeyRow): typeof apiKeys.$inferInsert => ({
  id: k.id,
  hash: k.hash,
  prefix: k.prefix,
  label: k.label,
  tenant: k.tenant,
  createdAt: new Date(k.createdAt),
  createdBy: k.createdBy ?? null,
  revokedAt: k.revokedAt ? new Date(k.revokedAt) : null,
  scope: k.scope ?? null,
  role: k.role ?? null,
  workspaces: k.workspaces ?? null,
  expiresAt: k.expiresAt ? new Date(k.expiresAt) : null,
  lastUsedAt: k.lastUsedAt ? new Date(k.lastUsedAt) : null,
  lastIp: k.lastIp ?? null,
  expiryWarnedAt: k.expiryWarnedAt ? new Date(k.expiryWarnedAt) : null,
  replacedBy: k.replacedBy ?? null,
});

export async function insertApiKeyDb(k: ApiKeyRow, on?: Db): Promise<void> {
  await (on ?? ormRequired()).insert(apiKeys).values(toValues(k));
}

/** The key presented, by its hash — revoked or not; the caller says which. */
export async function findApiKeyByHashDb(hash: string, on?: Db): Promise<ApiKeyRow | null> {
  const [r] = await (on ?? ormRequired()).select().from(apiKeys).where(eq(apiKeys.hash, hash));
  return r ? toRow(r) : null;
}

export async function listApiKeysDb(tenant: string, on?: Db): Promise<ApiKeyRow[]> {
  const rows = await (on ?? ormRequired()).select().from(apiKeys).where(eq(apiKeys.tenant, tenant)).orderBy(asc(apiKeys.createdAt));
  return rows.map(toRow);
}

/** Revoke one of this account's keys. False when it is not theirs or not there. */
export async function revokeApiKeyDb(tenant: string, id: string, on?: Db): Promise<boolean> {
  const got = await (on ?? ormRequired())
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.tenant, tenant)))
    .returning({ id: apiKeys.id });
  return got.length === 1;
}

/** Record that a key authenticated: when, and from where (already coarse). */
export async function touchApiKeyDb(id: string, at: Date, ip: string | null, on?: Db): Promise<void> {
  await (on ?? ormRequired()).update(apiKeys).set({ lastUsedAt: at, lastIp: ip }).where(eq(apiKeys.id, id));
}

/** Bring a key's end forward (never back): a rotation's grace. False when
 *  it is not this account's. LEAST in the statement, as keys.json's
 *  shortenExpiry compares: this used to set whatever it was given, so a 24h
 *  grace on a key that ended in ten minutes gave it another day. */
export async function setApiKeyExpiryDb(tenant: string, id: string, expiresAt: Date, on?: Db): Promise<boolean> {
  const got = await (on ?? ormRequired())
    .update(apiKeys)
    .set({ expiresAt: sql`least(coalesce(${apiKeys.expiresAt}, ${expiresAt}), ${expiresAt})` })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.tenant, tenant)))
    .returning({ id: apiKeys.id });
  return got.length === 1;
}

/** A member's address changed: the keys they minted in this account keep
 *  naming them (FOL-97), so removing them later still finds those keys. */
export async function renameKeyOwnerDb(tenant: string, from: string, to: string, on?: Db): Promise<number> {
  const got = await (on ?? ormRequired())
    .update(apiKeys)
    .set({ createdBy: to })
    .where(and(eq(apiKeys.tenant, tenant), sql`lower(${apiKeys.createdBy}) = ${from.toLowerCase()}`))
    .returning({ id: apiKeys.id });
  return got.length;
}

/** Record that a rotation replaced this key with `by`. One statement that
 *  only matches a live key not already replaced, so of two rotations of the
 *  same key at once exactly one wins; false for the other, and for a key
 *  that is not this account's. */
export async function markApiKeyReplacedDb(tenant: string, id: string, by: string, on?: Db): Promise<boolean> {
  const got = await (on ?? ormRequired())
    .update(apiKeys)
    .set({ replacedBy: by })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.tenant, tenant), isNull(apiKeys.replacedBy), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return got.length === 1;
}

/** Live keys, of every account, that expire before `before` and whose owner
 *  has not been told yet. */
export async function expiringApiKeysDb(before: Date, on?: Db): Promise<ApiKeyRow[]> {
  const rows = await (on ?? ormRequired())
    .select()
    .from(apiKeys)
    .where(and(isNull(apiKeys.revokedAt), isNull(apiKeys.expiryWarnedAt), isNotNull(apiKeys.expiresAt), lte(apiKeys.expiresAt, before)));
  return rows.map(toRow);
}

export async function markExpiryWarnedDb(id: string, at: Date, on?: Db): Promise<void> {
  await (on ?? ormRequired()).update(apiKeys).set({ expiryWarnedAt: at }).where(eq(apiKeys.id, id));
}

export async function hasActiveKeysDb(tenant: string, on?: Db): Promise<boolean> {
  const [r] = await (on ?? ormRequired())
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.tenant, tenant), isNull(apiKeys.revokedAt)))
    .limit(1);
  return Boolean(r);
}

/**
 * keys.json's records into rows, once. A row already there (by id or hash)
 * is left alone: the table is authoritative from the moment it has a key,
 * so a re-import can never un-revoke one. Returns how many were added.
 */
export async function importApiKeysDb(records: ApiKeyRow[], on?: Db): Promise<number> {
  if (!records.length) return 0;
  const got = await (on ?? ormRequired())
    .insert(apiKeys)
    .values(records.map(toValues))
    .onConflictDoNothing()
    .returning({ id: apiKeys.id });
  return got.length;
}
