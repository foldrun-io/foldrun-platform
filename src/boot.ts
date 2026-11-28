// What every platform process does before it serves or drives anything.
//
// This used to live in foldrun-web/instrumentation.ts, which meant the
// worker could only exist as a Next.js server that served nothing: the
// dashboard's startup hook was the only place the boot sequence ran. Now
// both roles call boot(): the web from its hook, the worker from its own
// entrypoint (worker.ts), and neither needs the other's runtime.
//
// The order is the order of trust: plug the platform into core, migrate the
// schema (an advisory lock makes every replica calling at once safe), load
// the account keys before anything reads a secret, move each one-time file
// import into its table, and only then start loops. Everything after the
// migration is best-effort — a failed hardening step must not turn into an
// outage — except the isolation check, which must.

import { opsLog, opsError } from "../../foldrun-core/src/ops-log.ts";
import fs from "node:fs";
import path from "node:path";
import { installPlatform } from "./index.ts";
import { startModelChoices } from "./model-choice.ts";
import { startModelKeys } from "./model-keys.ts";
import { migrate, databaseEnabled } from "./db.ts";
import { loadTenantKeys, ensureTenantKey, rewrapTenantKeys, rootKeyProvider, startTenantKeyRefresh } from "./tenant-keys.ts";
import { rewrapTenantSecrets, sealVaultBindings, vaultWritesBound } from "../../foldrun-core/src/secrets.ts";
import { listTenants, accountDir } from "../../foldrun-core/src/store.ts";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { billing } from "./billing.ts";
import { importKeyedFile } from "./keyed-store.ts";
import { oauthClients, oauthConnections } from "./schema.ts";
import { oauthClientFile } from "./oauth-clients.ts";
import { oauthConnectionFile } from "./oauth-connections.ts";
import { importSecretHealthFile } from "./secret-health-db.ts";
import { importLedgerToDatabase } from "./ledger.ts";
import { importRecordsFiles, seedRouting } from "./records-import.ts";
import { recordsInDatabase } from "./records-pg.ts";
import { startRoutingWatch } from "./records-routing.ts";
import { importFlowStateFiles } from "./flow-state.ts";
import { importWatchdogFile } from "./notices.ts";
import { importSharesFile } from "./shares.ts";
import { importOperatorFiles } from "./admin.ts";
import { syncAllGalleryCopies } from "./gallery.ts";
import { reconcileAllRuns } from "../../foldrun-core/src/runner.ts";
import { liveClaimedRuns, importQueueToDatabase, recoverQueue, startWorker, assertIsolationSafe, afterReconciled } from "./queue.ts";
import { startScheduler } from "./scheduler.ts";
import { startAssistantWorker } from "./assistant/jobs.ts";
import { startEgressRotationRecovery } from "./egress-proxy.ts";
import { setting, startSettings, localDiskGaps } from "./settings.ts";
import { withHousekeeping } from "./housekeeping.ts";
import { startBlobSweepLoop } from "./blob-sweep-job.ts";
import { recoverJournal, reconcileAll, tenantsWithRevisionState } from "../../foldrun-core/src/workspace-revisions.ts";
import { mirrorOn } from "../../foldrun-core/src/mirror-base.ts";
import { syncAllFromHeads, syncFromHeads } from "../../foldrun-core/src/workspace-revisions.ts";
import { startMirrorNotify, mirrorNotifyLive } from "./mirror-notify.ts";
import { nextMirrorDelay, withJitter } from "./mirror-backoff.ts";
import { startToolPods } from "./tool-pod.ts";

/** Boot, background: replay the revision journal, then reconcile each workspace with its folder. */
export async function recoverRevisions(): Promise<void> {
  try {
    const r = await recoverJournal();
    if (r.entries) opsLog("info", "revisions.journal_replayed", r);
    await withHousekeeping("revisions-reconcile", () => reconcileAll());
  } catch (err) {
    opsError("revisions.boot_failed", err, {}, "warn");
  }
}

/** On a pod with its own disk (revisions.mirror): an account is a folder here
 *  because the database says it exists (tenant_keys: one row per account,
 *  made at sign-up, gone with the account) — not because some pod once made
 *  the folder. Accounts with no workspace yet get theirs; a deleted one's
 *  goes. Nothing is done when the list cannot be read or is empty. */
