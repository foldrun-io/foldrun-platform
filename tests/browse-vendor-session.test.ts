// `web.browse.vendor_session:` → each vendor's own request. The vendor table is
// lifted out of the browse program and run with a fetch that records what it
// is sent, so every mapping is checked against the field names in the
// vendors' docs (2026-09-29) without a vendor key.
//
//   node --test tests/browse-vendor-session.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GALLERY } from "../src/gallery.ts";
import { BROWSER_APIS } from "../../foldrun-core/src/providers.ts";

const program = GALLERY.find((t) => t.name === "web")!.extra!.find((f) => f.file === "web/browse.mjs")!.content;
const block = program.slice(program.indexOf("const SESSION = "), program.indexOf("\n};\n", program.indexOf("const VENDORS = {")) + 3);

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function vendors(session: Record<string, unknown>, env: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-session-"));
  const cwd = path.join(root, "ws", "agents", "a");
  fs.mkdirSync(cwd, { recursive: true });
  const calls: Call[] = [];
  const replies: Record<string, unknown> = {
    "https://api.browserbase.com/v1/sessions": { id: "bb-1", connectUrl: "wss://connect.browserbase.com/bb-1" },
    "https://api.browserbase.com/v1/contexts": { id: "ctx-1" },
    "https://api.steel.dev/v1/sessions": { id: "st-1", profileId: "prof-1", sessionViewerUrl: "https://steel/view" },
    "https://api.hyperbrowser.ai/api/session": { id: "hb-1", wsEndpoint: "wss://hb/1", liveUrl: "https://hb/live" },
    "https://api.hyperbrowser.ai/api/profile": { id: "hbp-1", name: "portal" },
  };
  const fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
    const reply = replies[url] ?? {};
    return { ok: true, status: 200, json: async () => reply, text: async () => JSON.stringify(reply) };
  };
  const proc = { env: { FOLDRUN_BROWSER_VENDOR_SESSION: JSON.stringify(session), ...env } };
  const lifted = new Function("fetch", "fs", "path", "cwd", "process", "AbortSignal", `${block}\nreturn VENDORS;`);
  const V = lifted(fetch, fs, path, cwd, proc, AbortSignal) as Record<string, { endpoint: (k: string, s: unknown) => Promise<any>; lacks?: string[] }>;
  const SESSION = session;
  return { V, SESSION, calls, root, cwd, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("Browserbase: proxy location, captcha off, stealth, recording off, ads, region, timeout, a saved context, options merged", async () => {
  const s = { proxy: { country: "AU", city: "Sydney" }, captcha: false, stealth: true, record: false, block: ["ads"], region: "ap-southeast-1", timeout: 1800, keep: "portal", options: { browserSettings: { viewport: { width: 1440, height: 900 } } } };
  const t = vendors(s);
  try {
    const e = await t.V.browserbase.endpoint("KEY", s);
    const ctx = t.calls.find((c) => c.url.endsWith("/v1/contexts"))!;
    assert.equal(ctx.method, "POST");
    const sess = t.calls.find((c) => c.url === "https://api.browserbase.com/v1/sessions")!;
    assert.equal(sess.headers["X-BB-API-Key"], "KEY");
    assert.deepEqual(sess.body, {
      proxies: [{ type: "browserbase", geolocation: { country: "AU", city: "Sydney" } }],
      region: "ap-southeast-1",
      timeout: 1800,
      browserSettings: { solveCaptchas: false, verified: true, recordSession: false, blockAds: true, context: { id: "ctx-1", persist: true }, viewport: { width: 1440, height: 900 } },
    });
    assert.equal(e.ws, "wss://connect.browserbase.com/bb-1");
    assert.equal(e.useDefaultContext, true, "a saved context is the default one");
    // The id is kept in the workspace's state/, and the next run reuses it.
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.root, "ws", "state", "web-browse", "browserbase-portal.json"), "utf8")).id, "ctx-1");
    t.calls.length = 0;
    await t.V.browserbase.endpoint("KEY", s);
    assert.ok(!t.calls.some((c) => c.url.endsWith("/v1/contexts")), "no second context");
  } finally { t.done(); }
});

test("Browserbase: proxy true, and your own proxy from a secret", async () => {
  const t = vendors({});
  try {
    await t.V.browserbase.endpoint("K", { proxy: true });
    assert.deepEqual(t.calls.find((c) => c.url.endsWith("/v1/sessions"))!.body, { proxies: true });
  } finally { t.done(); }
  const t2 = vendors({}, { MY_PROXY: "http://u%40x:p%3Ass@proxy.example:8080" });
  try {
    await t2.V.browserbase.endpoint("K", { proxy: { own: "MY_PROXY" } });
    assert.deepEqual((t2.calls[0].body as { proxies: unknown }).proxies, [{ type: "external", server: "http://proxy.example:8080", username: "u@x", password: "p:ss" }]);
  } finally { t2.done(); }
});

