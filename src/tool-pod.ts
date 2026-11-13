// Tools on demand, under gVisor (owner, 14 Nov 2026: "all tools should be on
// demand on gvisor"). An account's tool runs as ONE POD PER ACCOUNT AND TOOL
// in the run namespace, made when that account is using the tool and
// deleted once it has not for the idle window. Never always-on. The tools:
//
//   extract   the files-to-text parser (foldrun-extract: OCR, PDF text,
//             office files, audio cutting), slice 1
//   stt-gen   Whisper, the general model (large-v3-turbo: every language),
//             slice 3 — `/talk`, and the speech in a file
//   stt-fa    Whisper, the Persian model — made only when Persian is asked
//             for (lang=fa) or heard (auto, detected on stt-gen)
//
// Why per account: these pods read files and recordings strangers sent with
// big parsers (Tesseract, Poppler, Docling, ffmpeg, whisper.cpp). A pod
// shared by every account would let an exploit read the next account's
// bytes in flight. Per account, a compromised pod sees only what that account
// sent; which account's pod a caller reaches is still the platform's choice
// (the URL is named from the authenticated tenant), and only the platform's
// own pods are let in.
//
// Why not account-pod.ts (search, browser): those pods are the run's reach
// into the world, so their policy lets them out to the internet; these must
// reach nothing. And their ensure deletes a Pending pod as stale, but a tool
// pod is Pending for the whole cold start (a runner node booting, a 1–1.4 GB
// image pulling) — two callers would keep killing each other's pod.
//
// Who does what:
//   - a caller holds a LEASE while it uses a tool, and the lease's insert
//     sends pg_notify(foldrun_tool_wanted). For extract the lease is the
//     `running` row every extraction already takes (extract.ts takeSlot); for
//     Whisper it is a row in tool_leases (holdToolLease) — `/talk` has no
//     extraction, so it holds its own. The caller then waits for its
//     account's pod to answer /health (waitForTool). Callers need no
//     Kubernetes rights at all: web and the gateway, which face the internet,
//     never create a pod.
//   - the worker (the role that already creates run pods in foldrun-runs)
//     reconciles: every (account, tool) with a live lease gets its pod,
//     Service and policy (create if absent, never delete a Pending pod),
//     stamped as used; a pod with no live lease for the idle window is
//     deleted, after its leases are checked again under the lock a lease is
//     taken with. On a notification, and every few seconds as the safety net.
//
// Capacity: the pods run on the Karpenter runner pool, whose CPU cap (8 prod,
// 4 staging) runs share. Whisper uses its 2 threads, so its pods request a
// whole CPU (not 100m), so Karpenter sizes nodes for what they do; both
// Whisper kinds use ONE image holding both models (~1 GB, pulled once a node).
//
// Billing: NOT billed yet. Extraction and transcription are not metered
// (extract.ts: "the owner sets the prices"); a pod's seconds go to the ops
// log when it is reaped (tool_pod.reaped), ready for a price later.
//
//   FOLDRUN_TOOLS_ON_DEMAND=1             on (needs a database; the worker
//                                         also FOLDRUN_RUN_ISOLATION=k8s and
//                                         FOLDRUN_RUNNER_RUNTIME, gVisor)
//   FOLDRUN_TOOLS_ON_DEMAND_ACCOUNTS      accounts it is on for, comma list;
//                                         unset or "*" for every account
//   FOLDRUN_EXTRACT_IMAGE                 the parser image, by digest
//   FOLDRUN_TRANSCRIBE_IMAGE              the Whisper image, by digest
//   FOLDRUN_TOOL_POD_IDLE_S               idle window (600)
//   FOLDRUN_TOOL_POD_START_S              how long a caller waits for a cold
//                                         pod to answer (300: node + pull)
//   FOLDRUN_EXTRACT_URL,                  when set, win: a fixed service
//   FOLDRUN_TRANSCRIBE_URL / _FA_URL      (Docker Compose, self-host) and no
//                                         pods are made for that tool

import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { opsError, opsLog } from "../../foldrun-core/src/ops-log.ts";
import { ACCOUNT_LABEL, LAST_USED, platformNamespace, accountSegment, kc, namespace } from "./account-pod.ts";
import { databaseEnabled, orm, tx } from "./db.ts";
import { listen } from "./pg-listen.ts";

