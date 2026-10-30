// The Kubernetes executor: the same step isolation as run-container.ts,
// spoken to a cluster instead of a docker daemon. Selected with
// FOLDRUN_RUN_ISOLATION=k8s; this is what replaces the dind sidecar — pods
// scheduled by the cluster, gVisor via runtimeClassName, egress policy via
// NetworkPolicy on the run namespace.
//
// Same protocol, same driver, same image, same copy-out filter. What
// differs is plumbing: a pod cannot be created stopped the way a container
// can, so the pod starts as a shim that waits for a `go` marker; the files
// are copied in while it idles, the marker released, the driver's JSONL
// read from `kubectl logs -f`, and the pod holds after finishing until the
// host acknowledges the copy-out — a terminated pod cannot be copied from.
//
//   FOLDRUN_RUNNER_IMAGE      required — the runner image, already in the
//                             cluster (k3d image import / a registry)
//   FOLDRUN_RUNNER_SLIM_IMAGE optional — the same image without browsers,
//                             for steps that grant no browsing (runnerImageFor)
//   FOLDRUN_K8S_NAMESPACE     default foldrun-runs
//   FOLDRUN_KUBECTL           default kubectl (kubeconfig from the env)
//   FOLDRUN_RUNNER_RUNTIME    a RuntimeClass name, e.g. gvisor

import { noteSharedUse } from "./runtime-warm.ts";
import { refusedLine, keptLine, type RefusedPath } from "../../foldrun-core/src/copy-back.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  applyContainerChanges,
  hashTree,
  writeHandedIn,
  readHandedIn,
  dropHandedIn,
  mtimeManifest,
  APPLY_MTIMES_JS,
  parseDriverLine,
  parseDriverMark,
  timingLine,
  resolveResources,
  classDisk,
  k8sMemory,
  RUN_LABEL,
  RUNTIME_CACHE,
  INSTALL_HELPER_SH,
  SHARED_RUNTIMES,
  type ContainerStepOutcome,
  type RunInContainerArgs,
  type StepLimits,
  type StepTiming,
  type StartupPhases,
} from "../../foldrun-core/src/run-container.ts";
import { safeTenantSegment, systemInstallSh, SYSTEM_FROM_INPUT_SH } from "../../foldrun-core/src/runtime.ts";
import { POD_EVENTS_ENV, POD_EVENTS_FILE, POD_ONLY_ENV, slimBrowseBlocker } from "../../foldrun-core/src/browser-pod.ts";
import { ACCOUNT_LABEL, accountSegment, ensureSearchPod, perAccountSearchEnabled, searchUrl } from "./search-k8s.ts";
import { browserWs, ensureBrowserPod, perAccountBrowserEnabled } from "./browser-k8s.ts";
import { NETWORK_LABEL } from "./account-pod.ts";
import { egressCaSh } from "../../foldrun-core/src/network.ts";
import { admitPod, anyRoomLimit, memGiB, roomFor, roomLimits, stopWaitingFor, tooBig, WORKSPACE_LABEL, type PodLike, type RoomLimits, type RoomWaiter } from "./pod-room.ts";
import { accountCompute, roomWaiting, runCompute, workspaceCompute, type ComputePool } from "./limits.ts";

/** On a test run's pod; the label the run namespace's deny-world policy selects on. */
export const TEST_LABEL = "foldrun.io/test";
import { isPlatformPath, listTenants, readRun } from "../../foldrun-core/src/store.ts";
import { overlayTestWrites } from "../../foldrun-core/src/test-mode.ts";
import { resolveRunPath } from "../../foldrun-core/src/script-tools.ts";

const kubectl = () => process.env.FOLDRUN_KUBECTL ?? "kubectl";
const namespace = () => process.env.FOLDRUN_K8S_NAMESPACE ?? "foldrun-runs";
/**
 * The claim backing the dependency cache, in the *run* namespace — PVCs are
 * namespaced, so the platform's own foldrun-data claim is not reachable from
 * here even though it is on the same disk. Unset means no cache: every step
 * installs fresh, which is exactly the behaviour that shipped before this.
 * That default matters, because a name pointing at a claim that does not
 * exist leaves every run pod Pending, and a slow platform beats a stopped one.
 */
export const cachePvc = () => process.env.FOLDRUN_RUNTIME_CACHE_PVC ?? "";

/** The claim's sub-directory holding the platform's shared runtime layer.
 *  A leading underscore can never be a tenant (safeTenantSegment requires a
 *  letter or digit first), so it cannot collide with an account's cache. */
export const SHARED_SUBPATH = "_shared";

/** Is the shared layer on? It needs the cache claim, and can be turned off. */
export const sharedLayerEnabled = () => Boolean(cachePvc()) && process.env.FOLDRUN_RUNTIME_SHARED_CACHE !== "0";

/**
 * One claim per account instead of one sub-directory per account — set in
 * prod, where the claim's StorageClass makes an EFS access point for each
 * (manifests/prod/storage.yaml, `efs-account`). A subPath keeps accounts apart
 * only while the kubelet's subPath handling holds; an access point is the
 * filesystem itself refusing a path outside the account's own root, so a
 * sandbox that escaped its mount still cannot read or poison another
 * account's environments. Unset (the box, NFS): the shared claim and its
 * per-account sub-directories, exactly as before. The platform's shared
 * read-only layer stays on the shared claim either way.
 */
export const accountCacheClass = () => process.env.FOLDRUN_RUNTIME_CACHE_ACCOUNT_CLASS ?? "";

/** The account's own cache claim: `rtc-<account label>`, a valid name by
 *  construction (the label is [a-z0-9-], at most 40). */
export function accountCacheClaim(tenant: string): string | null {
  const seg = accountSegment(tenant);
  return seg ? `rtc-${seg}` : null;
}

export function accountCachePvcManifest(tenant: string, storageClass: string): object | null {
  const claim = accountCacheClaim(tenant);
  if (!claim) return null;
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: { name: claim, namespace: namespace(), labels: { app: "foldrun-runtime-cache", [ACCOUNT_LABEL]: accountSegment(tenant)! } },
    spec: {
      accessModes: ["ReadWriteMany"],
      storageClassName: storageClass,
      // EFS is elastic; the number only has to satisfy the claim.
      resources: { requests: { storage: "20Gi" } },
    },
  };
}

// Claims this process has already applied: a kubectl round trip per step to
// re-apply an unchanged claim is latency on every step for nothing.
const ensuredClaims = new Set<string>();

/** Make sure the account's claim exists before a pod names it — a pod naming
 *  a missing claim sits Pending until the step's watch gives up. */
async function ensureAccountCache(tenant: string | undefined, kc: (args: string[], input?: string) => Promise<{ status: number | null; out: string }>): Promise<void> {
  const klass = accountCacheClass();
  if (!klass || !cachePvc() || !tenant) return;
  const manifest = accountCachePvcManifest(tenant, klass);
  const claim = accountCacheClaim(tenant);
  if (!manifest || !claim || ensuredClaims.has(claim)) return;
  const r = await kc(["apply", "-f", "-"], JSON.stringify(manifest));
  if (r.status !== 0) throw new Error(`runtime cache claim ${claim} could not be created:\n${r.out.slice(0, 600)}`);
  ensuredClaims.add(claim);
}

// The shim the pod runs. Stages: wait for files, take the env, hand the
// tree to the agent user, run the driver, then hold for the ack so the
// workspace can be copied out of a still-live container.
// The wait for `go` is bounded (10 minutes): if the platform dies between
// creating the pod and writing the marker, the shim exits instead of holding
// its reservation forever — the one orphan a step deadline used to reap, now
// that a step with no \`timeout:\` carries none.
/** The driver's `done` line in a whole log, if it wrote one. */
export function doneInLog(log: string): (ContainerStepOutcome & { e: "done" }) | null {
  for (const line of log.split("\n")) {
    const parsed = parseDriverLine(line);
    if (parsed && parsed.e === "done") return parsed as ContainerStepOutcome & { e: "done" };
  }
  return null;
}

/** The sentence for a driver that exited with no result: its exit code and
 *  the last lines it said that were not the protocol — stderr, where a
 *  crash explains itself. */
export function exitedWithoutResult(exitCode: string, log: string): string {
  const said = log.split("\n").map((l) => l.trim()).filter((l) => l && !parseDriverLine(l)).slice(-6).map((l) => l.slice(0, 300));
  return `the step's program exited (code ${exitCode.trim() || "?"}) without reporting a result${said.length ? `: ${said.join(" · ")}` : ""}`;
}

/** How often a live step is checked for a driver that exited without a done
 *  line, and how long a done line gets to arrive after the exit. */
const exitWatchMs = () => Number(process.env.FOLDRUN_K8S_EXIT_WATCH_MS) || 30_000;
const exitGraceMs = () => Number(process.env.FOLDRUN_K8S_EXIT_GRACE_MS ?? 10_000);

/** How long after pod Ready to wait before the first exec, to let the CNI
 *  program the pod's NetworkPolicy (see where it is used). FOLDRUN_POLICY_FLOOR_MS
 *  overrides the 2000 ms default; 0 is allowed (a CNI proven to enforce from
 *  Ready). Not a plain `Number(env) || 2000`: that would turn a deliberate 0
 *  back into 2000. Anything that is not a whole, non-negative number of
 *  milliseconds is ignored, with a warning, and the default stands. */
export const policyFloorMs = (): number => {
  const raw = process.env.FOLDRUN_POLICY_FLOOR_MS;
  if (raw === undefined || raw === "") return 2000;
  // Digits only — no sign, decimal, exponent or whitespace, so "2e3" and " "
  // (both of which Number() would quietly accept) are rejected, not surprises.
  if (!/^\d+$/.test(raw)) {
    console.warn(`FOLDRUN_POLICY_FLOOR_MS=${JSON.stringify(raw)} is not a whole number of milliseconds ≥ 0 — using 2000`);
    return 2000;
  }
  return Number(raw);
};

// mark: a start-up phase ending, as the JSON line the worker reads
// (run-container.ts#parseDriverMark). GNU date's %3N is milliseconds; a date
// without it prints a non-number, and the worker drops the line.
export const SHIM = `mark() { printf '{"e":"mark","name":"%s","at":%s}\\n' "$1" "$(date +%s%3N)"; }
i=0; while [ ! -f /opt/runner/job/go ] && [ $i -lt 3000 ]; do sleep 0.2; i=$((i+1)); done
[ -f /opt/runner/job/go ] || { echo "no go marker after 10 minutes — platform gone, exiting" >&2; exit 1; }
mark shim
set -a; [ -f /opt/runner/job/env.sh ] && . /opt/runner/job/env.sh; set +a
${egressCaSh("/opt/runner/job")}
${SYSTEM_FROM_INPUT_SH}
${systemInstallSh(RUNTIME_CACHE)}
mark system
${INSTALL_HELPER_SH}
chown -R agent:agent /workspace /library /opt/runner/job
chown agent:agent ${RUNTIME_CACHE} 2>/dev/null || true
runuser -u agent -- node /opt/runner/driver.mjs
echo $? > /opt/runner/job/exit
touch /opt/runner/job/finished
i=0; while [ ! -f /opt/runner/job/ack ] && [ $i -lt 4800 ]; do sleep 0.5; i=$((i+1)); done`;

// The hold after the driver finishes is FORTY minutes, not the five it was:
// a driver that died mid-step (a crash, not a rollout — a rollout hands
// its runs back at once) is recovered when its queue claim goes stale at
// thirty, and the next driver must still find the pod's log and files.
// In the normal case the ack arrives within a second of the done line and
// the hold costs nothing; the forty minutes are only ever paid by a pod
// nobody came back for.

// A driver that is being told to stop (SIGTERM — a rollout) detaches from
// its pods rather than failing or deleting them: the runs are handed back
// to the queue, and the next driver re-attaches. Nothing below this flag
// may ack, copy out, or delete once it is set.
let detaching = false;
/** Called by the worker on shutdown. Every in-flight step's stream ends,
 *  its pod stays exactly as it is, and its run is someone else's now. */
export function detachFromRunPods(): void {
  detaching = true;
  for (const child of streams) child.kill();
  streams.clear();
}
const streams = new Set<ReturnType<typeof spawn>>();

/** Why a pod that is no longer running ended, in the cluster's words —
 *  OOMKilled, Evicted, the deadline — or null when it is still running or
 *  cannot be asked. What the retry policy reads. */
