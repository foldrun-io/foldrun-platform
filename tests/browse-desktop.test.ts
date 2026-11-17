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
  assert.ok(end.indexOf('send("Browser.close")') >= 0 && end.indexOf('send("Browser.close")') < end.indexOf("await killLive(info, liveDir)"));
});

// A live session's tabs (17 Nov 2026): Claude Code opened a story's comments
// in a new tab, and the next call read and photographed the first tab again —
// each reattach took context.pages()[0], and Chrome lists the tabs in a new
// order on every reattach, so a tab number meant another tab a call later.
const liveTabs = (pages: { url: string; id: string }[], saved: Record<string, unknown>, front: string | null) => {
  const reorder = slice("const liveSaved = live ? readLive(liveMeta) : null;", "\n// And it goes back to the tab in front");
  const pick = slice("async function liveTab(ctx) {", "\nlet page = (live ? await liveTab(context)");
  const ps = pages.map((p) => ({ ...p, url: () => p.url }));
  const context: { pages: () => typeof ps } = { pages: () => ps };
  const targetIdOf = async (p: { id: string }) => p.id;
  const fetchFake = async () => ({ json: async () => (front ? [{ type: "page", id: front }, ...ps.filter((p) => p.id !== front).map((p) => ({ type: "page", id: p.id }))] : []) });
  return new Function("context", "live", "readLive", "liveMeta", "targetIdOf", "fetch", "AbortSignal",
    `return (async () => { ${reorder}\n${pick}\n const page = await liveTab(context); return { order: context.pages().map((p) => p.id), page: page && page.id }; })();`,
  )(context, true, () => ({ endpoint: "http://127.0.0.1:1", ...saved }), "/x/live.json", targetIdOf, front === "down" ? async () => { throw new Error("down"); } : fetchFake, { timeout: () => undefined }) as Promise<{ order: string[]; page: string | null }>;
};

test("a live session keeps its tab numbers: the order a call saw comes back, new tabs after", async () => {
  const r = await liveTabs([{ url: "https://b/", id: "B" }, { url: "https://c/", id: "C" }, { url: "https://a/", id: "A" }], { tabs: ["A", "B"], tab: "B" }, null);
  assert.deepEqual(r.order, ["A", "B", "C"]);
});

test("a live session goes back to the tab in front of the person, else to the one the last call left it on", async () => {
  const tabs = [{ url: "https://a/", id: "A" }, { url: "https://b/", id: "B" }];
  assert.equal((await liveTabs(tabs, { tabs: ["A", "B"], tab: "B" }, "A")).page, "A", "the person clicked tab A while the page was theirs");
  assert.equal((await liveTabs(tabs, { tabs: ["A", "B"], tab: "B" }, "down")).page, "B", "Chrome's list unreadable: the tab the last call was on");
  assert.equal((await liveTabs(tabs, {}, "down")).page, null, "nothing known: the first tab, as before");
});

test("a live session saves its tabs, current tab and labels at the end of every call", () => {
  const end = slice("// A live session remembers its tabs' order", "\nif (failed) process.exit(1);");
  assert.match(end, /info\.tabs = /);
  assert.match(end, /info\.tab = await targetIdOf\(page\)/);
  assert.match(end, /info\.labels = /);
  assert.match(src, /if \(live && liveSaved\?\.labels\)/);
});

test("the Playwright `foldrun browser` installed is loaded ahead of a global one", () => {
  const body = slice("function loadPlaywright() {", "\n// A step that runs out of time").replace("import.meta.url", '"file:///program/browse.mjs"');
  const tried: string[] = [];
  const load = (env: Record<string, string>) => {
    tried.length = 0;
    return new Function("process", "path", "createRequire", "execFileSync", `${body}\nreturn loadPlaywright();`)(
      { env, cwd: () => "/w" },
      { join: (...p: string[]) => p.join("").replace(/\/+/g, "/"), resolve: (p: string) => p },
      (anchor: string) => () => { tried.push(anchor); return { from: anchor }; },
      () => { throw new Error("no npm"); },
    ) as { from: string };
  };
  assert.equal(load({ FOLDRUN_BROWSER_MODULES: "/h/.foldrun/browser" }).from, "/h/.foldrun/browser/");
  assert.equal(load({}).from, "/usr/local/lib/node_modules/", "unset: the global copy first, as before");
});

// A pid in an old live.json may since belong to anything (17 Nov 2026,
// Codex): after a reboot on a person's computer, a call that could not
// reattach, live=end or an idle reap SIGKILLed whatever held it.
test("a live session kills only its own browser, never another program now holding the same pid", { skip: process.platform === "win32" }, async () => {
  const { spawn, execFileSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const body = slice("function commandLine(pid) {", "\nfunction readLive(file)");
  const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const killLive = new Function("process", "fs", "path", "execFileSync", "pidAlive", `${body}\nreturn killLive;`)(process, fs, path, execFileSync, pidAlive) as (info: object, dir: string) => Promise<void>;
  const hold = (...args: string[]) => spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", "--", ...args], { stdio: "ignore", detached: true });
  const stranger = hold("--not-a-browser");
  const ours = hold("--user-data-dir=/tmp/foldrun-live-test/live-live/profile");
  await new Promise((r) => setTimeout(r, 300));
  await killLive({ pid: stranger.pid }, "/tmp/foldrun-live-test/live-live");
  await killLive({ pid: ours.pid }, "/tmp/foldrun-live-test/live-live");
  await new Promise((r) => setTimeout(r, 300));
  const strangerAlive = pidAlive(stranger.pid!);
  const oursAlive = pidAlive(ours.pid!);
  try { process.kill(stranger.pid!, "SIGKILL"); } catch {}
  try { process.kill(ours.pid!, "SIGKILL"); } catch {}
  assert.ok(strangerAlive, "another program holding the recorded pid is left alone");
  assert.ok(!oursAlive, "the session's own browser is killed");
});

test("a live session's browser is asked to quit before it is killed, so the next window offers no restore", () => {
  const kill = slice("async function killLive(info, dir) {", "\nfunction readLive(file)");
  assert.ok(kill.indexOf('"SIGTERM"') >= 0 && kill.indexOf('"SIGTERM"') < kill.indexOf('"SIGKILL"'));
  assert.match(kill, /for \(const \[pid, mark\] of \[\[info\?\.pid, profile\], \[info\?\.xvfbPid, "Xvfb"\]\]\) \{\n    if \(!pidAlive\(pid\)[^]*?SIGTERM[^]*?pidAlive\(pid\)[^]*?SIGKILL/, "Chrome is ended, and waited for, before its Xvfb");
  for (const call of ["await killLive(info, path.join(liveRoot, d))", "if (info) await killLive(info, liveDir)", "await killLive({ pid: c.pid, xvfbPid }, liveDir)", "await killLive(info, liveDir);\n    fs.rmSync(liveMeta"]) {
    assert.ok(src.includes(call), call);
  }
});
