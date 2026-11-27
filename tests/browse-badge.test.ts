// web/browse.mjs's badge (FOL-451): on the person's own Chrome window the page
// says who drives the browser (FOLDRUN_BROWSER_LABEL, set by the CLI) and the
// step about to run. Only on the desktop's headed window, never while the
// screen is recorded, never in what a call reads, and never anything private:
// no typed text, selector, host or URL — the page can read the badge.
//
// The source half always runs. The real half draws the badge in Chromium, where
// FOLDRUN_TEST_PLAYWRIGHT names a folder whose node_modules holds playwright
// with Chromium installed (CI sets it).
//
//   node --test tests/browse-badge.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
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
const ACTIONS = new Function(`${slice("const ACTIONS = [", "];")}];\nreturn ACTIONS;`)() as string[];
const BODY = slice("const BADGE_LABEL = headed", "// A page this tool opens for its own work");

type Where = { headed?: boolean; desktop?: boolean; trace?: boolean; video?: boolean; live?: boolean; liveRoot?: string };
type Api = { BADGE_LABEL: string; BADGE_MARK: string; badgeStep: (s: unknown) => string | null; badge: (t: string | null) => Promise<void>; badgeFollow: (t?: string | null) => Promise<void>; badgeSweep: (m: string[]) => Promise<unknown[]>; toTab: (p: unknown) => void };
/** The badge code as the program has it, on a given page and window. */
function load(env: Record<string, string>, where: Where, page: unknown, context: unknown): Api {
  const w = { headed: true, desktop: true, trace: false, video: false, live: false, liveRoot: os.tmpdir(), ...where };
  return new Function("process", "headed", "DESKTOP", "traceTarget", "videoTmp", "live", "liveRoot", "ACTIONS", "page", "context", "randomBytes", "fs", "path",
    `${BODY}\nreturn { BADGE_LABEL, BADGE_MARK, badgeStep, badge, badgeFollow, badgeSweep, toTab: (p) => { page = p; } };`)(
    { env }, w.headed, w.desktop, w.trace ? "outputs/trace.zip" : null, w.video ? "/tmp/v" : null, w.live, w.liveRoot, ACTIONS, page, context, randomBytes, fs, path);
}
/** A page that records what it was asked to run. */
function fake() {
  const calls: unknown[][] = [];
  const page = { isClosed: () => false, url: () => "https://example.com/", on: () => {}, mainFrame: () => null, waitForLoadState: async () => {},
    evaluate: async (_fn: Function, args: unknown) => { calls.push(Array.isArray(args) ? args : [args]); return true; } };
  return { page, context: { pages: () => [page] }, calls };
}

test("the desktop's headed window with a label draws the badge: who, then what", async () => {
  const f = fake();
  const b = load({ FOLDRUN_BROWSER_LABEL: "koder · code-1a2b3c4d5e6f7a8b" }, {}, f.page, f.context);
  await b.badge("step 1 of 2: click @e13");
  const drawn = f.calls.find((c) => c.length === 3)!;
  assert.deepEqual(drawn.slice(0, 2), ["koder · code-1a2b3c4d5e6f7a8b", "step 1 of 2: click @e13"]);
});

test("no badge headless, off the desktop, without a label, or while the screen is recorded", async () => {
  const L = { FOLDRUN_BROWSER_LABEL: "koder" };
  const cases: [Record<string, string>, Where][] = [
    [L, { headed: false }], [L, { desktop: false }], [{}, {}], [{ FOLDRUN_BROWSER_LABEL: "  \n " }, {}],
    [L, { trace: true }], [L, { video: true }],
    [{ ...L, FOLDRUN_LIVE_URL: "https://x/live/abc" }, {}], [{ ...L, FOLDRUN_EGRESS: "https://x/e/abcdefghijklmnop" }, {}],
  ];
  for (const [env, where] of cases) {
    const f = fake();
    const b = load(env, where, f.page, f.context);
    await b.badge("step 1 of 1: click");
    assert.equal(f.calls.length, 0, JSON.stringify({ env, where }));
  }
});