async function podEndReason(ns: string, name: string): Promise<string | null> {
  const got = await kc(["get", "pod", name, "-n", ns, "-o", "json"]);
  if (got.status !== 0) return /NotFound/i.test(got.out) ? "pod gone" : null;
  try {
    const pod = JSON.parse(got.out) as {
      status?: { phase?: string; reason?: string; message?: string; containerStatuses?: { state?: Record<string, { reason?: string; exitCode?: number }>; lastState?: Record<string, { reason?: string; exitCode?: number }> }[] };
    };
    const st = pod.status ?? {};
    if (st.phase === "Running" || st.phase === "Pending") return null;
    if (st.reason) return `${st.reason}${st.message ? `: ${st.message.slice(0, 160)}` : ""}`; // Evicted, DeadlineExceeded
    const c = st.containerStatuses?.[0];
    const term = c?.state?.terminated ?? c?.lastState?.terminated;
    if (term?.reason) return `${term.reason}${term.exitCode !== undefined ? ` (exit ${term.exitCode})` : ""}`; // OOMKilled, Error
    return st.phase ?? "ended";
  } catch {
    return null;
  }
}

/**
 * Delete any run pod still alive for this run. Best effort, and by label
 * rather than name: the pod's name is random, and the run id is the only
 * thing a person stopping a run actually knows.
 */
export function killRunPods(runId: string, scope?: { tenant: string; workspace: string }): number {
  // A step of this run still waiting for room has no pod to delete yet.
  stopWaitingFor(runId);
  const ns = namespace();
  const got = kcSync([
    "get", "pods", "-n", ns, "-l", `${RUN_LABEL}=${runId}`,
    "-o", `jsonpath={range .items[*]}pod/{.metadata.name} {.metadata.labels.${ACCOUNT_LABEL.replaceAll(".", "\\.")}}{"\\n"}{end}`,
  ]);
  const list = runPodsToKill(got.out ?? "", scope?.tenant);
  if (list.length) kcSync(["delete", ...list, "-n", ns, "--wait=false"]);
  return list.length;
}

/** Every account's steps waiting for room on the records — another
 *  worker's, and those whose runs wait in the queue — each under its own
 *  account's limits, as the room gate's fair order reads them. Read at
 *  most every few seconds, however many steps wait in this worker. */
let recordedCache: { at: number; list: Promise<RoomWaiter[]> } | null = null;
function recordedWaiters(): Promise<RoomWaiter[]> {
  if (recordedCache && Date.now() - recordedCache.at < 3000) return recordedCache.list;
  const list = (async () => {
    const out: RoomWaiter[] = [];
    for (const tenant of listTenants()) {
      const waiting = roomWaiting(tenant);
      if (!waiting.length) continue;
      const account = accountSegment(tenant) ?? null;
      for (const w of waiting) {
        out.push({
          account,
          workspace: podLabelValue(w.workspace),
          runId: w.runId,
          key: `${w.runId}#${w.step}`,
          since: Date.parse(w.since),
          needGiB: w.memGiB,
          needCpu: w.cpus,
          needDisk: w.diskGiB,
          limits: await levelLimits(tenant, w.workspace, w.runPool),
        });
      }
    }
    return out;
  })().catch(() => [] as RoomWaiter[]);
  recordedCache = { at: Date.now(), list };
  return list;
}

/** The caps a step is held to at every level (27 Oct 2026): the install's
 *  node budgets and per-account pod count, the account's pool and step
 *  maximum, its workspace's pool and its run's. 0 is no cap. */
export async function levelLimits(tenant: string, workspace: string, run: ComputePool | null): Promise<RoomLimits> {
  const a = await accountCompute(tenant);
  const w = workspaceCompute(tenant, workspace);
  return {
    ...roomLimits(),
    accountGiB: a.memGiB ?? 0,
    accountVcpu: a.vcpu ?? 0,
    accountDiskGiB: a.diskGiB ?? 0,
    stepGiB: a.stepMemGiB ?? 0,
    stepVcpu: a.stepVcpu ?? 0,
    stepDiskGiB: a.stepDiskGiB ?? 0,
    workspaceGiB: w.memGiB ?? 0,
    workspaceVcpu: w.vcpu ?? 0,
    workspaceDiskGiB: w.diskGiB ?? 0,
    runGiB: run?.memGiB ?? 0,
    runVcpu: run?.vcpu ?? 0,
    runDiskGiB: run?.diskGiB ?? 0,
  };
}

/** A run's pool, read off its record (the flow's compute: copied onto it). */
function runPoolOf(tenant: string, workspace: string, runId: string): ComputePool | null {
  try {
    const run = readRun(tenant, workspace, runId);
    return run ? runCompute(run) : null;
  } catch {
    return null;
  }
}

/**
 * Which of a run's pods a stop deletes, from `pod/<name> <account label>`
 * lines (kubectl's stderr may be mixed in; only pod/ lines count). With a
 * tenant, a pod labelled for ANOTHER account is left alone (30 Oct 2026,
 * defence in depth: the kill matched on the run id alone). A pod with no
 * account label — a tenant with no segment, or a step started without one
 * — is still this run's to stop, as before. The workspace label is not
 * matched: a consult's pod is labelled from its scratch folder's name.
 */
export function runPodsToKill(out: string, tenant?: string): string[] {
  const mine = tenant ? accountSegment(tenant) : null;
  const pods: string[] = [];
  for (const line of out.split("\n")) {
    const [name, account] = line.trim().split(/\s+/);
    if (!name?.startsWith("pod/")) continue;
    if (tenant && account && account !== mine) continue;
    pods.push(name);
  }
  return pods;
}

/** A label value Kubernetes accepts, or null — a workspace name that is not
 *  one is simply not labelled, and its pods count to the account alone. */
export function podLabelValue(v: string | null | undefined): string | null {
  return v && /^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/.test(v) ? v : null;
}

/** The disk a step's pod is allowed: its own `disk:`, else its class's. */
function diskOf(size: "small" | "large" | "heavy" | undefined, own: string | null | undefined): string {
  return own ?? diskFor(size).limit;
}

/** One look for room for a step waiting in the queue (core
 *  platform.roomCheck): why it cannot start now, or null — by the room
 *  gate's rules, with no wait and no lock. A cluster that does not answer
 *  is not a full one: null, and the executor's own gate decides. */
export async function roomCheckK8s(ask: { tenant: string; workspace: string; runId: string; since: string; cpus: number; memGiB: number; diskGiB: number }): Promise<string | null> {
  const account = accountSegment(ask.tenant) ?? null;
  const limits = await levelLimits(ask.tenant, ask.workspace, runPoolOf(ask.tenant, ask.workspace, ask.runId));
  if (!anyRoomLimit(limits)) return null;
  // Too big now (a limit was lowered while it waited): no wait cures that,
  // so it goes on to the gate, which fails it saying so (Codex review).
  if (tooBig(ask.memGiB, ask.cpus, limits, ask.diskGiB)) return null;
  const got = await kc(["get", "pods", "-n", namespace(), "-o", "json"], undefined, 20_000);
  if (got.status !== 0) return null;
  let pods: PodLike[];
  try {
    pods = (JSON.parse(got.out).items ?? []) as PodLike[];
  } catch {
    return null;
  }
  const me: RoomWaiter = { account, workspace: podLabelValue(ask.workspace), runId: ask.runId, since: Date.parse(ask.since), needGiB: ask.memGiB, needCpu: ask.cpus, needDisk: ask.diskGiB, limits };
  return roomFor(me, pods, await recordedWaiters());
}

/** How long a placed pod has to become Ready: image, gVisor boot. */
const START_WINDOW_SEC = 180;

/** What one pod's wait for a node has seen so far. */
export type Placement = { nominated: boolean };

/** Why this pod is not placed yet in a way waiting cures — or null when
 *  that is not what holds it. Two sources:
 *
 *  - the scheduler: its PodScheduled condition says Unschedulable for a
 *    shortage of room (Insufficient cpu, memory or ephemeral-storage, or
 *    too many pods on a node);
 *  - Karpenter, on an autoscaled cluster (27 Oct 2026). On a cold pool no
 *    node matches the pod at all, so the scheduler's message is "didn't
 *    match node affinity/selector" or an untolerated start-up taint — not
 *    room — and the step used to fail after 180 s while its machine booted.
 *    Karpenter writes its decision on the pod as an event
 *    (kubernetes-sigs/karpenter pkg/controllers/provisioning/scheduling/
 *    events.go): Normal `Nominated` "Pod should schedule on: nodeclaim/…"
 *    when it is adding a node for it — a wait; Warning `FailedScheduling`
 *    "Failed to schedule pod, …all available instance types exceed limits
 *    for nodepool" (or "node limits have been exhausted") when the pool is
 *    at its size cap — room, so a wait too; any other "Failed to schedule
 *    pod" is requirements no node can meet — not a wait. The newest of
 *    Karpenter's events decides. Events expire (an hour by default), so a
 *    nomination is remembered in `seen` for as long as this pod waits.
 *
 *  A claim that does not exist or a selector nothing will ever match is
 *  never cured by waiting, so it fails at the start-up window as before
 *  (Codex review). Where no Karpenter runs (the box) there are no such
 *  events and this is the scheduler's answer alone. */
export async function unschedulable(ns: string, name: string, seen: Placement = { nominated: false }): Promise<string | null> {
  const got = await kc(["get", "pod", name, "-n", ns, "-o", "json"], undefined, 20_000);
  if (got.status !== 0) return null;
  let uid = "";
  let message = "";
  try {
    const pod = JSON.parse(got.out) as { metadata?: { uid?: string }; status?: { phase?: string; conditions?: { type: string; status: string; reason?: string; message?: string }[] } };
    if (pod.status?.phase !== "Pending") return null;
    const c = pod.status.conditions?.find((x) => x.type === "PodScheduled");
    if (!c || c.status !== "False" || c.reason !== "Unschedulable") return null;
    uid = pod.metadata?.uid ?? "";
    message = c.message ?? "";
  } catch {
    return null;
  }
  if (/Insufficient (cpu|memory|ephemeral-storage)|Too many pods/i.test(message)) return message.slice(0, 300);
  const said = await karpenterSays(ns, name, uid);
  if (said?.reason === "Nominated") seen.nominated = true;
  else if (said) {
    seen.nominated = false;
    return /exceed limits for nodepool|node limits have been exhausted/i.test(said.message)
      ? `the cluster is at its size limit (${said.message.slice(0, 240)})`
      : null;
  }
  return seen.nominated ? `a node is being added for it${said ? ` (${said.message.slice(0, 200)})` : ""}` : null;
}

/** The newest event Karpenter wrote on this pod, or null — none, no
 *  Karpenter, or events this install may not read. Matched by reason AND
 *  Karpenter's own message prefix: the scheduler's FailedScheduling reads
 *  "0/N nodes are available…", Karpenter's "Failed to schedule pod, …". */
async function karpenterSays(ns: string, name: string, uid: string): Promise<{ reason: string; message: string } | null> {
  const got = await kc(["get", "events", "-n", ns, "--field-selector", `involvedObject.kind=Pod,involvedObject.name=${name}`, "-o", "json"], undefined, 20_000);
  if (got.status !== 0) return null;
  try {
    type Ev = { reason?: string; message?: string; involvedObject?: { uid?: string }; lastTimestamp?: string; eventTime?: string; firstTimestamp?: string; series?: { lastObservedTime?: string } };
    const items = (JSON.parse(got.out) as { items?: Ev[] }).items ?? [];
    let best: { reason: string; message: string; at: number } | null = null;
    for (const e of items) {
      // A pod of the same name from an earlier attempt is not this one.
      if (uid && e.involvedObject?.uid && e.involvedObject.uid !== uid) continue;
      const msg = e.message ?? "";
      const ours = (e.reason === "Nominated" && msg.startsWith("Pod should schedule on")) || (e.reason === "FailedScheduling" && msg.startsWith("Failed to schedule pod"));
      if (!ours) continue;
      const at = Math.max(...[e.series?.lastObservedTime, e.lastTimestamp, e.eventTime, e.firstTimestamp].map((t) => (t ? Date.parse(t) : NaN)).filter(Number.isFinite), 0);
      if (!best || at >= best.at) best = { reason: e.reason!, message: msg, at };
    }
    return best ? { reason: best.reason, message: best.message } : null;
  } catch {
    return null;
  }
}