async function syncAccountFolders(): Promise<void> {
  const { ormRequired } = await import("./db.ts");
  const { sql } = await import("drizzle-orm");
  const rows = (await ormRequired().execute(sql`SELECT tenant FROM tenant_keys`)).rows as { tenant: string }[];
  const known = new Set(rows.map((r) => r.tenant).filter((t) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(t)));
  if (!known.size) return;
  await removeStaleAccountFolders(known);
}

const keptNoted = new Set<string>();
/** The folder part of syncAccountFolders, apart so it can be tested. */
export async function removeStaleAccountFolders(known: Set<string>): Promise<void> {
  const { dataRoot } = await import("../../foldrun-core/src/paths.ts");
  const fsm = await import("node:fs");
  const pathm = await import("node:path");
  for (const t of known) fsm.mkdirSync(pathm.join(dataRoot(), t, "workspaces"), { recursive: true });
  // Read only when a folder is a candidate, and once. A store that cannot be
  // read throws out of here with nothing removed: better a stale folder than
  // an account's unpublished state lost to a store being down.
  let withState: Set<string> | null = null;
  for (const name of fsm.readdirSync(dataRoot())) {
    if (name.startsWith(".") || known.has(name)) continue;
    const dir = pathm.join(dataRoot(), name);
    // Only an account folder (it has workspaces/), never anything else at the
    // root, and only one older than ten minutes: a sign-up on this pod makes
    // its folder around the moment its key row is written, so a list read just
    // before must not take the new account for a deleted one.
    if (!fsm.existsSync(pathm.join(dir, "workspaces"))) continue;
    if (Date.now() - fsm.statSync(dir).mtimeMs < 10 * 60_000) continue;
    // Not listed in tenant_keys is not proof the account is gone (a legacy or
    // imported account may lack a row, or a row may be briefly missing): one
    // that still has heads, journal entries or queued changes keeps its folder.
    withState ??= await tenantsWithRevisionState();
    if (withState.has(name)) {
      // The poll runs every few seconds: say it once per account per process.
      if (!keptNoted.has(name)) opsLog("warn", "revisions.account_folder_kept", { tenant: name, reason: "has revision state but no tenant_keys row" });
      keptNoted.add(name);
      continue;
    }
    fsm.rmSync(dir, { recursive: true, force: true });
  }
}

let mirrorTimer: NodeJS.Timeout | null = null;
/** Keeps this pod's copy of the workspaces current, while revisions.mirror is
 *  on. Changes arrive by notification (mirror-notify.ts: a trigger on the
 *  heads announces each one on commit), so the full pass below is the safety
 *  net — every FOLDRUN_MIRROR_SAFETY_MS (60 s) while the listener is live,
 *  every FOLDRUN_MIRROR_POLL_MS (3 s) when it is not (no database listener,
 *  FOLDRUN_PG_LISTEN=off, the connection down), and at once when it comes up
 *  or goes down (a change may have gone unheard). One pass at a time (the
 *  next is scheduled when this one ends); read per tick, so the switch takes
 *  effect without a restart. A pass in which every workspace failed backs the
 *  loop off — 2x each time, up to FOLDRUN_MIRROR_MAX_MS (60 s), with jitter —
 *  and the first pass that is not all failures brings it back to its pace
 *  (mirror-backoff.ts, 15 Nov 2026). */
