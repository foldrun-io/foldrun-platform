// Per-account browser pods: the objects the worker applies, the rule that
// reaps them, the ledger line each leaves, and the tool's decision to use
// one. No cluster and no browser — the parts that touch kubectl and
// Playwright are thin, and what they are given is what is tested here.
//
//   node --test tests/browser-k8s.test.ts
import { test } from "node:test";
import { needsBilling } from "./needs-billing.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { NETWORK_LABEL, TEST_RUN_LABEL } from "../src/account-pod.ts";
import { TEST_LABEL } from "../src/run-k8s.ts";
import {
  BROWSER,
  BROWSER_APP,
  BROWSER_PORT,
  browserImage,
  browserName,
  browserPodManifest,
  browserPolicyManifests,
  browserServiceManifest,
  browserWs,
  perAccountBrowserEnabled,
} from "../src/browser-k8s.ts";
import { ACCOUNT_LABEL, idleAccountPods } from "../src/account-pod.ts";
import { SEARCH, searchPolicyManifests } from "../src/search-k8s.ts";
import { readLedger, recordAccountPodSession } from "../src/ledger.ts";
import { GALLERY } from "../src/gallery.ts";

type Any = Record<string, any>;

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v as string;
    }
  };
  const r = fn();
  return r instanceof Promise ? r.finally(restore) : (restore(), r);
}

test("the pod is the runner image started as a Playwright server, as the agent user, on the run pods' RuntimeClass", () => {
  withEnv({ FOLDRUN_RUNNER_IMAGE: "localhost:5000/foldrun-runner:abc", FOLDRUN_BROWSER_IMAGE: undefined, FOLDRUN_RUNNER_RUNTIME: "gvisor" }, () => {
    const pod = browserPodManifest("acme", new Date("2026-09-15T10:00:00Z")) as Any;
    assert.equal(pod.metadata.name, "foldrun-browser-acme");
    assert.equal(pod.metadata.namespace, "foldrun-runs");
    assert.deepEqual(pod.metadata.labels, { app: BROWSER_APP, [ACCOUNT_LABEL]: "acme" });
    assert.equal(pod.metadata.annotations["foldrun.io/last-used"], "2026-09-15T10:00:00.000Z");
    assert.equal(pod.spec.restartPolicy, "Always", "a service, not a step");
    // Playwright's server closes its browsers on SIGTERM and keeps serving
    // new sessions until SIGKILL: a deleted pod must reach SIGKILL quickly.
    assert.equal(pod.spec.terminationGracePeriodSeconds, 2, "a deleted pod stops serving in seconds, not the default 30");
    assert.equal(pod.spec.automountServiceAccountToken, false);
    assert.equal(pod.spec.runtimeClassName, "gvisor", "the same sandbox a run pod gets");
    assert.equal(pod.spec.securityContext.runAsNonRoot, true);
    assert.equal(pod.spec.securityContext.runAsUser, 10001, "the runner image's agent user");
    const c = pod.spec.containers[0];
    // The one image guaranteed to carry the client's Playwright version.
    assert.equal(c.image, "localhost:5000/foldrun-runner:abc");
    assert.equal(c.command[0], "sh", "a screen first, then the server");
    assert.match(c.command[2], /^Xvfb :99 .* & exec "\$@"$/, "the screen for headless: false, and the server takes over the process");
    assert.ok(c.env.some((e: { name: string; value: string }) => e.name === "DISPLAY" && e.value === ":99"), "a windowed browser finds the screen");
    const node = c.command.indexOf("node");
    assert.deepEqual(c.command.slice(node, node + 3), ["node", "/usr/local/lib/node_modules/playwright/cli.js", "run-server"]);
    assert.ok(c.command.includes("--unsafe"), "without it the server drops the tool's Chromium args");
    assert.ok(c.command.includes("--host") && c.command[c.command.indexOf("--host") + 1] === "0.0.0.0", "binds every interface; the policy decides who may connect");
    assert.equal(c.command[c.command.indexOf("--port") + 1], String(BROWSER_PORT));
    assert.equal(c.ports[0].containerPort, 3000);
    assert.deepEqual(c.securityContext.capabilities, { drop: ["ALL"] });
    assert.equal(c.securityContext.allowPrivilegeEscalation, false);
    // Capped everywhere: cpu, memory and node disk.
    assert.equal(c.resources.limits.memory, "3Gi");
    assert.ok(c.resources.limits["ephemeral-storage"]);
    assert.equal(c.readinessProbe.tcpSocket.port, 3000);
    // Chromium wants a real /dev/shm; memory-backed and capped.
    const shm = pod.spec.volumes.find((v: Any) => v.name === "shm");
    assert.deepEqual(shm.emptyDir, { medium: "Memory", sizeLimit: "1Gi" });
    assert.ok(c.volumeMounts.some((m: Any) => m.mountPath === "/dev/shm"));
  });
  // Without a RuntimeClass configured the field is simply absent.
  withEnv({ FOLDRUN_RUNNER_RUNTIME: undefined }, () => {
    assert.equal((browserPodManifest("acme") as Any).spec.runtimeClassName, undefined);
  });
});

