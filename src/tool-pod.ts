// Tools on demand, under gVisor (owner, 14 Nov 2026: "all tools should be on
// demand on gvisor"). Slice 1: the files-to-text parser (foldrun-extract:
// OCR, PDF text, office files) as ONE POD PER ACCOUNT in the run namespace,
// made when that account has an extraction in flight and deleted once it
// has had none for the idle window. Never always-on. Speech (Whisper) is
// not on demand yet: transcribe.ts still answers "not configured" here.
//
// Why per account: the parser opens files strangers sent (its job is to read
// attacker-controlled bytes with Tesseract, Poppler, Docling and ffmpeg). A
// pod shared by every account would let a parser exploit read the next
// account's files in flight. Per account, a compromised parser sees only
// what that account sent; which account's pod a caller reaches is still the
// platform's choice (the URL is named from the authenticated tenant), and
// the platform pods are the only ones let in.
//
// Why not account-pod.ts (search, browser): those pods are the run's reach
// into the world, so their policy lets them out to the internet; this one
// must reach nothing. And their ensure deletes a Pending pod as stale, but a
// parser pod is Pending for the whole cold start (a runner node booting, a
// 1.4 GB image pulling) — two callers would keep killing each other's pod.
//
// Who does what:
//   - a caller (web, worker, the egress proxy's text door) records its
//     extraction as a `running` row in extract_jobs — the lease every place
//     already takes (extract.ts takeSlot) — and that insert sends
//     pg_notify(foldrun_tool_wanted). It then waits for its account's pod to
//     answer /health (waitForTool). Callers need no Kubernetes rights at all:
//     the web pod, which faces the internet, never creates a pod.
//   - the worker (the role that already creates run pods in foldrun-runs)
//     reconciles: every account with a live lease gets its pod, Service and
//     policy (create if absent, never delete a Pending pod), stamped as used;
//     a pod whose account has had no live lease for the idle window is
//     deleted. On a notification, and every few seconds as the safety net.
//
// Billing: NOT billed yet. Extraction itself is not metered (extract.ts:
// "the owner sets the prices"); the pod's seconds are written to the ops log
// when it is reaped (tool_pod.reaped), ready for a price later.
//
//   FOLDRUN_TOOLS_ON_DEMAND=1             on (with FOLDRUN_RUN_ISOLATION=k8s
//                                         and FOLDRUN_RUNNER_RUNTIME, gVisor)
//   FOLDRUN_TOOLS_ON_DEMAND_ACCOUNTS      accounts it is on for, comma list;
//                                         unset or "*" for every account
//   FOLDRUN_EXTRACT_IMAGE                 the parser image, by digest
//   FOLDRUN_TOOL_POD_IDLE_S               idle window (600)
//   FOLDRUN_TOOL_POD_START_S              how long a caller waits for a cold
//                                         pod to answer (300: node + pull)
//   FOLDRUN_EXTRACT_URL                   when set, wins: a fixed parser
//                                         (Docker Compose, self-host) and no
//                                         pods are made

import { sql } from "drizzle-orm";
import { opsError, opsLog } from "../../foldrun-core/src/ops-log.ts";
import { ACCOUNT_LABEL, LAST_USED, platformNamespace, accountSegment, kc, namespace } from "./account-pod.ts";
import { databaseEnabled, orm, tx } from "./db.ts";
import { listen } from "./pg-listen.ts";

export const EXTRACT_APP = "foldrun-extract";
export const EXTRACT_PORT = 8090;
/** Which tool a pod is; one value today. */
export const TOOL_LABEL = "foldrun.io/tool";
export const TOOL_CHANNEL = "foldrun_tool_wanted";
/** The platform pods that call a tool: the only ones its policy lets in. */
export const TOOL_CALLERS = ["foldrun-web", "foldrun-worker", "foldrun-egress"] as const;

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};
export const toolIdleMs = (env: NodeJS.ProcessEnv = process.env) => num(env.FOLDRUN_TOOL_POD_IDLE_S, 600) * 1000;
export const toolStartMs = (env: NodeJS.ProcessEnv = process.env) => num(env.FOLDRUN_TOOL_POD_START_S, 300) * 1000;

