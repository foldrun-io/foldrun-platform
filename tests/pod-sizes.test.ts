// What the account's service pods are billed at (FOL-125, 8 Nov 2026): one
// table feeds the manifests' requests and the bill, so they cannot drift.
//
//   node --test tests/pod-sizes.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { SERVICE_POD_SIZES, cpuQuantity, memQuantity, podHold, serviceRequests } from "../src/pod-sizes.ts";
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
  assert.deepEqual(requests(searchPodManifest("acme")), { cpu: "1", memory: "768Mi" });
  assert.deepEqual(requests(browserPodManifest("acme")), { ...serviceRequests("browser"), "ephemeral-storage": "4Gi" });
  assert.deepEqual(requests(browsePodManifest({ token: "t", seg: "acme", runPod: "p", configMap: "c", deadlineSec: 60 } as never)), { ...serviceRequests("browse"), "ephemeral-storage": "4Gi" });
});

test("requests equal limits on every service pod, so the bill is what is reserved (owner decision, 8 Nov)", () => {
  const pods = [searchPodManifest("acme"), browserPodManifest("acme"), browsePodManifest({ token: "t", seg: "acme", runPod: "p", configMap: "c", deadlineSec: 60 } as never)];
  for (const pod of pods) assert.deepEqual(limits(pod), requests(pod));
});

test("the pool kinds carry their size, which the reaper hands the ledger", () => {
  assert.equal(SEARCH.size, SERVICE_POD_SIZES.search);
  assert.equal(BROWSER.size, SERVICE_POD_SIZES.browser);
});

test("a hold is seconds × each dimension", () => {
  assert.deepEqual(podHold(SERVICE_POD_SIZES.search, 3600), { coreSecs: 3600, gibSecs: 2700, diskGibSecs: 0 });
  assert.deepEqual(podHold({ vcpu: 1, memGiB: 1, diskGiB: 2 }, 10), { coreSecs: 10, gibSecs: 10, diskGibSecs: 20 });
});
