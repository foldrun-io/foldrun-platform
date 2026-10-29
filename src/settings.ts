// Operator settings: what the SaaS operator decides for the whole install —
// prices, sign-up, the fleet's limits, retention, mail — kept as rows the
// platform reads, not as environment a deploy has to change (30 Oct 2026,
// stage 6 of the console separation).
//
// The settings are code, like the flags (flags.ts): a registry of what can
// be set, its type and range, what the code does when nothing is set, and
// the environment variable that used to say it. A setting that is not
// registered does not exist: its row is ignored and no write names it.
//
// What the operator decided lives in platform_settings, one row per key it
// ever set. `value` NULL is a reset (a tombstone): the key falls back as if
// it had never been set. Rows are never deleted, and every write takes a
// fresh `version` from a sequence, so the sum of the versions only ever
// grows — that sum is what the poll compares (a single max() could miss a
// write that committed after a later-numbered one).
//
// Precedence, per key: the row → the legacy environment variable → the
// code's own default. With no rows an install behaves exactly as it did on
// its environment, which is what makes the move safe in both directions.
//
// Read synchronously on request paths: a process snapshot, loaded at boot
// (boot.ts prepare), re-read when the poll sees the fingerprint move
// (SETTINGS_POLL_MS) and at once after a write in this process. A database
// that will not answer keeps the last snapshot. Before the first load the
// environment answers, as it always did.
//
// This repository READS. Writing — the operator console's settings page,
// audited per operator as `operator.setting.*` — is the hosted console's
// (foldrun-admin platform/src/settings-admin.ts), as are the keys only the
// hosted business reads (prices, billing, Stripe), registered from there.
// Without a database the rows are <data>/.platform-settings.json.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { databaseEnabled, ormRequired } from "./db.ts";
import { platformSettings } from "./schema.ts";

export type SettingType = "number" | "integer" | "boolean" | "string";

export type SettingGroup = "pricing" | "billing" | "access" | "limits" | "runner" | "retention" | "mail" | "stripe" | "background";

export const SETTING_GROUPS: { id: SettingGroup; title: string }[] = [
  { id: "pricing", title: "Pricing" },
  { id: "billing", title: "Billing" },
  { id: "access", title: "Sign-up and access" },
  { id: "limits", title: "Limits" },
  { id: "runner", title: "Step sizes" },
  { id: "retention", title: "Retention" },
  { id: "mail", title: "Mail" },
  { id: "stripe", title: "Stripe catalogue" },
  { id: "background", title: "Background work" },
];

/** When a change needs a typed reason (the console asks; the API refuses
 *  without one). `always`: any change. `lower` / `raise`: a number moving
 *  that way. `on` / `off`: a boolean turned that way. */
export type SettingConfirm = "always" | "lower" | "raise" | "on" | "off";

export interface SettingDef {
  /** Dotted, lower case: `pricing.margin`. What the API and rows name. */
  key: string;
  /** The environment variable that said it before, still read when no row
   *  does (the fallback, kept a release after the manifests stop setting it). */
  env: string;
  type: SettingType;
  /** For numbers: the range a write must fall in. */
  min?: number;
  max?: number;
  /** For strings: what a value must look like, and how long it may be. */
  pattern?: RegExp;
  maxLength?: number;
  /** What the code does when neither a row nor the environment says —
   *  shown, never written. null: off / no limit / not set. */
  default: string | number | boolean | null;
  group: SettingGroup;
  label: string;
  /** One line: what it changes, and what 0 or empty means where it means
   *  something. */
  help: string;
  unit?: string;
  /** "run": a run is priced at the value it STARTED under (the run-start
   *  price snapshot), never one changed while it ran. */
  snapshot?: "run";
  confirm?: SettingConfirm;
  /** For a number: 0 (and unset) mean "no limit" — kept for ever, never
   *  expires — so moving to 0 is raising it, and from 0 any figure is
   *  lowering it. Absent: 0 is simply the smallest figure. */
  zeroUnlimited?: boolean;
  /** Only an operator whose role is owner may change it. */
  owner?: boolean;
  /** Registered by the hosted build (foldrun-admin). */
  hosted?: boolean;
}

export type SettingValue = string | number | boolean;

/** A check across keys over the values a change would leave in force. */
export interface SettingRule {
  id: string;
  keys: string[];
  /** A sentence saying what is wrong, or null. `v` reads the effective
   *  value of any key (null where nothing is set). */
  check: (v: (key: string) => SettingValue | null) => string | null;
}