export const TOOL_LABEL = "foldrun.io/tool";
export const TOOL_CHANNEL = "foldrun_tool_wanted";
/** The platform pods that call the parser: the only ones its policy lets in. */
export const TOOL_CALLERS = ["foldrun-web", "foldrun-worker", "foldrun-egress"] as const;
/** Whisper's callers: the same, and the gateway (`/talk`). */
export const STT_CALLERS = [...TOOL_CALLERS, "foldrun-gateway"] as const;

export type ToolName = "extract" | "stt-gen" | "stt-fa";

/** One kind of tool pod: its names, its port, its image, its container. */
export interface ToolKind {
  tool: ToolName;
  /** The `app` label (the callers' egress rule selects it). */
  app: string;
  /** The prefix of every object's name: `<prefix>-<account label>` (≤ 63). */
  prefix: string;
  port: number;
  callers: readonly string[];
  image(env: NodeJS.ProcessEnv): string | undefined;
  /** A fixed service is configured for this tool: it wins, no pods. */
  fixed(env: NodeJS.ProcessEnv): boolean;
  pod(env: NodeJS.ProcessEnv): { securityContext: object; containers: object[]; volumes: object[] };
}

const locked = { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] }, readOnlyRootFilesystem: true };

export const EXTRACT: ToolKind = {
  tool: "extract",
  app: "foldrun-extract",
  prefix: "foldrun-extract",
  port: 8090,
  callers: TOOL_CALLERS,
  image: (env) => env.FOLDRUN_EXTRACT_IMAGE,
  fixed: (env) => !!env.FOLDRUN_EXTRACT_URL,
  // manifests/components/extract/extract.yaml's container, as it was.
  pod: (env) => ({
    securityContext: { seccompProfile: { type: "RuntimeDefault" }, runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001 },
    containers: [
      {
        name: "extract",
        image: env.FOLDRUN_EXTRACT_IMAGE,
        imagePullPolicy: "IfNotPresent",
        // Work in flight per pod; more get 503 and the platform retries.
        env: [{ name: "EXTRACT_CONCURRENCY", value: "2" }, { name: "EXTRACT_PORT", value: "8090" }],
        ports: [{ name: "http", containerPort: 8090 }],
        securityContext: locked,
        volumeMounts: [{ name: "scratch", mountPath: "/scratch" }],
        resources: { requests: { cpu: "100m", memory: "512Mi" }, limits: { cpu: "2", memory: "3Gi" } },
        startupProbe: { httpGet: { path: "/health", port: 8090 }, periodSeconds: 3, timeoutSeconds: 3, failureThreshold: 40 },
        readinessProbe: { httpGet: { path: "/health", port: 8090 }, periodSeconds: 10, timeoutSeconds: 5, failureThreshold: 3 },
      },
    ],
    volumes: [{ name: "scratch", emptyDir: { sizeLimit: "4Gi" } }],
  }),
};

/** whisper-server with one of the image's two models
 *  (manifests/components/transcribe/transcribe.yaml's container, one per pod). */
function whisper(model: "general" | "fa"): ToolKind["pod"] {
  return (env) => ({
    securityContext: { seccompProfile: { type: "RuntimeDefault" }, runAsNonRoot: true, runAsUser: 501, runAsGroup: 50 },
    containers: [
      {
        name: "whisper",
        image: env.FOLDRUN_TRANSCRIBE_IMAGE,
        imagePullPolicy: "IfNotPresent",
        env: [{ name: "MODEL", value: model }, { name: "PORT", value: "8080" }, { name: "THREADS", value: "2" }],
        ports: [{ name: "http", containerPort: 8080 }],
        securityContext: locked,
        volumeMounts: [{ name: "tmp", mountPath: "/tmp" }],
        // A whole CPU, not 100m: whisper.cpp keeps its two threads busy for a
        // whole inference, and the runner pool's cap is shared with runs.
        resources: { requests: { cpu: "1", memory: "1Gi" }, limits: { cpu: "2", memory: "1536Mi" } },
        // The model loads before /health answers: a minute and more under gVisor.
        startupProbe: { httpGet: { path: "/health", port: 8080 }, periodSeconds: 3, timeoutSeconds: 3, failureThreshold: 80 },
        readinessProbe: { httpGet: { path: "/health", port: 8080 }, periodSeconds: 10, timeoutSeconds: 5, failureThreshold: 3 },
      },
    ],
    volumes: [{ name: "tmp", emptyDir: { sizeLimit: "64Mi" } }],
  });
}

