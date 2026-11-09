// What the account's service pods are billed at (FOL-125, 8 Nov 2026): one
// table feeds the manifests' requests and the bill, so they cannot drift.
//
//   node --test tests/pod-sizes.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { SIZE, cpuQuantity, memQuantity, podHold, servicePodSize, serviceRequests, sizeOf, stampSize } from "../src/pod-sizes.ts";
import { setting } from "../src/settings.ts";
import { searchPodManifest, SEARCH } from "../src/search-k8s.ts";
import { browserPodManifest, BROWSER } from "../src/browser-k8s.ts";
import { browsePodManifest } from "../src/browse-service.ts";

type Pod = { spec: { containers: { resources: { requests: Record<string, string>; limits: Record<string, string> } }[] } };
const requests = (pod: object) => (pod as Pod).spec.containers[0]!.resources.requests;
const limits = (pod: object) => (pod as Pod).spec.containers[0]!.resources.limits;

test("quantities: 0.1 vCPU is 100m, 2 is 2; 0.25 GiB is 256Mi, 3 is 3Gi", () => {
  assert.equal(cpuQuantity(0.1), "100m");
  assert.equal(cpuQuantity(0.25), "250m");
  assert.equal(cpuQuantity(2), "2");
  assert.equal(memQuantity(0.25), "256Mi");
  assert.equal(memQuantity(0.5), "512Mi");
  assert.equal(memQuantity(3), "3Gi");
});

test("each pod asks Kubernetes for exactly the size it is billed at", () => {
  assert.deepEqual(requests(searchPodManifest("acme")), serviceRequests("search"));
  assert.deepEqual(requests(searchPodManifest("acme")), { cpu: "250m", memory: "768Mi" });
  assert.deepEqual(requests(browserPodManifest("acme")), { ...serviceRequests("browser"), "ephemeral-storage": "4Gi" });
  assert.deepEqual(requests(browsePodManifest({ token: "t", seg: "acme", runPod: "p", configMap: "c", deadlineSec: 60 } as never)), { ...serviceRequests("browse"), "ephemeral-storage": "4Gi" });
});

test("requests equal limits on every service pod, so the bill is what is reserved (owner decision, 8 Nov)", () => {
  const pods = [searchPodManifest("acme"), browserPodManifest("acme"), browsePodManifest({ token: "t", seg: "acme", runPod: "p", configMap: "c", deadlineSec: 60 } as never)];
  for (const pod of pods) assert.deepEqual(limits(pod), requests(pod));
});

const KEYS = ["FOLDRUN_BROWSER_VCPU", "FOLDRUN_BROWSER_MEMORY_GIB", "FOLDRUN_BROWSER_DISK_GIB", "FOLDRUN_SEARCH_VCPU", "FOLDRUN_SEARCH_MEMORY_GIB"];
function withEnv(env: Record<string, string>, fn: () => void) {
  const was = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try { fn(); } finally { for (const k of KEYS) { if (was[k] === undefined) delete process.env[k]; else process.env[k] = was[k]; } }
}

test("the defaults: browser and browse 1 vCPU / 3 GiB / 4 GiB disk, search 0.25 vCPU / 0.75 GiB", () => {
  withEnv({}, () => {
    assert.deepEqual(servicePodSize("browser"), { vcpu: 1, memGiB: 3, diskGiB: 4 });
    assert.deepEqual(servicePodSize("browse"), { vcpu: 1, memGiB: 3, diskGiB: 4 });
    assert.deepEqual(servicePodSize("search"), { vcpu: 0.25, memGiB: 0.75, diskGiB: 0 });
    assert.equal(setting("pods.browser_vcpu"), 1);
  });
});

test("the sizes are settings: dev sets browser 0.5 vCPU / 2 GiB and the pods and the bill follow, requests still equal limits", () => {
  withEnv({ FOLDRUN_BROWSER_VCPU: "0.5", FOLDRUN_BROWSER_MEMORY_GIB: "2" }, () => {
    assert.deepEqual(servicePodSize("browser"), { vcpu: 0.5, memGiB: 2, diskGiB: 4 });
    assert.deepEqual(servicePodSize("browse"), { vcpu: 0.5, memGiB: 2, diskGiB: 4 }, "the per-step pod shares the browser's");
    assert.deepEqual(servicePodSize("search"), { vcpu: 0.25, memGiB: 0.75, diskGiB: 0 }, "search is untouched");
    for (const pod of [browserPodManifest("acme"), browsePodManifest({ token: "t", seg: "acme", runPod: "p", configMap: "c", deadlineSec: 60 } as never)]) {
      assert.deepEqual(requests(pod), { cpu: "500m", memory: "2Gi", "ephemeral-storage": "4Gi" });
      assert.deepEqual(limits(pod), requests(pod));
    }
    assert.deepEqual(BROWSER.size(), { vcpu: 0.5, memGiB: 2, diskGiB: 4 }, "the pool kind hands the ledger what is set now");
  });
  withEnv({ FOLDRUN_SEARCH_VCPU: "0.5", FOLDRUN_SEARCH_MEMORY_GIB: "1" }, () => {
    const pod = searchPodManifest("acme");
    assert.deepEqual(requests(pod), { cpu: "500m", memory: "1Gi" });
    assert.deepEqual(limits(pod), requests(pod));
    assert.deepEqual(SEARCH.size(), { vcpu: 0.5, memGiB: 1, diskGiB: 0 });
  });
});

test("a pod carries the size it was made with, and is billed at that even after the setting moves", () => {
  let stamp = "";
  withEnv({ FOLDRUN_BROWSER_VCPU: "0.5", FOLDRUN_BROWSER_MEMORY_GIB: "2" }, () => {
    stamp = (browserPodManifest("acme") as { metadata: { annotations: Record<string, string> } }).metadata.annotations[SIZE]!;
    assert.deepEqual(JSON.parse(stamp), { vcpu: 0.5, memGiB: 2, diskGiB: 4 });
  });
  withEnv({}, () => {
    assert.deepEqual(sizeOf(stamp, "browser"), { vcpu: 0.5, memGiB: 2, diskGiB: 4 }, "the stamp wins over today's setting");
    assert.deepEqual(sizeOf(undefined, "browser"), { vcpu: 1, memGiB: 3, diskGiB: 4 }, "an unstamped pod reads today's");
    assert.deepEqual(sizeOf("not json", "search"), { vcpu: 0.25, memGiB: 0.75, diskGiB: 0 });
    const m = stampSize({ metadata: { name: "x" } }, { vcpu: 1, memGiB: 1, diskGiB: 0 }) as { metadata: { annotations: Record<string, string> } };
    assert.equal(m.metadata.annotations[SIZE], '{"vcpu":1,"memGiB":1,"diskGiB":0}');
  });
});

test("a hold is seconds × each dimension", () => {
  assert.deepEqual(podHold({ vcpu: 0.25, memGiB: 0.75, diskGiB: 0 }, 3600), { coreSecs: 900, gibSecs: 2700, diskGibSecs: 0 });
  assert.deepEqual(podHold({ vcpu: 1, memGiB: 1, diskGiB: 2 }, 10), { coreSecs: 10, gibSecs: 10, diskGibSecs: 20 });
});