test("Steel: geolocation with its city spelling, captcha, humanized, ads, timeout in ms; a profile made then reused; released at the end", async () => {
  const s = { proxy: { country: "US", state: "CA", city: "Los Angeles" }, captcha: true, stealth: true, block: ["ads"], timeout: 600, keep: "portal" };
  const t = vendors(s);
  try {
    const e = await t.V.steel.endpoint("SK", s);
    assert.equal(t.calls[0].headers["steel-api-key"], "SK");
    assert.deepEqual(t.calls[0].body, {
      useProxy: { geolocation: { country: "US", state: "CA", city: "LOS_ANGELES" } },
      solveCaptcha: true, stealthConfig: { humanizeInteractions: true }, blockAds: true, timeout: 600000, persistProfile: true,
    });
    assert.equal(e.ws, "wss://connect.steel.dev?apiKey=SK&sessionId=st-1");
    assert.deepEqual(e.release, { url: "https://api.steel.dev/v1/sessions/st-1/release", method: "POST", headers: { "steel-api-key": "SK" } });
    await t.V.steel.endpoint("SK", s);
    assert.equal((t.calls[1].body as { profileId?: string }).profileId, "prof-1", "the profile Steel made is the one reused");
  } finally { t.done(); }
});

test("Hyperbrowser: proxy country and state, captcha, stealth, region, minutes, recording, three blocks, a profile; stopped at the end", async () => {
  const s = { proxy: { country: "US", state: "NY" }, captcha: true, stealth: true, region: "us-east", timeout: 90, record: true, block: ["ads", "trackers", "cookies"], keep: "portal" };
  const t = vendors(s);
  try {
    const e = await t.V.hyperbrowser.endpoint("HK", s);
    const prof = t.calls.find((c) => c.url.endsWith("/api/profile"))!;
    assert.deepEqual(prof.body, { name: "portal" });
    const sess = t.calls.find((c) => c.url.endsWith("/api/session"))!;
    assert.equal(sess.headers["x-api-key"], "HK");
    assert.deepEqual(sess.body, {
      useProxy: true, proxyCountry: "US", proxyState: "NY", solveCaptchas: true, useStealth: true, region: "us-east",
      timeoutMinutes: 2, enableWebRecording: true, adblock: true, trackers: true, annoyances: true, profile: { id: "hbp-1", persistChanges: true },
    });
    assert.deepEqual(e.release, { url: "https://api.hyperbrowser.ai/api/session/hb-1/stop", method: "PUT", headers: { "x-api-key": "HK" } });
  } finally { t.done(); }
});

test("Browserless: region is the host, stealth the route, the rest query parameters", async () => {
  const t = vendors({});
  try {
    const u = new URL(await t.V.browserless.endpoint("TOK", { region: "lon", stealth: true, proxy: { country: "DE", city: "Berlin" }, captcha: true, block: ["ads"], timeout: 300, options: { proxySticky: "true" } }));
    assert.equal(u.host, "production-lon.browserless.io");
    assert.equal(u.pathname, "/stealth");
    assert.deepEqual(Object.fromEntries(u.searchParams), { token: "TOK", proxy: "residential", proxyCountry: "de", proxyCity: "Berlin", solveCaptchas: "true", blockAds: "true", timeout: "300000", proxySticky: "true" });
    assert.equal(new URL(await t.V.browserless.endpoint("TOK", {})).href, "wss://production-sfo.browserless.io/chromium?token=TOK");
  } finally { t.done(); }
});

test("Bright Data: the country on the user name; captcha and blocking as its own CDP commands", async () => {
  const t = vendors({});
  try {
    const e = await t.V.brightdata.endpoint("brd-customer-c1-zone-z1:pw", { proxy: { country: "AU" }, captcha: false, block: ["ads", "cookies"] });
    assert.equal(e.ws, "wss://brd-customer-c1-zone-z1-country-au:pw@brd.superproxy.io:9222");
    assert.deepEqual(e.cdpCommands, [["Captcha.setAutoSolve", { autoSolve: false }], ["Unblocker.enableAdBlock", {}], ["Unblocker.enableCookieBlock", {}]]);
  } finally { t.done(); }
});

test("ZenRows: country and a lifetime in minutes on the address; the browser's own identity kept", async () => {
  const t = vendors({});
  try {
    const e = await t.V.zenrows.endpoint("ZK", { proxy: { country: "ES" }, timeout: 150 });
    assert.equal(e.ws, "wss://browser.zenrows.com?apikey=ZK&proxy_country=es&session_ttl=3m");
    assert.equal(e.fixedIdentity, true);
  } finally { t.done(); }
});

test("nothing asked, nothing sent: an empty session is the vendor's defaults", async () => {
  const t = vendors({});
  try {
    await t.V.browserbase.endpoint("K", {});
    await t.V.steel.endpoint("K", {});
    await t.V.hyperbrowser.endpoint("K", {});
    for (const c of t.calls.filter((c) => c.method === "POST")) assert.deepEqual(c.body, {}, c.url);
  } finally { t.done(); }
});

test("the tool's lacks and core's agree, and core names what each vendor's session takes", () => {
  const t = vendors({});
  try {
    for (const b of BROWSER_APIS) {
      assert.deepEqual(t.V[b.name].lacks ?? [], b.lacks ?? [], b.name);
      if (b.name !== "cdp") assert.ok(b.session, `${b.name} says what its session takes`);
    }
  } finally { t.done(); }
});