export const STT_GEN: ToolKind = {
  tool: "stt-gen",
  app: "foldrun-stt",
  prefix: "foldrun-stt-gen",
  port: 8080,
  callers: STT_CALLERS,
  image: (env) => env.FOLDRUN_TRANSCRIBE_IMAGE,
  fixed: (env) => !!(env.FOLDRUN_TRANSCRIBE_URL || env.FOLDRUN_TRANSCRIBE_FA_URL),
  pod: whisper("general"),
};

export const STT_FA: ToolKind = { ...STT_GEN, tool: "stt-fa", prefix: "foldrun-stt-fa", pod: whisper("fa") };

export const KINDS: readonly ToolKind[] = [EXTRACT, STT_GEN, STT_FA];
const kindOf = (tool: string) => KINDS.find((k) => k.tool === tool) ?? null;

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};
export const toolIdleMs = (env: NodeJS.ProcessEnv = process.env) => num(env.FOLDRUN_TOOL_POD_IDLE_S, 600) * 1000;
export const toolStartMs = (env: NodeJS.ProcessEnv = process.env) => num(env.FOLDRUN_TOOL_POD_START_S, 300) * 1000;

/** A caller may use this tool's pods: the switch, a database (the worker
 *  finds the work by the leases' rows; without one every caller would wait
 *  for a pod nobody makes), the tool's image — and no fixed service, which
 *  wins (Codex review, 14 Nov 2026). */
export function kindOnDemand(kind: ToolKind, env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FOLDRUN_TOOLS_ON_DEMAND === "1" && !!env.FOLDRUN_DATABASE_URL && !!kind.image(env) && !kind.fixed(env);
}

/** This process may make the pods: k8s isolation and a sandbox runtime too. */
export function canMakeToolPods(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FOLDRUN_RUN_ISOLATION === "k8s" && !!env.FOLDRUN_RUNNER_RUNTIME;
}

/** The parser on demand, for web and the worker (both make or call it). */
export function toolsOnDemand(env: NodeJS.ProcessEnv = process.env): boolean {
  return kindOnDemand(EXTRACT, env) && canMakeToolPods(env);
}

function listed(tenant: string, env: NodeJS.ProcessEnv): boolean {
  const list = (env.FOLDRUN_TOOLS_ON_DEMAND_ACCOUNTS ?? "*").split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes("*") || list.includes(tenant);
}

/** The parser on demand for this account. */
export function onDemandFor(tenant: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return toolsOnDemand(env) && listed(tenant, env);
}

/** Whisper on demand for this account (both models: one image). */
export function sttOnDemandFor(tenant: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return kindOnDemand(STT_GEN, env) && listed(tenant, env);
}

const podName = (kind: ToolKind, seg: string) => `${kind.prefix}-${seg}`;
const podUrl = (kind: ToolKind, seg: string, ns = namespace()) => `http://${podName(kind, seg)}.${ns}.svc.cluster.local:${kind.port}`;
const labels = (kind: ToolKind, seg: string) => ({ app: kind.app, [ACCOUNT_LABEL]: seg, [TOOL_LABEL]: kind.tool });

export const extractPodName = (seg: string) => podName(EXTRACT, seg);
export const extractPodUrl = (seg: string, ns = namespace()) => podUrl(EXTRACT, seg, ns);
export const toolPodName = podName;
export const toolPodUrl = podUrl;

/**
 * One account's pod of a tool: gVisor always — the RuntimeClass also carries
 * the runner pool's nodeSelector and toleration, so it lands on a Karpenter
 * runner node and never on a platform node.
 */
