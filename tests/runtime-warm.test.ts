// Environments built at deploy: which need building, the pod that builds one,
// and what the report says.
//
//   node --test tests/runtime-warm.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { behindWarms, janitorPodManifest, needsWarm, nextDisk, noteSharedUse, readWarmStatus, warmWorkspace, parseWarmOutput, sharedKeepList, warmPodManifest, warmPodSize, workspaceRuntimeReport, type WarmStatus } from "../src/runtime-warm.ts";
import { runPodManifest } from "../src/run-k8s.ts";
import { readLedger } from "../src/ledger.ts";
import { needsBilling } from "./needs-billing.ts";
import { fingerprint } from "../../foldrun-core/src/runtime.ts";
import { SHARED_RUNTIMES } from "../../foldrun-core/src/run-container.ts";

const status = (state: WarmStatus["state"], ageMs: number): WarmStatus => ({
  ok: state === "ready",
  state,
  error: state === "failed" ? "boom" : null,
  log: [],
  at: new Date(Date.now() - ageMs).toISOString(),
  workspace: "desk",
  agents: ["a"],
});

test("only runtimes that are new, failed, stale or abandoned are built", () => {
  const plan = ["new", "ready", "old", "failed", "busy", "stuck"].map((fingerprint) => ({ fingerprint }));
  const todo = needsWarm(plan, {
    ready: status("ready", 60_000),
    old: status("ready", 8 * 86_400_000),
    failed: status("failed", 60_000),
    busy: status("building", 60_000),
    stuck: status("building", 3 * 3_600_000),
  });
  assert.deepEqual(todo, ["new", "old", "failed", "stuck"]);
});

test("the pod's one JSON line is the result; anything else is the error", () => {
  assert.deepEqual(parseWarmOutput('noise\n{"log":["runtime x: cached"],"error":null}\n'), {
    log: ["runtime x: cached"],
    error: null,
  });
  assert.deepEqual(parseWarmOutput('{"log":[],"error":"uv pip install failed: nope"}'), {
    log: [],
    error: "uv pip install failed: nope",
  });
  assert.match(parseWarmOutput("Traceback: it broke").error ?? "", /it broke/);
  assert.equal(parseWarmOutput("").error, "the warm pod printed nothing");
});

