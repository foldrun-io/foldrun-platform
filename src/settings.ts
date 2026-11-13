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

import { opsError } from "../../foldrun-core/src/ops-log.ts";
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

/** The supply providers offered: a comma list of known names, or empty. */
const SUPPLY_LIST = /^$|^(anthropic|openai|gemini|deepseek|moonshot|zai|qwen|minimax|mimo)(,(anthropic|openai|gemini|deepseek|moonshot|zai|qwen|minimax|mimo))*$/;
/** A supply provider's tier map: `fast=<id>,default=<id>,max=<id>`, any of
 *  the three, each id a provider's model name (letters, digits, . _ - / :). */
const TIER_MAP = /^$|^(fast|default|max)=[A-Za-z0-9._\/:-]{1,80}(,(fast|default|max)=[A-Za-z0-9._\/:-]{1,80}){0,2}$/;

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
  { key: "queue.max_waiting_runs", env: "FOLDRUN_MAX_WAITING_RUNS", type: "integer", min: 0, max: 100000, default: null, group: "limits", label: "Waiting runs per account", help: "New runs are refused while an account has this many waiting for their turn. Unset: 20 for each run it may drive at once, at least 50. 0: no cap.", unit: "runs", zeroUnlimited: true },
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
  // FOL-124 (5 Nov 2026): unset keeps for ever, as before — an install that
  // upgrades loses nothing it did not choose to (owner decision). foldrun's
  // hosted platform sets 90 (runs) and 365 (audit) in its manifests.
  { key: "runs.retention_days", env: "FOLDRUN_RETENTION_DAYS", type: "integer", min: 0, max: 3650, default: 0, group: "retention", label: "Run history", help: "Finished runs older than this — their records, captured calls and archived outputs — are deleted by the daily pass. 0: kept for ever.", unit: "days", confirm: "lower", zeroUnlimited: true, owner: true },
  { key: "audit.retention_days", env: "FOLDRUN_AUDIT_RETENTION_DAYS", type: "integer", min: 0, max: 3650, default: 0, group: "retention", label: "Audit log", help: "Audit log entries older than this are deleted by the daily pass (with a database; a file-backed log is kept). 0: kept for ever.", unit: "days", confirm: "lower", zeroUnlimited: true, owner: true },
  { key: "webhooks.disable_days", env: "FOLDRUN_WEBHOOK_DISABLE_DAYS", type: "number", min: 1, max: 365, default: 3, group: "retention", label: "Webhook auto-disable", help: "A notify: webhook failing every delivery this long is switched off.", unit: "days" },

  // Mail
  { key: "mail.from", env: "FOLDRUN_EMAIL_FROM", type: "string", pattern: /^[^\r\n<>]{0,80}<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>$|^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/, maxLength: 200, default: "foldrun <hello@foldrun.io>", group: "mail", label: "Sender", help: "The From of the platform's own mail. Its domain must be verified at the mail provider, or every send is refused.", confirm: "always", owner: true },
  { key: "mail.invites_per_day", env: "FOLDRUN_PLATFORM_INVITES_PER_DAY", type: "integer", min: 1, max: 100000, default: 25, group: "mail", label: "Invites per account per day", help: "Recipients one account may invite per day on the platform's mail key.", unit: "recipients" },
  { key: "mail.per_day", env: "FOLDRUN_PLATFORM_MAIL_PER_DAY", type: "integer", min: 1, max: 1000000, default: 200, group: "mail", label: "Other mail per account per day", help: "Recipients of notify:, approvals and the like, per account per day, on the platform's mail key.", unit: "recipients" },

  // Background work
  { key: "schedule.spread_sec", env: "FOLDRUN_SCHEDULE_SPREAD_SEC", type: "integer", min: 0, max: 3600, default: 0, group: "background", label: "Schedule spread", help: "Scheduled runs start up to this many seconds after their minute, the same offset per flow every day. 0: on the minute.", unit: "seconds" },

  // Workspaces as revisions (FOL-126 phase 3b). Both off until an operator
  // turns them on, one install at a time (dev first); a laptop and the CLI
  // have neither (no database, no store).
  // Step state in the database (FOL-126 phase 7). What a step was handed and
  // started from is a few rows instead of files under the run's folder. Off:
  // files, as before; rows already written are still read.
  { key: "runs.step_state_store", env: "FOLDRUN_RUN_STEP_STATE_STORE", type: "boolean", default: false, group: "background", label: "Step state in the database", help: "What a step was handed and which revisions it started from, and the storage index a run first saw, are kept as database rows instead of files under the run's folder on the shared volume. Needs a database. Off: files, as before; rows already written are still read, so switching it off mid-run loses nothing.", owner: true },
  // Captured tool calls in the blob store (FOL-126 phase 7, step 2). Off: files under the run's folder.
  { key: "runs.calls_store", env: "FOLDRUN_RUN_CALLS_STORE", type: "boolean", default: false, group: "background", label: "Captured calls in the object store", help: "What each tool call took and gave (secrets masked, long text cut at 64 KiB) is kept as one object in the store, pinned by its run, instead of a file under the run's folder on the shared volume. Needs a database and the object store. Off: files, as before; calls already stored are still read, so switching it off loses nothing. TEMPORARY: while it is on, a write the store refuses falls back to the volume.", owner: true },
  // A workspace's small state in the database (FOL-126, the last files on the
  // volume): webhook generations and deliveries, eval results and history,
  // grades, the deployed commit. Off: files in the
  // workspace's folder, as before; both places are always read.
  { key: "records.docs_store", env: "FOLDRUN_RECORDS_DOCS_STORE", type: "boolean", default: false, group: "background", label: "Workspace state in the database", help: "Webhook URL rotations and the delivery log, eval results and their history, grades and the deployed commit are kept as database rows instead of files in the workspace's folder on the shared volume. Needs a database. Both places are always read, so switching either way loses nothing already written. Turn it on only when every pod runs a release that has it: an older one reads the files alone, and would accept a webhook URL rotated away since.", confirm: "on", owner: true },
  // The runtime cache in the object store (FOL-126). Run pods mount no
  // volume: built environments are archives the worker unpacks before a step
  // and packs after it (runtime-archives.ts).
  { key: "runs.runtime_store", env: "FOLDRUN_RUN_RUNTIME_STORE", type: "boolean", default: false, group: "background", label: "Runtime cache in the object store", help: "Python and Node environments and system-package snapshots a step builds are kept as archives in the object store and unpacked into the next sandbox, instead of on the shared volume, so a run pod mounts no volume. Needs a database. The first step after switching installs again. Off: the volume, as before. Takes effect for the next step to start.", confirm: "on", owner: true },
  // Secrets in the database (FOL-126 phase 6). The same sealed records, one
  // row per account or workspace instead of secrets.json on the shared volume.
  { key: "secrets.store", env: "FOLDRUN_SECRETS_STORE", type: "boolean", default: false, group: "background", label: "Secrets in the database", help: "Each account's and workspace's secrets are kept as a database row of the same sealed records, instead of secrets.json on the shared volume; a scope is moved from its file the first time it is used. The file is still written after every change, so switching this off reads current secrets. Needs a database. Turn it on only when every pod runs a release that has it.", confirm: "on", owner: true },
  { key: "secrets.mirror", env: "FOLDRUN_SECRETS_MIRROR", type: "boolean", default: true, group: "background", label: "Secrets also written to files", help: "With the vault in the database, every change is also written to the scope's secrets.json on the shared volume (so switching secrets.store off or rolling back reads current secrets). Off: only the rows are written and the files go stale; the database then keeps serving whatever secrets.store says, until the files are brought up to date (scripts/vault-fleet.ts export) and this is turned on again. Turn it off only after scripts/vault-fleet.ts verify --open is clean. Needs secrets.store on.", confirm: "off", owner: true },
  { key: "revisions.journal", env: "FOLDRUN_REVISIONS", type: "boolean", default: false, group: "background", label: "Workspace revisions", help: "Every workspace change is also committed as a revision (heads, manifests, blobs; journalled on disk first, replayed after a crash), and the history page and restores read from them. Off: a workspace is its folder and its local history alone. Takes effect within a poll; a workspace is reconciled with its folder on its first write after.", confirm: "on", owner: true },
  { key: "revisions.read", env: "FOLDRUN_REVISIONS_READ", type: "boolean", default: false, group: "background", label: "Read workspaces from revisions", help: "A run's stage-in and the dashboard's file reads come from the revision head (blobs through the store), the folder as the fallback. Needs workspace revisions on; a head that is behind the folder serves the older content.", confirm: "on", owner: true },

  // How long `state/` checkpoints are kept (FOL-126 fixes, 8 Nov 2026). Only
  // where workspace revisions are on; the head is always kept.
  { key: "revisions.state_keep", env: "FOLDRUN_REVISIONS_STATE_KEEP", type: "integer", min: 0, max: 100000, default: 100, group: "retention", label: "State checkpoints kept", help: "A workspace's state/ is committed after every step; only the newest this many are kept (the current one always). Older ones can no longer be restored to. A checkpoint a running step started from is left until it ends. 0: no count limit.", unit: "checkpoints", confirm: "lower", zeroUnlimited: true, owner: true },
  { key: "revisions.state_days", env: "FOLDRUN_REVISIONS_STATE_DAYS", type: "integer", min: 0, max: 3650, default: 30, group: "retention", label: "State checkpoints age", help: "State checkpoints older than this are removed by the pass that follows a step (the current one always stays). Together with the count: a checkpoint goes when it is outside either. 0: no age limit.", unit: "days", confirm: "lower", zeroUnlimited: true, owner: true },

  // Run outputs in the blob store (FOL-126 phase 5, 9 Nov 2026). Needs a
  // database and an object store; off, a run's outputs are copied to the volume
  // as before. The two limits apply only while it is on: a file over them is
  // refused, named on the run, and kept nowhere.
  { key: "runs.outputs_store", env: "FOLDRUN_RUN_OUTPUTS_STORE", type: "boolean", default: false, group: "background", label: "Run outputs in the object store", help: "What a run's agents leave in outputs/ is published to the object store when the run ends (and read from there), instead of copied to the shared volume. Runs archived before the switch stay readable. A file over the limits below is not kept, and the run says so. Off: copied to the volume. Takes effect for the next run to finish.", confirm: "on", owner: true },
  { key: "runs.output_file_mb", env: "FOLDRUN_RUN_OUTPUT_FILE_MB", type: "integer", min: 0, max: 10240, default: 64, group: "retention", label: "Largest run output file", help: "With run outputs in the object store: a file an agent leaves in outputs/ larger than this is not kept; the run page and its trail name it. 0: no limit.", unit: "MiB", confirm: "lower", zeroUnlimited: true, owner: true },
  { key: "runs.output_run_mb", env: "FOLDRUN_RUN_OUTPUT_RUN_MB", type: "integer", min: 0, max: 102400, default: 512, group: "retention", label: "Run outputs per run", help: "With run outputs in the object store: once a run's kept outputs (all its agents) would pass this, further files are not kept; the run page and its trail name them. 0: no limit.", unit: "MiB", confirm: "lower", zeroUnlimited: true, owner: true },

  // The blob sweeper (FOL-126, 8 Nov 2026): deletes the objects no revision, pin
  // or restore window needs. Off until an operator turns it on, and a dry run
  // (counts only) until the dry-run switch is turned off.
  { key: "blobs.sweep", env: "FOLDRUN_BLOB_SWEEP", type: "boolean", default: false, group: "background", label: "Delete unused revision objects", help: "A scheduled pass deletes the stored blobs and manifests no revision, running step or publish still needs, once they have gone unused for the delay below; it also clears the objects of deleted accounts. Off: nothing is ever deleted and storage only grows. Starts as a dry run (see below).", confirm: "on", owner: true },
  { key: "blobs.sweep_dry_run", env: "FOLDRUN_BLOB_SWEEP_DRY_RUN", type: "boolean", default: true, group: "background", label: "Sweep as a dry run", help: "The pass counts and logs what it would delete (blobs.sweep ops event) and deletes nothing. Turn off after reading a few of its reports.", confirm: "off", owner: true },
  { key: "blobs.sweep_delay_days", env: "FOLDRUN_BLOB_SWEEP_DELAY_DAYS", type: "integer", min: 1, max: 365, default: 7, group: "retention", label: "Unused objects kept for", help: "An object is deleted only after it has been unused this long. Keep it at least as long as the window the database can be restored to: a restore inside it finds its objects.", unit: "days", confirm: "lower", owner: true },
  { key: "blobs.sweep_interval_hours", env: "FOLDRUN_BLOB_SWEEP_INTERVAL_HOURS", type: "integer", min: 1, max: 720, default: 24, group: "background", label: "Sweep every", help: "How often the pass runs, on one pod at a time.", unit: "hours", owner: true },
  { key: "blobs.sweep_max_deletes", env: "FOLDRUN_BLOB_SWEEP_MAX_DELETES", type: "integer", min: 1, max: 10000000, default: 10000, group: "limits", label: "Most objects deleted per pass", help: "A pass stops after deleting this many; the rest wait for the next.", unit: "objects", owner: true },

  // foldrun's models (3 Nov 2026): the platform's own keys, which an account
  // may choose instead of its own (model-supply.ts, model-gateway.ts).
  { key: "models.supply.enabled", env: "FOLDRUN_MODEL_SUPPLY", type: "boolean", default: false, group: "billing", label: "foldrun's models", help: "Accounts may choose to run on the platform's model keys, billed per call from the price list. Off: nobody can, and calls on a lease already in use are refused.", confirm: "on", owner: true },
  { key: "models.supply.providers", env: "FOLDRUN_MODEL_SUPPLY_PROVIDERS", type: "string", pattern: SUPPLY_LIST, maxLength: 128, default: "anthropic,openai,gemini,deepseek,moonshot,zai,qwen,minimax,mimo", group: "billing", label: "Providers offered", help: "Comma-separated: anthropic, openai, gemini, deepseek, moonshot, zai, qwen, minimax, mimo. One is offered only where the platform holds its key and (except anthropic) its tiers are set.", owner: true },
  { key: "models.supply.anthropic.tiers", env: "FOLDRUN_MODEL_SUPPLY_ANTHROPIC_TIERS", type: "string", pattern: TIER_MAP, maxLength: 300, default: null, group: "billing", label: "Anthropic tiers", help: "fast=<model id>,default=<model id>,max=<model id>. Empty: the runtime's own Claude models.", owner: true },
  { key: "models.supply.openai.tiers", env: "FOLDRUN_MODEL_SUPPLY_OPENAI_TIERS", type: "string", pattern: TIER_MAP, maxLength: 300, default: null, group: "billing", label: "OpenAI tiers", help: "fast=<model id>,default=<model id>,max=<model id>. Empty: OpenAI is not offered.", owner: true },
  { key: "models.supply.gemini.tiers", env: "FOLDRUN_MODEL_SUPPLY_GEMINI_TIERS", type: "string", pattern: TIER_MAP, maxLength: 300, default: null, group: "billing", label: "Gemini tiers", help: "fast=<model id>,default=<model id>,max=<model id>. Empty: Gemini is not offered.", owner: true },
  { key: "models.supply.deepseek.tiers", env: "FOLDRUN_MODEL_SUPPLY_DEEPSEEK_TIERS", type: "string", pattern: TIER_MAP, maxLength: 300, default: null, group: "billing", label: "DeepSeek tiers", help: "fast=<model id>,default=<model id>,max=<model id>. Empty: DeepSeek is not offered.", owner: true },
  { key: "models.supply.moonshot.tiers", env: "FOLDRUN_MODEL_SUPPLY_MOONSHOT_TIERS", type: "string", pattern: TIER_MAP, maxLength: 300, default: null, group: "billing", label: "Moonshot Kimi tiers", help: "fast=<model id>,default=<model id>,max=<model id>. Empty: Moonshot Kimi is not offered.", owner: true },
  { key: "models.supply.zai.tiers", env: "FOLDRUN_MODEL_SUPPLY_ZAI_TIERS", type: "string", pattern: TIER_MAP, maxLength: 300, default: null, group: "billing", label: "Z.ai GLM tiers", help: "fast=<model id>,default=<model id>,max=<model id>. Empty: Z.ai GLM is not offered.", owner: true },
  { key: "models.supply.qwen.tiers", env: "FOLDRUN_MODEL_SUPPLY_QWEN_TIERS", type: "string", pattern: TIER_MAP, maxLength: 300, default: null, group: "billing", label: "Alibaba Qwen tiers", help: "fast=<model id>,default=<model id>,max=<model id>. Empty: Alibaba Qwen is not offered.", owner: true },
  { key: "models.supply.minimax.tiers", env: "FOLDRUN_MODEL_SUPPLY_MINIMAX_TIERS", type: "string", pattern: TIER_MAP, maxLength: 300, default: null, group: "billing", label: "MiniMax tiers", help: "fast=<model id>,default=<model id>,max=<model id>. Empty: MiniMax is not offered.", owner: true },
  { key: "models.supply.mimo.tiers", env: "FOLDRUN_MODEL_SUPPLY_MIMO_TIERS", type: "string", pattern: TIER_MAP, maxLength: 300, default: null, group: "billing", label: "Xiaomi MiMo tiers", help: "fast=<model id>,default=<model id>,max=<model id>. Empty: Xiaomi MiMo is not offered.", owner: true },
  { key: "models.supply.daily_usd", env: "FOLDRUN_MODEL_SUPPLY_DAILY_USD", type: "number", min: 0, max: 100000, default: 50, group: "limits", label: "foldrun's models per account per day", help: "What one account's calls on the platform's model keys may cost per UTC day, at the price list before margin. An account's own lever overrides it. 0: no cap.", unit: "USD", confirm: "raise", zeroUnlimited: true, owner: true },

  // Admission — read by the open reservation gate
  { key: "billing.max_run_exposure", env: "FOLDRUN_MAX_RUN_EXPOSURE", type: "number", min: 0, max: 10000, default: null, group: "billing", label: "Balance held per run", help: "What admission holds of the balance for each unsettled run. 0: the flow's own history decides.", unit: "USD", owner: true },
];