/** When the scheduler placed this pod (ms), or null. */
async function scheduledAt(ns: string, name: string): Promise<number | null> {
  const got = await kc(["get", "pod", name, "-n", ns, "-o", "json"], undefined, 20_000);
  if (got.status !== 0) return null;
  try {
    const pod = JSON.parse(got.out) as { status?: { conditions?: { type: string; status: string; lastTransitionTime?: string }[] } };
    const c = pod.status?.conditions?.find((x) => x.type === "PodScheduled" && x.status === "True");
    const t = c?.lastTransitionTime ? Date.parse(c.lastTransitionTime) : NaN;
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/** A restarted driver's orphan sweep (core platform.ts killOrphanSandboxes):
 *  delete the run's pods except `keep`, the ones its steps re-attach to.
 *  Not a stop — no word is left for steps waiting for room, because the
 *  run goes on and its steps are about to start (27 Oct 2026: the stop
 *  word failed the relaunched step "stopped while waiting for room"). */
export function killOrphanPods(runId: string, keep: readonly string[]): number {
  const ns = namespace();
  const got = kcSync(["get", "pods", "-n", ns, "-l", `${RUN_LABEL}=${runId}`, "-o", "name"]);
  const kept = new Set(keep.map((ref) => `pod/${ref}`));
  const list = (got.out ?? "").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("pod/") && !kept.has(l));
  if (list.length) kcSync(["delete", ...list, "-n", ns, "--wait=false"]);
  return list.length;
}

/** Delete one run pod by name — a single step's sandbox, where the rest of
 *  its run must keep going (core platform.ts killSandbox). Only a run pod's
 *  name is accepted. */
export function killRunPod(name: string): boolean {
  if (!/^foldrun-run-[a-z0-9-]{1,60}$/.test(name)) return false;
  return kcSync(["delete", "pod", name, "-n", namespace(), "--wait=false", "--ignore-not-found"]).status === 0;
}

/**
 * Delete run pods that have finished and been left behind.
 *
 * The normal path deletes a pod in runStepInK8s's `finally`. That handle is
 * lost whenever the platform process goes away mid-step — which, with a
 * single replica on a Recreate strategy, is every deploy. Measured on the
 * production box 2026-08-28: seven terminated pods still present, the oldest
 * two and a half days old, one of them the DeadlineExceeded the cluster
 * reaped precisely because nobody was left to reap it.
 *
 * Terminated pods hold no CPU or memory, so this is not urgent — but they
 * hold names, IPs and an etcd record each, and nothing else in the system
 * ever removes them. Pods have no `ttlSecondsAfterFinished` (that is a Job
 * field), so the sweep has to be ours.
 */
export async function sweepFinishedRunPods(olderThanMs = 10 * 60_000): Promise<number> {
  if (process.env.FOLDRUN_RUN_ISOLATION !== "k8s") return 0;
  const ns = namespace();
  const got = await kc([
    "get", "pods", "-n", ns, "-l", "app=foldrun-run",
    "-o", "jsonpath={range .items[*]}{.metadata.name} {.status.phase} {.metadata.creationTimestamp}{\"\\n\"}{end}",
  ]);
  if (got.status !== 0) return 0;

  const stale: string[] = [];
  for (const line of got.out.split("\n")) {
    const [name, phase, created] = line.trim().split(/\s+/);
    if (!name || (phase !== "Succeeded" && phase !== "Failed")) continue;
    // Age-gated, because a pod that has just written its `done` line is still
    // being copied out of by a live step — deleting that races the copy-out
    // and loses the run's file changes.
    const age = Date.now() - new Date(created).getTime();
    if (Number.isFinite(age) && age > olderThanMs) stale.push(`pod/${name}`);
  }
  if (!stale.length) return 0;
  await kc(["delete", ...stale, "-n", ns, "--wait=false"]);
  return stale.length;
}

/**
 * Delete RUNNING run pods whose run is over.
 *
 * sweepFinishedRunPods only takes pods whose own process ended. A pod whose
 * run was stopped can still be busy, and so can one whose driver died, and
 * those never reach Succeeded. stopRun deletes the pod when the process that
 * handles the stop can reach the cluster. On the box that process is web,
 * and web's network policy does not reach the API server, so the delete
 * failed silently. On 2026-09-14 a stopped blog-desk pod sat in a hung
 * `git push` for 87 minutes and blocked every deploy. The worker can reach
 * the cluster, so it reconciles here: a pod labelled with a run whose record
 * is finished gets deleted.
 *
 * `runState(runId)` answers "live", "over" or "unknown". Unknown (no record
 * found) is left alone: a pod we cannot place is not ours to judge. The age
 * gate covers the moment between a record being written and its pod
 * appearing.
 */
export async function reapOrphanRunPods(
  runState: (runId: string) => "live" | "over" | "unknown",
  olderThanMs = 2 * 60_000,
): Promise<string[]> {
  if (process.env.FOLDRUN_RUN_ISOLATION !== "k8s") return [];
  const ns = namespace();
  const got = await kc([
    "get", "pods", "-n", ns, "-l", `app=foldrun-run,${RUN_LABEL}`,
    "-o", `jsonpath={range .items[*]}{.metadata.name} {.metadata.labels.${RUN_LABEL.replaceAll(".", "\\.")}} {.metadata.creationTimestamp}{"\\n"}{end}`,
  ]);
  if (got.status !== 0) return [];
  const orphans: string[] = [];
  for (const line of got.out.split("\n")) {
    const [name, runId, created] = line.trim().split(/\s+/);
    if (!name || !runId) continue;
    const age = Date.now() - new Date(created).getTime();
    if (!(Number.isFinite(age) && age > olderThanMs)) continue;
    if (runState(runId) === "over") orphans.push(`pod/${name}`);
  }
  if (orphans.length) await kc(["delete", ...orphans, "-n", ns, "--wait=false"]);
  return orphans;
}

/** The CPU a step's pod reserves, by size class: what the scheduler packs
 *  by, and each pod's share of the node when every core is busy. It scales
 *  with the class so a step paying for four cores gets five times a small
 *  one's share under contention, not the same 100m. Kept well below the
 *  limit because a step mostly waits on a model: reserving the full figure
 *  would leave most of the box idle and runs Pending. Small stays at 100m,
 *  so a fan-out of small steps packs exactly as it did before limits. */
export function cpuRequestFor(size?: "small" | "large" | "heavy"): string {
  switch (size) {
    case "small":
      return process.env.FOLDRUN_RUNNER_CPU_REQUEST_SMALL ?? "100m";
    case "heavy":
      return process.env.FOLDRUN_RUNNER_CPU_REQUEST_HEAVY ?? "500m";
    default:
      return process.env.FOLDRUN_RUNNER_CPU_REQUEST ?? "250m";
  }
}

/** A CPU quantity in millicores: "250m", "2", "0.5". NaN when it is not one. */
export function cpuMillis(q: string): number {
  const m = /^(\d+(?:\.\d+)?)(m)?$/.exec(String(q).trim());
  if (!m) return NaN;
  return m[2] ? Number(m[1]) : Number(m[1]) * 1000;
}

/** The request, or the limit where an install tuned the limit below it —
 *  Kubernetes refuses a pod whose request exceeds its limit, and a refused
 *  pod is a failed step with an error that names neither. */
export function cappedCpuRequest(request: string, limit: string): string {
  const r = cpuMillis(request);
  const l = cpuMillis(limit);
  return Number.isFinite(r) && Number.isFinite(l) && r > l ? limit : request;
}

/** Node disk a step may write, by size class. Env-tunable like the rest. */
export function diskFor(size?: "small" | "large" | "heavy"): { request: string; limit: string } {
  // The limit is core's (classDisk), so an OOM/eviction retry that raises an
  // agent's own `disk:` to the bigger class reads the same figure as here.
  const limit = classDisk(size);
  switch (size) {
    case "small":
      return { request: "256Mi", limit };
    case "heavy":
      return { request: "1Gi", limit };
    default:
      return { request: "512Mi", limit };
  }
}

/** The pod, as a manifest — pure, so tests can read it without a cluster. */
export function runPodManifest(
  name: string,
  image: string,
  runId?: string,
  size?: "small" | "large" | "heavy",
  deadlineSec?: number,
  tenant?: string,
  test?: boolean,
  filtered?: boolean,
  limits?: StepLimits,
  /** The workspace, as a label value (podLabelValue) — what its pool counts. */
  workspace?: string | null,
): object {
  // The class's figures, or the agent's `resources:` over them (core
  // resolveResources): cores and memory as hard limits, and disk where the
  // agent set its own.
  const lim = limits ?? resolveResources(size);
  const disk = lim.disk ? { request: diskFor(size).request, limit: lim.disk } : diskFor(size);
  // The dependency cache: one claim, one sub-directory per tenant. subPath is
  // what keeps tenants apart — the pod sees only its own sub-tree, so a step
  // cannot read, let alone poison, the venvs another account's steps execute.
  // kubelet creates the sub-directory on first use, so nothing has to
  // pre-provision it. No claim configured, or a tenant name that is not a safe
  // single segment, and the pod simply gets no volume.
  const claim = cachePvc();
  const seg = tenant ? safeTenantSegment(tenant) : null;
  // Per-account claims (prod): the account's own claim, mounted whole.
  const own = claim && tenant && accountCacheClass() ? accountCacheClaim(tenant) : null;
  const cache = claim && seg && (own || !accountCacheClass()) ? { claim, seg, own } : null;
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      namespace: namespace(),
      // Karpenter (production's node autoscaler) must not consolidate a node
      // out from under a running step — it would be killed and rerun, paying
      // twice and repeating anything outward it did (27 Oct 2026). Blocks
      // consolidation and, without a NodePool terminationGracePeriod, drift;
      // never expiry, a Spot interruption or a manual delete, and the
      // NodePool's grace period (1h) still forces a node that must go
      // (karpenter.sh/docs/concepts/disruption). "true", not a duration: a
      // step with no timeout: has no deadline to size one by. Ignored where
      // no Karpenter runs (the box). Run pods only — the accounts' browser
      // and search pods are long-lived and may move.
      annotations: { "karpenter.sh/do-not-disrupt": "true" },
      // The account label is what the per-account search policy selects on:
      // a run pod carrying it may reach that account's search pod and no
      // other. Absent for an embedder with no tenancy — and then no search
      // pod either, so nothing is opened that the base policy would shut.
      labels: {
        app: "foldrun-run",
        ...(runId ? { [RUN_LABEL]: runId } : {}),
        ...(tenant && accountSegment(tenant) ? { [ACCOUNT_LABEL]: accountSegment(tenant)! } : {}),
        // Its workspace (27 Oct 2026): the room gate counts a workspace's
        // pool by this label beside the account's.
        ...(workspace ? { [WORKSPACE_LABEL]: workspace } : {}),
        // A test run's pod: the cluster denies it the internet
        // (foldrun-run-test-no-world in foldrun-infra), leaving DNS, the
        // egress proxy and search. Http tools and the model key still work
        // through the proxy, where the test-mode policy is; a script tool's
        // direct call to the world fails instead of sending.
        ...(test ? { [TEST_LABEL]: "true" } : {}),
        // An enforced `network:` that is not open: the cluster gives the
        // pod the egress proxy and DNS, not the world (foldrun-infra
        // run-network-policy.yaml), so a program that ignores HTTPS_PROXY
        // fails instead of going round the site list.
        ...(filtered ? { [NETWORK_LABEL]: "filtered" } : {}),
      },
    },
    spec: {
      restartPolicy: "Never",
      // Model-directed code runs in here. The namespace's default token has
      // no RBAC, but it is still a bearer credential the API server accepts
      // from anywhere that can reach it — and a run pod has no business
      // holding one at all.
      automountServiceAccountToken: false,
      // A k8s-native backstop that does not depend on the platform staying
      // alive. The in-process watch below also deletes an overrunning pod, but
      // if the platform restarts mid-run it loses that handle and the shim can
      // spin forever waiting for a `go` marker that will never be written —
      // which is how run pods were seen Running for 40+ minutes, holding their
      // memory reservation. activeDeadlineSeconds lets the cluster reap them.
      // Only when the step set a timeout: the platform has no opinion of its
      // own about how long real work takes — a step with no `timeout:` runs
      // until it finishes, and stopping it is what the stop button is for.
      ...(deadlineSec ? { activeDeadlineSeconds: deadlineSec } : {}),
      ...(process.env.FOLDRUN_RUNNER_RUNTIME
        ? { runtimeClassName: process.env.FOLDRUN_RUNNER_RUNTIME }
        : {}),
      ...(cache
        ? {
            volumes: [
              { name: "runtime-cache", persistentVolumeClaim: { claimName: cache.claim } },
              ...(cache.own ? [{ name: "runtime-cache-own", persistentVolumeClaim: { claimName: cache.own } }] : []),
            ],
          }
        : {}),
      containers: [
        {
          name: "runner",
          image,
          imagePullPolicy: "IfNotPresent",
          command: ["sh", "-c", SHIM],
          securityContext: {
            // Root for the chown-and-drop; runuser sheds everything before
            // any model-directed code runs. Two capabilities more than the
            // docker flags — DAC_OVERRIDE and FOWNER — because kubectl cp
            // is an exec of tar *inside* the pod (docker cp is daemon-side),
            // and capless root can neither write into the agent-owned trees
            // nor chmod what it lands there.
            runAsUser: 0,
            allowPrivilegeEscalation: false,
            capabilities: { drop: ["ALL"], add: ["CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE", "FOWNER"] },
            seccompProfile: { type: "RuntimeDefault" },
          },
          resources: {
            // CPU is capped at the cores the step is billed for (the class's,
            // or the agent's `resources: cpu`). Until 26 Oct 2026 it
            // was uncapped, so one step could take every core on the node and
            // a heavy step paying for four had no more claim on the CPU than a
            // small one. Every sandbox platform caps what it sells; so do we.
            // The request scales with the class (cpuRequestFor) and stays
            // below the limit, because a step mostly waits on a model.
            // Memory is a hard limit with no request, so Kubernetes reserves
            // all of it: it is not compressible, and without a cap one runaway
            // step OOMs the whole box, which on a single-node install is every
            // tenant's runs and the control plane at once.
            requests: { cpu: cappedCpuRequest(cpuRequestFor(size), lim.cpus), "ephemeral-storage": disk.request },
            limits: {
              cpu: lim.cpus,
              memory: k8sMemory(lim.memory),
              // Disk the step writes on the node: the workspace copy, its
              // outputs (a crawl, a video), /tmp, anything a script builds
              // outside the runtime cache. Without a limit one step filling
              // the disk evicts every pod on the node, run and control plane
              // alike. Ceilings, not measurements: a step that legitimately
              // needs more declares a bigger size.
              "ephemeral-storage": disk.limit,
            },
          },
          ...(cache
            ? {
                volumeMounts: [
                  cache.own
                    ? { name: "runtime-cache-own", mountPath: RUNTIME_CACHE }
                    : { name: "runtime-cache", mountPath: RUNTIME_CACHE, subPath: cache.seg },
                  // The platform's shared layer, read-only: environments built
                  // once for every account that declares the same thing
                  // (runtime-warm.ts). A step reads it and can never write it.
                  ...(sharedLayerEnabled()
                    ? [{ name: "runtime-cache", mountPath: SHARED_RUNTIMES, subPath: SHARED_SUBPATH, readOnly: true }]
                    : []),
                ],
                ...(sharedLayerEnabled() ? { env: [{ name: "FOLDRUN_RUNTIME_SHARED", value: SHARED_RUNTIMES }] } : {}),
              }
            : {}),
        },
      ],
    },
  };
}

