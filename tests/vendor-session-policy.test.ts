// FOL-145 phase C (light): the egress proxy's rule for a held vendor browser's
// API calls — the call that starts a browser gets foldrun's door as its only
// proxy, reading and ending a session pass, anything else is refused.
//
//   node --test tests/vendor-session-policy.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { doorUrl, enforceVendorRequest, vendorForHost } from "../src/vendor-session-policy.ts";

const door = { server: "https://vendor-egress.example.com:8443" };
let minted = 0;
const mint = () => { minted++; return { username: `fv_${"a".repeat(22)}`, password: "p".repeat(43) }; };
const body = (o: unknown) => Buffer.from(JSON.stringify(o));
const parse = (b?: Buffer) => JSON.parse(b!.toString());

test("hosts: the four vendors that take a customer proxy, and nothing else", () => {
  assert.equal(vendorForHost("api.browserbase.com"), "browserbase");
  assert.equal(vendorForHost("API.STEEL.DEV."), "steel");
  assert.equal(vendorForHost("connect.steel.dev"), "steel");
  assert.equal(vendorForHost("api.hyperbrowser.ai"), "hyperbrowser");
  assert.equal(vendorForHost("production-sfo.browserless.io"), "browserless");
  for (const h of ["brd.superproxy.io", "browser.zenrows.com", "evil.browserless.io.example", "api.browserbase.com.evil"]) assert.equal(vendorForHost(h), null, h);
});

test("Browserbase: a new session's only proxy is the door, whatever the agent asked for", () => {
  minted = 0;
  const r = enforceVendorRequest({ method: "POST", url: "https://api.browserbase.com/v1/sessions", body: body({ projectId: "p1", proxies: true, browserSettings: { solveCaptchas: true } }) }, door, mint);
  assert.equal(r.action, "rewrite");
  const b = parse((r as { body?: Buffer }).body);
  assert.deepEqual(b.proxies, [{ type: "external", server: "https://vendor-egress.example.com:8443", username: `fv_${"a".repeat(22)}`, password: "p".repeat(43) }]);
  assert.equal(b.projectId, "p1", "the rest of the request is kept");
  assert.deepEqual(b.browserSettings, { solveCaptchas: true });
  assert.equal(minted, 1, "one credential per session");
});

test("Browserbase: reading, a saved-login context and a release pass; any other update is refused", () => {
  const ok = [
    { method: "GET", url: "https://api.browserbase.com/v1/sessions/abc123" },
    { method: "GET", url: "https://api.browserbase.com/v1/sessions/abc123/debug" },
    { method: "POST", url: "https://api.browserbase.com/v1/contexts", body: body({ projectId: "p1" }) },
    { method: "POST", url: "https://api.browserbase.com/v1/sessions/abc123", body: body({ projectId: "p1", status: "REQUEST_RELEASE" }) },
  ];
  for (const r of ok) assert.equal(enforceVendorRequest({ body: null, ...r }, door, mint).action, "pass", `${r.method} ${r.url}`);
  const no = [
    { method: "POST", url: "https://api.browserbase.com/v1/sessions/abc123", body: body({ status: "REQUEST_RELEASE", proxies: true }) },
    { method: "DELETE", url: "https://api.browserbase.com/v1/projects/p1" },
    { method: "GET", url: "https://api.browserbase.com/v1/sessions/../x" },
    { method: "POST", url: "https://api.browserbase.com/v1/sessions", body: Buffer.from("not json") },
  ];
  for (const r of no) assert.equal(enforceVendorRequest({ body: null, ...r }, door, mint).action, "refuse", `${r.method} ${r.url}`);
});

test("Steel: proxyUrl is the door with its credential; release and status pass; the session's websocket passes", () => {
  const r = enforceVendorRequest({ method: "POST", url: "https://api.steel.dev/v1/sessions", body: body({ useProxy: true, proxyUrl: "http://mine:pw@elsewhere:8080", solveCaptcha: true }) }, door, mint);
  assert.equal(r.action, "rewrite");
  const b = parse((r as { body?: Buffer }).body);
  assert.equal(b.proxyUrl, doorUrl(door, mint()));
  assert.equal(b.useProxy, undefined, "Steel's own proxy is off");
  assert.equal(b.solveCaptcha, true);
  assert.equal(enforceVendorRequest({ method: "POST", url: "https://api.steel.dev/v1/sessions/s1/release", body: null }, door, mint).action, "pass");
  assert.equal(enforceVendorRequest({ method: "GET", url: "https://api.steel.dev/v1/sessions/s1", body: null }, door, mint).action, "pass");
  assert.equal(enforceVendorRequest({ method: "GET", url: "wss://connect.steel.dev/?apiKey=x&sessionId=s1", body: null, upgrade: true }, door, mint).action, "pass");
  assert.equal(enforceVendorRequest({ method: "GET", url: "https://connect.steel.dev/whatever", body: null }, door, mint).action, "refuse");
  assert.equal(enforceVendorRequest({ method: "POST", url: "https://api.steel.dev/v1/scrape", body: body({ url: "https://x" }) }, door, mint).action, "refuse", "Steel's scrape API would load pages without the door");
});

