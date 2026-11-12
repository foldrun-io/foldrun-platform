// @foldrun/platform — the engine that runs foldrun on a server.
//
// Source-available (FSL-1.1-ALv2, LICENSE). @foldrun/core is the format, the
// runner and the checks; this package is the queue and its worker, pods on a
// cluster or containers on one machine, per-account keys, branch previews,
// share links, tenancy and roles. foldrun's hosted billing is reached only
// through billing.ts. It imports core by sibling path — the repos sit side
// by side and the layout is the wiring — and plugs into it through core's
// platform.ts. Core never imports this.
//
// registerPlatform() below is the one call a platform process must make at
// boot, before anything runs a step or reads a secret. A process that does
// not is a local install, which is the safe failure.

import { opsError } from "../../foldrun-core/src/ops-log.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { materialiseGallery } from "./gallery.ts";
import { edition } from "./ledger.ts";
import { billing } from "./billing.ts";
import { registerPlatform, hostUrlProblem } from "../../foldrun-core/src/platform.ts";
import { platformExtractHooks } from "./extract.ts";
import { INSTALL_MARKER } from "../../foldrun-core/src/layout.ts";
import { setSecretHealthStore } from "../../foldrun-core/src/secret-health.ts";
import { setVaultStore } from "../../foldrun-core/src/secrets.ts";
import { pgVaultStore } from "./vault-pg.ts";
import { databaseEnabled } from "./db.ts";
import { pgRecords, recordsInDatabase } from "./records-pg.ts";
import { pgRevisionStore } from "./revision-store-pg.ts";
import { pgBlobPins } from "./blob-pins.ts";
import { blobStore } from "../../foldrun-core/src/blob-store.ts";
import { pgJournalStore } from "./journal-pg.ts";
import { pgSweepMarks } from "./sweep-marks-pg.ts";
import { setRevisionBackend, flushRevisions } from "../../foldrun-core/src/workspace-revisions.ts";
import { setRunOutputsBackend } from "../../foldrun-core/src/run-outputs.ts";
import { pgRunOutputStore } from "./run-outputs-pg.ts";
import { secretHealthDbStore } from "./secret-health-db.ts";
import { enqueueFlowRun, enqueueResume } from "./queue.ts";
import { runStepInK8s, killRunPods, killRunPod, killOrphanPods, roomCheckK8s } from "./run-k8s.ts";
import { syncPublicShares } from "./shares.ts";
import { tenantKey } from "./tenant-keys.ts";
import { egressHooks } from "./egress-proxy.ts";
import { markScheduleDirty } from "./scheduler.ts";
import { runMeter } from "../../foldrun-core/src/store.ts";
import { admitTrigger, rollbackTrigger } from "./trigger-gate.ts";
import { noteOAuthRefresh } from "./oauth-connections.ts";
import { fetchPublic, refuseInternalUrl } from "./ssrf.ts";
import { deliverWebhook } from "./webhook-deliveries.ts";
import { mailAllowed } from "./email-preferences.ts";
import { platformKeyAllowedFor, setting, settingText } from "./settings.ts";
import { modelSupplyFor } from "./model-choice.ts";
import { confinesBrowsing, wallsRestrictedSteps } from "./browse-confine.ts";

let installed = false;

/**
 * Where this process keeps its copy of the gallery (the built-in tools, made
 * from code on every boot). In Kubernetes each pod keeps its own on local
 * scratch (/tmp): runs get it copied in by the worker (run-k8s.ts), never
 * through a shared disk, so it need not sit on EFS (FOL-126 gap, 12 Nov
 * 2026). Anywhere else — Compose, where run containers mount host paths; a
 * laptop — it stays under the data root.
 */
export function galleryRootFor(env: NodeJS.ProcessEnv = process.env, root = (): string => dataRoot()): string {
  if (env.KUBERNETES_SERVICE_HOST) return path.join(os.tmpdir(), "foldrun-gallery");
  return path.join(root(), "gallery");
}