/** Checks across keys. Each names the keys it reads; the hosted build adds
 *  its own. */
export const OPEN_SETTING_RULES: SettingRule[] = [
  {
    id: "secrets.mirror-needs-store",
    keys: ["secrets.store", "secrets.mirror"],
    // With the mirror off the files are stale: secrets.store off would send
    // every read back to them and lose every secret changed since.
    check: (v) =>
      v("secrets.store") !== true && v("secrets.mirror") === false
        ? "secrets.store cannot be off while secrets.mirror is off: the files are stale, and reading them would lose every secret changed since the mirror stopped. Turn secrets.mirror on, run scripts/vault-fleet.ts export, then secrets.store off."
        : null,
  },
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
  /** foldrun's models: accounts the operator refused them
   *  (state.modelSupply false), and accounts with a daily cap of their own
   *  (state.modelSupplyDailyUsd). Read with the platform-key levers. */
  supplyDenied: Set<string>;
  supplyDailyUsd: Map<string, number>;
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
async function readPlatformKeyAccounts(): Promise<{ allow: Set<string>; deny: Set<string>; supplyDenied: Set<string>; supplyDailyUsd: Map<string, number> }> {
  if (!databaseEnabled()) return { allow: new Set(), deny: new Set(), supplyDenied: new Set(), supplyDailyUsd: new Map() };
  const res = await ormRequired().execute(
    sql`SELECT tenant, state->>'platformKey' AS k, state->>'modelSupply' AS s, state->>'modelSupplyDailyUsd' AS d FROM operator_accounts
        WHERE state ? 'platformKey' OR state ? 'modelSupply' OR state ? 'modelSupplyDailyUsd'`,
  );
  const allow = new Set<string>(), deny = new Set<string>(), supplyDenied = new Set<string>();
  const supplyDailyUsd = new Map<string, number>();
  for (const r of res.rows as { tenant: string; k: string | null; s: string | null; d: string | null }[]) {
    if (r.k !== null) (r.k === "true" ? allow : deny).add(r.tenant);
    if (r.s === "false") supplyDenied.add(r.tenant);
    const d = r.d === null ? NaN : Number(r.d);
    if (Number.isFinite(d) && d >= 0) supplyDailyUsd.set(r.tenant, d);
  }
  return { allow, deny, supplyDenied, supplyDailyUsd };
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
      supplyDenied: keys.supplyDenied,
      supplyDailyUsd: keys.supplyDailyUsd,
      at: Date.now(),
    };
    reg.warned = false;
    return true;
  } catch (err) {
    if (!reg.warned) opsError("settings.unreadable", err, { outcome: reg.snap ? "kept_last" : "environment" });
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
    reg.snap.supplyDenied = keys.supplyDenied;
    reg.snap.supplyDailyUsd = keys.supplyDailyUsd;
    reg.snap.at = Date.now();
    reg.warned = false;
  } catch (err) {
    if (!reg.warned) opsError("settings.poll_failed", err, { outcome: "kept_last" });
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

/** foldrun's models for one account, as the operator left them: off for
 *  everyone, refused to this account, or on with the day's cap (USD at the
 *  price list; 0 = no cap). Fail-closed like the platform key: with no
 *  snapshot, or one the store has not confirmed for PLATFORM_KEY_MAX_AGE_MS,
 *  nothing is granted — a refusal or a switch-off must land within a poll
 *  even through an outage. Without a database (a test, a self-host) the
 *  snapshot is the settings file's and the levers are empty. */
export function supplyStanding(tenant: string, now = Date.now()): { ok: true; dailyUsd: number } | { ok: false; reason: string } {
  if (setting("models.supply.enabled") !== true) return { ok: false, reason: "foldrun's models are switched off on this platform" };
  const snap = reg.snap;
  if (!snap || (databaseEnabled() && now - snap.at > PLATFORM_KEY_MAX_AGE_MS)) {
    return { ok: false, reason: "foldrun's models are unavailable for a moment (the platform's settings could not be confirmed)" };
  }
  if (snap.supplyDenied.has(tenant)) return { ok: false, reason: "foldrun's models are not available to this account — contact support" };
  const own = snap.supplyDailyUsd.get(tenant);
  const global = setting("models.supply.daily_usd");
  return { ok: true, dailyUsd: own ?? (typeof global === "number" ? global : 50) };
}

/** For tests: the supply levers on the snapshot. */
export function setSupplyLeversForTest(denied: string[], daily: Record<string, number> = {}): void {
  reg.snap ??= { rows: new Map(), fingerprint: "0:0", version: 0, platformKey: new Set(), platformKeyDenied: new Set(), supplyDenied: new Set(), supplyDailyUsd: new Map(), at: Date.now() };
  reg.snap.supplyDenied = new Set(denied);
  reg.snap.supplyDailyUsd = new Map(Object.entries(daily));
  reg.snap.at = Date.now();
}

/** The accounts the snapshot holds as granted (the console's view). */
export function platformKeyAccounts(): string[] {
  return [...(reg.snap?.platformKey ?? [])].sort();
}

/** For tests: set the snapshot's platform-key accounts. */
export function setPlatformKeyAccountsForTest(granted: string[], refused: string[] = []): void {
  reg.snap ??= { rows: new Map(), fingerprint: "0:0", version: 0, platformKey: new Set(), platformKeyDenied: new Set(), supplyDenied: new Set(), supplyDailyUsd: new Map(), at: Date.now() };
  reg.snap.platformKey = new Set(granted);
  reg.snap.platformKeyDenied = new Set(refused);
  reg.snap.at = Date.now();
}

/** For tests: make the snapshot look `ms` old. */
export function ageSnapshotForTest(ms: number): void {
  if (reg.snap) reg.snap.at = Date.now() - ms;
}
