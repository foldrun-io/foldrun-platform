// The egress proxy's forward door: what HTTPS_PROXY in a sandbox points at.
// A site off the step's `network:` list is refused (or, report only, named);
// a site no secret is bound to is a tunnel the proxy never reads; a site a
// secret is bound to is intercepted with the egress CA and its `${NAME}`
// filled — the sandbox holding the name, never the value.
//
//   node --test tests/egress-forward.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";
import { connectTarget, egressHooks, fillBasicAuth, placeholdersInUrl, proxyToken, startEgressProxy, stopEgressProxy } from "../src/egress-proxy.ts";
import { egressCa, egressCaPem, leafFor } from "../src/egress-ca.ts";
import type { EgressGrant } from "../../foldrun-core/src/egress.ts";

// The fake upstreams listen on loopback, which the proxy refuses by default
// (ssrf.ts covers that); and the intercepted upstream's certificate is one
// this test made, which the worker would rightly not trust.
process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE = "1";
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
process.env.FOLDRUN_SECRET_KEY ??= "egress-forward-test-key";

const basic = (token: string) => `Basic ${Buffer.from(`foldrun:${token}`).toString("base64")}`;
const tokenOf = (proxyUrl: string) => decodeURIComponent(new URL(proxyUrl).password);

test("the lease rides as the proxy password; a CONNECT names host:port", () => {
  assert.equal(proxyToken(basic("abcdefghijklmnopqrstuvwx")), "abcdefghijklmnopqrstuvwx");
  assert.equal(proxyToken("Basic " + Buffer.from("foldrun:short").toString("base64")), null);
  assert.equal(proxyToken(undefined), null);
  assert.deepEqual(connectTarget("API.example.com:443"), { host: "api.example.com", port: 443 });
  assert.deepEqual(connectTarget("[::1]:8443"), { host: "::1", port: 8443 });
  assert.equal(connectTarget("example.com"), null);
  assert.equal(connectTarget("example.com:99999"), null);
});

test("Basic auth is decoded, filled for the host, and encoded again", () => {
  const grant: EgressGrant = { secrets: { DFS: { value: "s3cret", hosts: ["*.dataforseo.com"] } } };
  const sent = `Basic ${Buffer.from("me@x.com:${DFS}").toString("base64")}`;
  const ok = fillBasicAuth(sent, "api.dataforseo.com", { DFS: "s3cret" }, grant);
  assert.equal(Buffer.from(ok.text.slice(6), "base64").toString(), "me@x.com:s3cret");
  assert.deepEqual(ok.used, ["DFS"]);
  // Another host gets it untouched.
  assert.equal(fillBasicAuth(sent, "evil.example", { DFS: "s3cret" }, grant).text, sent);
});

test("a URL placeholder is found however a client spelled it, and only for this host's secrets", () => {
  const grant: EgressGrant = { secrets: { KEY: { value: "v", hosts: ["api.x.com"] } } };
  assert.equal(placeholdersInUrl("https://api.x.com/a?k=$%7BKEY%7D&b=1", "api.x.com", grant), "https://api.x.com/a?k=${KEY}&b=1", "requests");
  assert.equal(placeholdersInUrl("https://api.x.com/a?k=%24%7BKEY%7D", "api.x.com", grant), "https://api.x.com/a?k=${KEY}");
  assert.equal(placeholdersInUrl("https://api.x.com/a?k=$KEY&z=$PATH", "api.x.com", grant), "https://api.x.com/a?k=${KEY}&z=$PATH", "curl's globbing; another word stays");
  assert.equal(placeholdersInUrl("https://evil.example/?k=$KEY", "evil.example", grant), "https://evil.example/?k=$KEY", "not this host's secret");
  assert.equal(placeholdersInUrl("https://api.x.com/a?k=${KEY}", "api.x.com", grant), "https://api.x.com/a?k=${KEY}");
});

test("the egress CA is the same on every process and signs a leaf a strict client accepts", () => {
  const a = egressCa().pem;
  const ca = new crypto.X509Certificate(a);
  assert.ok(ca.ca);
  assert.equal(egressCaPem(), a);
  const leaf = new crypto.X509Certificate(leafFor("api.example.com").cert);
  assert.ok(leaf.checkIssued(ca) && leaf.verify(ca.publicKey));
  assert.equal(leaf.subjectAltName, "DNS:api.example.com");
});

