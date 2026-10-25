// The super admin's side of an account: what the platform knows about a
// customer that the customer does not set and cannot see.
//
// An account's own directory is the customer's — it is what a backup holds,
// what tenant-delete removes, what an export would hand them. What the
// OPERATOR records about an account (suspended, on what plan, a note from
// the last support call) is not theirs and does not travel with them, so it
// lives beside the accounts, not inside one:
//
//   operator_accounts   one row per account: the state
//   audit_log           every change, as `operator.<action>`, by whom, forever
//
// (Without a database: <data>/operator/accounts/<tenant>.json and
// <data>/operator/audit.jsonl, as before. `operator/` holds no workspaces/
// directory, so listTenants() never mistakes it for an account.)
//
// Read by the queue (a suspended account starts no runs), by the wallet (the
// plan lane overrides the account's own frontmatter), and by the super admin
// console in the dashboard, which is the only writer. Hosted-only in effect:
// nothing sets any of this on a self-hosted install, and every read of an
// absent file is the same as "an ordinary account".

import fs from "node:fs";
import path from "node:path";
import { desc, eq, like, and } from "drizzle-orm";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { databaseEnabled, ormRequired, tx } from "./db.ts";
import { auditLog, operatorAccounts } from "./schema.ts";
import type { OperatorPlan, OperatorWaive } from "./billing.ts";

const SAFE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface AdminContact {
  name?: string;
  email?: string;
  phone?: string;
  company?: string;
  /** Australian Business Number, or the local equivalent. */
  abn?: string;
}

export interface AdminState {
  /** Set while the account may not start runs. Login still works — a
   *  suspended customer must still be able to read the notice and talk to
   *  someone — and runs in flight finish; new ones are refused with the
   *  reason. */
  suspended?: { at: string; by: string; reason: string };
  /** The operator's plan for this customer (foldrun-admin sets it). */
  plan?: OperatorPlan;
  /** Set while the account may spend below zero. Absent means the
   *  ordinary rule: no credit, no new run. */
  overdraft?: { limitUsd: number | null; by: string; at: string; note?: string };
  /** Charges this account does not pay. Absent means it pays for
   *  everything, which is what every ordinary customer does. */
  waive?: OperatorWaive & { by: string; at: string; note?: string };
  /** Free text for the next admin who opens this account. */
  notes?: string;
  /** Who to call about the account, as the super admin recorded it — the
   *  owner's login email is a login, not always the person who pays. */
  contact?: AdminContact;
  /** The owner asked for the account to be closed. Closing suspends it and
   *  lands here; deleting the data stays a human decision, made after the
   *  last invoice and any refund are settled. */
  closeRequested?: { at: string; by: string; reason?: string };
  /** The HTTP API version this account's requests get when they send no
   *  Foldrun-Version header (YYYY-MM-DD). Absent: the current version.
   *  Set by the owner or an admin in Settings → API; foldrun-web
   *  server/api-version.ts is what reads it. */
  apiVersion?: string;
  /** The customer's own kill switch: no new run starts in the account, or
   *  in the workspaces named. Not `suspended` — that is the platform's lever
   *  (dunning, a closed account, an admin), and a customer's resume must
   *  never lift it. A mark stays after a resume with `resumedAt`, so the
   *  fires that fell inside the pause are not reported as missed. */
  paused?: { account?: PauseMark; workspaces?: Record<string, PauseMark> };
  updatedAt?: string;
  updatedBy?: string;
}

export interface PauseMark {
  at: string;
  by: string;
  reason?: string;
  /** Set by a resume; a mark with it is history, not a pause. */
  resumedAt?: string;
  /** Pauses before this one, kept for a week and a day: the missed-fire
   *  check looks back a week, and a pause–resume–pause must not turn the
   *  first window's held fires into "missed" (Codex review). */
  earlier?: { from: string; to: string }[];
}

/** A workspace's own mark — own keys only: a workspace may be called
 *  `constructor` (Codex review). */
export function workspacePause(state: AdminState, workspace: string): PauseMark | undefined {
  const all = state.paused?.workspaces;
  return all && Object.hasOwn(all, workspace) ? all[workspace] : undefined;
}

/** How long a finished pause window is kept — the missed-fire lookback and a day. */
const PAUSE_HISTORY_MS = 8 * 86_400_000;

export interface AuditEntry {
  t: string;
  /** The super admin's email. */
  by: string;
  tenant: string;
  action: string;
  detail?: Record<string, unknown>;
}