/** Plug the platform into core. Idempotent. */
export function installPlatform(): void {
  if (installed) return;
  installed = true;
  // The built-in tools, on disk where every account's runs can read them.
  // Written every boot so a gallery change ships with the deploy; an
  // account's own library copies shadow these by name.
  // The installation's marker at the data root, so the CLI run against this
  // data directory knows it is an installation (layout.ts). keys.json used
  // to be that marker; keys now live in the database.
  try {
    const marker = path.join(dataRoot(), INSTALL_MARKER);
    if (!fs.existsSync(marker)) fs.writeFileSync(marker, "");
  } catch (err) {
    opsError("platform.install_marker_not_written", err, {}, "warn");
  }
  const galleryRoot = galleryRootFor();
  try {
    materialiseGallery(galleryRoot);
  } catch (err) {
    opsError("platform.gallery_not_materialised", err, {}, "warn");
  }
  // Credential health: one atomic upsert per use in Postgres, where a file
  // shared by several pods lost updates. Without a database, the file.
  if (databaseEnabled()) setSecretHealthStore(secretHealthDbStore);
  // The vault's scopes as rows (FOL-126 phase 6), when `secrets.store` is on.
  if (databaseEnabled()) setVaultStore(pgVaultStore(() => setting("secrets.store") === true, () => setting("secrets.mirror") !== false));
  // Workspace revisions (FOL-126 phase 3b): with a database the store is
  // wired, but nothing happens until the operator turns `revisions.journal`
  // on (settings.ts; FOLDRUN_REVISIONS=1 is the same switch from the
  // environment). Then every write is also committed as a revision — written
  // to the journal on disk first, committed in the background, replayed at
  // boot — and `revisions.read` additionally serves reads from heads. Both
  // are read per call, so a change takes effect within a settings poll.
  if (databaseEnabled()) {
    setRevisionBackend(
      { blobs: blobStore(), revisions: pgRevisionStore(), pins: pgBlobPins() },
      {
        journal: () => setting("revisions.journal") === true,
        read: () => setting("revisions.read") === true,
        // How many state/ checkpoints stay (state-retention.ts); read per call.
        // Where "first seen without a folder" is kept, so the boot reconcile can
        // remove the history of workspaces deleted before the delete took it.
        sweepMarks: pgSweepMarks(),
        stateRetention: () => ({ keep: Number(setting("revisions.state_keep") ?? 100), days: Number(setting("revisions.state_days") ?? 30) }),
        // The journal's entries are rows, not files on the shared volume
        // (FOL-126 phase 4); what the volume still holds from before is
        // replayed at boot. With FOLDRUN_RECORDS=files there is no sync
        // bridge to ask, so the files stay.
        ...(recordsInDatabase() ? { journalStore: pgJournalStore() } : {}),
      },
    );
    // Run outputs (FOL-126 phase 5): published to the object store when a run
    // ends, behind `runs.outputs_store` (off = copied to the volume, as before).
    // Read per call, so a change takes effect for the next run to finish.
    setRunOutputsBackend({
      blobs: blobStore(),
      pins: pgBlobPins(),
      store: pgRunOutputStore(),
      enabled: () => setting("runs.outputs_store") === true,
      fileMaxBytes: () => Number(setting("runs.output_file_mb") ?? 64) * 1048576,
      runMaxBytes: () => Number(setting("runs.output_run_mb") ?? 512) * 1048576,
    });
    process.once("beforeExit", () => void flushRevisions());
  }
  registerPlatform({
    // Runs, the run index, the trigger log and the storage file index are
    // rows where there is a database (FOL-126 phase 2) — per workspace, as
    // the routing every process shares says (records-routing.ts, FOL-152).
    // Registered in BOTH modes: with FOLDRUN_RECORDS=files this process never
    // starts a move, but a workspace another process moved is rows here too.
    ...(databaseEnabled() ? { records: pgRecords({ stepStateOn: () => setting("runs.step_state_store") === true }) } : {}),
    galleryDir: () => galleryRoot,
    // Hosted or self-hosted — the one predicate the dashboard's commercial
    // surfaces ask. Decided by configuration, never by which build this is.
    edition,
    enqueueFlowRun,
    enqueueResume,
    // `budget:` against the whole bill. runMeter counts only steps that
    // finished, which is exactly the granularity the cap is checked at —
    // between groups, where every earlier step has its seconds recorded.
    runSpend: (run) => billing().price(runMeter(run), null, run.pricing ?? null).totalUsd,
    // idempotency:, throttle:, debounce:, disable_after: — all four need
    // state that outlives one delivery, which is a platform thing to hold.
    admitTrigger: (tenant, workspace, flow, opts) => admitTrigger(tenant, workspace, flow, opts),
    rollbackTrigger: (tenant, workspace, flow, opts) => rollbackTrigger(tenant, workspace, flow, opts),
    isolation: { k8s: runStepInK8s },
    // k8s can hold a snapshot step (Part B3: staging, patch, outputs-only copy-back).
    holdsSnapshot: (isolation) => isolation === "k8s",
    // A run's inputs (FOL-163): staged into the pod, never copied back.
    holdsInputs: (isolation) => isolation === "k8s",
    // ...with `<file>.txt` beside the media ones, when this install has the
    // extraction pods (FOLDRUN_EXTRACT_URL); without them, no hook, no .txt,
    // and nothing promised in the step's prompt.
    ...platformExtractHooks(),
    killRunSandboxes: (runId) => {
      if (process.env.FOLDRUN_RUN_ISOLATION === "k8s") killRunPods(runId);
    },
    killOrphanSandboxes: (runId, keep) => {
      if (process.env.FOLDRUN_RUN_ISOLATION === "k8s") killOrphanPods(runId, keep);
    },
    roomCheck: async (ask) => (process.env.FOLDRUN_RUN_ISOLATION === "k8s" ? roomCheckK8s(ask) : null),
    killSandbox: (sandbox) => {
      if (process.env.FOLDRUN_RUN_ISOLATION === "k8s" && sandbox.kind === "k8s") killRunPod(sandbox.ref);
    },
    syncPublicShares,
    tenantKey,
    // Per-step leases on the egress proxy. Hands out null until
    // FOLDRUN_EGRESS_URL names the address pods reach the worker at — and
    // then the runner keeps credentials out of the sandbox.
    egress: egressHooks,
    // The scheduler keeps every flow in memory and re-reads a workspace only
    // when told; this is how it is told, from whichever pod took the write.
    workspaceChanged: (tenant, workspace) => markScheduleDirty(tenant, workspace),
    // A k8s step pod keeps its log and files until a driver acks: a driver
    // that inherits the run re-attaches instead of running the step again.
    sandboxResumable: (kind) => kind === "k8s",
    // FOL-110 phase 3: a browsing step held to its list where the k8s tier
    // walls its pod and FOLDRUN_BROWSE_ENFORCE=1 (browse-confine.ts).
    confinesBrowsing,
    // FOL-128: a restricted, enforced step is walled on the k8s tier, and
    // searches through the proxy's search door (search-door.ts).
    wallsRestricted: wallsRestrictedSteps,
    // The platform's own model credential (the operator's key or Claude
    // login) is for the operator's accounts; every other account brings an
    // API key (Settings → Models). Hosted: the operator's per-account lever,
    // fail-closed (settings.ts platformKeyAllowedFor). Self-hosted:
    // FOLDRUN_PLATFORM_KEY_ACCOUNTS, unset meaning every account, as before.
    platformKeyAllowed: (tenant) => platformKeyAllowed(tenant),
    // foldrun's models: what the account chose, and whether it can have it
    // now (model-choice.ts). Hosted only — an install that bills nothing
    // offers nothing, and every call is refused at the gateway anyway.
    modelSupply: (tenant) => (edition() === "hosted" ? modelSupplyFor(tenant) : { kind: "none" }),
    // Operator settings core reads (mail sender and caps, step sizes): the
    // operator's row over the environment variable (settings.ts).
    setting: (env) => settingText(env),
    // OAuth health: a dead grant is emailed once with a one-click reconnect,
    // and the step that hit it quotes the same link.
    noteOAuthRefresh,
    // Webhooks, OAuth token endpoints, provider base URLs, OpenAPI sources:
    // URLs a tenant chose, fetched from a tier that can reach inward.
    fetchUntrusted: fetchPublic,
    // The early refusal for those URLs — a remotes: card, a provider base URL
    // — before anything is sent: an internal or private address named
    // outright, then core's https rule. fetchPublic still checks every hop.
    checkUntrustedUrl: async (url) => refuseInternalUrl(url) ?? hostUrlProblem(url),
    // notify: webhooks as recorded deliveries, retried on a backoff from
    // the scheduler's tick, each attempt in the log.
    deliverWebhook: (tenant, workspace, d) => deliverWebhook(tenant, workspace, d),
    // Profile → Notifications and the unsubscribe links, asked at send time.
    mailPreference: mailAllowed,
  });
}

// Importing this module is opting in: every platform entry point (the web
// server's instrumentation, the worker, a test that drives the queue) does.
installPlatform();

/** Is this account one of the operator's, allowed the platform's own model
 *  credential? Read on every call, from the settings snapshot (polled), so
 *  a change takes effect within a poll without a restart. */
export function platformKeyAllowed(tenant: string, env: NodeJS.ProcessEnv = process.env, hosted: boolean = edition() === "hosted"): boolean {
  return platformKeyAllowedFor(tenant, hosted, env);
}