function startMirrorLoop(): void {
  if (mirrorTimer) return;
  const poll = Math.max(1000, Number(process.env.FOLDRUN_MIRROR_POLL_MS ?? 3000));
  const safety = Math.max(poll, Number(process.env.FOLDRUN_MIRROR_SAFETY_MS ?? 60_000));
  const max = Math.max(safety, Number(process.env.FOLDRUN_MIRROR_MAX_MS ?? 60_000));
  const pace = () => (mirrorNotifyLive() ? safety : poll);
  let delay = pace();
  let backingOff = false;
  let running = false;
  let wanted = false;
  const schedule = (wait: number) => {
    if (mirrorTimer) clearTimeout(mirrorTimer);
    mirrorTimer = setTimeout(tick, wait);
    mirrorTimer.unref?.();
  };
  /** A full pass now (or right after the one running). */
  const wake = () => {
    if (running) wanted = true;
    else schedule(0);
  };
  const tick = () => {
    const base = pace();
    if (!mirrorOn()) {
      delay = base;
      backingOff = false;
      return schedule(base);
    }
    running = true;
    // What other pods change reaches this one now, not at the next pass —
    // from the first pass the mirror is on (no listener where it is off).
    startMirrorNotify({
      workspace: (tenant, workspace) =>
        syncFromHeads(tenant, workspace).catch((err) => opsError("revisions.mirror_sync_failed", err, { tenant, workspace }, "warn")),
      account: () => syncAccountFolders().catch((err) => opsError("revisions.mirror_accounts_failed", err, {}, "warn")),
      wake,
    });
    syncAccountFolders()
      .catch((err) => opsError("revisions.mirror_accounts_failed", err, {}, "warn"))
      .then(() => syncAllFromHeads())
      .then(
        (r) => {
          if (r.failed) opsLog("warn", "revisions.mirror_sync_partial", { count: r.synced, removed: r.removed, failed: r.failed, total: r.total });
          return r;
        },
        (err) => {
          opsError("revisions.mirror_loop_failed", err, {}, "warn");
          return null;
        },
      )
      .then((r) => {
        const base = pace();
        const next = nextMirrorDelay(backingOff ? delay : base, base, max, r);
        const now = next > base;
        if (now && !backingOff) opsLog("warn", "revisions.mirror_backing_off", { failed: r?.failed ?? null, total: r?.total ?? null });
        if (!now && backingOff) opsLog("info", "revisions.mirror_recovered", {});
        backingOff = now;
        delay = next;
        running = false;
        if (wanted) {
          wanted = false;
          schedule(0);
        } else schedule(withJitter(delay));
      });
  };
  schedule(poll);
}

export type Role = "web" | "worker" | "all" | "egress" | "assistant" | "gateway";

/** The roles that have the workspaces' folders: web, worker and the
 *  one-process shape. The egress, the assistant and the gateway may run on
 *  a data root of their own and must never treat it as the workspaces. */
export function holdsWorkspaces(role: Role = roleOf()): boolean {
  return role === "web" || role === "worker" || role === "all";
}

/** Which loops a process runs: `web` serves and runs nothing; `worker`
 *  drives runs and ticks the scheduler; `assistant` runs the dashboard
 *  assistant's replies and nothing else (assistant-worker.ts); `all` is the
 *  single-process shape (the laptop), every loop. Read from FOLDRUN_ROLE;
 *  `all` when unset. */
export function roleOf(): Role {
  const r = process.env.FOLDRUN_ROLE ?? "all";
  if (r === "web" || r === "worker" || r === "all" || r === "egress" || r === "assistant" || r === "gateway") return r;
  throw new Error(`FOLDRUN_ROLE must be web, worker, assistant, egress, gateway or all, not "${r}"`);
}

/** Which processes may START the move of records off files (FOL-152): the
 *  worker, or the single-process laptop shape. Every other role follows the
 *  routing but never moves anything — an egress proxy or an assistant that
 *  booted with a database moved dev's records on 9 Nov 2026 because only
 *  web, worker and assistant had FOLDRUN_RECORDS=files. One owner for the
 *  move, like the worker owns the schema. */
export function movesRecords(role: Role = roleOf()): boolean {
  return role === "worker" || role === "all";
}

let gapsTimer: NodeJS.Timeout | null = null;
/** Say which storage switches are off on a pod whose data root is its own
 *  disk: an error when the set changes to non-empty, an info line when it
 *  clears. Read each minute; the timer never holds the process open. */
export function watchLocalDiskGaps(read: () => string[] = () => localDiskGaps()): () => void {
  let said = "";
  const check = () => {
    let off: string[];
    try {
      off = read();
    } catch {
      return;
    }
    const now = off.join(",");
    if (now === said) return;
    if (off.length) opsLog("error", "storage.local_disk_switch_off", { off, effect: "their data goes to this pod's own disk and is lost on restart" });
    else if (said) opsLog("info", "storage.local_disk_switches_on", {});
    said = now;
  };
  check();
  if (!gapsTimer) {
    gapsTimer = setInterval(check, 60_000);
    gapsTimer.unref?.();
  }
  return check;
}