/** Shell-safe `export`s — the shim sources this, so quoting is load-bearing. */
export function envFileShell(env: Record<string, string>): string {
  return Object.entries(env)
    .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    .map(([k, v]) => `export ${k}='${v.replaceAll("'", `'\\''`)}'`)
    .join("\n");
}

/** What a busy or restarting API server answers — worth asking again. */
const TRANSIENT = /gave no answer in|connection refused|TLS handshake timeout|i\/o timeout|unexpected EOF|the server is currently unable|context deadline exceeded|Too Many Requests|ServiceUnavailable|etcdserver: request timed out/i;

/**
 * `kubectl apply` of a run pod, asked again when the API server did not
 * answer or answered "busy". Apply is idempotent — the same name, the same
 * manifest — so a second ask after a first that did land is a no-op.
 *
 * One 30-second try was all a step had: on 2026-10-19 the deploy's flow smoke
 * ran on a worker a minute old while the rollout was still settling, the
 * apply got no answer, and the release rolled itself back (v2026.10.19.3);
 * 18 Oct's v2026.10.18.1 failed the same way and passed on a re-run.
 */
export async function applyRetrying(
  run: (args: string[], input?: string, timeoutMs?: number) => Promise<{ status: number | null; out: string }>,
  manifest: string,
  note: (line: string) => void,
  timeouts: number[] = [30_000, 45_000, 60_000],
  pauseMs = 2_000,
): Promise<{ status: number | null; out: string }> {
  let last: { status: number | null; out: string } = { status: null, out: "" };
  for (let i = 0; i < timeouts.length; i++) {
    last = await run(["apply", "-f", "-"], manifest, timeouts[i]);
    if (last.status === 0 || !TRANSIENT.test(last.out) || i === timeouts.length - 1) return last;
    note(`pod create: the cluster did not answer (${last.out.trim().split("\n").pop()?.slice(0, 160)}) — asking again, ${i + 2} of ${timeouts.length}`);
    await new Promise((r) => setTimeout(r, pauseMs));
  }
  return last;
}

function kcSync(args: string[], input?: string): { status: number | null; out: string } {
  const res = spawnSync(kubectl(), args, { encoding: "utf8", input });
  return { status: res.status, out: (res.stdout ?? "") + (res.stderr ?? "") };
}

/**
 * kubectl, off the event loop. These calls run inside the PLATFORM process,
 * and spawnSync here froze everything the process serves: `wait
 * --for=condition=Ready --timeout=180s` held the loop for up to three
 * minutes per step, three parallel steps interleaved their holds, and the
 * readiness probe, every API request and the scheduler starved together —
 * a whole install unresponsive because one flow had a parallel group.
 */
/**
 * kubectl, its output, and — with `timeoutMs` — killed past that, answering
 * status null. The bound is ours rather than kubectl's --request-timeout:
 * inside a pod, a kubectl given that flag skipped its in-cluster config and
 * dialled localhost:8080 (every run pod create failed on the box, 17 Oct
 * 2026, and the deploy rolled itself back).
 */
function kc(args: string[], input?: string, timeoutMs?: number): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(kubectl(), args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    const timer = timeoutMs
      ? setTimeout(() => {
          out += `\nkubectl ${args[0]} gave no answer in ${Math.round(timeoutMs / 1000)}s`;
          child.kill("SIGKILL");
        }, timeoutMs)
      : null;
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (out += c.toString()));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ status: null, out: String(err) });
    });
    child.on("close", (status) => {
      if (timer) clearTimeout(timer);
      resolve({ status, out });
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** The tar that builds the stage-in archive, on this (worker) host — not the
 *  pod's. node:22-slim ships GNU tar. FOLDRUN_TAR overrides it, as
 *  FOLDRUN_KUBECTL does kubectl, so a test can point at a stub. */
const tarBin = () => process.env.FOLDRUN_TAR ?? "tar";

/**
 * The stage-in as one tar and one exec. `staging` holds exactly workspace/,
 * library/ and opt/runner/job/{input,in,env,mtimes}.json, so the create
 * names each member at the path it lands at under the pod's `tar x -C /`.
 * The unpack reapplies the mtime manifest in the same exec right after,
 * non-fatally (a failure only warns, as the old restore did), because
 * freshness checks read those times — see mtimeManifest / APPLY_MTIMES_JS.
 * --no-overwrite-dir: the archive carries opt/ and opt/runner/, and root
 * would otherwise stamp the image's own dirs with staging's modes — under a
 * worker umask of 077 that left /opt 0700 and agent could not load the
 * driver (checked in node:22-slim, GNU tar 1.34, 18 Oct 2026).
 */
export function stageInArgs(staging: string, ns: string, name: string): { create: string[]; exec: string[] } {
  const applyMtimes = `node -e '${APPLY_MTIMES_JS}' /opt/runner/job/mtimes.json /workspace`;
  return {
    create: ["c", "-C", staging, "workspace", "library", "opt"],
    exec: ["exec", "-i", "-n", ns, name, "--", "sh", "-c", `tar x --no-same-owner --no-overwrite-dir -C / && { ${applyMtimes} || echo "mtimes-not-restored" >&2; }`],
  };
}

/**
 * Stage a step in with one exec instead of six copies: `tar c` on this host,
 * piped to a single `kubectl exec -i -- …` that unpacks it in the pod. The
 * bound is ours, as in kc (kubectl's --request-timeout misbehaves in-cluster
 * — see kc). It settles only when both processes have closed, so a tar-create
 * failure counts even when the unpack read a clean EOF and exited 0; its
 * stderr leads the message so the throw reads like the old `kubectl cp failed`.
 * A kubectl that dies mid-stream (pod gone, exec refused) stops the tar and
 * fails this step — its EPIPE must never reach the worker as an uncaught error.
 */
export function unpackIntoPod(
  createArgs: string[],
  execArgs: string[],
  timeoutMs = 120_000,
): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve) => {
    const src = spawn(tarBin(), createArgs, { stdio: ["ignore", "pipe", "pipe"] });
    const sink = spawn(kubectl(), execArgs, { stdio: ["pipe", "pipe", "pipe"] });
    streams.add(src);
    streams.add(sink);
    let out = "";
    let srcErr = "";
    // undefined while that side runs; null when it never started or was killed.
    let srcStatus: number | null | undefined;
    let sinkStatus: number | null | undefined;
    let settled = false;
    const finish = () => {
      if (settled || srcStatus === undefined || sinkStatus === undefined) return;
      settled = true;
      clearTimeout(timer);
      streams.delete(src);
      streams.delete(sink);
      const status = sinkStatus === 0 && srcStatus !== 0 ? srcStatus : sinkStatus;
      resolve({ status, out: (srcErr ? `tar: ${srcErr}\n` : "") + out });
    };
    const timer = setTimeout(() => {
      out += `\nstage-in gave no answer in ${Math.round(timeoutMs / 1000)}s`;
      src.kill("SIGKILL");
      sink.kill("SIGKILL");
    }, timeoutMs);
    src.stderr.on("data", (c: Buffer) => (srcErr += c.toString()));
    src.stdout.pipe(sink.stdin);
    // kubectl gone while tar still writes: the write fails with EPIPE. Here
    // it only stops the tar; kubectl's own status says why.
    sink.stdin.on("error", () => src.kill("SIGKILL"));
    // tar create never started: nothing to unpack.
    src.on("error", (e) => {
      srcErr += String(e);
      if (srcStatus === undefined) srcStatus = null;
      sink.kill("SIGKILL");
      finish();
    });
    src.on("close", (s) => {
      if (srcStatus === undefined) srcStatus = s;
      finish();
    });
    sink.stdout.on("data", (c: Buffer) => (out += c.toString()));
    sink.stderr.on("data", (c: Buffer) => (out += c.toString()));
    sink.on("error", (e) => {
      out += String(e);
      if (sinkStatus === undefined) sinkStatus = null;
      src.kill("SIGKILL");
      finish();
    });
    sink.on("close", (s) => {
      if (sinkStatus === undefined) sinkStatus = s;
      // Nothing is reading any more: a tar still writing would block forever.
      if (s !== 0) src.kill("SIGKILL");
      finish();
    });
  });
}

/** What the per-account services gave a step, and why not when they did not. */
export interface AccountServiceEnv {
  env: Record<string, string>;
  /** Set, the step must not run: the one line the run record shows. */
  failed?: string;
  /** FOL-46: with `deferSearch`, the search pod is NOT awaited here — its
   *  URL is already in `env` (it is a function of the account segment, not of
   *  the pod being Ready), and this is the still-running ensure. The caller
   *  starts the step pod alongside it and awaits this right before `go`, so a
   *  cold search pod boots in parallel with the step pod instead of before it.
   *  Resolves to the URL (or null when the pool could not be had — the step
   *  then fails, exactly as it does today) AND `readyAt`, the epoch-ms moment
   *  the ensure actually resolved, captured inside the promise. The mark uses
   *  `readyAt` so `services` reads the search pod's TRUE ready time, not when
   *  the gate happened to look (gate arrival ≥ readyAt on a warm pool).
   *  Already .catch-guarded: it never rejects, so no path leaves it unhandled. */
  searchReady?: Promise<{ url: string | null; readyAt: number }>;
  /** The same for the account's browser pod, with `deferBrowser`: its ws://
   *  URL is already FOLDRUN_BROWSER_WS in `env` (a function of the segment,
   *  like search's), and this is the ensure still running. A null url is not
   *  a failure — as when it is awaited inline, the step then runs Chromium
   *  itself — but the caller must undo the address before `go` (the gate). */
  browserReady?: Promise<{ url: string | null; readyAt: number }>;
}

/** The line a step's trace carries when its account's browser pod could not
 *  be had — inline or at the gate, the same words. */
export const BROWSER_UNAVAILABLE = "browser: account pod unavailable — the tool runs Chromium inside the step";

/** The one wording for "the search pod could not be had", shared by the
 *  await-now path (below) and the defer-to-go gate (gateGoOnSearch), so the
 *  run record reads the same however search was resolved. */
export const SEARCH_UNAVAILABLE =
  "search: the account's search pod is unavailable and there is no shared engine — " +
  "the step cannot search (FOLDRUN_SEARCH_PER_ACCOUNT=1; the cluster gave no pod, see the lines above)";

/**
 * May this step use one of these `web` actions? `web` is all eight actions in
 * one tool; which of them an agent may use is FOLDRUN_WEB_ACTIONS (empty:
 * all). Search, answer and monitor ask the account's engine when no provider
 * answers them; browse drives its browser.
 */
export function webActionAllowed(scripts: { name: string }[], env: Record<string, string>, ...actions: string[]): boolean {
  if (!scripts.some((s) => s.name === "web")) return false;
  const allowed = (env.FOLDRUN_WEB_ACTIONS ?? "").split(",").map((a) => a.trim()).filter(Boolean);
  return actions.some((a) => !allowed.length || allowed.includes(a));
}

/** Does this step grant a browser? `web` with its browse action allowed. */
export function grantsBrowsing(scripts: { name: string }[], env: Record<string, string>): boolean {
  return webActionAllowed(scripts, env, "browse");
}

/** Words a program that drives a browser of its own carries. */
const BROWSER_WORDS = /playwright|puppeteer|chromium|chrome|selenium|webdriver|browser-use|pyppeteer/i;
/** Gallery programs known not to launch a browser — their source need not
 *  be read. `web` is judged by its browse action (grantsBrowsing). */
const NON_BROWSING = new Set(["web"]);

/** What of a step decides whether it may need a browser in its pod. */
export interface ImageInput {
  scripts: { name: string; run?: string; code?: string }[];
  mcpServers?: Record<string, unknown>;
  allowed?: string[];
  prompt?: string;
  systemPrompt?: string;
  runtime?: { packages?: string[]; npm?: string[] } | null;
  /** A granted tool acts outward — such a step keeps a browser of its own. */
  outward?: boolean;
  /** "full": this attempt is the re-run after the browser pod was lost. */
  image?: "full";
}

/** browserNeed's reason when browsing is the only thing that needs it. */
const GRANTS_BROWSER = "it grants a browser";

/**
 * Why this step needs the image with browsers, or null when the slim one
 * will do. Conservative: slim is for a step that plainly cannot launch a
 * browser, and anything this cannot see into runs the full image.
 *
 *   - it grants browsing (web with browse, or a tool named browser);
 *   - an MCP server the step launches by command (npx @playwright/mcp and
 *     its like run inside the pod; an http server runs elsewhere);
 *   - a script tool whose source names a browser library, or whose source
 *     cannot be read (`readSource` null);
 *   - a runtime that installs one;
 *   - Bash, when the prompt names a browser library — the agent will
 *     reach for it there.
 */
export function browserNeed(
  input: ImageInput,
  env: Record<string, string>,
  readSource: (script: ImageInput["scripts"][number]) => string | null = (sc) => sc.code ?? null,
  /** false: the step's own browsing does not count — what else would need
   *  the full image if the account's pod served the browsing? */
  opts: { browsing?: boolean } = {},
): string | null {
  if (opts.browsing !== false && grantsBrowsing(input.scripts, env)) return GRANTS_BROWSER;
  for (const [name, cfg] of Object.entries(input.mcpServers ?? {})) {
    const c = cfg as { type?: string; command?: string };
    if (c && (c.command || c.type === "stdio")) return `MCP server ${name} runs in the pod`;
  }
  for (const sc of input.scripts) {
    if (NON_BROWSING.has(sc.name)) continue;
    const src = readSource(sc);
    if (src === null) return `script ${sc.name}'s source could not be read`;
    if (BROWSER_WORDS.test(src)) return `script ${sc.name} drives a browser`;
  }
  const deps = [...(input.runtime?.packages ?? []), ...(input.runtime?.npm ?? [])];
  const dep = deps.find((d) => BROWSER_WORDS.test(d));
  if (dep) return `the runtime installs ${dep}`;
  if (input.allowed?.includes("Bash") && BROWSER_WORDS.test(`${input.prompt ?? ""}\n${input.systemPrompt ?? ""}`)) {
    return "Bash is granted and the prompt names a browser";
  }
  return null;
}