/** On for this install: k8s isolation, a sandbox runtime, an image — and a
 *  database, since the worker finds the work by the leases' rows (without
 *  one the slots are files it cannot see, and every caller would wait for a
 *  pod nobody makes). Off when a fixed parser is set: FOLDRUN_EXTRACT_URL
 *  wins, so no pod would be used (Codex review, 14 Nov 2026). */
export function toolsOnDemand(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.FOLDRUN_TOOLS_ON_DEMAND === "1" &&
    env.FOLDRUN_RUN_ISOLATION === "k8s" &&
    !!env.FOLDRUN_RUNNER_RUNTIME &&
    !!env.FOLDRUN_EXTRACT_IMAGE &&
    !!env.FOLDRUN_DATABASE_URL &&
    !env.FOLDRUN_EXTRACT_URL
  );
}

/** On for this account: the install's switch, then the account list. */
export function onDemandFor(tenant: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!toolsOnDemand(env)) return false;
  const list = (env.FOLDRUN_TOOLS_ON_DEMAND_ACCOUNTS ?? "*").split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes("*") || list.includes(tenant);
}

export const extractPodName = (seg: string) => `${EXTRACT_APP}-${seg}`;
export const extractPodUrl = (seg: string, ns = namespace()) => `http://${extractPodName(seg)}.${ns}.svc.cluster.local:${EXTRACT_PORT}`;
const labels = (seg: string) => ({ app: EXTRACT_APP, [ACCOUNT_LABEL]: seg, [TOOL_LABEL]: "extract" });

/**
 * The parser pod for one account: manifests/components/extract/extract.yaml's
 * container, as a bare pod in the run namespace. gVisor always — the
 * RuntimeClass also carries the runner pool's nodeSelector and toleration, so
 * it lands on a Karpenter runner node and never on a platform node.
 */
export function extractPodManifest(seg: string, env: NodeJS.ProcessEnv = process.env, now = new Date()): object {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: extractPodName(seg),
      namespace: namespace(),
      labels: labels(seg),
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
      securityContext: {
        seccompProfile: { type: "RuntimeDefault" },
        runAsNonRoot: true,
        runAsUser: 10001,
        runAsGroup: 10001,
        fsGroup: 10001,
      },
      containers: [
        {
          name: "extract",
          image: env.FOLDRUN_EXTRACT_IMAGE,
          imagePullPolicy: "IfNotPresent",
          env: [
            // Work in flight per pod; more get 503 and the platform retries.
            { name: "EXTRACT_CONCURRENCY", value: "2" },
            { name: "EXTRACT_PORT", value: String(EXTRACT_PORT) },
          ],
          ports: [{ name: "http", containerPort: EXTRACT_PORT }],
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] }, readOnlyRootFilesystem: true },
          volumeMounts: [{ name: "scratch", mountPath: "/scratch" }],
          resources: { requests: { cpu: "100m", memory: "512Mi" }, limits: { cpu: "2", memory: "3Gi" } },
          startupProbe: { httpGet: { path: "/health", port: EXTRACT_PORT }, periodSeconds: 3, timeoutSeconds: 3, failureThreshold: 40 },
          readinessProbe: { httpGet: { path: "/health", port: EXTRACT_PORT }, periodSeconds: 10, timeoutSeconds: 5, failureThreshold: 3 },
        },
      ],
      volumes: [{ name: "scratch", emptyDir: { sizeLimit: "4Gi" } }],
    },
  };
}

export function extractServiceManifest(seg: string): object {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: extractPodName(seg), namespace: namespace(), labels: labels(seg) },
    spec: { selector: labels(seg), ports: [{ name: "http", port: EXTRACT_PORT, targetPort: EXTRACT_PORT }] },
  };
}

