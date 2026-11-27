// FOL-402 (27 Nov 2026): one catalog of refusals — the message leads with
// what to do, error.foldrun says it again for a program — and the Iran front
// and notice as console settings (network.iran_*), with the environment as
// the fallback, and the notice on the gateway's answers to a caller in Iran.
//
//   node --test tests/error-catalog-front.test.ts

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-catalog-"));
delete process.env.FOLDRUN_DATABASE_URL;

const s = await import("../src/settings.ts");
const cat = await import("../src/error-catalog.ts");
const front = await import("../src/network-front.ts");
const door = await import("../src/gateway-door.ts");
const fs2 = fs;

const row = (key: string, value: unknown, version: number) => ({ key, value, version, updatedBy: "op@example.com", updatedAt: new Date().toISOString() }) as never;
const ENV = ["FOLDRUN_IRAN_API_URL", "FOLDRUN_IRAN_NOTICE", "FOLDRUN_IRAN_NOTICE_EXPIRES", "FOLDRUN_IRAN_NOTICE_ACTION", "FOLDRUN_TRUST_PROXY"];

beforeEach(async () => {
  for (const k of ENV) delete process.env[k];
  s.writeSettingsFile([]);
  s.resetSettingsSnapshot();
  await s.loadSettings();
});

// ------------------------------------------------------------ the catalog

test("a catalogued refusal leads with what to do, keeps what happened word for word, and says it again in error.foldrun", () => {
  const e = cat.catalogError("authentication_error", "API key revoked", "key_revoked", 401);
  assert.equal(e.message, "Sign in again, or use a current key (run `foldrun login`): API key revoked");
  assert.equal(e.code, "key_revoked", "the code a program already branches on stays");
  assert.deepEqual(e.foldrun, { code: "key_revoked", fix: "Sign in again, or use a current key", command: "foldrun login", command_kind: "repair", docs: "https://docs.foldrun.io/api#errors" });
  assert.equal(e.type, "authentication_error");
});

