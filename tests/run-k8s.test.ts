// The k8s executor's pure parts: the pod it would create, and the env file
// the shim will source. The cluster-shaped rest lives in tests/k8s-e2e.test.ts.
//
//   node --test tests/run-k8s.test.ts

import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { runPodManifest, accountCachePvcManifest, envFileShell, accountServiceEnv, runnerImageFor, grantsBrowsing, stagedScriptSource, policyFloorMs, gateGoOnSearch, SEARCH_UNAVAILABLE, runStepInK8s, billedTotalMs, cpuMillis, cappedCpuRequest } from "../src/run-k8s.ts";
import { accountSegment, policyManifests } from "../src/account-pod.ts";
import { SEARCH, searchPodManifest } from "../src/search-k8s.ts";
import { k8sMemory } from "../../foldrun-core/src/run-container.ts";

test("the pod carries the same hardening as the docker flags", () => {
  const pod = runPodManifest("foldrun-run-x", "foldrun-runner:abc") as {
    metadata: { labels: Record<string, string>; namespace: string };
    spec: {
      restartPolicy: string;
      runtimeClassName?: string;
      containers: {
        securityContext: {
          runAsUser: number;
          allowPrivilegeEscalation: boolean;
          capabilities: { drop: string[]; add: string[] };
        };
      }[];
    };
  };
  assert.equal(pod.spec.restartPolicy, "Never");
  assert.equal(pod.metadata.labels.app, "foldrun-run", "the NetworkPolicy selector");
  const sc = pod.spec.containers[0].securityContext;
  assert.deepEqual(sc.capabilities.drop, ["ALL"]);
  // DAC_OVERRIDE and FOWNER are the extras over the docker flags — kubectl cp execs
  // tar inside the pod, where capless root cannot write agent-owned trees.
  assert.deepEqual(sc.capabilities.add, ["CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE", "FOWNER"]);
  assert.equal(sc.allowPrivilegeEscalation, false);
});

test("a RuntimeClass rides in from the same env var docker uses", () => {
  const previous = process.env.FOLDRUN_RUNNER_RUNTIME;
  process.env.FOLDRUN_RUNNER_RUNTIME = "gvisor";
  try {
    const pod = runPodManifest("x", "img") as { spec: { runtimeClassName?: string } };
    assert.equal(pod.spec.runtimeClassName, "gvisor");
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_RUNNER_RUNTIME;
    else process.env.FOLDRUN_RUNNER_RUNTIME = previous;
  }
});

test("the env file survives shell metacharacters — quoting is load-bearing", () => {
  const file = envFileShell({
    PLAIN: "value",
    SPACED: "two words",
    QUOTED: "it's got 'quotes' and $HOME and `backticks`",
    "bad-name": "dropped, not exported",
  });
  assert.match(file, /^export PLAIN='value'$/m);
  assert.match(file, /^export SPACED='two words'$/m);
  assert.ok(!file.includes("bad-name"));
  // The single-quote escape: 'it'\''s ...' — the dangerous characters stay
  // inert inside single quotes, and embedded quotes hop out and back in.
  assert.ok(file.includes(`'it'\\''s got '\\''quotes'\\'' and $HOME and \`backticks\`'`));
});

test("a pod is capped at the cores and memory its class is billed for", () => {
  process.env.FOLDRUN_RUNNER_MEMORY = "6Gi";
  process.env.FOLDRUN_RUNNER_CPUS = "3";
  try {
    type Manifest = {
      spec: {
        containers: {
          resources: { requests?: { cpu?: string; memory?: string; "ephemeral-storage"?: string }; limits: { memory: string; cpu?: string; "ephemeral-storage"?: string } }[];
        }[];
      };
    };
    const res = (m: Manifest) => m.spec.containers[0].resources;

    const large = runPodManifest("p1", "img", "run-x") as Manifest;
    // The CPU limit is the class's billed cores: a step never runs on more
    // than it pays for, and never takes the whole node. Memory and disk are
    // hard ceilings too.
    assert.deepEqual(res(large).limits, { cpu: "3", memory: "6Gi", "ephemeral-storage": "8Gi" });
    // The request scales with the class: each pod's share when the node is busy.
    assert.equal(res(large).requests?.cpu, "250m");
    assert.equal(res(large).requests?.["ephemeral-storage"], "512Mi");
    // No memory request: Kubernetes reserves the whole limit, which is what
    // the room gate (pod-room.ts) counts.
    assert.equal(res(large).requests?.memory, undefined);

    const small = runPodManifest("p2", "img", "run-x", "small") as Manifest;
    assert.deepEqual(res(small).limits, { cpu: "1", memory: "1Gi", "ephemeral-storage": "2Gi" });
    assert.equal(res(small).requests?.cpu, "100m", "small packs exactly as before limits");

    const heavy = runPodManifest("p3", "img", "run-x", "heavy") as Manifest;
    assert.deepEqual(res(heavy).limits, { cpu: "4", memory: "8Gi", "ephemeral-storage": "20Gi" });
    assert.equal(res(heavy).requests?.cpu, "500m");

    // A pod carries a k8s-native deadline only when the step set a
    // `timeout:` — the platform has no default of its own, so a step that
    // names no limit runs until it finishes. Orphans (platform restarted
    // mid-run, shim spinning on a `go` that never comes) are reaped by boot
    // recovery killing the run's pods, not by a clock nobody chose.
    type WithDeadline = { spec: { activeDeadlineSeconds?: number } };
    assert.equal((large as unknown as WithDeadline).spec.activeDeadlineSeconds, undefined, "no timeout, no deadline");
    const custom = runPodManifest("p4", "img", "run-x", "large", 900) as unknown as WithDeadline;
    assert.equal(custom.spec.activeDeadlineSeconds, 900);
  } finally {
    delete process.env.FOLDRUN_RUNNER_MEMORY;
    delete process.env.FOLDRUN_RUNNER_CPUS;
  }
});

test("a CPU request is never above its limit, however an install tunes them", () => {
  assert.equal(cpuMillis("250m"), 250);
  assert.equal(cpuMillis("2"), 2000);
  assert.equal(cpuMillis("0.5"), 500);
  assert.ok(Number.isNaN(cpuMillis("fast")));
  assert.equal(cappedCpuRequest("250m", "3"), "250m");
  assert.equal(cappedCpuRequest("250m", "100m"), "100m", "a limit tuned below the request wins");
  assert.equal(cappedCpuRequest("junk", "1"), "junk", "an unreadable value is the cluster's to refuse");
  process.env.FOLDRUN_RUNNER_CPUS_SMALL = "0.05";
  try {
    const pod = runPodManifest("p", "img", "run-x", "small") as { spec: { containers: { resources: { requests: { cpu: string }; limits: { cpu: string } } }[] } };
    assert.equal(pod.spec.containers[0].resources.limits.cpu, "0.05");
    assert.equal(pod.spec.containers[0].resources.requests.cpu, "0.05");
  } finally {
    delete process.env.FOLDRUN_RUNNER_CPUS_SMALL;
  }
});

// ---------- the dependency cache ----------
//
// The volume that turns the runner's runtime cache from "rebuilt every step"
// into "built once per account". Two properties matter more than the mount
// itself: it is absent unless configured (a claim name pointing at nothing
// leaves every run pod Pending, which is worse than a slow one), and the
// subPath that separates tenants can never be talked into leaving its parent.

