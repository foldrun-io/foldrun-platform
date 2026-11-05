// A WebSocket to a site a secret is bound to (FOL-128). The forward door
// intercepts such a site's TLS to fill `${NAME}`; until FOL-128 an upgrade
// inside that connection went out as a plain GET with its Upgrade header
// stripped, so every `wss://` to a bound host failed. Now the handshake is
// filled like any request, the site's 101 comes back, and the frames are
// piped both ways.
//
//   node --test tests/egress-websocket.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";
import { egressHooks, isWebSocketUpgrade, startEgressProxy, stopEgressProxy } from "../src/egress-proxy.ts";
import { leafFor } from "../src/egress-ca.ts";
import { PrivateAddressError, upgradePublic } from "../src/ssrf.ts";
import type { EgressGrant } from "../../foldrun-core/src/egress.ts";

// Loopback upstreams with a certificate this test made (as egress-forward).
process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE = "1";
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
process.env.FOLDRUN_SECRET_KEY ??= "egress-websocket-test-key";

const basic = (token: string) => `Basic ${Buffer.from(`foldrun:${token}`).toString("base64")}`;
const tokenOf = (proxyUrl: string) => decodeURIComponent(new URL(proxyUrl).password);
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const acceptOf = (key: string) => crypto.createHash("sha1").update(key + GUID).digest("base64");

/** One unfragmented text frame; a client's is masked (RFC 6455 §5.3). */
function frame(text: string, masked: boolean): Buffer {
  const payload = Buffer.from(text);
  assert.ok(payload.length < 126);
  const head = Buffer.from([0x81, (masked ? 0x80 : 0) | payload.length]);
  if (!masked) return Buffer.concat([head, payload]);
  const mask = crypto.randomBytes(4);
  return Buffer.concat([head, mask, Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!))]);
}
/** The text of one short frame, masked or not. */
function unframe(buf: Buffer): string {
  const len = buf[1]! & 0x7f;
  if (buf[1]! & 0x80) {
    const mask = buf.subarray(2, 6);
    return Buffer.from(buf.subarray(6, 6 + len).map((b, i) => b ^ mask[i % 4]!)).toString();
  }
  return buf.subarray(2, 2 + len).toString();
}

/** A wss:// server on loopback: records each handshake, answers 101 and
 *  echoes one frame back with a prefix — or refuses when told to. */
async function wsUpstream(opts: { refuse?: number } = {}) {
  const seen: { url: string; headers: http.IncomingHttpHeaders }[] = [];
  const own = leafFor("localhost");
  const server = https.createServer({ cert: own.cert, key: own.key }, (_req, res) => res.writeHead(426).end("upgrade required"));
  server.on("upgrade", (req, socket: net.Socket) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    if (opts.refuse) {
      socket.end(`HTTP/1.1 ${opts.refuse} Unauthorized\r\ncontent-type: text/plain\r\ncontent-length: 7\r\n\r\nno, sir`);
      return;
    }
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptOf(String(req.headers["sec-websocket-key"]))}\r\n\r\n`,
    );
    socket.once("data", (d) => socket.write(frame(`echo:${unframe(d)}`, false)));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { seen, port: (server.address() as net.AddressInfo).port, close: () => server.close() };
}

/** CONNECT through the proxy, then TLS to the site trusting the egress CA:
 *  what a sandbox's WebSocket client does behind HTTPS_PROXY. */
async function intercepted(proxyPort: number, target: string, token: string, ca: string): Promise<tls.TLSSocket> {
  const raw = await new Promise<net.Socket>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: proxyPort, method: "CONNECT", path: target, headers: { "proxy-authorization": basic(token) } });
    req.on("connect", (res, socket, head) => (res.statusCode === 200 ? resolve(socket) : reject(new Error(`CONNECT ${res.statusCode} ${head}`))));
    req.on("error", reject);
    req.end();
  });
  const secure = tls.connect({ socket: raw, servername: "localhost", ca, rejectUnauthorized: true });
  await new Promise<void>((resolve, reject) => {
    secure.once("secureConnect", () => resolve());
    secure.once("error", reject);
  });
  return secure;
}

/** Send a handshake; resolve the head of the answer and whatever followed it. */
function handshake(secure: tls.TLSSocket, lines: string[]): Promise<{ head: string; rest: Buffer; ended: Promise<string> }> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let all = "";
    let done: (s: string) => void;
    const ended = new Promise<string>((r) => (done = r));
    secure.on("end", () => done(all));
    secure.on("close", () => done(all));
    const onData = (d: Buffer) => {
      all += d.toString();
      buf = Buffer.concat([buf, d]);
      const at = buf.indexOf("\r\n\r\n");
      if (at < 0) return;
      secure.off("data", onData);
      secure.on("data", (more: Buffer) => (all += more.toString()));
      resolve({ head: buf.subarray(0, at).toString(), rest: buf.subarray(at + 4), ended });
    };
    secure.on("data", onData);
    secure.write(`${lines.join("\r\n")}\r\n\r\n`);
  });
}

const wsLines = (path: string, extra: string[] = []) => {
  const key = crypto.randomBytes(16).toString("base64");
  return {
    key,
    lines: [`GET ${path} HTTP/1.1`, "Host: localhost", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Key: ${key}`, "Sec-WebSocket-Version: 13", ...extra],
  };
};

