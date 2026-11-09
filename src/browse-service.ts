// The browse service on the cluster (FOL-128 phase 2): one pod per browsing
// step's lease, made beside the step's run pod and deleted with it. The
// pod's program is browse-service.mjs; the names and the switch are
// browse-door.ts. foldrun-docs/proposals/browse-egress.md has the design and
// network.md#the-browse-service what a step sees.
//
// Why a pod per lease and not the account's pool (the browser pod): the
// service holds the step's lease (its browser's proxy password) and the
// secrets a call names. Two steps in one pod would share a user and a
// process tree, so a page that broke out of one step's Chromium could read
// the other's. One pod is one step: nothing in it belongs to anyone else,
// and it is gone when the step is.
//
// What the pod may reach, and who may reach it — the policy below, applied
// with every pod, because the run namespace has no default deny: in, only
// the egress proxy (or the worker, where the proxy runs there) on 3100; out,
// only the proxy on 8090 and DNS. Every page its browser opens goes through
// the proxy's forward door under the step's lease. No image of its own: the
// runner image, as the account's browser pod.

import crypto from "node:crypto";
import fs from "node:fs";
import { ACCOUNT_LABEL, accountSegment, kc, namespace, podNetBytes, pricingOf, stampPricing } from "./account-pod.ts";
import { SIZE, memQuantity, servicePodSize, serviceRequests, sizeOf } from "./pod-sizes.ts";
import { browserImage } from "./browser-k8s.ts";
import { recordAccountPodSession } from "./ledger.ts";
import { billing } from "./billing.ts";
import { BROWSE_APP, BROWSE_PORT, BROWSE_SUBDOMAIN, browsePodName, leaseHash } from "./browse-door.ts";
import { GALLERY } from "./gallery.ts";

/** On the browse pod: the run pod it serves, so an orphan is found. */
export const RUN_POD_LABEL = "foldrun.io/run-pod";
const AGENT_UID = 10001;
const DISPLAY = ":99";
const PROGRAM_DIR = "/opt/foldrun-browse";
/** The platform's own namespace: where the egress proxy and worker run. */
const platformNamespace = () => process.env.FOLDRUN_PLATFORM_NAMESPACE ?? "foldrun";

/** The service's program, as shipped beside this file. */
export const serviceProgram = (): string => fs.readFileSync(new URL("./browse-service.mjs", import.meta.url), "utf8");

/** The platform's browse program: the gallery's, never an account's copy. */
export function galleryBrowseProgram(): string {
  const f = GALLERY.find((t) => t.name === "web")?.extra?.find((x) => x.file === "web/browse.mjs");
  if (!f) throw new Error("the gallery has no web/browse.mjs");
  return f.content;
}

/** The ConfigMap the pods mount, named by its content: a pod keeps the
 *  program it was made with while a deploy rolls a new one out. */
export function programConfigMap(): object {
  const data = { "service.mjs": serviceProgram(), "browse.mjs": galleryBrowseProgram() };
  const hash = crypto.createHash("sha256").update(data["service.mjs"]).update("\0").update(data["browse.mjs"]).digest("hex").slice(0, 10);
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: `${BROWSE_APP}-program-${hash}`, namespace: namespace(), labels: { app: `${BROWSE_APP}-program` } },
    data,
  };
}

/** Who may reach the pods, and what they may reach. */
export function browsePolicyManifest(): object {
  const proxy = [
    { namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": platformNamespace() } }, podSelector: { matchLabels: { app: "foldrun-egress" } } },
    { namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": platformNamespace() } }, podSelector: { matchLabels: { app: "foldrun-worker" } } },
  ];
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: BROWSE_APP, namespace: namespace(), labels: { app: BROWSE_APP } },
    spec: {
      podSelector: { matchLabels: { app: BROWSE_APP } },
      policyTypes: ["Ingress", "Egress"],
      ingress: [{ from: proxy, ports: [{ protocol: "TCP", port: BROWSE_PORT }] }],
      egress: [
        { to: proxy, ports: [{ protocol: "TCP", port: 8090 }] },
        {
          to: [{ namespaceSelector: {}, podSelector: { matchLabels: { "k8s-app": "kube-dns" } } }],
          ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }],
        },
      ],
    },
  };
}

