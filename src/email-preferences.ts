// What mail each address takes.
//
// core/mail.ts asks `mailPreference(tenant, email, category, workspace)`
// before every optional send; this is the answer. A row is a choice someone
// made — on Profile → Notifications, with `foldrun notifications set`, or by
// an unsubscribe link — and no row is the default, which is on. A row for one
// workspace beats the account-wide row ('' workspace), so "no run alerts
// except from billing-desk" is two rows.
//
// Keyed by address, not by login: a workspace's notify: email need not
// belong to a person with an account, and whoever reads it is owed a working
// unsubscribe all the same. Required categories are refused here as well as
// in the UI — a preference store that could hold "security: off" is one bug
// away from a person who cannot reset their password.
//
// Postgres when the install has one (email_preferences); otherwise one JSON
// file per account under <data>/.email-preferences/.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { MAIL_CATEGORIES, mailCategory, type MailCategory } from "../../foldrun-core/src/mail.ts";
import { databaseEnabled, ormRequired } from "./db.ts";
import { emailPreferences } from "./schema.ts";

export interface PreferenceRow {
  category: MailCategory;
  /** '' for the whole account. */
  workspace: string;
  enabled: boolean;
  source: "settings" | "unsubscribe" | "api";
  updatedAt: string;
}

/** A refusal with the status the route should answer. */
export class PreferenceError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const norm = (email: string) => email.trim().toLowerCase();

// ------------------------------------------------------------------ files

type TenantFile = Record<string, PreferenceRow[]>;
const dir = () => path.join(dataRoot(), ".email-preferences");
const fileOf = (tenant: string) => path.join(dir(), `${tenant.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`);

function readFile(tenant: string): TenantFile {
  try {
    return JSON.parse(fs.readFileSync(fileOf(tenant), "utf8")) as TenantFile;
  } catch {
    return {};
  }
}

const locks = new Map<string, Promise<unknown>>();
function locked<T>(tenant: string, fn: (f: TenantFile) => T): Promise<T> {
  const run = (locks.get(tenant) ?? Promise.resolve()).then(() => {
    const f = readFile(tenant);
    const out = fn(f);
    fs.mkdirSync(dir(), { recursive: true });
    const tmp = `${fileOf(tenant)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
    fs.writeFileSync(tmp, JSON.stringify(f), { mode: 0o600 });
    fs.renameSync(tmp, fileOf(tenant));
    return out;
  });
  locks.set(tenant, run.catch(() => undefined));
  return run;
}

// ---------------------------------------------------------------- reading

/** Every choice this address has made in this account. */
export async function listPreferences(tenant: string, email: string): Promise<PreferenceRow[]> {
  const who = norm(email);
  if (!databaseEnabled()) return readFile(tenant)[who] ?? [];
  const rows = await ormRequired()
    .select()
    .from(emailPreferences)
    .where(and(eq(emailPreferences.tenant, tenant), eq(emailPreferences.email, who)));
  return rows.map((r) => ({
    category: r.category as MailCategory,
    workspace: r.workspace,
    enabled: r.enabled,
    source: r.source as PreferenceRow["source"],
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/** The decision for one send. Required mail is always yes. */
export async function mailAllowed(tenant: string, email: string, category: string, workspace: string | null): Promise<boolean> {
  const cat = mailCategory(category);
  if (!cat || cat.required) return true;
  const rows = (await listPreferences(tenant, email)).filter((r) => r.category === cat.id);
  const own = cat.perWorkspace && workspace ? rows.find((r) => r.workspace === workspace) : undefined;
  const all = rows.find((r) => r.workspace === "");
  return (own ?? all)?.enabled ?? true;
}

/**
 * The whole picture for one address, as the settings page and the CLI show
 * it: every category, whether it is on account-wide, and the workspaces
 * that differ.
 */
export async function preferenceSummary(tenant: string, email: string) {
  const rows = await listPreferences(tenant, email);
  return MAIL_CATEGORIES.map((c) => {
    const mine = rows.filter((r) => r.category === c.id);
    return {
      category: c.id,
      label: c.label,
      description: c.description,
      required: c.required,
      ...(c.why ? { why: c.why } : {}),
      perWorkspace: c.perWorkspace,
      enabled: c.required ? true : mine.find((r) => r.workspace === "")?.enabled ?? true,
      workspaces: c.perWorkspace
        ? Object.fromEntries(mine.filter((r) => r.workspace !== "").map((r) => [r.workspace, r.enabled]))
        : {},
    };
  });
}

// ---------------------------------------------------------------- writing

/**
 * Turn a category on or off for an address — account-wide, or for one
 * workspace when the category is per workspace. Turning a required one off
 * is refused (409, with the reason); turning it "on" is a no-op.
 * `workspace: null` with `enabled: true` on the account row also clears
 * any per-workspace offs, so "on" from the unsubscribe page means on.
 */
export async function setPreference(
  tenant: string,
  email: string,
  category: string,
  enabled: boolean,
  opts: { workspace?: string | null; source?: PreferenceRow["source"] } = {},
): Promise<void> {
  const cat = mailCategory(category);
  if (!cat) throw new PreferenceError(`no category "${category}" — one of ${MAIL_CATEGORIES.map((c) => c.id).join(", ")}`, 400);
  if (cat.required) {
    if (enabled) return;
    throw new PreferenceError(`${cat.label} mail cannot be turned off: ${cat.why}`, 409);
  }
  const workspace = opts.workspace ?? "";
  if (workspace && !cat.perWorkspace) throw new PreferenceError(`${cat.label} is account-wide — it is not set per workspace`, 400);
  const who = norm(email);
  if (!who.includes("@")) throw new PreferenceError("an email address is needed", 400);
  const source = opts.source ?? "settings";
  const at = new Date();
  if (!databaseEnabled()) {
    await locked(tenant, (f) => {
      const rows = (f[who] ?? []).filter((r) => !(r.category === cat.id && r.workspace === workspace));
      // Back on for the account means back on everywhere.
      const kept = enabled && !workspace ? rows.filter((r) => r.category !== cat.id) : rows;
      f[who] = [...kept, { category: cat.id, workspace, enabled, source, updatedAt: at.toISOString() }];
    });
    return;
  }
  const q = ormRequired();
  if (enabled && !workspace) {
    await q.delete(emailPreferences).where(and(eq(emailPreferences.tenant, tenant), eq(emailPreferences.email, who), eq(emailPreferences.category, cat.id)));
  }
  await q
    .insert(emailPreferences)
    .values({ tenant, email: who, category: cat.id, workspace, enabled, source, updatedAt: at })
    .onConflictDoUpdate({
      target: [emailPreferences.tenant, emailPreferences.email, emailPreferences.category, emailPreferences.workspace],
      set: { enabled, source, updatedAt: at },
    });
}

/** An account's rows, for tenant-delete. */
export async function deleteTenantPreferences(tenant: string): Promise<void> {
  if (!databaseEnabled()) {
    fs.rmSync(fileOf(tenant), { force: true });
    return;
  }
  await ormRequired().delete(emailPreferences).where(eq(emailPreferences.tenant, tenant));
}