/** In: the platform's callers, on the parser's port. Out: nothing at all,
 *  not even DNS. (The kubelet's probes come from the node, which Cilium's
 *  default allow-localhost admits, as for every run and account pod.) */
export function extractPolicyManifest(seg: string): object {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: extractPodName(seg), namespace: namespace(), labels: labels(seg) },
    spec: {
      podSelector: { matchLabels: labels(seg) },
      policyTypes: ["Ingress", "Egress"],
      ingress: [
        {
          from: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": platformNamespace() } },
              podSelector: { matchExpressions: [{ key: "app", operator: "In", values: [...TOOL_CALLERS] }] },
            },
          ],
          ports: [{ protocol: "TCP", port: EXTRACT_PORT }],
        },
      ],
      egress: [],
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

/** The account's pod, Service and policy, made if absent; the pod stamped as used. */
export async function ensureExtractPod(tenant: string, env: NodeJS.ProcessEnv = process.env): Promise<"created" | "kept" | "skipped"> {
  const seg = accountSegment(tenant);
  if (!seg || !onDemandFor(tenant, env)) return "skipped";
  const name = extractPodName(seg);
  const ns = namespace();
  const shared = { apiVersion: "v1", kind: "List", items: [extractServiceManifest(seg), extractPolicyManifest(seg)] };
  const applied = await kc(["apply", "-f", "-"], JSON.stringify(shared));
  if (applied.status !== 0) throw new Error(`extract pod for ${seg}: ${applied.err.trim().split("\n").pop()}`);
  const phase = await podPhase(name);
  if (phase === undefined) return "skipped";
  const act = ensureAction(phase);
  if (act === "keep") {
    await kc(["annotate", "pod", name, "-n", ns, `${LAST_USED}=${new Date().toISOString()}`, "--overwrite"]);
    return "kept";
  }
  if (act === "replace") await kc(["delete", "pod", name, "-n", ns, "--ignore-not-found", "--wait=true", "--timeout=60s"]);
  const made = await kc(["create", "-f", "-"], JSON.stringify(extractPodManifest(seg, env)));
  // Another worker made it in the same instant: that is the pod we wanted.
  if (made.status !== 0 && !/AlreadyExists/.test(made.err)) throw new Error(`extract pod for ${seg}: ${made.err.trim().split("\n").pop()}`);
  opsLog("info", "tool_pod.created", { tenant, kind: "extract" });
  return "created";
}

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

export interface ToolPodInfo {
  name: string;
  seg: string;
  createdAt: string;
  lastUsed: string;
}

/** Pods to delete: the account has no live extraction AND the pod has not
 *  been stamped for the idle window. Pure, for the tests. */
export function idleToolPods(pods: ToolPodInfo[], busySegs: Set<string>, now: number, idleMs: number): ToolPodInfo[] {
  return pods.filter((p) => !busySegs.has(p.seg) && now - Date.parse(p.lastUsed || p.createdAt) > idleMs);
}

async function listExtractPods(): Promise<ToolPodInfo[] | null> {
  const r = await kc([
    "get", "pods", "-n", namespace(), "-l", `app=${EXTRACT_APP},${TOOL_LABEL}=extract`, "-o",
    `jsonpath={range .items[*]}{.metadata.name}{"\\t"}{.metadata.labels.foldrun\\.io/account}{"\\t"}{.metadata.creationTimestamp}{"\\t"}{.metadata.annotations.foldrun\\.io/last-used}{"\\n"}{end}`,
  ]);
  if (r.status !== 0) return null;
  return r.out
    .split("\n")
    .map((l) => l.split("\t"))
    .filter((f) => f.length >= 3 && f[0])
    .map(([name, seg, createdAt, lastUsed]) => ({ name, seg, createdAt, lastUsed: lastUsed || createdAt }));
}