// ------------------------------------------------------------- registry

/** A memory figure for a step class: more than zero (Docker reads 0 as no
 *  limit at all), in Mi or Gi (or Docker's m, g). */
const MEMORY = /^(?=[\d.]*[1-9])\d+(\.\d+)?(Mi|Gi|m|g)$/;

/** Every key the open platform reads. The hosted build adds its own with
 *  registerSettings (foldrun-admin settings-hosted.ts). */
export const OPEN_SETTINGS: SettingDef[] = [
  // Sign-up and access
  { key: "signup.open", env: "FOLDRUN_OPEN_SIGNUP", type: "boolean", default: false, group: "access", label: "Open sign-up", help: "Strangers may create accounts. Off: invite-only once the first account exists.", confirm: "on", owner: true },

  // Limits — the plan for an account with none, and the fleet's guards
  { key: "plan.concurrency", env: "FOLDRUN_PLAN_CONCURRENCY", type: "integer", min: 0, max: 1000, default: null, group: "limits", label: "Runs at once (no plan)", help: "Runs one account drives at once when its plan says nothing. 0: no cap.", unit: "runs" },
  { key: "plan.workspaces", env: "FOLDRUN_PLAN_WORKSPACES", type: "integer", min: 0, max: 10000, default: null, group: "limits", label: "Workspaces (no plan)", help: "Workspaces an account may create when its plan says nothing. 0: no cap.", unit: "workspaces" },
  { key: "account.concurrency", env: "FOLDRUN_ACCOUNT_CONCURRENCY", type: "integer", min: 0, max: 1000, default: null, group: "limits", label: "Fleet share per account", help: "Runs one account may have in flight across every worker, unless its plan gives more. 0: no cap.", unit: "runs" },
  { key: "account.pods", env: "FOLDRUN_ACCOUNT_PODS", type: "integer", min: 0, max: 1000, default: null, group: "limits", label: "Sandboxes per account", help: "Sandboxes one account may have running at once; a fan-out takes turns. 0: no cap.", unit: "pods" },
  { key: "account.vcpu", env: "FOLDRUN_ACCOUNT_VCPU", type: "number", min: 0, max: 1024, default: null, group: "limits", label: "Account cores", help: "Cores one account's running steps may hold together (no plan). 0: no cap.", unit: "cores" },
  { key: "account.memory_gib", env: "FOLDRUN_ACCOUNT_MEMORY_GIB", type: "number", min: 0, max: 4096, default: null, group: "limits", label: "Account memory", help: "GiB one account's running steps may hold together (no plan). 0: no cap.", unit: "GiB" },
  { key: "account.disk_gib", env: "FOLDRUN_ACCOUNT_DISK_GIB", type: "number", min: 0, max: 65536, default: null, group: "limits", label: "Account disk", help: "GiB of disk one account's running steps may be allowed together (no plan). 0: no cap.", unit: "GiB" },
  { key: "step.max_vcpu", env: "FOLDRUN_STEP_MAX_VCPU", type: "number", min: 0, max: 1024, default: null, group: "limits", label: "Most cores per step", help: "A step asking for more fails at once (no plan). 0: no cap beyond the pool.", unit: "cores" },
  { key: "step.max_memory_gib", env: "FOLDRUN_STEP_MAX_MEMORY_GIB", type: "number", min: 0, max: 4096, default: null, group: "limits", label: "Most memory per step", help: "A step asking for more fails at once (no plan). 0: no cap beyond the pool.", unit: "GiB" },
  { key: "step.max_disk_gib", env: "FOLDRUN_STEP_MAX_DISK_GIB", type: "number", min: 0, max: 65536, default: null, group: "limits", label: "Most disk per step", help: "A step asking for more fails at once (no plan). 0: no cap beyond the pool.", unit: "GiB" },
  { key: "room.run_memory_gib", env: "FOLDRUN_RUN_MEMORY_GIB", type: "number", min: 0, max: 65536, default: null, group: "limits", label: "Run namespace memory", help: "Memory the run namespace may reserve; a step waits for room past it. 0: no limit. Never on an autoscaled cluster.", unit: "GiB", owner: true },
  { key: "room.run_disk_gib", env: "FOLDRUN_RUN_DISK_GIB", type: "number", min: 0, max: 1048576, default: null, group: "limits", label: "Run namespace disk", help: "Disk the run namespace's pods may be allowed together; a step waits past it. 0: no limit. Never on an autoscaled cluster.", unit: "GiB", owner: true },
  { key: "pods.search_max", env: "FOLDRUN_SEARCH_MAX_PODS", type: "integer", min: 1, max: 100, default: 3, group: "limits", label: "Search pods per account", help: "The most search pods one account's pool grows to.", unit: "pods" },
  { key: "pods.browser_max", env: "FOLDRUN_BROWSER_MAX_PODS", type: "integer", min: 1, max: 100, default: 4, group: "limits", label: "Browser pods per account", help: "The most browser pods one account's pool grows to.", unit: "pods" },
  { key: "assistant.account_cap", env: "FOLDRUN_ASSISTANT_ACCOUNT_CAP", type: "integer", min: 1, max: 100, default: 3, group: "limits", label: "Assistant replies per account", help: "Assistant replies of one account running at once across every assistant pod.", unit: "replies" },
  { key: "grade.account_limit", env: "FOLDRUN_GRADE_ACCOUNT_LIMIT", type: "integer", min: 1, max: 1000, default: 4, group: "limits", label: "Grades per account per pass", help: "Runs a grader eval grades for one account in one pass.", unit: "runs" },

  // Step sizes — each a pod's hard limits and the figures its seconds are
  // billed at; every step records what it held (`reserved`), so a change
  // never reprices a step that ran.
  { key: "runner.cpus", env: "FOLDRUN_RUNNER_CPUS", type: "number", min: 0.25, max: 64, default: 2, group: "runner", label: "Cores, default size", help: "A default-size step's cores: its limit and its billing weight.", unit: "cores", owner: true },
  { key: "runner.memory", env: "FOLDRUN_RUNNER_MEMORY", type: "string", pattern: MEMORY, maxLength: 12, default: "2g", group: "runner", label: "Memory, default size", help: "A default-size step's memory, e.g. 6Gi: a hard ceiling and a billing weight.", owner: true },
  { key: "runner.cpus_small", env: "FOLDRUN_RUNNER_CPUS_SMALL", type: "number", min: 0.25, max: 64, default: 1, group: "runner", label: "Cores, small", help: "size: small — cores.", unit: "cores", owner: true },
  { key: "runner.memory_small", env: "FOLDRUN_RUNNER_MEMORY_SMALL", type: "string", pattern: MEMORY, maxLength: 12, default: "1Gi", group: "runner", label: "Memory, small", help: "size: small — memory, e.g. 1Gi.", owner: true },
  { key: "runner.cpus_heavy", env: "FOLDRUN_RUNNER_CPUS_HEAVY", type: "number", min: 0.25, max: 64, default: 4, group: "runner", label: "Cores, heavy", help: "size: heavy — cores.", unit: "cores", owner: true },
  { key: "runner.memory_heavy", env: "FOLDRUN_RUNNER_MEMORY_HEAVY", type: "string", pattern: MEMORY, maxLength: 12, default: "8Gi", group: "runner", label: "Memory, heavy", help: "size: heavy — memory, e.g. 8Gi.", owner: true },

  // Retention
  { key: "runs.retention_days", env: "FOLDRUN_RETENTION_DAYS", type: "integer", min: 0, max: 3650, default: null, group: "retention", label: "Run history", help: "Finished runs older than this are pruned by the hourly pass. 0: kept for ever.", unit: "days", confirm: "lower", zeroUnlimited: true, owner: true },
  { key: "webhooks.disable_days", env: "FOLDRUN_WEBHOOK_DISABLE_DAYS", type: "number", min: 1, max: 365, default: 3, group: "retention", label: "Webhook auto-disable", help: "A notify: webhook failing every delivery this long is switched off.", unit: "days" },

  // Mail
  { key: "mail.from", env: "FOLDRUN_EMAIL_FROM", type: "string", pattern: /^[^\r\n<>]{0,80}<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>$|^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/, maxLength: 200, default: "foldrun <hello@foldrun.io>", group: "mail", label: "Sender", help: "The From of the platform's own mail. Its domain must be verified at the mail provider, or every send is refused.", confirm: "always", owner: true },
  { key: "mail.invites_per_day", env: "FOLDRUN_PLATFORM_INVITES_PER_DAY", type: "integer", min: 1, max: 100000, default: 25, group: "mail", label: "Invites per account per day", help: "Recipients one account may invite per day on the platform's mail key.", unit: "recipients" },
  { key: "mail.per_day", env: "FOLDRUN_PLATFORM_MAIL_PER_DAY", type: "integer", min: 1, max: 1000000, default: 200, group: "mail", label: "Other mail per account per day", help: "Recipients of notify:, approvals and the like, per account per day, on the platform's mail key.", unit: "recipients" },

  // Background work
  { key: "schedule.spread_sec", env: "FOLDRUN_SCHEDULE_SPREAD_SEC", type: "integer", min: 0, max: 3600, default: 0, group: "background", label: "Schedule spread", help: "Scheduled runs start up to this many seconds after their minute, the same offset per flow every day. 0: on the minute.", unit: "seconds" },

  // Admission — read by the open reservation gate
  { key: "billing.max_run_exposure", env: "FOLDRUN_MAX_RUN_EXPOSURE", type: "number", min: 0, max: 10000, default: null, group: "billing", label: "Balance held per run", help: "What admission holds of the balance for each unsettled run. 0: the flow's own history decides.", unit: "USD", owner: true },
];

