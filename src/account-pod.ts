// A service an account rents by the minute: one pod in the run namespace,
// started the first time a step that needs it is about to run, kept while
// steps keep using it, deleted after an idle window and billed for what it
// held. Search (search-k8s.ts) and the browser (browser-k8s.ts) are the two
// kinds; this is the mechanism they share, so a rule fixed here — the
// stderr-vs-stdout lesson, the busy guard, the billing line — is fixed for
// both. The owner's rule, verbatim: "all tools search browser should run at
// account level if they are triggered and if they are not used then they
// get killed." Nothing account-level is always on.
//
// Since 2026-09-15 an account has a POOL of a kind, not one pod: pods are
// added while steps arrive faster than one pod should serve, never removed
// while any run pod of the account is alive, and reaped once idle for the
// window — a pod beyond the current demand stops being stamped and idles
// out first, the last pod goes when the account stops. A step never waits
// on a saturated pod, and an account that is not running pays for nothing —
// scale-to-zero is the rest state, growth is the busy state, and there is
// no always-on in between.
// The Service spreads new connections across every Ready pod, which is all
// the routing a Playwright server or a search engine needs: a browser call
// connects, is given a browser of its own, and keeps its session as storage
// state on the run's side, so no call depends on reaching the same pod as
// the last one.
//
// Three things follow from a pod per account and kind:
//
//   - isolation: an account's queries and pages share a process with no
//     one else's;
//   - blast radius: an account that hammers a service suspends ITS pod;
//   - billing: the pod's seconds and bytes are the account's compute and
//     network, on the meters the platform already has. A shared pod was
//     cost nobody paid.
//
// What it does not change: every pod still leaves the cluster from the
// node's address, so upstream per-IP limits stay shared. That is a matter
// of egress addresses, not of pod placement.
//
// Tenant isolation is enforced on both sides of the wire: a per-account
// NetworkPolicy lets run pods labelled with that account reach only the
// service pod labelled with the same account and kind, and the pod's own
// ingress admits only those run pods. The ingress was the pod CIDR while
// kube-router was the CNI (a selector lagged pod creation; searxng.yaml has
// the history). Under Cilium (2026-09-15) a CIDR never matches a pod, and a
// selector matches from the first packet, so both rules are selectors —
// never an ipBlock for a pod.
//
//   FOLDRUN_K8S_NAMESPACE            the run namespace (foldrun-runs)
//   FOLDRUN_KUBECTL                  the kubectl to drive (kubectl)
//   FOLDRUN_RUN_ISOLATION=k8s        every kind needs this and its own switch

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { safeTenantSegment } from "../../foldrun-core/src/runtime.ts";
import { recordAccountPodSession } from "./ledger.ts";
import { billing } from "./billing.ts";
import type { PriceSnapshot } from "../../foldrun-core/src/store.ts";

export const ACCOUNT_LABEL = "foldrun.io/account";
export const LAST_USED = "foldrun.io/last-used";
/** The prices a pod was made under (billing().priceSnapshot()), as JSON:
 *  its session is charged at them when it is reaped (30 Oct 2026). */
export const PRICING = "foldrun.io/pricing";

/** A pod manifest with the price snapshot stamped on it. */
export function stampPricing(manifest: object, snapshot: PriceSnapshot | null): object {
  if (!snapshot) return manifest;
  const m = manifest as { metadata?: { annotations?: Record<string, string> } };
  return { ...m, metadata: { ...(m.metadata ?? {}), annotations: { ...(m.metadata?.annotations ?? {}), [PRICING]: JSON.stringify(snapshot) } } };
}

/** The snapshot read back off a pod, or null for one made before them (or
 *  with an annotation that does not read as one — the live prices then). */
export function pricingOf(text: string | undefined): PriceSnapshot | null {
  if (!text) return null;
  try {
    const p = JSON.parse(text) as PriceSnapshot;
    return p && typeof p.version === "number" && p.values && typeof p.values === "object" ? p : null;
  } catch {
    return null;
  }
}
/** The label every run pod carries; the source side of each policy. */
export const RUN_APP = "foldrun-run";