async function withProxy(body: (port: number) => Promise<void>) {
  const proxy = await startEgressProxy(0);
  process.env.FOLDRUN_EGRESS_URL = `http://127.0.0.1:${proxy.port}`;
  process.env.FOLDRUN_NETWORK_ENFORCE = "1";
  try {
    await body(proxy.port);
  } finally {
    await stopEgressProxy();
    delete process.env.FOLDRUN_EGRESS_URL;
    delete process.env.FOLDRUN_NETWORK_ENFORCE;
  }
}

const logOf = async (lease: { drainLog(): Promise<unknown[]> }) =>
  (await lease.drainLog()).map((l) => (typeof l === "string" ? l : (l as { text: string }).text));

test("only a GET asking for websocket is a WebSocket handshake", () => {
  assert.equal(isWebSocketUpgrade({ method: "GET", headers: { upgrade: "websocket" } }), true);
  assert.equal(isWebSocketUpgrade({ method: "GET", headers: { upgrade: "WebSocket" } }), true);
  assert.equal(isWebSocketUpgrade({ method: "GET", headers: { upgrade: "h2c" } }), false);
  assert.equal(isWebSocketUpgrade({ method: "POST", headers: { upgrade: "websocket" } }), false);
  assert.equal(isWebSocketUpgrade({ method: "GET", headers: {} }), false);
});

test("a wss:// to a bound site: the handshake is filled, the 101 comes back, frames go both ways", async () => {
  const up = await wsUpstream();
  try {
    await withProxy(async (port) => {
      const grant: EgressGrant = { secrets: { WS_KEY: { value: "live-ws-secret", hosts: ["localhost"] } }, network: { level: "none", hosts: [] } };
      const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-ws", grant }))!;
      const secure = await intercepted(port, `localhost:${up.port}`, tokenOf(lease.proxy!), lease.ca!);
      const { key, lines } = wsLines("/stream?token=${WS_KEY}", ["Authorization: Bearer ${WS_KEY}", "Sec-WebSocket-Protocol: chat"]);
      const { head, rest } = await handshake(secure, lines);
      assert.match(head, /^HTTP\/1\.1 101 /);
      assert.match(head, new RegExp(`Sec-WebSocket-Accept: ${acceptOf(key).replace(/[+/=]/g, "\\$&")}`, "i"), "the site's accept, for the client's key");
      // What reached the site: the secret, in the header and the URL; the
      // handshake headers intact.
      assert.equal(up.seen[0]?.headers.authorization, "Bearer live-ws-secret");
      assert.equal(up.seen[0]?.url, "/stream?token=live-ws-secret");
      assert.equal(up.seen[0]?.headers.upgrade, "websocket");
      assert.equal(up.seen[0]?.headers["sec-websocket-key"], key);
      assert.equal(up.seen[0]?.headers["sec-websocket-protocol"], "chat");
      assert.doesNotMatch(head, /live-ws-secret/, "the value never comes back to the sandbox");
      // A frame out, the echo back: piped both ways.
      const reply = new Promise<Buffer>((resolve) => (rest.length ? resolve(rest) : secure.once("data", resolve)));
      secure.write(frame("hello", true));
      assert.equal(unframe(await reply), "echo:hello");
      secure.destroy();
      await new Promise((r) => setTimeout(r, 50));
      const log = await logOf(lease);
      assert.ok(log.some((l) => /GET localhost\/stream → 101 \(WebSocket\).*\[WS_KEY\]/.test(l)), log.join("\n"));
      await lease.release();
    });
  } finally {
    up.close();
  }
});