/**
 * Which runner image a step's pod runs.
 *
 * The full image carries 1.4 GB of browsers that a step only needs when it
 * may browse — and then only as the fallback, because on a cluster the
 * browser itself runs in the account's browser pod. Everything else runs the
 * slim image (FOLDRUN_RUNNER_SLIM_IMAGE): the same core, driver, python, uv
 * and Playwright client, a third of the pull. With no slim image configured
 * every step runs the full one, exactly as before. Which steps may need a
 * browser is browserNeed's call, and it errs toward full.
 */
export function runnerImageFor(
  input: ImageInput | ImageInput["scripts"],
  env: Record<string, string>,
  readSource?: (script: ImageInput["scripts"][number]) => string | null,
): { image: string; variant: "full" | "slim"; why?: string; pod?: boolean } {
  const full = process.env.FOLDRUN_RUNNER_IMAGE ?? "";
  const slim = process.env.FOLDRUN_RUNNER_SLIM_IMAGE;
  if (!slim) return { image: full, variant: "full" };
  // A bare list is the scripts alone (the runtime warmer asks about images
  // with no step in hand).
  const step: ImageInput = Array.isArray(input) ? { scripts: input } : input;
  if (step.image === "full") return { image: full, variant: "full", why: "re-run after the browser pod was lost" };
  const why = browserNeed(step, env, readSource);
  if (!why) return { image: slim, variant: "slim" };
  // Slim browsing (core browser-pod.ts): when browsing is the only reason
  // and the account's browser pod is up for this step, the step runs slim
  // and every browse call renders in the pod. A pod lost mid-step is
  // reconnected; past that the step re-runs on full if it had only read,
  // and fails naming what it wrote if it had not. Outward steps, and steps
  // whose web.browse block needs a browser in the step, stay on full.
  if (why !== GRANTS_BROWSER || !env.FOLDRUN_BROWSER_WS) return { image: full, variant: "full", why };
  const blocker = process.env.FOLDRUN_SLIM_BROWSING === "0" ? "slim browsing is off (FOLDRUN_SLIM_BROWSING=0)"
    : step.outward ? "it can act outward, so it keeps a browser of its own"
    : browserNeed(step, env, readSource, { browsing: false }) ?? slimBrowseBlocker(env);
  if (blocker) return { image: full, variant: "full", why: `${why}; ${blocker}` };
  return { image: slim, variant: "slim", why: "browses through the account's browser pod", pod: true };
}

/** A script's program as the pod will run it, from the staged copy: the
 *  inline code, or the file its `run:` names — and, for a folder tool, every
 *  file beside it, since run.mjs may only import the part that browses.
 *  Null when it cannot be found. */
export function stagedScriptSource(agentDir: string, libraryScripts: string, sc: { run?: string; code?: string }): string | null {
  if (sc.code) return sc.code;
  if (!sc.run) return null;
  try {
    const abs = resolveRunPath(agentDir, sc.run, libraryScripts);
    const dir = path.dirname(abs);
    const inFolderTool = path.basename(path.dirname(dir)) === "tools";
    if (!inFolderTool) return fs.readFileSync(abs, "utf8");
    let out = "";
    const walk = (d: string, depth: number) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory() && depth < 3 && e.name !== "node_modules") walk(p, depth + 1);
        else if (e.isFile() && out.length < 4_000_000) out += fs.readFileSync(p, "utf8") + "\n";
      }
    };
    walk(dir, 0);
    return out;
  } catch {
    return null;
  }
}

/**
 * The env a step's sandbox gets for the account's service pods, decided
 * from what the step grants. Pure but for the two ensure calls, which are
 * injectable so the rules are testable without a cluster:
 *
 *   - `websearch` granted, per-account search on: the account's search pod
 *     is ensured and its URL replaces FOLDRUN_SEARCH_URL. There is no
 *     shared engine any more (searxng.yaml is scaled to zero), so a pod the
 *     cluster would not give FAILS the step with one clear line rather than
 *     letting the tool try an address every account once shared.
 *   - `browser` granted, per-account browser on: the account's browser pod
 *     is ensured and FOLDRUN_BROWSER_WS names it. A pod the cluster would
 *     not give is not fatal — the tool launches Chromium inside the step,
 *     as it always could — and the log says so.
 *   - a TEST run gets no browser address at all. The deny-world policy is
 *     on the run pod; a browser pod it drove would fetch the world for it.
 *     In-pod Chromium is under that policy, so the call fails closed.
 *
 * No tenant (an embedder with no tenancy) means no pods and no label — and
 * the run pod carries no account label either, so nothing is opened that
 * the base policy would shut.
 */
export async function accountServiceEnv(opts: {
  tenant?: string;
  test?: boolean;
  scripts: { name: string }[];
  env: Record<string, string>;
  emit: (line: string) => void;
  ensureSearch?: (tenant: string, log: (line: string) => void, opts?: { pod?: string }) => Promise<string | null>;
  ensureBrowser?: (tenant: string, log: (line: string) => void, opts?: { pod?: string }) => Promise<string | null>;
  /** The run pod this step will own: an ensure that overlaps its creation
   *  names it, so the pool counts the step once (account-pod.ts poolWanted). */
  pod?: string;
  /** FOL-46: start the account's search pod but do NOT wait for it here —
   *  set its (segment-derived) URL in the env and return the ensure as
   *  `searchReady` for the caller to await right before `go`, so it overlaps
   *  the step pod's own start-up. The default (false) is the old behaviour:
   *  await the pod and fail inline if it cannot be had. */
  deferSearch?: boolean;
  /** The same for the browser pod (Mehdi, 28 Oct: v1 overlapped search only):
   *  its URL set now, the ensure returned as `browserReady`. Default false:
   *  awaited here, and a pod that cannot be had leaves the address unset. */
  deferBrowser?: boolean;
}): Promise<AccountServiceEnv> {
  const env = { ...opts.env };
  let searchReady: Promise<{ url: string | null; readyAt: number }> | undefined;
  let browserReady: Promise<{ url: string | null; readyAt: number }> | undefined;
  // `web` searches the account's engine for search, answer and monitor
  // unless a provider answers that action.
  const webMay = (...actions: string[]) => webActionAllowed(opts.scripts, env, ...actions);
  const webSearches = webMay("search") && !env.FOLDRUN_WEB_SEARCH_VIA
    || webMay("answer") && !env.FOLDRUN_WEB_ANSWER_VIA
    || webMay("monitor") && !env.FOLDRUN_WEB_MONITOR_VIA;
  if (perAccountSearchEnabled() && opts.tenant && webSearches) {
    if (opts.deferSearch) {
      // The Service URL is a function of the account segment, not of the pod
      // being Ready, so it is known now and rides into env.sh as it always
      // did. The ensure (create + wait) runs in the background; the caller
      // awaits searchReady before `go`. .catch-guarded so no path leaves a
      // rejection unhandled (condition: awaited OR caught everywhere).
      const seg = accountSegment(opts.tenant);
      const url = seg ? searchUrl(seg) : null;
      if (!url) return { env, failed: SEARCH_UNAVAILABLE };
      env.FOLDRUN_SEARCH_URL = url;
      // `readyAt` is Date.now() AT THE MOMENT the ensure resolves (inside the
      // promise), so the `services` mark is the search pod's own ready time,
      // not when the gate awaited it. A rejection is caught to null here.
      searchReady = Promise.resolve()
        .then(() => (opts.ensureSearch ?? ensureSearchPod)(opts.tenant!, opts.emit, opts.pod ? { pod: opts.pod } : undefined))
        .then((u) => ({ url: u, readyAt: Date.now() }), () => ({ url: null, readyAt: Date.now() }));
    } else {
      const url = await (opts.ensureSearch ?? ensureSearchPod)(opts.tenant, opts.emit);
      if (!url) return { env, failed: SEARCH_UNAVAILABLE };
      env.FOLDRUN_SEARCH_URL = url;
    }
  }
  if (env.FOLDRUN_BROWSER_VENDOR) {
    // The agent named a remote browser (`web: {browse: browserbase}`). The
    // wrapper connects there over CDP; the account's pod is not started
    // and not addressed, so a run that chose a vendor never rents ours.
    delete env.FOLDRUN_BROWSER_WS;
    opts.emit(`browser: ${env.FOLDRUN_BROWSER_VENDOR} named in frontmatter — no account browser pod for this step`);
  } else if (perAccountBrowserEnabled() && opts.tenant && grantsBrowsing(opts.scripts, env)) {
    if (opts.test) {
      opts.emit("browser: test run — no account browser pod; the tool's in-pod Chromium is denied the world by the run policy");
      delete env.FOLDRUN_BROWSER_WS;
    } else if (opts.deferBrowser) {
      // As search: the address is known before the pod is Ready, so the
      // image can be chosen (slim browsing needs it) and env.sh written now;
      // the gate before `go` waits for the pod, and undoes the address when
      // the pod could not be had. Never rejects, as searchReady.
      const seg = accountSegment(opts.tenant);
      if (!seg) opts.emit(BROWSER_UNAVAILABLE);
      else {
        env.FOLDRUN_BROWSER_WS = browserWs(seg);
        const tenant = opts.tenant;
        browserReady = Promise.resolve()
          .then(() => (opts.ensureBrowser ?? ensureBrowserPod)(tenant, opts.emit, opts.pod ? { pod: opts.pod } : undefined))
          .then((u) => ({ url: u, readyAt: Date.now() }), () => ({ url: null, readyAt: Date.now() }));
      }
    } else {
      const ws = await (opts.ensureBrowser ?? ensureBrowserPod)(opts.tenant, opts.emit);
      if (ws) env.FOLDRUN_BROWSER_WS = ws;
      else opts.emit(BROWSER_UNAVAILABLE);
    }
  }
  return { env, ...(searchReady ? { searchReady } : {}), ...(browserReady ? { browserReady } : {}) };
}