/** Checks across keys. Each names the keys it reads; the hosted build adds
 *  its own. */
export const OPEN_SETTING_RULES: SettingRule[] = [
  {
    id: "runner.sizes-ordered",
    keys: ["runner.cpus_small", "runner.cpus", "runner.cpus_heavy", "runner.memory_small", "runner.memory", "runner.memory_heavy"],
    check: (v) => {
      const c = ["runner.cpus_small", "runner.cpus", "runner.cpus_heavy"].map((k) => Number(v(k)));
      const m = ["runner.memory_small", "runner.memory", "runner.memory_heavy"].map((k) => memoryGiB(String(v(k) ?? "")));
      if (c.every(Number.isFinite) && !(c[0] <= c[1] && c[1] <= c[2])) return "cores must not shrink from small to default to heavy";
      if (m.every((x) => x !== null) && !(m[0]! <= m[1]! && m[1]! <= m[2]!)) return "memory must not shrink from small to default to heavy";
      return null;
    },
  },
  {
    id: "runner.fits-node",
    keys: ["runner.memory", "runner.memory_heavy", "runner.memory_small"],
    // FOLDRUN_NODE_MAX_MEMORY_GIB is infrastructure (the biggest node), not
    // a setting: a class bigger than it could never be placed.
    check: (v) => {
      const node = Number(process.env.FOLDRUN_NODE_MAX_MEMORY_GIB);
      if (!(node > 0)) return null;
      for (const k of ["runner.memory_small", "runner.memory", "runner.memory_heavy"]) {
        const g = memoryGiB(String(v(k) ?? ""));
        if (g !== null && g > node) return `${k} (${v(k)}) is bigger than the largest node (FOLDRUN_NODE_MAX_MEMORY_GIB=${node}): its steps could never start`;
      }
      return null;
    },
  },
  {
    id: "room.fits-heavy",
    keys: ["room.run_memory_gib", "runner.memory_heavy"],
    check: (v) => {
      const room = Number(v("room.run_memory_gib"));
      const heavy = memoryGiB(String(v("runner.memory_heavy") ?? ""));
      return room > 0 && heavy !== null && heavy > room ? `the run namespace (${room} GiB) is smaller than one heavy step (${v("runner.memory_heavy")}): heavy steps would never start` : null;
    },
  },
  {
    id: "step.within-account",
    keys: ["step.max_vcpu", "account.vcpu", "step.max_memory_gib", "account.memory_gib", "step.max_disk_gib", "account.disk_gib"],
    check: (v) => {
      for (const [step, acct] of [["step.max_vcpu", "account.vcpu"], ["step.max_memory_gib", "account.memory_gib"], ["step.max_disk_gib", "account.disk_gib"]]) {
        const s = Number(v(step)), a = Number(v(acct));
        if (s > 0 && a > 0 && s > a) return `${step} (${s}) is more than the whole account may hold (${acct} ${a})`;
      }
      return null;
    },
  },
];

