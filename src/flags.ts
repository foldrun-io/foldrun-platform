// Feature flags: a change shipped dark and turned on by a decision, not a
// deploy.
//
// The flags are code, like the plans (plans.ts): a name, what it changes,
// who owns it, whether it is on when nobody has said otherwise, and an
// optional rollout percentage. A flag that is not in FLAGS does not exist —
// flagOn() of an unknown name is false, and the routes answer 404 — so a
// typo cannot quietly create one, and retiring a flag is deleting its line
// (the rows left behind are ignored).
//
// What the super admin decides lives in feature_flags, one row per decision
// that differs from the code:
//
//   tenant ''          the install-wide row: `enabled` on/off for everyone
//                      not overridden, and/or `rollout` 0–100
//   tenant <account>   that account's override: `enabled` alone
//
// flagOn(tenant, name) is, in order: the account's override, else the
// install-wide on/off, else the rollout (the install-wide row's, else the
// registry's) by a stable hash of flag and account — the same account lands
// in the same bucket on every pod and every boot, and raising the
// percentage only ever adds accounts — else the registry's default.
//
// Read on request paths, so the rows are cached in the process for a few
// seconds and the cache is dropped on every write here. Another pod sees a
// change within FLAG_CACHE_MS. Every write is on the audit as
// `operator.flag.*`, in the same transaction as the row.
//
// Postgres when the install has one; otherwise <data>/.feature-flags.json.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { databaseEnabled, ormRequired, tx } from "./db.ts";
import { auditLog, featureFlags } from "./schema.ts";
import { appendAudit, platformAccount } from "./admin.ts";

export interface FlagDef {
  /** kebab-case; what flagOn() and the API name it by. */
  name: string;
  /** What turning it on changes, for the console and the account's settings. */
  description: string;
  /** Who answers for it — a person or a team. */
  owner: string;
  /** On when nothing else decides. */
  default: boolean;
  /** 0–100: the share of accounts it reaches when no override decides.
   *  Absent: the default decides. */
  rollout?: number;
}

/**
 * Every flag the platform knows. Add a line to ship something dark; delete
 * the line (and the code that asks) once it is on for everyone.
 */
export const FLAGS = [
  {
    name: "example-flag",
    description: "The registered example. Off by default and read by nothing: turning it on changes no behaviour. Use it to try the console, the API and the CLI.",
    owner: "platform",
    default: false,
  },
] as const satisfies readonly FlagDef[];

export type FlagName = (typeof FLAGS)[number]["name"];

/** How long a pod trusts the rows it read. */
export const FLAG_CACHE_MS = 10_000;

export type FlagSource = "account" | "global" | "rollout" | "default";

export interface FlagRow {
  flag: string;
  /** '' for the install-wide row. */
  tenant: string;
  enabled: boolean | null;
  rollout: number | null;
  updatedBy: string;
  updatedAt: string;
}

export interface EffectiveFlag {
  name: string;
  description: string;
  owner: string;
  default: boolean;
  on: boolean;
  /** What decided it. */
  source: FlagSource;
  /** The rollout in force, when one is. */
  rollout: number | null;
}

/** A refusal with the status the route should answer. */
export class FlagError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const SAFE_TENANT = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function flagDef(name: string): FlagDef | null {
  return (FLAGS as readonly FlagDef[]).find((f) => f.name === name) ?? null;
}

function requireDef(name: string): FlagDef {
  const def = flagDef(name);
  if (!def) throw new FlagError(`no flag "${name}" — one of ${FLAGS.map((f) => f.name).join(", ")}`, 404);
  return def;
}

/** 0–99, the same for this account and flag everywhere, forever. */
export function rolloutBucket(tenant: string, name: string): number {
  return crypto.createHash("sha256").update(`${name}:${tenant}`).digest().readUInt32BE(0) % 100;
}

// ------------------------------------------------------------------ store

const file = () => path.join(dataRoot(), ".feature-flags.json");

