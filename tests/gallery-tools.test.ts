// The gallery's two folder tools, exercised as programs — not only as
// strings that install. The sql script actually runs under python3 against
// files on disk; the browser program is syntax-checked as an ES module and
// its definition read for the arguments it promises. Chromium is never
// launched here.
//
//   node --test tests/gallery-tools.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { GALLERY, galleryTemplate, installGalleryTool } from "../src/gallery.ts";
import { readLibraryFile } from "../../foldrun-core/src/library.ts";
import { fencedCode, parseToolDef, saveWorkspace, workspaceTools } from "../../foldrun-core/src/store.ts";
import { missingToolPrograms } from "../../foldrun-core/src/tool-programs.ts";
import { WEB_BROWSE_ACTIONS, BROWSE_ENGINES, BROWSE_ENGINE_LIMITS, browseEngineRefusal } from "../../foldrun-core/src/providers.ts";
import { MAX_EDITABLE_FILE } from "../../foldrun-core/src/paths.ts";

// web's browse action: the definition is web's, the program web/browse.mjs.
const web = GALLERY.find((t) => t.name === "web")!;
const browser = { content: web.content, wrapper: { content: web.extra!.find((f) => f.file === "web/browse.mjs")!.content } };

// ------------------------------------------------------- gallery mechanics

test("installing a folder tool writes both files, and it loads with its program", () =>
  withData(() => {
    assert.equal(installGalleryTool("acme", "web"), "web/tool.md");
    assert.match(readLibraryFile("acme", "tools", "web/browse.mjs"), /playwright/);

    saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: "---\nname: desk\n---\n" }]);
    installGalleryTool("acme", "web", "desk");
    const def = workspaceTools("acme", "desk").web;
    assert.equal(def.kind, "script");
    assert.equal((def.spec as { run?: string }).run, "workspace/tools/web/run.mjs");
    assert.deepEqual(missingToolPrograms("acme", "desk"), []);
  }));

test("starting from a gallery tool seeds a renamed folder", () => {
  const seed = galleryTemplate("tools", "web", "my-browser")!;
  assert.deepEqual(seed.slice(0, 2).map((f) => f.file), ["my-browser/tool.md", "my-browser/run.mjs"]);
  assert.equal(matter(seed[0].content).data.run, "run.mjs");
  assert.match(seed[0].content, /tools: \[my-browser\]/);
});