export function toolPodManifest(kind: ToolKind, seg: string, env: NodeJS.ProcessEnv = process.env, now = new Date()): object {
  const spec = kind.pod(env);
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: podName(kind, seg),
      namespace: namespace(),
      labels: labels(kind, seg),
      annotations: {
        [LAST_USED]: now.toISOString(),
        // Consolidation must not move it mid-file; the idle reaper ends it.
        "karpenter.sh/do-not-disrupt": "true",
      },
    },
    spec: {
      restartPolicy: "Always",
      runtimeClassName: env.FOLDRUN_RUNNER_RUNTIME,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      terminationGracePeriodSeconds: 30,
      ...spec,
    },
  };
}
export const extractPodManifest = (seg: string, env: NodeJS.ProcessEnv = process.env, now = new Date()) => toolPodManifest(EXTRACT, seg, env, now);

export function toolServiceManifest(kind: ToolKind, seg: string): object {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: podName(kind, seg), namespace: namespace(), labels: labels(kind, seg) },
    spec: { selector: labels(kind, seg), ports: [{ name: "http", port: kind.port, targetPort: kind.port }] },
  };
}
export const extractServiceManifest = (seg: string) => toolServiceManifest(EXTRACT, seg);

/** In: the tool's callers, on its port. Out: nothing at all, not even DNS.
 *  (The kubelet's probes come from the node, which Cilium's default
 *  allow-localhost admits, as for every run and account pod.) */
export function toolPolicyManifest(kind: ToolKind, seg: string): object {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: podName(kind, seg), namespace: namespace(), labels: labels(kind, seg) },
    spec: {
      podSelector: { matchLabels: labels(kind, seg) },
      policyTypes: ["Ingress", "Egress"],
      ingress: [
        {
          from: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": platformNamespace() } },
              podSelector: { matchExpressions: [{ key: "app", operator: "In", values: [...kind.callers] }] },
            },
          ],
          ports: [{ protocol: "TCP", port: kind.port }],
        },
      ],
      egress: [],
    },
  };
}
export const extractPolicyManifest = (seg: string) => toolPolicyManifest(EXTRACT, seg);

// ---------------------------------------------------------------- leases (callers)

const LEASE_SECONDS = 120;
const RENEW_MS = 30_000;

/** The lock a lease is taken under, and a pod is reaped under. */
const lockKey = (kind: ToolKind, tenant: string) => (kind.tool === "extract" ? `extract:${tenant}` : `tool:${kind.tool}:${tenant}`);

/**
 * Hold a lease on an account's Whisper pod while it is used: a row in
 * tool_leases, renewed every 30 s, ended at release (kept, expired, so the
 * reaper still knows whose pod it is; swept after a day). Its insert tells
 * the worker at once. The parser's lease is its extraction's row instead.
 */