export const kubectl = () => process.env.FOLDRUN_KUBECTL ?? "kubectl";
export const namespace = () => process.env.FOLDRUN_K8S_NAMESPACE ?? "foldrun-runs";

/**
 * One kind of account service. The pod is the kind's own — search is a
 * SearXNG with a settings file, the browser a Playwright server on the
 * runner image — and everything around it (Service, policies, ensure, reap,
 * bill, delete) is written once below.
 */
export interface AccountPodKind {
  /** The word in log lines and ledger notes: "search", "browser". */
  kind: string;
  /** The `app` label; also the prefix of every object's name. */
  app: string;
  /** The one port the run pods may reach it on. */
  port: number;
  /** Both the kind's switch and k8s isolation, or nothing happens. */
  enabled(): boolean;
  /** Unused this long and it is reaped. */
  idleMs(): number;
  /** One pod of the pool, labelled for the account, last-used stamped now,
   *  named as given (the first keeps the bare name, the rest are numbered). */
  podManifest(seg: string, now?: Date, name?: string): object;
  /** Anything the pod needs that is not the pod (a ConfigMap), applied first. */
  extraObjects?(): object[];
  /** How a run pod addresses it — a URL scheme is the kind's business. */
  url(seg: string): string;
  /** Held at the small reservation, and billed as one. */
  small?: boolean;
  /** How many of the account's steps one pod should serve at once; the
   *  pool grows past it. A browser pod renders full pages and gets few, a
   *  search pod answers queries and gets many. */
  stepsPerPod(): number;
  /** The pool never grows past this, whatever the demand: the account's
   *  ceiling on this kind's compute, and the cluster's. */
  maxPods(): number;
  /** A test run's pod may not reach it. A browser fetches the world for
   *  whoever drives it, so a test run that reached one would have the
   *  world its deny policy takes away; a search pod only answers queries. */
  refusesTestRuns?: boolean;
}

/** The label a test run's pod carries (run-k8s.ts TEST_LABEL; spelled here
 *  too because run-k8s imports this file). */
export const TEST_RUN_LABEL = "foldrun.io/test";

/** On a run pod whose step's `network:` is enforced and not open: the base
 *  run policy (foldrun-infra run-network-policy.yaml) then gives it the
 *  egress proxy and DNS but not the world, and no account pod admits it —
 *  a browser or a search engine is the world, fetched on the run's behalf. */
export const NETWORK_LABEL = "foldrun.io/network";

/**
 * The pool size a demand calls for — pure, so the rule is testable: one
 * pod for the first `perPod` steps, another for the next, never more than
 * `cap`, never fewer than one for any demand at all.
 */
export function podsWanted(activeSteps: number, perPod: number, cap: number): number {
  const per = Math.max(1, Math.floor(perPod));
  const want = Math.ceil(Math.max(1, activeSteps) / per);
  return Math.max(1, Math.min(Math.max(1, Math.floor(cap)), want));
}

/**
 * An account name as a DNS label: the pod, its Service and its policies are
 * all named from it, and a Service name must be a DNS label. Lower-cased,
 * anything outside [a-z0-9-] becomes a dash, 40 characters at most — the
 * prefix takes the rest of the 63. Null for a tenant that is not a safe
 * segment at all, the same test the dependency cache applies.
 *
 * COLLISION-PROOF. Folding alone made `a.b`, `a_b` and `A-B` the same label
 * — the same search pod, the same Service, the same NetworkPolicy, and the
 * reaper billed whichever tenant the directory listing found first. So a
 * tenant whose name survives folding untouched keeps the bare label (every
 * pod on the cluster today is named that way), and any tenant the fold
 * CHANGED — a dot, an underscore, a capital, a name over 40 characters —
 * gets the folded prefix plus a short hash of the raw name. Two tenants
 * can share a prefix; they cannot share a hash of their exact names. The
 * hash also settles the trailing-dash trap: a 40+ character name used to
 * be trimmed and THEN cut, so it could end in `-`, and every run pod for
 * that account failed validation before it was ever scheduled. A bare name
 * that already ENDS like a hash (`-` and eight hex) is hashed as well, so a
 * bare label and a hashed one can never be the same string.
 */
