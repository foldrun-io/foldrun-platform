// FOL-145: the vendor session rules wired into the egress proxy's /e/ door —
// a held vendor browser's API calls and its remote-control WebSocket. The
// real proxy; nothing reaches a real vendor: refusals answer before any
// upstream call, and the one rewritten call is aimed at port 1, which no one
// answers, after its credential is minted and stored.
//
//   node --test tests/vendor-door-wiring.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import crypto from "node:crypto";
import { egressHooks, startEgressProxy, stopEgressProxy } from "../src/egress-proxy.ts";
import { vendorCredentialStore } from "../src/vendor-egress-credentials.ts";
import type { EgressGrant } from "../../foldrun-core/src/egress.ts";

process.env.FOLDRUN_SECRET_KEY ??= "vendor-door-wiring-test-key";

const door = { vendor: "browserbase", server: "https://vendor-egress.example.com:8443" };
function grant(vendorDoor = true): EgressGrant {
  return {
    secrets: {
      BROWSERBASE_API_KEY: { value: "bb-key", hosts: ["api.browserbase.com"] },
      STEEL_API_KEY: { value: "st-key", hosts: ["api.steel.dev", "connect.steel.dev"] },
    },
    network: { level: "none", hosts: ["example.com"] },
    ...(vendorDoor ? { vendorDoor: door } : {}),
  };
}

async function withProxy(body: (port: number) => Promise<void>) {
  const proxy = await startEgressProxy(0);
  process.env.FOLDRUN_EGRESS_URL = `http://127.0.0.1:${proxy.port}`;
  try { await body(proxy.port); } finally { await stopEgressProxy(); delete process.env.FOLDRUN_EGRESS_URL; }
}

/** A raw WebSocket upgrade through the /e/ door; the status line back. */
function upgrade(port: number, path: string): Promise<string> {
  return new Promise((ok) => {
    const s = net.connect({ host: "127.0.0.1", port });
    let buf = "";
    s.on("error", () => ok(buf || "error"));
    s.on("connect", () => s.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\n\r\n`));
    s.on("data", (d) => { buf += d.toString(); if (buf.includes("\r\n\r\n")) { s.destroy(); ok(buf); } });
    setTimeout(() => { s.destroy(); ok(buf || "timeout"); }, 5_000);
  });
}

test("an API call the vendor's rules do not allow is refused at the /e/ door, and the trail says why", async () => {
  await withProxy(async () => {
    const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-vd1", grant: grant() }))!;
    const r = await fetch(`${lease.url}/https://api.browserbase.com/v1/projects/p1`, { method: "DELETE", headers: { "x-bb-api-key": "${BROWSERBASE_API_KEY}" } });
    assert.equal(r.status, 403);
    assert.match(await r.text(), /not a call this door allows to Browserbase/);
    assert.match(String(await lease.drainLog()), /egress: DELETE api\.browserbase\.com refused — vendor browser held to network:/);
    await lease.release();
  });
});