test("the label is one line: no control or direction characters, at most 80 characters", () => {
  const f = fake();
  const b = load({ FOLDRUN_BROWSER_LABEL: `koder\u0000 ·\n\u202e\u001b[31m${"x".repeat(200)}` }, {}, f.page, f.context);
  assert.doesNotMatch(b.BADGE_LABEL, /[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/);
  assert.ok(b.BADGE_LABEL.length <= 80);
  assert.match(b.BADGE_LABEL, /^koder · \[31mx+$/);
});

test("a step shows a verb, an @eN reference or a key's name — never text, a selector, a host or a URL", () => {
  const f = fake();
  const { badgeStep } = load({ FOLDRUN_BROWSER_LABEL: "k" }, {}, f.page, f.context);
  assert.equal(badgeStep({ click: "@e13" }), "click @e13");
  assert.equal(badgeStep({ fill: "@e4", text: "hunter2" }), "fill @e4");
  assert.equal(badgeStep({ fill: "#password", text: "hunter2" }), "fill");
  assert.equal(badgeStep({ click: "text=Pay Jane Doe $5,000" }), "click");
  assert.equal(badgeStep({ press: "", key: "Enter" }), "press Enter");
  assert.equal(badgeStep({ press: "@e2", key: "Tab" }), "press Tab on @e2");
  assert.equal(badgeStep({ press: "#x", key: "my secret" }), "press");
  // press's value is the element; the key is `key`, Enter when none is given (Codex).
  assert.equal(badgeStep({ press: "hunter2" }), "press Enter");
  assert.equal(badgeStep({ press: "#pw", key: "h" }), "press", "a key that types a character is not shown");
  assert.equal(badgeStep({ keydown: "h" }), "keydown");
  assert.equal(badgeStep({ keydown: "Shift" }), "keydown Shift");
  assert.equal(badgeStep({ press: "", key: "Control+A" }), "press Control+A");
  assert.equal(badgeStep({ press: "", key: "Shift+H" }), "press");
  assert.equal(badgeStep({ insert: "@e123" }), "type", "insert's value is the text, even when it looks like a ref");
  assert.equal(badgeStep({ goto: "https://bank.example/account?token=abc" }), "go to another page");
  assert.equal(badgeStep({ insert: "hunter2" }), "type");
  assert.equal(badgeStep({ type: "@e9", text: "hunter2" }), "type into @e9");
  assert.equal(badgeStep({ keyboard: "secret words" }), "type");
  assert.equal(badgeStep({ download: "https://s3.example/x?X-Amz-Signature=abc" }), "download");
  assert.equal(badgeStep({ login: "BANK_LOGIN" }), "sign in");
  const secret = /hunter2|password|bank|token|Jane|secret|Amz|BANK/;
  for (const s of [{ fill: "#password", text: "hunter2" }, { type: "#a", text: "hunter2" }, { keyboard: "hunter2" }, { insert: "hunter2" },
    { select: "#a", value: "hunter2" }, { goto: "https://bank.example/?token=1" }, { download: "https://x/?X-Amz-Signature=1" }, { login: "BANK_LOGIN" }]) {
    assert.doesNotMatch(String(badgeStep(s)), secret, JSON.stringify(s));
  }
});

test("a step that reads the page runs with the badge off", async () => {
  const f = fake();
  const { badgeStep } = load({ FOLDRUN_BROWSER_LABEL: "k" }, {}, f.page, f.context);
  for (const k of ["get", "extract", "if", "expect", "eval", "solve", "screenshot", "pdf", "webmcp", "highlight", "clipboard", "cookie", "localstorage", "wait"]) {
    assert.equal(badgeStep({ [k]: "x" }), null, k);
  }
  // Each loop draws what badgeStep says, so null takes it off; and it comes off before the result is read.
  assert.match(src, /const doing = badgeStep\(step\);\n\s+const line = doing === null \? null : `step \$\{stepNo\} of \$\{actions\.length\}: \$\{doing\}`;\n\s+await badge\(line\);\n\s+const done = await runAction\(step\);/);
  assert.match(src, /await badge\(badgeStep\(step\)\);\n\s+const done = await runAction\(step, indent\);/);
  assert.ok(src.indexOf("await badge(null).catch(badgeStuck);\n  let out;") > 0, "taken off before the output is read");
  assert.ok(src.indexOf("await badge(null).catch(badgeStuck);\n\n  // --expect: the claims") > 0, "and before --expect checks the page");
  assert.ok(src.indexOf("await badge(null).catch(badgeStuck);   // a wait reads the page (FOL-451)\n    await page.locator(values.wait_for)") > 0, "and before wait_for");
  assert.match(src, /const done = await runAction\(step\);\n\s+await badgeFollow\(line\);/, "a tab switch takes it along at once");
});

test("a new mark each call; a live window notes the last one for the next call, in a file only the person reads", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "badge-mark-"));
  const f = fake();
  const one = load({ FOLDRUN_BROWSER_LABEL: "k" }, { live: true, liveRoot: root }, f.page, f.context).BADGE_MARK;
  const two = load({ FOLDRUN_BROWSER_LABEL: "k" }, { live: true, liveRoot: root }, f.page, f.context).BADGE_MARK;
  assert.match(one, /^[0-9a-f]{18}$/);
  assert.notEqual(one, two, "nothing in a page is the same from one call to the next");
  const file = path.join(root, "badge-marks");
  assert.equal(fs.readFileSync(file, "utf8"), `${one}\n${two}\n`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a live call that cannot note its mark draws nothing", async () => {
  const f = fake();
  const b = load({ FOLDRUN_BROWSER_LABEL: "k" }, { live: true, liveRoot: path.join(os.tmpdir(), "no-such-dir-" + Date.now(), "x") }, f.page, f.context);
  assert.equal(b.BADGE_MARK, "");
  await b.badge("step 1 of 1: click");
  assert.equal(f.calls.length, 0);
});

