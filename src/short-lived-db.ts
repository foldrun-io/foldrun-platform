// Short-lived rows: a `foldrun login` request and an OAuth consent in flight.
//
// Both were files under the data root — cli-logins.json, rewritten whole by
// every web pod, and .oauth-pending/<nonce>.json, holding a client secret in
// plain text. Both live ten minutes and are used once. As rows, "used once"
// is a single DELETE … RETURNING: two polls, or two callbacks with the same
// nonce, cannot both get the key or the consent. The secret each carries is
// encrypted before it is written, under the account's key.

import { and, count, eq, gt, lte, ne } from "drizzle-orm";
import { ormRequired, type Db } from "./db.ts";
import { cliLogins, oauthPending } from "./schema.ts";

export interface CliLoginRow {
  id: string;
  code: string;
  hostname: string;
  status: "pending" | "approved" | "denied";
  /** The minted key, encrypted, plus who it belongs to. */
  grant: Record<string, unknown> | null;
  createdAt: Date;
  expiresAt: Date;
}

const asRow = (r: typeof cliLogins.$inferSelect): CliLoginRow => ({
  id: r.id,
  code: r.code,
  hostname: r.hostname,
  status: r.status as CliLoginRow["status"],
  grant: (r.grant as Record<string, unknown> | null) ?? null,
  createdAt: r.createdAt,
  expiresAt: r.expiresAt,
});

/** Drop what has expired, and say how many live requests remain. */
export async function sweepCliLoginsDb(on?: Db): Promise<number> {
  const q = on ?? ormRequired();
  await q.delete(cliLogins).where(lte(cliLogins.expiresAt, new Date()));
  const [{ n }] = await q.select({ n: count() }).from(cliLogins);
  return Number(n);
}

/** Insert a request; false when its code is already taken, so the caller draws another. */
export async function insertCliLoginDb(row: Omit<CliLoginRow, "grant">, on?: Db): Promise<boolean> {
  const q = on ?? ormRequired();
  const got = await q
    .insert(cliLogins)
    .values({ ...row, grant: null })
    .onConflictDoNothing({ target: cliLogins.code })
    .returning({ id: cliLogins.id });
  return got.length === 1;
}

/** A live request by the code the browser shows. */
export async function findCliLoginByCodeDb(code: string, on?: Db): Promise<CliLoginRow | null> {
  const q = on ?? ormRequired();
  const [r] = await q
    .select()
    .from(cliLogins)
    .where(and(eq(cliLogins.code, code), gt(cliLogins.expiresAt, new Date())));
  return r ? asRow(r) : null;
}

/** Record the decision on a live, still-pending request. False if there is none. */
export async function decideCliLoginDb(
  code: string,
  status: "approved" | "denied",
  grant: Record<string, unknown> | null,
  on?: Db,
): Promise<boolean> {
  const q = on ?? ormRequired();
  const got = await q
    .update(cliLogins)
    .set({ status, grant })
    .where(and(eq(cliLogins.code, code), eq(cliLogins.status, "pending"), gt(cliLogins.expiresAt, new Date())))
    .returning({ id: cliLogins.id });
  return got.length === 1;
}

/**
 * The CLI's poll. A decided request is taken — deleted and returned — in one
 * statement, so the key reaches exactly one process. An undecided live one is
 * left alone; an expired one is removed.
 */
export async function pollCliLoginDb(
  id: string,
  on?: Db,
): Promise<{ state: "pending" } | { state: "expired" } | { state: "decided"; row: CliLoginRow }> {
  const q = on ?? ormRequired();
  const now = new Date();
  const [taken] = await q
    .delete(cliLogins)
    .where(and(eq(cliLogins.id, id), ne(cliLogins.status, "pending"), gt(cliLogins.expiresAt, now)))
    .returning();
  if (taken) return { state: "decided", row: asRow(taken) };
  const [r] = await q.select({ expiresAt: cliLogins.expiresAt }).from(cliLogins).where(eq(cliLogins.id, id));
  if (r && r.expiresAt > now) return { state: "pending" };
  if (r) await q.delete(cliLogins).where(eq(cliLogins.id, id));
  return { state: "expired" };
}

/** Park a consent. Expired ones are swept on the way in. */
export async function putOAuthPendingDb(
  nonce: string,
  tenant: string,
  payload: Record<string, unknown>,
  expiresAt: Date,
  on?: Db,
): Promise<void> {
  const q = on ?? ormRequired();
  await q.delete(oauthPending).where(lte(oauthPending.expiresAt, new Date()));
  await q.insert(oauthPending).values({ nonce, tenant, payload, expiresAt });
}

/** Read a parked record without taking it (a hand-off page shows it first). */
export async function peekOAuthPendingDb(
  nonce: string,
  on?: Db,
): Promise<{ tenant: string; payload: Record<string, unknown>; expired: boolean } | null> {
  const q = on ?? ormRequired();
  const [r] = await q.select().from(oauthPending).where(eq(oauthPending.nonce, nonce));
  if (!r) return null;
  return { tenant: r.tenant, payload: r.payload as Record<string, unknown>, expired: r.expiresAt <= new Date() };
}

/** Take a consent: returned once, whoever asks second gets null. Expired counts as gone. */
export async function takeOAuthPendingDb(
  nonce: string,
  on?: Db,
): Promise<{ tenant: string; payload: Record<string, unknown>; expired: boolean } | null> {
  const q = on ?? ormRequired();
  const [r] = await q.delete(oauthPending).where(eq(oauthPending.nonce, nonce)).returning();
  if (!r) return null;
  return { tenant: r.tenant, payload: r.payload as Record<string, unknown>, expired: r.expiresAt <= new Date() };
}
