// What has been backed up, and what a customer has asked to have restored.
//
// The backup itself is the operator's: a nightly host job (foldrun-infra
// dev/backup.sh) archives the whole data volume and a pg_dump, verifies
// both, and ships them off the box. It is not per-account — one archive
// holds every account — so what an account can be shown is which archives
// it is IN. The job records that, after verifying, as one row here per
// archive with the accounts it found in the listing. Nothing here reads or
// touches an archive; this is the index the Backups page reads.
//
// Every file the job ships is sealed with age to the operator's public key
// before it leaves the box (the row's `encrypted` and `recipient`); the
// private key that opens them is not on the server.
//
// Restoring an archive is also the operator's: it replaces a whole volume
// and a whole database, and the key that opens the archive is not on the
// box. What a customer can do alone is roll a workspace's markdown back
// through its git history (web's /restore route). For everything else —
// runs, state, storage, the database's records — they ask, and the ask is a
// row in restore_requests plus a mail to the operator.
//
// Rows in the database; on an install without one, two JSON-lines files at
// the data root, which is also what backup.sh appends to when it finds no
// database to write to.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { databaseEnabled, ormRequired } from "./db.ts";
import { backups, restoreRequests } from "./schema.ts";

export type BackupKind = "files" | "database" | "keys";

export interface BackupRecord {
  id: string;
  at: string;
  archive: string;
  bytes: number | null;
  sha256: string | null;
  files: number | null;
  runs: number | null;
  kinds: BackupKind[];
  accounts: string[];
  verified: boolean;
  offsite: string | null;
  keepDays: number | null;
  /** Sealed with age before it left the server (archive, manifest, env). */
  encrypted: boolean;
  /** Fingerprint of the public key it was sealed to, "sha256:<16 hex>". */
  recipient: string | null;
}

export interface RestoreRequest {
  id: string;
  tenant: string;
  workspace: string | null;
  target: string;
  backupId: string | null;
  what: string;
  note: string | null;
  by: string;
  at: string;
  status: string;
  notified: boolean;
}

/**
 * What the backup job is configured to do, for a page that has to say it.
 * The defaults are what dev/backup.sh and its timer do on the box; an
 * install that changes them says so through the environment.
 */
export function backupPolicy(): { schedule: string; keepLocal: number; keepOffsiteDays: number | null; encrypted: boolean; covers: string[]; excludes: string[] } {
  const s3 = process.env.FOLDRUN_STORAGE_DRIVER === "s3";
  const n = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);
  return {
    schedule: process.env.FOLDRUN_BACKUP_SCHEDULE || "nightly at 03:30, the server's time",
    keepLocal: n(process.env.FOLDRUN_BACKUP_KEEP, 14),
    keepOffsiteDays: process.env.FOLDRUN_BACKUP_OFFSITE_DAYS === "0" ? null : n(process.env.FOLDRUN_BACKUP_OFFSITE_DAYS, 15),
    // backup.sh seals every file with age before it leaves the server and
    // refuses to run without a recipient, so this is the job's rule, not a
    // setting. Each archive's own row says whether IT was sealed — the ones
    // taken before this rule landed were not.
    encrypted: true,
    covers: [
      "every workspace's source: agents, flows, knowledge, skills, tools, memory",
      "each workspace's git history",
      "state/ and run records",
      s3 ? "the storage index (which files exist); the file bytes are in object storage, not in this archive" : "storage/ files",
      "the account's encrypted secrets (the vault)",
      "the database: people, keys, sessions, the ledger and balances, the queue, the audit log",
    ],
    excludes: [
      ...(s3 ? ["storage file bytes, which live in object storage (S3/R2) and are not copied by the nightly job"] : []),
      "anything only inside a sandbox while a step runs",
      "data held by model providers and connected services",
    ],
  };
}

const backupsFile = () => path.join(dataRoot(), "backups.jsonl");
const requestsFile = () => path.join(dataRoot(), "restore-requests.jsonl");

