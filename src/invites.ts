// Team invites, as rows (29 Oct 2026) — the storage half of the web server's
// invites (web/server/users.ts mintInvite / acceptInvite / revokeInvites).
//
// An invite link used to be a signed statement stored nowhere: whoever held
// it could join as many times, with as many addresses, as they liked for
// seven days, and nobody could take one back — not even by removing the
// member who made it. Now the link carries only an id, its expiry and a MAC;
// what it grants lives here, and it is used up by one UPDATE … WHERE
// used_at IS NULL inside the transaction that creates the member, so two
// people racing one link make exactly one member.
//
// With a database: the `invites` table. Without one: `<dataRoot>/invites.json`
// (0600), which the web server reads and writes inside the same queue as
// users.json, so an acceptance and the member it creates land together.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { databaseEnabled, orm, type Db } from "./db.ts";
import { invites, type InviteDbRow } from "./schema.ts";

export interface InviteRow {
  id: string;
  tenant: string;
  /** viewer | editor | admin — never owner. */
  role: string;
  /** null for every workspace. */
  workspaces: string[] | null;
  /** The one address that may accept it, lower-cased; null for anyone (once). */
  email: string | null;
  /** The member who made it, by id; their standing is checked again on accept. */
  createdBy: string;
  createdByEmail: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  usedBy: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
}

export type InviteStatus = "pending" | "accepted" | "revoked" | "expired";

export function inviteStatus(r: InviteRow, now = Date.now()): InviteStatus {
  if (r.usedAt) return "accepted";
  if (r.revokedAt) return "revoked";
  if (Date.parse(r.expiresAt) <= now) return "expired";
  return "pending";
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function fromRow(r: InviteDbRow): InviteRow {
  return {
    id: r.id,
    tenant: r.tenant,
    role: r.role,
    workspaces: (r.workspaces as string[] | null) ?? null,
    email: r.email,
    createdBy: r.createdBy,
    createdByEmail: r.createdByEmail,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    usedAt: iso(r.usedAt),
    usedBy: r.usedBy,
    revokedAt: iso(r.revokedAt),
    revokedBy: r.revokedBy,
    revokeReason: r.revokeReason,
  };
}

// ------------------------------------------------------------------ database

export async function insertInviteDb(r: InviteRow, on: Db): Promise<void> {
  await on.insert(invites).values({
    id: r.id,
    tenant: r.tenant,
    role: r.role,
    workspaces: r.workspaces,
    email: r.email,
    createdBy: r.createdBy,
    createdByEmail: r.createdByEmail,
    createdAt: new Date(r.createdAt),
    expiresAt: new Date(r.expiresAt),
  });
}

/** Use it up: the row, marked used by `userId`, or null when it was already
 *  used, revoked, past its expiry or never existed. One statement, so two
 *  acceptances of one invite cannot both get a row back. */
export async function claimInviteDb(id: string, userId: string, on: Db): Promise<InviteRow | null> {
  const [row] = await on
    .update(invites)
    .set({ usedAt: sql`now()`, usedBy: userId })
    .where(and(eq(invites.id, id), isNull(invites.usedAt), isNull(invites.revokedAt), gt(invites.expiresAt, sql`now()`)))
    .returning();
  return row ? fromRow(row) : null;
}

export async function inviteByIdDb(id: string, on?: Db): Promise<InviteRow | null> {
  const q = on ?? orm();
  if (!q) return null;
  const [row] = await q.select().from(invites).where(eq(invites.id, id)).limit(1);
  return row ? fromRow(row) : null;
}

/** Every invite of an account, newest first. */
export async function invitesOfTenantDb(tenant: string, on?: Db): Promise<InviteRow[]> {
  const q = on ?? orm();
  if (!q) return [];
  const rows = await q.select().from(invites).where(eq(invites.tenant, tenant)).orderBy(sql`${invites.createdAt} desc`, invites.id);
  return rows.map(fromRow);
}

/** Revoke the still-unused ones among `ids`; returns those it revoked. A
 *  used or already-revoked invite is left exactly as it was. */
export async function revokeInvitesDb(ids: string[], by: string, reason: string, on: Db): Promise<InviteRow[]> {
  if (!ids.length) return [];
  const rows = await on
    .update(invites)
    .set({ revokedAt: sql`now()`, revokedBy: by, revokeReason: reason })
    .where(and(inArray(invites.id, ids), isNull(invites.usedAt), isNull(invites.revokedAt)))
    .returning();
  return rows.map(fromRow);
}

// ------------------------------------------------------------------ file

export const invitesFile = () => path.join(dataRoot(), "invites.json");

export function readInvitesFile(): InviteRow[] {
  const file = invitesFile();
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8")) as InviteRow[];
}

/** Whole-file write: a temp file beside it, renamed over, 0600 — a reader
 *  sees the old list or the new one, never half of either. */
export function writeInvitesFile(rows: InviteRow[]): void {
  const file = invitesFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ------------------------------------------------------------------ account deletion

/** An account's invites, for tenant-delete: rows with a database, its
 *  entries in invites.json without one. Returns how many went. */
export async function deleteTenantInvites(tenant: string): Promise<number> {
  if (databaseEnabled()) {
    const q = orm();
    if (!q) return 0;
    return (await q.delete(invites).where(eq(invites.tenant, tenant)).returning({ id: invites.id })).length;
  }
  const rows = readInvitesFile();
  const kept = rows.filter((r) => r.tenant !== tenant);
  if (kept.length !== rows.length) writeInvitesFile(kept);
  return rows.length - kept.length;
}
