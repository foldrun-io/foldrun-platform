// FOL-145: web browse in vendor-door mode — every vendor call and the
// vendor's remote-control socket go through the egress proxy's /e/ door.
//
//   node --test tests/browse-vendor-door.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { GALLERY } from "../src/gallery.ts";

const src = () => GALLERY.find((t) => t.name === "web")!.extra!.find((f) => f.file === "web/browse.mjs")!.content;

function lift(env: Record<string, string | undefined>) {
  const s = src();
  const start = s.indexOf("const VENDOR_DOOR = ");
  const end = s.indexOf("async function vendorJson(");
  assert.ok(start > 0 && end > start);
  return new Function("process", `${s.slice(start, end)}; return { viaDoor, viaDoorWs, VENDOR_DOOR };`)({ env }) as { viaDoor: (u: string) => string; viaDoorWs: (u: string) => string; VENDOR_DOOR: boolean };
}

test("door mode: vendor addresses become the /e/ door's, https for sockets too", () => {
  const d = lift({ FOLDRUN_VENDOR_DOOR: "1", FOLDRUN_EGRESS: "http://egress:8090/e/tok123/" });
  assert.equal(d.VENDOR_DOOR, true);
  assert.equal(d.viaDoor("https://api.steel.dev/v1/sessions"), "http://egress:8090/e/tok123/https://api.steel.dev/v1/sessions");
  assert.equal(d.viaDoorWs("wss://connect.steel.dev?apiKey=%24%7BSTEEL_API_KEY%7D&sessionId=s1"), "ws://egress:8090/e/tok123/https://connect.steel.dev?apiKey=%24%7BSTEEL_API_KEY%7D&sessionId=s1");
});

test("not in door mode (or no egress address): addresses untouched", () => {
  for (const env of [{}, { FOLDRUN_VENDOR_DOOR: "1" }, { FOLDRUN_EGRESS: "http://e/e/t" }]) {
    const d = lift(env);
    assert.equal(d.viaDoor("https://api.steel.dev/v1/sessions"), "https://api.steel.dev/v1/sessions");
    assert.equal(d.viaDoorWs("wss://x/y"), "wss://x/y");
  }
});

test("every vendor call site goes through the door helpers", () => {
  const s = src();
  assert.match(s, /const r = await fetch\(viaDoor\(url\), \{ \.\.\.init, signal: AbortSignal\.timeout\(30_000\) \}\);/, "vendorJson");
  assert.match(s, /fetch\(viaDoor\(`https:\/\/api\.browserbase\.com\/v1\/sessions\/\$\{encodeURIComponent\(j\.id\)\}\/debug`\)/, "Browserbase's debug read");
  assert.match(s, /RELEASE_CHILD, viaDoor\(release\.url\)/, "releases");
  assert.match(s, /connectOverCDP\(viaDoorWs\(plan\.ws\)/, "the vendor's remote-control socket");
});