function readJsonl<T>(file: string): T[] {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as T];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function appendJsonl(file: string, row: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

function normalise(r: Partial<BackupRecord> & { at: string; archive: string }): BackupRecord {
  return {
    id: r.id ?? r.archive,
    at: new Date(r.at).toISOString(),
    archive: r.archive,
    bytes: r.bytes ?? null,
    sha256: r.sha256 ?? null,
    files: r.files ?? null,
    runs: r.runs ?? null,
    kinds: (r.kinds ?? ["files"]) as BackupKind[],
    accounts: r.accounts ?? [],
    verified: Boolean(r.verified),
    offsite: r.offsite ?? null,
    keepDays: r.keepDays ?? null,
    encrypted: Boolean(r.encrypted),
    recipient: r.recipient ?? null,
  };
}

/** Record one verified archive. What backup.sh does with psql; here for
 *  tests and for an operator recording an archive taken by hand. */
export async function recordBackup(rec: Partial<BackupRecord> & { at: string; archive: string }): Promise<BackupRecord> {
  const row = normalise(rec);
  if (!databaseEnabled()) {
    appendJsonl(backupsFile(), row);
    return row;
  }
  await ormRequired()
    .insert(backups)
    .values({ ...row, at: new Date(row.at) })
    .onConflictDoNothing({ target: backups.id });
  return row;
}

/** The archives that hold this account, newest first. `accounts` names
 *  this account only: one archive holds every account on the server, and
 *  listing the rest told each customer who else is on the box. */
export async function listBackups(tenant: string, limit = 60): Promise<BackupRecord[]> {
  if (!databaseEnabled()) {
    return readJsonl<BackupRecord>(backupsFile())
      .map((r) => normalise(r))
      .filter((r) => r.accounts.includes(tenant))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, limit)
      .map((r) => ({ ...r, accounts: [tenant] }));
  }
  const rows = await ormRequired()
    .select()
    .from(backups)
    .where(sql`${backups.accounts} @> ${JSON.stringify([tenant])}::jsonb`)
    .orderBy(desc(backups.at))
    .limit(limit);
  return rows.map((r) =>
    normalise({
      ...r,
      at: r.at.toISOString(),
      kinds: r.kinds as BackupKind[],
      accounts: [tenant],
    }),
  );
}

export async function createRestoreRequest(input: {
  tenant: string;
  workspace?: string | null;
  target: string;
  backupId?: string | null;
  what: string;
  note?: string | null;
  by: string;
}): Promise<RestoreRequest> {
  const row: RestoreRequest = {
    id: `rr_${crypto.randomBytes(8).toString("hex")}`,
    tenant: input.tenant,
    workspace: input.workspace ?? null,
    target: input.target,
    backupId: input.backupId ?? null,
    what: input.what,
    note: input.note ?? null,
    by: input.by,
    at: new Date().toISOString(),
    status: "requested",
    notified: false,
  };
  if (!databaseEnabled()) {
    appendJsonl(requestsFile(), row);
    return row;
  }
  await ormRequired().insert(restoreRequests).values({ ...row, at: new Date(row.at) });
  return row;
}

/** Say whether the operator was mailed, once the mail has been tried. */
export async function markRestoreRequestNotified(id: string, notified: boolean): Promise<void> {
  if (!databaseEnabled()) {
    const rows = readJsonl<RestoreRequest>(requestsFile());
    const r = rows.find((x) => x.id === id);
    if (!r) return;
    r.notified = notified;
    fs.writeFileSync(requestsFile(), rows.map((x) => JSON.stringify(x)).join("\n") + "\n", { mode: 0o600 });
    return;
  }
  await ormRequired().update(restoreRequests).set({ notified }).where(eq(restoreRequests.id, id));
}

export async function listRestoreRequests(tenant: string, limit = 20): Promise<RestoreRequest[]> {
  if (!databaseEnabled()) {
    return readJsonl<RestoreRequest>(requestsFile())
      .filter((r) => r.tenant === tenant)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, limit);
  }
  const rows = await ormRequired()
    .select()
    .from(restoreRequests)
    .where(eq(restoreRequests.tenant, tenant))
    .orderBy(desc(restoreRequests.at))
    .limit(limit);
  return rows.map((r) => ({ ...r, at: r.at.toISOString() }));
}