function withData(body: () => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-gallery-tools-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    body();
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------- browser

// Every action the program knows, and the definition must document.
const ACTIONS = [
  "click", "dblclick", "rightclick", "hover", "check", "uncheck", "drag", "fill", "type", "press", "select",
  "wait", "goto", "screenshot", "pdf", "scroll", "paste", "upload", "download", "extract", "frame", "tab",
  "back", "forward", "reload", "focus", "clear", "highlight", "keyboard", "keydown", "keyup", "mouse", "wheel",
  "tap", "swipe", "clipboard", "eval", "get", "expect", "if", "mock", "unmock", "offline", "cookie",
  "localstorage", "sessionstorage", "viewport", "dialog", "solve",
  "pushstate", "insert", "webmcp", "login",
];
// Every mode, and the definition must explain each in one breath.
const MODES = ["text", "markdown", "html", "aria", "meta", "table", "network", "capture", "links", "screenshot", "pdf", "console", "vitals", "a11y", "diff", "feed", "webmcp", "react"];

test("the browser program parses as an ES module and keeps its guards", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-browser-"));
  try {
    const file = path.join(dir, "run.mjs");
    fs.writeFileSync(file, browser.wrapper!.content);
    const r = spawnSync("node", ["--check", file], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const src = browser.wrapper!.content;
  // One program, three engines: the launch goes through whichever engine
  // --browser named, and chromium stays the default.
  assert.match(src, /engine\.launch\(/, "the plain launch stays for session-less calls");
  assert.match(src, /engine\.launchPersistentContext\(/, "a session is a persistent profile");
  assert.match(src, /ENGINES = \["chromium", "chrome", "firefox", "safari", "lightpanda", "obscura"\]/, "the names a person writes, chromium the default");
  assert.match(src, /ENGINE_ALIASES = \{ chrome: "chrome", chromium: "chromium"/, "chrome is real Google Chrome now, distinct from the open-source chromium");
  // chromium is still the default — applied after the `web.browse` block,
  // so a file's engine is not overwritten by an argument nobody passed.
  assert.match(src, /browser: \{ type: "string" \}/);
  assert.match(src, /if \(values\.browser === undefined\) values\.browser = "chromium";/);
  assert.match(src, /FOLDRUN_BROWSER_ENGINE/, "the block's engine reaches the tool");
  assert.match(src, /FOLDRUN_BROWSER_USER_AGENT/, "and its user agent");
  // headless: false is the same browser with a window, on a virtual screen
  // started here when the machine has none; headless stays the default.
  assert.match(src, /const headed = process\.env\.FOLDRUN_BROWSER_HEADLESS === "0";/, "only an explicit false opens a window");
  assert.match(src, /const launchOptions = \{ headless: true \};/, "no window unless asked");
  assert.match(src, /spawn\("Xvfb", \["-displayfd", "3"/, "a free screen, reported by Xvfb itself");
  assert.match(src, /if \(headed && !remote && !live\) await ensureDisplay\(\);/, "the pod brings its own screen, and a live session starts its own");
  assert.match(src, /contextOptions\.viewport = headed \? null :/, "a windowed page takes the window's size");
  // A laptop keeps Playwright somewhere else than the runner image does.
  assert.match(src, /const playwright = loadPlaywright\(\);/);
  assert.match(src, /"\/usr\/local\/lib\/node_modules\/", "\/opt\/homebrew\/lib\/node_modules\/"/, "the image first, then Homebrew's");
  assert.match(src, /execFileSync\("npm", \["root", "-g"\]/, "then wherever npm says");
  assert.match(src, /if \(values\[k\] === undefined && v\) values\[k\] = v;/, "a call argument still wins");
  // A cookie from the file belongs to one site; a call elsewhere opens signed
  // out rather than handing that site someone else's session.
  assert.match(src, /if \(!cookiesFromCall && values\.cookies && values\.cookie_domain\)/);
  assert.match(src, /opened signed out/);
  assert.match(src, /outputs[/"', ]+\.browser/, "the profile lives under outputs/");
  assert.match(src, /--no-sandbox/);
  assert.match(src, /MAX_CHARS = 18_000/);
  for (const action of ACTIONS) {
    assert.match(src, new RegExp(`"${action}"`), `${action} is a known action`);
  }
  // Sign-in cookies come from a named secret, read from the environment —
  // the name is the only thing that may appear in arguments or the log.
  assert.match(src, /process\.env\[name\]/, "cookies are read from the secret's environment variable");
  assert.match(src, /cookies must be the NAME of a secret/, "a cookie value passed as the argument is refused");
  assert.match(src, /channel: values\.browser === "chrome" \? "chrome" : "chromium"/, "engine: chrome launches real Chrome, engine: chromium the open-source build");
  assert.match(src, /that Chrome build is not installed here — using Chromium/, "falls back where Chrome (or a named version) is absent");
  // version: a specific build — Chrome release channel or an installed binary.
  assert.match(src, /live: process\.env\.FOLDRUN_BROWSER_LIVE/, "the block's live reaches the tool");
  assert.match(src, /remote-debugging-port=0/, "a live browser is reattached over DevTools");
  assert.match(src, /detached: true, stdio: "ignore"/, "and it cannot hold the call's output open");
  // A control the pointer cannot reach falls back to the keyboard, then its
  // label, and is read back; "force" sends the click event to the element.
  assert.match(src, /async function setToggle\(loc, want, t, force\)/);
  assert.match(src, /await loc\.press\("Space"/, "Space on a checkbox or radio");
  assert.match(src, /await loc\.press\("Enter"/, "Enter on a button or link");
  assert.match(src, /loc\.dispatchEvent\("click"/, "force sends the click event to the element itself");
  assert.match(src, /const t = \{ timeout: step\.timeout \?\? STEP_TIMEOUT \};/, "a step's timeout bounds any action");
  assert.match(src, /not on the page within \$\{t\.timeout\}ms/, "a missing element says how long it was waited for");
  assert.match(src, /fs\.mkdirSync\(path\.dirname\(seededMarker\)/, "a live session's marker directory is made before it is written (the first live G2 call crashed on it)");
  assert.match(src, /if \(browser && !live\) await browser\.close\(\);/, "a live browser is never closed at the end of a call");
  assert.match(src, /version: process\.env\.FOLDRUN_BROWSER_VERSION/, "the block's version reaches the tool");
  assert.match(src, /\{ stable: "chrome", beta: "chrome-beta", dev: "chrome-dev" \}/, "Chrome release channels by version");
  assert.match(src, /\/opt\/browser\/\$\{values\.browser\}\/\$\{values\.version\}/, "an installed binary at a known path wins");
  // The captcha seam: a key named by secret, never pasted; three vendors on
  // one protocol; a widget solved once per page; the platform pays nothing.
  assert.match(src, /captcha must be the NAME of a secret holding the solver's API key/);
  assert.match(src, /SOLVERS = \{\s*capsolver: \{ url: "https:\/\/api\.capsolver\.com"/);
  assert.match(src, /"2captcha": \{ url: "https:\/\/api\.2captcha\.com"/);
  assert.match(src, /anticaptcha: \{ url: "https:\/\/api\.anti-captcha\.com"/);
  assert.match(src, /solvedWidgets\.has\(id\)/, "a site key is solved once per page, so a re-check after an action does not bill twice");
  assert.match(src, /process\.env\.FOLDRUN_CAPTCHA_API \|\| solver\.url/, "a fake solver can stand in for tests");
  assert.match(src, /await maybeSolveCaptcha\(page\);/);
  assert.match(src, /console\.error\(`page: \$\{page\.url\(\)\}`\)/, "the final URL is reported");
  // Script in the page could read document.cookie, so js and a secret's
  // cookies never share a browser — not in one call, and not across a
  // session the secret seeded earlier in the run.
  assert.match(src, /\$\{what\} cannot be combined with cookies/);
  assert.match(src, /\$\{what\} cannot be combined with storage/, "and script can read tokens out of storage just as easily");
  assert.match(src, /if \(values\.js\) scriptGuard\("js"\);/, "js is the first caller of the one guard");
  // Storage is the sibling of cookies, for the logins that are not cookies:
  // Firebase writes IndexedDB, MSAL can use sessionStorage, and a cookie jar
  // alone opens those pages signed out. Seeded before the page's own scripts,
  // scoped to one origin, and never read back.
  assert.match(src, /storage: \{ type: "string" \}/, "the tool takes a storage secret");
  assert.match(src, /storage_origin: \{ type: "string" \}/, "and the origin it belongs to");
  assert.match(src, /FOLDRUN_BROWSER_STORAGE\b/, "the block's storage reaches the tool");
  assert.match(src, /FOLDRUN_BROWSER_STORAGE_ORIGIN/, "and its origin");
  assert.match(src, /if \(!storageFromCall && values\.storage && values\.storage_origin\)/, "a file default is dropped on another origin");
  assert.match(src, /opened without it/);
  assert.match(src, /context\.addInitScript/, "storage is written before the page's own scripts run");
  assert.match(src, /indexedDB\.open\(dbName\)/, "IndexedDB is filled through its own API, not copied as files");
  assert.match(src, /\.seeded-from-secret/, "a seeded session is marked on disk");
  assert.match(src, /firefox: \{ why: "is a Chromium feature[^}]*"mode=pdf"/, "pdf refuses on firefox and webkit");
  assert.match(src, /acceptDownloads: true/);
  assert.match(src, /context\.route\("\*\*\/\*"/, "block works at the network layer");
  assert.match(src, /context\.on\("response"/, "capture listens on the whole context");
  assert.match(src, /outputs[/"', ]+extracted\.json/, "extract writes its full result beside the output");
  // Headers may reference a secret by ${NAME}; the cookie header is refused
  // so cookies keep their one door; auth and proxy are secret NAMES only.
  assert.match(src, /send cookies with cookies=<SECRET NAME>, not as a header/);
  assert.match(src, /must be the NAME of a secret holding/);
  assert.match(src, /extraHTTPHeaders/);
  assert.match(src, /recordVideo/);
  assert.match(src, /tracing\.start\(/);
  assert.match(src, /ariaSnapshot\(/);
  // A crawl reads a site the way its owner allowed: robots.txt for "*",
  // same host only, and it never runs actions.
  assert.match(src, /robots\.txt/);
  assert.match(src, /allowedBy\(rules, u\)/);
  assert.match(src, /walks the site by itself; actions do not apply/);
  assert.match(src, /outputs[/"', ]+crawl[/"', ]+index\.json/);
  // The readers: four more modes, each a self-contained function run in
  // the page (no dependency in the runner image), each with its file. No
  // two modes answer the same question: the page's own response lives at
  // the top of network, not in a mode of its own.
  assert.match(src, /MODES = \["text", "markdown", "html", "links", "meta", "table", "network", "screenshot", "pdf", "capture", "aria", "map", "crawl", "console", "vitals", "a11y", "diff", "feed", "webmcp", "react"\]/);
  assert.match(src, /const TO_MARKDOWN = \(\) =>/);
  assert.match(src, /const PAGE_META = \(\) =>/);
  assert.match(src, /const PAGE_TABLES = \(\) =>/);
  assert.match(src, /async function describeResponse\(\)/);
  for (const file of ["page.md", "meta.json", "tables.json", "network.json"]) {
    assert.match(src, new RegExp(`outputs[/"', ]+${file.replace(".", "\\.")}`), `${file} is written beside the output`);
  }
  // A refreshed session cookie is the one header mode=response must not
  // print: it is the secret a cookies= call promised never to show.
  assert.match(src, /headers\["set-cookie"\] = `\[withheld:/);
  // The page's own failures reach stderr on every call, and our own blocks
  // are not counted among them.
  assert.match(src, /p\.on\("pageerror"/);
  assert.match(src, /context\.on\("requestfailed"/);
  assert.match(src, /droppedUrls\.has\(req\.url\(\)\)/, "a request we blocked is not a failed request");
  assert.match(src, /console\.error\(`page errors: /);
  // A screenshot can be one element, or the viewport; whole page stays the
  // default — and the options are built once, so an element shot and a page
  // shot take the same type, quality and clip.
  assert.match(src, /el\.screenshot\(opts\)/);
  assert.match(src, /function shotOptions\(step, abs\)/);
  assert.match(src, /opts\.type = "jpeg"/, "a .jpg path is JPEG");
  assert.match(src, /Math\.min\(100, Math\.max\(1, Math\.round\(q\)\)\) : 60/, "quality is clamped, default 60");
  assert.match(src, /opts\.clip = \{ x: c\[0\], y: c\[1\], width: c\[2\], height: c\[3\] \}/, "clip as [x, y, w, h]");
  // A full page is settled first so lazy images are in it; a clip is never
  // combined with fullPage, which Playwright would refuse.
  assert.match(src, /async function settleForFullPage\(page\)/);
  assert.match(src, /const full = step\.full !== false && !opts\.clip;/);
  assert.match(src, /if \(full && step\.settle !== false\) await settleForFullPage\(page\);/);
  assert.match(src, /n < 80/, "the settle scroll is capped");
  assert.match(src, /fullPage: full \}\)/);
  // (the old inline `fullPage: step.full !== false` became `full`, computed once so a clip never combines with fullPage)
  // A crawl retries a wire error, a 5xx or a 429 once before recording it.
  assert.match(src, /RETRY_ON = \(st\) => st === null \|\| st === 429/);
  for (const mode of MODES) assert.match(src, new RegExp(`"${mode}"`), `${mode} is a known mode`);
});

test("the browser's 2026-09-23 layers: claims, branches, questions, mocks, state, identity", () => {
  const src = browser.wrapper!.content;
  // One guard for everything that runs script or reads storage in the page,
  // named for whichever step asked — the js rule did not get a second copy.
  assert.match(src, /function scriptGuard\(what\)/);
  assert.match(src, /if \(values\.js\) scriptGuard\("js"\);/);
  assert.match(src, /scriptGuard\(`action \$\{n\}: eval`\)/, "an eval step is script");
  assert.match(src, /scriptGuard\(`action \$\{n\}: wait fn`\)/, "so is a wait on a function");
  assert.match(src, /scriptGuard\(`action \$\{n\}: get \$\{v\}`\)/, "and reading localStorage");
  assert.match(src, /scriptGuard\(`action \$\{n\}: clipboard read`\)/, "and the clipboard, which the page may have filled");
  // state/ is a workspace file any step can read, so a secret never lands
  // in it: refused with cookies=, with storage=, and in a seeded session.
  assert.match(src, /state cannot be combined with cookies/);
  assert.match(src, /state cannot be combined with storage/);
  assert.match(src, /state cannot be used with session/);
  assert.match(src, /path\.join\(workspaceRoot\(\), "state", "browser", `\$\{values\.state\}\.json`\)/, "the login lives in the workspace's state/, which a deploy never touches");
  // A claim is checked after the actions; any failure fails the call, and
  // every claim is reported, not only the first.
  assert.match(src, /if \(expectations\.length && !failed\)/);
  assert.match(src, /expectation\$\{expectations\.length === 1 \? "" : "s"\} failed/);
  // An if step branches on the same shape as expect, and its steps run
  // through the same door, indented in the log.
  assert.match(src, /const r = await check\(step, "if"\);/);
  assert.match(src, /await runSteps\(branch, indent \+ "  "\);/);
  // Identities come from the block as one JSON map; an unknown name is
  // refused with the names that exist; a call argument still wins.
  assert.match(src, /FOLDRUN_BROWSER_IDENTITIES/);
  assert.match(src, /is not one the agent's web\.browse block names/);
  assert.match(src, /if \(values\[target\] === undefined\) values\[target\]/);
  // Mocks are routes by glob, lifted by the same glob; --routes installs
  // them before the first request.
  assert.match(src, /async function installMock\(step\)/);
  assert.match(src, /for \(const r of routes\) \{\s*await installMock\(r\);/);
  // The scroll step exists in the runner, not only in the validator (it
  // was validated and then fell through to "unknown action" until now).
  assert.match(src, /case "scroll": \{/);
  // The audits: axe-core when the image has it, the built-in checks otherwise.
  assert.match(src, /createRequire\(anchor\)\.resolve\("axe-core\/axe\.min\.js"\)/);
  assert.match(src, /built-in \(axe-core is not in the runner image\)/);
  // A diff spans runs, so its baseline is state/, keyed by the URL asked for.
  assert.match(src, /path\.join\(workspaceRoot\(\), "state", "browser", "diff", host, `\$\{key\}\.json`\)/);
  // The semantic selector prefixes map onto Playwright's own lookups.
  assert.match(src, /BY_PREFIX = \{ label: "getByLabel", placeholder: "getByPlaceholder", alt: "getByAltText", title: "getByTitle", testid: "getByTestId" \}/);
  // A cookie secret may seed a saved login only when state_key encrypts it;
  // the saved, rotated session then wins until the secret itself changes.
  assert.match(src, /if \(values\.state && values\.cookies && !values\.state_key\) fail\(/, "state + cookies needs a key");
  assert.match(src, /createHmac\("sha256", key\)\.update\(secretValue\(name/, "the seed is fingerprinted under the state key, not hashed bare");
  assert.match(src, /stateEnvelope\?\.seeded_from === values\.cookies && stateEnvelope\?\.seed === fingerprint/, "same secret, same fingerprint: load the saved session");
  assert.match(src, /seedCookies\.length = 0;/, "and do not lay the vault's stale copy over it");
  assert.match(src, /if \(stateSeededFromSecret\(\)\) fail\(/, "script stays refused on a login a secret seeded");
  assert.match(src, /state: process\.env\.FOLDRUN_BROWSER_STATE,/, "the block's state reaches the tool");
  assert.match(src, /if \(stateSeed\) c\.setAAD\(/, "the seed record is bound into the tag, so stripping it breaks the file, not the guard");
  assert.match(src, /if \(j\.seeded_from\) d\.setAAD\(/, "and checked on the way back in");
  assert.match(src, /const same = alive && stateEnvelope/, "a saved session the site signed out falls back to the secret");
  assert.match(src, /: live \? path\.join\(os\.tmpdir\(\), "foldrun-live"/, "a live page without session= is marked too");

  const { data, content } = matter(browser.content);
  const spec = parseToolDef(data as Record<string, unknown>, "web", content)!.spec as { args: Record<string, string> };
  assert.match(spec.args.expect, /any\s+that fails fails the call/);
  assert.match(spec.args.state, /Without state_key it is refused together with cookies, and always with storage/);
  assert.match(spec.args.identity, /identities: map/);
  assert.match(spec.args.actions, /"if": <the same shape as expect>/);
  assert.match(spec.args.actions, /label=Email, placeholder=Search/);
});

test("web's definition carries every browse argument", () => {
  const { data, content } = matter(browser.content);
  const def = parseToolDef(data as Record<string, unknown>, "web", content);
  assert.equal(def!.kind, "script");
  const spec = def!.spec as { run?: string; args: Record<string, string>; timeout?: number };
  assert.equal(spec.run, "run.mjs");
  assert.equal(spec.timeout, 600); // a crawl is many pages; its own budget stops at 480 s
  for (const arg of [
    "url", "wait_for", "mode", "actions", "session", "cookies", "cookie_domain", "confirm",
    "browser", "device", "block", "capture", "js", "geolocation", "permissions", "locale", "timezone",
    "headers", "user_agent", "auth", "proxy", "video", "trace", "dialogs", "dialog_text", "color_scheme", "captcha", "captcha_solver", "limit",
    "engine", "interactive", "expect", "routes", "identity", "state", "har", "live",
    "within", "depth", "compact", "delta", "annotate", "visual", "init", "allowed_domains", "boundaries", "webgpu",
    "extensions", "ignore_https_errors", "cpu_profile", "state_key", "max_output", "against",
  ]) {
    assert.ok(arg in spec.args, `${arg} is declared`);
  }
  // live: the page outlives the call, so a wizard can be driven one step per call.
  assert.match(spec.args.live, /multi-step form or wizard one step per call/);
  assert.match(spec.args.live, /"end" closes it/);
  // Captcha solving is opt-in on the customer's own solver: the argument
  // names a secret, the vendor is one of three, and the definition says
  // what is not covered rather than implying everything is.
  assert.match(spec.args.captcha, /NAME of a secret/);
  assert.match(spec.args.captcha, /Off by default/);
  assert.match(spec.args.captcha, /Not covered: reCAPTCHA v3, Cloudflare's full-page challenge/);
  assert.match(spec.args.captcha_solver, /capsolver \(default\) \| 2captcha \| anticaptcha/);
  assert.match(spec.args.mode, /crawl/);
  assert.match(spec.args.headers, /\$\{PORTAL_TOKEN\}/);
  assert.match(spec.args.mode, /aria/);
  for (const mode of MODES) {
    assert.match(spec.args.mode, new RegExp(`\\b${mode} \\(`), `${mode} is explained in one breath, not only listed`);
  }
  assert.match(spec.args.mode, /map: every URL on the site/);
  assert.match(spec.args.mode, /crawl: breadth-first/);
  assert.doesNotMatch(spec.args.mode, /\bresponse\b/, "response is part of network, not a mode");
  assert.match(spec.args.mode, /Set-Cookie\s+withheld/);
  assert.match(spec.args.actions, /"selector":\s*"<el>"/, "an element screenshot is documented");
  assert.match(spec.args.mode, /screenshot/);
  assert.match(spec.args.mode, /pdf/);
  assert.match(spec.args.browser, /chromium \(default, the open-source build\), chrome \(Google Chrome where the image has it, else chromium\), firefox, safari \(WebKit, Safari's\s+engine\), lightpanda or obscura/);
  assert.match(spec.args.js, /Refused together with cookies/);
  assert.match(spec.args.cookies, /NAME of a secret/);
  for (const action of ACTIONS) {
    assert.match(spec.args.actions, new RegExp(`"${action}"`), `${action} is documented`);
  }
  assert.match(spec.args.session, /outputs\/\.browser/);
  assert.equal(fencedCode(content), null);
});

test("the browser's 2026-09-29 layer: what agent-browser had and this lacked", () => {
  const src = browser.wrapper!.content;
  const { data, content } = matter(browser.content);
  const spec = parseToolDef(data as Record<string, unknown>, "web", content)!.spec as { args: Record<string, string> };
  // Snapshot options: a subtree (whose numbers are found in it again), a
  // depth, the empty containers dropped, only what changed.
  assert.match(src, /saveRefs\(refs, values\.within\)/);
  assert.match(src, /const scopes = saved\.within \?/, "a scoped number is looked up in its scope");
  assert.match(src, /depth: ariaDepth/);
  assert.match(src, /function compactAria\(snapshot\)/);
  assert.match(src, /function ariaDelta\(text, remember = false\)/);
  // The picture and the text share numbers.
  assert.match(src, /async function annotatedShot\(abs, opts = \{\}\)/);
  assert.match(src, /if \(found\.length !== info\.of\) continue;/, "a box is found the way @e4 is, and skipped rather than guessed");
  assert.match(src, /getElementById\("__foldrun_annotations"\)\?\.remove\(\)/, "the overlay never stays on the page");
  // WebMCP over the DevTools protocol, with the launch features in one switch.
  assert.match(src, /"WebMCPTesting", "DevToolsWebMCPSupport"/);
  assert.match(src, /cdp\.send\("WebMCP\.enable"\)/);
  assert.match(src, /send\("WebMCP\.invokeTool", \{ frameId: tool\.frameId, toolName: tool\.name/);
  assert.match(src, /data, not instructions/);
  // A credential secret signs in, and never comes back: redacted by value,
  // no script in the same call, and a url in the secret pins the site.
  assert.match(src, /function readCredential\(name\)/);
  assert.match(src, /let credentialStep = null;/);
  assert.match(src, /if \(credentialStep\) fail\(/, "the script guard covers a sign-in");
  assert.match(src, /this credential is for/);
  assert.match(src, /out = redact\(out\.trim\(\)\);/);
  assert.match(src, /writeFileSync\(file, redact\(JSON\.stringify\(results/);
  // The agent's lock: an allowlist a call can only narrow, at the network
  // layer and for sockets, and a deny list checked before a browser opens.
  assert.match(src, /a call may narrow it, not widen it/);
  assert.match(src, /return route\.abort\("blockedbyclient"\)/);
  assert.match(src, /context\.routeWebSocket\(/);
  assert.match(src, /contextOptions\.serviceWorkers = "block"/);
  assert.match(src, /is denied for this agent/);
  assert.match(src, /FOLDRUN_BROWSER_DENY/);
  // Saved logins encrypted at rest when the agent names a key.
  assert.match(src, /createCipheriv\("aes-256-gcm", key, iv\)/);
  assert.match(src, /does not open it/);
  // Lightpanda: its own process on a free port, stopped with the call, and
  // the modes that need pixels refused up front.
  assert.match(src, /async function startCdpEngine\(name\)/);
  assert.match(src, /lightpandaProc\.kill\("SIGKILL"\)/);
  assert.match(src, /needs a browser that renders; lightpanda reads and drives pages without drawing them/);
  // The rest.
  assert.match(src, /--enable-unsafe-webgpu/);
  assert.match(src, /--load-extension=/);
  assert.match(src, /Profiler\.start/);
  assert.match(src, /async function visualDiff\(p\)/);
  assert.match(src, /function REACT_TREE\(opts\)/);
  assert.match(src, /async function humanMoveTo\(x, y\)/);
  assert.match(src, /page\.keyboard\.insertText\(v\)/);
  assert.match(src, /live view: \$\{plan\.liveUrl\}/);
  // deny: in the agent's block is checked by core against core's list; the
  // two lists are one list, or a new action could not be denied.
  const toolActions = JSON.parse(src.match(/const ACTIONS = (\[[\s\S]*?\]);/)![1].replace(/\/\/.*$/gm, "").replace(/,\s*\]/, "]"));
  assert.deepEqual([...WEB_BROWSE_ACTIONS].sort(), [...toolActions].sort(), "core's WEB_BROWSE_ACTIONS is the tool's ACTIONS");
  assert.deepEqual([...WEB_BROWSE_ACTIONS].sort(), [...ACTIONS].sort());
  // The audit of 2026-09-29, each fix pinned: a redirect is checked hop by
  // hop, an empty call list is not "no limit", a wildcard needs a wildcard,
  // secrets are redacted on every channel (stderr included, JSON-escaped
  // too), recordings refuse a sign-in, script and navigation by other names
  // are denied, and an engine process dies with the call however it ends.
  assert.match(src, /route\.fetch\(\{ maxRedirects: 0 \}\)/);
  assert.match(src, /if \(blockAllowed\.length && !allowedDomains\.length\) allowedDomains = \[\.\.\.blockAllowed\];/);
  assert.match(src, /blockAllowed\.some\(\(b\) => b\.startsWith\("\*\."\)/);
  assert.match(src, /console\.error = \(\.\.\.a\) => write\(\.\.\.a\.map/);
  assert.match(src, /const escaped = JSON\.stringify\(value\)\.slice\(1, -1\);/);
  assert.match(src, /it would keep the secret/);
  assert.match(src, /if \(kind === "wait" && step\[kind\] === "fn"\) denyAs\("eval"/);
  assert.match(src, /process\.on\("exit", \(\) => \{ try \{ lightpandaProc\?\.kill\("SIGKILL"\)/);
  assert.match(src, /secretValue\(values\.state_key, "the key that encrypts saved logins"\);/, "the key is read before the call runs");
  assert.match(src, /function emitPage\(text\)/);
  assert.match(src, /RTCPeerConnection/);
  // Obscura: its own program like Lightpanda, and never asked to intercept.
  assert.match(src, /obscura: \{\s+env: "OBSCURA_BIN"/);
  assert.match(src, /if \(allowedDomains\.length && engineRefusal\(values\.browser, "allowed_domains"\)\) fail\(/);
  assert.match(src, /if \(engineRefusal\(values\.browser, kind\)\) fail\(`action \$\{n\}: /, "mocks and other actions an engine cannot do");
  // The live view: the page streamed through the step's lease, off for a
  // call that signs in, and followed into another tab.
  assert.match(src, /`\$\{m\[1\]\}\/live\/\$\{m\[2\]\}`/);
  assert.match(src, /Page\.startScreencast/);
  assert.match(src, /live view: off for this call — it signs in/);
  assert.match(src, /FOLDRUN_BROWSER_LIVE_VIEW === "0"/);
  assert.match(src, /FOLDRUN_BROWSER_VIDEO === "1"/);
  // The program is one file an account copies into its library, so it must
  // fit the store's cap — installing it failed the day it outgrew 256 KB.
  assert.ok(src.length < MAX_EDITABLE_FILE * 0.9, `the browser program is ${src.length} chars; the library takes ${MAX_EDITABLE_FILE}`);
  // Each call's recording has its own name, so a step's calls do not
  // overwrite each other and every one reaches the run page.
  assert.match(src, /const videoTarget = recordingTarget\("video", videoDefault, "\.webm"\);/);
  assert.match(src, /return `outputs\/video\/\$\{when\}-\$\{host \|\| "page"\}\.webm`;/);
  // Any DevTools address, a cap on output, and two pages compared.
  assert.match(src, /cdp: \{\s+label: "a DevTools address", secret: "BROWSER_CDP_URL"/);
  assert.match(src, /async function diffAgainstPage\(p, otherUrl\)/);
  assert.match(src, /out\.slice\(0, outputCap\)/);
  for (const k of ["within", "depth", "compact", "delta", "annotate", "visual", "init", "allowed_domains", "boundaries", "webgpu", "extensions", "ignore_https_errors", "cpu_profile", "state_key", "max_output", "against"]) {
    assert.match(src, new RegExp(`\\b${k}: \\{ type: "string" \\}`), `${k} is parsed`);
    assert.ok(spec.args[k], `${k} is documented`);
  }
});

test("the browser definition tells the agent a screenshot can be read back, and how to make it cheap", () => {
  const { data, content } = matter(browser.content);
  const spec = parseToolDef(data as Record<string, unknown>, "web", content)!.spec as { args: Record<string, string> };
  assert.match(spec.args.mode, /outputs\/page\.png, the full page; Read that file to see it/, "names the file and the tool that opens it");
  assert.match(spec.args.actions, /"quality"/, "the quality knob is documented");
  assert.match(spec.args.actions, /"clip": \[x, y, w, h\]/, "the clip rectangle is documented");
  assert.match(spec.args.actions, /"settle": false/, "the lazy-load scroll can be skipped");
});

test("confirm is the write-then-read-back contract: reload, prove it stuck, fail if it did not", () => {
  const src = GALLERY.find((t) => t.name === "web")!.extra!.find((f) => f.file === "web/browse.mjs")!.content;
  assert.match(src, /if \(values\.confirm && !failed\)/);
  assert.match(src, /confirm= needs actions/, "confirming a page nobody changed proves nothing");
  assert.match(src, /the change did NOT stick/);
  assert.match(src, /Do not retry/, "a refused write is not a flake");
  assert.match(src, /process\.exit\(1\)/);
  const { data, content } = matter(GALLERY.find((t) => t.name === "web")!.content);
  const spec = parseToolDef(data as Record<string, unknown>, "web", content)!.spec as { args: Record<string, string> };
  assert.ok(spec.args.confirm, "confirm is declared");
});

// Numbered elements. The parser and the finding-again rules are pure
// functions inside the program; they are lifted out and run here against a
// snapshot in the shape Playwright 1.63 prints with mode "ai", so the cases
// that break a naive parser — YAML's quoting, duplicates, nameless fields,
// a clickable div, a frame — are held without launching a browser.
function refHelpers() {
  const src = browser.wrapper!.content;
  const from = src.indexOf("const INTERACTIVE_ROLES");
  const to = src.indexOf("function readRefs");
  const tail = src.slice(src.indexOf("function interactiveOnly"), src.indexOf("const extracted = [];"));
  assert.ok(from > 0 && to > from && tail.length > 0, "the ref helpers are where the test expects them");
  return new Function(`${src.slice(from, to)}\n${tail}\nreturn { parseRefLine, refsFrom, interactiveOnly };`)() as {
    parseRefLine: (l: string) => { role: string; name: string | null; ref: string; pointer: boolean; text: string | null } | null;
    refsFrom: (s: string) => Record<string, { role: string; name: string | null; text: string | null; frame: boolean; key?: string; nth?: number; of?: number }>;
    interactiveOnly: (s: string) => string;
  };
}

const SNAPSHOT = [
  "- generic [active] [ref=e1]:",
  "  - 'heading \"It''s \\\"quoted\\\": yes\" [level=1] [ref=e2]'",
  "  - button \"Delete\" [ref=e5]",
  "  - button \"Delete\" [ref=e7]",
  "  - 'button \"Say \\\"hi\\\": now\" [ref=e8]': x",
  "  - textbox [ref=e9]",
  "  - textbox \"Email\" [ref=e10]",
  "  - generic [ref=e11] [cursor=pointer]: Clickable div",
  "  - link \"Other page\" [ref=e12] [cursor=pointer]:",
  "    - /url: /other.html",
  "  - iframe [ref=e13]:",
  "    - button \"In frame\" [ref=f1e2]",
  "  - paragraph [ref=e14]: nothing yet",
].join("\n");

test("mode=aria numbers: a line is read through YAML's quoting", () => {
  const { parseRefLine } = refHelpers();
  assert.deepEqual(parseRefLine(SNAPSHOT.split("\n")[1]), { role: "heading", name: 'It\'s "quoted": yes', ref: "e2", pointer: false, text: null });
  assert.deepEqual(parseRefLine(SNAPSHOT.split("\n")[4]), { role: "button", name: 'Say "hi": now', ref: "e8", pointer: false, text: "x" });
  assert.equal(parseRefLine("    - /url: /other.html"), null, "a property line is not an element");
  assert.equal(parseRefLine("  - text: Agree"), null, "nor is bare text");
});

test("mode=aria numbers: each is kept as what finds it again, not the number", () => {
  const refs = refHelpers().refsFrom(SNAPSHOT);
  assert.deepEqual([refs.e5.nth, refs.e5.of, refs.e7.nth, refs.e7.of], [0, 2, 1, 2], "the second Delete is the second of two");
  assert.equal(refs.e8.name, 'Say "hi": now');
  // A nameless textbox is found by getByRole("textbox"), which matches the
  // named one too — so it is placed among every textbox.
  assert.deepEqual([refs.e9.name, refs.e9.nth, refs.e9.of], [null, 0, 2]);
  assert.deepEqual([refs.e11.role, refs.e11.text, refs.e11.of], ["generic", "Clickable div", 1], "a clickable div is found by its text");
  assert.equal(refs.e1.key, undefined, "a wrapper with no role or text cannot be found again, and says so");
  assert.deepEqual([refs.f1e2.frame, refs.e5.frame], [true, false]);
});

test("mode=aria interactive=true keeps only what can be acted on", () => {
  assert.equal(refHelpers().interactiveOnly(SNAPSHOT), [
    'button "Delete" [ref=e5]',
    'button "Delete" [ref=e7]',
    'button "Say \\"hi\\": now" [ref=e8]',
    "textbox [ref=e9]",
    'textbox "Email" [ref=e10]',
    'clickable "Clickable div" [ref=e11]',
    'link "Other page" [ref=e12] -> /other.html',
    'button "In frame" [ref=f1e2]',
  ].join("\n"));
});

test("an action takes @e4 wherever it takes a selector, and fails by name rather than guess", () => {
  const src = browser.wrapper!.content;
  assert.match(src, /async function target\(sel\) \{\n  if \(isRef\(sel\)\) return refTarget\(sel\);/, "every action finds its element through target()");
  assert.match(src, /ariaSnapshot\(\{ mode: "ai", timeout: ARIA_TIMEOUT, \.\.\.\(ariaDepth \? \{ depth: ariaDepth \} : \{\}\) \}\)/, "the aria snapshot is capped so it cannot hang on a heavy page");
  assert.match(src, /returning the visible text instead/, "on timeout it falls back to visible text");
  assert.match(src, /getByRole\(r\.role/, "found again through the public API, not the unlisted aria-ref selector");
  assert.doesNotMatch(src, /aria-ref=/);
  assert.match(src, /is not on the page now/);
  assert.match(src, /so which one is not certain/);
});

test("a call takes engine= as well as browser=, the block's word for the same setting", () => {
  const src = browser.wrapper!.content;
  const { data, content } = matter(browser.content);
  const spec = parseToolDef(data as Record<string, unknown>, "web", content)!.spec as { args: Record<string, string> };
  assert.match(spec.args.engine, /the same as browser/);
  assert.match(spec.args.browser, /chromium \(default, the open-source build\), chrome \(Google Chrome where the image has it, else chromium\), firefox, safari \(WebKit, Safari's\s+engine\), lightpanda or obscura/, "the names a person writes, not the engines underneath");
  assert.match(src, /if \(values\.engine !== undefined\) \{/);
  assert.match(src, /are one setting and disagree/, "both, naming different engines, is refused rather than guessed");
  // Applied before the block's defaults, so a call's engine= still wins over the file.
  assert.ok(src.indexOf("values.browser = values.engine") < src.indexOf("const fromFile = {"));
});

// Check and the tool refuse the same engine/option pairs in the same words
// because they read one table: core's BROWSE_ENGINE_LIMITS, which the tool
// carries as ENGINE_LIMITS. This is what fails if either learns alone.
test("the tool's ENGINE_LIMITS is core's BROWSE_ENGINE_LIMITS, and both word a refusal alike", () => {
  const src = browser.wrapper!.content;
  const literal = src.match(/const ENGINE_LIMITS = (\{[\s\S]*?\n\});/)![1];
  const toolLimits = new Function(`return ${literal}`)();
  assert.deepEqual(toolLimits, BROWSE_ENGINE_LIMITS);
  const toolEngines = JSON.parse(src.match(/const ENGINES = (\[[^\]]*\]);/)![1]);
  assert.deepEqual(toolEngines, [...BROWSE_ENGINES]);
  const refusal = new Function("ENGINE_LIMITS", `return ${src.match(/const engineRefusal = (\(engine, what\) => [^;]+);/)![1]}`)(toolLimits);
  for (const [engine, row] of Object.entries(BROWSE_ENGINE_LIMITS)) {
    for (const what of row.cannot) assert.equal(refusal(engine, what), browseEngineRefusal(engine, what));
  }
  assert.equal(refusal("chromium", "video"), null);
  // Every entry is something the tool actually checks.
  for (const what of new Set(Object.values(BROWSE_ENGINE_LIMITS).flatMap((r) => r.cannot))) {
    const checked = what.startsWith("mode=") ? true : (WEB_BROWSE_ACTIONS as readonly string[]).includes(what) || src.includes(`"${what}"]`) || src.includes(`engineRefusal(values.browser, "${what}")`);
    assert.ok(checked, `${what} is in the table but the tool never asks about it`);
  }
});