/** "6Gi", "2g", "1536Mi" → GiB, or null for anything else. */
export function memoryGiB(s: string): number | null {
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)(Mi|Gi|m|g)$/);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "Mi" || m[2] === "m" ? n / 1024 : n;
}

// One registry per PROCESS, not per module copy: Next bundles a module
// once per route, and a key the hosted build registered in one bundle must
// be known in every other (core platform.ts does the same, for the same
// reason).
interface Registry {
  defs: Map<string, SettingDef>;
  byEnv: Map<string, SettingDef>;
  rules: SettingRule[];
  snap: Snapshot | null;
  poll: NodeJS.Timeout | null;
  warned: boolean;
}
const RKEY = Symbol.for("foldrun.settings");
const gs = globalThis as unknown as Record<symbol, Registry | undefined>;
const reg: Registry = (gs[RKEY] ??= { defs: new Map(), byEnv: new Map(), rules: [], snap: null, poll: null, warned: false });

/** Add keys (and rules) to the registry. A key or env name registered twice
 *  with a different definition is a programming error. */
export function registerSettings(defs: SettingDef[], rules: SettingRule[] = []): void {
  for (const d of defs) {
    if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(d.key)) throw new Error(`setting key ${d.key}: dotted lower case`);
    const had = reg.defs.get(d.key) ?? reg.byEnv.get(d.env);
    if (had && (had.key !== d.key || had.env !== d.env)) throw new Error(`setting ${d.key} (${d.env}) collides with ${had.key} (${had.env})`);
    reg.defs.set(d.key, d);
    reg.byEnv.set(d.env, d);
  }
  for (const r of rules) if (!reg.rules.some((x) => x.id === r.id)) reg.rules.push(r);
}
registerSettings(OPEN_SETTINGS, OPEN_SETTING_RULES);