let prepared: Promise<void> | null = null;
let started: Promise<void> | null = null;

/**
 * Boot this process for its role: prepare(), then the loops unless the role
 * is web. Idempotent: a second call returns the first call's promise, so a
 * restart loop inside one process cannot run the imports twice. Throws on a
 * failed migration or an unsafe isolation setting — the two things a
 * process must not run without.
 */
export async function boot(role: Role = roleOf()): Promise<void> {
  // The gateway (gateway.ts, 10 Nov 2026) boots as the minimal egress does,
  // always: the operator's settings and the sealed provider keys, nothing
  // else — no migration, no loops, no records move, no install key.
  if (role === "gateway") {
    await prepareEgress();
    // Every account's model choice and live plan (database reads only): the
    // door serves a call the way the account's cloud step is served
    // (model-choice.ts accountRoute — owner, 23 Nov 2026: one door). Never
    // read, every call is refused with "try again", not served on a guess.
    try {
      await startModelChoices();
    } catch (err) {
      opsError("gateway.model_choices_unreadable", err);
    }
    return;
  }
  if (role === "egress" && egressMinimalBoot()) {
    await prepareEgress();
    return;
  }
  await prepare();
  // egress runs the proxy alone (egress.ts starts it): no queue, no
  // scheduler, so restarting the worker no longer takes it down. The
  // assistant role runs its own loop alone, the same way.
  if (role === "assistant") {
    startAssistantWorker();
    return;
  }
  if (role !== "web" && role !== "egress") await startLoops();
}

/** FOLDRUN_EGRESS_MINIMAL_BOOT=1: an egress pod that holds no install key
 *  and opens no account key boots with prepareEgress(). Off by default, so
 *  one release is safe on pods that still have the key. */
export const egressMinimalBoot = () => process.env.FOLDRUN_EGRESS_MINIMAL_BOOT === "1";

/**
 * The egress role's boot when it runs without the install key: plug the
 * platform into core, and nothing else. No migration (the worker owns the
 * schema, and a pod that may not change it should not try), no account keys
 * (v2 leases open with their own token), no file imports, no rewraps — each
 * of those needs the key this pod no longer has.
 */
let preparedEgress = false;
export async function prepareEgress(): Promise<void> {
  if (preparedEgress) return;
  preparedEgress = true;
  installPlatform();
  // foldrun's models: the gateway in this proxy needs the operator's
  // settings (is it on, who is refused, the caps) and the platform's
  // provider keys (sealed; opened with FOLDRUN_SUPPLY_SEAL_KEY here). Both
  // are reads the database answers without the install key. Neither stops
  // the proxy from serving: without them every call on the platform's keys
  // is refused, and the polls keep trying (Codex review, 3 Nov 2026).
  try {
    await startSettings();
    await startModelKeys();
  } catch (err) {
    opsError("egress.models_off", err);
  }
}

/** Everything before any loop: plug in, migrate, keys, the file imports.
 *  The web hook calls this, does its own file imports (users, API keys —
 *  files the web layer owns), then startLoops() unless it is a web replica. */
export function prepare(): Promise<void> {
  prepared ??= prepareOnce();
  return prepared;
}

/** An error that says "the database could not be reached or is full right
 *  now", as opposed to "the database answered and refused": too many
 *  connections (53300), starting up or shutting down (57P01-57P03), a
 *  connection that would not open or was cut. The pg driver puts the SQLSTATE
 *  in `code`; a socket failure puts the errno there; the pool's own timeout
 *  has only a message. A migration that failed in SQL is wrapped by migrate()
 *  with neither, so it stays fatal. */
