// Build a workspace's environments when it is deployed, not when a step needs
// them.
//
// A step builds its own runtime inside its pod the first time it meets a new
// declaration (core's runtime.ts). That works, and it has two costs: the
// first scheduled step after a change waits for the install, and a package
// that will not install is found by that step, at 3am, as a failed run. So a
// deployed workspace is warmed: the worker's scheduler already hears about
// every changed workspace (markScheduleDirty, through Redis from whichever
// pod took the write), and for each one it works out the distinct runtimes
// its agents need (core's workspaceRuntimePlan — the same function the runner
// builds from) and builds any it has not built, in a short pod that mounts
// the account's runtime cache and exits.
//
// The result is written to <data>/<tenant>/.runtime-status.json, keyed by
// fingerprint, which the web tier reads for GET /api/workspaces/<ws>/runtimes
// and `foldrun deploy` prints. A warm that fails fails nothing else: the step
// would have hit the same error, later and worse.
//
//   FOLDRUN_RUNTIME_WARM=0     turn it off (on by default under k8s isolation)
//   FOLDRUN_RUNTIME_WARM_MS    the most one build may take (10 min)

import fs from "node:fs";
import path from "node:path";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { workspaceRuntimePlan } from "../../foldrun-core/src/runner.ts";
import { fingerprint, systemInstallSh, type RuntimeSpec } from "../../foldrun-core/src/runtime.ts";
import { RUNTIME_CACHE } from "../../foldrun-core/src/run-container.ts";
import { SHARED_RUNTIMES } from "../../foldrun-core/src/run-container.ts";
import { kc, namespace } from "./account-pod.ts";
import { runPodManifest, runnerImageFor, sharedLayerEnabled, SHARED_SUBPATH } from "./run-k8s.ts";

export interface WarmStatus {
  ok: boolean;
  /** "ready" once built, "failed" with an error, "building" while a pod works. */
  state: "ready" | "failed" | "building";
  error: string | null;
  log: string[];
  at: string;
  workspace: string;
  agents: string[];
}

export function warmEnabled(): boolean {
  return process.env.FOLDRUN_RUN_ISOLATION === "k8s" && process.env.FOLDRUN_RUNTIME_WARM !== "0";
}

const statusFile = (tenant: string) => path.join(dataRoot(), tenant, ".runtime-status.json");

export function readWarmStatus(tenant: string): Record<string, WarmStatus> {
  try {
    return JSON.parse(fs.readFileSync(statusFile(tenant), "utf8")) as Record<string, WarmStatus>;
  } catch {
    return {};
  }
}

function writeWarmStatus(tenant: string, fp: string, status: WarmStatus): void {
  // Read-modify-write under one process: the queue below builds one at a
  // time, and only the worker writes this file.
  const all = readWarmStatus(tenant);
  all[fp] = status;
  const file = statusFile(tenant);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, file);
}

/** How long a "ready" is believed before the next change re-checks it. The
 *  cache prunes entries unused for 30 days, so an old ready may be gone. */
const READY_TRUST_MS = 7 * 86_400_000;

/** Which of a workspace's runtimes still need building. */
export function needsWarm(
  plan: { fingerprint: string }[],
  status: Record<string, WarmStatus>,
  now = Date.now(),
): string[] {
  return plan
    .filter((p) => {
      const s = status[p.fingerprint];
      if (!s) return true;
      // One is on it — unless it has been "building" for longer than any
      // build may take, which is a worker that restarted mid-build.
      if (s.state === "building") return now - Date.parse(s.at) > 2 * warmMs();
      if (s.state === "failed") return true; // a change is the moment to try again
      return now - Date.parse(s.at) > READY_TRUST_MS;
    })
    .map((p) => p.fingerprint);
}

// The program the warm pod runs, as the agent user, beside the mounted cache:
// build the spec (or find it built) and print one JSON line saying how it went.
const WARM_JS =
  'import("@foldrun/core/runtime").then((m) => {' +
  " const r = m.prepareRuntime(process.argv[2] || \"runner\", JSON.parse(process.argv[1]));" +
  " console.log(JSON.stringify({ log: r.log, error: r.error }));" +
  " process.exit(r.error ? 1 : 0);" +
  " }).catch((e) => { console.log(JSON.stringify({ log: [], error: String(e) })); process.exit(1); });";

type PodShape = {
  metadata: { labels: Record<string, string> };
  spec: {
    containers: {
      command: string[];
      env?: { name: string; value: string }[];
      volumeMounts?: { name: string; mountPath: string; subPath: string; readOnly?: boolean }[];
    }[];
  };
};