test("the image is the runner's unless deliberately overridden", () => {
  withEnv({ FOLDRUN_RUNNER_IMAGE: "r:1", FOLDRUN_BROWSER_IMAGE: undefined }, () => assert.equal(browserImage(), "r:1"));
  withEnv({ FOLDRUN_RUNNER_IMAGE: "r:1", FOLDRUN_BROWSER_IMAGE: "b:2" }, () => assert.equal(browserImage(), "b:2"));
  withEnv({ FOLDRUN_RUNNER_IMAGE: undefined, FOLDRUN_BROWSER_IMAGE: undefined }, () => assert.equal(browserImage(), ""));
});

test("the address is a ws:// endpoint on the account's Service, and the Service selects exactly that pod", () => {
  assert.equal(browserName("acme"), "foldrun-browser-acme");
  assert.equal(browserWs("acme"), "ws://foldrun-browser-acme.foldrun-runs.svc.cluster.local:3000/");
  const svc = browserServiceManifest("acme") as Any;
  assert.equal(svc.metadata.name, "foldrun-browser-acme");
  assert.deepEqual(svc.spec.selector, { app: BROWSER_APP, [ACCOUNT_LABEL]: "acme" });
  assert.deepEqual(svc.spec.ports[0], { port: 3000, targetPort: 3000 });
});