export async function holdToolLease(kind: ToolKind, tenant: string): Promise<{ release: () => Promise<void> }> {
  const id = `tl-${Date.now().toString(36)}${crypto.randomBytes(8).toString("hex")}`;
  await tx(async (t) => {
    await t.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey(kind, tenant)}))`);
    await t.execute(sql`INSERT INTO tool_leases (id, tenant, tool, lease_until) VALUES (${id}, ${tenant}, ${kind.tool}, now() + make_interval(secs => ${LEASE_SECONDS}))`);
    await t.execute(sql`SELECT pg_notify(${TOOL_CHANNEL}, ${tenant})`);
  });
  const beat = setInterval(() => {
    void orm()!
      .execute(sql`UPDATE tool_leases SET lease_until = now() + make_interval(secs => ${LEASE_SECONDS}) WHERE id = ${id} AND lease_until > now()`)
      .catch((err) => opsError("tool_pod.lease_renew_failed", err, { tenant, tool: kind.tool }));
  }, RENEW_MS);
  beat.unref?.();
  let done = false;
  return {
    release: async () => {
      if (done) return;
      done = true;
      clearInterval(beat);
      await orm()!.execute(sql`UPDATE tool_leases SET lease_until = now() WHERE id = ${id}`);
    },
  };
}

// ---------------------------------------------------------------- the worker's side

/** What to do with a pod in this phase: create it when absent, replace it
 *  only when it has ended, and leave a Pending or Running one alone — a
 *  Pending pod is the cold start, never stale. Pure, for the tests. */
export function ensureAction(phase: string | null): "create" | "replace" | "keep" {
  if (phase === null || phase === "") return "create";
  if (phase === "Failed" || phase === "Succeeded") return "replace";
  return "keep";
}

async function podPhase(name: string): Promise<string | null | undefined> {
  const r = await kc(["get", "pod", name, "-n", namespace(), "--ignore-not-found", "-o", "jsonpath={.status.phase}"]);
  if (r.status !== 0) return undefined; // the cluster did not answer: do nothing this pass
  const out = r.out.trim();
  return out === "" ? null : out;
}

/** The account's pod of a tool, its Service and policy, made if absent; the pod stamped as used. */
export async function ensureToolPod(kind: ToolKind, tenant: string, env: NodeJS.ProcessEnv = process.env): Promise<"created" | "kept" | "skipped"> {
  const seg = accountSegment(tenant);
  if (!seg || !kindOnDemand(kind, env) || !canMakeToolPods(env) || !listed(tenant, env)) return "skipped";
  const name = podName(kind, seg);
  const ns = namespace();
  const shared = { apiVersion: "v1", kind: "List", items: [toolServiceManifest(kind, seg), toolPolicyManifest(kind, seg)] };
  const applied = await kc(["apply", "-f", "-"], JSON.stringify(shared));
  if (applied.status !== 0) throw new Error(`${kind.tool} pod for ${seg}: ${applied.err.trim().split("\n").pop()}`);
  const phase = await podPhase(name);
  if (phase === undefined) return "skipped";
  const act = ensureAction(phase);
  if (act === "keep") {
    await kc(["annotate", "pod", name, "-n", ns, `${LAST_USED}=${new Date().toISOString()}`, "--overwrite"]);
    return "kept";
  }
  if (act === "replace") await kc(["delete", "pod", name, "-n", ns, "--ignore-not-found", "--wait=true", "--timeout=60s"]);
  const made = await kc(["create", "-f", "-"], JSON.stringify(toolPodManifest(kind, seg, env)));
  // Another worker made it in the same instant: that is the pod we wanted.
  if (made.status !== 0 && !/AlreadyExists/.test(made.err)) throw new Error(`${kind.tool} pod for ${seg}: ${made.err.trim().split("\n").pop()}`);
  opsLog("info", "tool_pod.created", { tenant, tool: kind.tool, pod: name });
  return "created";
}
export const ensureExtractPod = (tenant: string, env: NodeJS.ProcessEnv = process.env) => ensureToolPod(EXTRACT, tenant, env);

/** Accounts with an extraction in flight right now: a `running` row whose
 *  lease has not run out. Null when the database would not answer — and
 *  then nothing is reaped. */
export async function accountsWithLiveExtractions(): Promise<Set<string> | null> {
  if (!(databaseEnabled() && orm())) return null;
  try {
    const { rows } = await orm()!.execute<{ tenant: string }>(sql`SELECT DISTINCT tenant FROM extract_jobs WHERE status = 'running' AND lease_until > now()`);
    return new Set(rows.map((r) => r.tenant));
  } catch (err) {
    opsError("tool_pod.wanted_failed", err);
    return null;
  }
}

/** Every (account, tool) in use right now: the live extractions (extract)
 *  and the live tool leases (Whisper). Null when the database would not
 *  answer. */
export async function toolsInUse(): Promise<Map<ToolName, Set<string>> | null> {
  const ex = await accountsWithLiveExtractions();
  if (ex === null) return null;
  const out = new Map<ToolName, Set<string>>([["extract", ex], ["stt-gen", new Set()], ["stt-fa", new Set()]]);
  try {
    const { rows } = await orm()!.execute<{ tenant: string; tool: string }>(sql`SELECT DISTINCT tenant, tool FROM tool_leases WHERE lease_until > now()`);
    for (const r of rows) out.get(r.tool as ToolName)?.add(r.tenant);
  } catch (err) {
    opsError("tool_pod.wanted_failed", err);
    return null;
  }
  return out;
}

export interface ToolPodInfo {
  name: string;
  seg: string;
  createdAt: string;
  lastUsed: string;
  /** The tool label; extract when absent (slice 1's pods). */
  tool?: string;
}

/** Pods to delete: the account has no live lease on that tool AND the pod has
 *  not been stamped for the idle window. Pure, for the tests. */
export function idleToolPods(pods: ToolPodInfo[], busySegs: Set<string>, now: number, idleMs: number): ToolPodInfo[] {
  return pods.filter((p) => !busySegs.has(p.seg) && now - Date.parse(p.lastUsed || p.createdAt) > idleMs);
}

async function listToolPods(): Promise<ToolPodInfo[] | null> {
  const r = await kc([
    "get", "pods", "-n", namespace(), "-l", `${TOOL_LABEL} in (${KINDS.map((k) => k.tool).join(",")})`, "-o",
    `jsonpath={range .items[*]}{.metadata.name}{"\\t"}{.metadata.labels.foldrun\\.io/account}{"\\t"}{.metadata.creationTimestamp}{"\\t"}{.metadata.annotations.foldrun\\.io/last-used}{"\\t"}{.metadata.labels.foldrun\\.io/tool}{"\\n"}{end}`,
  ]);
  if (r.status !== 0) return null;
  return r.out
    .split("\n")
    .map((l) => l.split("\t"))
    .filter((f) => f.length >= 3 && f[0])
    .map(([name, seg, createdAt, lastUsed, tool]) => ({ name, seg, createdAt, lastUsed: lastUsed || createdAt, tool: tool || "extract" }));
}

/** One pass: ensure every (account, tool) in use, reap the idle pods. */
export async function reconcileToolPods(env: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<{ ensured: number; reaped: number }> {
  if (!canMakeToolPods(env) || !KINDS.some((k) => kindOnDemand(k, env))) return { ensured: 0, reaped: 0 };
  const inUse = await toolsInUse();
  if (inUse === null) return { ensured: 0, reaped: 0 };
  let ensured = 0;
  for (const kind of KINDS) {
    for (const tenant of inUse.get(kind.tool) ?? []) {
      try {
        if ((await ensureToolPod(kind, tenant, env)) !== "skipped") ensured++;
      } catch (err) {
        opsError("tool_pod.ensure_failed", err, { tenant, tool: kind.tool });
      }
    }
  }
  const pods = await listToolPods();
  if (pods === null) return { ensured, reaped: 0 };
  let reaped = 0;
  let tenantOf: Map<string, string> | null = null;
  for (const kind of KINDS) {
    const busySegs = new Set([...(inUse.get(kind.tool) ?? [])].map((t) => accountSegment(t)).filter((s): s is string => !!s));
    const idle = idleToolPods(pods.filter((p) => (p.tool ?? "extract") === kind.tool), busySegs, now, toolIdleMs(env));
    if (idle.length && !tenantOf) tenantOf = await tenantsBySegment();
    for (const p of idle) {
      try {
        if (await reapIfStillIdle(p, tenantOf!.get(p.seg) ?? null, kind)) {
          opsLog("info", "tool_pod.reaped", { tenant: tenantOf!.get(p.seg) ?? undefined, tool: kind.tool, pod: p.name, secs: Math.round((now - Date.parse(p.createdAt)) / 1000) });
          reaped++;
        }
      } catch (err) {
        opsError("tool_pod.reap_failed", err, { pod: p.name });
      }
    }
  }
  // Ended leases are kept a day (so a pod is always someone's), then go.
  await orm()!
    .execute(sql`DELETE FROM tool_leases WHERE lease_until < now() - interval '1 day'`)
    .catch((err) => opsError("tool_pod.lease_sweep_failed", err));
  return { ensured, reaped };
}

/** The accounts the leases know (extract_jobs rows stay a day, tool_leases
 *  rows a day past their end; a pod lives minutes past its last one), by DNS
 *  label: whose pod is whose. */
async function tenantsBySegment(): Promise<Map<string, string>> {
  const { rows } = await orm()!.execute<{ tenant: string }>(sql`SELECT DISTINCT tenant FROM extract_jobs UNION SELECT DISTINCT tenant FROM tool_leases`);
  const out = new Map<string, string>();
  for (const { tenant } of rows) {
    const seg = accountSegment(tenant);
    if (seg && !out.has(seg)) out.set(seg, tenant);
  }
  return out;
}

/**
 * Delete the pod only if its account STILL holds no lease on that tool,
 * checked under the advisory lock a lease is taken with (extract.ts takeSlot,
 * holdToolLease): a lease taken after this pass's first look either shows up
 * here and keeps the pod, or is taken after the delete and has its pod made
 * again — never served by a pod being deleted under it (Codex review).
 */
export async function reapIfStillIdle(p: ToolPodInfo, tenant: string | null, kind: ToolKind = kindOf(p.tool ?? "extract") ?? EXTRACT): Promise<boolean> {
  const ns = namespace();
  const drop = async () => {
    await kc(["delete", "pod", p.name, "-n", ns, "--ignore-not-found", "--wait=false"]);
    await kc(["delete", "service,networkpolicy", p.name, "-n", ns, "--ignore-not-found", "--wait=false"]);
  };
  // No account owns the label any more (deleted with its rows): nothing to race.
  if (!tenant) {
    await drop();
    return true;
  }
  return tx(async (t) => {
    await t.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey(kind, tenant)}))`);
    const live =
      kind.tool === "extract"
        ? sql`SELECT count(*)::int AS n FROM extract_jobs WHERE tenant = ${tenant} AND status = 'running' AND lease_until > now()`
        : sql`SELECT count(*)::int AS n FROM tool_leases WHERE tenant = ${tenant} AND tool = ${kind.tool} AND lease_until > now()`;
    const { rows } = await t.execute<{ n: number }>(live);
    if ((rows[0]?.n ?? 0) > 0) return false;
    // The Service and policy go in the same breath: a caller admitted the
    // moment the lock is released waits for the pod the worker makes again.
    await drop();
    return true;
  });
}

