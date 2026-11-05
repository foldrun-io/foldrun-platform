// The browse service (FOL-128 phase 2): browse calls of a step that is NOT
// held to its list run outside its sandbox, in a pod of the step's own,
// reached through the egress proxy's /browse/<lease> door; a held step keeps
// its browser in its walled pod (phase 3).
//
// No cluster: what kubectl is handed is checked as data, the service runs
// as a local process, the door is the real egress proxy. The last test runs
// the real browse program through the whole chain — shim, door, service,
// Chromium, forward door — where FOLDRUN_TEST_PLAYWRIGHT names a folder
// whose node_modules holds playwright@1.63 with Chromium installed.
//
//   node --test tests/browse-service.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { BROWSE_SERVICE_ENV, browseDoorUrl, browsePodName, browseServiceOn, leaseHash, leaseTokenOf, parseBrowsePath } from "../src/browse-door.ts";
import { browseHeadlessService, browsePodManifest, browsePolicyManifest, deleteBrowsePod, ensureBrowsePod, galleryBrowseProgram, programConfigMap, sweepOrphanBrowsePods } from "../src/browse-service.ts";
import { accountServiceEnv, BROWSE_SERVICE_LINE, BROWSE_SERVICE_UNAVAILABLE, runnerImageFor } from "../src/run-k8s.ts";
import { egressHooks, startEgressProxy, stopEgressProxy } from "../src/egress-proxy.ts";
import { GALLERY } from "../src/gallery.ts";

process.env.FOLDRUN_SECRET_KEY ??= "browse-service-test-key";

const SERVICE = fileURLToPathSafe(new URL("../src/browse-service.mjs", import.meta.url));
function fileURLToPathSafe(u: URL) { return decodeURIComponent(u.pathname); }
const web = GALLERY.find((t) => t.name === "web")!;
const program = (file: string) => (file === "web/run.mjs" ? web.wrapper!.content : web.extra!.find((f) => f.file === file)!.content);

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  }
}
const freePort = () => new Promise<number>((ok) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => ok(p)); }); });
const TOKEN = "tok_abcdefghijklmnopqrstuvwxyz012345";
const ON = { FOLDRUN_BROWSE_SERVICE: "1", FOLDRUN_RUN_ISOLATION: "k8s", FOLDRUN_EGRESS_URL: "http://egress:8090", FOLDRUN_EGRESS_FORWARD: undefined };

// ------------------------------------------------------------- names, switch

test("the switch needs the k8s tier and the forward door; names come from the lease's hash", () =>
  withEnv(ON, async () => {
    assert.equal(browseServiceOn(), true);
    await withEnv({ FOLDRUN_BROWSE_SERVICE: undefined }, () => assert.equal(browseServiceOn(), false));
    await withEnv({ FOLDRUN_RUN_ISOLATION: "container" }, () => assert.equal(browseServiceOn(), false));
    await withEnv({ FOLDRUN_EGRESS_FORWARD: "0" }, () => assert.equal(browseServiceOn(), false));
    assert.equal(browsePodName(TOKEN), `foldrun-browse-${leaseHash(TOKEN).slice(0, 16)}`);
    assert.ok(!browsePodName(TOKEN).includes(TOKEN.slice(4, 20)), "never the token itself");
    assert.equal(leaseTokenOf(`http://egress:8090/e/${TOKEN}`), TOKEN);
    assert.equal(browseDoorUrl(`http://egress:8090/e/${TOKEN}`), `http://egress:8090/browse/${TOKEN}`);
    assert.deepEqual(parseBrowsePath(`/browse/${TOKEN}`), { token: TOKEN });
    assert.equal(parseBrowsePath(`/browse/${TOKEN}/x`), null);
    assert.equal(parseBrowsePath("/browse/short"), null);
  }));

// --------------------------------------------------------- who gets the door

const base = { tenant: "acme", scripts: [{ name: "web" }], pod: "foldrun-run-abc", emit: () => undefined };
const egressEnv = { FOLDRUN_EGRESS: `http://egress:8090/e/${TOKEN}`, FOLDRUN_WEB_ACTIONS: "browse" };

test("a step that is not held gets its door, a pod of its own, no account browser pod — and the full image", () =>
  withEnv({ ...ON, FOLDRUN_BROWSER_PER_ACCOUNT: "1" }, async () => {
    const lines: string[] = [];
    const asked: unknown[] = [];
    const r = await accountServiceEnv({
      ...base,
      env: { ...egressEnv, FOLDRUN_BROWSER_WS: "ws://leftover:3000/" },
      emit: (l) => lines.push(l),
      deferBrowser: true,
      deadlineSec: 600,
      ensureBrowser: async () => assert.fail("the account's browser pod is not used beside the service"),
      ensureBrowse: async (o) => { asked.push(o); return true; },
    });
    assert.equal(r.env[BROWSE_SERVICE_ENV], `http://egress:8090/browse/${TOKEN}`);
    assert.equal(r.env.FOLDRUN_BROWSER_WS, undefined);
    assert.deepEqual(await r.browserReady!.then((x) => x.url), r.env[BROWSE_SERVICE_ENV]);
    assert.deepEqual(asked, [{ token: TOKEN, tenant: "acme", runPod: "foldrun-run-abc", deadlineSec: 600 }]);
    assert.ok(lines.includes(BROWSE_SERVICE_LINE));
    const chosen = runnerImageFor({ scripts: [{ name: "web" }], agentRel: "agents/a", allowed: [] } as never, r.env, () => null);
    assert.notEqual(chosen.variant, "slim", "a call the service does not serve runs in the step");
  }));