test("Hyperbrowser: the door is the proxy server, geo options dropped; stop, status and profiles pass", () => {
  const r = enforceVendorRequest({ method: "POST", url: "https://api.hyperbrowser.ai/api/session", body: body({ useProxy: true, proxyCountry: "US", proxyServer: "http://elsewhere:1", solveCaptchas: true }) }, door, mint);
  assert.equal(r.action, "rewrite");
  const b = parse((r as { body?: Buffer }).body);
  assert.equal(b.useProxy, true);
  assert.equal(b.proxyServer, "https://vendor-egress.example.com:8443");
  assert.equal(b.proxyServerUsername, `fv_${"a".repeat(22)}`);
  assert.equal(b.proxyCountry, undefined);
  assert.equal(b.solveCaptchas, true);
  assert.equal(enforceVendorRequest({ method: "PUT", url: "https://api.hyperbrowser.ai/api/session/h1/stop", body: null }, door, mint).action, "pass");
  assert.equal(enforceVendorRequest({ method: "POST", url: "https://api.hyperbrowser.ai/api/profile", body: body({}) }, door, mint).action, "pass");
  assert.equal(enforceVendorRequest({ method: "POST", url: "https://api.hyperbrowser.ai/api/scrape", body: body({}) }, door, mint).action, "refuse");
});

test("Browserless: only the websocket connection, with externalProxyServer set to the door and every other proxy option gone", () => {
  const r = enforceVendorRequest({ method: "GET", url: "wss://production-sfo.browserless.io/chromium?token=T&proxy=residential&proxyCountry=us&externalProxyServer=http%3A%2F%2Fmine%3A1&blockAds=true", body: null, upgrade: true }, door, mint);
  assert.equal(r.action, "rewrite");
  const u = new URL((r as { url: string }).url);
  assert.equal(u.searchParams.get("externalProxyServer"), doorUrl(door, mint()));
  assert.equal(u.searchParams.get("proxy"), null);
  assert.equal(u.searchParams.get("proxyCountry"), null);
  assert.equal(u.searchParams.get("token"), "T", "the token stays (the proxy filled it)");
  assert.equal(u.searchParams.get("blockAds"), "true");
  assert.equal(u.searchParams.getAll("externalProxyServer").length, 1);
  assert.equal(enforceVendorRequest({ method: "POST", url: "https://production-sfo.browserless.io/content?token=T", body: body({ url: "https://x" }) }, door, mint).action, "refuse", "the REST APIs would load pages without the door");
  // Codex review: a launch option can carry --proxy-bypass-list=* — refused, as is any option not known to be safe.
  const launch = encodeURIComponent(JSON.stringify({ args: ["--proxy-bypass-list=*"] }));
  for (const url of [
    `wss://production-sfo.browserless.io/chromium?token=T&launch=${launch}`,
    "wss://production-sfo.browserless.io/chromium?token=T&--proxy-bypass-list=*",
    "wss://production-sfo.browserless.io/chromium?token=T&Launch=x",
    "wss://production-sfo.browserless.io/chromium/playwright?token=T",
    "wss://production-sfo.browserless.io/?token=T",
  ]) assert.equal(enforceVendorRequest({ method: "GET", url, body: null, upgrade: true }, door, mint).action, "refuse", url);
  assert.equal(enforceVendorRequest({ method: "GET", url: "wss://production-lon.browserless.io/stealth?token=T&timeout=60000", body: null, upgrade: true }, door, mint).action, "rewrite");
});

test("Steel: a websocket with no session would start a new one without the door — refused (Codex review)", () => {
  const ok = { method: "GET", url: "wss://connect.steel.dev/?apiKey=K&sessionId=s1", body: null, upgrade: true };
  assert.equal(enforceVendorRequest(ok, door, mint).action, "pass");
  assert.equal(enforceVendorRequest({ ...ok, url: "wss://connect.steel.dev/?apiKey=K" }, door, mint).action, "refuse", "no sessionId");
  assert.equal(enforceVendorRequest({ ...ok, url: "wss://connect.steel.dev/?apiKey=K&sessionId=s1&proxyUrl=http://x" }, door, mint).action, "refuse", "nothing else on the address");
  assert.equal(enforceVendorRequest(ok, door, mint, (_v, id) => id === "s2").action, "refuse", "a session not started through the door");
  assert.equal(enforceVendorRequest(ok, door, mint, (_v, id) => id === "s1").action, "pass");
});

test("anything not a vendor this door serves is refused, and says why", () => {
  const r = enforceVendorRequest({ method: "GET", url: "https://brd.superproxy.io/", body: null }, door, mint);
  assert.equal(r.action, "refuse");
  assert.match((r as { reason: string }).reason, /not a vendor this door serves/);
  assert.equal(enforceVendorRequest({ method: "GET", url: "::not a url", body: null }, door, mint).action, "refuse");
});