/** One pass: ensure every busy account's pod, reap the idle ones. */
export async function reconcileToolPods(env: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<{ ensured: number; reaped: number }> {
  if (!toolsOnDemand(env)) return { ensured: 0, reaped: 0 };
  const busy = await accountsWithLiveExtractions();
  if (busy === null) return { ensured: 0, reaped: 0 };
  let ensured = 0;
  for (const tenant of busy) {
    try {
      if ((await ensureExtractPod(tenant, env)) !== "skipped") ensured++;
    } catch (err) {
      opsError("tool_pod.ensure_failed", err, { tenant });
    }
  }
  const pods = await listExtractPods();
  if (pods === null) return { ensured, reaped: 0 };
  const busySegs = new Set([...busy].map((t) => accountSegment(t)).filter((s): s is string => !!s));
  let reaped = 0;
  const idle = idleToolPods(pods, busySegs, now, toolIdleMs(env));
  const tenantOf = idle.length ? await tenantsBySegment() : new Map<string, string>();
  for (const p of idle) {
    try {
      if (await reapIfStillIdle(p, tenantOf.get(p.seg) ?? null)) {
        opsLog("info", "tool_pod.reaped", { kind: "extract", account: p.seg, seconds: Math.round((now - Date.parse(p.createdAt)) / 1000) });
        reaped++;
      }
    } catch (err) {
      opsError("tool_pod.reap_failed", err, { account: p.seg });
    }
  }
  return { ensured, reaped };
}

/** The accounts extract_jobs knows (its rows stay a day, a pod lives minutes
 *  past its last one), by DNS label: whose pod is whose. */
async function tenantsBySegment(): Promise<Map<string, string>> {
  const { rows } = await orm()!.execute<{ tenant: string }>(sql`SELECT DISTINCT tenant FROM extract_jobs`);
  const out = new Map<string, string>();
  for (const { tenant } of rows) {
    const seg = accountSegment(tenant);
    if (seg && !out.has(seg)) out.set(seg, tenant);
  }
  return out;
}

/**
 * Delete the pod only if its account STILL has no extraction in flight,
 * checked under the advisory lock that takes a slot (extract.ts takeSlot):
 * an extraction admitted after this pass's first look either shows up here
 * and keeps the pod, or is admitted after the delete and has its pod made
 * again — never served by a pod being deleted under it (Codex review).
 */
export async function reapIfStillIdle(p: ToolPodInfo, tenant: string | null): Promise<boolean> {
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
    await t.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`extract:${tenant}`}))`);
    const { rows } = await t.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM extract_jobs WHERE tenant = ${tenant} AND status = 'running' AND lease_until > now()`);
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
  if (timer || !toolsOnDemand(env)) return;
  listen(TOOL_CHANNEL, () => kick(), { up: kick, down: kick });
  timer = setInterval(kick, 5000);
  timer.unref?.();
  kick();
  opsLog("info", "tool_pod.started", { kind: "extract" });
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

/** The account's parser URL once it answers /health — after a cold start
 *  this waits for a runner node and the image pull (toolStartMs), apart from
 *  the parser's own timeout. Throws ToolStartError when it never answers,
 *  the AbortError of `signal` when the caller gives up. */
export async function waitForTool(tenant: string, signal: AbortSignal, env: NodeJS.ProcessEnv = process.env, startMs = toolStartMs(env)): Promise<string> {
  const seg = accountSegment(tenant);
  if (!seg) throw new ToolStartError("this account's name cannot name a pod");
  const url = extractPodUrl(seg);
  const deadline = Date.now() + startMs;
  let wait = 500;
  for (;;) {
    signal.throwIfAborted();
    try {
      const res = await fetchFn(`${url}/health`, { redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) });
      if (res.ok) return url;
    } catch (err) {
      if (signal.aborted) throw err;
      // not up yet: no Service, no endpoint, or the parser still loading
    }
    if (Date.now() >= deadline) throw new ToolStartError(`the text extraction pod did not start within ${Math.round(startMs / 1000)} s — try again`);
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, wait);
      signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
    });
    wait = Math.min(2000, wait * 2);
  }
}