test("isolation: this account's run pods reach this account's browser on 3000; the pod reaches the world, never the cluster, LAN or metadata", () => {
  const [fromRuns, own] = browserPolicyManifests("acme") as Any[];
  assert.equal(fromRuns.metadata.name, "foldrun-browser-acme-from-runs");
  assert.deepEqual(fromRuns.spec.podSelector.matchLabels, { app: "foldrun-run", [ACCOUNT_LABEL]: "acme" });
  assert.deepEqual(fromRuns.spec.policyTypes, ["Egress"]);
  assert.deepEqual(fromRuns.spec.egress[0].to[0].podSelector.matchLabels, { app: BROWSER_APP, [ACCOUNT_LABEL]: "acme" });
  assert.deepEqual(fromRuns.spec.egress[0].ports, [{ protocol: "TCP", port: 3000 }]);
  // Ingress by selector only — Cilium never matches a pod by CIDR.
  assert.deepEqual(own.spec.podSelector.matchLabels, { app: BROWSER_APP, [ACCOUNT_LABEL]: "acme" });
  assert.deepEqual(own.spec.policyTypes, ["Ingress", "Egress"]);
  assert.equal(own.spec.ingress.length, 1);
  assert.deepEqual(own.spec.ingress[0].from.map((p: Any) => p.podSelector.matchLabels), [{ app: "foldrun-run", [ACCOUNT_LABEL]: "acme" }]);
  assert.deepEqual(own.spec.ingress[0].ports, [{ protocol: "TCP", port: 3000 }]);
  // Egress: exactly the run pod's shape — the world minus private space, plus DNS by selector.
  const world = own.spec.egress[0].to[0].ipBlock;
  assert.equal(world.cidr, "0.0.0.0/0");
  assert.deepEqual(world.except, ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10"]);
  const dns = own.spec.egress[1];
  assert.deepEqual(dns.to[0].podSelector.matchLabels, { "k8s-app": "kube-dns" });
  assert.deepEqual(dns.ports.map((p: Any) => p.port), [53, 53]);
  for (const rule of [...own.spec.ingress, ...(own.spec.egress as Any[])]) {
    for (const peer of [...(rule.from ?? []), ...(rule.to ?? [])]) {
      if (peer.ipBlock) assert.equal(peer.ipBlock.cidr, "0.0.0.0/0", "an ipBlock only ever names the world");
    }
  }
  // Search and browser are the same policy shape with the kind's labels and port swapped.
  const [, searchOwn] = searchPolicyManifests("acme") as Any[];
  assert.deepEqual(searchOwn.spec.egress, own.spec.egress);
  assert.equal(SEARCH.port, 8080);
  assert.equal(BROWSER.port, 3000);
});

test("a test run's pod reaches neither side of the browser policy; it still reaches search", () => {
  const notFiltered = { key: "foldrun.io/network", operator: "NotIn", values: ["filtered"] };
  const notTest = [notFiltered, { key: "foldrun.io/test", operator: "NotIn", values: ["true"] }];
  assert.equal(TEST_RUN_LABEL, TEST_LABEL, "the label the run pod carries is the one the policy excludes");
  const [fromRuns, own] = browserPolicyManifests("acme") as Any[];
  assert.deepEqual(fromRuns.spec.podSelector.matchExpressions, notTest, "a test run's egress policy does not open the browser");
  assert.deepEqual(own.spec.ingress[0].from[0].podSelector.matchExpressions, notTest, "and the browser does not let one in");
  const [searchFrom, searchOwn] = searchPolicyManifests("acme") as Any[];
  assert.deepEqual(searchFrom.spec.podSelector.matchExpressions, [notFiltered], "search is a read; a test run may ask it");
  assert.deepEqual(searchOwn.spec.ingress[0].from[0].podSelector.matchExpressions, [notFiltered]);
});

test("a pod whose network: is filtered reaches no account pod: a browser or a search engine is the world", () => {
  assert.equal(NETWORK_LABEL, "foldrun.io/network");
  for (const [fromRuns, own] of [browserPolicyManifests("acme"), searchPolicyManifests("acme")] as Any[][]) {
    for (const sel of [fromRuns.spec.podSelector, own.spec.ingress[0].from[0].podSelector]) {
      assert.ok(sel.matchExpressions.some((e: Any) => e.key === NETWORK_LABEL && e.operator === "NotIn" && e.values.includes("filtered")));
    }
  }
});

test("the switch needs both the flag and k8s isolation", () => {
  withEnv({ FOLDRUN_BROWSER_PER_ACCOUNT: "1", FOLDRUN_RUN_ISOLATION: "container" }, () => assert.equal(perAccountBrowserEnabled(), false));
  withEnv({ FOLDRUN_BROWSER_PER_ACCOUNT: "1", FOLDRUN_RUN_ISOLATION: "k8s" }, () => assert.equal(perAccountBrowserEnabled(), true));
  withEnv({ FOLDRUN_BROWSER_PER_ACCOUNT: undefined, FOLDRUN_RUN_ISOLATION: "k8s" }, () => assert.equal(perAccountBrowserEnabled(), false));
  assert.equal(BROWSER.enabled, perAccountBrowserEnabled);
});

test("idle is one rule for every kind: unused past the window AND no run pod alive; the browser's window is its own", () => {
  const now = Date.parse("2026-09-15T12:00:00Z");
  const min = 60_000;
  const pods = [
    { name: "foldrun-browser-a", seg: "a", createdAt: "2026-09-15T10:00:00Z", lastUsed: "2026-09-15T11:30:00Z" }, // 30 min idle
    { name: "foldrun-browser-b", seg: "b", createdAt: "2026-09-15T10:00:00Z", lastUsed: "2026-09-15T11:50:00Z" }, // 10 min idle
    { name: "foldrun-browser-c", seg: "c", createdAt: "2026-09-15T10:00:00Z", lastUsed: "2026-09-15T11:00:00Z" }, // idle, but a step is running
  ];
  assert.deepEqual(idleAccountPods(pods, new Set(["c"]), now, 15 * min).map((p) => p.seg), ["a"]);
  assert.deepEqual(idleAccountPods(pods, new Set(), now, 5 * min).map((p) => p.seg), ["a", "b", "c"]);
  withEnv({ FOLDRUN_BROWSER_IDLE_MS: undefined }, () => assert.equal(BROWSER.idleMs(), 15 * min));
  withEnv({ FOLDRUN_BROWSER_IDLE_MS: "60000" }, () => assert.equal(BROWSER.idleMs(), min));
});

test("a reaped browser pod is one ledger line: default-size compute plus bytes, once, named by kind", { skip: needsBilling }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-browser-ledger-"));
  await withEnv(
    { FOLDRUN_DATA: root, FOLDRUN_BILLING: "1", FOLDRUN_COMPUTE_USD_PER_SEC: "0.001", FOLDRUN_NET_USD_PER_GB: "0.10", FOLDRUN_MIN_RUN_FEE: "0.000001" },
    async () => {
      fs.mkdirSync(path.join(root, "acme/workspaces"), { recursive: true });
      const session = { kind: "browser", podName: "foldrun-browser-acme", secs: 600, netBytes: 256 * 1024 * 1024, from: "2026-09-15T10:00:00Z" };
      const e = await recordAccountPodSession("acme", session);
      assert.ok(e);
      assert.equal(e!.kind, "adjustment");
      // 600 s × $0.001 + 0.25 GB × $0.10
      assert.equal(e!.usd, -(0.6 + 0.025));
      assert.equal(e!.cost, 0, "nothing was bought from a provider");
      assert.deepEqual(e!.meter, { steps: 0, computeSecs: 600, netBytes: 256 * 1024 * 1024 });
      assert.match(e!.note!, /^browser foldrun-browser-acme 600s 256\.0MB since 2026-09-15T10:00:00Z$/);
      assert.equal(await recordAccountPodSession("acme", session), null, "the same pod session is not billed twice");
      // A search pod of the same account at the same moment is a different line.
      assert.ok(await recordAccountPodSession("acme", { ...session, kind: "search", podName: "foldrun-search-acme", small: true }));
      assert.equal((await readLedger("acme")).length, 2);
    },
  );
});

