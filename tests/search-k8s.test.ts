// Per-account search: the objects the worker applies, the rule that reaps
// them, and the ledger line each one leaves. No cluster — the parts that
// touch kubectl are thin, and what they apply is what is tested here.
//
//   node --test tests/search-k8s.test.ts
import { test } from "node:test";
import { needsBilling } from "./needs-billing.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ACCOUNT_LABEL,
  SEARCH_APP,
  accountSegment,
  idleSearchPods,
  perAccountSearchEnabled,
  searchName,
  searchPodManifest,
  searchPolicyManifests,
  searchServiceManifest,
  searchUrl,
  settingsConfigMap,
} from "../src/search-k8s.ts";
import { runPodManifest } from "../src/run-k8s.ts";
import { readLedger, recordSearchSession } from "../src/ledger.ts";

type Any = Record<string, any>;

test("an account name becomes a DNS label, or nothing", () => {
  assert.equal(accountSegment("matt"), "matt");
  // A name the fold changes carries a hash of the raw one, so Acme_Corp.AU
  // and acme-corp-au are two accounts with two pods (account-pod.test.ts).
  assert.match(accountSegment("Acme_Corp.AU")!, /^acme-corp-au-[0-9a-f]{8}$/);
  assert.equal(accountSegment("../etc"), null, "not a safe segment");
  assert.ok(accountSegment("x".repeat(80))!.length <= 40, "room left for the prefix in 63");
  assert.equal(searchName("matt"), "foldrun-search-matt");
  assert.match(searchUrl("matt"), /^http:\/\/foldrun-search-matt\.foldrun-runs\.svc\.cluster\.local:8080$/);
});

test("the pod is the shared deployment's spec, labelled for one account, small, non-root", () => {
  const pod = searchPodManifest("acme", new Date("2026-09-06T10:00:00Z")) as Any;
  assert.equal(pod.metadata.name, "foldrun-search-acme");
  assert.equal(pod.metadata.namespace, "foldrun-runs");
  assert.deepEqual(pod.metadata.labels, { app: SEARCH_APP, [ACCOUNT_LABEL]: "acme" });
  assert.equal(pod.metadata.annotations["foldrun.io/last-used"], "2026-09-06T10:00:00.000Z");
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.equal(pod.spec.securityContext.runAsNonRoot, true);
  assert.equal(pod.spec.runtimeClassName, undefined, "no RuntimeClass configured, none asked for");
  const c = pod.spec.containers[0];
  assert.match(c.image, /^docker\.io\/searxng\/searxng@sha256:/, "pinned by digest");
  assert.equal(c.resources.requests.memory, "256Mi");
  assert.deepEqual(c.securityContext.capabilities, { drop: ["ALL"] });
  // The signing key is per pod and random — two pods never share one.
  const secret = (m: Any) => m.spec.containers[0].env.find((e: Any) => e.name === "SEARXNG_SECRET").value;
  assert.notEqual(secret(pod), secret(searchPodManifest("acme") as Any));
  assert.equal(secret(pod).length, 64);
  // Settings come from the ConfigMap the worker also applies.
  assert.equal(pod.spec.volumes[0].configMap.name, (settingsConfigMap() as Any).metadata.name);
  assert.match((settingsConfigMap() as Any).data["settings.yml"], /default_lang: "en-AU"/);
});

test("the search pod runs on the same RuntimeClass as a run pod — it fetches model-directed URLs", () => {
  const prev = process.env.FOLDRUN_RUNNER_RUNTIME;
  process.env.FOLDRUN_RUNNER_RUNTIME = "gvisor";
  try {
    const pod = searchPodManifest("acme") as Any;
    assert.equal(pod.spec.runtimeClassName, "gvisor");
    // The RuntimeClass carries the nodeSelector: same class, same nodes
    // as every run pod, never the platform's own.
    const run = runPodManifest("p", "img", "run-1", "small", undefined, "acme") as Any;
    assert.equal(run.spec.runtimeClassName, pod.spec.runtimeClassName);
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_RUNNER_RUNTIME;
    else process.env.FOLDRUN_RUNNER_RUNTIME = prev;
  }
});

test("the Service selects exactly that account's pod", () => {
  const svc = searchServiceManifest("acme") as Any;
  assert.equal(svc.metadata.name, "foldrun-search-acme");
  assert.deepEqual(svc.spec.selector, { app: SEARCH_APP, [ACCOUNT_LABEL]: "acme" });
  assert.equal(svc.spec.ports[0].port, 8080);
});

test("isolation: this account's run pods may reach this account's search pod, and the label is on the run pod", () => {
  const [fromRuns, own] = searchPolicyManifests("acme") as Any[];
  // Enforced from the run pod's side: the short-lived source selects the
  // long-lived destination (the lag lesson in searxng.yaml).
  assert.deepEqual(fromRuns.spec.podSelector.matchLabels, { app: "foldrun-run", [ACCOUNT_LABEL]: "acme" });
  assert.deepEqual(fromRuns.spec.policyTypes, ["Egress"]);
  assert.deepEqual(fromRuns.spec.egress[0].to[0].podSelector.matchLabels, { app: SEARCH_APP, [ACCOUNT_LABEL]: "acme" });
  assert.equal(fromRuns.spec.egress[0].ports[0].port, 8080);
  // The search pod's own policy: ingress from this account's run pods only
  // (a selector, never a CIDR: Cilium does not match pods by CIDR), egress
  // to the internet and DNS, private space excepted.
  assert.deepEqual(own.spec.podSelector.matchLabels, { app: SEARCH_APP, [ACCOUNT_LABEL]: "acme" });
  assert.deepEqual(own.spec.ingress[0].from[0].podSelector.matchLabels, { app: "foldrun-run", [ACCOUNT_LABEL]: "acme" });
  assert.equal(own.spec.ingress[0].ports[0].port, 8080);
  assert.ok(own.spec.egress[0].to[0].ipBlock.except.includes("169.254.0.0/16"), "metadata endpoint blocked");
  // And the run pod actually carries the label the first policy selects on.
  const run = runPodManifest("r", "img", "run-1", "small", undefined, "acme") as Any;
  assert.equal(run.metadata.labels[ACCOUNT_LABEL], "acme");
  const noTenant = runPodManifest("r", "img") as Any;
  assert.equal(noTenant.metadata.labels[ACCOUNT_LABEL], undefined, "no tenant, no label, no door");
});