test("inline, a pod that cannot be had leaves the step browsing in its sandbox, said", () =>
  withEnv(ON, async () => {
    const lines: string[] = [];
    const r = await accountServiceEnv({ ...base, env: { ...egressEnv }, emit: (l) => lines.push(l), ensureBrowse: async () => false });
    assert.equal(r.env[BROWSE_SERVICE_ENV], undefined);
    assert.ok(lines.includes(BROWSE_SERVICE_UNAVAILABLE));
  }));

test("never for a held step, a vendor, a test run, the switch off, or a step that does not browse", () =>
  withEnv(ON, async () => {
    const never = async () => assert.fail("no browse pod");
    const cases: [string, Parameters<typeof accountServiceEnv>[0]][] = [
      ["held", { ...base, env: { ...egressEnv, FOLDRUN_BROWSER_CONFINED: "1" }, ensureBrowse: never }],
      ["vendor", { ...base, env: { ...egressEnv, FOLDRUN_BROWSER_VENDOR: "browserbase" }, ensureBrowse: never }],
      ["test", { ...base, test: true, env: { ...egressEnv }, ensureBrowse: never }],
      ["no browse", { ...base, env: { ...egressEnv, FOLDRUN_WEB_ACTIONS: "search,fetch" }, ensureBrowse: never }],
      ["no lease", { ...base, env: { FOLDRUN_WEB_ACTIONS: "browse" }, ensureBrowse: never }],
      ["planted", { ...base, env: { ...egressEnv, FOLDRUN_BROWSER_CONFINED: "1", [BROWSE_SERVICE_ENV]: "http://evil/" }, ensureBrowse: never }],
    ];
    for (const [what, o] of cases) {
      const r = await accountServiceEnv(o);
      assert.equal(r.env[BROWSE_SERVICE_ENV], undefined, what);
    }
    await withEnv({ FOLDRUN_BROWSE_SERVICE: undefined }, async () => {
      const r = await accountServiceEnv({ ...base, env: { ...egressEnv }, ensureBrowse: never });
      assert.equal(r.env[BROWSE_SERVICE_ENV], undefined, "switch off");
    });
  }));

// ------------------------------------------------------------- the k8s objects

test("the pod: the lease's hash not its token, no service account token, walled by its own policy", () =>
  withEnv({ FOLDRUN_RUNNER_IMAGE: "runner:full", FOLDRUN_RUNNER_RUNTIME: "gvisor", FOLDRUN_EGRESS_URL: "http://foldrun-egress.foldrun.svc.cluster.local:8090" }, () => {
    const pod = browsePodManifest({ token: TOKEN, seg: "acme", runPod: "foldrun-run-abc", configMap: "foldrun-browse-program-x", deadlineSec: 900 }) as any;
    const text = JSON.stringify(pod);
    assert.ok(!text.includes(TOKEN), "the token never sits in the cluster's objects");
    assert.equal(pod.metadata.labels["foldrun.io/run-pod"], "foldrun-run-abc");
    assert.equal(pod.spec.automountServiceAccountToken, false);
    assert.equal(pod.spec.runtimeClassName, "gvisor");
    assert.equal(pod.spec.activeDeadlineSeconds, 900);
    assert.equal(pod.spec.hostname, browsePodName(TOKEN));
    assert.equal(pod.spec.subdomain, "foldrun-browse");
    const c = pod.spec.containers[0];
    assert.equal(c.image, "runner:full", "the runner image: no image of its own");
    assert.equal(c.securityContext.readOnlyRootFilesystem, true);
    const env = Object.fromEntries(c.env.map((e: any) => [e.name, e.value]));
    assert.equal(env.FOLDRUN_BROWSE_LEASE_ID, leaseHash(TOKEN));
    assert.ok(c.volumeMounts.some((m: any) => m.name === "program" && m.readOnly));
    const pol = browsePolicyManifest() as any;
    assert.deepEqual(pol.spec.policyTypes, ["Ingress", "Egress"]);
    assert.deepEqual(pol.spec.ingress[0].ports, [{ protocol: "TCP", port: 3100 }]);
    const apps = (rule: any) => rule.map((p: any) => p.podSelector.matchLabels.app).sort();
    assert.deepEqual(apps(pol.spec.ingress[0].from), ["foldrun-egress", "foldrun-worker"], "only the proxy knocks");
    assert.deepEqual(apps(pol.spec.egress[0].to), ["foldrun-egress", "foldrun-worker"]);
    assert.deepEqual(pol.spec.egress[0].ports, [{ protocol: "TCP", port: 8090 }]);
    assert.equal(pol.spec.egress.length, 2, "the proxy and DNS, nothing else");
    assert.ok(!JSON.stringify(pol).includes("ipBlock"), "no address range: never the world");
    assert.equal((browseHeadlessService() as any).spec.clusterIP, "None");
  }));

