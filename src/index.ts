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

import fs from "node:fs";
import path from "node:path";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { materialiseGallery } from "./gallery.ts";
import { edition } from "./ledger.ts";
import { billing } from "./billing.ts";
import { registerPlatform } from "../../foldrun-core/src/platform.ts";
import { INSTALL_MARKER } from "../../foldrun-core/src/layout.ts";
import { setSecretHealthStore } from "../../foldrun-core/src/secret-health.ts";
import { databaseEnabled } from "./db.ts";
import { secretHealthDbStore } from "./secret-health-db.ts";
import { enqueueFlowRun, enqueueResume } from "./queue.ts";
import { runStepInK8s, killRunPods, killRunPod, killOrphanPods } from "./run-k8s.ts";
import { syncPublicShares } from "./shares.ts";
import { tenantKey } from "./tenant-keys.ts";
import { egressHooks } from "./egress-proxy.ts";
import { markScheduleDirty } from "./scheduler.ts";
import { runMeter } from "../../foldrun-core/src/store.ts";
import { admitTrigger, rollbackTrigger } from "./trigger-gate.ts";
import { noteOAuthRefresh } from "./oauth-connections.ts";
import { fetchPublic } from "./ssrf.ts";
import { deliverWebhook } from "./webhook-deliveries.ts";
import { mailAllowed } from "./email-preferences.ts";

let installed = false;

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
    console.warn("[platform] install marker not written:", err instanceof Error ? err.message : err);
  }
  const galleryRoot = path.join(dataRoot(), "gallery");
  try {
    materialiseGallery(galleryRoot);
  } catch (err) {
    console.warn("[platform] gallery not materialised:", err instanceof Error ? err.message : err);
  }
  // Credential health: one atomic upsert per use in Postgres, where a file
  // shared by several pods lost updates. Without a database, the file.
  if (databaseEnabled()) setSecretHealthStore(secretHealthDbStore);
  registerPlatform({
    galleryDir: () => galleryRoot,
    // Hosted or self-hosted — the one predicate the dashboard's commercial
    // surfaces ask. Decided by configuration, never by which build this is.
    edition,
    enqueueFlowRun,
    enqueueResume,
    // `budget:` against the whole bill. runMeter counts only steps that
    // finished, which is exactly the granularity the cap is checked at —
    // between groups, where every earlier step has its seconds recorded.
    runSpend: (run) => billing().price(runMeter(run)).totalUsd,
    // idempotency:, throttle:, debounce:, disable_after: — all four need
    // state that outlives one delivery, which is a platform thing to hold.
    admitTrigger: (tenant, workspace, flow, opts) => admitTrigger(tenant, workspace, flow, opts),
    rollbackTrigger: (tenant, workspace, flow, opts) => rollbackTrigger(tenant, workspace, flow, opts),
    isolation: { k8s: runStepInK8s },
    killRunSandboxes: (runId) => {
      if (process.env.FOLDRUN_RUN_ISOLATION === "k8s") killRunPods(runId);
    },
    killOrphanSandboxes: (runId, keep) => {
      if (process.env.FOLDRUN_RUN_ISOLATION === "k8s") killOrphanPods(runId, keep);
    },
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
    // The platform's own model credential (the operator's key or Claude
    // login) is for the operator's accounts; every other account brings an
    // API key (Settings → Model). FOLDRUN_PLATFORM_KEY_ACCOUNTS names them,
    // comma-separated; unset (a laptop, a self-hosted install) means every
    // account, as before.
    platformKeyAllowed: (tenant) => platformKeyAllowed(tenant),
    // OAuth health: a dead grant is emailed once with a one-click reconnect,
    // and the step that hit it quotes the same link.
    noteOAuthRefresh,
    // Webhooks, OAuth token endpoints, provider base URLs, OpenAPI sources:
    // URLs a tenant chose, fetched from a tier that can reach inward.
    fetchUntrusted: fetchPublic,
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
 *  credential? Read on every call, so a changed list takes effect on the
 *  next step without a restart of anything that caches it. */
export function platformKeyAllowed(tenant: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.FOLDRUN_PLATFORM_KEY_ACCOUNTS ?? "").trim();
  if (!raw || raw === "*") return true;
  return raw.split(",").map((t) => t.trim()).filter(Boolean).includes(tenant);
}