/** CONNECT through the proxy; resolves the raw socket and the status line. */
function connect(port: number, target: string, token: string): Promise<{ status: number; socket: net.Socket; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "CONNECT", path: target, headers: { "proxy-authorization": basic(token) } });
    req.on("connect", (res, socket, head) => {
      if (res.statusCode === 200) return resolve({ status: 200, socket, body: "" });
      // A refusal's body arrives with the head, or after it.
      let body = head.toString();
      socket.on("data", (d) => (body += d));
      socket.on("end", () => resolve({ status: res.statusCode ?? 0, socket, body }));
    });
    req.on("response", (res) => {
      // Node hands a refused CONNECT to "response" in some versions.
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, socket: res.socket as net.Socket, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function withProxy(body: (port: number) => Promise<void>) {
  const proxy = await startEgressProxy(0);
  process.env.FOLDRUN_EGRESS_URL = `http://127.0.0.1:${proxy.port}`;
  try {
    await body(proxy.port);
  } finally {
    await stopEgressProxy();
    delete process.env.FOLDRUN_EGRESS_URL;
    delete process.env.FOLDRUN_NETWORK_ENFORCE;
  }
}

test("a listed site is a tunnel; an unlisted one is refused when enforced, named when only reported", async () => {
  const echo = net.createServer((s) => s.pipe(s));
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  const echoPort = (echo.address() as net.AddressInfo).port;
  try {
    await withProxy(async (port) => {
      process.env.FOLDRUN_NETWORK_ENFORCE = "1";
      const grant: EgressGrant = { secrets: {}, network: { level: "trusted", hosts: ["localhost"] } };
      const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-net", grant }))!;
      assert.ok(lease.proxy?.startsWith("http://foldrun:"), "the lease names the forward door");
      assert.equal(lease.enforce, true);
      assert.match(lease.ca!, /BEGIN CERTIFICATE/);
      const token = tokenOf(lease.proxy!);

      const open = await connect(port, `localhost:${echoPort}`, token);
      assert.equal(open.status, 200);
      const echoed = await new Promise<string>((resolve) => {
        open.socket.once("data", (d) => resolve(String(d)));
        open.socket.write("ping");
      });
      assert.equal(echoed, "ping", "bytes both ways, unread");
      open.socket.destroy();

      const refused = await connect(port, `127.0.0.1:${echoPort}`, token);
      assert.equal(refused.status, 403);
      assert.match(refused.body, /127\.0\.0\.1 is not a site this step may reach \(network: trusted\)/);

      const noLease = await connect(port, `localhost:${echoPort}`, "nosuchleasenosuchlease");
      assert.equal(noLease.status, 407);

      await new Promise((r) => setTimeout(r, 50));
      const log = (await lease.drainLog()).map((l) => (typeof l === "string" ? l : l.text));
      assert.ok(log.some((l) => /^egress: CONNECT localhost:\d+/.test(l)), log.join("\n"));
      assert.ok(log.some((l) => /127\.0\.0\.1 is not a site .* Refused\./.test(l)), log.join("\n"));
      await lease.release();

      // Report only: the same site goes through, and the trace says so once.
      delete process.env.FOLDRUN_NETWORK_ENFORCE;
      const learning = (await egressHooks.lease({ tenant: "acme", runId: "run-net2", grant: { secrets: {}, network: { level: "trusted", hosts: [] } } }))!;
      assert.equal(learning.enforce, false);
      for (let i = 0; i < 2; i++) {
        const r = await connect(port, `127.0.0.1:${echoPort}`, tokenOf(learning.proxy!));
        assert.equal(r.status, 200);
        r.socket.destroy();
      }
      const lines = (await learning.drainLog()).map((l) => (typeof l === "string" ? l : l.text)).filter((l) => l.includes("would be refused"));
      assert.equal(lines.length, 1, "once per site");
      await learning.release();
    });
  } finally {
    echo.close();
  }
});

test("network_enforce: an account's or workspace's true refuses on an install that only reports; false loosens nothing", async () => {
  const echo = net.createServer((s) => s.pipe(s));
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  const echoPort = (echo.address() as net.AddressInfo).port;
  try {
    await withProxy(async (port) => {
      delete process.env.FOLDRUN_NETWORK_ENFORCE;
      // The runner put the account's wish on the grant.
      const asked = (await egressHooks.lease({ tenant: "acme", runId: "run-ne1", grant: { secrets: {}, network: { level: "trusted", hosts: [] }, enforce: true } }))!;
      assert.equal(asked.enforce, true);
      const refused = await connect(port, `127.0.0.1:${echoPort}`, tokenOf(asked.proxy!));
      assert.equal(refused.status, 403);
      await asked.release();

      // The install enforces: a grant saying false does not loosen it.
      process.env.FOLDRUN_NETWORK_ENFORCE = "1";
      const loose = (await egressHooks.lease({ tenant: "acme", runId: "run-ne2", grant: { secrets: {}, network: { level: "trusted", hosts: [] }, enforce: false } }))!;
      assert.equal(loose.enforce, true);
      const still = await connect(port, `127.0.0.1:${echoPort}`, tokenOf(loose.proxy!));
      assert.equal(still.status, 403);
      await loose.release();
    });
  } finally {
    echo.close();
  }
});

test("a bound site is intercepted: the secret is filled on the way out and never in the pod", async () => {
  // The upstream: HTTPS on localhost, recording what reached it.
  const seen: http.IncomingHttpHeaders[] = [];
  const own = leafFor("localhost");
  const upstream = (await import("node:https")).createServer({ cert: own.cert, key: own.key }, (req, res) => {
    seen.push(req.headers);
    res.writeHead(200, { "content-type": "text/plain" }).end(`path=${req.url}`);
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = (upstream.address() as net.AddressInfo).port;
  try {
    await withProxy(async (port) => {
      process.env.FOLDRUN_NETWORK_ENFORCE = "1";
      const grant: EgressGrant = {
        secrets: { DFS_KEY: { value: "live-value-123", hosts: ["localhost"] } },
        network: { level: "none", hosts: [] },
      };
      const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-bound", grant }))!;
      const tunnel = await connect(port, `localhost:${upPort}`, tokenOf(lease.proxy!));
      assert.equal(tunnel.status, 200, "a bound site is reachable even at network: none");
      // What curl in the sandbox does: TLS to the site, trusting the egress CA.
      const secure = tls.connect({ socket: tunnel.socket, servername: "localhost", ca: lease.ca, rejectUnauthorized: true });
      await new Promise<void>((resolve, reject) => {
        secure.once("secureConnect", () => resolve());
        secure.once("error", reject);
      });
      assert.equal(secure.authorized, true, "the sandbox's TLS client accepts the egress CA's leaf");
      const reply = await new Promise<string>((resolve) => {
        let out = "";
        secure.on("data", (d) => (out += d));
        secure.on("end", () => resolve(out));
        secure.write("GET /v3/x?key=${DFS_KEY} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${DFS_KEY}\r\nConnection: close\r\n\r\n");
      });
      assert.match(reply, /^HTTP\/1\.1 200/);
      assert.match(reply, /path=\/v3\/x\?key=live-value-123/, "filled in the URL");
      assert.equal(seen[0]?.authorization, "Bearer live-value-123", "filled in the header");
      secure.destroy();
      const log = (await lease.drainLog()).map((l) => (typeof l === "string" ? l : l.text));
      assert.ok(log.some((l) => /GET localhost\/v3\/x → 200 .*\[DFS_KEY\]/.test(l)), log.join("\n"));
      await lease.release();
    });
  } finally {
    upstream.close();
  }
});

test("plain http:// through HTTP_PROXY is held to the same list and filled the same way", async () => {
  const seen: string[] = [];
  const upstream = http.createServer((req, res) => {
    seen.push(String(req.headers["x-key"]));
    res.end("ok");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = (upstream.address() as net.AddressInfo).port;
  try {
    await withProxy(async (port) => {
      process.env.FOLDRUN_NETWORK_ENFORCE = "1";
      const lease = (await egressHooks.lease({
        tenant: "acme",
        runId: "run-http",
        grant: { secrets: { K: { value: "vvvvvvvv", hosts: ["localhost"] } }, network: { level: "trusted", hosts: [] } },
      }))!;
      const ask = (host: string) =>
        new Promise<{ status: number; body: string }>((resolve, reject) => {
          const req = http.request({
            host: "127.0.0.1",
            port,
            method: "GET",
            path: `http://${host}:${upPort}/`,
            headers: { "proxy-authorization": basic(tokenOf(lease.proxy!)), "x-key": "${K}" },
          }, (res) => {
            let body = "";
            res.on("data", (d) => (body += d));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          });
          req.on("error", reject);
          req.end();
        });
      const ok = await ask("localhost");
      assert.equal(ok.status, 200);
      assert.equal(seen[0], "vvvvvvvv");
      const refused = await ask("127.0.0.1");
      assert.equal(refused.status, 403);
      await lease.release();
    });
  } finally {
    upstream.close();
  }
});

test("with the door turned off, a lease names no forward proxy and pods go direct", async () => {
  process.env.FOLDRUN_EGRESS_FORWARD = "0";
  try {
    await withProxy(async () => {
      const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-off", grant: { secrets: {} } }))!;
      assert.equal(lease.proxy, undefined);
      assert.equal(lease.ca, undefined);
      await lease.release();
    });
  } finally {
    delete process.env.FOLDRUN_EGRESS_FORWARD;
  }
});

// A download to a sandbox that reads slower than the far end sends: the
// proxy reads upstream only as fast as the sandbox takes it, so the file
// streams through and is never held on the worker. It used to write every
// chunk without waiting, and a slow reader made the proxy buffer the whole
// download in memory.
const MiB = 1024 * 1024;

/** An upstream that sends `total` bytes as fast as it is let, counting what
 *  it has handed over; `closed` resolves when its side ends either way. */
async function bigUpstream(total: number) {
  const state = { sent: 0, closed: Promise.withResolvers<void>() };
  const chunk = Buffer.alloc(64 * 1024, 7);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.on("close", () => state.closed.resolve());
    const pump = () => {
      while (state.sent < total) {
        state.sent += chunk.length;
        if (!res.write(chunk)) return void res.once("drain", pump);
      }
      res.end();
    };
    pump();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { state, server, port: (server.address() as net.AddressInfo).port };
}

/** GET through the proxy; the answer comes back paused, for the test to read. */
function getVia(proxyPort: number, token: string, target: string) {
  return new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: proxyPort, method: "GET", path: target, headers: { "proxy-authorization": basic(token) } }, (res) => {
      res.pause();
      resolve(res);
    });
    req.on("error", reject);
    req.end();
  });
}

const openLease = (runId: string) =>
  egressHooks.lease({ tenant: "acme", runId, grant: { secrets: {}, network: { level: "open", hosts: [] } } });

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a slow reader holds the download back at upstream, not in the proxy, and still gets all of it", async () => {
  const total = 64 * MiB;
  const up = await bigUpstream(total);
  try {
    await withProxy(async (port) => {
      const lease = (await openLease("run-slow"))!;
      const res = await getVia(port, tokenOf(lease.proxy!), `http://localhost:${up.port}/big`);
      assert.equal(res.statusCode, 200);
      await settle(1500);
      // Socket buffers and a stream's high-water mark hold a few MiB; the
      // proxy holding the rest would show as the whole 64 MiB sent.
      assert.ok(up.state.sent < 24 * MiB, `upstream sent ${Math.round(up.state.sent / MiB)} MiB to a reader that took none`);
      let got = 0;
      res.on("data", (d: Buffer) => (got += d.length));
      res.resume();
      await new Promise((r) => res.on("end", r));
      assert.equal(got, total, "every byte arrives once the reader reads");
      await lease.release();
    });
  } finally {
    up.server.close();
  }
});