/**
 * FOL-46: the step pod's shell blocks on /opt/runner/job/go (SHIM) and so
 * cannot touch any service before go is touched. The account's search pod is
 * started in parallel with the step pod (accountServiceEnv deferSearch); this
 * is the gate `go` waits behind, so go is NEVER touched before the search pod
 * is Ready. It awaits `searchReady`, stamps the real services-ready moment
 * (`onReady`, for an honest phase mark), and only then runs `go`. On a pool
 * that could not be had it returns `failed` and `go` is never called — the
 * caller fails the step and the finally deletes the pod, exactly as an
 * inline search failure does today. `waitMs` is the time spent BLOCKED here
 * (the step pod was up but idle, waiting on our pool); the caller credits it
 * out of billed time so a cold search pod is the platform's cost, not the
 * customer's. No search granted (searchReady undefined) → go runs straight
 * away, unchanged.
 */
/**
 * FOL-46 billing credit: the rent clock (t0) is unchanged — it still starts
 * at pod apply — so `rentMs` is the full wall-clock the pod was rented. But
 * `serviceWaitMs` of that was the pod sitting Ready-but-idle at the gate
 * waiting on a search pod WE were still bringing up; that is the platform's
 * latency, not the customer's, so it is subtracted from the billed total.
 * Warm pool → serviceWaitMs 0 → billed total unchanged. Never negative.
 * This is the ONLY timing number that reaches money: billedTotalMs → step
 * computeSecs (runner.ts) → coreSecs/gibSecs/flatSecs (store/usage) → price
 * (ledger.ts). sandboxMs/startupSecs/startedAt/finishedAt do not bill.
 */
export function billedTotalMs(rentMs: number, serviceWaitMs: number): number {
  return Math.max(0, rentMs - Math.max(0, serviceWaitMs));
}

/** When every service a step needs was ready: the search pod's own ready
 *  time, or what is already marked when that is later — a browser awaited
 *  inline can become ready after search did. */
export function servicesReadyAt(searchReadyAt: number, alreadyMarkedAt: number | undefined): number {
  return alreadyMarkedAt === undefined ? searchReadyAt : Math.max(searchReadyAt, alreadyMarkedAt);
}

export async function gateGoOnSearch(
  searchReady: Promise<{ url: string | null; readyAt: number }> | undefined,
  go: () => Promise<void>,
  onReady?: (readyAt: number) => void,
  // A stop that lands while this gate blocks on the search pod must keep `go`
  // untouched — c498bba looks at stopRequested at the room, pod-exists and
  // ready marks, and this gate's wait (up to ~13s on a cold search pool) sits
  // between the ready check and `go`. Checked once the wait is over, before
  // `go`; set → return stopped and NEVER touch go (the caller then returns the
  // same "stopped …" outcome c498bba's stoppedHere gives, and the finally
  // deletes the pod). Undefined → no stop check, unchanged.
  stopped?: () => boolean,
): Promise<{ waitMs: number; failed?: string; stopped?: boolean }> {
  return gateGoOnServices({ search: searchReady }, go, { onReady, stopped });
}

/**
 * The gate for every service started beside the step pod: search, and the
 * browser (28 Oct). Search first — a search pod that cannot be had fails the
 * step whatever the browser does, as it did inline — then the browser; both
 * ensures were already running, so the waits overlap. `onReady` gets the
 * later of their own ready times. A browser pod that cannot be had is not a
 * failure: `browserUnavailable` puts the step back as the inline path would
 * have made it and says "go", or says "again" when it cannot (the step was
 * put on the slim image to browse through that pod) — the gate then returns
 * `again` and `go` is never touched. A stop is looked at after the waits and
 * once more after that repair, before `go`.
 */
export async function gateGoOnServices(
  ready: {
    search?: Promise<{ url: string | null; readyAt: number }>;
    browser?: Promise<{ url: string | null; readyAt: number }>;
  },
  go: () => Promise<void>,
  opts: {
    onReady?: (readyAt: number) => void;
    stopped?: () => boolean;
    browserUnavailable?: () => Promise<"go" | "again">;
  } = {},
): Promise<{ waitMs: number; failed?: string; stopped?: boolean; again?: boolean }> {
  if (!ready.search && !ready.browser) {
    if (opts.stopped?.()) return { waitMs: 0, stopped: true };
    await go();
    return { waitMs: 0 };
  }
  const start = Date.now();
  const search = ready.search ? await ready.search : null;
  if (search && !search.url) {
    // The browser's ensure is left to finish on its own (it never rejects);
    // the step fails for search, as it always has.
    opts.onReady?.(search.readyAt);
    return { waitMs: Date.now() - start, failed: SEARCH_UNAVAILABLE };
  }
  const browser = ready.browser ? await ready.browser : null;
  const waitMs = Date.now() - start;
  // Stamp `services` at the ensures' OWN resolution times (readyAt), not now:
  // on a warm pool gate arrival >= readyAt, so `services` stays honest.
  opts.onReady?.(Math.max(search?.readyAt ?? 0, browser?.readyAt ?? 0));
  if (opts.stopped?.()) return { waitMs, stopped: true };
  if (browser && !browser.url) {
    if ((await opts.browserUnavailable?.()) === "again") return { waitMs, again: true };
    if (opts.stopped?.()) return { waitMs, stopped: true };
  }
  await go();
  return { waitMs };
}

/** First tries that gave the step pod back unused because the browser pod
 *  it was put on the slim image for could not be had (the gate's `again`). */
const BROWSER_AGAIN = new WeakSet<object>();

type ServiceHooks = {
  ensureSearch?: (tenant: string, log: (line: string) => void, opts?: { pod?: string }) => Promise<string | null>;
  ensureBrowser?: (tenant: string, log: (line: string) => void, opts?: { pod?: string }) => Promise<string | null>;
};

/**
 * Run one step in a pod of its own. The account's service pods start beside
 * the step pod (FOL-46) and `go` waits for them. When the browser pod cannot
 * be had and the step was put on the slim image to browse through it, that
 * pod is deleted unused and the step starts again exactly as before the
 * overlap — the browser awaited first, the image chosen after — so it runs as
 * it would have: on the full image, Chromium in the step. The first pod was
 * never handed `go`, and its time is not billed.
 */
export async function runStepInK8s(
  args: RunInContainerArgs,
  // Test seam: lets a test inject the service ensures so the pod lifecycle can
  // be driven against a stub kubectl (FOLDRUN_KUBECTL). Undefined in
  // production — the real ensureSearchPod/ensureBrowserPod are used.
  hooks: ServiceHooks = {},
): Promise<ContainerStepOutcome> {
  const first = await runStepInK8sOnce(args, hooks);
  if (!BROWSER_AGAIN.has(first)) return first;
  args.emit("info", "browser: starting the sandbox again, waiting for the browser pod first");
  return runStepInK8sOnce(args, hooks, { browserInline: true });
}