/** The headless Service that gives each pod `<pod>.foldrun-browse.<ns>`. */
export function browseHeadlessService(): object {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: BROWSE_SUBDOMAIN, namespace: namespace(), labels: { app: BROWSE_APP } },
    spec: { clusterIP: "None", selector: { app: BROWSE_APP }, ports: [{ name: "browse", port: BROWSE_PORT, targetPort: BROWSE_PORT }] },
  };
}

export interface BrowsePodSpec {
  token: string;
  seg: string;
  runPod: string;
  configMap: string;
  deadlineSec?: number;
  /** The run pod's uid: the cluster deletes this pod when that one goes. */
  runPodUid?: string;
}

export function browsePodManifest(o: BrowsePodSpec, now = new Date()): object {
  const size = servicePodSize("browse");
  const name = browsePodName(o.token);
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      namespace: namespace(),
      labels: { app: BROWSE_APP, [ACCOUNT_LABEL]: o.seg, [RUN_POD_LABEL]: o.runPod },
      annotations: { "foldrun.io/created": now.toISOString(), [SIZE]: JSON.stringify(size) },
      ...(o.runPodUid ? { ownerReferences: [{ apiVersion: "v1", kind: "Pod", name: o.runPod, uid: o.runPodUid, blockOwnerDeletion: false }] } : {}),
    },
    spec: {
      hostname: name,
      subdomain: BROWSE_SUBDOMAIN,
      restartPolicy: "Never",
      // The step's own ceiling, as its run pod's: nothing outlives it long.
      ...(o.deadlineSec ? { activeDeadlineSeconds: o.deadlineSec } : {}),
      terminationGracePeriodSeconds: 2,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      ...(process.env.FOLDRUN_RUNNER_RUNTIME ? { runtimeClassName: process.env.FOLDRUN_RUNNER_RUNTIME } : {}),
      securityContext: {
        seccompProfile: { type: "RuntimeDefault" },
        runAsNonRoot: true,
        runAsUser: AGENT_UID,
        runAsGroup: AGENT_UID,
        fsGroup: AGENT_UID,
      },
      containers: [
        {
          name: "browse",
          image: browserImage(),
          imagePullPolicy: "IfNotPresent",
          // A virtual screen first, for `headless: false`; then the service.
          command: [
            "sh", "-c", `Xvfb ${DISPLAY} -screen 0 1920x1080x24 -nolisten tcp >/tmp/xvfb.log 2>&1 & exec "$@"`, "browse",
            "node", `${PROGRAM_DIR}/service.mjs`,
          ],
          env: [
            { name: "HOME", value: "/tmp/home" },
            { name: "DISPLAY", value: DISPLAY },
            { name: "FOLDRUN_BROWSE_LEASE_ID", value: leaseHash(o.token) },
            { name: "FOLDRUN_BROWSE_EGRESS", value: process.env.FOLDRUN_EGRESS_URL ?? "" },
            { name: "FOLDRUN_BROWSE_PROGRAM", value: `${PROGRAM_DIR}/browse.mjs` },
            { name: "FOLDRUN_BROWSE_PORT", value: String(BROWSE_PORT) },
          ],
          ports: [{ containerPort: BROWSE_PORT }],
          volumeMounts: [
            { name: "shm", mountPath: "/dev/shm" },
            { name: "tmp", mountPath: "/tmp" },
            { name: "program", mountPath: PROGRAM_DIR, readOnly: true },
          ],
          resources: {
            requests: { ...serviceRequests("browse", size), "ephemeral-storage": memQuantity(size.diskGiB) },
            limits: { ...serviceRequests("browse", size), "ephemeral-storage": memQuantity(size.diskGiB) },
          },
          readinessProbe: { httpGet: { path: "/healthz", port: BROWSE_PORT }, initialDelaySeconds: 1, periodSeconds: 2 },
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] }, readOnlyRootFilesystem: true },
        },
      ],
      volumes: [
        { name: "shm", emptyDir: { medium: "Memory", sizeLimit: "1Gi" } },
        { name: "tmp", emptyDir: {} },
        { name: "program", configMap: { name: o.configMap, defaultMode: 0o444 } },
      ],
    },
  };
}

/** The run pod's uid once it exists (it is made beside this one); none
 *  after a few seconds leaves the sweep as the only backstop. */