const HASH_TAIL = /-[0-9a-f]{8}$/;

export function accountSegment(tenant: string): string | null {
  const seg = safeTenantSegment(tenant);
  if (!seg) return null;
  const folded = seg.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  // A bare name ending in a dash and eight hex (`acme-1a2b3c4d`) is the
  // shape of a hashed label below, so it is hashed too: otherwise a tenant
  // could sign up as exactly `acme-<hash("Acme")>` and get Acme's label.
  // Only such names change; every other bare label (and so every live pod,
  // Service and cache claim named from one) stays as it is.
  if (folded === seg && folded.length <= 40 && !HASH_TAIL.test(folded)) return folded || null;
  // Eight hex characters: 32 bits over the raw name. Not a security
  // boundary — a birthday among an install's tenants at 2^16 accounts is
  // the scale at which the prefix is different anyway.
  const hash = crypto.createHash("sha256").update(tenant).digest("hex").slice(0, 8);
  const prefix = folded.slice(0, 40 - hash.length - 1).replace(/-+$/g, "");
  const label = prefix ? `${prefix}-${hash}` : hash;
  return isLabelValue(label) ? label : null;
}

/** A Kubernetes label value and a DNS label at once: [a-z0-9], dashes
 *  inside, 63 characters at most. What every producer of the account
 *  label has to hand the cluster. */
export function isLabelValue(s: string): boolean {
  return /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(s);
}

/**
 * The tenant a pod's label belongs to, by EXACT segment. Never by
 * re-folding the label: a label is a one-way function of the tenant, and
 * the only correct inverse is to compute every tenant's segment and match.
 * Built once per pass (the map), because the reapers ask once per pod.
 */
export function segmentIndex(tenants: string[]): (seg: string) => string | null {
  const bySeg = new Map<string, string>();
  for (const t of tenants) {
    const seg = accountSegment(t);
    if (seg && !bySeg.has(seg)) bySeg.set(seg, t);
  }
  return (seg) => bySeg.get(seg) ?? null;
}

/** The pool's first pod keeps the bare name (the Service and both policies
 *  are named from it); the rest are numbered from 1. */
export const podName = (k: AccountPodKind, seg: string, index = 0) => (index ? `${k.app}-${seg}-${index}` : `${k.app}-${seg}`);
export const poolNames = (k: AccountPodKind, seg: string, n: number) => Array.from({ length: n }, (_, i) => podName(k, seg, i));
export const serviceHost = (k: AccountPodKind, seg: string) => `${podName(k, seg)}.${namespace()}.svc.cluster.local`;

export function serviceManifest(k: AccountPodKind, seg: string): object {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: podName(k, seg), namespace: namespace(), labels: { app: k.app, [ACCOUNT_LABEL]: seg } },
    spec: { selector: { app: k.app, [ACCOUNT_LABEL]: seg }, ports: [{ port: k.port, targetPort: k.port }] },
  };
}

/**
 * Two policies per account and kind. The first is the isolation: run pods
 * of this account may reach this account's pod on its port — and, because
 * the base run policy blocks all private space, nothing else in the
 * cluster. The second is the pod's own: reachable from this account's run
 * pods and nothing else, and out to the internet and DNS but never the
 * cluster, the LAN or the metadata endpoint — the same egress shape a run
 * pod has, because a browser or a search engine IS the thing that fetches
 * the world on the run's behalf.
 */
