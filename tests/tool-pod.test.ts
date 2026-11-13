// Tools on demand (14 Nov 2026): the files-to-text parser as one pod per
// account, made while it has an extraction in flight and gone after the idle
// window (tool-pod.ts). The cluster is a fake kubectl that logs its calls.
//
//   node --test tests/tool-pod.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ON = {
  FOLDRUN_TOOLS_ON_DEMAND: "1",
  FOLDRUN_RUN_ISOLATION: "k8s",
  FOLDRUN_RUNNER_RUNTIME: "gvisor",
  FOLDRUN_EXTRACT_IMAGE: "ecr.example/ghcr/foldrun-io/extract@sha256:abc",
  FOLDRUN_DATABASE_URL: "postgres://foldrun@db.example/foldrun",
} as NodeJS.ProcessEnv;

const tp = await import("../src/tool-pod.ts");

test("on only with k8s isolation, a sandbox runtime and an image; per account by the list", () => {
  assert.equal(tp.toolsOnDemand(ON), true);
  for (const k of ["FOLDRUN_TOOLS_ON_DEMAND", "FOLDRUN_RUN_ISOLATION", "FOLDRUN_RUNNER_RUNTIME", "FOLDRUN_EXTRACT_IMAGE", "FOLDRUN_DATABASE_URL"]) {
    assert.equal(tp.toolsOnDemand({ ...ON, [k]: undefined }), false, `${k} missing turns it off`);
  }
  assert.equal(tp.toolsOnDemand({ ...ON, FOLDRUN_EXTRACT_URL: "http://extract:8090" }), false, "a fixed parser wins: no pods");
  assert.equal(tp.onDemandFor("acme", ON), true, "no list: every account");
  const listed = { ...ON, FOLDRUN_TOOLS_ON_DEMAND_ACCOUNTS: "test, beta" };
  assert.equal(tp.onDemandFor("test", listed), true);
  assert.equal(tp.onDemandFor("acme", listed), false);
  assert.equal(tp.onDemandFor("acme", { ...listed, FOLDRUN_TOOLS_ON_DEMAND_ACCOUNTS: "*" }), true);
});