async function runPodUid(name: string): Promise<string | undefined> {
  for (let i = 0; i < 20; i++) {
    const got = await kc(["get", "pod", name, "-n", namespace(), "-o", "jsonpath={.metadata.uid}"]);
    if (got.status === 0 && /^[0-9a-f-]{36}$/.test(got.out.trim())) return got.out.trim();
    await new Promise((r) => setTimeout(r, 500));
  }
  return undefined;
}

/**
 * Make the step's browse pod and wait for it to answer. False when it
 * cannot be had — the step then browses in its own sandbox, as before.
 */
export async function ensureBrowsePod(o: { token: string; tenant: string; runPod: string; deadlineSec?: number }, log: (line: string) => void = () => {}): Promise<boolean> {
  const seg = accountSegment(o.tenant);
  if (!seg || !browserImage()) {
    log("browse service: no account label or runner image — not used");
    return false;
  }
  const t0 = Date.now();
  const cm = programConfigMap() as { metadata: { name: string } };
  // Asked each time, not remembered: the sweep may collect one no pod uses.
  const have = await kc(["get", "configmap", cm.metadata.name, "-n", namespace(), "-o", "name"]);
  if (have.status !== 0) {
    // Server-side: the program is past client-side apply's 256 KB annotation.
    const put = await kc(["apply", "--server-side", "--force-conflicts", "--field-manager=foldrun-browse", "-f", "-"], JSON.stringify(cm));
    if (put.status !== 0) {
      log(`browse service: could not write its program: ${(put.err || put.out).trim().split("\n").pop()}`);
      return false;
    }
  }
  const name = browsePodName(o.token);
  const uid = await runPodUid(o.runPod);
  const pod = stampPricing(browsePodManifest({ token: o.token, seg, runPod: o.runPod, configMap: cm.metadata.name, deadlineSec: o.deadlineSec, ...(uid ? { runPodUid: uid } : {}) }), billing().priceSnapshot?.() ?? null);
  // The policy before the pod, in one apply: the pod is walled from its
  // first packet.
  const applied = await kc(["apply", "-f", "-"], [browsePolicyManifest(), browseHeadlessService(), pod].map((x) => JSON.stringify(x)).join("\n---\n"));
  if (applied.status !== 0) {
    log(`browse service: could not create ${name}: ${(applied.err || applied.out).trim().split("\n").pop()}`);
    return false;
  }
  const ready = await kc(["wait", "--for=condition=Ready", `pod/${name}`, "-n", namespace(), "--timeout=120s"]);
  if (ready.status !== 0) {
    log(`browse service: ${name} never became ready: ${(ready.err || ready.out).trim().split("\n").pop()}`);
    await deleteBrowsePod(o.token, o.tenant);
    return false;
  }
  log(`browse service: ${name} up in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return true;
}

/** Delete one pod and put its time on the account's ledger. */
async function deleteAndBill(name: string, tenant: string | null, createdAt: string | undefined, pricing: string | undefined, size?: string): Promise<void> {
  // The pod's own counters, read BEFORE it goes: the bytes Chromium moved
  // for the step are metered like any pod's (FOL-125, 8 Nov 2026 — they were
  // always recorded as 0). A pod that cannot answer is recorded as 0, as the
  // account pods are.
  const netBytes = tenant && createdAt ? (await podNetBytes(name)) ?? 0 : 0;
  await kc(["delete", "pod", name, "-n", namespace(), "--ignore-not-found", "--wait=false"]);
  if (!tenant || !createdAt) return;
  const secs = Math.max(1, (Date.now() - Date.parse(createdAt)) / 1000);
  await recordAccountPodSession(tenant, { kind: "browse", podName: name, secs, netBytes, from: createdAt, ...sizeOf(size, "browse"), pricing: pricingOf(pricing) }).catch(() => null);
}

/** The step is over: its browse pod goes, billed for the time it held. */
export async function deleteBrowsePod(token: string, tenant: string): Promise<void> {
  const name = browsePodName(token);
  const got = await kc(["get", "pod", name, "-n", namespace(), "-o", `jsonpath={.metadata.creationTimestamp}{"\\t"}{.metadata.annotations.foldrun\\.io/pricing}{"\\t"}{.metadata.annotations.foldrun\\.io/size}`]);
  const [createdAt, pricing, size] = got.status === 0 ? got.out.split("\t") : [];
  await deleteAndBill(name, got.status === 0 ? tenant : null, createdAt || undefined, pricing || undefined, size || undefined);
}

/**
 * Browse pods whose run pod is gone — a worker that died mid-step never
 * reached its `finally`. Deleted and billed; run on the scheduler's tick.
 * A cluster that will not list either kind reaps nothing.
 */
export async function sweepOrphanBrowsePods(tenantOf: (seg: string) => string | null, graceMs = 2 * 60_000): Promise<number> {
  if (process.env.FOLDRUN_RUN_ISOLATION !== "k8s") return 0;
  const ns = namespace();
  const pods = await kc(["get", "pods", "-n", ns, "-l", `app=${BROWSE_APP}`, "-o",
    `jsonpath={range .items[*]}{.metadata.name}{"\\t"}{.metadata.labels.foldrun\\.io/run-pod}{"\\t"}{.metadata.labels.foldrun\\.io/account}{"\\t"}{.metadata.creationTimestamp}{"\\t"}{.metadata.annotations.foldrun\\.io/pricing}{"\\t"}{.metadata.annotations.foldrun\\.io/size}{"\\n"}{end}`]);
  if (pods.status !== 0) return 0;
  if (!pods.out.trim()) {
    await collectPrograms("").catch(() => undefined);
    return 0;
  }
  const runs = await kc(["get", "pods", "-n", ns, "-l", "app=foldrun-run", "-o", "jsonpath={range .items[*]}{.metadata.name}{\"\\t\"}{.status.phase}{\"\\n\"}{end}"]);
  if (runs.status !== 0) return 0;
  // A run pod that has finished (kept a while for its copy-out) serves no
  // step any more: its browse pod goes.
  const alive = new Set(runs.out.split("\n").map((l) => l.trim().split("\t")).filter(([n, phase]) => n && phase !== "Succeeded" && phase !== "Failed").map(([n]) => n));
  let n = 0;
  for (const line of pods.out.split("\n")) {
    const [name, runPod, seg, createdAt, pricing, size] = line.split("\t");
    if (!name || !runPod || alive.has(runPod)) continue;
    if (!(Date.now() - Date.parse(createdAt ?? "") > graceMs)) continue;
    await deleteAndBill(name, seg ? tenantOf(seg) : null, createdAt, pricing, size || undefined);
    n++;
  }
  await collectPrograms(pods.out).catch(() => undefined);
  return n;
}

/** Program ConfigMaps no browse pod mounts, a day old: a deploy's old one.
 *  The current one is kept even unused; an older one a pod still mounts too. */
async function collectPrograms(podListing: string): Promise<void> {
  const ns = namespace();
  const current = (programConfigMap() as { metadata: { name: string } }).metadata.name;
  const mounted = await kc(["get", "pods", "-n", ns, "-l", `app=${BROWSE_APP}`, "-o", "jsonpath={range .items[*]}{.spec.volumes[*].configMap.name}{\"\\n\"}{end}"]);
  if (mounted.status !== 0 && podListing.trim()) return;
  const used = new Set(mounted.out.split(/\s+/).filter(Boolean));
  const cms = await kc(["get", "configmaps", "-n", ns, "-l", `app=${BROWSE_APP}-program`, "-o", "jsonpath={range .items[*]}{.metadata.name}{\"\\t\"}{.metadata.creationTimestamp}{\"\\n\"}{end}"]);
  if (cms.status !== 0) return;
  for (const line of cms.out.split("\n")) {
    const [name, created] = line.trim().split("\t");
    if (!name || name === current || used.has(name)) continue;
    if (Date.now() - Date.parse(created ?? "") < 24 * 60 * 60_000) continue;
    await kc(["delete", "configmap", name, "-n", ns, "--ignore-not-found"]);
  }
}

/** Every browse pod of an account being deleted. */
export async function deleteAccountBrowsePods(tenant: string): Promise<void> {
  const seg = accountSegment(tenant);
  if (!seg) return;
  await kc(["delete", "pods", "-n", namespace(), "-l", `app=${BROWSE_APP},${ACCOUNT_LABEL}=${seg}`, "--ignore-not-found", "--wait=false"]);
}