test("what the last call left is struck from the list only once every tab took it off", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "badge-left-"));
  const file = path.join(root, "badge-marks");
  fs.writeFileSync(file, "aaaaaaaaaaaaaaaaaa\nnot-a-mark\nbbbbbbbbbbbbbbbbbb\n");
  const seen: string[][] = [];
  const stuckTab = { url: () => "https://bank.example/account?token=SENTINEL42#x" };
  await assert.rejects(clearLeft(root, async (m) => { seen.push(m); return [stuckTab]; }, [stuckTab]),
    (err: Error) => /could not be taken off tab 0 — nothing was recorded or read/.test(err.message) && !/SENTINEL42|bank\.example/.test(err.message),
    "a tab that could not be cleared stops the call before tracing starts, and its address is not told");
  assert.deepEqual(seen, [["aaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbb"]]);
  assert.ok(fs.existsSync(file), "and the marks are kept for the next call");
  await clearLeft(root, async () => []);
  assert.equal(fs.existsSync(file), false);
  // No list: nothing to do. A list that cannot be read: stop, do not guess it empty.
  await clearLeft(root, async () => { throw new Error("not called"); });
  fs.mkdirSync(file);   // reading a directory fails with EISDIR
  await assert.rejects(clearLeft(root, async () => []), /could not be read \(EISDIR\) — nothing was recorded or read/);
  fs.rmdirSync(file);
  fs.rmSync(root, { recursive: true, force: true });
});

/** The start of a call: what the last call left comes off, before tracing starts, drawing or not. */
const LEFT = slice("// What the last call left on the window", "if (traceTarget) await context.tracing.start(");
const clearLeft = (root: string, sweep: (m: string[]) => Promise<unknown[]>, pages: unknown[] = [], desktop = true) =>
  new Function("live", "DESKTOP", "fs", "path", "liveRoot", "badgeSweep", "fail", "context", `return (async () => {${LEFT}})();`)(
    true, desktop, fs, path, root, sweep, (m: string) => { throw new Error(m); }, { pages: () => pages }) as Promise<void>;