function withCachePvc<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.FOLDRUN_RUNTIME_CACHE_PVC;
  if (value === undefined) delete process.env.FOLDRUN_RUNTIME_CACHE_PVC;
  else process.env.FOLDRUN_RUNTIME_CACHE_PVC = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_RUNTIME_CACHE_PVC;
    else process.env.FOLDRUN_RUNTIME_CACHE_PVC = previous;
  }
}

type Pod = {
  spec: {
    volumes?: { name: string; persistentVolumeClaim: { claimName: string } }[];
    containers: {
      volumeMounts?: { name: string; mountPath: string; subPath: string }[];
    }[];
  };
};

test("no claim configured, no volume — the pod is exactly what it was before", () => {
  withCachePvc(undefined, () => {
    const pod = runPodManifest("x", "img", "run1", "small", 600, "acct-1") as Pod;
    assert.equal(pod.spec.volumes, undefined);
    assert.equal(pod.spec.containers[0].volumeMounts, undefined);
  });
});

test("with a claim, the tenant's cache mounts by subPath", () => {
  withCachePvc("foldrun-runtimes", () => {
    const pod = runPodManifest("x", "img", "run1", "small", 600, "acct-1") as Pod;
    assert.deepEqual(pod.spec.volumes, [
      { name: "runtime-cache", persistentVolumeClaim: { claimName: "foldrun-runtimes" } },
    ]);
    const mount = pod.spec.containers[0].volumeMounts?.[0];
    assert.equal(mount?.subPath, "acct-1", "one sub-directory per account, not a shared root");
    // The path is load-bearing, not cosmetic: a venv writes its own absolute
    // path into every shebang, so a cache mounted anywhere else is a cache of
    // broken interpreters. It must equal what the driver's FOLDRUN_DATA and
    // the in-container tenant name produce.
    assert.equal(mount?.mountPath, "/home/agent/.foldrun/runner/.runtimes");
  });
});

test("a tenant name that is not one safe segment gets no volume at all", () => {
  withCachePvc("foldrun-runtimes", () => {
    for (const bad of ["../other", "a/b", "..", ".", "", "  "]) {
      const pod = runPodManifest("x", "img", "run1", "small", 600, bad) as Pod;
      assert.equal(pod.spec.volumes, undefined, `${JSON.stringify(bad)} must not mount`);
    }
  });
});

test("no tenant (an embedder with no tenancy) simply gets no cache", () => {
  withCachePvc("foldrun-runtimes", () => {
    const pod = runPodManifest("x", "img") as Pod;
    assert.equal(pod.spec.volumes, undefined);
  });
});

// Per-account claims (prod on EFS): an access point per account, so the
// filesystem itself — not only the kubelet's subPath — keeps accounts apart.
function withAccountClass<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.FOLDRUN_RUNTIME_CACHE_ACCOUNT_CLASS;
  if (value === undefined) delete process.env.FOLDRUN_RUNTIME_CACHE_ACCOUNT_CLASS;
  else process.env.FOLDRUN_RUNTIME_CACHE_ACCOUNT_CLASS = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_RUNTIME_CACHE_ACCOUNT_CLASS;
    else process.env.FOLDRUN_RUNTIME_CACHE_ACCOUNT_CLASS = previous;
  }
}

test("per-account claims: the account's own claim mounts whole, the shared layer stays read-only", () => {
  withCachePvc("foldrun-runtimes", () =>
    withAccountClass("efs-account", () => {
      const pod = runPodManifest("x", "img", "run1", "small", 600, "acct-1") as Pod;
      assert.deepEqual(pod.spec.volumes, [
        { name: "runtime-cache", persistentVolumeClaim: { claimName: "foldrun-runtimes" } },
        { name: "runtime-cache-own", persistentVolumeClaim: { claimName: "rtc-acct-1" } },
      ]);
      const mounts = pod.spec.containers[0].volumeMounts ?? [];
      const own = mounts.find((m) => m.mountPath === "/home/agent/.foldrun/runner/.runtimes");
      assert.equal(own?.name, "runtime-cache-own");
      assert.equal(own?.subPath, undefined, "the claim IS the account's root; no subPath to escape");
      // Nothing of the shared claim is writable, and nothing but _shared is mounted from it.
      for (const m of mounts.filter((m) => m.name === "runtime-cache")) {
        assert.equal(m.subPath, "_shared");
        assert.equal((m as { readOnly?: boolean }).readOnly, true);
      }
    }),
  );
});