export function transientDatabaseError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : "";
  if (["53300", "57P01", "57P02", "57P03", "08000", "08001", "08003", "08004", "08006", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN"].includes(code)) return true;
  const message = typeof e?.message === "string" ? e.message : "";
  return /timeout exceeded when trying to connect|connection terminated|too many (clients|connections)|the database system is (starting up|shutting down)/i.test(message);
}

let booted = false;

/** True once this process finished its boot (prepare, and for a web replica
 *  the rest of the startup hook). Only ever goes true: a probe that asked
 *  "is the database busy right now" would drop every copy from the load
 *  balancer at the moment the database is struggling, and the survivors would
 *  take the load of the ones taken out (28 Nov 2026). */
export function bootComplete(): boolean {
  return booted;
}

/** The startup hook says it is done. */
export function markBooted(): void {
  booted = true;
}

/** `prepare()` that waits out a database that is full or not answering,
 *  instead of failing the process. A copy that cannot get a connection stays
 *  alive and not ready, tries again with a growing pause, and joins when the
 *  database has room, rather than being restarted into the same full database
 *  (each restart is another connection attempt). Anything else — a migration
 *  that failed in SQL, a missing migrations directory — still throws. The
 *  pause is `pause(attempt)` ms; tests pass their own. */
export function prepareWhenDatabaseAnswers(pause: (attempt: number) => number = databaseRetryPause): Promise<void> {
  // prepareOnce threw before anything past the migration ran (the only step
  // that throws is the migration, and installPlatform is a no-op the second
  // time), so a fresh pass is the same as the first.
  return retryWhileTransient(prepare, pause, () => {
    prepared = null;
  });
}

/** Run `attempt` until it stops failing with a transient database error. Any
 *  other error is thrown at once. `reset` runs before each new try. */
export async function retryWhileTransient<T>(attempt: () => Promise<T>, pause: (attempt: number) => number, reset: () => void = () => {}): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await attempt();
    } catch (err) {
      if (!transientDatabaseError(err)) throw err;
      reset();
      const ms = pause(n);
      opsLog("warn", "boot.database_unavailable", { attempt: n, ms });
      await new Promise((r) => setTimeout(r, ms));
    }
  }
}

/** 2 s, doubling to 30 s, with up to a quarter more so six copies that failed
 *  together do not all ask again together. */
function databaseRetryPause(attempt: number): number {
  const base = Math.min(30_000, 2_000 * 2 ** Math.min(attempt - 1, 4));
  return Math.round(base * (1 + Math.random() * 0.25));
}