test("a page the badge cannot be taken off is not read", async () => {
  const f = fake();
  const b = load({ FOLDRUN_BROWSER_LABEL: "k" }, {}, f.page, f.context);
  await b.badge("step 1 of 1: click");
  f.page.evaluate = async () => { throw new Error("Execution context was destroyed"); };
  await assert.rejects(b.badge(null), /could not be taken off this page before reading it/);
  assert.ok(src.includes("await badge(null).catch(badgeStuck);\n  let out;"), "and the call stops before the output is read");
});

const PW = process.env.FOLDRUN_TEST_PLAYWRIGHT;
test("real Chromium: drawn where a person sees it, out of every read, and only our own node is taken off", { skip: !PW && "set FOLDRUN_TEST_PLAYWRIGHT", timeout: 120_000 }, async () => {
  const { chromium } = createRequire(path.join(PW!, "package.json"))("playwright");
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const other = await context.newPage();
    const b = load({ FOLDRUN_BROWSER_LABEL: "koder · code-1a2b3c4d5e6f7a8b" }, {}, page, context);
    // A strict CSP page with Trusted Types, and a site node that imitates ours.
    const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'none'; require-trusted-types-for 'script'"></head>
      <body><h1>Sign in</h1><input id="pw" type="password"><foldrun-badge id="site">the site's own</foldrun-badge></body></html>`;
    await page.setContent(html);
    await other.setContent(html);
    await b.badge("step 1 of 2: click @e13");
    const seen = await page.evaluate(() => {
      const ours = [...document.querySelectorAll("foldrun-badge")].filter((e) => e.id !== "site");
      const r = ours[0]?.getBoundingClientRect();
      return { count: ours.length, shadow: ours[0]?.shadowRoot ?? null, aria: ours[0]?.getAttribute("aria-hidden"), pos: ours[0] && getComputedStyle(ours[0]).position,
        visible: !!r && r.width > 0 && r.height > 0, inBody: !!ours[0] && document.body.contains(ours[0]), body: document.body.innerText };
    });
    assert.equal(seen.count, 1, "drawn once");
    assert.equal(seen.shadow, null, "closed: the page's script cannot read into it");
    assert.equal(seen.aria, "true");
    assert.equal(seen.pos, "fixed", "its style holds under a CSP that forbids inline style");
    assert.ok(seen.visible, "a person sees it");
    assert.equal(seen.inBody, false);
    assert.doesNotMatch(seen.body, /koder/, "body text holds none of it");
    const snap = await page.locator("body").ariaSnapshot();
    assert.doesNotMatch(snap, /koder|step 1/, "nor the accessibility tree");
    const tree = await page.accessibility?.snapshot?.().catch(() => null);
    if (tree) assert.doesNotMatch(JSON.stringify(tree), /koder/);
    // The text is drawn: Chromium's own view of the closed root holds it.
    const cdp = await context.newCDPSession(page);
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    assert.match(JSON.stringify(root), /koder · code-1a2b3c4d5e6f7a8b.*step 1 of 2: click @e13/);
    // A click passes through it.
    await page.evaluate(() => { (window as any).hit = 0; document.addEventListener("click", (e) => { (window as any).hit = (e.target as Element).tagName; }); });
    await page.mouse.click(page.viewportSize()!.width - 20, page.viewportSize()!.height - 20);
    assert.notEqual(await page.evaluate(() => (window as any).hit), "FOLDRUN-BADGE");

    // Moving on to another tab: the old one is cleared, the new one drawn; the site's node stays.
    b.toTab(other);
    await b.badge("step 2 of 2: click @e2");
    const ids = (p: any) => p.evaluate(() => [...document.querySelectorAll("foldrun-badge")].map((e) => e.id || "ours"));
    assert.deepEqual(await ids(page), ["site"], "the tab left behind: only the site's node, never stale words of ours");
    assert.deepEqual(await ids(other), ["site", "ours"]);
    await b.badge(null);
    assert.deepEqual(await ids(other), ["site"], "taken off: only ours");
    b.toTab(page);

    // A call leaves "waiting"; the next one records a trace (so draws nothing) and still finds the page clean.
    const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), "badge-live-"));
    const first = load({ FOLDRUN_BROWSER_LABEL: "koder · code-1a2b3c4d5e6f7a8b" }, { live: true, liveRoot: liveDir }, page, context);
    await first.badge("done — waiting for the next step");
    const ours = () => page.evaluate(() => [...document.querySelectorAll("foldrun-badge")].filter((e) => e.id !== "site").length);
    assert.equal(await ours(), 1);
    const traced = load({ FOLDRUN_BROWSER_LABEL: "koder · code-1a2b3c4d5e6f7a8b" }, { live: true, liveRoot: liveDir, trace: true }, page, context);
    assert.equal(traced.BADGE_LABEL, "", "a recorded call draws none");
    await clearLeft(liveDir, traced.badgeSweep);
    assert.equal(await ours(), 0, "the last call's badge is gone before tracing starts");
    assert.equal(await page.evaluate(() => document.querySelectorAll("#site").length), 1, "the site's own node stays");
    assert.equal(fs.existsSync(path.join(liveDir, "badge-marks")), false);
    fs.rmSync(liveDir, { recursive: true, force: true });

    // A step that switches tab takes the badge along at once (a new tab: before its page loads).
    await b.badge("step 1 of 1: tab");
    b.toTab(other);
    await b.badgeFollow();
    assert.deepEqual(await ids(page), ["site"]);
    assert.deepEqual(await ids(other), ["site", "ours"]);
    // A step that led to another page: drawn again there, by itself, once.
    await other.goto("data:text/html,<p>next</p>");
    await b.badgeFollow();
    assert.deepEqual(await ids(other), ["ours"]);
    await b.badge(null);
    b.toTab(page);
    assert.ok(src.includes("await badgeFollow();   // the old tab no longer claims the step (FOL-451)\n        if (step.url) await navigate(page, step.url);"));

    // A step that reloads the same address: drawn again on the new document while it still loads.
    const slow = await context.newPage();
    let release = () => {};
    const held = new Promise<void>((r) => { release = r; });
    let scripts = 0;
    await slow.route("https://badge.test/", (r) => r.fulfill({ contentType: "text/html", body: `<p>form</p><script src="/slow.js"></script>` }));
    await slow.route("https://badge.test/slow.js", async (r) => { if (scripts++) await held; await r.fulfill({ contentType: "text/javascript", body: "" }); });
    await slow.goto("https://badge.test/");
    const rb = load({ FOLDRUN_BROWSER_LABEL: "koder · code-1a2b3c4d5e6f7a8b" }, {}, slow, context);
    await rb.badge("step 1 of 1: reload");
    assert.deepEqual(await ids(slow), ["ours"]);
    const reloading = slow.reload();
    let during: string[] = [];
    for (let i = 0; i < 60 && during[0] !== "ours"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      during = scripts > 1 ? await ids(slow).catch(() => []) : [];
    }
    assert.equal(await slow.evaluate(() => document.readyState), "loading", "the step is still loading the page");
    assert.deepEqual(during, ["ours"], "the reloaded document shows the badge before it has loaded");
    release();
    await reloading;
    await rb.badge(null);
    assert.deepEqual(await ids(slow), []);
    await slow.close();

    // An SVG document has no HTML root: no badge, no error.
    await page.goto("data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>`));
    await b.badge("step 1 of 1: click");
    assert.equal(await page.evaluate(() => document.querySelectorAll("foldrun-badge").length), 0);
  } finally {
    await browser.close();
  }
});