test("a site that refuses the handshake: its answer comes back as it is, and the connection ends", async () => {
  const up = await wsUpstream({ refuse: 401 });
  try {
    await withProxy(async (port) => {
      const grant: EgressGrant = { secrets: { WS_KEY: { value: "live-ws-secret", hosts: ["localhost"] } }, network: { level: "none", hosts: [] } };
      const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-ws-401", grant }))!;
      const secure = await intercepted(port, `localhost:${up.port}`, tokenOf(lease.proxy!), lease.ca!);
      const { head, ended } = await handshake(secure, wsLines("/s", ["Authorization: Bearer ${WS_KEY}"]).lines);
      assert.match(head, /^HTTP\/1\.1 401 /);
      assert.match(head, /connection: close/i);
      assert.match(await ended, /no, sir/);
      const log = await logOf(lease);
      assert.ok(log.some((l) => /GET localhost\/s → 401/.test(l)), log.join("\n"));
      await lease.release();
    });
  } finally {
    up.close();
  }
});

test("refused in words: another upgrade, the platform's model key, a test run to a writable site", async () => {
  const up = await wsUpstream();
  try {
    await withProxy(async (port) => {
      // A grant each: a released lease empties the one it was given.
      const grant = (): EgressGrant => ({ secrets: { WS_KEY: { value: "v", hosts: ["localhost"] } }, network: { level: "none", hosts: [] } });
      const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-ws-no", grant: grant() }))!;
      let secure = await intercepted(port, `localhost:${up.port}`, tokenOf(lease.proxy!), lease.ca!);
      let got = await handshake(secure, ["GET / HTTP/1.1", "Host: localhost", "Upgrade: h2c", "Connection: Upgrade, HTTP2-Settings", "HTTP2-Settings: AAMAAABkAAQAAP__"]);
      assert.match(got.head, /^HTTP\/1\.1 501 /);
      assert.match(await got.ended, /only a WebSocket upgrade is passed through to localhost/);
      await lease.release();

      // A test run: the frames are not read, so a write cannot be held back.
      const tested = (await egressHooks.lease({ tenant: "acme", runId: "run-ws-test", grant: grant(), test: true }))!;
      secure = await intercepted(port, `localhost:${up.port}`, tokenOf(tested.proxy!), tested.ca!);
      got = await handshake(secure, wsLines("/s").lines);
      assert.match(got.head, /^HTTP\/1\.1 403 /);
      assert.match(await got.ended, /refused in a test run/);
      const log = await logOf(tested);
      assert.ok(log.some((l) => /^test: WebSocket localhost\/s refused/.test(l)), log.join("\n"));
      await tested.release();

      // One of the platform's model keys: metered per request, so never over a WebSocket.
      const supply: EgressGrant = { secrets: { FOLDRUN_MODEL_KEY: { value: "", hosts: ["localhost"], supply: { provider: "anthropic" } } as EgressGrant["secrets"][string] }, network: { level: "none", hosts: [] } };
      const metered = (await egressHooks.lease({ tenant: "acme", runId: "run-ws-supply", grant: supply }))!;
      secure = await intercepted(port, `localhost:${up.port}`, tokenOf(metered.proxy!), metered.ca!);
      got = await handshake(secure, wsLines("/s", ["x-api-key: ${FOLDRUN_MODEL_KEY}"]).lines);
      assert.match(got.head, /^HTTP\/1\.1 403 /);
      assert.match(await got.ended, /model keys are not sent over a WebSocket/);
      await metered.release();
      assert.equal(up.seen.length, 0, "none of them reached the site");
    });
  } finally {
    up.close();
  }
});

test("the upgrade is never inward: an internal name or a private address is refused before it connects", () => {
  delete process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE;
  try {
    for (const url of ["https://127.0.0.1:8443/ws", "https://[::1]/ws", "https://169.254.169.254/latest/"]) {
      assert.throws(() => upgradePublic(url, { headers: {} }), PrivateAddressError, url);
    }
    for (const url of ["https://localhost/ws", "https://foldrun-egress.foldrun.svc.cluster.local/", "https://kubernetes/"]) {
      assert.throws(() => upgradePublic(url, { headers: {} }), /internal name/, url);
    }
    assert.throws(() => upgradePublic("http://example.com/", { headers: {} }), /over https only/);
  } finally {
    process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE = "1";
  }
});