export function settingDefs(): SettingDef[] {
  return [...reg.defs.values()];
}
export function settingDef(key: string): SettingDef | null {
  return reg.defs.get(key) ?? null;
}
export function settingRules(): SettingRule[] {
  return [...reg.rules];
}

// --------------------------------------------------------------- values

/** A value as the environment variable spelled it — what every converted
 *  call site already parses: true → "1", false → "0", numbers as written. */
export function envText(def: SettingDef, value: SettingValue): string {
  if (def.type === "boolean") return value === true ? "1" : "0";
  return String(value);
}

/** Check a value for a key. Numbers may arrive as text (a form); booleans
 *  as true/false only. */
export function parseSettingValue(def: SettingDef, raw: unknown): { value: SettingValue } | { error: string } {
  if (def.type === "boolean") {
    if (typeof raw !== "boolean") return { error: `${def.key} is on or off (true or false)` };
    return { value: raw };
  }
  if (def.type === "number" || def.type === "integer") {
    const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw.trim()) : NaN;
    if (!Number.isFinite(n)) return { error: `${def.key} must be a number` };
    if (def.type === "integer" && !Number.isInteger(n)) return { error: `${def.key} must be a whole number` };
    if (def.min !== undefined && n < def.min) return { error: `${def.key} is at least ${def.min}` };
    if (def.max !== undefined && n > def.max) return { error: `${def.key} is at most ${def.max}` };
    return { value: n };
  }
  if (typeof raw !== "string") return { error: `${def.key} must be text` };
  const s = raw.trim();
  if (s.length > (def.maxLength ?? 500)) return { error: `${def.key} is at most ${def.maxLength ?? 500} characters` };
  if (/[\u0000-\u001f\u007f]/.test(s)) return { error: `${def.key} may not hold control characters` };
  if (def.pattern && !def.pattern.test(s)) return { error: `${def.key}: "${s}" is not in the expected form` };
  return { value: s };
}

/** The environment's text for a key, read the way the code reads it: for a
 *  boolean, "1" is on and anything else set is off; for a number, what
 *  Number() makes of it. null when unset, empty or unreadable. */
export function parseEnvValue(def: SettingDef, text: string | undefined): SettingValue | null {
  if (text === undefined || text.trim() === "") return null;
  if (def.type === "boolean") return text.trim() === "1";
  if (def.type === "number" || def.type === "integer") {
    const n = Number(text.trim());
    return Number.isFinite(n) ? n : null;
  }
  return text.trim();
}

// ------------------------------------------------------------- snapshot

