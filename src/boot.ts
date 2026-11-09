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
import { setting, startSettings } from "./settings.ts";
import { withHousekeeping } from "./housekeeping.ts";
import { startBlobSweepLoop } from "./blob-sweep-job.ts";
import { recoverJournal, reconcileAll } from "../../foldrun-core/src/workspace-revisions.ts";

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

export type Role = "web" | "worker" | "all" | "egress" | "assistant";

/** Which loops a process runs: `web` serves and runs nothing; `worker`
 *  drives runs and ticks the scheduler; `assistant` runs the dashboard
 *  assistant's replies and nothing else (assistant-worker.ts); `all` is the
 *  single-process shape (the laptop), every loop. Read from FOLDRUN_ROLE;
 *  `all` when unset. */
export function roleOf(): Role {
  const r = process.env.FOLDRUN_ROLE ?? "all";
  if (r === "web" || r === "worker" || r === "all" || r === "egress" || r === "assistant") return r;
  throw new Error(`FOLDRUN_ROLE must be web, worker, assistant, egress or all, not "${r}"`);
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
    if (setting("revisions.journal") === true) void recoverRevisions();
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