test("no code: the status picks a default entry; a code the catalog lacks keeps its message as it was", () => {
  const rate = cat.catalogError("rate_limit_error", "this key's request rate is reached", undefined, 429);
  assert.match(String(rate.message), /^Slow down and retry after the Retry-After seconds: this key's request rate/);
  assert.equal(rate.code, undefined, "no code is invented on error.code");
  assert.equal((rate.foldrun as { code: string }).code, "rate_limited");
  const other = cat.catalogError("invalid_request_error", "bad thing", "server_tool_not_offered", 400);
  assert.deepEqual(other, { type: "invalid_request_error", message: "bad thing", code: "server_tool_not_offered" });
  const plain400 = cat.catalogError("invalid_request_error", "the request names no model", undefined, 400);
  assert.equal(plain400.foldrun, undefined);
});

test("every command in the catalog is one the CLI has, written as a fixed template", () => {
  const cli = path.join(import.meta.dirname, "../../foldrun-cli/docs/cli.md");
  const known = fs2.existsSync(cli) ? fs2.readFileSync(cli, "utf8") : null;
  for (const [code, e] of Object.entries(cat.ERROR_CATALOG)) {
    assert.ok(e.fix.length > 5 && !/\.$/.test(e.fix), `${code}: a short fix, no full stop`);
    if (!e.command) continue;
    assert.match(e.command, /^foldrun( [a-z][a-z-]*){1,3}$/, `${code}: a plain command, no placeholders or shell`);
    assert.ok(e.command_kind === "diagnose" || e.command_kind === "repair", `${code}: says what the command does`);
    if (known) assert.ok(known.includes(e.command) || known.includes(`\`${e.command.split(" ").slice(0, 3).join(" ")}`), `${code}: ${e.command} is in foldrun-cli docs/cli.md`);
  }
});

// ------------------------------------------------------ the front, set

test("the front: a console row over the environment; only CloudFront names over https survive, first is answered", async () => {
  assert.deepEqual(front.iranFronts(), []);
  assert.equal(front.iranFrontUrl(), null);
  process.env.FOLDRUN_IRAN_API_URL = "https://d123.cloudfront.net/";
  assert.equal(front.iranFrontUrl(), "https://d123.cloudfront.net", "the environment, while no row says");
  s.writeSettingsFile([row("network.iran_api_url", "https://dnew1.cloudfront.net,https://dnew2.cloudfront.net", 1)]);
  await s.loadSettings();
  assert.deepEqual(front.iranFronts(), ["https://dnew1.cloudfront.net", "https://dnew2.cloudfront.net"], "the row wins: one change in the console");
  for (const bad of ["http://d1.cloudfront.net", "https://evil.example", "https://d1.cloudfront.net.evil.example", "https://d1.cloudfront.net:8443", "https://u:p@d1.cloudfront.net", "https://d1.cloudfront.net/path", "not a url"]) {
    s.writeSettingsFile([row("network.iran_api_url", bad, 2)]);
    await s.loadSettings();
    assert.deepEqual(front.iranFronts(), [], `${bad} is never answered`);
  }
});

test("a console write of the front is checked: no free text, no other host", () => {
  const def = s.settingDef("network.iran_api_url")!;
  assert.ok("value" in s.parseSettingValue(def, "https://dmdw0aty3jgf6.cloudfront.net"));
  assert.ok("value" in s.parseSettingValue(def, "https://a1.cloudfront.net,https://b2.cloudfront.net"));
  assert.ok("value" in s.parseSettingValue(def, ""), "empty clears it");
  for (const bad of ["https://api.foldrun.io", "http://a1.cloudfront.net", "https://a1.cloudfront.net/", "https://A1.cloudfront.net", "https://a1.cloudfront.net, https://b2.cloudfront.net", "https://a.cloudfront.net,https://b.cloudfront.net,https://c.cloudfront.net,https://d.cloudfront.net,https://e.cloudfront.net"]) {
    assert.ok("error" in s.parseSettingValue(def, bad), `${bad} refused`);
  }
  const notice = s.settingDef("network.iran_notice")!;
  assert.ok("value" in s.parseSettingValue(notice, "Iran's filter blocked our old address — restart Claude Code."));
  for (const bad of ["<script>x</script>", "a‮b", "line\none"]) assert.ok("error" in s.parseSettingValue(notice, bad), JSON.stringify(bad));
  const action = s.settingDef("network.iran_notice_action")!;
  assert.ok("value" in s.parseSettingValue(action, "restart_claude_code"));
  assert.ok("error" in s.parseSettingValue(action, "rm -rf ~"));
});

// ------------------------------------------------------- the notice

test("the notice: its id changes with it, it ends when it says, its action is a fixed command", async () => {
  assert.equal(front.iranNotice(), null);
  s.writeSettingsFile([row("network.iran_notice", "Iran's filter blocked the old address; you were moved.", 1), row("network.iran_notice_action", "run_doctor", 2)]);
  await s.loadSettings();
  const n = front.iranNotice()!;
  assert.equal(n.message, "Iran's filter blocked the old address; you were moved.");
  assert.equal(n.action, "run_doctor");
  assert.equal(n.command, "foldrun doctor");
  assert.equal(n.expires, null);
  assert.match(n.id, /^[0-9a-f]{12}$/);
  s.writeSettingsFile([row("network.iran_notice", "Another message.", 3), row("network.iran_notice_expires", "2026-12-01", 4)]);
  await s.loadSettings();
  const m = front.iranNotice(Date.parse("2026-11-28T00:00:00Z"))!;
  assert.notEqual(m.id, n.id);
  assert.equal(m.expires, "2026-12-01T00:00:00.000Z");
  assert.equal(front.iranNotice(Date.parse("2026-12-01T00:00:01Z")), null, "past its end: gone");
  process.env.FOLDRUN_IRAN_NOTICE = "from the environment";
  s.writeSettingsFile([]);
  await s.loadSettings();
  assert.equal(front.iranNotice()!.message, "from the environment");
  process.env.FOLDRUN_IRAN_NOTICE_EXPIRES = "soon";
  assert.equal(front.iranNotice(), null, "an end that does not read is not 'for ever'");
});

test("only a caller in Iran is given the notice; the country is believed only behind Cloudflare", () => {
  process.env.FOLDRUN_IRAN_NOTICE = "hello\u0007 there";
  assert.equal(front.noticeFor({ "cf-ipcountry": "IR" }), null, "no Cloudflare stamp: not believed");
  process.env.FOLDRUN_TRUST_PROXY = "cloudflare";
  assert.equal(front.noticeFor({ "cf-ipcountry": "IR" })!.message, "hello there", "control characters stripped, whatever the source");
  assert.equal(front.noticeFor({ "cf-ipcountry": "DE" }), null);
  assert.equal(front.noticeFor(new Headers({ "x-foldrun-front": "ir" }))!.message, "hello there", "the front's stamp, as Fetch Headers");
  const h = front.noticeHeaders(front.noticeFor({ "x-foldrun-front": "ir" }));
  assert.equal(decodeURIComponent(h["x-foldrun-notice"]), "hello there");
  assert.match(h["x-foldrun-notice"], /^[\x21-\x7e]+$/, "ASCII only in a header");
});

// ------------------------------------------- the gateway's own answers

test("the gateway: a refusal carries error.foldrun, and a caller in Iran gets X-Foldrun-Notice on it", async () => {
  process.env.FOLDRUN_IRAN_NOTICE = "Iran's filter blocked our old address: restart Claude Code";
  process.env.FOLDRUN_IRAN_NOTICE_ACTION = "restart_claude_code";
  const sha = (k: string) => crypto.createHash("sha256").update(k).digest("hex");
  door.setGatewayKeyLookupForTests(async (h) => (h === sha("mda_revoked") ? ({ id: "k9", hash: h, prefix: "mda_x", label: "x", tenant: "acme", createdAt: new Date().toISOString(), revokedAt: new Date().toISOString(), role: "viewer", workspaces: null, purpose: "gateway", gateway: { capUsd: 5, dailyUsd: null } } as never) : null));
  const d = await door.startGatewayDoor(0);
  try {
    const post = (headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${d.port}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ model: "claude-x", max_tokens: 1, messages: [] }) });
    const r = await post({ "x-api-key": "mda_revoked", "x-foldrun-front": "ir" });
    assert.equal(r.status, 401);
    assert.equal(decodeURIComponent(r.headers.get("x-foldrun-notice") ?? ""), "Iran's filter blocked our old address: restart Claude Code");
    assert.match(r.headers.get("x-foldrun-notice-id") ?? "", /^[0-9a-f]{12}$/);
    const body = (await r.json()) as { type: string; error: { type: string; message: string; code: string; foldrun: { code: string; command: string } } };
    assert.equal(body.type, "error");
    assert.equal(body.error.type, "authentication_error");
    assert.match(body.error.message, /^Sign in again, or use a current key \(run `foldrun login`\): API key revoked/);
    assert.equal(body.error.code, "key_revoked");
    assert.equal(body.error.foldrun.command, "foldrun login");
    const none = await post({ "x-api-key": "mda_unknown" });
    assert.equal(none.headers.get("x-foldrun-notice"), null, "not in Iran: no notice");
    assert.equal(((await none.json()) as { error: { foldrun: { code: string } } }).error.foldrun.code, "key_unknown");
  } finally {
    door.setGatewayKeyLookupForTests(null);
    await d.close();
  }
});