/** The state lives under <data>/operator/ — the directory's name is what
 *  it was when the box first wrote it, and renaming a directory on a live
 *  volume is a migration, not a word change. */
function adminDir() {
  return path.join(dataRoot(), "operator");
}
function stateFile(tenant: string) {
  if (!SAFE.test(tenant)) throw new Error(`bad tenant name: ${tenant}`);
  return path.join(adminDir(), "accounts", `${tenant}.json`);
}
function auditFile() {
  return path.join(adminDir(), "audit.jsonl");
}

/**
 * The platform's own account: the one the SaaS owner signs in to. Its owner
 * is the super admin — the person who manages every other account — and
 * that is the whole rule. `foldrun` on the hosted platform, which is what
 * the bootstrap creates; FOLDRUN_PLATFORM_ACCOUNT names another.
 */
export function platformAccount(): string {
  return (process.env.FOLDRUN_PLATFORM_ACCOUNT ?? "foldrun").trim();
}

/**
 * Is this person the super admin?
 *
 * The owner of the platform's own account is, and nobody else. That is who
 * the SaaS belongs to, and ownership is already the most guarded thing in
 * the system: one per account, transferred only by the owner, never held
 * by an API key. No list of emails, no second door: to change who runs the
 * platform, transfer the platform account. Here rather than in the console
 * because the session route needs it to tell the browser whether to draw
 * the door.
 */
export function isSuperAdmin(who: { tenant?: string | null; owner?: boolean | null } | null | undefined): boolean {
  return Boolean(who?.owner && who.tenant && who.tenant === platformAccount());
}

function readStateFile(tenant: string): AdminState {
  try {
    return JSON.parse(fs.readFileSync(stateFile(tenant), "utf8")) as AdminState;
  } catch {
    return {};
  }
}

export async function adminState(tenant: string): Promise<AdminState> {
  if (!databaseEnabled()) return readStateFile(tenant);
  const [r] = await ormRequired().select({ state: operatorAccounts.state }).from(operatorAccounts).where(eq(operatorAccounts.tenant, tenant));
  return (r?.state as AdminState) ?? {};
}

/** How an operator action is named on the audit: `operator.<action>`,
 *  words joined by `_` — the names the dashboard's own audit uses, so one
 *  query over audit_log reads both. An action already dotted (the plan
 *  cycle's `plan.cycle`) keeps its family under the prefix. */
const auditAction = (action: string) => `operator.${action.replaceAll("-", "_")}`;

/** Merge `patch` into the account's admin state and write the audit
 *  line for it — one transaction, so a change without its audit cannot exist. */
export async function updateAdminState(
  tenant: string,
  patch: Partial<AdminState>,
  by: string,
  action: string,
  detail?: Record<string, unknown>,
): Promise<AdminState> {
  if (!SAFE.test(tenant)) throw new Error(`bad tenant name: ${tenant}`);
  const at = new Date().toISOString();
  if (!databaseEnabled()) {
    const next: AdminState = { ...readStateFile(tenant), ...patch, updatedAt: at, updatedBy: by };
    const file = stateFile(tenant);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
    await appendAudit({ t: at, by, tenant, action, detail });
    return next;
  }
  return tx(async (t) => {
    await t.insert(operatorAccounts).values({ tenant, state: {} }).onConflictDoNothing({ target: operatorAccounts.tenant });
    const [row] = await t.select({ state: operatorAccounts.state }).from(operatorAccounts).where(eq(operatorAccounts.tenant, tenant)).for("update");
    const next: AdminState = { ...((row?.state as AdminState) ?? {}), ...patch, updatedAt: at, updatedBy: by };
    // JSON drops undefined keys; a jsonb write must drop them the same way,
    // or `{ suspended: undefined }` would not lift a suspension.
    const stored = JSON.parse(JSON.stringify(next)) as AdminState;
    await t.update(operatorAccounts).set({ state: stored, updatedAt: new Date(at) }).where(eq(operatorAccounts.tenant, tenant));
    await t.insert(auditLog).values({ tenant, actor: by, action: auditAction(action), subject: null, detail: detail ?? {} });
    return stored;
  });
}

/** Pause or resume runs in the account (`workspace` absent) or one
 *  workspace — the customer's own switch. Read-merge-write in one
 *  transaction like updateAdminState, but NOT audited as an operator
 *  action: the caller (a person or a key) writes its own audit line. */