test("a refusal whose body stalls: the client hanging up closes the site's connection too", async () => {
  const own = leafFor("localhost");
  let upstreamClosed: () => void;
  const closed = new Promise<void>((r) => (upstreamClosed = r));
  const server = https.createServer({ cert: own.cert, key: own.key });
  server.on("upgrade", (_req, socket: net.Socket) => {
    // The proxy closing its side: an end (http.Server sockets are
    // half-open) or a reset, whichever comes.
    socket.on("end", () => upstreamClosed());
    socket.on("close", () => upstreamClosed());
    socket.on("error", () => upstreamClosed());
    // Headers, part of a body, then nothing.
    socket.write("HTTP/1.1 401 Unauthorized\r\ncontent-type: text/plain\r\ncontent-length: 100\r\n\r\npartial");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const upPort = (server.address() as net.AddressInfo).port;
  try {
    await withProxy(async (port) => {
      const grant: EgressGrant = { secrets: { WS_KEY: { value: "v", hosts: ["localhost"] } }, network: { level: "none", hosts: [] } };
      const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-ws-stall", grant }))!;
      const secure = await intercepted(port, `localhost:${upPort}`, tokenOf(lease.proxy!), lease.ca!);
      const { head } = await handshake(secure, wsLines("/s").lines);
      assert.match(head, /^HTTP\/1\.1 401 /);
      secure.destroy();
      let t: NodeJS.Timeout | undefined;
      await Promise.race([closed, new Promise((_, reject) => (t = setTimeout(() => reject(new Error("the site's connection outlived the client")), 15_000)))]);
      clearTimeout(t);
      await lease.release();
    });
  } finally {
    server.close();
  }
});

test("a DPoP-bound token: the proxy proves the handshake, and answers the site's nonce challenge itself", async () => {
  const { generateDpopKey } = await import("../../foldrun-core/src/oauth-dpop.ts");
  const own = leafFor("localhost");
  const proofs: { nonce?: string; htm: string; htu: string; auth: string }[] = [];
  const server = https.createServer({ cert: own.cert, key: own.key }, (req, res) => {
    // The token endpoint the oauth2 recipe refreshes at.
    req.resume();
    req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "at-dpop-1", token_type: "DPoP", expires_in: 3600 })));
  });
  server.on("upgrade", (req, socket: net.Socket) => {
    const jwt = String(req.headers.dpop ?? "");
    const claims = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString() || "{}");
    proofs.push({ nonce: claims.nonce, htm: claims.htm, htu: claims.htu, auth: String(req.headers.authorization) });
    if (claims.nonce !== "n-1") {
      socket.end('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: DPoP error="use_dpop_nonce"\r\nDPoP-Nonce: n-1\r\ncontent-length: 0\r\n\r\n');
      return;
    }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptOf(String(req.headers["sec-websocket-key"]))}\r\n\r\n`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const upPort = (server.address() as net.AddressInfo).port;
  try {
    await withProxy(async (port) => {
      const recipe = "@oauth2 " + JSON.stringify({ token_url: `https://localhost:${upPort}/token`, client_id: "c", refresh_token: "r", dpop_key: generateDpopKey() });
      const grant: EgressGrant = { secrets: { BSKY: { value: recipe, hosts: ["localhost"] } }, network: { level: "none", hosts: [] } };
      const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-ws-dpop", grant }))!;
      const secure = await intercepted(port, `localhost:${upPort}`, tokenOf(lease.proxy!), lease.ca!);
      const { head } = await handshake(secure, wsLines("/sub?x=1", ["Authorization: Bearer ${BSKY}", "DPoP: forged-by-the-sandbox"]).lines);
      assert.match(head, /^HTTP\/1\.1 101 /, "the nonce challenge never reached the sandbox");
      assert.equal(proofs.length, 2, "asked once, then once more with the nonce");
      assert.equal(proofs[0]!.nonce, undefined);
      assert.equal(proofs[1]!.nonce, "n-1");
      for (const p of proofs) {
        assert.equal(p.htm, "GET");
        assert.equal(p.htu, `https://localhost:${upPort}/sub`, "the proof names the handshake's URI, query left out (RFC 9449)");
        assert.equal(p.auth, "DPoP at-dpop-1", "the token as a DPoP token, filled here");
      }
      secure.destroy();
      await lease.release();
    });
  } finally {
    server.close();
  }
});