test("the pod: gVisor, no token, read-only, the image by digest, never moved by consolidation", () => {
  const pod = tp.extractPodManifest("acme", ON) as any;
  assert.equal(pod.metadata.name, "foldrun-extract-acme");
  assert.equal(pod.metadata.namespace, "foldrun-runs");
  assert.deepEqual(pod.metadata.labels, { app: "foldrun-extract", "foldrun.io/account": "acme", "foldrun.io/tool": "extract" });
  assert.equal(pod.metadata.annotations["karpenter.sh/do-not-disrupt"], "true");
  assert.equal(pod.spec.runtimeClassName, "gvisor", "the RuntimeClass carries the runner pool's nodeSelector and toleration");
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.equal(pod.spec.enableServiceLinks, false);
  assert.equal(pod.spec.securityContext.runAsNonRoot, true);
  const c = pod.spec.containers[0];
  assert.equal(c.image, ON.FOLDRUN_EXTRACT_IMAGE);
  assert.equal(c.securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(c.securityContext.capabilities, { drop: ["ALL"] });
  assert.equal(c.securityContext.allowPrivilegeEscalation, false);
  assert.ok(c.volumeMounts.some((v: any) => v.mountPath === "/scratch"));
  assert.ok(c.startupProbe && c.readinessProbe);
});

test("the policy: the platform's callers in, on the parser's port; nothing out, not even DNS", () => {
  const np = tp.extractPolicyManifest("acme") as any;
  assert.deepEqual(np.spec.policyTypes, ["Ingress", "Egress"]);
  assert.deepEqual(np.spec.egress, [], "no egress rule at all: the pod reaches nothing");
  assert.equal(np.spec.ingress.length, 1);
  const from = np.spec.ingress[0].from;
  assert.equal(from.length, 1, "one peer: namespace AND pod must both match");
  assert.deepEqual(from[0].namespaceSelector, { matchLabels: { "kubernetes.io/metadata.name": "foldrun" } });
  assert.deepEqual(from[0].podSelector.matchExpressions[0].values, ["foldrun-web", "foldrun-worker", "foldrun-egress"]);
  assert.deepEqual(np.spec.ingress[0].ports, [{ protocol: "TCP", port: 8090 }]);
  assert.equal(JSON.stringify(np).includes("foldrun-run\""), false, "run pods are not let in");
});

test("ensure: a Pending pod is the cold start and is kept; only an ended pod is replaced", () => {
  assert.equal(tp.ensureAction(null), "create");
  assert.equal(tp.ensureAction("Pending"), "keep");
  assert.equal(tp.ensureAction("Running"), "keep");
  assert.equal(tp.ensureAction("Unknown"), "keep");
  assert.equal(tp.ensureAction("Failed"), "replace");
  assert.equal(tp.ensureAction("Succeeded"), "replace");
});

/** A kubectl that logs every call and answers `get pod … phase` with PHASE. */
function fakeKubectl(phase: string): { bin: string; calls: () => string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-toolpod-"));
  const log = path.join(dir, "calls.log");
  const bin = path.join(dir, "kubectl");
  fs.writeFileSync(
    bin,
    `#!/bin/sh
echo "$*" >> "${log}"
cat > /dev/null
case "$1 $2" in
  "get pod") printf '%s' "${phase}" ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []) };
}

test("ensure against a cluster: Pending is stamped, never deleted or created again; absent is created", async () => {
  const prev = process.env.FOLDRUN_KUBECTL;
  try {
    const pending = fakeKubectl("Pending");
    process.env.FOLDRUN_KUBECTL = pending.bin;
    assert.equal(await tp.ensureExtractPod("acme", ON), "kept");
    const a = pending.calls();
    assert.ok(a.some((c) => c.startsWith("apply -f -")), "Service and policy applied (idempotent)");
    assert.ok(a.some((c) => c.startsWith("annotate pod foldrun-extract-acme")), "stamped as used");
    assert.ok(!a.some((c) => c.startsWith("delete")), "a Pending pod is never deleted");
    assert.ok(!a.some((c) => c.startsWith("create")), "nor made a second time");

    const absent = fakeKubectl("");
    process.env.FOLDRUN_KUBECTL = absent.bin;
    assert.equal(await tp.ensureExtractPod("acme", ON), "created");
    const b = absent.calls();
    assert.ok(b.some((c) => c.startsWith("create -f -")));
    assert.ok(!b.some((c) => c.startsWith("delete")));

    const failed = fakeKubectl("Failed");
    process.env.FOLDRUN_KUBECTL = failed.bin;
    assert.equal(await tp.ensureExtractPod("acme", ON), "created");
    const c = failed.calls();
    const del = c.findIndex((x) => x.startsWith("delete pod foldrun-extract-acme"));
    const made = c.findIndex((x) => x.startsWith("create -f -"));
    assert.ok(del >= 0 && made > del, "an ended pod is deleted, then made again");

    assert.equal(await tp.ensureExtractPod("acme", { ...ON, FOLDRUN_TOOLS_ON_DEMAND_ACCOUNTS: "other" }), "skipped", "an account not on the list gets nothing");
  } finally {
    prev === undefined ? delete process.env.FOLDRUN_KUBECTL : (process.env.FOLDRUN_KUBECTL = prev);
  }
});

test("reap: only an account with no extraction in flight AND no stamp for the idle window", () => {
  const now = Date.parse("2026-11-14T10:00:00Z");
  const pod = (seg: string, lastUsed: string) => ({ name: `foldrun-extract-${seg}`, seg, createdAt: "2026-11-14T08:00:00Z", lastUsed });
  const pods = [pod("idle", "2026-11-14T09:40:00Z"), pod("busy", "2026-11-14T09:00:00Z"), pod("recent", "2026-11-14T09:55:00Z")];
  const gone = tp.idleToolPods(pods, new Set(["busy"]), now, 600_000).map((p) => p.seg);
  assert.deepEqual(gone, ["idle"], "busy is held by its live lease, recent by its stamp");
});

test("reconcile when the database does not answer reaps nothing (an unanswered question is never 'idle')", async () => {
  delete process.env.FOLDRUN_DATABASE_URL; // orm() has no pool: the question cannot be asked
  assert.equal(await tp.accountsWithLiveExtractions(), null);
  assert.deepEqual(await tp.reconcileToolPods(ON), { ensured: 0, reaped: 0 });
});

test("a caller waits for /health through the cold start, gives up at its own deadline, and on abort", async () => {
  let n = 0;
  tp.setToolFetchForTests((async (url: string) => {
    n++;
    assert.equal(url, "http://foldrun-extract-acme.foldrun-runs.svc.cluster.local:8090/health");
    if (n < 3) throw new Error("ENOTFOUND");
    return new Response("ok", { status: 200 });
  }) as typeof fetch);
  try {
    const url = await tp.waitForTool("acme", new AbortController().signal, ON, 30_000);
    assert.equal(url, "http://foldrun-extract-acme.foldrun-runs.svc.cluster.local:8090");
    assert.equal(n, 3);

    tp.setToolFetchForTests((async () => new Response("starting", { status: 503 })) as typeof fetch);
    await assert.rejects(tp.waitForTool("acme", new AbortController().signal, ON, 300), (e: unknown) => e instanceof tp.ToolStartError && (e as Error).message.includes("did not start"));

    const stop = new AbortController();
    setTimeout(() => stop.abort(), 50);
    await assert.rejects(tp.waitForTool("acme", stop.signal, ON, 30_000), (e: unknown) => !(e instanceof tp.ToolStartError));
  } finally {
    tp.setToolFetchForTests(null);
  }
});