export interface SettingRow {
  key: string;
  /** null: reset — no override. */
  value: SettingValue | null;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

interface Snapshot {
  rows: Map<string, SettingRow>;
  /** sum(version) and the row count when this was read: what the poll compares. */
  fingerprint: string;
  /** The largest version, for the price snapshot's version. */
  version: number;
  /** Accounts the operator let use the platform's model credential
   *  (operator_accounts.state.platformKey true), and those it refused
   *  outright (false — beats the legacy environment list). */
  platformKey: Set<string>;
  platformKeyDenied: Set<string>;
  /** When the store last answered. */
  at: number;
}

/** A grant older than this (the store stopped answering) no longer counts:
 *  revoking an account's use of the platform key must not wait on an
 *  outage. Everything else keeps the last snapshot. */
export const PLATFORM_KEY_MAX_AGE_MS = 120_000;

/** How often a pod looks for a change made on another pod. */
export const SETTINGS_POLL_MS = 10_000;

const file = () => path.join(dataRoot(), ".platform-settings.json");

/** The rows file, for an install without a database. No file is no rows;
 *  a file that does not read throws — it must not pass for "nothing set"
 *  (the reader then keeps its last snapshot). */
export function readSettingsFile(): SettingRow[] {
  let text: string;
  try {
    text = fs.readFileSync(file(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const rows = JSON.parse(text) as SettingRow[];
  if (!Array.isArray(rows)) throw new Error(`${file()} is not a list of settings`);
  return rows;
}

export function writeSettingsFile(rows: SettingRow[]): void {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = `${file()}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file());
}

/** Every row, tombstones included, straight from the store. */
export async function readSettingRows(): Promise<SettingRow[]> {
  if (!databaseEnabled()) return readSettingsFile();
  const rows = await ormRequired().select().from(platformSettings);
  return rows.map((r) => ({
    key: r.key,
    value: (r.value ?? null) as SettingValue | null,
    version: Number(r.version),
    updatedBy: r.updatedBy,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

function fingerprintOf(rows: { version: number }[]): string {
  return `${rows.length}:${rows.reduce((n, r) => n + r.version, 0)}`;
}

async function readFingerprint(): Promise<string> {
  if (!databaseEnabled()) return fingerprintOf(readSettingsFile());
  const [r] = (await ormRequired().execute(sql`SELECT count(*)::text AS n, coalesce(sum(version), 0)::text AS s FROM platform_settings`)).rows as { n: string; s: string }[];
  return `${r?.n ?? 0}:${r?.s ?? 0}`;
}

/** The accounts whose operator record grants (or refuses) the platform's
 *  model key. Without a database there is no operator console to set it. */
async function readPlatformKeyAccounts(): Promise<{ allow: Set<string>; deny: Set<string> }> {
  if (!databaseEnabled()) return { allow: new Set(), deny: new Set() };
  const res = await ormRequired().execute(sql`SELECT tenant, state->>'platformKey' AS k FROM operator_accounts WHERE state ? 'platformKey'`);
  const allow = new Set<string>(), deny = new Set<string>();
  for (const r of res.rows as { tenant: string; k: string | null }[]) (r.k === "true" ? allow : deny).add(r.tenant);
  return { allow, deny };
}

// Loads can overlap (the poll and a write's reload): a load that STARTED
// before the one already applied must not replace it.
let started = 0;
let applied = 0;

/** Read every row (and the platform-key accounts) into this process. Keeps
 *  the last snapshot, and says so once, when the store will not answer. */
export async function loadSettings(): Promise<boolean> {
  const gen = ++started;
  try {
    const rows = await readSettingRows();
    const keys = await readPlatformKeyAccounts();
    if (gen < applied) return true;
    applied = gen;
    reg.snap = {
      rows: new Map(rows.map((r) => [r.key, r])),
      fingerprint: fingerprintOf(rows),
      version: rows.reduce((n, r) => Math.max(n, r.version), 0),
      platformKey: keys.allow,
      platformKeyDenied: keys.deny,
      at: Date.now(),
    };
    reg.warned = false;
    return true;
  } catch (err) {
    if (!reg.warned) console.error(`[settings] could not read settings; keeping ${reg.snap ? "the last snapshot" : "the environment"}:`, err instanceof Error ? err.message : err);
    reg.warned = true;
    return false;
  }
}

/** One poll: re-read when another pod changed something. The platform-key
 *  accounts are re-read every time — they are operator records, not rows
 *  here, and a revoked grant must land within one poll. */
export async function pollSettings(): Promise<void> {
  try {
    const fp = await readFingerprint();
    if (!reg.snap || fp !== reg.snap.fingerprint) {
      await loadSettings();
      return;
    }
    const gen = ++started;
    const keys = await readPlatformKeyAccounts();
    if (gen < applied || !reg.snap) return;
    applied = gen;
    reg.snap.platformKey = keys.allow;
    reg.snap.platformKeyDenied = keys.deny;
    reg.snap.at = Date.now();
    reg.warned = false;
  } catch (err) {
    if (!reg.warned) console.error("[settings] poll failed; keeping the last snapshot:", err instanceof Error ? err.message : err);
    reg.warned = true;
  }
}

/** Load now and keep polling. Idempotent; the timer never holds a process open. */
export async function startSettings(): Promise<void> {
  await loadSettings();
  if (reg.poll) return;
  reg.poll = setInterval(() => void pollSettings(), SETTINGS_POLL_MS);
  reg.poll.unref?.();
}

/** Forget the snapshot (tests; a write reloads instead). */
export function resetSettingsSnapshot(): void {
  reg.snap = null;
}

/** The snapshot's version (largest row version; 0 with none). */
export function settingsVersion(): number {
  return reg.snap?.version ?? 0;
}

/** When the snapshot was last confirmed against the store, or null. */
export function settingsLoadedAt(): number | null {
  return reg.snap?.at ?? null;
}

// -------------------------------------------------------------- reading

export type SettingSource = "row" | "env" | "default";

/**
 * What the environment variable `env` would say, with the operator's row
 * laid over it: the row's value spelled as the variable would be, else the
 * variable itself. Every call site converted from process.env reads through
 * this and keeps its own parsing and fallback, so with no rows nothing
 * changes. A variable no setting owns reads straight through.
 */
export function settingText(env: string): string | undefined {
  const def = reg.byEnv.get(env);
  const row = def ? reg.snap?.rows.get(def.key) : undefined;
  if (def && row && row.value !== null) return envText(def, row.value);
  return process.env[env];
}

/** process.env with the operator's rows laid over it, for code that takes
 *  an `env` object (roomLimits, scheduleSpreadMs). */
export function settingsEnv(): NodeJS.ProcessEnv {
  return new Proxy(process.env, {
    get: (target, prop) => (typeof prop === "string" ? settingText(prop) : Reflect.get(target, prop)),
  });
}

/** One key, typed: the row, else the environment as the code reads it, else
 *  the registry's default. */
export function setting(key: string): SettingValue | null {
  const def = reg.defs.get(key);
  if (!def) throw new Error(`no setting ${key}`);
  return effectiveOf(def).value;
}

function effectiveOf(def: SettingDef, rows: Map<string, SettingRow> | undefined = reg.snap?.rows): { value: SettingValue | null; source: SettingSource } {
  const row = rows?.get(def.key);
  if (row && row.value !== null) return { value: row.value, source: "row" };
  const fromEnv = parseEnvValue(def, process.env[def.env]);
  if (fromEnv !== null) return { value: fromEnv, source: "env" };
  return { value: def.default, source: "default" };
}

export interface EffectiveSetting {
  def: SettingDef;
  value: SettingValue | null;
  source: SettingSource;
  /** The row's version, 0 when there has never been one: what a write's
   *  ifVersion must name. */
  version: number;
  updatedBy: string | null;
  updatedAt: string | null;
  /** The environment variable is set on this process (the fallback). */
  envSet: boolean;
}

/** Every registered key as it stands, from the given rows (default: the
 *  snapshot). */
export function effectiveSettings(rows?: SettingRow[]): EffectiveSetting[] {
  const map = rows ? new Map(rows.map((r) => [r.key, r])) : reg.snap?.rows;
  return settingDefs().map((def) => {
    const row = map?.get(def.key);
    return {
      def,
      ...effectiveOf(def, map),
      version: row?.version ?? 0,
      updatedBy: row?.updatedBy ?? null,
      updatedAt: row?.updatedAt ?? null,
      envSet: (process.env[def.env] ?? "").trim() !== "",
    };
  });
}

/**
 * Would these changes leave the settings consistent? Each value checked
 * against its key, then every rule over the values the change would leave
 * in force (`null` in `changes` is a reset). Nothing is written.
 */
export function validateSettingChanges(changes: Record<string, unknown>, rows?: SettingRow[]): { ok: boolean; errors: { key: string | null; rule?: string; message: string }[]; values: Record<string, SettingValue | null> } {
  const errors: { key: string | null; rule?: string; message: string }[] = [];
  const parsed: Record<string, SettingValue | null> = {};
  for (const [key, raw] of Object.entries(changes)) {
    const def = reg.defs.get(key);
    if (!def) {
      errors.push({ key, message: `no setting ${key}` });
      continue;
    }
    if (raw === null) {
      parsed[key] = null;
      continue;
    }
    const p = parseSettingValue(def, raw);
    if ("error" in p) errors.push({ key, message: p.error });
    else parsed[key] = p.value;
  }
  const map = new Map((rows ?? [...(reg.snap?.rows.values() ?? [])]).map((r) => [r.key, r]));
  const v = (key: string): SettingValue | null => {
    const def = reg.defs.get(key);
    if (!def) return null;
    if (key in parsed) {
      if (parsed[key] !== null) return parsed[key];
      // A reset: what the environment or the default says.
      return effectiveOf(def, new Map()).value;
    }
    return effectiveOf(def, map).value;
  };
  const touched = new Set(Object.keys(parsed));
  for (const rule of reg.rules) {
    if (!rule.keys.some((k) => touched.has(k))) continue;
    const msg = rule.check(v);
    if (msg) errors.push({ key: null, rule: rule.id, message: msg });
  }
  const values: Record<string, SettingValue | null> = {};
  for (const k of touched) values[k] = v(k);
  return { ok: errors.length === 0, errors, values };
}

/** Does moving `key` from `from` to `to` need a typed reason? */
export function needsConfirm(def: SettingDef, from: SettingValue | null, to: SettingValue | null): boolean {
  switch (def.confirm) {
    case undefined:
      return false;
    case "always":
      return true;
    case "on":
      return to === true && from !== true;
    case "off":
      return to === false && from !== false;
    case "lower":
    case "raise": {
      // Where 0 or unset means no limit (retention), that is the top of
      // the scale; elsewhere (a grace period) 0 is the bottom.
      const norm = (x: SettingValue | null) =>
        typeof x !== "number" ? (def.zeroUnlimited ? Infinity : typeof def.default === "number" ? def.default : Infinity) : def.zeroUnlimited && x <= 0 ? Infinity : x;
      const a = norm(from);
      const b = norm(to);
      return def.confirm === "lower" ? b < a : b > a;
    }
  }
}

// ------------------------------------------------------- platform key

/**
 * Is this account allowed the platform's own model credential?
 *
 * Hosted (fail-closed): the operator's per-account lever
 * (operator_accounts.state.platformKey, set in the console) — false refuses
 * whatever else says, true grants — else, for one release while the
 * manifests still state it, an account NAMED in
 * FOLDRUN_PLATFORM_KEY_ACCOUNTS. Unset, empty or "*" names nobody there. A
 * snapshot the store has not confirmed for PLATFORM_KEY_MAX_AGE_MS grants
 * nothing (the environment's names still count: they are not revocable
 * from the console anyway).
 *
 * Self-hosted: the variable as it always was — unset or "*" is every
 * account, since the key is the install owner's own and there is no
 * operator console to grant it with.
 */
export function platformKeyAllowedFor(tenant: string, hosted: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.FOLDRUN_PLATFORM_KEY_ACCOUNTS ?? "").trim();
  const named = raw.split(",").map((t) => t.trim()).filter(Boolean);
  if (!hosted) return !raw || raw === "*" || named.includes(tenant);
  // A refusal holds until the store says otherwise — an outage must never
  // undo a revocation. A grant holds only while the store keeps answering.
  if (reg.snap?.platformKeyDenied.has(tenant)) return false;
  const fresh = reg.snap && Date.now() - reg.snap.at <= PLATFORM_KEY_MAX_AGE_MS;
  if (fresh && reg.snap!.platformKey.has(tenant)) return true;
  return raw !== "*" && named.includes(tenant);
}

/** The accounts the snapshot holds as granted (the console's view). */
export function platformKeyAccounts(): string[] {
  return [...(reg.snap?.platformKey ?? [])].sort();
}

/** For tests: set the snapshot's platform-key accounts. */
export function setPlatformKeyAccountsForTest(granted: string[], refused: string[] = []): void {
  reg.snap ??= { rows: new Map(), fingerprint: "0:0", version: 0, platformKey: new Set(), platformKeyDenied: new Set(), at: Date.now() };
  reg.snap.platformKey = new Set(granted);
  reg.snap.platformKeyDenied = new Set(refused);
  reg.snap.at = Date.now();
}

/** For tests: make the snapshot look `ms` old. */
export function ageSnapshotForTest(ms: number): void {
  if (reg.snap) reg.snap.at = Date.now() - ms;
}