export function policyManifests(k: AccountPodKind, seg: string): object[] {
  const ns = namespace();
  const name = podName(k, seg);
  const dns = {
    to: [{ namespaceSelector: {}, podSelector: { matchLabels: { "k8s-app": "kube-dns" } } }],
    ports: [
      { protocol: "UDP", port: 53 },
      { protocol: "TCP", port: 53 },
    ],
  };
  // The account's run pods — less its test runs, for a kind they may not
  // reach. Both sides say so: the run pod's egress and the pod's ingress.
  const runs = {
    matchLabels: { app: RUN_APP, [ACCOUNT_LABEL]: seg },
    matchExpressions: [
      { key: NETWORK_LABEL, operator: "NotIn", values: ["filtered"] },
      ...(k.refusesTestRuns ? [{ key: TEST_RUN_LABEL, operator: "NotIn", values: ["true"] }] : []),
    ],
  };
  return [
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: `${name}-from-runs`, namespace: ns, labels: { app: k.app, [ACCOUNT_LABEL]: seg } },
      spec: {
        podSelector: runs,
        policyTypes: ["Egress"],
        egress: [
          {
            to: [{ podSelector: { matchLabels: { app: k.app, [ACCOUNT_LABEL]: seg } } }],
            ports: [{ protocol: "TCP", port: k.port }],
          },
        ],
      },
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name, namespace: ns, labels: { app: k.app, [ACCOUNT_LABEL]: seg } },
      spec: {
        podSelector: { matchLabels: { app: k.app, [ACCOUNT_LABEL]: seg } },
        policyTypes: ["Ingress", "Egress"],
        ingress: [
          {
            from: [{ podSelector: runs }],
            ports: [{ protocol: "TCP", port: k.port }],
          },
        ],
        egress: [
          {
            to: [
              {
                ipBlock: {
                  cidr: "0.0.0.0/0",
                  // 100.64/10: carrier-grade NAT, and some clusters' pod network.
                  except: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10"],
                },
              },
            ],
          },
          dns,
        ],
      },
    },
  ];
}