export async function setPaused(
  tenant: string,
  workspace: string | null,
  change: { pause: { by: string; reason?: string } } | { resume: { by: string } },
): Promise<AdminState> {
  if (!SAFE.test(tenant)) throw new Error(`bad tenant name: ${tenant}`);
  const at = new Date().toISOString();
  const apply = (prev: AdminState): AdminState => {
    const paused = { ...(prev.paused ?? {}), workspaces: { ...(prev.paused?.workspaces ?? {}) } };
    const current = workspace ? workspacePause(prev, workspace) : paused.account;
    let mark: PauseMark | undefined;
    if ("pause" in change) {
      // Pausing what is already paused keeps the first mark: when it began
      // is what the missed-fire window and the banner both need.
      if (current && !current.resumedAt) mark = current;
      else {
        const keep = Date.parse(at) - PAUSE_HISTORY_MS;
        const earlier = [
          ...(current?.earlier ?? []),
          ...(current?.resumedAt ? [{ from: current.at, to: current.resumedAt }] : []),
        ].filter((w) => Date.parse(w.to) >= keep);
        mark = { at, by: change.pause.by, ...(change.pause.reason ? { reason: change.pause.reason } : {}), ...(earlier.length ? { earlier } : {}) };
      }
    } else {
      mark = current && !current.resumedAt ? { ...current, resumedAt: at } : current;
    }
    if (workspace) {
      // fromEntries, not `[workspace] =`: an own property whatever the name.
      if (mark) paused.workspaces = Object.fromEntries([...Object.entries(paused.workspaces).filter(([k]) => k !== workspace), [workspace, mark]]);
    } else if (mark) paused.account = mark;
    return { ...prev, paused, updatedAt: at, updatedBy: "pause" in change ? change.pause.by : change.resume.by };
  };
  if (!databaseEnabled()) {
    const next = apply(readStateFile(tenant));
    const file = stateFile(tenant);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
    return next;
  }
  return tx(async (t) => {
    await t.insert(operatorAccounts).values({ tenant, state: {} }).onConflictDoNothing({ target: operatorAccounts.tenant });
    const [row] = await t.select({ state: operatorAccounts.state }).from(operatorAccounts).where(eq(operatorAccounts.tenant, tenant)).for("update");
    const stored = JSON.parse(JSON.stringify(apply((row?.state as AdminState) ?? {}))) as AdminState;
    await t.update(operatorAccounts).set({ state: stored, updatedAt: new Date(at) }).where(eq(operatorAccounts.tenant, tenant));
    return stored;
  });
}

/** What holds runs in this workspace now — the account's pause first, as
 *  the wider one — or null. */
export function pauseOf(state: AdminState, workspace: string | null): (PauseMark & { scope: "account" | "workspace" }) | null {
  const a = state.paused?.account;
  if (a && !a.resumedAt) return { ...a, scope: "account" };
  const w = workspace ? workspacePause(state, workspace) : undefined;
  if (w && !w.resumedAt) return { ...w, scope: "workspace" };
  return null;
}

/** Every pause window, past or present, that covers this workspace — for
 *  the missed-fire check, which must not call a paused hour "missed". */
export function pauseWindows(state: AdminState, workspace: string): { from: number; to: number | null }[] {
  return [state.paused?.account, workspacePause(state, workspace)]
    .filter((m): m is PauseMark => !!m)
    .flatMap((m) => [
      ...(m.earlier ?? []).map((w) => ({ from: Date.parse(w.from), to: Date.parse(w.to) })),
      { from: Date.parse(m.at), to: m.resumedAt ? Date.parse(m.resumedAt) : null },
    ]);
}

/** Thrown where a run would start in a paused account or workspace. 423,
 *  like a suspension, and the message says who paused it and how to undo. */
export class RunsPaused extends Error {
  status = 423;
  constructor(workspace: string, mark: PauseMark & { scope: "account" | "workspace" }) {
    super(
      `${mark.scope === "account" ? "this account" : `workspace ${workspace}`} is paused — no new runs (by ${mark.by} at ${mark.at.slice(0, 16).replace("T", " ")}Z${mark.reason ? `: ${mark.reason}` : ""}). Resume it in Settings or \`foldrun ${mark.scope === "account" ? "account" : "workspace"} resume\`.`,
    );
  }
}

export async function assertNotPaused(tenant: string, workspace: string): Promise<void> {
  const mark = pauseOf(await adminState(tenant), workspace);
  if (mark) throw new RunsPaused(workspace, mark);
}