async function prepareOnce(): Promise<void> {
  // The platform plugs into core here, before anything runs a step or reads
  // a secret: the queue, pods, account keys, previews, share links.
  installPlatform();

  // Schema first, for every role: a web replica reads the same tables the
  // worker writes, and an unmigrated database is not a slow start — it is a
  // 500 on the first query.
  if (databaseEnabled()) {
    try {
      const applied = await migrate();
      if (applied.length) opsLog("info", "db.migrations_applied", { count: applied.length });
    } catch (err) {
      // Loud, and fatal: serving against a half-migrated schema is how a
      // platform corrupts the records it was given a database to protect.
      opsError("db.migration_failed", err);
      throw err;
    }
    // Where each workspace's records live, followed and acknowledged every
    // second for as long as this process runs, in either FOLDRUN_RECORDS
    // mode: an import (here or on another pod) waits for that acknowledgement
    // before it touches a workspace's files (records-routing.ts).
    startRoutingWatch(seedRouting);
  }

  // The operator's settings (settings.ts), before anything reads one: the
  // rows over the environment, then a poll for changes made on other pods.
  // A store that will not answer leaves the environment in charge — the
  // behaviour before settings existed — and the poll keeps trying.
  await startSettings();
  // A pod with no shared volume needs every storage switch on; one that is
  // off is said at once and whenever the set changes (Kousha's review,
  // 14 Nov 2026: nothing checked, and the fallbacks wrote to the emptyDir).
  watchLocalDiskGaps();
  // foldrun's models: every account's choice, kept for the runner to ask.
  await startModelChoices();
  // …and the platform's own provider keys for them, set in the console
  // (sealed; only the egress proxy opens one).
  await startModelKeys();

  // Account keys before anything reads a secret. Every account gets one if
  // it has none, existing vaults move onto it, and the set is held in
  // memory so the secrets API can stay synchronous.
  if (databaseEnabled()) {
    try {
      await loadTenantKeys();
      // And again every five minutes, so an account minted on another
      // replica is known here without a restart.
      startTenantKeyRefresh();
      // Moving to KMS: every account key still sealed by the env key is
      // re-sealed by KMS, one at a time. Only the small keys move.
      // …and once the install writes bound records (FOLDRUN_VAULT_WRITE_BOUND=1),
      // every env-wrapped account key is re-wrapped bound to its account (env2).
      if (rootKeyProvider() === "kms" || vaultWritesBound()) {
        const { moved, unreadable } = await rewrapTenantKeys();
        if (moved) opsLog("info", "keys.rewrapped", { count: moved, kind: rootKeyProvider() === "kms" ? "kms" : "bound" });
        if (unreadable.length) opsLog("error", "keys.reseal_failed", { count: unreadable.length });
      }
      for (const tenant of listTenants()) {
        if (await ensureTenantKey(tenant)) opsLog("info", "keys.minted", { tenant });
        const { moved, unreadable } = rewrapTenantSecrets(tenant);
        if (moved) opsLog("info", "keys.secrets_moved", { tenant, count: moved });
        if (unreadable.length) opsLog("error", "keys.secrets_unreadable", { tenant, count: unreadable.length, outcome: "left_alone" });
        // Bound records (core secrets.ts vaultAad): once written, every
        // unbound one is sealed for its place, file by file, all or nothing.
        if (vaultWritesBound()) {
          const bound = sealVaultBindings(tenant);
          if (bound.sealed) opsLog("info", "keys.secrets_bound", { tenant, count: bound.sealed });
          if (bound.unreadable.length) opsLog("error", "keys.secrets_unreadable", { tenant, count: bound.unreadable.length, outcome: "left_unbound" });
        }
      }
    } catch (err) {
      // Not fatal: without an account key the vault still opens with the
      // install key, which is where it was yesterday.
      opsError("keys.setup_failed", err);
    }
  }

  // The one-time moves of files into tables. Each is idempotent by its
  // table's own constraint and keeps a row that is already there.
  if (databaseEnabled()) {
    // Billing's own files (the wallet's billing.json), where this install
    // carries billing: billing.ts.
    for (const imp of billing().bootImports()) await importOnce(imp.label, imp.run);
    await importOnce("OAuth clients and connections", async () => {
      let n = 0;
      for (const tenant of listTenants()) {
        for (const [table, fileOf] of [[oauthClients, oauthClientFile], [oauthConnections, oauthConnectionFile]] as const) {
          const file = fileOf(tenant);
          if (!fs.existsSync(file)) continue;
          n += await importKeyedFile(table, tenant, JSON.parse(fs.readFileSync(file, "utf8")));
          fs.renameSync(file, `${file}.imported-${today()}`);
        }
      }
      return n ? `${n} OAuth clients and connections` : null;
    });
    await importOnce("credential health", async () => {
      let n = 0;
      for (const tenant of listTenants()) {
        const file = path.join(accountDir(tenant), "secret-health.json");
        if (!fs.existsSync(file)) continue;
        n += await importSecretHealthFile(tenant);
        fs.rmSync(file, { force: true });
      }
      return n ? `${n} credential health records` : null;
    });
    // The platform's own records that were files at the data root: each
    // flow's cursor, the watchdog's notices, the share links and the
    // operator's view of every account. After this the data volume holds
    // the customers' trees and nothing of ours.
    await importOnce("flow state", async () => {
      const n = await importFlowStateFiles();
      return n ? `${n} flow cursors from schedule.json and triggers.json` : null;
    });
    await importOnce("notices", async () => {
      const n = await importWatchdogFile();
      return n ? `${n} notices from watchdog.json` : null;
    });
    await importOnce("shares", async () => {
      const n = await importSharesFile();
      return n ? `${n} share links from shares.json` : null;
    });
    await importOnce("operator records", async () => {
      const { accounts, audit } = await importOperatorFiles();
      return accounts || audit ? `${accounts} operator account record(s) and ${audit} audit line(s) from operator/` : null;
    });
    // The workspaces' own records that were files: every run and its list
    // index, the trigger log, the storage index (FOL-126 phase 2), moved
    // workspace by workspace behind a barrier every process of this release
    // takes part in (records-import.ts, FOL-152 — read its ROLLOUT before
    // turning this on where processes of an older release still run). Only
    // the worker (or the one-process shape) starts it — movesRecords() — and
    // not when FOLDRUN_RECORDS=files: every other process follows the routing
    // like the rest, and moves nothing. Not through importOnce: a
    // workspace that could not be moved stays on its files for every process
    // (the routing says so), is named here, and the next boot tries again.
    // First, in either mode and before this process serves: workspaces the
    // release before this one already moved start in the database here too
    // (the import does it itself before it moves anything). Not fatal: until
    // it is done every workspace reads as files (what such a workspace's
    // files gain meanwhile is added to its rows by the move, none deleted),
    // no move starts, and the routing watch tries it again every minute.
    if (databaseEnabled() && (!recordsInDatabase() || !movesRecords())) {
      try {
        await seedRouting();
      } catch (err) {
        opsError("records.routing_seed_failed", err);
      }
    }
    if (recordsInDatabase() && movesRecords()) {
      const { counts: c, onFiles } = await importRecordsFiles();
      if (c) opsLog("info", "db.imported", { migration: "run_records", count: c.runs + c.triggerEvents + c.storageFiles });
      for (const w of onFiles.slice(0, 50)) opsLog("error", "records.on_files", { tenant: w.tenant, ...(w.workspace === "*" ? {} : { workspace: w.workspace }), reason: "import_incomplete" });
      if (onFiles.length) opsLog("error", "records.on_files_total", { count: onFiles.length });
    }
    // Workspaces as revisions (FOL-126 phase 3b), right after the records:
    // replay what a process that died left in the journal, then bring every
    // workspace's heads to its folder. In the background — a big install's
    // trees must not hold the boot — and only where the operator turned the
    // journal on. Replay is idempotent, so every pod does it; the sweep takes
    // the housekeeping lease so one pod does it.
    // Every secrets.json still without a row, into Postgres (13 Nov 2026):
    // a pod with its own data root (the egress) cannot import lazily from a
    // file it does not have. The worker does it once per boot; idempotent.
    if (movesRecords() && setting("secrets.store") === true) {
      try {
        // The fleet tool's import (vault-fleet.ts), the store's own first-use
        // import for every scope that is still only a file.
        const { importFileOnly } = await import("./vault-fleet.ts");
        const r = importFileOnly();
        if (r.imported.length || r.failed.length) opsLog(r.failed.length ? "error" : "info", "vault.files_imported", { count: r.imported.length, failed: r.failed.length });
      } catch (err) {
        opsError("vault.files_import_failed", err);
      }
    }
    // Only where the workspaces' folders are (13 Nov 2026): replay and the
    // reconcile compare the journal and the heads with the folder, and a pod
    // whose data root is its own disk (the egress, the assistant) would read
    // every workspace as empty — dropping journal entries, publishing empty
    // heads, or marking history orphaned.
    // Folders as a copy of the heads (revisions.mirror): every workspace is
    // brought here BEFORE anything reads or reconciles it — an empty disk must
    // never be taken for the truth — then kept current every few seconds.
    const mirrors = holdsWorkspaces() || roleOf() === "assistant"; // the assistant reads workspaces, never writes them
    if (mirrors && mirrorOn()) {
      await syncAccountFolders().catch((err) => opsError("revisions.mirror_accounts_failed", err, {}, "warn"));
      const r = await syncAllFromHeads().catch((err) => {
        opsError("revisions.mirror_boot_failed", err);
        return null;
      });
      if (r) opsLog("info", "revisions.mirror_synced", { count: r.synced, removed: r.removed, failed: r.failed });
    }
    if (mirrors) startMirrorLoop();
    if (setting("revisions.journal") === true && holdsWorkspaces()) void recoverRevisions();
    // The ledger's history, per account, loud but not fatal: the file is
    // still authoritative for reads where this failed, and refusing to boot
    // would take the platform down over history rather than money in flight.
    for (const tenant of listTenants()) {
      try {
        const n = await importLedgerToDatabase(tenant);
        if (n) opsLog("info", "db.ledger_imported", { tenant, count: n });
      } catch (err) {
        opsError("db.ledger_import_failed", err, { tenant });
      }
    }
  }

}