test("the warm pod is a run pod — same labels, hardening and cache — that builds one spec and exits", () => {
  const prev = process.env.FOLDRUN_RUNTIME_CACHE_PVC;
  const prevShared = process.env.FOLDRUN_RUNTIME_SHARED_CACHE;
  process.env.FOLDRUN_RUNTIME_CACHE_PVC = "foldrun-runtimes";
  // The per-account mode; the shared layer's build pod has its own test below.
  process.env.FOLDRUN_RUNTIME_SHARED_CACHE = "0";
  try {
    const spec = { python: true, packages: ["openpyxl"], npm: [] };
    const pod = warmPodManifest("foldrun-warm-x", "reg/runner:slim", "acme", spec) as {
      metadata: { labels: Record<string, string> };
      spec: {
        activeDeadlineSeconds?: number;
        automountServiceAccountToken: boolean;
        containers: {
          image: string;
          command: string[];
          env: { name: string; value: string }[];
          volumeMounts?: { subPath: string }[];
          securityContext: { allowPrivilegeEscalation: boolean };
        }[];
      };
    };
    assert.equal(pod.metadata.labels.app, "foldrun-run", "the run network policy applies");
    assert.equal(pod.metadata.labels["foldrun.io/purpose"], "runtime-warm");
    assert.equal(pod.spec.automountServiceAccountToken, false);
    assert.ok(pod.spec.activeDeadlineSeconds, "the cluster reaps a wedged warm pod");
    const c = pod.spec.containers[0];
    assert.equal(c.image, "reg/runner:slim");
    assert.equal(c.securityContext.allowPrivilegeEscalation, false);
    assert.deepEqual(c.volumeMounts?.map((m) => m.subPath), ["acme"], "the account's own cache, nobody else's");
    assert.deepEqual(JSON.parse(c.env.find((e) => e.name === "FOLDRUN_WARM_SPEC")!.value), spec);
    assert.match(c.command[2], /runuser -u agent/, "built as the agent user, like a step");
    assert.match(c.command[2], /prepareRuntime\(process.argv\[2\]/);
    assert.match(c.command[2], /" runner$/, "the account's own cache, as a step would build it");
    assert.ok(!c.command[2].includes("openpyxl"), "the spec travels as data, never spliced into the shell");
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_RUNTIME_CACHE_PVC;
    else process.env.FOLDRUN_RUNTIME_CACHE_PVC = prev;
    if (prevShared === undefined) delete process.env.FOLDRUN_RUNTIME_SHARED_CACHE;
    else process.env.FOLDRUN_RUNTIME_SHARED_CACHE = prevShared;
  }
});

test("the report lists every runtime a workspace needs, pending until a warm records it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-warm-report-"));
  const prev = [process.env.FOLDRUN_DATA, process.env.FOLDRUN_RUN_ISOLATION];
  process.env.FOLDRUN_DATA = root;
  process.env.FOLDRUN_RUN_ISOLATION = "k8s";
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "tools/sheet"), { recursive: true });
    fs.mkdirSync(path.join(ws, "agents/compiler"), { recursive: true });
    fs.writeFileSync(path.join(ws, "tools/sheet/tool.md"), "---\ntransport: script\nname: sheet\nrun: run.py\ndescription: x\n---\n");
    fs.writeFileSync(path.join(ws, "tools/sheet/run.py"), "");
    fs.writeFileSync(path.join(ws, "tools/sheet/requirements.txt"), "openpyxl\n");
    fs.writeFileSync(path.join(ws, "agents/compiler/agent.md"), "---\nname: compiler\ntools: [sheet]\n---\nx\n");
    const [one] = workspaceRuntimeReport("acme", "desk");
    assert.deepEqual(one.packages, ["openpyxl"]);
    assert.deepEqual(one.agents, ["compiler"]);
    assert.equal(one.state, "pending");
    fs.writeFileSync(
      path.join(root, "acme/.runtime-status.json"),
      JSON.stringify({ [one.fingerprint]: { ...status("failed", 1000), error: "uv pip install failed: no such package" } }),
    );
    const [after] = workspaceRuntimeReport("acme", "desk");
    assert.equal(after.state, "failed");
    assert.match(after.error ?? "", /no such package/);
  } finally {
    const [d, i] = prev;
    if (d === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = d;
    if (i === undefined) delete process.env.FOLDRUN_RUN_ISOLATION;
    else process.env.FOLDRUN_RUN_ISOLATION = i;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- the shared layer ----------

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

type Mount = { mountPath: string; subPath: string; readOnly?: boolean };
type Ctr = { command: string[]; env?: { name: string; value: string }[]; volumeMounts?: Mount[] };

test("a run pod reads the shared layer and can never write it", () => {
  withEnv({ FOLDRUN_RUNTIME_CACHE_PVC: "foldrun-runtimes", FOLDRUN_RUNTIME_SHARED_CACHE: undefined }, () => {
    const pod = runPodManifest("foldrun-run-x", "img", undefined, undefined, undefined, "acme") as { spec: { containers: Ctr[] } };
    const c = pod.spec.containers[0];
    const shared = c.volumeMounts!.find((m) => m.mountPath === SHARED_RUNTIMES)!;
    assert.equal(shared.subPath, "_shared");
    assert.equal(shared.readOnly, true);
    assert.deepEqual(c.env, [{ name: "FOLDRUN_RUNTIME_SHARED", value: SHARED_RUNTIMES }]);
    const own = c.volumeMounts!.find((m) => m.subPath === "acme")!;
    assert.ok(!own.readOnly, "the account's own cache stays writable");
  });
  withEnv({ FOLDRUN_RUNTIME_CACHE_PVC: "foldrun-runtimes", FOLDRUN_RUNTIME_SHARED_CACHE: "0" }, () => {
    const pod = runPodManifest("foldrun-run-x", "img", undefined, undefined, undefined, "acme") as { spec: { containers: Ctr[] } };
    assert.deepEqual(pod.spec.containers[0].volumeMounts!.map((m) => m.subPath), ["acme"], "switched off: exactly as before");
  });
});

test("a shared-layer build pod can write its own entry and nothing else", () => {
  withEnv({ FOLDRUN_RUNTIME_CACHE_PVC: "foldrun-runtimes", FOLDRUN_RUNTIME_SHARED_CACHE: undefined }, () => {
    const spec = { packages: ["openpyxl"], npm: [] };
    const fp = fingerprint(spec);
    const pod = warmPodManifest("foldrun-warm-x", "img", "acme", spec) as { spec: { containers: Ctr[] } };
    const c = pod.spec.containers[0];
    assert.deepEqual(c.volumeMounts, [{ name: "runtime-cache", mountPath: `${SHARED_RUNTIMES}/${fp}`, subPath: `_shared/${fp}` }]);
    assert.match(c.command[2], /FOLDRUN_DATA=\/opt\/foldrun-runtimes/);
    assert.match(c.command[2], /FOLDRUN_RUNTIME_PYTHON_IN_ENTRY=1/);
    assert.match(c.command[2], /" shared$/);
    assert.ok(!c.env!.some((e) => e.name === "FOLDRUN_RUNTIME_SHARED"));
  });
});

test("the janitor mounts the whole layer and is told what to keep", () => {
  withEnv({ FOLDRUN_RUNTIME_CACHE_PVC: "foldrun-runtimes" }, () => {
    const pod = janitorPodManifest("foldrun-janitor-x", "img", ["aaaa", "bbbb"]) as {
      metadata: { labels: Record<string, string> };
      spec: { volumes: { persistentVolumeClaim: { claimName: string } }[]; containers: Ctr[] };
    };
    assert.equal(pod.spec.volumes[0].persistentVolumeClaim.claimName, "foldrun-runtimes");
    assert.deepEqual(pod.spec.containers[0].volumeMounts, [{ name: "runtime-cache", mountPath: SHARED_RUNTIMES, subPath: "_shared" }]);
    assert.deepEqual(JSON.parse(pod.spec.containers[0].env!.find((e) => e.name === "FOLDRUN_KEEP")!.value), ["aaaa", "bbbb"]);
    assert.equal(pod.metadata.labels["foldrun.io/purpose"], "runtime-janitor");
  });
});

test("what a step used, or a workspace built, recently is kept; old use is not", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-keep-"));
  withEnv({ FOLDRUN_DATA: root }, () => {
    try {
      fs.writeFileSync(
        path.join(root, ".runtime-shared-used.json"),
        JSON.stringify({ "1111111111111111": Date.now() - 86_400_000, "2222222222222222": Date.now() - 60 * 86_400_000 }),
      );
      fs.mkdirSync(path.join(root, "acme"));
      fs.writeFileSync(
        path.join(root, "acme/.runtime-status.json"),
        JSON.stringify({ "3333333333333333": status("ready", 1000), "4444444444444444": status("failed", 1000) }),
      );
      noteSharedUse("runtime: runtime 5555555555555555: shared");
      const keep = sharedKeepList().sort();
      assert.deepEqual(keep, ["1111111111111111", "3333333333333333", "5555555555555555"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test("one warm that throws does not stop the ones queued behind it", async () => {
  const ran: string[] = [];
  const errors: unknown[][] = [];
  const quiet = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    void behindWarms("first", async () => {
      ran.push("first");
      throw new Error("status file would not write");
    });
    await behindWarms("second", async () => {
      ran.push("second");
    });
  } finally {
    console.error = quiet;
  }
  assert.deepEqual(ran, ["first", "second"]);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /runtime_warm\.failed .*op=first/);
});

test("a warm pod for a runtime with system: installs them as root before the build drops to agent", async () => {
  const { parseRuntime } = await import("../../foldrun-core/src/runtime.ts");
  const spec = parseRuntime({ system: ["libcairo2-dev", "pkg-config"], packages: ["pycairo"] })!;
  const pod = warmPodManifest("foldrun-warm-s", "img", "acme", spec) as { spec: { containers: { command: string[]; env: { name: string; value: string }[] }[] } };
  const c = pod.spec.containers[0];
  assert.deepEqual(c.env.find((e) => e.name === "FOLDRUN_SYSTEM_PACKAGES"), { name: "FOLDRUN_SYSTEM_PACKAGES", value: "libcairo2-dev pkg-config" });
  const cmd = c.command[2];
  assert.ok(cmd.indexOf("apt-get") >= 0 && cmd.indexOf("apt-get") < cmd.indexOf("exec runuser -u agent"), "apt runs before the drop");
  const plain = warmPodManifest("foldrun-warm-p", "img", "acme", parseRuntime({ packages: ["requests"] })!) as { spec: { containers: { command: string[]; env: { name: string }[] }[] } };
  assert.ok(!plain.spec.containers[0].command[2].includes("apt-get"), "no system: no apt");
  assert.ok(!plain.spec.containers[0].env.some((e) => e.name === "FOLDRUN_SYSTEM_PACKAGES"));
});

// ---------------------------------------------------------------- billing (FOL-125, 8 Nov 2026)

test("the warm pod's result line carries the bytes it moved, and the parser reads them", () => {
  assert.deepEqual(parseWarmOutput('{"log":["runtime x: built"],"error":null,"netBytes":4096}'), { log: ["runtime x: built"], error: null, netBytes: 4096 });
  assert.equal("netBytes" in parseWarmOutput('{"log":[],"error":null,"netBytes":0}'), false, "zero says nothing");
  assert.equal("netBytes" in parseWarmOutput('{"log":[],"error":null}'), false, "an older pod's line has none");
});

test("the warm program counts its own network bytes and still runs inside single quotes", async () => {
  const { spawnSync } = await import("node:child_process");
  const spec = { python: true, packages: ["openpyxl"], npm: [] };
  const pod = warmPodManifest("foldrun-warm-x", "img", "acme", spec) as { spec: { containers: { command: string[] }[] } };
  const sh = pod.spec.containers[0]!.command[2]!;
  const m = /node -e '([\s\S]*)' "\$FOLDRUN_WARM_SPEC"/.exec(sh);
  assert.ok(m, "the program sits in one single-quoted argument");
  const js = m![1]!;
  assert.equal(js.includes("'"), false, "no single quote inside, or the shell would cut it");
  // Run it for real against a stand-in for core's runtime: the line it prints
  // must be JSON with a numeric netBytes (0 where /proc/net/dev is absent).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-warm-js-"));
  try {
    const pkg = path.join(dir, "node_modules/@foldrun/core");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@foldrun/core", type: "module", exports: { "./runtime": "./runtime.js" } }));
    fs.writeFileSync(path.join(pkg, "runtime.js"), 'export const prepareRuntime = () => ({ log: ["runtime x: built"], error: null });');
    const out = spawnSync(process.execPath, ["-e", js, "{}", "runner"], { cwd: dir, encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr);
    const line = JSON.parse(out.stdout.trim().split("\n").at(-1)!) as { log: string[]; error: unknown; netBytes: unknown };
    assert.deepEqual(line.log, ["runtime x: built"]);
    assert.equal(typeof line.netBytes, "number");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a warm pod is billed at the small class a small step is billed at", () => {
  const size = warmPodSize();
  assert.equal(size.vcpu, 1);
  assert.equal(size.memGiB, 1);
  assert.equal(size.diskGiB, 2);
});

test("a warm pod gets the disk of the biggest agent sharing the runtime, and is billed for it", async () => {
  const { parseRuntime } = await import("../../foldrun-core/src/runtime.ts");
  type Ctr = { resources: { limits: Record<string, string>; requests: Record<string, string> } };
  const spec = parseRuntime({ packages: ["manim"] })!;
  const heavy = (warmPodManifest("foldrun-warm-h", "img", "acme", spec, "20Gi") as { spec: { containers: Ctr[] } }).spec.containers[0];
  assert.equal(heavy.resources.limits["ephemeral-storage"], "20Gi");
  assert.equal(heavy.resources.limits.memory, (warmPodManifest("foldrun-warm-s", "img", "acme", spec) as { spec: { containers: Ctr[] } }).spec.containers[0].resources.limits.memory);
  assert.equal(warmPodSize("20Gi").diskGiB, 20);
  assert.equal(warmPodSize("20Gi").vcpu, 1);
  // Never below the small class.
  const tiny = (warmPodManifest("foldrun-warm-t", "img", "acme", spec, "1Gi") as { spec: { containers: Ctr[] } }).spec.containers[0];
  assert.equal(tiny.resources.limits["ephemeral-storage"], "2Gi");
  assert.equal(warmPodSize("1Gi").diskGiB, 2);
});

test("a warm build on a mounted cache only caps its disk: the request stays the small class's", async () => {
  const { parseRuntime } = await import("../../foldrun-core/src/runtime.ts");
  type Ctr = { resources: { limits: Record<string, string>; requests: Record<string, string> } };
  const c = (warmPodManifest("foldrun-warm-r", "img", "acme", parseRuntime({ packages: ["manim"] })!, "20Gi") as { spec: { containers: Ctr[] } }).spec.containers[0];
  assert.equal(c.resources.limits["ephemeral-storage"], "20Gi");
  assert.equal(c.resources.requests["ephemeral-storage"], "256Mi");
});

test("a failed warm is tried again only with more disk than the pod that failed had", () => {
  assert.equal(nextDisk(undefined, "2Gi"), null);
  assert.equal(nextDisk("20Gi", "8Gi"), "20Gi");
  assert.equal(nextDisk("8Gi", "8Gi"), null);
  assert.equal(nextDisk("4Gi", "8Gi"), null);
  // Both under the small-class floor: the same 2Gi pod, not a second attempt.
  assert.equal(nextDisk("2Gi", "1Gi"), null);
  assert.equal(nextDisk("1536Mi", "1Gi"), null);
});

test("a heavy agent's runtime is warmed at its disk; a pod never placed is a failed build", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-warm-disk-"));
  const applied = path.join(root, "applied.json");
  const fake = path.join(root, "kubectl");
  // apply: keep the manifest; the pod stays Pending, never scheduled, past the build's time.
  fs.writeFileSync(fake, `#!/bin/sh
case "$1" in
  apply) cat > "${applied}" ;;
  get) case "$*" in *jsonpath*) printf Pending ;; *) printf '{"status":{"conditions":[{"type":"PodScheduled","status":"False"}]}}' ;; esac ;;
esac
exit 0
`, { mode: 0o755 });
  const agentDir = path.join(root, "acme/workspaces/desk/agents/animator");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "agent.md"), "---\nname: animator\nsize: heavy\nruntime:\n  packages: [manim]\n---\nAnimate.\n");
  const keys = ["FOLDRUN_KUBECTL", "FOLDRUN_RUN_ISOLATION", "FOLDRUN_DATA", "FOLDRUN_RUNNER_IMAGE", "FOLDRUN_RUNTIME_WARM_MS"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { FOLDRUN_KUBECTL: fake, FOLDRUN_RUN_ISOLATION: "k8s", FOLDRUN_DATA: root, FOLDRUN_RUNNER_IMAGE: "reg/runner:1", FOLDRUN_RUNTIME_WARM_MS: "2500" });
  try {
    warmWorkspace("acme", "desk");
    await behindWarms("wait", async () => {});
    const pod = JSON.parse(fs.readFileSync(applied, "utf8")) as { spec: { containers: { resources: { limits: Record<string, string> } }[] } };
    assert.equal(pod.spec.containers[0]!.resources.limits["ephemeral-storage"], "20Gi");
    const status = Object.values(readWarmStatus("acme"));
    assert.equal(status.length, 1);
    assert.equal(status[0]!.state, "failed");
    assert.match(status[0]!.error ?? "", /did not finish/);
    assert.deepEqual(status[0]!.agents, ["animator"]);
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** One warm of a heavy agent against a fake kubectl: `phase` is what the pod
 *  reports, `placement` the pod JSON (or "fail" for a lookup that errors). */
async function warmOnce(phase: string, placement: string): Promise<{ root: string; done: () => void }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-warm-bill-"));
  const fake = path.join(root, "kubectl");
  const json = placement === "fail" ? "exit 1" : `printf '%s' '${placement}'`;
  fs.writeFileSync(fake, `#!/bin/sh
case "$1" in
  apply) cat > /dev/null ;;
  get) case "$*" in *jsonpath*) printf ${phase} ;; *) ${json} ;; esac ;;
esac
exit 0
`, { mode: 0o755 });
  const agentDir = path.join(root, "acme/workspaces/desk/agents/animator");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "agent.md"), "---\nname: animator\nsize: heavy\nruntime:\n  packages: [manim]\n---\nAnimate.\n");
  const keys = ["FOLDRUN_KUBECTL", "FOLDRUN_RUN_ISOLATION", "FOLDRUN_DATA", "FOLDRUN_RUNNER_IMAGE", "FOLDRUN_RUNTIME_WARM_MS", "FOLDRUN_BILLING", "FOLDRUN_COMPUTE_USD_PER_SEC", "FOLDRUN_COMPUTE_USD_PER_CORE_SEC", "FOLDRUN_COMPUTE_USD_PER_GIB_SEC", "FOLDRUN_REDIS_URL"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { FOLDRUN_KUBECTL: fake, FOLDRUN_RUN_ISOLATION: "k8s", FOLDRUN_DATA: root, FOLDRUN_RUNNER_IMAGE: "reg/runner:1", FOLDRUN_RUNTIME_WARM_MS: "2500", FOLDRUN_BILLING: "1", FOLDRUN_COMPUTE_USD_PER_SEC: "0.001", FOLDRUN_COMPUTE_USD_PER_CORE_SEC: "0.001", FOLDRUN_COMPUTE_USD_PER_GIB_SEC: "0.001" });
  delete process.env.FOLDRUN_REDIS_URL;
  warmWorkspace("acme", "desk");
  await behindWarms("wait", async () => {});
  return {
    root,
    done: () => {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("a warm pod is billed from when it was placed, at its disk; one never placed is not billed", { skip: needsBilling }, async () => {
  const at = new Date(Date.now() - 1000).toISOString();
  const ran = await warmOnce("Succeeded", `{"status":{"conditions":[{"type":"PodScheduled","status":"True","lastTransitionTime":"${at}"}]}}`);
  try {
    const lines = await readLedger("acme");
    assert.equal(lines.length, 1);
    assert.match(JSON.stringify(lines[0]), /"diskGiB":20/);
  } finally {
    ran.done();
  }
  // Seen past Pending but its placement unreadable: still billed, from when
  // it was seen — seconds, not the whole wait.
  const blind = await warmOnce("Succeeded", "fail");
  try {
    const lines = await readLedger("acme");
    assert.equal(lines.length, 1);
    assert.ok((lines[0]!.meter?.computeSecs ?? 99) < 5, `billed ${lines[0]!.meter?.computeSecs}s`);
  } finally {
    blind.done();
  }
  const never = await warmOnce("Pending", '{"status":{"conditions":[{"type":"PodScheduled","status":"False"}]}}');
  try {
    assert.equal((await readLedger("acme")).length, 0);
  } finally {
    never.done();
  }
});