test("the program is the gallery's, in a ConfigMap named by its content", () => {
  const cm = programConfigMap() as any;
  assert.equal(cm.data["browse.mjs"], galleryBrowseProgram());
  assert.equal(cm.data["browse.mjs"], program("web/browse.mjs"));
  assert.match(cm.data["service.mjs"], /FOLDRUN_BROWSE_LEASE_ID/);
  assert.match(cm.metadata.name, /^foldrun-browse-program-[0-9a-f]{10}$/);
  assert.ok(Buffer.byteLength(JSON.stringify(cm.data)) < 1_000_000, "under a ConfigMap's 1 MiB");
});

// A kubectl that records what it is asked and answers from a script.
function fakeKubectl(dir: string, answers: string): { calls: () => { args: string[]; input: string }[] } {
  const log = path.join(dir, "calls.jsonl");
  const bin = path.join(dir, "kubectl");
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs");
let input = ""; try { input = fs.readFileSync(0, "utf8"); } catch {}
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input }) + "\\n");
${answers}
`, { mode: 0o755 });
  return { calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []) };
}

test("ensure: program (server-side), policy before pod, owner = the run pod; delete bills; the sweep takes orphans", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browse-kc-"));
  const k = fakeKubectl(dir, `
const a = args.join(" ");
if (a.startsWith("get configmap")) process.exit(1);
if (a.startsWith("get pod foldrun-run-abc")) { process.stdout.write("0a1b2c3d-0000-4000-8000-000000000001"); process.exit(0); }
if (a.startsWith("get pod foldrun-browse-")) { process.stdout.write(new Date(Date.now() - 60000).toISOString() + "\\t"); process.exit(0); }
if (a.startsWith("get pods -n foldrun-runs -l app=foldrun-browse -o jsonpath={range .items[*]}{.metadata.name}")) { process.stdout.write("foldrun-browse-orphan\\tfoldrun-run-gone\\tacme\\t2020-01-01T00:00:00Z\\t\\nfoldrun-browse-live\\tfoldrun-run-live\\tacme\\t2020-01-01T00:00:00Z\\t\\nfoldrun-browse-done\\tfoldrun-run-done\\tacme\\t2020-01-01T00:00:00Z\\t\\n"); process.exit(0); }
if (a.startsWith("get pods -n foldrun-runs -l app=foldrun-run ")) { process.stdout.write("foldrun-run-live\\tRunning\\nfoldrun-run-done\\tSucceeded\\n"); process.exit(0); }
process.exit(0);
`);
  try {
    await withEnv({ FOLDRUN_KUBECTL: path.join(dir, "kubectl"), FOLDRUN_RUNNER_IMAGE: "runner:full", FOLDRUN_RUN_ISOLATION: "k8s", FOLDRUN_EGRESS_URL: "http://egress:8090" }, async () => {
      const lines: string[] = [];
      assert.equal(await ensureBrowsePod({ token: TOKEN, tenant: "acme", runPod: "foldrun-run-abc", deadlineSec: 300 }, (l) => lines.push(l)), true, lines.join("\n"));
      const calls = k.calls();
      const ssa = calls.find((c) => c.args.includes("--server-side"))!;
      assert.ok(ssa, "the program goes server-side");
      assert.match(JSON.parse(ssa.input).metadata.name, /^foldrun-browse-program-/);
      const apply = calls.find((c) => c.args[0] === "apply" && !c.args.includes("--server-side"))!;
      const kinds = apply.input.split("\n---\n").map((d) => JSON.parse(d));
      assert.deepEqual(kinds.map((o) => o.kind), ["NetworkPolicy", "Service", "Pod"], "walled from its first packet");
      assert.deepEqual(kinds[2].metadata.ownerReferences, [{ apiVersion: "v1", kind: "Pod", name: "foldrun-run-abc", uid: "0a1b2c3d-0000-4000-8000-000000000001", blockOwnerDeletion: false }]);
      assert.ok(!apply.input.includes(TOKEN), "no token in what the cluster stores");
      assert.ok(calls.some((c) => c.args[0] === "wait" && c.args.includes(`pod/${browsePodName(TOKEN)}`)));
      await deleteBrowsePod(TOKEN, "acme");
      assert.ok(k.calls().some((c) => c.args[0] === "delete" && c.args.includes(browsePodName(TOKEN))));
      const swept = await sweepOrphanBrowsePods((seg) => seg);
      assert.equal(swept, 2, "the orphan and the one whose run pod finished; not the live one");
      const deleted = k.calls().filter((c) => c.args[0] === "delete" && c.args[1] === "pod").map((c) => c.args[2]);
      assert.ok(deleted.includes("foldrun-browse-orphan") && deleted.includes("foldrun-browse-done") && !deleted.includes("foldrun-browse-live"));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the service

async function startService(env: Record<string, string>): Promise<{ port: number; child: ChildProcess; stop: () => void }> {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVICE], { env: { PATH: process.env.PATH!, HOME: os.tmpdir(), FOLDRUN_BROWSE_PORT: String(port), ...env }, stdio: ["ignore", "ignore", "pipe"] });
  for (let i = 0; i < 100; i++) {
    const up = await new Promise((ok) => { const c = net.connect(port, "127.0.0.1"); c.once("connect", () => { c.destroy(); ok(true); }); c.once("error", () => ok(false)); });
    if (up) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return { port, child, stop: () => child.kill("SIGKILL") };
}

/** One call, its NDJSON read back. */
async function callService(port: number, token: string, body: unknown) {
  const r = await fetch(`http://127.0.0.1:${port}/call`, { method: "POST", headers: { "content-type": "application/json", "x-foldrun-lease": token }, body: JSON.stringify(body) });
  const text = await r.text();
  if (r.status !== 200) return { status: r.status, error: JSON.parse(text).error.message as string };
  const lines = text.trim().split("\n").map((l) => JSON.parse(l));
  const dec = (t: string) => lines.filter((l) => l.t === t).map((l) => Buffer.from(l.d, "base64").toString()).join("");
  return {
    status: 200,
    out: dec("out"),
    err: dec("err"),
    files: Object.fromEntries(lines.filter((l) => l.t === "file").map((l) => [l.path, Buffer.from(l.d, "base64").toString()])),
    exit: lines.find((l) => l.t === "exit")?.code as number | undefined,
  };
}