async function runStepInK8sOnce(
  args: RunInContainerArgs,
  hooks: ServiceHooks = {},
  // The second try after the browser pod could not be had: await it first,
  // as before the overlap, so the image is chosen knowing.
  opts: { browserInline?: boolean } = {},
): Promise<ContainerStepOutcome> {
  // Start-up phases are measured from here, before anything the step waits
  // on (run-container.ts#STARTUP_PHASES); t0 below is the rent clock.
  const begin = Date.now();
  const phases: StartupPhases = {};
  // `at` lets a caller stamp a phase at a moment OTHER than now — FOL-46 uses it
  // so `services` reads the search pod's TRUE ready time (captured inside the
  // ensure promise) rather than when the gate happened to await it. Defaults to
  // now, so every other call is unchanged.
  const markNow = (phase: keyof StartupPhases, at?: number) => { phases[phase] = (at ?? Date.now()) - begin; };
  // A step served from the shared runtime layer says so in its trace; the pod
  // cannot mark the read-only entry used, so the worker keeps that clock.
  const emitThrough = args.emit;
  args = {
    ...args,
    emit: (type, text, extra) => {
      if (type === "info" && text.includes(": shared")) noteSharedUse(text);
      emitThrough(type, text, extra);
    },
  };
  const image = process.env.FOLDRUN_RUNNER_IMAGE;
  if (!image) {
    args.emit("error", "FOLDRUN_RUN_ISOLATION=k8s needs FOLDRUN_RUNNER_IMAGE (an image the cluster can pull)");
    return { status: "failed", result: null, costUsd: null };
  }

  const ns = namespace();
  await kc(["create", "namespace", ns]); // idempotent-by-outcome; AlreadyExists is fine

  // Resume: the pod is the one the record names, and this driver applies
  // its output from the line after the last one the previous driver did.
  const resuming = args.resume ?? null;
  const name = resuming ? resuming.ref : `foldrun-run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const podRef = `pod/${name}`;
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-k8s-"));
  let created = false;
  /** What the workspace looked like going in — a directory for a fresh
   *  step, a hash manifest read back out of the pod for a resumed one. */
  let baseline: string | Record<string, string> | undefined;
  let t0 = Date.now();
  let sandboxMs = 0;
  // FOL-46: ms the step pod sat Ready-but-idle waiting on our search and
  // browser pools (gateGoOnServices). Credited out of billed totalMs below so
  // a cold service pod is the platform's cost, not the customer's.
  let serviceWaitMs = 0;
  /** The image this step's pod runs, for the record (StepRecord.image).
   *  Unknown on a resumed step — the first driver recorded it. */
  let ran: ContainerStepOutcome["image"] = null;

  try {
    if (resuming) {
      const reason = await podEndReason(ns, name);
      if (reason === "pod gone" || reason === null && (await kc(["get", "pod", name, "-n", ns])).status !== 0) {
        args.emit("error", `sandbox ${name} is gone — the step cannot be resumed`);
        return { status: "failed", result: null, costUsd: null, reason: "sandbox gone before the driver could re-attach" };
      }
      created = true; // ours to delete when done, as if we had made it
      // What the first driver handed in, as the HOST noted it — never read
      // back out of the pod, where the step could have rewritten it
      // (FOL-96). Without it every file reads as changed: correct for data,
      // just noisier; configuration is refused either way.
      baseline = args.runId ? readHandedIn(args.workspaceRoot, args.runId, name) : undefined;
      if (!baseline) args.emit("info", "re-attached without a record of what the sandbox was handed — every changed file is compared with the workspace as it is now");
      args.emit("info", `re-attached to ${name} (${resuming.consumed} lines already applied)${reason ? ` — pod already ended: ${reason}` : ""}`);
    }
    // Stage exactly what the docker path stages — same single definition of
    // platform-owned, so the two executors cannot drift.
    const wsIn = path.join(staging, "workspace");
    const libIn = path.join(staging, "library");
    // The job's own inputs sit under opt/runner/job so that one tar rooted
    // at staging lands them at /opt/runner/job in the pod (see unpackIntoPod).
    const jobIn = path.join(staging, "opt", "runner", "job");
    if (!resuming) {
    fs.mkdirSync(jobIn, { recursive: true });
    fs.cpSync(args.workspaceRoot, wsIn, {
      recursive: true,
      preserveTimestamps: true,
      filter: (src) => !isPlatformPath(path.relative(args.workspaceRoot, src)),
    });
    // A test run: what its earlier steps wrote, over the real files, before
    // the times and the baseline are taken (core test-mode#overlayTestWrites).
    if (args.divert) {
      const laid = overlayTestWrites(wsIn, args.divert.to);
      if (laid.length) args.emit("info", `test: this step sees ${laid.length} file${laid.length === 1 ? "" : "s"} earlier steps of this run wrote`);
    }
    // The workspace's real mtimes ride in beside the files and are put back
    // right after the unpack, in the same exec — see mtimeManifest and
    // unpackIntoPod. Outside wsIn: it is the job's, not the workspace's.
    fs.writeFileSync(path.join(jobIn, "mtimes.json"), JSON.stringify(mtimeManifest(wsIn)));
    baseline = wsIn;
    if (args.galleryRoot && fs.existsSync(args.galleryRoot)) fs.cpSync(args.galleryRoot, libIn, { recursive: true });
    if (fs.existsSync(args.libraryRoot)) fs.cpSync(args.libraryRoot, libIn, { recursive: true });
    else fs.mkdirSync(libIn, { recursive: true });
    fs.writeFileSync(path.join(jobIn, "input.json"), JSON.stringify(args.input, null, 2));
    // The copy-in's fingerprint, kept on the host beside the run, so a driver
    // that inherits this step can tell what it changed without this staging
    // directory, which dies with this process (FOL-96: no longer in the pod).
    if (args.runId) writeHandedIn(args.workspaceRoot, args.runId, name, hashTree(wsIn));
    // The account's own service pods — search, browser — for the steps that
    // grant the tools that use them, started now if they are not up. A
    // step that grants neither starts nothing: the pods are the account's
    // bill.
    const services = await accountServiceEnv({
      tenant: args.tenant,
      test: args.test,
      scripts: args.input.scripts,
      env: args.env,
      emit: (line) => args.emit("info", line),
      // FOL-46: start the search pod but do not wait for it here — it boots
      // alongside the step pod and is awaited right before `go` (the gate).
      deferSearch: true,
      // …and the browser pod the same way (28 Oct), except on the try after
      // it could not be had.
      deferBrowser: !opts.browserInline,
      pod: name,
      ensureSearch: hooks.ensureSearch,
      ensureBrowser: hooks.ensureBrowser,
    });
    if (services.failed) {
      args.emit("error", services.failed);
      return { status: "failed", result: null, costUsd: null, reason: services.failed };
    }
    // The no-service case (and a browser awaited inline, on a second try) is
    // marked here as before; a deferred search or browser pod is still
    // booting and is re-marked at the gate with its real Ready moment.
    markNow("services");
    // Which image — after the services, because whether a browsing step
    // may run slim depends on the account's browser pod being up for it.
    const chosen = runnerImageFor(args.input, services.env, (sc) =>
      stagedScriptSource(path.join(wsIn, args.input.agentRel), path.join(libIn, "scripts"), sc),
    );
    if (chosen.pod) {
      services.env[POD_ONLY_ENV] = "1";
      services.env[POD_EVENTS_ENV] = POD_EVENTS_FILE;
    }
    ran = { variant: chosen.variant, ...(chosen.why ? { why: chosen.why } : {}), ...(chosen.pod ? { pod: true } : {}) };
    fs.writeFileSync(path.join(jobIn, "env.sh"), envFileShell(services.env), { mode: 0o600 });

    // The rent clock starts at apply. Everything before it — copying the
    // workspace into staging — is host work on a machine that is already
    // paid for; the pod is the thing that scales to zero and therefore the
    // thing that costs when it doesn't.
    // Room on the cluster before the pod exists (pod-room.ts): the wait is
    // before the rent clock, so it is never billed.
    const held = args.limits ?? resolveResources(args.size);
    // The account's compute pool and step maximum (limits.ts): the plan's,
    // the install's, or lower by the account's own `compute:`.
    // Every level's cap (27 Oct 2026): the account's pool and step maximum
    // (limits.ts: the plan's, the install's, or lower by its own
    // `compute:`), this workspace's pool, and this run's (its flow's
    // compute:, copied onto the run).
    const workspaceName = path.basename(args.workspaceRoot);
    const roomAccount = args.tenant ? accountSegment(args.tenant) ?? null : null;
    const limits = args.tenant ? await levelLimits(args.tenant, workspaceName, args.runId ? runPoolOf(args.tenant, workspaceName, args.runId) : null) : roomLimits();
    const room = await admitPod({
      account: roomAccount,
      workspace: podLabelValue(workspaceName),
      needGiB: memGiB(k8sMemory(held.memory)),
      needCpu: Number(held.cpus) || 0,
      needDisk: memGiB(diskOf(args.size, held.disk)),
      ...(args.room?.key ? { key: args.room.key } : {}),
      limits,
      runId: args.runId,
      stopped: args.stopRequested,
      // The fair order (pod-room.ts waitYourTurn): this step's place in
      // line, and the account's other steps waiting on the records.
      since: args.room?.since ? Date.parse(args.room.since) : null,
      waiting: args.room?.waiting,
      mayDefer: args.room?.mayDefer,
      recorded: recordedWaiters,
      listPods: async () => {
        // Bounded: the check holds this worker's start lock, and kubectl's
        // own default is to wait for the API server forever. (By kc's own
        // timer — see kc for why not --request-timeout.)
        const got = await kc(["get", "pods", "-n", ns, "-o", "json"], undefined, 20_000);
        if (got.status !== 0) return null;
        try {
          return (JSON.parse(got.out).items ?? []) as PodLike[];
        } catch {
          return null;
        }
      },
      emit: (line) => args.emit("info", line),
    });
    if ("failed" in room) {
      args.emit("error", room.failed);
      return { status: "failed", result: null, costUsd: null, reason: room.failed };
    }
    // No room, and the run may wait for it in the queue: nothing was
    // created, nothing rented. The runner sends the step back (core
    // runner.ts) and its run parks with its place in line.
    if ("deferred" in room) {
      return { status: "failed", deferred: room.deferred, result: null, costUsd: null };
    }
    // A stop between the room and the pod: the stop's sweep of the run's
    // pods ran before this one existed, so it is this launch that must look
    // (live check 21 Oct: a step that had its room six seconds before the
    // stop created its pod after it, and ran to the end).
    const stoppedHere = (when: string) => {
      if (!args.stopRequested?.()) return null;
      const reason = `stopped ${when}`;
      args.emit("error", reason);
      return { status: "failed" as const, result: null, costUsd: null, reason };
    };
    {
      const stopped = stoppedHere("before its sandbox was created");
      if (stopped) {
        room.release();
        return stopped;
      }
    }
    markNow("room");
    t0 = Date.now();
    // The pod's own deadline mirrors the in-process backstop (below), plus a
    // small margin so the watch loop is normally the one to act — the pod
    // deadline is the fallback for when the platform is not there to.
    const deadlineSec = args.input.timeoutSec ? args.input.timeoutSec + 180 : undefined;
    if (chosen.pod) args.emit("info", "image: slim — browses through the account's browser pod (a lost pod is reconnected; past that, a step that has only read re-runs on full)");
    else if (chosen.variant === "slim") args.emit("info", "image: slim (this step grants no browser)");
    else if (chosen.why) args.emit("info", `image: full (${chosen.why})`);
    let applied: { status: number | null; out: string };
    try {
      await ensureAccountCache(args.tenant, kc);
      applied = await applyRetrying(
        kc,
        JSON.stringify(runPodManifest(name, chosen.image, args.runId, args.size, deadlineSec, args.tenant, args.test === true, args.network?.enforced === true && args.network.level !== "open", args.limits, podLabelValue(workspaceName))),
        (line) => args.emit("info", line),
      );
    } finally {
      // The pod is counted from here on: the next step's check sees it.
      room.release();
    }
    if (applied.status !== 0) throw new Error(`pod create failed:\n${applied.out.slice(0, 800)}`);
    created = true;
    markNow("applied");
    // And once more now the pod exists: the finally below deletes it.
    {
      const stopped = stoppedHere("as its sandbox was being created");
      if (stopped) return stopped;
    }
    // On the record from the moment it exists: a driver rolled between here
    // and the first output line still knows which pod to come back to.
    args.checkpoint?.(name, 0);

    let ready = await kc(["wait", "--for=condition=Ready", podRef, "-n", ns, `--timeout=${START_WINDOW_SEC}s`]);
    // No node with room for it (27 Oct 2026): the scheduler says so on the
    // pod. That is a wait, not a failure — most often disk or memory the
    // node does not have free just now. It waits as long as it takes, and
    // the time is not charged; anything else that keeps a pod from Ready
    // still fails the step, as before.
    let unplaced = "";
    const seen: Placement = { nominated: false };
    while (ready.status !== 0) {
      const why = await unschedulable(ns, name, seen);
      if (why) {
        const stopped = stoppedHere("while it waited for a node with room");
        if (stopped) return stopped;
        if (why !== unplaced) args.emit("info", `room: no node has room for this sandbox yet — ${why}; waiting, not charged`);
        unplaced = why;
        ready = await kc(["wait", "--for=condition=Ready", podRef, "-n", ns, "--timeout=60s"]);
        continue;
      }
      // Placed, or held by something waiting cannot cure. A placed pod gets
      // the full start-up window from the moment it was placed, not what is
      // left of a poll (Codex review) — nor of the first window: on a node
      // Karpenter has just added, the image is pulled after placement
      // (27 Oct 2026). Placed at once and still not Ready is a failure, as
      // before.
      const placedAt = await scheduledAt(ns, name);
      const left = placedAt ? START_WINDOW_SEC * 1000 - (Date.now() - placedAt) : 0;
      if (left < 5_000) break;
      ready = await kc(["wait", "--for=condition=Ready", podRef, "-n", ns, `--timeout=${Math.ceil(left / 1000)}s`]);
    }
    if (ready.status !== 0) throw new Error(`pod never became ready:\n${ready.out.slice(0, 800)}`);
    if (unplaced) {
      // Credited like a wait for our services: from apply to the moment
      // the scheduler placed it.
      const placedAt = await scheduledAt(ns, name);
      if (placedAt) serviceWaitMs += Math.max(0, placedAt - t0);
      args.emit("info", "room: a node had room — starting");
    }
    // Scheduling + image + gVisor sandbox boot. This is the cold-start
    // number: the one that decides whether a human can wait on a run.
    sandboxMs = Date.now() - t0;
    markNow("ready");
    {
      const stopped = stoppedHere("while its sandbox started");
      if (stopped) return stopped;
    }

    // One tar, one exec, where there were six `kubectl cp` — each itself an
    // exec of tar inside the pod — and a seventh exec to restore mtimes.
    // staging holds exactly workspace/, library/ and opt/runner/job/{input,
    // in,env,mtimes}, so `tar c -C staging workspace library opt` names each
    // member at the path it lands at under `tar x -C /`. kubectl cp forced
    // `tar -m` (every file stamped "now", which the manifest then undid);
    // this unpack keeps the real mtimes and reapplies the manifest in the
    // same exec right after — non-fatally, exactly as the old restore was.
    const { create, exec } = stageInArgs(staging, ns, name);
    const staged = await unpackIntoPod(create, exec);
    if (staged.status !== 0) throw new Error(`stage-in failed:\n${staged.out.slice(0, 500)}`);
    if (staged.out.includes("mtimes-not-restored")) args.emit("error", "file times not restored — freshness checks may pass on old files");
    markNow("files");
    // The CNI programs a new pod's NetworkPolicy rules a moment after the
    // pod is up: measured on k3s/kube-router 2026-09-06, a request in the
    // first ~0.3 s reached an address every policy forbids, and by 0.5 s it
    // was blocked. So the first exec waits a floor past Ready.
    //
    // That was kube-router. On Cilium (every tier since 2026-09-15) the race
    // is gone: on dev-aws staging, 2026-10-18, 20 fresh runner-labelled pods
    // probing world (1.1.1.1:443) and the kube-API ClusterIP from their first
    // instruction never once connected, while allowed egress was open at 0 ms
    // — 20/20 clean (dev/ci/policy-race-check.sh reproduces it). So the floor
    // is configurable: FOLDRUN_POLICY_FLOOR_MS, default 2000 (kept for any CNI
    // not yet proven), 0 where a tier has passed the check. Run the check on a
    // tier before setting it to 0 there.
    // FOL-46: the search and browser pods started in parallel with this step
    // pod; each MUST be Ready before `go` (the step cannot reach them before
    // go anyway — the SHIM blocks on the go file — but its first call would
    // otherwise race the pod). Await them here, then the policy floor, then
    // touch go. A search pool that could not be had fails the step and the
    // finally deletes this pod — the same outcome an inline search failure
    // gives. A browser pool that could not be had is the inline path's
    // outcome too: the step runs Chromium itself (browserUnavailable below).
    const gate = await gateGoOnServices(
      { search: services.searchReady, browser: services.browserReady },
      async () => {
        const floorMs = policyFloorMs();
        const sinceReady = Date.now() - t0 - sandboxMs;
        if (sinceReady < floorMs) await new Promise((r) => setTimeout(r, floorMs - sinceReady));
        await kc(["exec", "-n", ns, name, "--", "touch", "/opt/runner/job/go"]);
      },
      {
        // The honest services-ready mark: when the search and browser pods
        // actually became Ready (the later), even though they overlapped the
        // step pod's boot. On a cold run this is LATER than `ready`/`files`,
        // which is the overlap made visible. readyAt is the ensures' own
        // resolution moment, not gate arrival; never earlier than what is
        // already marked.
        onReady: (readyAt) => markNow("services", servicesReadyAt(readyAt, phases.services === undefined ? undefined : begin + phases.services)),
        // A stop during the gate's wait keeps `go` untouched.
        stopped: args.stopRequested,
        // The browser pod could not be had. On the image this step got, the
        // inline path would have made the same pod with no browser address:
        // take the address back out of the env the pod sources at `go`, and
        // go — Chromium in the step, as before. On the slim image chosen to
        // browse through that pod there is no Chromium to fall back on: give
        // the pod back and start again the old way (runStepInK8s).
        browserUnavailable: async () => {
          args.emit("info", BROWSER_UNAVAILABLE);
          if (chosen.pod) return "again";
          delete services.env.FOLDRUN_BROWSER_WS;
          const put = await kc(["exec", "-i", "-n", ns, name, "--", "sh", "-c", "cat > /opt/runner/job/env.sh"], envFileShell(services.env));
          if (put.status !== 0) throw new Error(`could not take the browser address back out of the sandbox:\n${put.out.slice(0, 500)}`);
          return "go";
        },
      },
    );
    // Added to, never replacing: a wait for a node with room is credited
    // too (Codex review — it was overwritten here and billed).
    serviceWaitMs += gate.waitMs;
    if (gate.failed) {
      args.emit("error", gate.failed);
      return { status: "failed", result: null, costUsd: null, reason: gate.failed };
    }
    if (gate.stopped) {
      // The stop landed while this step idled at the gate waiting on our
      // service pools: go was never touched; return the same outcome
      // c498bba's marks give, and the finally (created=true) deletes the pod.
      const stopped = stoppedHere(services.browserReady && !services.searchReady ? "while its sandbox waited for its browser" : "while its sandbox waited for search");
      if (stopped) return stopped;
    }
    if (gate.again) {
      // Given back unused (go never touched): the finally deletes the pod,
      // and runStepInK8s starts the step again the way it ran before.
      const again = { status: "failed" as const, result: null, costUsd: null, reason: BROWSER_UNAVAILABLE };
      BROWSER_AGAIN.add(again);
      return again;
    }
    markNow("go");
    } // !resuming

    // The driver's stdout, streamed. `logs -f` ends only when the container
    // does, and the shim holds for the ack — so the `done` line, not the
    // stream's end, is the signal to move on.
    let firstOutputAt: number | null = null;
    const outcome = await new Promise<ContainerStepOutcome>((resolve) => {
      let settled = false;
      let reattaches = 0;
      let child: ReturnType<typeof spawn> | null = null;
      let exitWatch: ReturnType<typeof setInterval> | null = null;
      const MAX_REATTACH = 5;
      // No `timeout:` on the step means no backstop: the step runs until it
      // finishes. There used to be a silent 15-minute default here, and it
      // killed an enricher that was doing exactly what it was asked.
      const backstopMs = args.input.timeoutSec ? (args.input.timeoutSec + 120) * 1000 : null;
      const finish = (value: ContainerStepOutcome) => {
        if (settled) return;
        settled = true;
        if (backstop) clearTimeout(backstop);
        if (exitWatch) clearInterval(exitWatch);
        child?.kill();
        resolve(value);
      };
      // Fail the step, but do NOT delete the pod here: the copy-out below
      // needs it alive, and the finally deletes it right after. Deleting
      // first lost every file the step had written — an enricher killed at
      // 17 minutes left nothing, not even the rows it had finished. The
      // pod's own activeDeadlineSeconds sits 60s past this backstop, which
      // is the window the copy-out gets.
      const backstop = backstopMs
        ? setTimeout(() => {
            args.emit("error", `pod exceeded its ${Math.round(backstopMs / 1000)}s backstop — stopping; copying its files out first`);
            finish({ status: "failed", result: null, costUsd: null });
          }, backstopMs)
        : null;

      /** One parsed line, the `index`-th of the log (1-based). Returns true
       *  when it was the terminal one. The checkpoint goes on the record
       *  BEFORE the line is applied — the emit that follows saves both — so
       *  a driver that dies between them replays this one line, never
       *  loses one. */
      const handle = (raw: string, index: number): boolean => {
        if (detaching) return true;
        // A start-up mark from the shim or the driver: on the record's
        // phases, never the step's output (and not its first output).
        const marked = parseDriverMark(raw);
        if (marked) {
          if (!resuming) phases[marked.name] ??= Math.max(0, marked.at - begin);
          return false;
        }
        const parsed = parseDriverLine(raw);
        // kubectl logs carries stderr too: lines that are not the protocol's
        // JSON. A crash's reason is read from the whole log (checkExited).
        if (!parsed) return false;
        firstOutputAt ??= Date.now();
        args.checkpoint?.(name, index);
        if (parsed.e === "event") {
          // The pairing fields and a person-in-the-loop event (operator.ts)
          // ride along, as they do on the container path.
          const { e: _e, type, text, ...extra } = parsed;
          args.emit(type, text, extra);
          return false;
        }
        finish(parsed);
        return true;
      };

      // `skip` is how many lines an earlier attach already handled: a re-read
      // starts at the beginning of the log, and replaying events would print
      // a step's output twice.
      const attach = (skip: number) => {
        let buffer = "";
        let seen = 0;
        const c = spawn(kubectl(), ["logs", "-f", name, "-n", ns], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        child = c;
        streams.add(c);
        c.on("close", () => streams.delete(c));
        c.stdout.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          for (;;) {
            const nl = buffer.indexOf("\n");
            if (nl < 0) break;
            const raw = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            seen += 1;
            if (seen <= skip) continue;
            if (handle(raw, seen)) return;
          }
        });
        c.on("close", () => void recover(seen));
        c.on("error", (err) => {
          args.emit("error", err.message);
          void recover(seen);
        });
      };

      // The stream ended without a terminal line. That has two very different
      // causes and they used to be treated as one: the container genuinely
      // stopped, or the connection dropped while the step was still thinking.
      // A `logs -f` held open across a quiet model call is exactly what an
      // idle-connection timeout kills, and failing the step for it fails work
      // that was fine. The pod's shim holds it open for the ack, so the log is
      // still readable — re-read it and let its contents decide.
      const recover = async (consumed: number) => {
        if (settled || detaching) return;
        let seen = consumed;
        const full = await kc(["logs", name, "-n", ns]);
        if (settled) return;
        if (full.status === 0) {
          const lines = full.out.split("\n");
          // The log ends with a newline, so the split's last element is an
          // empty string, not a line. Counting it put `seen` one past the
          // stream's own count, and the re-attach then skipped the first
          // NEW line — which, after a quiet model call, is usually the
          // `done` line. The step then hung until the shim gave up, was
          // marked failed, and its copy-out hit a terminated pod.
          if (lines.length && lines[lines.length - 1] === "") lines.pop();
          for (let i = seen; i < lines.length; i += 1) {
            if (handle(lines[i], i + 1)) return;
          }
          seen = Math.max(seen, lines.length);
        }
        const phase = await kc(["get", "pod", name, "-n", ns, "-o", "jsonpath={.status.phase}"]);
        if (settled) return;
        const alive = phase.status === 0 && (phase.out === "Running" || phase.out === "Pending");
        // The API server not answering is not the pod being gone: a k3s
        // restart or a blip fails both the log re-read and this lookup, and
        // failing the step for that fails work that is still running.
        const unknown = phase.status !== 0;
        if ((alive || unknown) && reattaches < MAX_REATTACH) {
          reattaches += 1;
          if (unknown) {
            args.emit("info", `cluster not answering — retrying the log stream in 5s (${reattaches}/${MAX_REATTACH})`);
            await new Promise((r) => setTimeout(r, 5000));
            if (settled) return;
          } else {
            args.emit("info", `log stream dropped, pod still running — reattaching (${reattaches}/${MAX_REATTACH})`);
          }
          attach(seen);
          return;
        }
        // Not running, and no done line: the cluster ended it. Say why, in
        // its words, so the retry policy can act on it (OOMKilled and
        // Evicted retry one size up; anything else retries as it was).
        const reason = (await podEndReason(ns, name)) ?? "pod ended without a done line";
        finish({ status: "failed", result: null, costUsd: null, reason });
      };

      attach(resuming ? resuming.consumed : 0);

      // The driver can exit without a done line — a crash after its last tool
      // call, with the reason on stderr. The shim then holds the pod for the
      // ack for forty minutes while the stream sits quiet, and when it gives
      // up the pod is gone and so are the step's files (blog-desk radar,
      // 30 Sep). So watch for the driver's exit code: once it is there, give
      // the done line a moment, re-read the whole log in case the stream
      // missed it, and otherwise fail now — with the pod still held, so the
      // copy-out below keeps what the step wrote.
      exitWatch = setInterval(() => void checkExited(), exitWatchMs());
      let exitSeenAt: number | null = null;
      const checkExited = async () => {
        if (settled || detaching) return;
        const code = await kc(["exec", "-n", ns, name, "--", "cat", "/opt/runner/job/exit"]);
        if (settled || code.status !== 0 || !/^\d+/.test(code.out.trim())) return;
        exitSeenAt ??= Date.now();
        if (Date.now() - exitSeenAt < exitGraceMs()) return;
        const full = await kc(["logs", name, "-n", ns]);
        if (settled) return;
        // The re-read failing (an API server blip) is not the driver saying
        // nothing: try again next tick. The stream's own recovery, the
        // backstop and the shim's hold still bound how long that can go on.
        if (full.status !== 0) return;
        const found = doneInLog(full.out);
        if (found) {
          args.emit("info", "the done line arrived only in a full re-read of the log — the stream had missed it");
          finish(found);
          return;
        }
        const reason = exitedWithoutResult(code.out, full.out);
        args.emit("error", reason);
        finish({ status: "failed", result: null, costUsd: null, reason });
      };
    });
    if (detaching) {
      // Someone else's run now. The pod stays; the record says where we got to.
      return { status: "failed", result: null, costUsd: null, reason: "driver detached — resumed by the next driver" };
    }

    // Copy out of the still-held pod, then release it.
    const wsOut = path.join(staging, "out");
    fs.mkdirSync(wsOut);
    const back = await kc(["cp", `${ns}/${name}:/workspace/.`, wsOut]);
    let applied: string[] = [];
    const refused: RefusedPath[] = [];
    const kept: RefusedPath[] = [];
    if (back.status === 0) {
      applied = applyContainerChanges(args.workspaceRoot, wsOut, baseline, (m) => args.emit("error", m), args.divert, {
        handedBack: args.handedBack?.(),
        onRefused: (r) => refused.push(r),
        // A person approved the step before it ran (FOL-96): its config and
        // code changes are kept, and listed.
        allowConfig: args.configWrites === true,
        onKept: (r) => kept.push(r),
      });
      if (refused.length) args.emit("info", refusedLine(refused));
      if (kept.length) args.emit("info", keptLine(kept));
      if (args.runId) dropHandedIn(args.workspaceRoot, args.runId, name);
    } else {
      // A pod a person's stop destroyed has nothing to copy: say what happened,
      // not a copy-out fault (live check 21 Oct — the stop read as a failure).
      if (args.stopRequested?.()) args.emit("error", "stopped by a person mid-step — its sandbox was destroyed, so the step's file changes were not kept");
      else args.emit("error", `copy-out failed — the step's file changes were lost:\n${back.out.slice(0, 500)}`);
    }
    await kc(["exec", "-n", ns, name, "--", "touch", "/opt/runner/job/ack"]);

    // After the ack: the pod is held live for the copy-out, so the copy-out
    // is rented time like everything else.
    // A resumed step's clock is this driver's share of it; the first
    // driver's sandbox and first-output numbers are on the record already.
    // FOL-46: the rent clock (t0) is unchanged — still set at pod apply. But
    // the step pod may have sat idle before `go` waiting on a cold search pod
    // we started (serviceWaitMs); that is our latency, not the customer's, so
    // it is credited out of billed totalMs. Warm search (pool already up) →
    // serviceWaitMs ~0 → totalMs identical to before. Never negative.
    const timing: StepTiming = {
      sandboxMs,
      firstOutputMs: firstOutputAt === null ? null : firstOutputAt - t0 - sandboxMs,
      totalMs: billedTotalMs(Date.now() - t0, serviceWaitMs),
      ...(!resuming && Object.keys(phases).length ? { phases } : {}),
    };
    args.emit("info", timingLine(timing));
    return { ...outcome, timing, applied, ...(refused.length ? { refused } : {}), ...(ran ? { image: ran } : {}) };
  } finally {
    if (created && !detaching) await kc(["delete", podRef, "-n", ns, "--wait=false"]);
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
