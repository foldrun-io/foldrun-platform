// FOL-110 phase 3 on the platform's side: a browsing step held to its list
// (core browse-egress.ts, FOLDRUN_BROWSER_CONFINED=1) is handed no account
// pod — its walled pod could reach none, and the account's browser pod has
// the world — its run pod is walled (filtered), a resumed sandbox says when
// its old wall differs, and the web tool's browse program gives the browser
// the forward door as launch options and refuses what cannot go through it.
// No cluster and no browser: what kubectl and Playwright are handed is what
// is tested here (the browser half was run by hand against an auth proxy).
//
//   node --test tests/browse-confine.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accountServiceEnv,
  BROWSER_CONFINED_LINE,
  SEARCH_CONFINED_LINE,
  resumedNetworkLine,
  runPodManifest,
  runnerImageFor,
  wantsFiltered,
} from "../src/run-k8s.ts";
import { NETWORK_LABEL } from "../src/account-pod.ts";
import { confinesBrowsing } from "../src/browse-confine.ts";
import { GALLERY } from "../src/gallery.ts";

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  }
}
const k8s = { FOLDRUN_RUN_ISOLATION: "k8s", FOLDRUN_BROWSER_PER_ACCOUNT: "1", FOLDRUN_SEARCH_PER_ACCOUNT: "1" };

test("the switch: FOLDRUN_BROWSE_ENFORCE=1, the k8s tier and the forward door, all three", () =>
  withEnv({ ...k8s, FOLDRUN_BROWSE_ENFORCE: "1", FOLDRUN_EGRESS_URL: "http://egress:8090", FOLDRUN_EGRESS_FORWARD: undefined }, async () => {
    assert.equal(confinesBrowsing("k8s"), true);
    assert.equal(confinesBrowsing("container"), false, "docker walls nothing");
    await withEnv({ FOLDRUN_BROWSE_ENFORCE: undefined }, () => assert.equal(confinesBrowsing("k8s"), false));
    await withEnv({ FOLDRUN_RUN_ISOLATION: "container" }, () => assert.equal(confinesBrowsing("k8s"), false));
    // No door, no way out of the wall to browse through — and the dashboard,
    // which has no lease to ask, must not claim one (Codex review).
    await withEnv({ FOLDRUN_EGRESS_URL: undefined }, () => assert.equal(confinesBrowsing("k8s"), false));
    await withEnv({ FOLDRUN_EGRESS_FORWARD: "0" }, () => assert.equal(confinesBrowsing("k8s"), false));
  }));

test("a held step starts and addresses no account pod, says so, and runs the full image", () =>
  withEnv(k8s, async () => {
    const lines: string[] = [];
    const r = await accountServiceEnv({
      tenant: "acme",
      scripts: [{ name: "web" }],
      env: { FOLDRUN_BROWSER_CONFINED: "1", FOLDRUN_BROWSER_WS: "ws://leftover:3000/" },
      emit: (l) => lines.push(l),
      deferBrowser: true,
      deferSearch: true,
      ensureBrowser: async () => assert.fail("a walled pod cannot reach the account's browser pod"),
      ensureSearch: async () => assert.fail("…nor its search pod"),
    });
    assert.equal(r.failed, undefined);
    assert.equal(r.env.FOLDRUN_BROWSER_WS, undefined, "a stale address does not survive");
    assert.equal(r.env.FOLDRUN_SEARCH_URL, undefined);
    assert.equal(r.browserReady, undefined);
    assert.equal(r.searchReady, undefined);
    assert.deepEqual(lines, [BROWSER_CONFINED_LINE, SEARCH_CONFINED_LINE]);
    const chosen = runnerImageFor({ scripts: [{ name: "web" }], agentRel: "agents/a", allowed: [] } as never, r.env, () => null);
    assert.notEqual(chosen.variant, "slim", "the browser is in the step, so it needs the image with browsers");
  }));

test("without the flag the same step gets the account's browser pod, as before phase 3", () =>
  withEnv(k8s, async () => {
    const r = await accountServiceEnv({
      tenant: "acme",
      scripts: [{ name: "web" }],
      env: { FOLDRUN_WEB_ACTIONS: "browse" },
      emit: () => undefined,
      ensureBrowser: async () => "ws://foldrun-browser-acme.foldrun-runs.svc.cluster.local:3000/",
    });
    assert.equal(r.env.FOLDRUN_BROWSER_WS, "ws://foldrun-browser-acme.foldrun-runs.svc.cluster.local:3000/");
  }));

test("the wall: an enforced list that is not open labels the pod filtered; the resumed pod's label is the truth", () => {
  assert.equal(wantsFiltered({ level: "trusted", enforced: true }), true);
  assert.equal(wantsFiltered({ level: "none", enforced: true }), true);
  assert.equal(wantsFiltered({ level: "open", enforced: true }), false);
  assert.equal(wantsFiltered({ level: "trusted", enforced: false }), false);
  assert.equal(wantsFiltered(undefined), false);
  const m = runPodManifest("p", "img", "run-1", undefined, 600, "acme", false, true) as { metadata: { labels: Record<string, string> } };
  assert.equal(m.metadata.labels[NETWORK_LABEL], "filtered");
  assert.equal(resumedNetworkLine(true, true), null);
  assert.equal(resumedNetworkLine(false, false), null);
  assert.match(resumedNetworkLine(false, true)!, /made before its step was walled — it is NOT held to its network: list/);
  assert.match(resumedNetworkLine(true, false)!, /keeps that wall/);
});

