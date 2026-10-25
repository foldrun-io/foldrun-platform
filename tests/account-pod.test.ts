// The pool: how many pods an account's demand calls for, how they are
// named, and that both kinds size themselves from their own switches.
//
//   node --test tests/account-pod.test.ts

import { test } from "node:test";
import { needsBilling } from "./needs-billing.ts";
import assert from "node:assert/strict";
import { podsWanted, poolNames, podName, accountSegment, isLabelValue, segmentIndex, stepsDemanding } from "../src/account-pod.ts";
import { BROWSER, browserPodManifest } from "../src/browser-k8s.ts";
import { SEARCH, searchPodManifest } from "../src/search-k8s.ts";

function withEnv<T>(vars: Record<string, string | undefined>, body: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return body();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("the pool grows one pod per `perPod` steps, never past the cap, never below one", () => {
  assert.equal(podsWanted(0, 2, 4), 1, "no demand still means the first pod: the step asking is the demand");
  assert.equal(podsWanted(1, 2, 4), 1);
  assert.equal(podsWanted(2, 2, 4), 1);
  assert.equal(podsWanted(3, 2, 4), 2);
  assert.equal(podsWanted(8, 2, 4), 4);
  assert.equal(podsWanted(50, 2, 4), 4, "the cap holds whatever the fan-out");
  assert.equal(podsWanted(50, 0, 4), 4, "a nonsense per-pod reads as one");
  assert.equal(podsWanted(5, 2, 0), 1, "a nonsense cap still allows the first pod");
});

test("a step whose run pod is live AND asking is one step (FOL-46 starts both together)", () => {
  const eight = Array.from({ length: 8 }, (_, i) => `foldrun-run-${i}`);
  // Eight cold-start steps: pods created, each still asking for search.
  assert.equal(stepsDemanding(new Set(eight), eight), 8);
  assert.equal(podsWanted(stepsDemanding(new Set(eight), eight), SEARCH.stepsPerPod(), 8), 1, "one search pod, not two");
  // An asker that named no pod (or one not created yet) is still demand.
  assert.equal(stepsDemanding(new Set(eight), [...eight, "?1", "foldrun-run-new"]), 10);
  // Steps running without asking count; nothing alive still means one.
  assert.equal(stepsDemanding(new Set(["a", "b"]), []), 2);
  assert.equal(stepsDemanding(new Set(), []), 1);
  // A listing that failed: one step plus whoever is asking.
  assert.equal(stepsDemanding(null, ["?1", "?2"]), 3);
  assert.equal(stepsDemanding(null, []), 1);
});

test("the first pod keeps the bare name the Service and policies use; the rest are numbered", () => {
  assert.deepEqual(poolNames(BROWSER, "acme", 1), ["foldrun-browser-acme"]);
  assert.deepEqual(poolNames(BROWSER, "acme", 3), ["foldrun-browser-acme", "foldrun-browser-acme-1", "foldrun-browser-acme-2"]);
  assert.equal(podName(SEARCH, "acme", 0), "foldrun-search-acme");
  assert.equal(podName(SEARCH, "acme", 2), "foldrun-search-acme-2");
});

test("a numbered pod carries the account's labels, so the Service and both policies select it like the first", () => {
  for (const [manifest, app] of [
    [browserPodManifest("acme", new Date(), "foldrun-browser-acme-2"), "foldrun-browser"],
    [searchPodManifest("acme", new Date(), "foldrun-search-acme-1"), "foldrun-search"],
  ] as const) {
    const m = manifest as { metadata: { name: string; labels: Record<string, string> } };
    assert.match(m.metadata.name, /-[12]$/);
    assert.equal(m.metadata.labels.app, app);
    assert.equal(m.metadata.labels["foldrun.io/account"], "acme");
  }
});

test("each kind sizes its own pool: browsers are heavy and few per pod, search light and many", () => {
  withEnv({ FOLDRUN_BROWSER_STEPS_PER_POD: undefined, FOLDRUN_BROWSER_MAX_PODS: undefined }, () => {
    assert.equal(BROWSER.stepsPerPod(), 2);
    assert.equal(BROWSER.maxPods(), 4);
  });
  withEnv({ FOLDRUN_SEARCH_STEPS_PER_POD: undefined, FOLDRUN_SEARCH_MAX_PODS: undefined }, () => {
    assert.equal(SEARCH.stepsPerPod(), 8);
    assert.equal(SEARCH.maxPods(), 3);
  });
  withEnv({ FOLDRUN_BROWSER_STEPS_PER_POD: "1", FOLDRUN_BROWSER_MAX_PODS: "2" }, () => {
    assert.equal(podsWanted(5, BROWSER.stepsPerPod(), BROWSER.maxPods()), 2);
  });
});

// ------------------------------------------------ the label is one-to-one

test("tenants that fold to the same label get different segments, each a valid label", () => {
  const segs = ["a.b", "a_b", "A-B", "a-b"].map((t) => accountSegment(t)!);
  assert.equal(new Set(segs).size, 4, `every tenant its own segment: ${segs.join(" ")}`);
  for (const s of segs) assert.ok(isLabelValue(s), `${s} is a label value`);
  assert.equal(accountSegment("a-b"), "a-b", "a name the fold leaves alone keeps the bare label the cluster already has");
  assert.equal(accountSegment("acme"), "acme");
  assert.match(accountSegment("Acme")!, /^acme-[0-9a-f]{8}$/, "a folded name carries a hash of the raw one");
  assert.equal(accountSegment("Acme"), accountSegment("Acme"), "and it is stable");
  assert.equal(accountSegment(".."), null, "an unsafe name is still refused");
});

test("a bare name shaped like a hashed one is hashed too, so it can never take another tenant's label", () => {
  // "Acme" folds and becomes acme-<hash("Acme")>. A tenant who signs up as
  // exactly that string passed the fold untouched and kept it bare: the same
  // search pod, Service, NetworkPolicy and runtime cache claim as Acme.
  const hashed = accountSegment("Acme")!;
  const squatter = accountSegment(hashed)!;
  assert.notEqual(squatter, hashed, "the look-alike gets its own label");
  assert.match(squatter, /^acme-[0-9a-f]{8}-[0-9a-f]{8}$/);
  assert.ok(isLabelValue(squatter), squatter);
  assert.equal(accountSegment("shop-2024"), "shop-2024", "only the -<8 hex> tail is taken for a hash; other names stay bare");
  assert.equal(accountSegment("acme-deadbeefx"), "acme-deadbeefx");
});

test("a long tenant name never ends in a dash and never exceeds 40 characters", () => {
  // 39 letters then a dash then more: the old slice(0, 40) cut exactly
  // after the dash, and every run pod for the account failed validation.
  const seg = accountSegment("a".repeat(39) + "-" + "b".repeat(20))!;
  assert.ok(seg.length <= 40, seg);
  assert.ok(!seg.endsWith("-"), seg);
  assert.ok(isLabelValue(seg), seg);
  const other = accountSegment("a".repeat(39) + "-" + "c".repeat(20))!;
  assert.notEqual(seg, other, "two long names with the same prefix are still told apart");
});

test("the reverse lookup matches the exact segment, never a re-fold of the label", () => {
  const tenants = ["a.b", "a_b", "a-b", "acme"];
  const tenantOf = segmentIndex(tenants);
  for (const t of tenants) assert.equal(tenantOf(accountSegment(t)!), t);
  assert.equal(tenantOf("a-b-deadbeef"), null, "a label nobody owns maps to no one, so nobody is billed for it");
});

// ------------------------------------------------- the reaper's one listing

test("a reap pass lists run pods once, bills each reaped pod once, and a second pass over the same pods bills nothing", { skip: needsBilling }, async () => {
  const fsMod = await import("node:fs");
  const osMod = await import("node:os");
  const pathMod = await import("node:path");
  const { reapIdleAccountPods, busyAccountSegments } = await import("../src/account-pod.ts");
  const { SEARCH } = await import("../src/search-k8s.ts");
  const { readLedger } = await import("../src/ledger.ts");
  const root = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "foldrun-reap-"));
  const log = pathMod.join(root, "calls.log");
  const fake = pathMod.join(root, "kubectl");
  const old = new Date(Date.now() - 3600_000).toISOString();
  // Three search pods: acme's (idle), acme's second (idle), beta's (idle but
  // beta has a run pod alive). The run-pod listing names beta only.
  fsMod.writeFileSync(fake, `#!/bin/sh
echo "$@" >> "${log}"
case "$1 $6" in
  "get app=foldrun-run,foldrun.io/account") printf 'beta\\n' ;;
  "get app=foldrun-search") printf 'foldrun-search-acme\\tacme\\t${old}\\t${old}\\nfoldrun-search-acme-1\\tacme\\t${old}\\t${old}\\nfoldrun-search-beta\\tbeta\\t${old}\\t${old}\\n' ;;
esac
case "$1" in exec) printf 'eth0: 1048576 0 0 0 0 0 0 0 1048576 0\\n' ;; esac
`, { mode: 0o755 });
  const prev = Object.fromEntries(["FOLDRUN_KUBECTL", "FOLDRUN_RUN_ISOLATION", "FOLDRUN_SEARCH_PER_ACCOUNT", "FOLDRUN_DATA", "FOLDRUN_BILLING", "FOLDRUN_COMPUTE_USD_PER_SEC", "FOLDRUN_REDIS_URL"].map((k) => [k, process.env[k]]));
  Object.assign(process.env, { FOLDRUN_KUBECTL: fake, FOLDRUN_RUN_ISOLATION: "k8s", FOLDRUN_SEARCH_PER_ACCOUNT: "1", FOLDRUN_DATA: root, FOLDRUN_BILLING: "1", FOLDRUN_COMPUTE_USD_PER_SEC: "0.001" });
  delete process.env.FOLDRUN_REDIS_URL;
  try {
    fsMod.mkdirSync(pathMod.join(root, "acme/workspaces"), { recursive: true });
    fsMod.mkdirSync(pathMod.join(root, "beta/workspaces"), { recursive: true });
    const busy = await busyAccountSegments();
    assert.deepEqual([...busy!], ["beta"]);
    const reaped = await reapIdleAccountPods(SEARCH, (s) => s, busy);
    assert.equal(reaped, 2, "acme's two idle pods; beta's is guarded by its run pod");
    const calls = fsMod.readFileSync(log, "utf8").split("\n").filter(Boolean);
    assert.equal(calls.filter((c) => c.includes("app=foldrun-run,")).length, 1, "the run pods were listed ONCE for the pass");
    assert.equal(calls.filter((c) => c.startsWith("get pods") && c.includes("app=foldrun-search")).length, 1, "and the kind's pods once");
    assert.equal(calls.filter((c) => c.startsWith("delete pod ")).length, 2);
    assert.ok(calls.some((c) => c.startsWith("delete service foldrun-search-acme ")), "acme has no search pod left: its Service goes, read off the listing");
    assert.ok(!calls.some((c) => c.includes("delete service foldrun-search-beta")));
    const lines = await readLedger("acme");
    assert.equal(lines.length, 2, "one line per reaped pod");
    assert.ok(lines.every((e) => e.key?.startsWith("pod:search:foldrun-search-acme")));
    // The same pass again — a lease handover, a second pod's reaper on the
    // same listing — deletes again (harmless) and bills nothing.
    await reapIdleAccountPods(SEARCH, (s) => s, busy);
    assert.equal((await readLedger("acme")).length, 2);
    assert.equal(await reapIdleAccountPods(SEARCH, (s) => s, null), 0, "a listing that failed reaps nothing");
  } finally {
    for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v as string);
    fsMod.rmSync(root, { recursive: true, force: true });
  }
});