// ------------------------------------------------------------------ the tool

/** The tool's decision function, lifted out of the program and run alone. */
function remoteBrowserPlan(): (env: Record<string, string | undefined>, browser: string) => { remote: boolean; ws?: string; reason?: string } {
  const src = GALLERY.find((t) => t.name === "web")!.extra!.find((f) => f.file === "web/browse.mjs")!.content;
  const m = src.match(/function remoteBrowserPlan\([\s\S]*?\n\}\n/);
  assert.ok(m, "the program has a remoteBrowserPlan function");
  return vm.runInNewContext(`${m![0]}; remoteBrowserPlan`, {});
}

test("the tool uses the account pod for every engine, only when handed a ws:// address, and says why not otherwise", () => {
  const plan = remoteBrowserPlan();
  // Objects born in the other context have another Object prototype, so
  // compare fields, not structure.
  const off = plan({}, "chromium");
  assert.equal(off.remote, false);
  assert.equal(off.reason, "no account browser pod (FOLDRUN_BROWSER_WS unset)");
  assert.equal(plan({ FOLDRUN_BROWSER_WS: "   " }, "chromium").remote, false);
  const on = plan({ FOLDRUN_BROWSER_WS: "ws://foldrun-browser-acme.foldrun-runs.svc.cluster.local:3000/" }, "chromium");
  assert.equal(on.remote, true);
  assert.equal(on.ws, "ws://foldrun-browser-acme.foldrun-runs.svc.cluster.local:3000/?browser=chromium", "the server is told which engine to launch");
  assert.equal(plan({ FOLDRUN_BROWSER_WS: "ws://h:3000/?x=1" }, "chromium").ws, "ws://h:3000/?x=1&browser=chromium");
  // Firefox and WebKit take the same path — one rule, every engine, so
  // "where did this render" is never a question you have to test for.
  for (const other of ["firefox", "webkit"]) {
    const r = plan({ FOLDRUN_BROWSER_WS: "ws://h:3000/" }, other);
    assert.equal(r.remote, true, `${other} is served by the account pod`);
    assert.equal(r.ws, `ws://h:3000/?browser=${other}`, "the server is told which engine to launch");
  }
  // Chrome is a channel of chromium: the pod's server only knows chromium,
  // firefox and webkit, and browser=chrome failed every pod call (1 Oct).
  // The channel rides in the launch options header.
  const chrome = plan({ FOLDRUN_BROWSER_WS: "ws://h:3000/" }, "chrome");
  assert.equal(chrome.remote, true);
  assert.equal(chrome.ws, "ws://h:3000/?browser=chromium", "Chrome asks the pod for chromium");
  // An address that is not a websocket is refused, not guessed at.
  assert.match(plan({ FOLDRUN_BROWSER_WS: "http://h:3000/" }, "chromium").reason!, /not a ws:\/\/ address/);
});

test("the program connects with the launch options in the header, falls back in-pod on failure, and keeps a remote session as storage state", () => {
  const src = GALLERY.find((t) => t.name === "web")!.extra!.find((f) => f.file === "web/browse.mjs")!.content;
  assert.match(src, /engine\.connect\(plan\.ws, \{ headers: \{ "x-playwright-launch-options": JSON\.stringify\(launchOptions\) \}/,
    "the engine the call asked for is the one the pod launches");
  assert.match(src, /running \$\{values\.browser\} inside the step/, "a pod that cannot be reached is said, by engine name");
  assert.match(src, /storage-state\.json/);
  assert.match(src, /context\.storageState\(\{ path: stateFile \}\)/, "the session is saved for the next call");
  assert.match(src, /p\.video\(\)\.saveAs\(videoName\(i\)\)/, "a remote video streams here; path\\(\\) throws remotely");
  // And the in-pod path is intact for the CLI, compose and the fallback.
  assert.match(src, /engine\.launch\(launchOptions\)/);
  assert.match(src, /engine\.launchPersistentContext\(/);
});