test("the switch needs both the flag and k8s isolation", () => {
  const prev = [process.env.FOLDRUN_SEARCH_PER_ACCOUNT, process.env.FOLDRUN_RUN_ISOLATION];
  try {
    process.env.FOLDRUN_SEARCH_PER_ACCOUNT = "1";
    process.env.FOLDRUN_RUN_ISOLATION = "container";
    assert.equal(perAccountSearchEnabled(), false);
    process.env.FOLDRUN_RUN_ISOLATION = "k8s";
    assert.equal(perAccountSearchEnabled(), true);
    delete process.env.FOLDRUN_SEARCH_PER_ACCOUNT;
    assert.equal(perAccountSearchEnabled(), false);
  } finally {
    for (const [k, v] of [["FOLDRUN_SEARCH_PER_ACCOUNT", prev[0]], ["FOLDRUN_RUN_ISOLATION", prev[1]]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("idle means unused past the window AND no run pod alive for the account", () => {
  const now = Date.parse("2026-09-06T12:00:00Z");
  const min = 60_000;
  const pods = [
    { name: "foldrun-search-a", seg: "a", createdAt: "2026-09-06T10:00:00Z", lastUsed: "2026-09-06T11:30:00Z" }, // 30 min idle
    { name: "foldrun-search-b", seg: "b", createdAt: "2026-09-06T10:00:00Z", lastUsed: "2026-09-06T11:50:00Z" }, // 10 min idle
    { name: "foldrun-search-c", seg: "c", createdAt: "2026-09-06T10:00:00Z", lastUsed: "2026-09-06T11:00:00Z" }, // idle, but a step is running
  ];
  const idle = idleSearchPods(pods, new Set(["c"]), now, 15 * min).map((p) => p.seg);
  assert.deepEqual(idle, ["a"]);
  assert.deepEqual(idleSearchPods(pods, new Set(), now, 5 * min).map((p) => p.seg), ["a", "b", "c"]);
});

test("a reaped pod is one ledger line: small compute plus bytes, once", { skip: needsBilling }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-search-ledger-"));
  const prev = Object.fromEntries(["FOLDRUN_DATA", "FOLDRUN_BILLING", "FOLDRUN_COMPUTE_USD_PER_SEC", "FOLDRUN_NET_USD_PER_GB", "FOLDRUN_MIN_RUN_FEE"].map((k) => [k, process.env[k]]));
  try {
    process.env.FOLDRUN_DATA = root;
    fs.mkdirSync(path.join(root, "acme/workspaces"), { recursive: true });
    process.env.FOLDRUN_BILLING = "1";
    process.env.FOLDRUN_COMPUTE_USD_PER_SEC = "0.001";
    process.env.FOLDRUN_NET_USD_PER_GB = "0.10";
    process.env.FOLDRUN_MIN_RUN_FEE = "0.000001";
    const session = { podName: "foldrun-search-acme", secs: 1234.4, netBytes: 512 * 1024 * 1024, from: "2026-09-06T10:00:00Z" };
    const e = await recordSearchSession("acme", session);
    assert.ok(e);
    assert.equal(e!.kind, "adjustment");
    // 1235 s × $0.001 + 0.5 GB × $0.10 = 1.235 + 0.05
    assert.equal(e!.usd, -1.285);
    assert.equal(e!.cost, 0, "nothing was bought from a provider");
    assert.deepEqual(e!.meter, { steps: 0, computeSecs: 1235, netBytes: 512 * 1024 * 1024 });
    assert.match(e!.note!, /^search foldrun-search-acme 1235s 512\.0MB since 2026-09-06T10:00:00Z$/);
    assert.equal(await recordSearchSession("acme", session), null, "the same pod session is not billed twice");
    assert.equal((await readLedger("acme")).length, 1);
    // A later pod of the same name (the account came back) is a new line.
    const again = await recordSearchSession("acme", { ...session, from: "2026-09-06T14:00:00Z" });
    assert.ok(again);
    assert.equal((await readLedger("acme")).length, 2);
    // Billing off: nothing written, ever.
    delete process.env.FOLDRUN_BILLING;
    assert.equal(await recordSearchSession("acme", { ...session, from: "2026-09-06T16:00:00Z" }), null);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v as string;
    }
  }
});

test("the engines that answer from the box are switched on, and the junk ones are not", () => {
  const yml = (settingsConfigMap() as Any).data["settings.yml"] as string;
  for (const on of ["yandex", "naver"]) {
    assert.match(yml, new RegExp(`- name: ${on}\\n\\s+disabled: false`), `${on} is enabled`);
  }
  for (const off of ["bing", "wiby", "searchmysite"]) {
    assert.doesNotMatch(yml, new RegExp(`- name: ${off}\\b`), `${off} is left at the image's default (off)`);
  }
});