/**
 * The warm pod: a run pod in every respect that matters — same namespace,
 * labels (so the same network policy), hardening and RuntimeClass — with a
 * command that builds one runtime and exits.
 *
 * With the shared layer on, it builds into the platform's shared layer and
 * can write ONE entry of it: the claim's `_shared/<fingerprint>`, nothing
 * else. A package's own install script runs in here (an sdist's setup.py),
 * and it must never be able to reach another environment that other accounts
 * will execute. Only an account that declares exactly this set of packages
 * ever runs what it built — and that account asked for the same code. Off,
 * it builds into the account's own cache, as a step would.
 */
export function warmPodManifest(name: string, image: string, tenant: string, spec: RuntimeSpec): object {
  const pod = runPodManifest(name, image, undefined, "small", Math.ceil(warmMs() / 1000) + 60, tenant) as PodShape;
  pod.metadata.labels["foldrun.io/purpose"] = "runtime-warm";
  const c = pod.spec.containers[0];
  const shared = sharedLayerEnabled() && (c.volumeMounts?.length ?? 0) > 0;
  const fp = fingerprint(spec);
  c.env = [
    { name: "FOLDRUN_WARM_SPEC", value: JSON.stringify(spec) },
    // runtime: system: first, as root — a pip package that compiles against
    // a library (pycairo against libcairo2-dev) must find it at warm time too.
    ...(spec.system?.length ? [{ name: "FOLDRUN_SYSTEM_PACKAGES", value: spec.system.join(" ") }] : []),
  ];
  const sys = spec.system?.length ? `${systemInstallSh(RUNTIME_CACHE, "/tmp")}; ` : "";
  if (shared) {
    const entry = `${SHARED_RUNTIMES}/${fp}`;
    c.volumeMounts = [{ name: "runtime-cache", mountPath: entry, subPath: `${SHARED_SUBPATH}/${fp}` }];
    c.command = [
      "sh",
      "-c",
      sys + `chown agent:agent ${entry} 2>/dev/null || true; ` +
        "cd /opt/runner && exec runuser -u agent -- env FOLDRUN_DATA=/opt/foldrun-runtimes FOLDRUN_RUNTIME_PYTHON_IN_ENTRY=1 node -e '" +
        WARM_JS +
        "' \"$FOLDRUN_WARM_SPEC\" shared",
    ];
  } else {
    c.command = [
      "sh",
      "-c",
      sys + "chown agent:agent /home/agent/.foldrun/runner/.runtimes 2>/dev/null || true; " +
        "cd /opt/runner && exec runuser -u agent -- env FOLDRUN_DATA=/home/agent/.foldrun node -e '" +
        WARM_JS +
        "' \"$FOLDRUN_WARM_SPEC\" runner",
    ];
  }
  return pod;
}

// ---------------------------------------------------------------- the shared layer's upkeep

const usedFile = () => path.join(dataRoot(), ".runtime-shared-used.json");
const used = new Map<string, number>();
let usedFlushed = 0;

/**
 * A step reported "runtime <fp>: shared". The run pod cannot touch the entry
 * (its mount is read-only), so the worker keeps the last-used clock instead,
 * flushed at most once a minute; the janitor below keeps what was used.
 */
export function noteSharedUse(line: string): void {
  const m = /runtime ([0-9a-f]{16}): shared/.exec(line);
  if (!m) return;
  used.set(m[1], Date.now());
  if (Date.now() - usedFlushed < 60_000) return;
  usedFlushed = Date.now();
  try {
    const all = readUsed();
    for (const [fp, at] of used) all[fp] = Math.max(all[fp] ?? 0, at);
    fs.writeFileSync(`${usedFile()}.tmp`, JSON.stringify(all));
    fs.renameSync(`${usedFile()}.tmp`, usedFile());
  } catch {
    // a lost clock only means an entry may be rebuilt a little sooner
  }
}