test("per-account claims: two accounts whose names fold alike still get different claims", () => {
  const a = accountCachePvcManifest("a.b", "efs-account") as { metadata: { name: string } };
  const b = accountCachePvcManifest("a_b", "efs-account") as { metadata: { name: string } };
  assert.notEqual(a.metadata.name, b.metadata.name);
  assert.match(a.metadata.name, /^rtc-[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
  assert.ok(a.metadata.name.length <= 63);
});

test("per-account claims: a tenant with no safe segment gets no volume, not someone else's", () => {
  withCachePvc("foldrun-runtimes", () =>
    withAccountClass("efs-account", () => {
      for (const bad of ["../other", "a/b", "", "  "]) {
        const pod = runPodManifest("x", "img", "run1", "small", 600, bad) as Pod;
        assert.equal(pod.spec.volumes, undefined, `${JSON.stringify(bad)} must not mount`);
      }
      assert.equal(accountCachePvcManifest("../other", "efs-account"), null);
    }),
  );
});

test("a Docker memory figure becomes one Kubernetes accepts", () => {
  // sizeLimits speaks Docker — `--memory 2g` — and its default is exactly
  // that. Kubernetes rejects the lowercase form with a message naming neither
  // the field nor the value, so every default-size step failed to create a pod
  // on any install that had not overridden FOLDRUN_RUNNER_MEMORY. These
  // manifests do, which is why it broke only for self-hosters.
  assert.equal(k8sMemory("2g"), "2Gi", "the default size, and the bug");
  assert.equal(k8sMemory("512m"), "512Mi", "docker's m is mebibytes, not millibytes");
  // `k` is a legal Kubernetes decimal suffix and Docker's kibibytes; case
  // decides, and everything here comes from sizeLimits, which speaks Docker.
  assert.equal(k8sMemory("1024k"), "1024Ki");
  assert.equal(k8sMemory("2t"), "2Ti");
  assert.equal(k8sMemory("2048b"), "2048");
  // Already a quantity: untouched, including what production actually sets.
  for (const q of ["6Gi", "8Gi", "1Gi", "500M", "2G", "1024"]) assert.equal(k8sMemory(q), q);
  // Anything else is handed over so the cluster's own error is the one read.
  assert.equal(k8sMemory("lots"), "lots");
});

test("a running pod whose run is over is deleted; live, unknown and young pods stay", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { reapOrphanRunPods } = await import("../src/run-k8s.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-reap-"));
  const log = path.join(dir, "calls");
  const old = new Date(Date.now() - 60 * 60_000).toISOString();
  const young = new Date().toISOString();
  const fake = path.join(dir, "kubectl");
  fs.writeFileSync(fake, `#!/bin/sh
echo "$@" >> "${log}"
case "$1" in get) printf 'pod-stopped run-stopped ${old}\\npod-live run-live ${old}\\npod-unknown run-gone ${old}\\npod-young run-stopped2 ${young}\\n' ;; esac
`, { mode: 0o755 });
  const env = { FOLDRUN_KUBECTL: process.env.FOLDRUN_KUBECTL, FOLDRUN_RUN_ISOLATION: process.env.FOLDRUN_RUN_ISOLATION };
  process.env.FOLDRUN_KUBECTL = fake;
  process.env.FOLDRUN_RUN_ISOLATION = "k8s";
  try {
    const states: Record<string, "live" | "over"> = { "run-stopped": "over", "run-live": "live", "run-stopped2": "over" };
    const reaped = await reapOrphanRunPods((id) => states[id] ?? "unknown");
    assert.deepEqual(reaped, ["pod/pod-stopped"]);
    const calls = fs.readFileSync(log, "utf8");
    assert.match(calls, /delete pod\/pod-stopped -n \S+ --wait=false/);
    assert.doesNotMatch(calls, /pod-live|pod-unknown|pod-young/);
  } finally {
    for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a test run's pod carries the label the deny-world policy selects on, a live one does not", () => {
  const live = runPodManifest("x", "img", "run-1", undefined, undefined, "acct") as { metadata: { labels: Record<string, string> } };
  const tst = runPodManifest("x", "img", "run-1", undefined, undefined, "acct", true) as { metadata: { labels: Record<string, string> } };
  assert.equal(live.metadata.labels["foldrun.io/test"], undefined);
  assert.equal(tst.metadata.labels["foldrun.io/test"], "true");
});

// ----------------------------------------------------- the account's service pods
//
// What a step's sandbox is handed for the account's search and browser pods,
// decided from what the step grants. The ensure calls are injected, so this
// is the rule and not the cluster.

function withPerAccount<T>(fn: () => Promise<T>): Promise<T> {
  const keys = ["FOLDRUN_RUN_ISOLATION", "FOLDRUN_SEARCH_PER_ACCOUNT", "FOLDRUN_BROWSER_PER_ACCOUNT"] as const;
  const prev = keys.map((k) => process.env[k]);
  process.env.FOLDRUN_RUN_ISOLATION = "k8s";
  process.env.FOLDRUN_SEARCH_PER_ACCOUNT = "1";
  process.env.FOLDRUN_BROWSER_PER_ACCOUNT = "1";
  return fn().finally(() => {
    keys.forEach((k, i) => {
      if (prev[i] === undefined) delete process.env[k];
      else process.env[k] = prev[i]!;
    });
  });
}

test("a step granting browser gets the account's browser pod as FOLDRUN_BROWSER_WS, and a trace line", () =>
  withPerAccount(async () => {
    const lines: string[] = [];
    const ensured: string[] = [];
    const r = await accountServiceEnv({
      tenant: "acme",
      scripts: [{ name: "web" }],
      env: { A: "1", FOLDRUN_WEB_ACTIONS: "browse,fetch" },
      emit: (l) => lines.push(l),
      ensureBrowser: async (tenant, log) => {
        ensured.push(tenant);
        log("browser: foldrun-browser-acme up in 3.1s");
        return "ws://foldrun-browser-acme.foldrun-runs.svc.cluster.local:3000/";
      },
      ensureSearch: async () => assert.fail("search was not granted; its pod must not be started"),
    });
    assert.equal(r.failed, undefined);
    assert.deepEqual(ensured, ["acme"]);
    assert.equal(r.env.FOLDRUN_BROWSER_WS, "ws://foldrun-browser-acme.foldrun-runs.svc.cluster.local:3000/");
    assert.equal(r.env.A, "1", "the rest of the env rides through untouched");
    assert.deepEqual(lines, ["browser: foldrun-browser-acme up in 3.1s"]);
  }));

test("a step that grants neither tool starts nothing, whoever the tenant is", () =>
  withPerAccount(async () => {
    const r = await accountServiceEnv({
      tenant: "acme",
      scripts: [{ name: "fetch" }],
      env: { FOLDRUN_SEARCH_URL: "http://x" },
      emit: () => assert.fail("nothing to say"),
      ensureBrowser: async () => assert.fail("not granted"),
      ensureSearch: async () => assert.fail("not granted"),
    });
    assert.deepEqual(r, { env: { FOLDRUN_SEARCH_URL: "http://x" } });
    // No tenant: no pods and no address, however much is granted.
    const none = await accountServiceEnv({
      scripts: [{ name: "web" }],
      env: {},
      emit: () => assert.fail("nothing to say"),
      ensureBrowser: async () => assert.fail("no tenant"),
      ensureSearch: async () => assert.fail("no tenant"),
    });
    assert.deepEqual(none, { env: {} });
  }));

test("a TEST run is handed no browser pod: the in-pod browser stays under the deny-world policy", () =>
  withPerAccount(async () => {
    const lines: string[] = [];
    const r = await accountServiceEnv({
      tenant: "acme",
      test: true,
      scripts: [{ name: "web" }],
      // A stale address from the outside must not survive either.
      env: { FOLDRUN_WEB_ACTIONS: "browse", FOLDRUN_BROWSER_WS: "ws://leftover:3000/" },
      emit: (l) => lines.push(l),
      ensureBrowser: async () => assert.fail("a test run must never start, or stamp, a browser pod"),
    });
    assert.equal(r.failed, undefined, "the step still runs; its browser call fails closed inside the pod");
    assert.equal(r.env.FOLDRUN_BROWSER_WS, undefined);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^browser: test run — no account browser pod/);
  }));

test("a browser pod the cluster would not give is not fatal: the tool runs Chromium inside the step", () =>
  withPerAccount(async () => {
    const lines: string[] = [];
    const r = await accountServiceEnv({
      tenant: "acme",
      scripts: [{ name: "web" }],
      env: { FOLDRUN_WEB_ACTIONS: "browse" },
      emit: (l) => lines.push(l),
      ensureBrowser: async (_t, log) => {
        log("browser: foldrun-browser-acme never became ready: timed out");
        return null;
      },
    });
    assert.equal(r.failed, undefined);
    assert.equal(r.env.FOLDRUN_BROWSER_WS, undefined);
    assert.deepEqual(lines, [
      "browser: foldrun-browser-acme never became ready: timed out",
      "browser: account pod unavailable — the tool runs Chromium inside the step",
    ]);
  }));