/** For actions that change something OTHER than the state — a ledger
 *  adjustment, a member removed — and still belong on the record. */
export async function appendAudit(entry: AuditEntry): Promise<void> {
  if (!databaseEnabled()) {
    const file = auditFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // O_APPEND: a whole line lands whole even if two admins act at once.
    fs.appendFileSync(file, JSON.stringify(entry) + "\n");
    return;
  }
  await ormRequired().insert(auditLog).values({
    tenant: entry.tenant,
    actor: entry.by,
    action: auditAction(entry.action),
    subject: null,
    detail: entry.detail ?? {},
    ...(entry.t ? { at: new Date(entry.t) } : {}),
  });
}

/** Newest first. `tenant` narrows to one account. Actions read without
 *  their `operator.` prefix, as the console always showed them. */
export async function readAudit(opts: { tenant?: string; limit?: number } = {}): Promise<AuditEntry[]> {
  const limit = opts.limit ?? 200;
  if (!databaseEnabled()) {
    let lines: string[];
    try {
      lines = fs.readFileSync(auditFile(), "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
    const out: AuditEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const e = JSON.parse(lines[i]) as AuditEntry;
        if (!opts.tenant || e.tenant === opts.tenant) out.push(e);
      } catch {
        // a torn line from a crash mid-write is skipped, not fatal
      }
    }
    return out;
  }
  const where = opts.tenant ? and(like(auditLog.action, "operator.%"), eq(auditLog.tenant, opts.tenant)) : like(auditLog.action, "operator.%");
  const rows = await ormRequired()
    .select({ at: auditLog.at, actor: auditLog.actor, tenant: auditLog.tenant, action: auditLog.action, detail: auditLog.detail })
    .from(auditLog)
    .where(where)
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(Math.min(limit, 1000));
  return rows.map((r) => ({
    t: r.at.toISOString(),
    by: r.actor,
    tenant: r.tenant ?? "",
    action: r.action.replace(/^operator\./, ""),
    detail: r.detail as Record<string, unknown>,
  }));
}

/** The files into rows, once: each account's state (a row already there is
 *  kept — it is newer) and every audit line. The directory is then renamed
 *  so the import cannot run twice. */
export async function importOperatorFiles(): Promise<{ accounts: number; audit: number }> {
  const out = { accounts: 0, audit: 0 };
  if (!databaseEnabled() || !fs.existsSync(adminDir())) return out;
  const accounts = path.join(adminDir(), "accounts");
  if (fs.existsSync(accounts)) {
    for (const name of fs.readdirSync(accounts)) {
      if (!name.endsWith(".json")) continue;
      const tenant = name.slice(0, -5);
      if (!SAFE.test(tenant)) continue;
      const state = readStateFile(tenant);
      const got = await ormRequired()
        .insert(operatorAccounts)
        .values({ tenant, state, updatedAt: state.updatedAt ? new Date(state.updatedAt) : new Date() })
        .onConflictDoNothing()
        .returning({ tenant: operatorAccounts.tenant });
      out.accounts += got.length;
    }
  }
  if (fs.existsSync(auditFile())) {
    for (const line of fs.readFileSync(auditFile(), "utf8").split("\n").filter(Boolean)) {
      try {
        await appendAudit(JSON.parse(line) as AuditEntry);
        out.audit++;
      } catch {
        // a torn line is skipped, as it was on read
      }
    }
  }
  fs.renameSync(adminDir(), `${adminDir()}.imported-${new Date().toISOString().slice(0, 10)}`);
  return out;
}

/** The operator's state about a deleted account goes; its audit stays. */
export async function deleteAdminState(tenant: string): Promise<boolean> {
  if (!databaseEnabled()) return false;
  return (await ormRequired().delete(operatorAccounts).where(eq(operatorAccounts.tenant, tenant)).returning({ tenant: operatorAccounts.tenant })).length === 1;
}

/** Thrown where a run would start. 423 Locked: the account exists and
 *  the caller is who they say they are; the account is simply not allowed
 *  to do this right now, and the message says why. */
export class AccountSuspended extends Error {
  status = 423;
  constructor(tenant: string, reason: string) {
    super(`account ${tenant} is suspended: ${reason}`);
  }
}

export async function assertAccountActive(tenant: string): Promise<void> {
  const s = (await adminState(tenant)).suspended;
  if (s) throw new AccountSuspended(tenant, s.reason);
}
