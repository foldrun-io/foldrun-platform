// web/browse.mjs on a person's own computer (`foldrun browser`, 17 Nov 2026):
// the CLI runs the gallery's program with FOLDRUN_BROWSER_DESKTOP=1, a live
// root that lasts (FOLDRUN_BROWSER_LIVE_ROOT) and no idle close
// (FOLDRUN_BROWSER_LIVE_IDLE_MS=0).
//
// What it fixes: the container switches (--no-sandbox above all) put Chrome's
// "unsupported command-line flag" bar over the page the person was looking
// at and turned Chrome's sandbox off on their machine; the Windows user agent
// on a Mac was a mismatch sites challenge; the profile lived in the temp
// folder, so sign-ins could vanish; and a 15-minute idle close shut the
// window on a person who had stepped away.
//
//   node --test tests/browse-desktop.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { GALLERY } from "../src/gallery.ts";

const web = GALLERY.find((t) => t.name === "web")!;
const src = web.extra!.find((f) => f.file === "web/browse.mjs")!.content;
const slice = (from: string, to: string) => {
  const a = src.indexOf(from);
  assert.ok(a >= 0, from);
  const b = src.indexOf(to, a);
  assert.ok(b > a, to);
  return src.slice(a, b);
};

/** The Chromium launch switches the program builds, for a given environment. */
function launchArgs(env: Record<string, string>, { webgpu = false } = {}) {
  const body = slice("const DESKTOP = ", "\n  // Chrome is the one engine with a stand-in");
  const run = new Function("process", "isChromium", "values", "launchOptions", "wantsWebmcp", "webgpu", "allowedDomains", "CONFINED", "egressCaSpki",
    `${body}\n  }\n  return launchOptions.args;`);
  return run({ env, platform: "darwin" }, true, { browser: "chrome" }, { headless: true }, false, webgpu, [], false, () => null) as string[];
}

test("in the cloud the container switches stay as they were", () => {
  const args = launchArgs({});
  for (const a of ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled", "--disable-gpu"]) assert.ok(args.includes(a), a);
});

test("on a desktop Chrome starts as Chrome does: sandbox on, GPU on, no flag bar", () => {
  const args = launchArgs({ FOLDRUN_BROWSER_DESKTOP: "1" });
  assert.deepEqual(args, [], "no switch of ours at all");
});

test("on a desktop the window keeps its own size and Chrome its own user agent", () => {
  assert.match(src, /if \(isChromium && !DESKTOP\) launchOptions\.args\.push\("--window-size=1920,1080"\)/);
  assert.match(src, /if \(isChromium && !plan\.remote && !DESKTOP\) contextOptions\.userAgent = desktopUa/);
  assert.match(src, /else if \(!remote && !DESKTOP && !values\.device/);
});

test("a live session's root and idle limit can be set; unset they are what they were", () => {
  const block = slice("const idleSetting = ", "\nconst liveName = ");
  const run = (env: Record<string, string>) =>
    new Function("process", "path", "os", "createHash", "cwd", `${block}\nreturn { LIVE_IDLE_MS, liveRoot };`)(
      { env }, { resolve: (p: string) => `/abs${p}`, join: (...p: string[]) => p.join("/") }, { tmpdir: () => "/tmp" },
      () => ({ update: () => ({ digest: () => "abcdef0123456789" }) }), "/w",
    ) as { LIVE_IDLE_MS: number; liveRoot: string };
  assert.deepEqual(run({}), { LIVE_IDLE_MS: 15 * 60_000, liveRoot: "/tmp/foldrun-live/abcdef012345" });
  assert.deepEqual(run({ FOLDRUN_BROWSER_LIVE_ROOT: "/home/x/.foldrun/browser/chrome", FOLDRUN_BROWSER_LIVE_IDLE_MS: "0" }), { LIVE_IDLE_MS: Infinity, liveRoot: "/abs/home/x/.foldrun/browser/chrome" });
  assert.equal(run({ FOLDRUN_BROWSER_LIVE_IDLE_MS: "60000" }).LIVE_IDLE_MS, 60_000);
  assert.equal(run({ FOLDRUN_BROWSER_LIVE_IDLE_MS: "soon" }).LIVE_IDLE_MS, 15 * 60_000, "a value that is not a number is ignored");
});

test("live=end asks Chrome to close before killing it", () => {
  const end = slice('if (liveArg === "end") {', "\nif (plan.remote) {");
  assert.ok(end.indexOf('send("Browser.close")') >= 0 && end.indexOf('send("Browser.close")') < end.indexOf("killLive(info)"));
});