const browseSrc = () => GALLERY.find((t) => t.name === "web")!.extra!.find((f) => f.file === "web/browse.mjs")!.content;

test("the browse program, held: the forward door as launch options, the credential apart, loopback off the proxy", () => {
  const src = browseSrc();
  assert.match(src, /const CONFINED = process\.env\.FOLDRUN_BROWSER_CONFINED === "1";/);
  assert.match(src, /const door = process\.env\.HTTPS_PROXY \|\| process\.env\.https_proxy/);
  assert.match(src, /confinedProxy = \{ server: `\$\{u\.protocol\}\/\/\$\{u\.host\}`, username: decodeURIComponent\(u\.username\), password: decodeURIComponent\(u\.password\), bypass: SERVICE_SIDE \? "<-loopback>" : "localhost,127\.0\.0\.1,\[::1\]" \};/);
  assert.match(src, /proxy = confinedProxy;/);
  // Never the account pod, never a vendor: the browser is the step's own.
  assert.match(src, /const plan = SERVICE_SIDE \? \{ remote: false, reason: "in the browse service[^"]*" \}\n  : CONFINED \? \{ remote: false, reason: "held to network:/);
  // Chromium: no UDP around the proxy, and the egress CA trusted by its key.
  assert.match(src, /if \(allowedDomains\.length \|\| CONFINED\) launchOptions\.args\.push\("--force-webrtc-ip-handling-policy=disable_non_proxied_udp"\)/);
  assert.match(src, /--ignore-certificate-errors-spki-list=\$\{spki\}/);
  assert.match(src, /publicKey\.export\(\{ type: "spki", format: "der" \}\)/);
});

test("the browse program, held: what cannot go through the door is refused, plainly", () => {
  const src = browseSrc();
  assert.match(src, /proxy=: this step is held to its network: list/);
  assert.match(src, /live: a live session is not held to network: yet/);
  assert.match(src, /browses from its own network, which this step's network: list cannot hold/);
  assert.match(src, /if \(CONFINED\) fail\(`engine \$\{name\}: this step is held to its network: list, and \$\{name\} has no verified way/, "Lightpanda and Obscura: not admitted until verified");
  assert.match(src, /if \(CONFINED && !isChromium && process\.env\.FOLDRUN_EGRESS_CA && !firefoxCaProfile\)/, "an engine that does not trust the proxy's certificate is told so");
  assert.match(src, /has no egress proxy address \(HTTPS_PROXY\) to browse through/);
  // A bound secret's placeholder: fine in a header the proxy fills, refused
  // where the browser itself needs the value.
  assert.match(src, /secretValue\(ref, `referenced by the \$\{name\} header`, \{ placeholderOk: true \}\)/);
  assert.match(src, /refuseBoundPlaceholder\(name, raw, "cookies="\)/);
  assert.match(src, /refuseBoundPlaceholder\(name, raw, "storage="\)/);
});

test("the refusal helper fails only a held step's exact placeholder", () => {
  const src = browseSrc();
  const m = src.match(/function refuseBoundPlaceholder\([\s\S]*?\n\}\n/);
  assert.ok(m);
  // It reads the environment itself: it runs from the first secretValue()
  // call (state_key's check), before `const CONFINED` exists — reading that
  // const there threw a ReferenceError on every state_key call (Codex review).
  assert.doesNotMatch(m![0], /\bCONFINED\b(?! ===)/);
  const run = (confined: boolean, name: string, raw: string) => {
    let failed: string | null = null;
    const prev = process.env.FOLDRUN_BROWSER_CONFINED;
    if (confined) process.env.FOLDRUN_BROWSER_CONFINED = "1";
    else delete process.env.FOLDRUN_BROWSER_CONFINED;
    try {
      new Function("fail", "process", `${m![0]}; refuseBoundPlaceholder(${JSON.stringify(name)}, ${JSON.stringify(raw)}, "auth=");`)((msg: string) => {
        failed = msg;
      }, process);
    } finally {
      if (prev === undefined) delete process.env.FOLDRUN_BROWSER_CONFINED;
      else process.env.FOLDRUN_BROWSER_CONFINED = prev;
    }
    return failed as string | null;
  };
  const first = src.indexOf("secretValue(values.state_key");
  assert.ok(first > 0 && first < src.indexOf("const CONFINED ="), "the first call is before the const — the case the helper must survive");
  assert.match(run(true, "LOGIN", "${LOGIN}")!, /secret LOGIN is bound to sites, so this step holds only its name .* auth= needs the value itself/);
  assert.equal(run(false, "LOGIN", "${LOGIN}"), null, "not held: as before");
  assert.equal(run(true, "LOGIN", "me:pw"), null, "a real value");
  assert.equal(run(true, "LOGIN", "${OTHER}"), null);
});