let timer: ReturnType<typeof setInterval> | undefined;
let running: Promise<unknown> | null = null;
let again = false;
/** Single flight: a notification during a pass asks for one more pass. */
function kick(): void {
  if (running) {
    again = true;
    return;
  }
  running = reconcileToolPods()
    .catch((err) => opsError("tool_pod.reconcile_failed", err))
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        kick();
      }
    });
}

/** Started with the worker's loops (boot.ts): on a notification, and every
 *  five seconds as the safety net a missed notification needs. */
export function startToolPods(env: NodeJS.ProcessEnv = process.env): void {
  if (timer || !canMakeToolPods(env) || !KINDS.some((k) => kindOnDemand(k, env))) return;
  listen(TOOL_CHANNEL, () => kick(), { up: kick, down: kick });
  timer = setInterval(kick, 5000);
  timer.unref?.();
  kick();
  opsLog("info", "tool_pod.started", { count: KINDS.filter((k) => kindOnDemand(k, env)).length });
}

// ---------------------------------------------------------------- the caller's side

type Fetch = typeof fetch;
let fetchFn: Fetch = (...a) => fetch(...a);
/** Test seam: the /health checks. */
export function setToolFetchForTests(fn: Fetch | null): void {
  fetchFn = fn ?? ((...a) => fetch(...a));
}

