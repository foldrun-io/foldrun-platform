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
// What the operator decides lives in feature_flags, one row per decision
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
// seconds and the cache is dropped on every write. Another pod sees a
// change within FLAG_CACHE_MS.
//
// This repository READS the decisions. Making them — the install-wide
// setting, a rollout, one account's override, each audited as
// `operator.flag.*` — is the hosted operator console's (foldrun-admin,
// platform/src/flags-admin.ts, 30 Oct 2026). An install without one runs
// every flag at its registry default.
//
// Postgres when the install has one; otherwise <data>/.feature-flags.json.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { databaseEnabled, ormRequired } from "./db.ts";
import { featureFlags } from "./schema.ts";

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

export function flagDef(name: string): FlagDef | null {
  return (FLAGS as readonly FlagDef[]).find((f) => f.name === name) ?? null;
}

/** 0–99, the same for this account and flag everywhere, forever. */
export function rolloutBucket(tenant: string, name: string): number {
  return crypto.createHash("sha256").update(`${name}:${tenant}`).digest().readUInt32BE(0) % 100;
}

// ------------------------------------------------------------------ store

const file = () => path.join(dataRoot(), ".feature-flags.json");

/** The rows file, for an install without a database. Exported for the
 *  hosted operator console (foldrun-admin flags-admin.ts), which is what
 *  writes decisions; this repository reads them and drops an account's. */
export function readFlagFile(): FlagRow[] {
  try {
    const rows = JSON.parse(fs.readFileSync(file(), "utf8")) as FlagRow[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export function writeFlagFile(rows: FlagRow[]): void {
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

/** Every decision the operator has made, cached for FLAG_CACHE_MS. */
export async function flagRows(): Promise<FlagRow[]> {
  if (cached && Date.now() - cached.at < FLAG_CACHE_MS) return cached.rows;
  let rows: FlagRow[];
  if (!databaseEnabled()) {
    rows = readFlagFile();
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

/** An account's overrides, for tenant-delete. The audit stays. */
export async function deleteTenantFlags(tenant: string): Promise<void> {
  if (!tenant) return;
  try {
    if (!databaseEnabled()) {
      const rows = readFlagFile();
      const kept = rows.filter((r) => r.tenant !== tenant);
      if (kept.length !== rows.length) writeFlagFile(kept);
      return;
    }
    await ormRequired().delete(featureFlags).where(eq(featureFlags.tenant, tenant));
  } finally {
    resetFlagCache();
  }
}