// A stand-in for browse.mjs: prints its env and reads an input, writes outputs.
const STUB = `
import fs from "node:fs";
const pick = (k) => process.env[k] ?? null;
console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: Object.fromEntries(["NODE_OPTIONS","LD_PRELOAD","MY_COOKIES","FOLDRUN_BROWSER_WS","FOLDRUN_BROWSER_HEADLESS","FOLDRUN_BROWSER_CONFINED","FOLDRUN_BROWSE_SERVICE_SIDE","HTTPS_PROXY","FOLDRUN_EGRESS","PLAYWRIGHT_BROWSERS_PATH","FOLDRUN_BROWSER_EXTENSIONS"].map((k) => [k, pick(k)])) }));
fs.mkdirSync("outputs", { recursive: true });
fs.writeFileSync("outputs/page.png", "PNG" + fs.readFileSync("../../storage/in.txt", "utf8"));
fs.mkdirSync("../../state/browser", { recursive: true });
fs.writeFileSync("../../state/browser/login.json", "{}");
try { fs.symlinkSync("/etc/passwd", "outputs/link"); } catch {}
console.error("stub done");
process.exit(3);
`;

test("the service: its lease only, the platform's program only, a filtered env, files in and out", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browse-svc-"));
  const stub = path.join(dir, "browse.mjs");
  fs.writeFileSync(stub, STUB);
  const sha = crypto.createHash("sha256").update(STUB).digest("hex");
  const svc = await startService({ FOLDRUN_BROWSE_LEASE_ID: leaseHash(TOKEN), FOLDRUN_BROWSE_EGRESS: "http://egress.example:8090", FOLDRUN_BROWSE_PROGRAM: stub, FOLDRUN_BROWSE_SCRATCH: path.join(dir, "scratch") });
  try {
    const call = { argv: ["--url", "https://example.com/"], cwd: "agents/a", sha, env: { MY_COOKIES: "sid=1", NODE_OPTIONS: "--require /x.js", LD_PRELOAD: "/x.so", FOLDRUN_BROWSER_WS: "ws://x", FOLDRUN_BROWSER_HEADLESS: "0", PLAYWRIGHT_BROWSERS_PATH: "/x", FOLDRUN_BROWSER_EXTENSIONS: "x" }, files: [{ path: "storage/in.txt", data: Buffer.from("hello").toString("base64") }] };
    assert.equal((await callService(svc.port, "tok_another_lease_0000000000000", call)).status, 403, "another lease");
    assert.equal((await callService(svc.port, TOKEN, { ...call, sha: "0".repeat(64) })).status, 409, "a customised copy runs in the step");
    for (const bad of ["../x", "/etc/x", "a/../../x", "node_modules/playwright/index.js", "a//b"]) {
      const r = await callService(svc.port, TOKEN, { ...call, files: [{ path: bad, data: "" }] });
      assert.equal(r.status, 400, bad);
    }
    assert.equal((await callService(svc.port, TOKEN, { ...call, cwd: "../x" })).status, 400);
    const r = await callService(svc.port, TOKEN, call);
    assert.equal(r.status, 200);
    assert.equal(r.exit, 3, "the program's own exit code");
    assert.match(r.err!, /stub done/);
    const seen = JSON.parse(r.out!.trim());
    assert.deepEqual(seen.argv, ["--url", "https://example.com/"]);
    assert.ok(seen.cwd.endsWith(path.join("w", "agents", "a")));
    assert.equal(seen.env.MY_COOKIES, "sid=1", "a secret the call names");
    assert.equal(seen.env.FOLDRUN_BROWSER_HEADLESS, "0", "a browse setting");
    for (const k of ["NODE_OPTIONS", "LD_PRELOAD", "FOLDRUN_BROWSER_WS", "PLAYWRIGHT_BROWSERS_PATH", "FOLDRUN_BROWSER_EXTENSIONS"]) assert.equal(seen.env[k], null, k);
    assert.equal(seen.env.FOLDRUN_BROWSER_CONFINED, "1");
    assert.equal(seen.env.FOLDRUN_BROWSE_SERVICE_SIDE, "1");
    assert.equal(seen.env.HTTPS_PROXY, `http://foldrun:${TOKEN}@egress.example:8090`, "the step's own lease is its browser's proxy password");
    assert.equal(seen.env.FOLDRUN_EGRESS, `http://egress.example:8090/e/${TOKEN}`, "live view frames under the lease");
    assert.equal(r.files!["agents/a/outputs/page.png"], "PNGhello");
    assert.equal(r.files!["state/browser/login.json"], "{}");
    assert.equal(r.files!["storage/in.txt"], undefined, "an input it did not change does not come back");
    assert.ok(!Object.keys(r.files!).some((f) => f.endsWith("link")), "a symlink never comes back");
    assert.deepEqual(fs.readdirSync(path.join(dir, "scratch")), [], "scratch is gone after the call");
  } finally {
    svc.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ the door

async function withProxy<T>(fn: (port: number) => Promise<T>): Promise<T> {
  const proxy = await startEgressProxy(0);
  process.env.FOLDRUN_EGRESS_URL = `http://127.0.0.1:${proxy.port}`;
  try {
    return await fn(proxy.port);
  } finally {
    await stopEgressProxy();
    delete process.env.FOLDRUN_EGRESS_URL;
  }
}

test("the door: a live, non-test, non-held lease reaches its own pod — named by the lease, never the request", async () => {
  const seen: { lease?: string; path?: string; ca?: string }[] = [];
  const fake = http.createServer((req, res) => {
    seen.push({ lease: String(req.headers["x-foldrun-lease"]), path: req.url, ca: String(req.headers["x-foldrun-egress-ca"] ?? "") });
    req.resume();
    req.on("end", () => { res.writeHead(200, { "content-type": "application/x-ndjson" }); res.end('{"t":"start"}\n{"t":"exit","code":0}\n'); });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  const fakePort = (fake.address() as net.AddressInfo).port;
  try {
    await withEnv({ FOLDRUN_BROWSE_SERVICE: "1", FOLDRUN_BROWSE_SERVICE_ADDR: `127.0.0.1:${fakePort}`, FOLDRUN_BROWSE_ENFORCE: "1", FOLDRUN_NETWORK_ENFORCE: undefined }, () =>
      withProxy(async (port) => {
        const post = (token: string) => fetch(`http://127.0.0.1:${port}/browse/${token}`, { method: "POST", body: "{}" });
        const open = (await egressHooks.lease({ tenant: "acme", runId: "run-b1", grant: { secrets: {}, network: { level: "open", hosts: [] } } }))!;
        const token = leaseTokenOf(open.url)!;
        const ok = await post(token);
        assert.equal(ok.status, 200);
        assert.match(await ok.text(), /"exit"/);
        assert.equal(seen.at(-1)!.lease, token);
        assert.equal(seen.at(-1)!.path, "/call");
        assert.match(Buffer.from(seen.at(-1)!.ca!, "base64").toString(), /BEGIN CERTIFICATE/);
        assert.equal((await post("tok_no_such_lease_0000000000000")).status, 401);
        const test = (await egressHooks.lease({ tenant: "acme", runId: "run-b2", grant: { secrets: {}, network: { level: "open", hosts: [] } }, test: true }))!;
        assert.equal((await post(leaseTokenOf(test.url)!)).status, 403, "a test run");
        const held = (await egressHooks.lease({ tenant: "acme", runId: "run-b3", grant: { secrets: {}, network: { level: "trusted", hosts: [] }, enforce: true } }))!;
        const refused = await post(leaseTokenOf(held.url)!);
        assert.equal(refused.status, 403, "a held step's browser stays in its walled pod");
        assert.match((await refused.json()).error.message, /held to its network/);
        assert.equal((await fetch(`http://127.0.0.1:${port}/browse/${token}`)).status, 405);
        await withEnv({ FOLDRUN_BROWSE_SERVICE: undefined }, async () => assert.equal((await post(token)).status, 404, "switch off"));
        await withEnv({ FOLDRUN_BROWSE_SERVICE_ADDR: `127.0.0.1:${await freePort()}` }, async () => {
          const r = await post(token);
          assert.equal(r.status, 503, "no pod: the shim browses in the step");
        });
        for (const l of [open, test, held]) await l.release();
      }));
  } finally {
    fake.close();
  }
});

// ------------------------------------------------------------------ the shim

async function loadShim(dir: string) {
  const f = path.join(dir, "browse-remote.mjs");
  fs.writeFileSync(f, program("web/browse-remote.mjs"));
  return import(f) as Promise<{ notServed: (a: string[], e: Record<string, string>) => string | null; inputsOf: (a: string[], cwd: string, root: string, e: Record<string, string>) => string[]; plainPath: (root: string, rel: string) => string | null; envOf: (a: string[], e: Record<string, string>) => Record<string, string> }>;
}

test("the shim: what it leaves to the step, what files and env it sends", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browse-shim-"));
  try {
    const shim = await loadShim(dir);
    const u = ["--url", "https://example.com/"];
    assert.equal(shim.notServed(u, {}), null);
    assert.match(shim.notServed(u, { FOLDRUN_BROWSER_CONFINED: "1" })!, /held/);
    assert.match(shim.notServed(u, { FOLDRUN_BROWSER_VENDOR: "steel" })!, /vendor/);
    assert.match(shim.notServed([...u, "--browser", "firefox"], {})!, /firefox/);
    assert.match(shim.notServed([...u, "--engine=lightpanda"], {})!, /lightpanda/);
    assert.equal(shim.notServed([...u, "--browser", "chrome"], {}), null);
    assert.match(shim.notServed([...u, "--live", "true"], {})!, /live/);
    assert.match(shim.notServed([...u, "--proxy", "MY_PROXY"], {})!, /proxy/);
    assert.match(shim.notServed(u, { FOLDRUN_BROWSER_EXTENSIONS: "ext/a" })!, /extensions/);
    assert.match(shim.notServed(["--url", "http://127.0.0.1:3000/"], {})!, /this machine/);
    assert.match(shim.notServed(["--url", "http://localhost:3000/"], {})!, /this machine/);
    assert.match(shim.notServed([...u, "--identity", "au"], { FOLDRUN_BROWSER_IDENTITIES: JSON.stringify({ au: { proxy: "AU_PROXY" } }) })!, /proxy/);

    const root = path.join(dir, "ws");
    const cwd = path.join(root, "agents", "a");
    fs.mkdirSync(path.join(cwd, "outputs", ".browser", "s1"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "outputs", ".browser", "s1", "Default"), { recursive: true });
    fs.writeFileSync(path.join(root, "AGENTS.md"), "");
    fs.writeFileSync(path.join(cwd, "outputs", ".browser", "refs.json"), "{}");
    fs.writeFileSync(path.join(cwd, "outputs", ".browser", "s1", "storage-state.json"), "{}");
    fs.writeFileSync(path.join(cwd, "outputs", ".browser", "s1", "Default", "Cookies"), "profile");
    fs.mkdirSync(path.join(root, "storage"));
    fs.writeFileSync(path.join(root, "storage", "cv.pdf"), "pdf");
    fs.writeFileSync(path.join(cwd, "mock.json"), "{}");
    fs.mkdirSync(path.join(root, "state", "browser"), { recursive: true });
    fs.writeFileSync(path.join(root, "state", "browser", "login.json"), "{}");
    fs.writeFileSync(path.join(root, "state", "browser", "other.json"), "{}");
    fs.symlinkSync("/etc/passwd", path.join(root, "storage", "evil"));
    const actions = JSON.stringify([{ upload: "#f", file: "workspace/storage/cv.pdf" }, { mock: "**/api", file: "mock.json" }, { upload: "#g", file: "workspace/storage/evil" }]);
    const got = shim.inputsOf([...u, "--actions", actions, "--state", "login"], cwd, root, {}).sort();
    assert.deepEqual(got, ["agents/a/mock.json", "agents/a/outputs/.browser/refs.json", "agents/a/outputs/.browser/s1/storage-state.json", "state/browser/login.json", "storage/cv.pdf"], "a symlink is not read; a full profile is not sent; only the named login");
    assert.equal(shim.plainPath(root, "storage/evil"), null);
    assert.equal(shim.plainPath(root, "../x"), null);
    assert.ok(shim.plainPath(root, "storage/cv.pdf"));
    const env = shim.envOf([...u, "--cookies", "SITE_COOKIES"], { SITE_COOKIES: "a=b", OTHER_SECRET: "x", FOLDRUN_BROWSER_HEADLESS: "0", FOLDRUN_BROWSER_STATE_KEY: "STATE_KEY", STATE_KEY: "k", FOLDRUN_BROWSER_WS: "ws://x", FOLDRUN_MODEL_KEY: "m", PATH: "/bin" });
    assert.deepEqual(env, { SITE_COOKIES: "a=b", FOLDRUN_BROWSER_HEADLESS: "0", FOLDRUN_BROWSER_STATE_KEY: "STATE_KEY", STATE_KEY: "k" }, "only what the call names");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the shim never browses again in the step once the call may have started there", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browse-replay-"));
  const f = path.join(dir, "browse-remote.mjs");
  fs.writeFileSync(f, program("web/browse-remote.mjs"));
  fs.writeFileSync(path.join(dir, "browse.mjs"), "x");
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "");
  const { browseViaService } = await import(f) as { browseViaService: (a: string[], p: string, o: { env: Record<string, string>; cwd: string }) => Promise<boolean> };
  // A server that takes the call and hangs up without a word.
  const rude = net.createServer((s) => s.once("data", () => s.destroy()));
  await new Promise<void>((r) => rude.listen(0, "127.0.0.1", r));
  const prev = process.exitCode;
  const errWrite = process.stderr.write.bind(process.stderr);
  let said = "";
  (process.stderr as any).write = (c: unknown) => { said += String(c); return true; };
  try {
    const argv = ["--url", "https://example.com/"];
    const refused = await browseViaService(argv, path.join(dir, "browse.mjs"), { env: { FOLDRUN_BROWSE_SERVICE: `http://127.0.0.1:${await freePort()}/browse/${TOKEN}` }, cwd: dir });
    assert.equal(refused, false, "never connected: nothing ran, the step browses itself");
    const cut = await browseViaService(argv, path.join(dir, "browse.mjs"), { env: { FOLDRUN_BROWSE_SERVICE: `http://127.0.0.1:${(rude.address() as net.AddressInfo).port}/browse/${TOKEN}` }, cwd: dir });
    assert.equal(cut, true, "connected, then cut: not done again");
    assert.equal(process.exitCode, 1);
    assert.match(said, /may have acted/);
  } finally {
    (process.stderr as any).write = errWrite;
    process.exitCode = prev;
    rude.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("run.mjs hands a browse call to the shim only when the platform set the door, and the shim is a gallery file", () => {
  const run = program("web/run.mjs");
  assert.match(run, /process\.env\.FOLDRUN_BROWSE_SERVICE\)/);
  assert.match(run, /import\("\.\/browse-remote\.mjs"\)/);
  assert.ok(web.extra!.some((f) => f.file === "web/browse-remote.mjs"));
  // Service side: session as storage state, loopback through the proxy.
  const b = program("web/browse.mjs");
  assert.match(b, /bypass: SERVICE_SIDE \? "<-loopback>"/);
  assert.match(b, /\(remote \|\| SERVICE_SIDE\) && stateFile/);
  assert.match(b, /version must be a plain label/);
});

// ------------------------------------------- the whole chain, real Chromium

const PW = process.env.FOLDRUN_TEST_PLAYWRIGHT;
test("real Playwright: the browse action suite through shim → door → service → Chromium → forward door", { skip: !PW && "set FOLDRUN_TEST_PLAYWRIGHT", timeout: 300_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(PW!, "browse-svc-real-"));
  // The tool, as the step has it; the service's own copy beside Playwright
  // (browse.mjs finds Playwright from its own location).
  const tools = path.join(dir, "tools", "web");
  fs.mkdirSync(tools, { recursive: true });
  fs.writeFileSync(path.join(tools, "run.mjs"), program("web/run.mjs"));
  fs.writeFileSync(path.join(tools, "browse.mjs"), program("web/browse.mjs"));
  fs.writeFileSync(path.join(tools, "browse-remote.mjs"), program("web/browse-remote.mjs"));
  const svcProgram = path.join(dir, "svc-browse.mjs");
  fs.writeFileSync(svcProgram, program("web/browse.mjs"));
  const ws = path.join(dir, "ws");
  const agent = path.join(ws, "agents", "a");
  fs.mkdirSync(path.join(ws, "storage"), { recursive: true });
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "# t\n");
  fs.writeFileSync(path.join(ws, "storage", "up.txt"), "uploaded-bytes");

  const pages = http.createServer((req, res) => {
    const u = new URL(req.url!, "http://x");
    if (u.pathname === "/file") { res.setHeader("content-type", "text/csv"); res.setHeader("content-disposition", 'attachment; filename="d.csv"'); return res.end("a,b\n1,2\n"); }
    if (u.pathname === "/up" && req.method === "POST") { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { res.setHeader("content-type", "text/html"); res.end(`<p id=r>${b.includes("uploaded-bytes") ? "GOT-UPLOAD" : "NO"}</p>`); }); return; }
    res.setHeader("content-type", "text/html");
    res.setHeader("set-cookie", "sid=kept; Path=/");
    res.end(`<html><head><title>T</title></head><body><h1>hello service</h1><p>cookie:${req.headers.cookie ?? ""}</p>
      <input id=q><button id=b onclick="document.querySelector('#o').textContent='typed:'+document.querySelector('#q').value">Go</button><p id=o></p>
      <a href="/file" id=dl>download</a>
      <form action="/up" method=post enctype="multipart/form-data"><input type=file id=f name=f><button id=s>send</button></form></body></html>`);
  });
  await new Promise<void>((r) => pages.listen(0, "127.0.0.1", r));
  const page = `http://127.0.0.1:${(pages.address() as net.AddressInfo).port}/`;
  let svc: Awaited<ReturnType<typeof startService>> | null = null;
  try {
    await withEnv({ FOLDRUN_BROWSE_SERVICE: "1", FOLDRUN_EGRESS_ALLOW_PRIVATE: "1", FOLDRUN_NETWORK_ENFORCE: undefined }, () =>
      withProxy(async (port) => {
        const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-real", grant: { secrets: {}, network: { level: "open", hosts: [] } } }))!;
        const token = leaseTokenOf(lease.url)!;
        svc = await startService({
          FOLDRUN_BROWSE_LEASE_ID: leaseHash(token),
          FOLDRUN_BROWSE_EGRESS: `http://127.0.0.1:${port}`,
          FOLDRUN_BROWSE_PROGRAM: svcProgram,
          FOLDRUN_BROWSE_SCRATCH: path.join(dir, "scratch"),
          ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}),
        });
        process.env.FOLDRUN_BROWSE_SERVICE_ADDR = `127.0.0.1:${svc.port}`;
        const call = (args: string[], extra: Record<string, string> = {}) => new Promise<{ code: number | null; out: string; err: string }>((ok) => {
          const c = spawn(process.execPath, [path.join(tools, "run.mjs"), "--action", "browse", ...args], {
            cwd: agent,
            env: { PATH: process.env.PATH!, HOME: os.tmpdir(), FOLDRUN_BROWSE_SERVICE: browseDoorUrl(lease.url)!, FOLDRUN_BROWSE_SERVICE_LOCAL: "1", FOLDRUN_EGRESS: lease.url, FOLDRUN_AGENT: "a", ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}), ...extra },
          });
          let out = "";
          let err = "";
          c.stdout.on("data", (d) => (out += d));
          c.stderr.on("data", (d) => (err += d));
          c.on("close", (code) => ok({ code, out, err }));
        });
        const viaService = (r: { err: string }) => assert.match(r.err, /in foldrun's browse service/, r.err);

        const text = await call(["--url", page]);
        assert.equal(text.code, 0, text.err);
        viaService(text);
        assert.match(text.out, /hello service/, text.err);

        const md = await call(["--url", page, "--mode", "markdown"]);
        assert.match(md.out, /# hello service/);

        const shot = await call(["--url", page, "--mode", "screenshot"]);
        assert.equal(shot.code, 0, shot.err);
        assert.equal(fs.readFileSync(path.join(agent, "outputs", "page.png")).subarray(1, 4).toString(), "PNG", "the artifact came back to the step");

        const acts = await call(["--url", page, "--actions", JSON.stringify([{ fill: "#q", text: "abc" }, { click: "#b" }, { get: "#o", what: "text" }])]);
        assert.equal(acts.code, 0, acts.err);
        assert.match(acts.out, /typed:abc/);

        const up = await call(["--url", page, "--actions", JSON.stringify([{ upload: "#f", file: "workspace/storage/up.txt" }, { click: "#s" }, { wait: "#r" }]), "--mode", "text"]);
        assert.equal(up.code, 0, up.err);
        assert.match(up.out, /GOT-UPLOAD/, "the upload's bytes went in from the step's workspace");

        const dl = await call(["--url", page, "--actions", JSON.stringify([{ download: "#dl", to: "outputs/d.csv" }])]);
        assert.equal(dl.code, 0, dl.err);
        assert.equal(fs.readFileSync(path.join(agent, "outputs", "d.csv"), "utf8"), "a,b\n1,2\n");

        const pdf = await call(["--url", page, "--actions", JSON.stringify([{ pdf: "outputs/p.pdf" }])]);
        assert.equal(pdf.code, 0, pdf.err);
        assert.equal(fs.readFileSync(path.join(agent, "outputs", "p.pdf")).subarray(0, 4).toString(), "%PDF");

        // A session carries across calls, as storage state the step keeps.
        await call(["--url", page, "--session", "s"]);
        assert.ok(fs.existsSync(path.join(agent, "outputs", ".browser", "s", "storage-state.json")));
        const again = await call(["--url", page, "--session", "s"]);
        assert.match(again.out, /cookie:sid=kept/, again.err);

        // A saved login lands in the workspace's state/.
        const st = await call(["--url", page, "--state", "site"]);
        assert.equal(st.code, 0, st.err);
        assert.ok(fs.existsSync(path.join(ws, "state", "browser", "site.json")));

        // aria numbers, then one used by the next call.
        const aria = await call(["--url", page, "--mode", "aria", "--interactive", "true"]);
        const ref = aria.out.match(/button "Go" \[ref=(e\d+)\]/)?.[1];
        assert.ok(ref, aria.out);
        const byRef = await call(["--url", page, "--actions", JSON.stringify([{ fill: "#q", text: "ref" }, { click: `@${ref}` }, { get: "#o", what: "text" }])]);
        assert.equal(byRef.code, 0, byRef.err);
        assert.match(byRef.out, /typed:ref/);

        // Script in the page, a recording, a HAR, a diff against the last read.
        const js = await call(["--url", page, "--js", "document.title + '-' + location.pathname"]);
        assert.equal(js.code, 0, js.err);
        assert.match(js.out, /T-\//);
        const rec = await call(["--url", page, "--video", "outputs/v.webm", "--har", "outputs/n.har"]);
        assert.equal(rec.code, 0, rec.err);
        assert.ok(fs.statSync(path.join(agent, "outputs", "v.webm")).size > 0, "the video came back");
        assert.match(fs.readFileSync(path.join(agent, "outputs", "n.har"), "utf8"), /"entries"/);
        const d1 = await call(["--url", page, "--mode", "diff"]);
        assert.equal(d1.code, 0, d1.err);
        const d2 = await call(["--url", page, "--mode", "diff"]);
        assert.equal(d2.code, 0, d2.err);
        assert.ok(fs.readdirSync(path.join(ws, "state", "browser", "diff")).length === 1, "the baseline lives in the workspace");
        assert.notEqual(d1.out, d2.out, "the second read is compared with the first");

        // The browser went through the forward door under the step's lease:
        // the proxy's own record of this lease names the page's host.
        const log = JSON.stringify(await lease.drainLog());
        assert.match(log, /127\.0\.0\.1:\d+/, `the forward door saw the pages: ${log.slice(0, 400)}`);
        assert.match(log, /browse service/);

        // A call it does not serve runs in the step, as before.
        const ff = await call(["--url", page, "--browser", "webkit"]);
        assert.match(ff.err, /not used for this call \(engine webkit/);

        // A customised copy of the program runs in the step.
        fs.appendFileSync(path.join(tools, "browse.mjs"), "\n// edited\n");
        const edited = await call(["--url", page]);
        assert.match(edited.err, /differs from the platform's — browsing in the step/);
        assert.match(edited.out, /hello service/, edited.err);
        await lease.release();
      }));
  } finally {
    delete process.env.FOLDRUN_BROWSE_SERVICE_ADDR;
    (svc as { stop: () => void } | null)?.stop();
    pages.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