function readUsed(): Record<string, number> {
  try {
    return JSON.parse(fs.readFileSync(usedFile(), "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

const maxAgeDays = () => {
  const raw = Number(process.env.FOLDRUN_RUNTIME_MAX_AGE_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
};

/** Every shared entry to keep: used by a step, or built for a workspace, within the max age. */
export function sharedKeepList(now = Date.now()): string[] {
  const cutoff = now - maxAgeDays() * 86_400_000;
  const keep = new Set<string>();
  for (const [fp, at] of Object.entries(readUsed())) if (at >= cutoff) keep.add(fp);
  for (const [fp, at] of used) if (at >= cutoff) keep.add(fp);
  let tenants: string[] = [];
  try {
    tenants = fs.readdirSync(dataRoot()).filter((n) => !n.startsWith("."));
  } catch {
    tenants = [];
  }
  for (const tenant of tenants) {
    for (const [fp, s] of Object.entries(readWarmStatus(tenant))) {
      if (s.state !== "failed" && Date.parse(s.at) >= cutoff) keep.add(fp);
    }
  }
  return [...keep];
}

// Trusted code only: it deletes, it installs nothing. Entries on the keep
// list, entries being built, and the layer's own dot-directories are left.
const JANITOR_JS =
  'const fs = require("fs"), path = require("path");' +
  " const root = process.argv[1], keep = new Set(JSON.parse(process.argv[2])), cutoff = Date.now() - Number(process.argv[3]) * 86400000;" +
  " const removed = [];" +
  " for (const n of fs.readdirSync(root)) {" +
  '  if (n.startsWith(".") || keep.has(n)) continue;' +
  "  const d = path.join(root, n);" +
  "  try {" +
  '   if (fs.existsSync(path.join(d, ".building"))) continue;' +
  '   const clock = fs.existsSync(path.join(d, ".ready")) ? fs.statSync(path.join(d, ".ready")).mtimeMs : fs.statSync(d).mtimeMs;' +
  "   if (clock < cutoff) { fs.rmSync(d, { recursive: true, force: true }); removed.push(n); }" +
  "  } catch {}" +
  " }" +
  " console.log(JSON.stringify({ removed }));";

export function janitorPodManifest(name: string, image: string, keep: string[]): object {
  const pod = runPodManifest(name, image, undefined, "small", 600, undefined) as PodShape & {
    spec: { volumes?: unknown[] };
  };
  pod.metadata.labels["foldrun.io/purpose"] = "runtime-janitor";
  // No tenant, so runPodManifest mounted nothing: this pod mounts the whole
  // shared layer, read-write — it is the only thing that ever deletes from it.
  pod.spec.volumes = [{ name: "runtime-cache", persistentVolumeClaim: { claimName: process.env.FOLDRUN_RUNTIME_CACHE_PVC } }];
  const c = pod.spec.containers[0];
  c.volumeMounts = [{ name: "runtime-cache", mountPath: SHARED_RUNTIMES, subPath: SHARED_SUBPATH }];
  c.env = [{ name: "FOLDRUN_KEEP", value: JSON.stringify(keep) }];
  c.command = [
    "sh",
    "-c",
    `cd /opt/runner && exec runuser -u agent -- node -e '${JANITOR_JS}' ${SHARED_RUNTIMES} "$FOLDRUN_KEEP" ${maxAgeDays()}`,
  ];
  return pod;
}

let lastJanitor = 0;

/** Prune the shared layer, at most once a day, behind the warm queue. */
export function maybeRunJanitor(now = Date.now()): void {
  if (!warmEnabled() || !sharedLayerEnabled() || now - lastJanitor < 86_400_000) return;
  lastJanitor = now;
  void behindWarms("shared layer janitor", async () => {
    const { image } = runnerImageFor([], {});
    if (!image) return;
    const ns = namespace();
    const name = `foldrun-janitor-${Date.now().toString(36)}`;
    const applied = await kc(["apply", "-f", "-"], JSON.stringify(janitorPodManifest(name, image, sharedKeepList(now))));
    if (applied.status !== 0) return;
    try {
      const until = Date.now() + 10 * 60_000;
      while (Date.now() < until) {
        const phase = (await kc(["get", "pod", name, "-n", ns, "-o", "jsonpath={.status.phase}"])).out.trim();
        if (phase === "Succeeded" || phase === "Failed") break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      const logs = await kc(["logs", name, "-n", ns]);
      console.log(`[runtime-warm] shared layer janitor: ${logs.out.trim().split("\n").at(-1) ?? ""}`);
    } finally {
      await kc(["delete", "pod", name, "-n", ns, "--wait=false", "--ignore-not-found"]);
    }
  });
}

function warmMs(): number {
  const raw = Number(process.env.FOLDRUN_RUNTIME_WARM_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60_000;
}

/** Read the pod's one JSON line; anything else is the error. */
export function parseWarmOutput(out: string): { log: string[]; error: string | null } {
  for (const line of out.trim().split("\n").reverse()) {
    try {
      const v = JSON.parse(line) as { log?: unknown; error?: unknown };
      if (v && Array.isArray(v.log)) return { log: v.log.map(String), error: v.error ? String(v.error) : null };
    } catch {
      // not the result line
    }
  }
  return { log: [], error: out.trim().slice(-500) || "the warm pod printed nothing" };
}

async function buildOne(tenant: string, spec: RuntimeSpec): Promise<{ log: string[]; error: string | null }> {
  // Slim when there is one: warming never browses, and it is the image most
  // steps that use this runtime will run on anyway.
  const { image } = runnerImageFor([], {});
  if (!image) return { log: [], error: "no runner image configured (FOLDRUN_RUNNER_IMAGE)" };
  const ns = namespace();
  const name = `foldrun-warm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const applied = await kc(["apply", "-f", "-"], JSON.stringify(warmPodManifest(name, image, tenant, spec)));
  if (applied.status !== 0) return { log: [], error: `warm pod create failed: ${(applied.err || applied.out).slice(0, 300)}` };
  try {
    const until = Date.now() + warmMs();
    let phase = "";
    while (Date.now() < until) {
      const got = await kc(["get", "pod", name, "-n", ns, "-o", "jsonpath={.status.phase}"]);
      phase = got.out.trim();
      if (phase === "Succeeded" || phase === "Failed") break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    const logs = await kc(["logs", name, "-n", ns]);
    const result = parseWarmOutput(logs.out);
    if (phase !== "Succeeded" && phase !== "Failed") {
      return { log: result.log, error: `the build did not finish in ${Math.round(warmMs() / 60000)} minutes (pod ${phase || "unknown"})` };
    }
    return result;
  } finally {
    await kc(["delete", "pod", name, "-n", ns, "--wait=false", "--ignore-not-found"]);
  }
}

// One build at a time per worker: warming is background work and must never
// crowd out the steps it exists to speed up.
let chain: Promise<void> = Promise.resolve();
const queued = new Set<string>();

/**
 * Put a task at the back of the line. The catch is what keeps the line
 * going: a bare `chain.then(task)` that rejected — a status file that would
 * not write, kubectl not there — left `chain` rejected, and every warm and
 * janitor queued after it was skipped until the process restarted.
 * Returns the chain for a caller (a test) that wants to wait on it.
 */
export function behindWarms(label: string, task: () => Promise<void>): Promise<void> {
  chain = chain.then(task).catch((err) => {
    console.error(`[runtime-warm] ${label}:`, err instanceof Error ? err.message : err);
  });
  return chain;
}

/**
 * A workspace changed: build whatever runtimes it needs that are not built.
 * Called from the scheduler for every workspace marked dirty. Returns at
 * once; the builds run behind it, one at a time.
 */
export function warmWorkspace(tenant: string, workspace: string): void {
  if (!warmEnabled()) return;
  let plan: ReturnType<typeof workspaceRuntimePlan>;
  try {
    plan = workspaceRuntimePlan(tenant, workspace);
  } catch (err) {
    console.warn(`[runtime-warm] ${tenant}/${workspace}: plan failed:`, err instanceof Error ? err.message : err);
    return;
  }
  const todo = new Set(needsWarm(plan, readWarmStatus(tenant)));
  for (const entry of plan) {
    const key = `${tenant}\t${entry.fingerprint}`;
    if (!todo.has(entry.fingerprint) || queued.has(key)) continue;
    queued.add(key);
    const base = { workspace, agents: entry.agents, log: [] as string[] };
    writeWarmStatus(tenant, entry.fingerprint, { ...base, ok: false, state: "building", error: null, at: new Date().toISOString() });
    void behindWarms(`${tenant}/${workspace} ${entry.fingerprint}`, async () => {
      try {
        const r = await buildOne(tenant, entry.spec);
        writeWarmStatus(tenant, entry.fingerprint, {
          ...base,
          ok: !r.error,
          state: r.error ? "failed" : "ready",
          error: r.error,
          log: r.log,
          at: new Date().toISOString(),
        });
        console.log(`[runtime-warm] ${tenant}/${workspace} ${entry.fingerprint}: ${r.error ? `FAILED ${r.error}` : "ready"}`);
      } catch (err) {
        writeWarmStatus(tenant, entry.fingerprint, {
          ...base,
          ok: false,
          state: "failed",
          error: err instanceof Error ? err.message : String(err),
          at: new Date().toISOString(),
        });
      } finally {
        queued.delete(key);
      }
    });
  }
}

/**
 * What a workspace's runtimes look like right now, for the API and the CLI:
 * every runtime its agents need, with the last warm's outcome, or "pending"
 * when none has been recorded yet.
 */
export function workspaceRuntimeReport(tenant: string, workspace: string) {
  const status = readWarmStatus(tenant);
  return workspaceRuntimePlan(tenant, workspace).map((p) => {
    const s = status[p.fingerprint];
    return {
      fingerprint: p.fingerprint,
      agents: p.agents,
      python: p.spec.python ?? null,
      packages: p.spec.packages,
      npm: p.spec.npm,
      system: p.spec.system ?? [],
      rejected: p.spec.rejected ?? [],
      state: s ? s.state : warmEnabled() ? "pending" : "on first run",
      error: s?.error ?? null,
      at: s?.at ?? null,
    };
  });
}