function readFileRows(): FlagRow[] {
  try {
    const rows = JSON.parse(fs.readFileSync(file(), "utf8")) as FlagRow[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function writeFileRows(rows: FlagRow[]): void {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = `${file()}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file());
}

let cached: { at: number; rows: FlagRow[] } | null = null;

/** Drop the cached rows — every write does; tests do between cases. */
export function resetFlagCache(): void {
  cached = null;
}

/** Every decision the super admin has made, cached for FLAG_CACHE_MS. */
export async function flagRows(): Promise<FlagRow[]> {
  if (cached && Date.now() - cached.at < FLAG_CACHE_MS) return cached.rows;
  let rows: FlagRow[];
  if (!databaseEnabled()) {
    rows = readFileRows();
  } else {
    rows = (await ormRequired().select().from(featureFlags)).map((r) => ({
      flag: r.flag,
      tenant: r.tenant,
      enabled: r.enabled,
      rollout: r.rollout,
      updatedBy: r.updatedBy,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }
  cached = { at: Date.now(), rows };
  return rows;
}

// ------------------------------------------------------------- evaluating

function evaluate(def: FlagDef, tenant: string, rows: FlagRow[]): EffectiveFlag {
  const mine = rows.find((r) => r.flag === def.name && r.tenant === tenant && tenant !== "");
  const global = rows.find((r) => r.flag === def.name && r.tenant === "");
  const rollout = global?.rollout ?? def.rollout ?? null;
  const base = { name: def.name, description: def.description, owner: def.owner, default: def.default, rollout };
  if (mine && mine.enabled !== null) return { ...base, on: mine.enabled, source: "account" };
  if (global && global.enabled !== null) return { ...base, on: global.enabled, source: "global" };
  if (rollout !== null) return { ...base, on: rolloutBucket(tenant, def.name) < rollout, source: "rollout" };
  return { ...base, on: def.default, source: "default" };
}

/** Is this flag on for this account? Unknown flags are off. */
export async function flagOn(tenant: string, name: FlagName | (string & {})): Promise<boolean> {
  const def = flagDef(name);
  if (!def) return false;
  return evaluate(def, tenant, await flagRows()).on;
}

/** Every flag as it stands for one account, and why. */
export async function effectiveFlags(tenant: string): Promise<EffectiveFlag[]> {
  const rows = await flagRows();
  return FLAGS.map((def) => evaluate(def, tenant, rows));
}

export interface FlagOverview extends FlagDef {
  /** The install-wide row, or null when the registry decides. */
  global: { enabled: boolean | null; rollout: number | null; updatedBy: string; updatedAt: string } | null;
  /** Accounts with their own setting, by name. */
  accounts: { tenant: string; enabled: boolean; updatedBy: string; updatedAt: string }[];
}

/** The console's picture: every flag, its install-wide state and the accounts that differ. */
export async function flagOverview(): Promise<FlagOverview[]> {
  const rows = await flagRows();
  return FLAGS.map((def) => {
    const g = rows.find((r) => r.flag === def.name && r.tenant === "");
    return {
      ...def,
      global: g ? { enabled: g.enabled, rollout: g.rollout, updatedBy: g.updatedBy, updatedAt: g.updatedAt } : null,
      accounts: rows
        .filter((r) => r.flag === def.name && r.tenant !== "" && r.enabled !== null)
        .map((r) => ({ tenant: r.tenant, enabled: r.enabled as boolean, updatedBy: r.updatedBy, updatedAt: r.updatedAt }))
        .sort((a, b) => a.tenant.localeCompare(b.tenant)),
    };
  });
}

// ---------------------------------------------------------------- writing

function checkRollout(v: unknown): number | null {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 100) throw new FlagError("rollout: a whole number from 0 to 100, or null", 400);
  return v;
}

/**
 * Write one row, or remove it (`row` null), and its audit line — one
 * transaction with a database, so a change without its audit cannot exist.
 */
async function writeRow(name: string, tenant: string, row: { enabled: boolean | null; rollout: number | null } | null, by: string, action: string, detail: Record<string, unknown>): Promise<void> {
  const auditTenant = tenant || platformAccount();
  const at = new Date();
  try {
    if (!databaseEnabled()) {
      const rows = readFileRows().filter((r) => !(r.flag === name && r.tenant === tenant));
      if (row) rows.push({ flag: name, tenant, enabled: row.enabled, rollout: row.rollout, updatedBy: by, updatedAt: at.toISOString() });
      writeFileRows(rows);
      await appendAudit({ t: at.toISOString(), by, tenant: auditTenant, action, detail });
      return;
    }
    await tx(async (t) => {
      if (row) {
        await t
          .insert(featureFlags)
          .values({ flag: name, tenant, enabled: row.enabled, rollout: row.rollout, updatedBy: by, updatedAt: at })
          .onConflictDoUpdate({ target: [featureFlags.flag, featureFlags.tenant], set: { enabled: row.enabled, rollout: row.rollout, updatedBy: by, updatedAt: at } });
      } else {
        await t.delete(featureFlags).where(and(eq(featureFlags.flag, name), eq(featureFlags.tenant, tenant)));
      }
      await t.insert(auditLog).values({ tenant: auditTenant, actor: by, action: `operator.${action}`, subject: null, detail });
    });
  } finally {
    resetFlagCache();
  }
}

/**
 * The install-wide row. `enabled`: true/false for everyone not overridden,
 * null to let the rollout or the default decide. `rollout`: 0–100, or null
 * for the registry's. A field left out keeps what the row had; both null
 * removes the row. Audited as `operator.flag.global`.
 */
export async function setGlobalFlag(name: string, patch: { enabled?: unknown; rollout?: unknown }, by: string): Promise<FlagOverview> {
  requireDef(name);
  if (!("enabled" in patch) && !("rollout" in patch)) throw new FlagError("expected { enabled?: true | false | null, rollout?: 0–100 | null }", 400);
  if ("enabled" in patch && patch.enabled !== null && typeof patch.enabled !== "boolean") throw new FlagError("enabled: true, false or null", 400);
  const before = (await flagRows()).find((r) => r.flag === name && r.tenant === "");
  const enabled = "enabled" in patch ? (patch.enabled as boolean | null) : (before?.enabled ?? null);
  const rollout = "rollout" in patch ? checkRollout(patch.rollout) : (before?.rollout ?? null);
  const row = enabled === null && rollout === null ? null : { enabled, rollout };
  await writeRow(name, "", row, by, row ? "flag.global" : "flag.global_cleared", {
    flag: name,
    enabled,
    rollout,
    before: before ? { enabled: before.enabled, rollout: before.rollout } : null,
  });
  return (await flagOverview()).find((f) => f.name === name)!;
}

/** Remove the install-wide row: the registry decides again. */
export async function clearGlobalFlag(name: string, by: string): Promise<FlagOverview> {
  return setGlobalFlag(name, { enabled: null, rollout: null }, by);
}

/** One account's override: on or off whatever else says. Audited as
 *  `operator.flag.account` against that account. */
export async function setAccountFlag(tenant: string, name: string, enabled: unknown, by: string): Promise<EffectiveFlag> {
  requireDef(name);
  if (!SAFE_TENANT.test(tenant)) throw new FlagError(`bad account name: ${tenant}`, 400);
  if (typeof enabled !== "boolean") throw new FlagError("expected { enabled: true | false }", 400);
  const before = (await flagRows()).find((r) => r.flag === name && r.tenant === tenant);
  await writeRow(name, tenant, { enabled, rollout: null }, by, "flag.account", { flag: name, enabled, before: before?.enabled ?? null });
  return (await effectiveFlags(tenant)).find((f) => f.name === name)!;
}

/** Remove one account's override. Audited as `operator.flag.account_cleared`. */
export async function clearAccountFlag(tenant: string, name: string, by: string): Promise<EffectiveFlag> {
  requireDef(name);
  if (!SAFE_TENANT.test(tenant)) throw new FlagError(`bad account name: ${tenant}`, 400);
  const before = (await flagRows()).find((r) => r.flag === name && r.tenant === tenant);
  if (before) await writeRow(name, tenant, null, by, "flag.account_cleared", { flag: name, before: before.enabled });
  return (await effectiveFlags(tenant)).find((f) => f.name === name)!;
}

/** An account's overrides, for tenant-delete. The audit stays. */
export async function deleteTenantFlags(tenant: string): Promise<void> {
  if (!tenant) return;
  try {
    if (!databaseEnabled()) {
      const rows = readFileRows();
      const kept = rows.filter((r) => r.tenant !== tenant);
      if (kept.length !== rows.length) writeFileRows(kept);
      return;
    }
    await ormRequired().delete(featureFlags).where(eq(featureFlags.tenant, tenant));
  } finally {
    resetFlagCache();
  }
}
