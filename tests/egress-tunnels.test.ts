// FOL-110 phase 3: the forward door's connections end with their lease. A
// CONNECT is checked when it opens; a tunnel a browser keeps open must not
// carry traffic after the step it was opened for has ended. And an
// intercepted host's TLS is served with the egress CA in the chain, so a
// browser that trusts the CA by its key (Chromium's SPKI list) matches it.
//
//   node --test tests/egress-tunnels.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";

process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE = "1";
process.env.FOLDRUN_SECRET_KEY ??= "egress-tunnels-test-key";
process.env.FOLDRUN_EGRESS_TUNNEL_SWEEP_MS = "50";

const { egressHooks, startEgressProxy, stopEgressProxy } = await import("../src/egress-proxy.ts");
const { closeEndedTunnels, trackTunnel, tunnelsOpen } = await import("../src/egress-tunnels.ts");
const { egressCaPem, leafFor } = await import("../src/egress-ca.ts");
import type { EgressGrant } from "../../foldrun-core/src/egress.ts";

const basic = (token: string) => `Basic ${Buffer.from(`foldrun:${token}`).toString("base64")}`;
const tokenOf = (proxyUrl: string) => decodeURIComponent(new URL(proxyUrl).password);

function connect(port: number, target: string, token: string): Promise<{ status: number; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "CONNECT", path: target, headers: { "proxy-authorization": basic(token) } });
    req.on("connect", (res, socket) => resolve({ status: res.statusCode ?? 0, socket }));
    req.on("error", reject);
    req.end();
  });
}

const closed = (s: net.Socket, ms = 3000) =>
  new Promise<boolean>((resolve) => {
    if (s.destroyed) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    s.once("close", () => {
      clearTimeout(t);
      resolve(true);
    });
  });

test("the sweep closes what a gone lease opened, keeps a live one's, and closes nothing when the store cannot say", async () => {
  const server = net.createServer(() => undefined);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  const dial = () => new Promise<net.Socket>((r) => { const s = net.connect(port, "127.0.0.1", () => r(s)); });
  try {
    const [gone, live, unsure] = [await dial(), await dial(), await dial()];
    trackTunnel("tok-gone", gone);
    trackTunnel("tok-live", live);
    trackTunnel("tok-unsure", unsure);
    assert.equal(tunnelsOpen("tok-gone"), 1);
    const n = await closeEndedTunnels(async (t) => {
      if (t === "tok-unsure") throw new Error("store down");
      return t === "tok-live";
    });
    assert.equal(n, 1);
    assert.ok(await closed(gone, 500), "the gone lease's tunnel is closed");
    assert.equal(live.destroyed, false);
    assert.equal(unsure.destroyed, false, "an outage of the store is not the end of a lease");
    const both = Promise.all([new Promise((r) => live.once("close", r)), new Promise((r) => unsure.once("close", r))]);
    live.destroy();
    unsure.destroy();
    await both;
    assert.equal(tunnelsOpen("tok-live"), 0, "a socket that closes on its own leaves the books");
  } finally {
    server.close();
  }
});

test("a tunnel through the door closes soon after its lease is released", async () => {
  const echo = net.createServer((s) => s.pipe(s));
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  const echoPort = (echo.address() as net.AddressInfo).port;
  const proxy = await startEgressProxy(0);
  process.env.FOLDRUN_EGRESS_URL = `http://127.0.0.1:${proxy.port}`;
  try {
    const grant: EgressGrant = { secrets: {}, network: { level: "trusted", hosts: ["localhost"] } };
    const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-tunnel-end", grant }))!;
    const open = await connect(proxy.port, `localhost:${echoPort}`, tokenOf(lease.proxy!));
    assert.equal(open.status, 200);
    const echoed = await new Promise<string>((resolve) => {
      open.socket.once("data", (d) => resolve(String(d)));
      open.socket.write("ping");
    });
    assert.equal(echoed, "ping");
    assert.equal(await closed(open.socket, 300), false, "open while the lease lives");
    await lease.release();
    assert.equal(await closed(open.socket), true, "closed by the sweep once the lease is gone");
  } finally {
    await stopEgressProxy();
    delete process.env.FOLDRUN_EGRESS_URL;
    echo.close();
  }
});

test("an intercepted host is served the leaf AND the egress CA, so a browser that trusts the CA's key matches it", async () => {
  const own = leafFor("localhost");
  const upstream = (await import("node:https")).createServer({ cert: own.cert, key: own.key }, (_req, res) => res.end("ok"));
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = (upstream.address() as net.AddressInfo).port;
  const proxy = await startEgressProxy(0);
  process.env.FOLDRUN_EGRESS_URL = `http://127.0.0.1:${proxy.port}`;
  try {
    const grant: EgressGrant = { secrets: { K: { value: "v", hosts: ["localhost"] } }, network: { level: "none", hosts: [] } };
    const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-chain", grant }))!;
    const tunnel = await connect(proxy.port, `localhost:${upPort}`, tokenOf(lease.proxy!));
    assert.equal(tunnel.status, 200);
    // No CA given: what a browser sees before it decides whether to trust.
    const secure = tls.connect({ socket: tunnel.socket, servername: "localhost", rejectUnauthorized: false });
    await new Promise<void>((resolve, reject) => {
      secure.once("secureConnect", () => resolve());
      secure.once("error", reject);
    });
    const leaf = secure.getPeerCertificate(true);
    const ca = new crypto.X509Certificate(egressCaPem());
    assert.equal(leaf.issuerCertificate?.fingerprint256, ca.fingerprint256, "the CA is in the chain the proxy sent");
    secure.destroy();
    // …and a client that trusts the CA still verifies the leaf, as before.
    const again = await connect(proxy.port, `localhost:${upPort}`, tokenOf(lease.proxy!));
    const strict = tls.connect({ socket: again.socket, servername: "localhost", ca: lease.ca, rejectUnauthorized: true });
    await new Promise<void>((resolve, reject) => {
      strict.once("secureConnect", () => resolve());
      strict.once("error", reject);
    });
    assert.equal(strict.authorized, true);
    strict.destroy();
    await lease.release();
  } finally {
    await stopEgressProxy();
    delete process.env.FOLDRUN_EGRESS_URL;
    upstream.close();
  }
});