/** The worker's half: gallery, reconcile, queue recovery, then the loops. Once. */
export function startLoops(): Promise<void> {
  started ??= startLoopsOnce();
  return started;
}

async function startLoopsOnce(): Promise<void> {
  // Gallery tools an account installed and never edited follow the gallery.
  // Workers only, behind a lease, so replicas booting together write once.
  try {
    for (const r of await syncAllGalleryCopies(`${dataRoot()}/.locks`)) {
      if (r.upgraded.length) opsLog("info", "gallery.upgraded", { tenant: r.tenant, count: r.upgraded.length });
      if (r.kept.length) opsLog("info", "gallery.kept_edited", { tenant: r.tenant, count: r.kept.length });
      if (r.forgotten?.length) opsLog("info", "gallery.forgotten", { tenant: r.tenant, count: r.forgotten.length });
    }
  } catch (err) {
    opsError("gallery.sync_failed", err);
  }

  // Runs left `running` by a process that stopped are closed out — but
  // never a run a live neighbour is driving: ask the queue first.
  // Loud, not fatal: on 20 Oct 2026 one account's unreadable agent file threw
  // out of here and the worker never came up for anyone. A run left
  // `running` is closed on the next boot, or by the person who stops it.
  try {
    for (const closed of reconcileAllRuns(Date.now(), await liveClaimedRuns(), afterReconciled)) {
      opsLog("info", "reconcile.closed_abandoned_run", { tenant: closed.tenant, workspace: closed.workspace, runId: closed.runId, count: closed.interrupted.length });
    }
  } catch (err) {
    opsError("reconcile.abandoned_runs_failed", err);
  }

  // Recover the queue before the worker starts: file-queue jobs become rows,
  // claimed jobs whose driver died go back to pending.
  const movedJobs = await importQueueToDatabase();
  if (movedJobs) opsLog("info", "db.jobs_moved", { count: movedJobs });
  // A multi-tenant install without step isolation must not come up at all.
  assertIsolationSafe();
  const { requeued, dropped } = await recoverQueue();
  if (requeued.length || dropped.length) {
    opsLog("info", "queue.recovered", { count: requeued.length, tries: dropped.length });
  }
  startWorker();
  startScheduler();
  startBlobSweepLoop();
  // Tools on demand (tool-pod.ts): each account's parser pod while it has an
  // extraction in flight, gone after the idle window. Off unless switched on.
  startToolPods();
  // Cloud browser calls with no run (FOL-313, browse-jobs.ts): web_browse on
  // /v1/messages and the laptop's cloud browser. Where this worker can make
  // pods (the cluster, with the runner image) and the egress proxy is there.
  if (process.env.FOLDRUN_RUN_ISOLATION === "k8s" && process.env.FOLDRUN_EGRESS_URL) {
    void import("./browse-jobs.ts")
      .then(async (m) => m.startBrowseJobs(await m.browseJobDeps()))
      .catch((err) => opsError("browse_job.start_failed", err));
  }
  // Images and PDFs in gateway calls (FOL-268, media-reads.ts): the gateway may not reach the parser, so the
  // worker reads them — where this worker can read files at all (a fixed parser, or its pods on demand).
  void import("./extract.ts")
    .then(async (x) => {
      const { toolsOnDemand } = await import("./tool-pod.ts");
      if (!x.extractConfigured() && !toolsOnDemand()) return;
      const m = await import("./media-reads.ts");
      // In the account's extraction slot, held while the parser reads (its pod kept up while it does).
      m.startMediaReads((tenant, bytes, o) => x.withExtractSlot(tenant, o.actor, () => x.extractFile(tenant, bytes, { name: o.name, signal: o.signal })));
    })
    .catch((err) => opsError("media_read.start_failed", err));
  // Rotated OAuth refresh tokens of released v2 leases reach the vault even
  // when no run is being driven (egress-proxy.ts).
  startEgressRotationRecovery();
  // The assistant's replies have their own Deployment (FOLDRUN_ROLE=assistant)
  // so a burst of chat never takes a run's turn and a run worker's quick
  // shutdown never cuts a reply off. The single-process shape has no such
  // Deployment, so it runs them here.
  if (roleOf() === "all") startAssistantWorker();
}

async function importOnce(what: string, run: () => Promise<string | null>): Promise<void> {
  try {
    const done = await run();
    if (done) opsLog("info", "db.imported", { migration: what });
  } catch (err) {
    opsError("db.import_failed", err, { migration: what });
  }
}

const today = () => new Date().toISOString().slice(0, 10);
