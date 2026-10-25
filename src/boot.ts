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

import fs from "node:fs";
import path from "node:path";
import { installPlatform } from "./index.ts";
import { migrate, databaseEnabled } from "./db.ts";
import { loadTenantKeys, ensureTenantKey, rewrapTenantKeys, rootKeyProvider, startTenantKeyRefresh } from "./tenant-keys.ts";
import { rewrapTenantSecrets } from "../../foldrun-core/src/secrets.ts";
import { listTenants, accountDir } from "../../foldrun-core/src/store.ts";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { billing } from "./billing.ts";
import { importKeyedFile } from "./keyed-store.ts";
import { oauthClients, oauthConnections } from "./schema.ts";
import { oauthClientFile } from "./oauth-clients.ts";
import { oauthConnectionFile } from "./oauth-connections.ts";
import { importSecretHealthFile } from "./secret-health-db.ts";
import { importLedgerToDatabase } from "./ledger.ts";
import { importFlowStateFiles } from "./flow-state.ts";
import { importWatchdogFile } from "./notices.ts";
import { importSharesFile } from "./shares.ts";
import { importOperatorFiles } from "./admin.ts";
import { syncAllGalleryCopies } from "./gallery.ts";
import { reconcileAllRuns } from "../../foldrun-core/src/runner.ts";
import { liveClaimedRuns, importQueueToDatabase, recoverQueue, startWorker, assertIsolationSafe, afterReconciled } from "./queue.ts";
import { startScheduler } from "./scheduler.ts";
import { startAssistantWorker } from "./assistant/jobs.ts";

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
      if (applied.length) console.log(`[db] applied ${applied.join(", ")}`);
    } catch (err) {
      // Loud, and fatal: serving against a half-migrated schema is how a
      // platform corrupts the records it was given a database to protect.
      console.error("[db] migration failed:", err);
      throw err;
    }
  }

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
      if (rootKeyProvider() === "kms") {
        const { moved, unreadable } = await rewrapTenantKeys();
        if (moved) console.log(`[keys] ${moved} account key(s) now sealed by KMS`);
        if (unreadable.length) console.error(`[keys] could not re-seal: ${unreadable.join(", ")}`);
      }
      for (const tenant of listTenants()) {
        if (await ensureTenantKey(tenant)) console.log(`[keys] minted an account key for ${tenant}`);
        const { moved, unreadable } = rewrapTenantSecrets(tenant);
        if (moved) console.log(`[keys] moved ${moved} secret(s) for ${tenant} onto its own key`);
        if (unreadable.length) console.error(`[keys] ${tenant}: left alone, ${unreadable.length} secret(s) unreadable`);
      }
    } catch (err) {
      // Not fatal: without an account key the vault still opens with the
      // install key, which is where it was yesterday.
      console.error("[keys] account key setup failed:", err);
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
    // The ledger's history, per account, loud but not fatal: the file is
    // still authoritative for reads where this failed, and refusing to boot
    // would take the platform down over history rather than money in flight.
    for (const tenant of listTenants()) {
      try {
        const n = await importLedgerToDatabase(tenant);
        if (n) console.log(`[db] imported ${n} ledger entries for ${tenant}`);
      } catch (err) {
        console.error(`[db] ledger import failed for ${tenant}:`, err);
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
      if (r.upgraded.length) console.log(`[gallery] ${r.tenant}: upgraded ${r.upgraded.join(", ")}`);
      if (r.kept.length) console.log(`[gallery] ${r.tenant}: edited, left as is: ${r.kept.join(", ")}`);
      if (r.forgotten?.length) console.log(`[gallery] ${r.tenant}: forgot stamps for ${r.forgotten.join(", ")} (no longer in the gallery)`);
    }
  } catch (err) {
    console.error("[gallery] sync failed:", err);
  }

  // Runs left `running` by a process that stopped are closed out — but
  // never a run a live neighbour is driving: ask the queue first.
  // Loud, not fatal: on 20 Oct 2026 one account's unreadable agent file threw
  // out of here and the worker never came up for anyone. A run left
  // `running` is closed on the next boot, or by the person who stops it.
  try {
    for (const closed of reconcileAllRuns(Date.now(), await liveClaimedRuns(), afterReconciled)) {
      console.log(
        `[foldrun] closed abandoned run ${closed.tenant}/${closed.workspace}/${closed.runId}` +
          (closed.interrupted.length ? ` — interrupted: ${closed.interrupted.join(", ")}` : ""),
      );
    }
  } catch (err) {
    console.error("[foldrun] reconciling abandoned runs failed:", err);
  }

  // Recover the queue before the worker starts: file-queue jobs become rows,
  // claimed jobs whose driver died go back to pending.
  const movedJobs = await importQueueToDatabase();
  if (movedJobs) console.log(`[db] moved ${movedJobs} queued job(s) into the database`);
  // A multi-tenant install without step isolation must not come up at all.
  assertIsolationSafe();
  const { requeued, dropped } = await recoverQueue();
  if (requeued.length || dropped.length) {
    console.log(`[foldrun] queue recovered — requeued ${requeued.length}, dropped ${dropped.length}`);
  }
  startWorker();
  startScheduler();
  // The assistant's replies have their own Deployment (FOLDRUN_ROLE=assistant)
  // so a burst of chat never takes a run's turn and a run worker's quick
  // shutdown never cuts a reply off. The single-process shape has no such
  // Deployment, so it runs them here.
  if (roleOf() === "all") startAssistantWorker();
}

async function importOnce(what: string, run: () => Promise<string | null>): Promise<void> {
  try {
    const done = await run();
    if (done) console.log(`[db] imported ${done}`);
  } catch (err) {
    console.error(`[db] ${what} import failed:`, err);
  }
}

const today = () => new Date().toISOString().slice(0, 10);
