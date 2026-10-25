// Three things web/browse.mjs says plainly (2026-10-01):
//   - Obscura's refusal of a private or loopback address, which reached the
//     model as "Protocol error (Page.navigate): Network error: …";
//   - a pinned user agent whose Chrome is not the browser's own;
//   - the vendor session settings under their new name, vendor_session
//     (FOLDRUN_BROWSER_VENDOR_SESSION), the old env name still read.
// Pure helpers lifted out of the program, as the other gallery tests do.
//
//   node --test tests/browse-engine-notes.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { GALLERY } from "../src/gallery.ts";

const web = GALLERY.find((t) => t.name === "web")!;
const src = web.extra!.find((f) => f.file === "web/browse.mjs")!.content;
const slice = (from: string, to: string) => {
  const a = src.indexOf(from);
  assert.ok(a >= 0, from);
  return src.slice(a, src.indexOf(to, a));
};

const navErrorFor = (isObscura: boolean) =>
  new Function("isObscura", `${slice("function navError(", "\nasync function navigate(")}\nreturn navError;`)(isObscura) as (e: Error, url: string) => Error;

test("obscura: a private or loopback address is refused in plain words, with the way out", () => {
  const navError = navErrorFor(true);
  // The two texts obscura 0.2.3 gave, driven over CDP on 2026-10-01.
  const ip = new Error("page.goto: Protocol error (Page.navigate): Network error: Network error: Access to private/internal IP address 127.0.0.1 is not allowed");
  const host = new Error("page.goto: Protocol error (Page.navigate): Network error: Network error: Access to localhost domain 'localhost' is not allowed");
  const a = navError(ip, "http://127.0.0.1:8765/");
  assert.match(a.message, /^engine obscura refuses private and loopback addresses \(127\.0\.0\.1\)/);
  assert.match(a.message, /use engine chrome or chromium for a local or internal page/);
  assert.match(navError(host, "http://localhost:3000/x").message, /\(localhost\)/);
  const other = new Error("net::ERR_NAME_NOT_RESOLVED");
  assert.equal(navError(other, "http://nope.invalid/"), other, "any other failure is passed through as it was");
  assert.equal(navErrorFor(false)(ip, "http://127.0.0.1/"), ip, "only obscura's refusal is reworded");
});

test("both navigations an obscura call makes go through it", () => {
  assert.match(src, /if \(!\/Download is starting\/\.test\(err\.message\)\) throw navError\(err, url\);/);
  assert.match(src, /throw navError\(firstErr \?\? new Error\("no response"\), u\);/);
});

test("the tool's description says obscura will not open a local page", () => {
  assert.match(web.content, /obscura[^"]*refuses private and loopback addresses \(localhost, 127\.0\.0\.1/);
});

test("a pinned user agent's Chrome major, against the browser's own", () => {
  const uaChromeMajor = new Function(`${slice("function uaChromeMajor(", "\nconst desktopUa")}\nreturn uaChromeMajor;`)() as (ua: string) => string | null;
  assert.equal(uaChromeMajor("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36"), "153");
  assert.equal(uaChromeMajor("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/154.0.0.0 Safari/537.36"), "154");
  assert.equal(uaChromeMajor("Mozilla/5.0 (Windows NT 10.0; rv:140.0) Gecko/20100101 Firefox/140.0"), null);
  // The note: on a Chrome engine, a pinned UA, no device; the default UA
  // (desktopUa) already follows the installed Chrome and is not compared.
  assert.match(src, /if \(values\.user_agent && isChromium && !values\.device\) \{/);
  assert.match(src, /user_agent says Chrome \$\{pinned\}, and this browser is Chrome \$\{actual\}/);
  assert.match(src, /contextOptions\.userAgent = desktopUa\(chromiumVersion\(\)\)/, "the default follows the installed Chrome");
});

test("the vendor session arrives as FOLDRUN_BROWSER_VENDOR_SESSION; the old name is still read", () => {
  const line = src.split("\n").find((l) => l.startsWith("const SESSION = "))!;
  const read = (env: Record<string, string>) => new Function("process", `${line}\nreturn SESSION;`)({ env });
  assert.deepEqual(read({ FOLDRUN_BROWSER_VENDOR_SESSION: '{"captcha":true}' }), { captcha: true });
  assert.deepEqual(read({ FOLDRUN_BROWSER_SESSION: '{"stealth":true}' }), { stealth: true }, "a core from before the rename");
  assert.deepEqual(read({ FOLDRUN_BROWSER_VENDOR_SESSION: '{"captcha":true}', FOLDRUN_BROWSER_SESSION: '{"stealth":true}' }), { captcha: true }, "the new name wins");
  assert.deepEqual(read({}), {});
  assert.doesNotMatch(src, /web\.browse\.session:|\(session\.keep\)/, "the program says vendor_session");
});

test("engine chrome's default user agent is Google Chrome's version, not Playwright's Chromium's", () => {
  // chromium.executablePath() takes no channel; asked for "chrome" it gave
  // Chromium's path, and the default UA claimed 153 while Chrome 154 sent it.
  const body = slice("const CHROME_PATHS = {", "\nfunction chromiumVersion(");
  const pick = (launchOptions: Record<string, unknown>, present: string[]) =>
    new Function("launchOptions", "fs", "chromium", `${body}\nreturn launchedBinary();`)(
      launchOptions,
      { existsSync: (p: string) => present.includes(p) },
      { executablePath: () => "/opt/browser/chromium-1243/chrome-linux/chrome" },
    );
  assert.equal(pick({ channel: "chrome" }, ["/opt/google/chrome/chrome"]), "/opt/google/chrome/chrome");
  assert.equal(pick({ channel: "chrome" }, ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  assert.equal(pick({ channel: "chrome-beta" }, ["/opt/google/chrome/chrome", "/opt/google/chrome-beta/chrome"]), "/opt/google/chrome-beta/chrome");
  assert.equal(pick({ channel: "chrome" }, []), null, "no Chrome: no version rather than Chromium's");
  assert.equal(pick({ channel: "chromium" }, []), "/opt/browser/chromium-1243/chrome-linux/chrome");
  assert.equal(pick({ channel: "chrome", executablePath: "/opt/browser/chrome/150/chrome" }, []), "/opt/browser/chrome/150/chrome", "a version: build wins");
  assert.doesNotMatch(body, /executablePath\(\{ channel/);
});