// stdout and stderr kept apart, deliberately: `kubectl get --no-headers`
// with nothing to show prints "No resources found" on stderr, and a reaper
// that read the two together took that sentence for a running pod and
// judged every account busy forever. `out` is stdout; `err` is for messages.
export function kc(args: string[], input?: string): Promise<{ status: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(kubectl(), args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (status) => resolve({ status, out, err }));
    child.on("error", (e) => resolve({ status: null, out: "", err: String(e) }));
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

// One ensure at a time per account and kind: two steps of the same run
// starting together must not both size the pool and both apply it. The
// ones that wait are DEMAND, though — a group of five steps calls this
// five times in the same millisecond, before any of them has a run pod —
// so each caller is counted while it is here, and the leader sizes for
// them and checks once more after its first pass for any that arrived
// during it.
const inflight = new Map<string, Promise<string | null>>();
/** The steps asking for a pool right now, by pool: each asker under an id —
 *  the run pod it will own when it names one, else a one-off id. */
const asking = new Map<string, Map<string, number>>();
let anonymous = 0;

/** The account's live run pods, by name: what the pool is sized for. Null
 *  when the query failed. */
async function activeRunPods(seg: string): Promise<Set<string> | null> {
  const res = await kc([
    "get", "pods", "-n", namespace(), "-l", `app=${RUN_APP},${ACCOUNT_LABEL}=${seg}`,
    "--field-selector=status.phase!=Succeeded,status.phase!=Failed", "-o", "name",
  ]);
  if (res.status !== 0) return null;
  return new Set(res.out.split("\n").map((l) => l.trim().replace(/^pod\//, "")).filter(Boolean));
}

/**
 * The URL a run pod of this account should use — creating the Service, the
 * policies and as many pods as the account's demand calls for, if they do
 * not exist, and waiting for the first to answer. Null when the tenant
 * cannot be named as a DNS label, or when the cluster would not give us a
 * pod inside two minutes: the caller decides what a step without the
 * service does, and says so in the log. Touches the last-used stamp on
 * every pod of the pool either way, so a busy account's pool is never
 * reaped from under it.
 *
 * The pool is sized for the run pods alive now PLUS the step asking, which
 * has no pod yet. It grows here and only here; it shrinks in the reaper,
 * to zero, when the account has been idle for the window. A pod deleted
 * while a browser call is mid-flight would cost that call, and an active
 * account's spare pod costs less than that, so nothing is trimmed while
 * anything runs.
 */
export async function ensureAccountPod(
  k: AccountPodKind,
  tenant: string,
  log: (line: string) => void = () => {},
  opts: { pod?: string } = {},
): Promise<string | null> {
  const seg = accountSegment(tenant);
  if (!seg) return null;
  const key = podName(k, seg);
  // A step that asks while its own run pod already exists (FOL-46 starts
  // both together) names that pod, so it is counted once, not as a live pod
  // AND an asker.
  const id = opts.pod ?? `?${++anonymous}`;
  const askers = asking.get(key) ?? new Map<string, number>();
  askers.set(id, (askers.get(id) ?? 0) + 1);
  asking.set(key, askers);
  try {
    const running = inflight.get(key);
    if (running) return await running;
    const p = ensurePool(k, seg, key, log).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return await p;
  } finally {
    const n = (askers.get(id) ?? 1) - 1;
    if (n > 0) askers.set(id, n);
    else askers.delete(id);
    if (!askers.size) asking.delete(key);
  }
}

/** The pods of the pool the cluster has, by name and phase. */
async function poolState(k: AccountPodKind, seg: string): Promise<Map<string, string>> {
  const have = new Map<string, string>();
  const listed = await kc([
    "get", "pods", "-n", namespace(), "-l", `app=${k.app},${ACCOUNT_LABEL}=${seg}`, "-o",
    `jsonpath={range .items[*]}{.metadata.name}{"\\t"}{.status.phase}{"\\n"}{end}`,
  ]);
  if (listed.status === 0) {
    for (const line of listed.out.split("\n")) {
      const [name, phase] = line.split("\t");
      if (name) have.set(name, phase ?? "");
    }
  }
  return have;
}

/** What the pool should be right now: the run pods alive plus every step
 *  asking for the pool at this moment (each is a step about to have one). */
async function poolWanted(k: AccountPodKind, seg: string, key: string): Promise<number> {
  const live = await activeRunPods(seg);
  // Askers are read AFTER the listing: a step that joined while it ran is
  // counted here, since its own pod may not be in the listing yet.
  const askers = [...(asking.get(key) ?? new Map<string, number>()).keys()];
  return podsWanted(stepsDemanding(live, askers), k.stepsPerPod(), k.maxPods());
}

/** How many steps a pool serves: the live run pods, plus each asker whose
 *  run pod is not among them yet — a step whose pod is live and which is
 *  also asking is one step. A listing that failed (null) reads as one step
 *  plus the askers, so a cluster that would not answer still gets its first
 *  pod and nothing more. Never below one: the step asking is demand. */
export function stepsDemanding(live: Set<string> | null, askers: string[]): number {
  const steps = live ? live.size + askers.filter((id) => !live.has(id)).length : 1 + askers.length;
  return Math.max(steps, 1);
}

/**
 * Apply what the pool is missing for `want` pods and wait for the first if
 * it was not there. Pods added for capacity join the Service when Ready and
 * are not waited on. Null only when the first pod cannot be had.
 */
async function growPool(k: AccountPodKind, seg: string, want: number, log: (line: string) => void): Promise<string | null> {
  const ns = namespace();
  const have = await poolState(k, seg);
  const names = poolNames(k, seg, want);
  // A pod in any state but Running (Pending after a node loss, Failed) is
  // replaced: delete what is there and apply fresh.
  const stale = names.filter((n) => have.has(n) && have.get(n) !== "Running");
  for (const n of stale) await kc(["delete", "pod", n, "-n", ns, "--ignore-not-found", "--wait=false"]);
  const missing = names.filter((n) => !have.has(n) || have.get(n) !== "Running");
  if (!missing.length) return k.url(seg);
  const t0 = Date.now();
  const objects = [
    ...(k.extraObjects?.() ?? []),
    ...missing.map((n) => stampPricing(k.podManifest(seg, new Date(), n), billing().priceSnapshot?.() ?? null)),
    serviceManifest(k, seg),
    ...policyManifests(k, seg),
  ];
  const applied = await kc(["apply", "-f", "-"], objects.map((o) => JSON.stringify(o)).join("\n---\n"));
  if (applied.status !== 0) {
    log(`${k.kind}: could not create ${missing.join(", ")}: ${(applied.err || applied.out).trim().split("\n").pop()}`);
    return null;
  }
  const first = names[0];
  if (missing.includes(first)) {
    const ready = await kc(["wait", "--for=condition=Ready", `pod/${first}`, "-n", ns, "--timeout=120s"]);
    if (ready.status !== 0) {
      log(`${k.kind}: ${first} never became ready: ${(ready.err || ready.out).trim().split("\n").pop()}`);
      return null;
    }
  }
  log(`${k.kind}: ${missing.join(", ")} up in ${((Date.now() - t0) / 1000).toFixed(1)}s` + (want > 1 ? ` (pool of ${want} for ${seg})` : ""));
  return k.url(seg);
}

async function ensurePool(k: AccountPodKind, seg: string, key: string, log: (line: string) => void): Promise<string | null> {
  const stamp = new Date().toISOString();
  let want = await poolWanted(k, seg, key);
  const url = await growPool(k, seg, want, log);
  if (!url) return null;
  // Steps that arrived while the pool grew are demand too — checked again
  // until it stops growing (bounded: the pool's cap ends it anyway).
  for (let pass = 0; pass < 4; pass++) {
    const again = await poolWanted(k, seg, key);
    if (again <= want) break;
    want = again;
    await growPool(k, seg, want, log);
  }
  // Only the pods this demand wants are stamped: a pod beyond it keeps its
  // old stamp and idles out on its own, which is how the pool shrinks
  // while the account is still active but quieter.
  for (const n of poolNames(k, seg, want)) await kc(["annotate", "pod", n, "-n", namespace(), `${LAST_USED}=${stamp}`, "--overwrite"]);
  return url;
}

export interface AccountPodInfo {
  name: string;
  seg: string;
  createdAt: string;
  lastUsed: string;
  /** The prices it was made under, or null. */
  pricing?: PriceSnapshot | null;
}

async function listAccountPods(k: AccountPodKind): Promise<AccountPodInfo[]> {
  const res = await kc([
    "get", "pods", "-n", namespace(), "-l", `app=${k.app}`, "-o",
    `jsonpath={range .items[*]}{.metadata.name}{"\\t"}{.metadata.labels.foldrun\\.io/account}{"\\t"}{.metadata.creationTimestamp}{"\\t"}{.metadata.annotations.foldrun\\.io/last-used}{"\\t"}{.metadata.annotations.foldrun\\.io/pricing}{"\\n"}{end}`,
  ]);
  if (res.status !== 0) return [];
  return res.out
    .split("\n")
    .map((l) => l.split("\t"))
    .filter((f) => f.length >= 3 && f[0])
    .map(([name, seg, createdAt, lastUsed, pricing]) => ({ name, seg, createdAt, lastUsed: lastUsed || createdAt, pricing: pricingOf(pricing) }));
}

/** Bytes both ways on the pod's interfaces, read from its own kernel books
 *  the way the run driver reads a step's. Null when the pod cannot answer. */
async function podNetBytes(name: string): Promise<number | null> {
  const res = await kc(["exec", name, "-n", namespace(), "--", "cat", "/proc/net/dev"]);
  if (res.status !== 0) return null;
  let total = 0;
  for (const line of res.out.split("\n")) {
    const m = line.match(/^\s*(\S+):\s*(.*)$/);
    if (!m || m[1] === "lo") continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    if (f.length >= 9) total += (f[0] || 0) + (f[8] || 0);
  }
  return total;
}

/**
 * Every account with a run pod alive right now, in ONE listing. A pod
 * between steps does not exist, so "no pod" is not "idle" — the last-used
 * stamp carries that; this is the guard against reaping under a step that
 * is mid-flight. Null when the cluster would not answer, which every
 * caller must read as "everyone is busy": never reap on a listing that
 * failed. The reaper used to ask this once per account pod; a pass over
 * forty pods was forty kubectl calls for one fact.
 */
export async function busyAccountSegments(): Promise<Set<string> | null> {
  const res = await kc([
    "get", "pods", "-n", namespace(), "-l", `app=${RUN_APP},${ACCOUNT_LABEL}`,
    "--field-selector=status.phase!=Succeeded,status.phase!=Failed", "-o",
    `jsonpath={range .items[*]}{.metadata.labels.foldrun\\.io/account}{"\\n"}{end}`,
  ]);
  if (res.status !== 0) return null;
  return new Set(res.out.split("\n").map((l) => l.trim()).filter(Boolean));
}

/**
 * Decide, from what the cluster says, which pods have gone idle. Pure, so
 * the rule is testable without a cluster: idle means last used longer ago
 * than the window AND no run pod of that account alive.
 */
export function idleAccountPods(pods: AccountPodInfo[], busy: Set<string>, now: number, idle: number): AccountPodInfo[] {
  return pods.filter((p) => !busy.has(p.seg) && now - Date.parse(p.lastUsed) > idle);
}

/**
 * Delete this kind's pods nobody has used for the idle window, and charge
 * each account for the pod it had: its lifetime at the small reservation,
 * and the bytes it moved. Fire-and-forget housekeeping for the scheduler
 * tick.
 */
export async function reapIdleAccountPods(
  k: AccountPodKind,
  tenantOf: (seg: string) => string | null = (s) => s,
  /** The run-pod listing, when the caller already has it for this pass;
   *  null means the cluster would not answer and nothing is reaped. */
  busySegs?: Set<string> | null,
): Promise<number> {
  if (!k.enabled()) return 0;
  const pods = await listAccountPods(k);
  if (!pods.length) return 0;
  const busy = busySegs === undefined ? await busyAccountSegments() : busySegs;
  // A listing that failed is "everyone is busy": never reap on a cluster
  // that would not answer.
  if (busy === null) return 0;
  let reaped = 0;
  const gone = new Set<string>();
  for (const p of idleAccountPods(pods, busy, Date.now(), k.idleMs())) {
    const netBytes = (await podNetBytes(p.name)) ?? 0;
    const secs = Math.max(1, (Date.now() - Date.parse(p.createdAt)) / 1000);
    await kc(["delete", "pod", p.name, "-n", namespace(), "--ignore-not-found", "--wait=false"]);
    const tenant = tenantOf(p.seg);
    // Every pod of the pool is its own ledger line: the account had that
    // many processes for that long, and the note says which. Keyed by the
    // pod and its start, so the same pass run twice — a lease handover, a
    // second pod's reaper — writes it once.
    if (tenant) await recordAccountPodSession(tenant, { kind: k.kind, podName: p.name, secs, netBytes, from: p.createdAt, small: k.small, pricing: p.pricing ?? null });
    gone.add(p.name);
    reaped++;
  }
  // The Service and the policies go once the account has no pod of this
  // kind left — read off the listing this pass already took, not asked
  // again per account; the next step recreates all three.
  const emptied = new Set<string>();
  for (const p of pods) if (gone.has(p.name)) emptied.add(p.seg);
  for (const p of pods) if (!gone.has(p.name)) emptied.delete(p.seg);
  for (const seg of emptied) await deleteShared(k, seg);
  return reaped;
}

async function deleteShared(k: AccountPodKind, seg: string): Promise<void> {
  const ns = namespace();
  const name = podName(k, seg);
  await kc(["delete", "service", name, "-n", ns, "--ignore-not-found", "--wait=false"]);
  await kc(["delete", "networkpolicy", name, `${name}-from-runs`, "-n", ns, "--ignore-not-found"]);
}

/** Everything this kind created for a tenant being deleted. Best effort:
 *  the pods hold nothing of theirs, but they are running processes with
 *  their name on them, and the reaper would otherwise bill a deleted
 *  account. */
export async function deleteAccountPod(k: AccountPodKind, tenant: string): Promise<void> {
  const seg = accountSegment(tenant);
  if (!seg) return;
  await kc(["delete", "pods", "-n", namespace(), "-l", `app=${k.app},${ACCOUNT_LABEL}=${seg}`, "--ignore-not-found", "--wait=false"]);
  await deleteShared(k, seg);
}