test("the call that starts a browser mints and stores a door credential for this lease; release revokes it", async () => {
  await withProxy(async () => {
    const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-vd2", grant: grant() }))!;
    // The lease's store key: its token (v1) or the token's SHA-256 (v2).
    const token = new URL(lease.url).pathname.split("/")[2]!;
    // Port 1: nobody answers, so nothing reaches Browserbase; the rewrite
    // (and the credential) happen before the send.
    const r = await fetch(`${lease.url}/https://api.browserbase.com:1/v1/sessions`, { method: "POST", headers: { "content-type": "application/json", "x-bb-api-key": "${BROWSERBASE_API_KEY}" }, body: JSON.stringify({ projectId: "p1", proxies: true }) });
    assert.notEqual(r.status, 403, "not refused by the rules");
    const log = String(await lease.drainLog());
    assert.match(log, /browserbase session started with foldrun's vendor door as its only proxy/);
    const store = vendorCredentialStore();
    const keys = [token, crypto.createHash("sha256").update(token).digest("hex")];
    const found = [];
    for (const k of keys) if ((await store.idsForLease(k)).length) found.push(k);
    assert.equal(found.length, 1, "one credential, under this lease's key");
    const key = found[0]!;
    assert.equal((await store.idsForLease(key)).length, 1, "one credential for the one session");
    await lease.release();
    assert.equal((await store.idsForLease(key)).length, 0, "revoked with the lease");
    assert.equal(await store.leaseRevoked(key), true);
  });
});

test("a WebSocket through the /e/ door: only a held vendor browser's own vendor, after its rules", async () => {
  await withProxy(async (port) => {
    const held = (await egressHooks.lease({ tenant: "acme", runId: "run-vd3", grant: grant() }))!;
    const plain = (await egressHooks.lease({ tenant: "acme", runId: "run-vd4", grant: grant(false) }))!;
    const tok = (u: string) => new URL(u).pathname.split("/")[2]!;
    // No vendor door on the lease: refused.
    assert.match(await upgrade(port, `/e/${tok(plain.url)}/https://connect.steel.dev/?apiKey=\${STEEL_API_KEY}&sessionId=s1`), /^HTTP\/1\.1 403/);
    // Held, but a Steel connection with no session would start one without the door.
    const noSession = await upgrade(port, `/e/${tok(held.url)}/https://connect.steel.dev/?apiKey=\${STEEL_API_KEY}`);
    assert.match(noSession, /^HTTP\/1\.1 403/);
    assert.match(noSession, /must name a session/);
    // A host that is not a vendor: refused.
    assert.match(await upgrade(port, `/e/${tok(held.url)}/https://example.com/socket`), /^HTTP\/1\.1 403/);
    // A lease that does not exist.
    assert.match(await upgrade(port, `/e/${"x".repeat(32)}/https://connect.steel.dev/?sessionId=s1`), /^HTTP\/1\.1 401/);
    await held.release();
    await plain.release();
  });
});

// ------------------------------------------- Codex review of the wiring

test("an allowed GET reaches the network step without a body (fetch refuses a GET with one)", async () => {
  await withProxy(async () => {
    const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-vd5", grant: grant() }))!;
    const r = await fetch(`${lease.url}/https://api.browserbase.com:1/v1/sessions/abc123`, { headers: { "x-bb-api-key": "${BROWSERBASE_API_KEY}" } });
    assert.notEqual(r.status, 403);
    const log = String(await lease.drainLog());
    assert.doesNotMatch(log, /cannot have body/i, log);
    await lease.release();
  });
});

test("a test run never starts a vendor browser: refused, nothing minted, no credential in the answer", async () => {
  await withProxy(async () => {
    const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-vd6", grant: grant(), test: true } as never))!;
    const token = new URL(lease.url).pathname.split("/")[2]!;
    const r = await fetch(`${lease.url}/https://api.steel.dev:1/v1/sessions`, { method: "POST", headers: { "content-type": "application/json", "steel-api-key": "${STEEL_API_KEY}" }, body: "{}" });
    assert.equal(r.status, 403);
    const text = await r.text();
    assert.match(text, /a test run does not start a vendor browser/);
    assert.doesNotMatch(text, /fv_/);
    for (const k of [token, crypto.createHash("sha256").update(token).digest("hex")]) assert.equal((await vendorCredentialStore().idsForLease(k)).length, 0);
    await lease.release();
  });
});

test("the vendor rules hold on the forward door too: a CONNECT the proxy opens (the key is bound there) is held to them", async () => {
  const tls = await import("node:tls");
  const { egressCaPem } = await import("../src/egress-ca.ts");
  await withProxy(async (port) => {
    const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-vd7", grant: grant() }))!;
    const token = new URL(lease.url).pathname.split("/")[2]!;
    const sock = net.connect({ host: "127.0.0.1", port });
    await new Promise<void>((r) => sock.on("connect", () => r()));
    sock.write(`CONNECT api.browserbase.com:443 HTTP/1.1\r\nHost: api.browserbase.com:443\r\nProxy-Authorization: Basic ${Buffer.from(`foldrun:${token}`).toString("base64")}\r\n\r\n`);
    const established = await new Promise<string>((r) => sock.once("data", (d) => r(d.toString())));
    assert.match(established, /^HTTP\/1\.1 200/, established);
    const secure = tls.connect({ socket: sock, servername: "api.browserbase.com", ca: egressCaPem() });
    await new Promise<void>((r, j) => { secure.once("secureConnect", () => r()); secure.once("error", j); });
    secure.write("DELETE /v1/projects/p1 HTTP/1.1\r\nHost: api.browserbase.com\r\nx-bb-api-key: ${BROWSERBASE_API_KEY}\r\nConnection: close\r\n\r\n");
    let answer = "";
    await new Promise<void>((r) => { secure.on("data", (d) => { answer += d.toString(); }); secure.on("end", () => r()); secure.on("close", () => r()); });
    assert.match(answer, /^HTTP\/1\.1 403/, answer.slice(0, 200));
    assert.match(answer, /not a call this door allows to Browserbase/);
    await lease.release();
  });
});

test("no way round the rules for a held vendor step: plain http, an unbound vendor tunnel, a bare address", async () => {
  await withProxy(async (port) => {
    // Steel's hosts allowed on the list but NOT bound: an agent's own key would ride an unread tunnel.
    const g: EgressGrant = { ...grant(), secrets: { BROWSERBASE_API_KEY: { value: "bb-key", hosts: ["api.browserbase.com"] } }, network: { level: "none", hosts: ["example.com", "api.steel.dev", "203.0.113.7"] } };
    const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-vd8", grant: g }))!;
    const token = new URL(lease.url).pathname.split("/")[2]!;
    const auth = `Basic ${Buffer.from(`foldrun:${token}`).toString("base64")}`;
    const connect = (target: string) => new Promise<string>((ok) => {
      const s = net.connect({ host: "127.0.0.1", port });
      s.on("error", () => ok("error"));
      s.on("connect", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${auth}\r\n\r\n`));
      s.once("data", (d) => { s.destroy(); ok(d.toString()); });
    });
    const unbound = await connect("api.steel.dev:443");
    assert.match(unbound, /^HTTP\/1\.1 403/, unbound);
    assert.match(unbound, /foldrun's own key/);
    const bare = await connect("203.0.113.7:443");
    assert.match(bare, /^HTTP\/1\.1 403/, bare);
    assert.match(bare, /bare address/);
    const http = await new Promise<string>((ok) => {
      const s = net.connect({ host: "127.0.0.1", port });
      s.on("connect", () => s.write(`POST http://api.browserbase.com/v1/sessions HTTP/1.1\r\nHost: api.browserbase.com\r\nProxy-Authorization: ${auth}\r\nContent-Length: 2\r\n\r\n{}`));
      s.once("data", (d) => { s.destroy(); ok(d.toString()); });
    });
    assert.match(http, /^HTTP\/1\.1 403/, http);
    assert.match(http, /https only/);
    await lease.release();
  });
});