export class ToolStartError extends Error {
  readonly status = 503;
  constructor(message: string) {
    super(message);
  }
}

/** The account's pod URL for a tool once it answers /health — after a cold
 *  start this waits for a runner node, the image pull and (Whisper) the model
 *  load: toolStartMs, apart from the tool's own timeouts. Throws
 *  ToolStartError when it never answers, the AbortError of `signal` when the
 *  caller gives up. */
export async function waitForTool(tenant: string, signal: AbortSignal, env: NodeJS.ProcessEnv = process.env, startMs = toolStartMs(env), kind: ToolKind = EXTRACT): Promise<string> {
  const seg = accountSegment(tenant);
  if (!seg) throw new ToolStartError("this account's name cannot name a pod");
  const url = podUrl(kind, seg);
  const deadline = Date.now() + startMs;
  let wait = 500;
  for (;;) {
    signal.throwIfAborted();
    try {
      const res = await fetchFn(`${url}/health`, { redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) });
      if (res.ok) return url;
    } catch (err) {
      if (signal.aborted) throw err;
      // not up yet: no Service, no endpoint, or the tool still loading
    }
    if (Date.now() >= deadline) throw new ToolStartError(`the ${kind.tool === "extract" ? "text extraction" : "transcription"} pod did not start within ${Math.round(startMs / 1000)} s — try again`);
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, wait);
      signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
    });
    wait = Math.min(2000, wait * 2);
  }
}
