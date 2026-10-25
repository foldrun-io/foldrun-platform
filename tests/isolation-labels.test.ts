// The strings the run-namespace NetworkPolicies select on, pinned (FOL-6).
//
// foldrun-infra's manifests/base/run-network-policy.yaml and
// cilium-policies.yaml match pods by labels this repo sets and by the
// namespace it defaults to. Renaming any of them here does not break a run —
// it silently takes the run pod out from under its egress policy. So each is
// pinned below, and when foldrun-infra is checked out beside this repo (the
// laptop, the box's deploy) the manifests are read too and must name the same
// strings. dev/ci/isolation-probe.sh in foldrun-infra proves the policies hold
// on every deploy; this fails first, in this repo's own tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPodManifest, TEST_LABEL } from "../src/run-k8s.ts";
import { browserPodManifest, BROWSER_APP } from "../src/browser-k8s.ts";
import { NETWORK_LABEL, namespace as accountNamespace } from "../src/account-pod.ts";

type Pod = { metadata: { labels: Record<string, string>; namespace: string } };

test("run pods carry the labels and namespace the run policies select on", () => {
  const prev = process.env.FOLDRUN_K8S_NAMESPACE;
  delete process.env.FOLDRUN_K8S_NAMESPACE;
  try {
    const plain = runPodManifest("p", "img", "run-x", "small", undefined, "acme", false, false) as Pod;
    assert.equal(plain.metadata.namespace, "foldrun-runs", "foldrun-run-egress and foldrun-run-world live in foldrun-runs");
    assert.equal(plain.metadata.labels.app, "foldrun-run", "both run policies select app: foldrun-run");
    const tested = runPodManifest("p", "img", "run-x", "small", undefined, "acme", true, false) as Pod;
    assert.equal(TEST_LABEL, "foldrun.io/test");
    assert.equal(tested.metadata.labels["foldrun.io/test"], "true", "foldrun-run-test-no-world selects foldrun.io/test: \"true\"");
    const filtered = runPodManifest("p", "img", "run-x", "small", undefined, "acme", false, true) as Pod;
    assert.equal(NETWORK_LABEL, "foldrun.io/network");
    assert.equal(filtered.metadata.labels["foldrun.io/network"], "filtered", "foldrun-run-world excludes foldrun.io/network: filtered");
    assert.equal(accountNamespace(), "foldrun-runs", "account pods share the run namespace");
  } finally {
    if (prev !== undefined) process.env.FOLDRUN_K8S_NAMESPACE = prev;
  }
});

test("the account browser pod carries the label the browser policy selects on", () => {
  const pod = browserPodManifest("acme") as Pod;
  assert.equal(BROWSER_APP, "foldrun-browser");
  assert.equal(pod.metadata.labels.app, "foldrun-browser", "foldrun-run-test-no-world denies test runs app: foldrun-browser");
});

const infra = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../foldrun-infra/manifests/base");
test("foldrun-infra's policies name the same strings, when it is checked out beside this repo", { skip: fs.existsSync(infra) ? false : "foldrun-infra is not beside this repo" }, () => {
  const run = fs.readFileSync(path.join(infra, "run-network-policy.yaml"), "utf8");
  const cilium = fs.readFileSync(path.join(infra, "cilium-policies.yaml"), "utf8");
  assert.match(run, /namespace: foldrun-runs/);
  assert.match(run, /app: foldrun-run\b/);
  assert.match(run, /key: foldrun\.io\/network[\s\S]*?values: \["filtered"\]/);
  assert.match(cilium, /matchLabels: \{ app: foldrun-run, foldrun\.io\/test: "true" \}/);
  assert.match(cilium, /app: foldrun-browser/);
});
