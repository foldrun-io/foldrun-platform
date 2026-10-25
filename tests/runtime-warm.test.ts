// Environments built at deploy: which need building, the pod that builds one,
// and what the report says.
//
//   node --test tests/runtime-warm.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { behindWarms, janitorPodManifest, needsWarm, noteSharedUse, parseWarmOutput, sharedKeepList, warmPodManifest, workspaceRuntimeReport, type WarmStatus } from "../src/runtime-warm.ts";
import { runPodManifest } from "../src/run-k8s.ts";
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
  assert.match(String(errors[0][0]), /\[runtime-warm\] first/);
});

test("a warm pod for a runtime with system: installs them as root before the build drops to agent", async () => {
  const { parseRuntime } = await import("../../foldrun-core/src/runtime.ts");
  const spec = parseRuntime({ system: ["libcairo2-dev", "pkg-config"], packages: ["pycairo"] })!;
  const pod = warmPodManifest("foldrun-warm-s", "img", "acme", spec) as { spec: { containers: { command: string[]; env: { name: string; value: string }[] }[] } };
  const c = pod.spec.containers[0];
  assert.deepEqual(c.env.find((e) => e.name === "FOLDRUN_SYSTEM_PACKAGES"), { name: "FOLDRUN_SYSTEM_PACKAGES", value: "libcairo2-dev pkg-config" });
  const cmd = c.command[2];
  assert.ok(cmd.indexOf("apt-get") >= 0 && cmd.indexOf("apt-get") < cmd.indexOf("runuser -u agent"), "apt runs before the drop");
  const plain = warmPodManifest("foldrun-warm-p", "img", "acme", parseRuntime({ packages: ["requests"] })!) as { spec: { containers: { command: string[]; env: { name: string }[] }[] } };
  assert.ok(!plain.spec.containers[0].command[2].includes("apt-get"), "no system: no apt");
  assert.ok(!plain.spec.containers[0].env.some((e) => e.name === "FOLDRUN_SYSTEM_PACKAGES"));
});