test("a model the gateway does not offer is refused as model_unavailable, with what to run", () => {
  const r = door.routeOf("POST", "/v1/messages", Buffer.from(JSON.stringify({ model: "nosuch/thing" })));
  assert.ok("error" in r);
  assert.equal((r as { code?: string }).code, "model_unavailable");
  assert.equal(cat.foldrunError("model_unavailable")!.command, "foldrun account model prices");
});

test("a notice cut at 400 never splits a character, and an upstream cannot set the notice headers", () => {
  process.env.FOLDRUN_TRUST_PROXY = "cloudflare";
  process.env.FOLDRUN_IRAN_NOTICE = "a".repeat(399) + "😀😀";
  const n = front.noticeFor({ "cf-ipcountry": "IR" })!;
  assert.equal(Array.from(n.message).length, 400);
  assert.doesNotThrow(() => front.noticeHeaders(n));
  const src = fs2.readFileSync(path.join(import.meta.dirname, "../src/gateway-door.ts"), "utf8");
  assert.match(src.match(/const DROP_BACK = (.*);/)![1], /x-foldrun-notice/);
});

test("a lone surrogate in a stored notice is dropped, so the header can always be made", async () => {
  process.env.FOLDRUN_TRUST_PROXY = "cloudflare";
  s.writeSettingsFile([row("network.iran_notice", "x\ud800y", 1)]);
  await s.loadSettings();
  const n = front.noticeFor({ "cf-ipcountry": "IR" });
  if (n) {
    assert.equal(n.message, "xy");
    assert.doesNotThrow(() => front.noticeHeaders(n));
  }
});