test("waiting on a slow reader is not upstream going quiet; a reader that never reads is hung up on", async () => {
  const up = await bigUpstream(64 * MiB);
  try {
    await withProxy(async (port) => {
      process.env.FOLDRUN_EGRESS_UPSTREAM_IDLE_MS = "300";
      const lease = (await openLease("run-stall"))!;
      const slow = await getVia(port, tokenOf(lease.proxy!), `http://localhost:${up.port}/big`);
      await settle(1200); // four idle windows with the proxy waiting on us
      let got = 0;
      slow.on("data", (d: Buffer) => (got += d.length));
      slow.resume();
      await new Promise((r) => slow.on("end", r));
      assert.equal(got, 64 * MiB, "the idle clock did not cut a download the reader was only slow to take");

      process.env.FOLDRUN_EGRESS_CLIENT_STALL_MS = "300";
      const before = up.state.closed;
      up.state.closed = Promise.withResolvers<void>();
      await before.promise;
      up.state.sent = 0;
      const stuck = await getVia(port, tokenOf(lease.proxy!), `http://localhost:${up.port}/big`);
      const ended = new Promise<string>((r) => {
        stuck.on("aborted", () => r("aborted"));
        stuck.on("error", () => r("error"));
        stuck.on("close", () => r("close"));
      });
      await Promise.race([up.state.closed.promise, settle(5000).then(() => assert.fail("upstream was never released"))]);
      assert.ok(up.state.sent < 64 * MiB, "the stalled transfer stopped, not finished");
      stuck.destroy();
      await ended;
      await lease.release();
    });
  } finally {
    delete process.env.FOLDRUN_EGRESS_UPSTREAM_IDLE_MS;
    delete process.env.FOLDRUN_EGRESS_CLIENT_STALL_MS;
    up.server.close();
  }
});