test("with per-account search on, a step that cannot get its search pod FAILS — there is no shared engine to fall back to", () =>
  withPerAccount(async () => {
    const lines: string[] = [];
    const r = await accountServiceEnv({
      tenant: "acme",
      scripts: [{ name: "web" }],
      env: { FOLDRUN_WEB_ACTIONS: "search", FOLDRUN_SEARCH_URL: "http://searxng.foldrun.svc.cluster.local:8080" },
      emit: (l) => lines.push(l),
      ensureSearch: async (_t, log) => {
        log("search: could not create foldrun-search-acme: forbidden");
        return null;
      },
    });
    assert.ok(r.failed);
    assert.match(r.failed!, /^search: the account's search pod is unavailable and there is no shared engine/);
    assert.match(r.failed!, /FOLDRUN_SEARCH_PER_ACCOUNT=1/);
    assert.deepEqual(lines, ["search: could not create foldrun-search-acme: forbidden"]);
    // And when the pod comes, its address replaces the shared one.
    const ok = await accountServiceEnv({
      tenant: "acme",
      scripts: [{ name: "web" }],
      env: { FOLDRUN_WEB_ACTIONS: "search", FOLDRUN_SEARCH_URL: "http://searxng.foldrun.svc.cluster.local:8080" },
      emit: () => {},
      ensureSearch: async () => "http://foldrun-search-acme.foldrun-runs.svc.cluster.local:8080",
    });
    assert.equal(ok.failed, undefined);
    assert.equal(ok.env.FOLDRUN_SEARCH_URL, "http://foldrun-search-acme.foldrun-runs.svc.cluster.local:8080");
  }));

test("with the switches off the env is handed through as it came, and no pod is ever touched", async () => {
  const keys = ["FOLDRUN_SEARCH_PER_ACCOUNT", "FOLDRUN_BROWSER_PER_ACCOUNT"] as const;
  const prev = keys.map((k) => process.env[k]);
  keys.forEach((k) => delete process.env[k]);
  try {
    const r = await accountServiceEnv({
      tenant: "acme",
      scripts: [{ name: "web" }],
      env: { FOLDRUN_SEARCH_URL: "http://x" },
      emit: () => assert.fail("nothing to say"),
      ensureBrowser: async () => assert.fail("off"),
      ensureSearch: async () => assert.fail("off"),
    });
    assert.deepEqual(r, { env: { FOLDRUN_SEARCH_URL: "http://x" } });
  } finally {
    keys.forEach((k, i) => {
      if (prev[i] === undefined) delete process.env[k];
      else process.env[k] = prev[i]!;
    });
  }
});

test("a run pod, its account's service pod and the policy between them agree on one label", () => {
  const tenant = "Owner.Inspections";
  const seg = accountSegment(tenant)!;
  const run = runPodManifest("p", "img", "run-1", "small", undefined, tenant) as { metadata: { labels: Record<string, string> } };
  assert.equal(run.metadata.labels["foldrun.io/account"], seg);
  const pod = searchPodManifest(seg) as { metadata: { labels: Record<string, string> } };
  assert.equal(pod.metadata.labels["foldrun.io/account"], seg);
  const [fromRuns] = policyManifests(SEARCH, seg) as { spec: { podSelector: { matchLabels: Record<string, string> }; egress: { to: { podSelector: { matchLabels: Record<string, string> } }[] }[] } }[];
  assert.equal(fromRuns.spec.podSelector.matchLabels["foldrun.io/account"], seg);
  assert.equal(fromRuns.spec.egress[0].to[0].podSelector.matchLabels["foldrun.io/account"], seg);
  assert.match(seg, /^owner-inspections-[0-9a-f]{8}$/, "a folded tenant is hashed, and the hash is what every side carries");
});

test("a step that named a remote browser gets no account pod, and says so", async () => {
  const lines: string[] = [];
  let ensured = 0;
  const { env } = await accountServiceEnv({
    tenant: "acme",
    scripts: [{ name: "web" }],
    env: { FOLDRUN_WEB_ACTIONS: "browse", FOLDRUN_BROWSER_VENDOR: "browserbase", FOLDRUN_BROWSER_SECRET: "BROWSERBASE_API_KEY", FOLDRUN_BROWSER_WS: "ws://stale" },
    emit: (l) => lines.push(l),
    ensureBrowser: async () => { ensured++; return "ws://foldrun-browser-acme:3000"; },
    ensureSearch: async () => null,
  });
  assert.equal(ensured, 0, "the account pod is neither started nor addressed");
  assert.equal(env.FOLDRUN_BROWSER_WS, undefined);
  assert.equal(env.FOLDRUN_BROWSER_VENDOR, "browserbase", "the vendor choice reaches the wrapper");
  assert.ok(lines.some((l) => /browserbase named in frontmatter/.test(l)), lines.join("\n"));
});

test("web with every action starts both pods; limited to fetch and crawl it starts neither", () =>
  withPerAccount(async () => {
    const started: string[] = [];
    const ensureSearch = async () => { started.push("search"); return "http://searx"; };
    const ensureBrowser = async () => { started.push("browser"); return "ws://browser/"; };
    const all = await accountServiceEnv({ tenant: "acme", scripts: [{ name: "web" }], env: {}, emit: () => {}, ensureSearch, ensureBrowser });
    assert.deepEqual(started.sort(), ["browser", "search"]);
    assert.equal(all.env.FOLDRUN_SEARCH_URL, "http://searx");
    started.length = 0;
    await accountServiceEnv({ tenant: "acme", scripts: [{ name: "web" }], env: { FOLDRUN_WEB_ACTIONS: "fetch,crawl" }, emit: () => {}, ensureSearch, ensureBrowser });
    assert.deepEqual(started, [], "fetch and crawl read pages directly");
  }));

test("web's answer on our engine needs the search pod; with a provider for search and answer it does not", () =>
  withPerAccount(async () => {
    const started: string[] = [];
    const ensureSearch = async () => { started.push("search"); return "http://searx"; };
    await accountServiceEnv({ tenant: "acme", scripts: [{ name: "web" }], env: { FOLDRUN_WEB_ACTIONS: "answer" }, emit: () => {}, ensureSearch });
    assert.deepEqual(started, ["search"]);
    started.length = 0;
    await accountServiceEnv({
      tenant: "acme", scripts: [{ name: "web" }],
      env: { FOLDRUN_WEB_ACTIONS: "search,answer", FOLDRUN_WEB_SEARCH_VIA: "brave", FOLDRUN_WEB_ANSWER_VIA: "exa" },
      emit: () => {}, ensureSearch,
    });
    assert.deepEqual(started, [], "a provider answers both");
  }));

// ---------- slim or full runner image ----------

function withImages<T>(full: string | undefined, slim: string | undefined, fn: () => T): T {
  const prev = [process.env.FOLDRUN_RUNNER_IMAGE, process.env.FOLDRUN_RUNNER_SLIM_IMAGE];
  const set = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  set("FOLDRUN_RUNNER_IMAGE", full);
  set("FOLDRUN_RUNNER_SLIM_IMAGE", slim);
  try {
    return fn();
  } finally {
    set("FOLDRUN_RUNNER_IMAGE", prev[0]);
    set("FOLDRUN_RUNNER_SLIM_IMAGE", prev[1]);
  }
}

const tools = (...names: string[]) => names.map((name) => ({ name }));

test("browsing is web with browse allowed, and nothing else", () => {
  assert.ok(!grantsBrowsing(tools("web_browse"), {}), "the retired name is not a grant");
  assert.ok(!grantsBrowsing(tools("browser"), {}), "nor is a tool that happens to be called browser");
  assert.ok(grantsBrowsing(tools("web"), {}), "web with no action list may browse");
  assert.ok(grantsBrowsing(tools("web"), { FOLDRUN_WEB_ACTIONS: "fetch,browse" }));
  assert.ok(!grantsBrowsing(tools("web"), { FOLDRUN_WEB_ACTIONS: "search,fetch" }), "web limited to search and fetch does not browse");
  assert.ok(!grantsBrowsing(tools("build_xlsx"), {}));
});

test("a step that grants no browser runs the slim image; one that may browse runs the full one", () => {
  withImages("reg/runner:full", "reg/runner:slim", () => {
    const officeSave = { name: "office_save", code: "import { writeFileSync } from 'node:fs';" };
    assert.deepEqual(runnerImageFor([officeSave, ...tools("web")], { FOLDRUN_WEB_ACTIONS: "search" }), { image: "reg/runner:slim", variant: "slim" });
    assert.deepEqual(runnerImageFor(tools("web"), {}), { image: "reg/runner:full", variant: "full", why: "it grants a browser" });
    assert.deepEqual(runnerImageFor(tools("web"), { FOLDRUN_WEB_ACTIONS: "fetch" }), { image: "reg/runner:slim", variant: "slim" });
  });
});

test("slim browsing: browsing alone, with the account's pod up, runs slim and drives the pod", () => {
  withImages("reg/runner:full", "reg/runner:slim", () => {
    const pod = { FOLDRUN_BROWSER_WS: "ws://foldrun-browser-acme:3000/" };
    assert.deepEqual(runnerImageFor({ scripts: tools("web") }, pod), { image: "reg/runner:slim", variant: "slim", why: "browses through the account's browser pod", pod: true });
    // chrome and a window are served by the pod too
    assert.equal(runnerImageFor({ scripts: tools("web") }, { ...pod, FOLDRUN_BROWSER_ENGINE: "chrome", FOLDRUN_BROWSER_HEADLESS: "0" }).pod, true);
    // no pod (a test run, a vendor, a cluster that would not give one): full, as before
    assert.deepEqual(runnerImageFor({ scripts: tools("web") }, {}), { image: "reg/runner:full", variant: "full", why: "it grants a browser" });
  });
});

test("slim browsing: outward steps, in-step engines, other browser needs and a forced re-run stay on full", () => {
  withImages("reg/runner:full", "reg/runner:slim", () => {
    const pod = { FOLDRUN_BROWSER_WS: "ws://foldrun-browser-acme:3000/" };
    const outward = runnerImageFor({ scripts: tools("web", "poster"), outward: true }, pod, () => "fetch('https://api.example.com', { method: 'POST' })");
    assert.equal(outward.variant, "full");
    assert.match(outward.why!, /can act outward/);
    for (const [env, re] of [
      [{ FOLDRUN_BROWSER_ENGINE: "lightpanda" }, /lightpanda runs in the step/],
      [{ FOLDRUN_BROWSER_ENGINE: "obscura" }, /obscura/],
      [{ FOLDRUN_BROWSER_LIVE: "1" }, /live/],
      [{ FOLDRUN_BROWSER_EXTENSIONS: "my-ext" }, /extensions/],
    ] as const) {
      const r = runnerImageFor({ scripts: tools("web") }, { ...pod, ...env });
      assert.equal(r.variant, "full", JSON.stringify(env));
      assert.match(r.why!, re);
      assert.equal(r.pod, undefined);
    }
    // browsing plus a script that drives its own browser: the pod cannot serve that
    const own = runnerImageFor({ scripts: [{ name: "web" }, { name: "scrape", code: "import { chromium } from 'playwright'" }] }, pod);
    assert.equal(own.variant, "full");
    assert.match(own.why!, /script scrape drives a browser/);
    // the re-run after a lost pod
    assert.deepEqual(runnerImageFor({ scripts: tools("web"), image: "full" }, pod), { image: "reg/runner:full", variant: "full", why: "re-run after the browser pod was lost" });
    // the switch
    process.env.FOLDRUN_SLIM_BROWSING = "0";
    try {
      assert.match(runnerImageFor({ scripts: tools("web") }, pod).why!, /slim browsing is off/);
    } finally {
      delete process.env.FOLDRUN_SLIM_BROWSING;
    }
  });
});

test("with no slim image configured every step runs the full image, exactly as before", () => {
  withImages("reg/runner:full", undefined, () => {
    assert.deepEqual(runnerImageFor(tools("office_save"), {}), { image: "reg/runner:full", variant: "full" });
  });
  withImages("reg/runner:full", "", () => {
    assert.deepEqual(runnerImageFor(tools("office_save"), {}), { image: "reg/runner:full", variant: "full" }, "an empty value is not an image");
  });
});

test("a step that can launch a browser some other way runs the full image", () => {
  withImages("reg/runner:full", "reg/runner:slim", () => {
    const variant = (input: Parameters<typeof runnerImageFor>[0], read?: Parameters<typeof runnerImageFor>[2]) => runnerImageFor(input, {}, read);
    const plain = { name: "summarise", code: "print('hi')" };
    assert.equal(variant({ scripts: [plain] }).variant, "slim", "a plain script, nothing else");
    // An MCP server started by command runs inside the pod; one over http does not.
    assert.match(variant({ scripts: [], mcpServers: { pw: { command: "npx", args: ["@playwright/mcp"] } } }).why!, /MCP server pw runs in the pod/);
    assert.match(variant({ scripts: [], mcpServers: { any: { type: "stdio", command: "node" } } }).why!, /MCP server any/);
    assert.equal(variant({ scripts: [], mcpServers: { remote: { type: "http", url: "https://mcp.example.com" } } }).variant, "slim");
    // A script tool that drives a browser of its own, inline or by file.
    assert.match(variant({ scripts: [{ name: "scrape", code: "from playwright.sync_api import sync_playwright" }] }).why!, /script scrape drives a browser/);
    assert.equal(variant({ scripts: [{ name: "scrape", run: "scripts/s.js" }] }, () => "const p = require('puppeteer')").variant, "full");
    assert.match(variant({ scripts: [{ name: "mystery", run: "scripts/gone.py" }] }, () => null).why!, /could not be read/, "unseen source errs toward full");
    // A runtime that installs one, or Bash with a prompt that asks for one.
    assert.match(variant({ scripts: [], runtime: { packages: ["selenium==4.1"], npm: [] } }).why!, /runtime installs selenium/);
    assert.equal(variant({ scripts: [], allowed: ["Bash"], prompt: "Use playwright to screenshot the site" }).variant, "full");
    assert.equal(variant({ scripts: [], allowed: ["Read"], prompt: "Use playwright to screenshot the site" }).variant, "slim", "no way to run it");
    assert.equal(variant({ scripts: [], allowed: ["Bash"], prompt: "Tidy the CSV" }).variant, "slim");
  });
});

test("a folder tool's source is every file beside its run.mjs, from the staged copy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-image-"));
  try {
    const agentDir = path.join(root, "workspace", "agents", "a");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(path.join(root, "workspace", "tools", "shots", "lib"), { recursive: true });
    fs.writeFileSync(path.join(root, "workspace", "tools", "shots", "run.mjs"), "import './lib/take.mjs';");
    fs.writeFileSync(path.join(root, "workspace", "tools", "shots", "lib", "take.mjs"), "import { chromium } from 'playwright';");
    const src = stagedScriptSource(agentDir, path.join(root, "library", "scripts"), { run: "workspace/tools/shots/run.mjs" });
    assert.match(src!, /chromium/, "the import beside run.mjs is read too");
    assert.equal(stagedScriptSource(agentDir, path.join(root, "library", "scripts"), { run: "workspace/tools/none/run.mjs" }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------- a driver that exits without `done`
//
// blog-desk radar, 30 Sep: the driver finished at 20:20, no done line was
// read, the shim held the pod forty minutes for an ack nobody would send,
// and when it gave up the pod was Completed and the step's files could not
// be copied out. The shim now writes the driver's exit code; the host
// watches for it and fails at once, with the pod still held.

test("the shim records the driver's exit code before it waits for the ack", async () => {
  const { SHIM } = await import("../src/run-k8s.ts");
  const driver = SHIM.indexOf("node /opt/runner/driver.mjs");
  const exit = SHIM.indexOf("echo $? > /opt/runner/job/exit");
  const ack = SHIM.indexOf("/opt/runner/job/ack");
  assert.ok(driver > 0 && exit > driver && ack > exit, "driver, then its exit code, then the wait for the ack");
});

test("a done line found in a full re-read of the log settles the step", async () => {
  const { doneInLog } = await import("../src/run-k8s.ts");
  const log = [
    '{"e":"event","type":"info","text":"script: serp_forums → exit 0"}',
    "some stderr noise",
    '{"e":"done","status":"completed","result":"found 12 threads","costUsd":0.42}',
    "",
  ].join("\n");
  const done = doneInLog(log);
  assert.equal(done?.status, "completed");
  assert.equal(done?.result, "found 12 threads");
  assert.equal(doneInLog('{"e":"event","type":"info","text":"x"}\n'), null);
});

test("with no done line, the reason gives the exit code and what the program said on stderr", async () => {
  const { exitedWithoutResult } = await import("../src/run-k8s.ts");
  const log = [
    '{"e":"event","type":"info","text":"script: serp_forums → exit 0"}',
    "file:///opt/runner/driver.mjs:812",
    "TypeError: Cannot read properties of undefined (reading 'content')",
    "",
  ].join("\n");
  const why = exitedWithoutResult("1\n", log);
  assert.match(why, /exited \(code 1\) without reporting a result/);
  assert.match(why, /TypeError: Cannot read properties of undefined/);
  assert.doesNotMatch(why, /serp_forums/, "protocol lines are not the explanation");
  assert.match(exitedWithoutResult("0", ""), /code 0\) without reporting a result$/);
});

test("the driver exited and the one-shot log re-read failed: the next tick reads again, and finds the done line", async () => {
  const { runStepInK8s } = await import("../src/run-k8s.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-exitwatch-"));
  const reads = path.join(dir, "reads");
  const done = JSON.stringify({ e: "done", status: "completed", result: "all there", costUsd: 0.01 });
  // A held pod whose driver has exited (code 0); its live stream is quiet; the
  // first one-shot `logs` fails as an API server blip would, the next answers.
  const fake = path.join(dir, "kubectl");
  fs.writeFileSync(fake, `#!/bin/sh
case "$1" in
  get) echo '{"status":{"phase":"Running"}}' ;;
  exec) case "$*" in *"cat /opt/runner/job/exit"*) echo 0 ;; esac ;;
  logs)
    case "$2" in -f) exec sleep 30 ;; esac
    n=$(cat "${reads}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${reads}"
    if [ $n -eq 1 ]; then echo "error: the server is currently unable to handle the request" >&2; exit 1; fi
    echo '${done}' ;;
  cp) exit 1 ;;
esac
`, { mode: 0o755 });
  const keys = ["FOLDRUN_KUBECTL", "FOLDRUN_RUNNER_IMAGE", "FOLDRUN_K8S_EXIT_WATCH_MS", "FOLDRUN_K8S_EXIT_GRACE_MS"] as const;
  const prev = keys.map((k) => process.env[k]);
  Object.assign(process.env, { FOLDRUN_KUBECTL: fake, FOLDRUN_RUNNER_IMAGE: "img", FOLDRUN_K8S_EXIT_WATCH_MS: "50", FOLDRUN_K8S_EXIT_GRACE_MS: "0" });
  try {
    const errors: string[] = [];
    const out = await runStepInK8s({
      workspaceRoot: dir,
      libraryRoot: path.join(dir, "library"),
      input: {} as never,
      env: {},
      emit: (type, text) => void (type === "error" && errors.push(text)),
      resume: { ref: "foldrun-run-held", consumed: 0 },
    });
    assert.equal(out.status, "completed", errors.join(" | "));
    assert.equal(out.result, "all there");
    assert.ok(Number(fs.readFileSync(reads, "utf8")) >= 2, "a failed re-read is retried on the next tick");
    assert.ok(!errors.some((e) => /without reporting a result/.test(e)), "a failed re-read is not the driver's silence");
  } finally {
    keys.forEach((k, i) => (prev[i] === undefined ? delete process.env[k] : (process.env[k] = prev[i]!)));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the pod shim installs runtime system packages as root, before the drop to agent", async () => {
  const { SHIM } = await import("../src/run-k8s.ts");
  const read = SHIM.indexOf("FOLDRUN_SYSTEM_PACKAGES=");
  const apt = SHIM.indexOf("apt-get");
  const drop = SHIM.indexOf("runuser -u agent");
  assert.ok(read >= 0 && apt > read && drop > apt, "read the list, install, then drop");
  assert.match(SHIM, /\/opt\/runner\/job\/input\.json/);
  assert.match(SHIM, /system-install\.json/);
});

test("the pod shim starts the install helper as root, before the drop to agent", async () => {
  const { SHIM } = await import("../src/run-k8s.ts");
  const helper = SHIM.indexOf("install-helper.js");
  const drop = SHIM.indexOf("runuser -u agent");
  assert.ok(helper > 0 && drop > helper, "helper first, then the drop");
  assert.match(SHIM, /FOLDRUN_INSTALL_SOCKET=\/opt\/runner\/job\/install\.sock; export FOLDRUN_INSTALL_SOCKET/);
  assert.match(SHIM, /install-helper\.js "\$FOLDRUN_INSTALL_SOCKET" \/home\/agent\/\.foldrun\/runner\/\.runtimes >\/dev\/null 2>&1 &/);
});

test("a pod whose network: is enforced and not open carries the label the run policy withholds the world from", () => {
  type Labelled = { metadata: { labels: Record<string, string> } };
  const filtered = runPodManifest("p", "img", "run-x", "small", undefined, "acme", false, true) as Labelled;
  assert.equal(filtered.metadata.labels["foldrun.io/network"], "filtered");
  const open = runPodManifest("p", "img", "run-x", "small", undefined, "acme", false, false) as Labelled;
  assert.equal(open.metadata.labels["foldrun.io/network"], undefined);
});

test("policyFloorMs: default 2000, 0 honoured, invalid falls back with a warning (FOL-48)", () => {
  const prev = process.env.FOLDRUN_POLICY_FLOOR_MS;
  const warns: unknown[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a[0]);
  try {
    delete process.env.FOLDRUN_POLICY_FLOOR_MS;
    assert.equal(policyFloorMs(), 2000, "unset → default, behaviour unchanged");
    process.env.FOLDRUN_POLICY_FLOOR_MS = "";
    assert.equal(policyFloorMs(), 2000, "empty → default");
    process.env.FOLDRUN_POLICY_FLOOR_MS = "0";
    assert.equal(policyFloorMs(), 0, "0 is allowed — a proven CNI drops the floor");
    process.env.FOLDRUN_POLICY_FLOOR_MS = "500";
    assert.equal(policyFloorMs(), 500, "a whole ms count is used as-is");
    assert.equal(warns.length, 0, "no warning for valid values");
    for (const bad of ["abc", "-1", "1.5", "2e3", " "]) {
      process.env.FOLDRUN_POLICY_FLOOR_MS = bad;
      assert.equal(policyFloorMs(), 2000, `${JSON.stringify(bad)} → default`);
    }
    assert.equal(warns.length, 5, "each invalid value warned once");
  } finally {
    console.warn = realWarn;
    if (prev === undefined) delete process.env.FOLDRUN_POLICY_FLOOR_MS;
    else process.env.FOLDRUN_POLICY_FLOOR_MS = prev;
  }
});

test("a run pod's apply is asked again when the cluster does not answer, not when it refuses (deploy rollback, 19 Oct)", async () => {
  const { applyRetrying } = await import("../src/run-k8s.ts");
  const answers = [{ status: null, out: "\nkubectl apply gave no answer in 30s" }, { status: 1, out: "Error from server (ServiceUnavailable): the server is currently unable to handle the request" }, { status: 0, out: "pod/x created" }];
  const seen: number[] = [];
  const notes: string[] = [];
  const ok = await applyRetrying(async (_a, _i, t) => (seen.push(t ?? 0), answers.shift()!), "{}", (l) => notes.push(l), [10, 20, 30], 0);
  assert.equal(ok.status, 0);
  assert.deepEqual(seen, [10, 20, 30], "a longer wait each time");
  assert.equal(notes.length, 2);
  assert.match(notes[0]!, /asking again, 2 of 3/);
  let calls = 0;
  const refused = await applyRetrying(async () => (calls++, { status: 1, out: 'The Pod "x" is invalid: spec.containers[0].image: Required value' }), "{}", () => {}, [10, 20, 30], 0);
  assert.equal(refused.status, 1);
  assert.equal(calls, 1, "a real refusal is not retried");
  let tries = 0;
  const gone = await applyRetrying(async () => (tries++, { status: null, out: "gave no answer in 10s" }), "{}", () => {}, [10, 20], 0);
  assert.equal(gone.status, null);
  assert.equal(tries, 2, "gives up after the last");
});

// ---- FOL-46: the search pod starts in parallel with the step pod ----

test("FOL-46: deferSearch sets the search URL synchronously and does NOT wait on the pod", async () => {
  process.env.FOLDRUN_SEARCH_PER_ACCOUNT = "1";
  process.env.FOLDRUN_RUN_ISOLATION = "k8s";
  try {
    let resolveSearch: (u: string) => void = () => {};
    const slow = new Promise<string>((r) => { resolveSearch = r; });
    const r = await accountServiceEnv({
      tenant: "acme",
      scripts: [{ name: "web" }],
      env: {},
      emit: () => {},
      deferSearch: true,
      // Resolves only when WE say so — if accountServiceEnv awaited it, this
      // call would hang; it returns at once, proving the overlap.
      ensureSearch: () => slow,
    });
    assert.equal(r.failed, undefined);
    assert.equal(r.env.FOLDRUN_SEARCH_URL, "http://foldrun-search-acme.foldrun-runs.svc.cluster.local:8080",
      "the Service URL is known without the pod being Ready");
    assert.ok(r.searchReady, "the still-running ensure is handed back to be awaited before go");
    resolveSearch("http://foldrun-search-acme.foldrun-runs.svc.cluster.local:8080");
    const ready = await r.searchReady!;
    assert.equal(ready.url, "http://foldrun-search-acme.foldrun-runs.svc.cluster.local:8080");
    assert.equal(typeof ready.readyAt, "number", "readyAt is captured when the ensure resolves");
  } finally {
    delete process.env.FOLDRUN_SEARCH_PER_ACCOUNT;
    delete process.env.FOLDRUN_RUN_ISOLATION;
  }
});

test("FOL-46: a slow search pod BLOCKS go — go is never touched before search is Ready", async () => {
  const order: string[] = [];
  let readySearch: (u: string) => void = () => {};
  const searchReady = new Promise<{ url: string | null; readyAt: number }>((r) => { readySearch = (u) => { order.push("search-ready"); r({ url: u, readyAt: Date.now() }); }; });
  // go must only run after search resolves. Release search after a tick.
  setTimeout(() => readySearch("http://searx"), 25);
  const res = await gateGoOnSearch(searchReady, async () => { order.push("go"); });
  assert.deepEqual(order, ["search-ready", "go"], "go waited for the search pod");
  assert.equal(res.failed, undefined);
  assert.ok(res.waitMs >= 20, `the block was measured for the billing credit (got ${res.waitMs}ms)`);
});

test("FOL-46: a search pod that cannot be had fails the step and go is NEVER touched", async () => {
  let went = false;
  // A rejecting ensure is .catch-guarded to {url:null} upstream; the gate sees it.
  const res = await gateGoOnSearch(Promise.resolve({ url: null, readyAt: Date.now() }), async () => { went = true; });
  assert.equal(went, false, "go must not run when search is unavailable");
  assert.equal(res.failed, SEARCH_UNAVAILABLE);
});

test("FOL-46: no search granted → go runs straight away, unchanged", async () => {
  let went = false;
  const res = await gateGoOnSearch(undefined, async () => { went = true; });
  assert.equal(went, true);
  assert.equal(res.waitMs, 0);
  assert.equal(res.failed, undefined);
});

test("FOL-46: services is stamped with search's own readyAt, not gate arrival", async () => {
  // A fixed epoch-ms from the past, deliberately NOT 'now'. The ensure resolves
  // a tick late so gate arrival (when gateGoOnSearch awaits) is well after it —
  // if the mark used gate time, onReady would get ~now, not FIXED_READY.
  const FIXED_READY = 1_600_000_000_000;
  let stamped: number | undefined;
  const searchReady = new Promise<{ url: string | null; readyAt: number }>((r) => {
    setTimeout(() => r({ url: "http://searx", readyAt: FIXED_READY }), 25);
  });
  const res = await gateGoOnSearch(searchReady, async () => {}, (at) => { stamped = at; });
  assert.equal(stamped, FIXED_READY, "services uses the ensure's own resolution time (readyAt)");
  assert.ok(Date.now() - FIXED_READY > 1000, "and that readyAt is NOT gate arrival (now)");
  assert.equal(res.failed, undefined);
});

test("FOL-46: services keeps the later of search's ready time and a browser already marked ready", async () => {
  const { servicesReadyAt } = await import("../src/run-k8s.ts");
  assert.equal(servicesReadyAt(1000, undefined), 1000, "search alone: its own ready time");
  assert.equal(servicesReadyAt(1000, 1500), 1500, "the browser came up after search: services waits for it");
  assert.equal(servicesReadyAt(2000, 1500), 2000, "search came up last: its time");
});

test("FOL-46: a search pod that fails AFTER the step pod exists → step failed AND the pod is deleted", async () => {
  // Drives the real runStepInK8s against a STUB kubectl (FOLDRUN_KUBECTL) — no
  // cluster — with an injected search ensure that fails after the step pod was
  // created. The step must come back services.failed and the step pod must be
  // deleted (the finally), exactly as an inline search failure does today.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-fol46-"));
  const callsLog = path.join(tmp, "kc-calls.log");
  const fakeKc = path.join(tmp, "kubectl");
  fs.writeFileSync(fakeKc,
    "#!/usr/bin/env node\n" +
    "const fs=require('fs');const a=process.argv.slice(2);\n" +
    "if(process.env.FAKE_KC_LOG)fs.appendFileSync(process.env.FAKE_KC_LOG,a.join(' ')+'\\n');\n" +
    "const j=a.join(' ');\n" +
    "if(a[0]==='get'&&j.includes('-o')&&j.includes('json'))process.stdout.write('{\"items\":[]}\\n');\n" +
    "else if(a[0]==='apply')process.stdout.write('pod/created\\n');\n" +
    "process.stdin.on('data',()=>{});process.stdin.on('end',()=>process.exit(0));process.stdin.resume();\n" +
    "setTimeout(()=>process.exit(0),1500);\n");
  fs.chmodSync(fakeKc, 0o755);

  const ws = path.join(tmp, "ws");
  fs.mkdirSync(path.join(ws, "agents/writer"), { recursive: true });
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
  fs.writeFileSync(path.join(ws, "agents/writer/agent.md"), "---\nname: writer\ndescription: writes\n---\n\nWrite.\n");

  const save: Record<string, string | undefined> = {};
  const set = (k: string, v: string | undefined) => { save[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  set("FOLDRUN_KUBECTL", fakeKc);
  set("FAKE_KC_LOG", callsLog);
  set("FOLDRUN_RUNNER_IMAGE", "foldrun-runner:test");
  set("FOLDRUN_SEARCH_PER_ACCOUNT", "1");
  set("FOLDRUN_RUN_ISOLATION", "k8s");
  set("FOLDRUN_RUNTIME_CACHE_ACCOUNT_CLASS", undefined);
  set("FOLDRUN_RUNTIME_CACHE_PVC", undefined);

  try {
    const events: { type: string; text: string }[] = [];
    const outcome = await runStepInK8s(
      {
        workspaceRoot: ws,
        libraryRoot: path.join(tmp, "no-library"),
        tenant: "acme",
        input: {
          agentRel: "agents/writer",
          prompt: "x",
          model: "haiku",
          systemPrompt: "s",
          allowed: [],
          mcpNames: [],
          mcpServers: {},
          apis: [],
          scripts: [{ name: "web", run: "", description: "web", args: {} }],
          runtime: null,
          consults: [],
          timeoutSec: 180,
        },
        env: {},
        test: false,
        size: "small",
        emit: (type, text) => events.push({ type, text }),
      },
      { ensureSearch: async () => { throw new Error("search pod exploded after the step pod came up"); } },
    );

    assert.equal(outcome.status, "failed", JSON.stringify(events.slice(-3)));
    assert.match(outcome.reason ?? "", /search/, "it failed for the reason search gives");
    const calls = fs.readFileSync(callsLog, "utf8");
    assert.match(calls, /^apply /m, "the step pod was created");
    assert.match(calls, /delete pod\/foldrun-run-[a-z0-9-]+/, "and the step pod was deleted on the failure");
  } finally {
    for (const [k, v] of Object.entries(save)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("FOL-46: a stop that lands while search is pending keeps go untouched", async () => {
  // The search pod DOES come up (url non-null) — so this is NOT the unavailable
  // path — but a stop was requested while the gate blocked on it. go must not be
  // touched, and the gate reports stopped (the caller turns that into a 'stopped'
  // outcome and the finally deletes the pod).
  let went = false;
  let stopped = false;
  const searchReady = new Promise<{ url: string | null; readyAt: number }>((r) => {
    // The stop lands during the wait, just before search resolves Ready.
    setTimeout(() => { stopped = true; r({ url: "http://searx", readyAt: Date.now() }); }, 25);
  });
  const res = await gateGoOnSearch(searchReady, async () => { went = true; }, undefined, () => stopped);
  assert.equal(went, false, "go must never be touched once a stop landed during the gate's wait");
  assert.equal(res.stopped, true);
  assert.equal(res.failed, undefined, "a stop is not a search-unavailable failure");
});

test("FOL-46: a stop raised while search is still pending → step stopped, go never touched, pod deleted", async () => {
  // Real runStepInK8s against a STUB kubectl. The injected search ensure is held
  // open until a stop is raised; by then the launch has passed c498bba's room /
  // applied / ready checks (stop still false there) and is parked at the gate.
  // The stop flips true as search resolves, so it is the GATE that catches it:
  // go is never touched, the outcome reads 'stopped … waited for search', and
  // the finally deletes the step pod.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-fol46-"));
  const callsLog = path.join(tmp, "kc-calls.log");
  const fakeKc = path.join(tmp, "kubectl");
  fs.writeFileSync(fakeKc,
    "#!/usr/bin/env node\n" +
    "const fs=require('fs');const a=process.argv.slice(2);\n" +
    "if(process.env.FAKE_KC_LOG)fs.appendFileSync(process.env.FAKE_KC_LOG,a.join(' ')+'\\n');\n" +
    "const j=a.join(' ');\n" +
    "if(a[0]==='get'&&j.includes('-o')&&j.includes('json'))process.stdout.write('{\"items\":[]}\\n');\n" +
    "else if(a[0]==='apply')process.stdout.write('pod/created\\n');\n" +
    "process.stdin.on('data',()=>{});process.stdin.on('end',()=>process.exit(0));process.stdin.resume();\n" +
    "setTimeout(()=>process.exit(0),1500);\n");
  fs.chmodSync(fakeKc, 0o755);

  const ws = path.join(tmp, "ws");
  fs.mkdirSync(path.join(ws, "agents/writer"), { recursive: true });
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
  fs.writeFileSync(path.join(ws, "agents/writer/agent.md"), "---\nname: writer\ndescription: writes\n---\n\nWrite.\n");

  const save: Record<string, string | undefined> = {};
  const set = (k: string, v: string | undefined) => { save[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  set("FOLDRUN_KUBECTL", fakeKc);
  set("FAKE_KC_LOG", callsLog);
  set("FOLDRUN_RUNNER_IMAGE", "foldrun-runner:test");
  set("FOLDRUN_SEARCH_PER_ACCOUNT", "1");
  set("FOLDRUN_RUN_ISOLATION", "k8s");
  set("FOLDRUN_RUNTIME_CACHE_ACCOUNT_CLASS", undefined);
  set("FOLDRUN_RUNTIME_CACHE_PVC", undefined);

  let stopped = false;
  let releaseSearch: () => void = () => {};
  const searchHeld = new Promise<void>((r) => { releaseSearch = r; });
  // Raise the stop only AFTER c498bba's ready check — signalled deterministically
  // by the stage-in exec (`tar x …`) landing in the kc log. Stage-in runs
  // strictly after markNow("ready") and right before the gate, so room / applied
  // / ready all polled stop=false; the gate (parked on the held search) is the
  // first poll to see it true. Not a wall-clock guess.
  const poll = setInterval(() => {
    try {
      if (fs.existsSync(callsLog) && fs.readFileSync(callsLog, "utf8").includes("tar x --no-same-owner")) {
        clearInterval(poll);
        stopped = true;
        releaseSearch();
      }
    } catch { /* the log is not there yet */ }
  }, 5);
  try {
    const events: { type: string; text: string }[] = [];
    const outcome = await runStepInK8s(
      {
        workspaceRoot: ws,
        libraryRoot: path.join(tmp, "no-library"),
        tenant: "acme",
        input: {
          agentRel: "agents/writer",
          prompt: "x",
          model: "haiku",
          systemPrompt: "s",
          allowed: [],
          mcpNames: [],
          mcpServers: {},
          apis: [],
          scripts: [{ name: "web", run: "", description: "web", args: {} }],
          runtime: null,
          consults: [],
          timeoutSec: 180,
        },
        env: {},
        test: false,
        size: "small",
        stopRequested: () => stopped,
        emit: (type, text) => events.push({ type, text }),
      },
      { ensureSearch: async () => { await searchHeld; return "http://searx"; } },
    );

    assert.equal(outcome.status, "failed", JSON.stringify(events.slice(-3)));
    assert.match(outcome.reason ?? "", /stopped while its sandbox waited for search/, "the gate caught the stop, not an earlier check");
    const calls = fs.readFileSync(callsLog, "utf8");
    assert.match(calls, /^apply /m, "the step pod was created");
    assert.doesNotMatch(calls, /touch .*\/opt\/runner\/job\/go/, "go was NEVER touched");
    assert.match(calls, /delete pod\/foldrun-run-[a-z0-9-]+/, "and the step pod was deleted (the finally)");
  } finally {
    clearInterval(poll);
    for (const [k, v] of Object.entries(save)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("FOL-46 billing: warm → totalMs unchanged; cold → the search wait is credited; never negative", () => {
  // Warm pool: nothing was waited on at the gate, so the full rent is billed.
  assert.equal(billedTotalMs(5000, 0), 5000, "warm run bills the whole rent, exactly as before FOL-46");
  // Cold pool: the pod sat idle at the gate 12s waiting on our search pod —
  // that 12s is credited out, leaving only the pod's own ~2s of real work.
  assert.equal(billedTotalMs(14000, 12000), 2000, "the cold search wait is subtracted from the bill");
  // A credit that somehow exceeds the rent can never make the customer owe
  // negative time (or wrap): it floors at zero.
  assert.equal(billedTotalMs(100, 999), 0, "never negative");
  // A negative wait (clock skew) is ignored, not added to the bill.
  assert.equal(billedTotalMs(5000, -50), 5000, "a nonsense negative wait credits nothing");
});
