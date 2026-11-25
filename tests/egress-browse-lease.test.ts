// A lease with no run behind it, for one cloud browser call (FOL-313,
// foldrun-infra docs/web-browse-backend-plan.md): it opens on the forward
// door alone, before its expiry, and never on a proxy that may reach private
// addresses.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { egressHooks, holdToDeadline, leaseOpensAt, openLease, requestDeadline, startEgressProxy, stopEgressProxy } from "../src/egress-proxy.ts";
import type { EgressGrant } from "../../foldrun-core/src/egress.ts";

process.env.FOLDRUN_SECRET_KEY ??= "egress-browse-lease-test-key";
delete process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE;
// A browse lease opens only as a v2 lease (signed, its grant sealed to it).
process.env.FOLDRUN_EGRESS_LEASE_V2 = "1";

const DOORS = ["forward", "e", "live", "identity", "operator", "browse", "search", "text"] as const;
const tokenOf = (proxyUrl: string) => decodeURIComponent(new URL(proxyUrl).password);
const browseGrant = (expiresAt: number): EgressGrant => ({ secrets: {}, network: { level: "open", hosts: [] }, enforce: true, purpose: "browse-job", expiresAt });

function withPrivate<T>(on: boolean, fn: () => T): T {
  const was = process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE;
  if (on) process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE = "1";
  else delete process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE;
  try {
    return fn();
  } finally {
    if (was === undefined) delete process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE;
    else process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE = was;
  }
}

test("the rule: a browse-job lease opens on the forward door alone, before its expiry, as v2, with a narrow grant, never with private reach; an unknown purpose opens nothing", () => {
  const now = 1_000_000;
  const g: EgressGrant = { secrets: {}, purpose: "browse-job", expiresAt: now + 45_000 };
  const lease = { grant: g, v2: true };
  for (const d of DOORS) assert.equal(leaseOpensAt(lease, d, now), d === "forward", d);
  assert.equal(leaseOpensAt(lease, "forward", now + 45_000), false, "expired at its instant");
  assert.equal(leaseOpensAt({ grant: { ...g, expiresAt: undefined }, v2: true }, "forward", now), false, "a purpose without an expiry");
  assert.equal(leaseOpensAt({ grant: { ...g, expiresAt: Infinity }, v2: true }, "forward", now), false, "a non-finite expiry");
  assert.equal(leaseOpensAt({ grant: { ...g, purpose: "x" as never }, v2: true }, "forward", now), false, "an unknown purpose");
  assert.equal(leaseOpensAt({ grant: g }, "forward", now), false, "a v1 lease");
  assert.equal(leaseOpensAt({ grant: g, v2: true, test: true }, "forward", now), false, "a test lease");
  for (const wide of [{ secrets: { K: { value: "v", hosts: ["a.com"] } } }, { vendorDoor: { vendor: "x", server: "y" } }, { identities: { id: { audience: "a" } } }, { search: {} }]) {
    assert.equal(leaseOpensAt({ grant: { ...g, ...wide }, v2: true }, "forward", now), false, JSON.stringify(wide));
  }
  assert.equal(withPrivate(true, () => leaseOpensAt(lease, "forward", now)), false, "a proxy that may reach private space");
  // An ordinary lease is untouched, at every door, override or not.
  for (const d of DOORS) assert.equal(withPrivate(true, () => leaseOpensAt({ grant: { secrets: {} } }, d, now)), true);
});

test("a purpose lease's connections are cut at its expiry, whatever the store says; an ordinary lease's are not", async () => {
  const server = net.createServer((s) => s.on("error", () => {})).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as net.AddressInfo).port;
  const open = () => new Promise<net.Socket>((r) => { const c = net.connect(port, "127.0.0.1", () => r(c)); c.on("error", () => {}); });
  const [a, b] = [await open(), await open()];
  const closed = (s: net.Socket) => new Promise<number>((r) => s.once("close", () => r(Date.now())));
  const t0 = Date.now();
  const lease = (grant: EgressGrant) => ({ token: "t", key: "k", tenant: "acme", runId: "browse:x", grant, createdAt: t0, renewedAt: t0 }) as Parameters<typeof holdToDeadline>[0];
  holdToDeadline(lease({ secrets: {}, purpose: "browse-job", expiresAt: t0 + 150 }), a);
  holdToDeadline(lease({ secrets: {} }), b);
  const at = await closed(a);
  assert.ok(at - t0 >= 140 && at - t0 < 1000, `cut after ${at - t0} ms`);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(b.destroyed, false, "an ordinary lease keeps its connection");
  b.destroy();
  server.close();
});

async function withProxy(body: (port: number) => Promise<void>) {
  const proxy = await startEgressProxy(0);
  process.env.FOLDRUN_EGRESS_URL = `http://127.0.0.1:${proxy.port}`;
  try {
    await body(proxy.port);
  } finally {
    await stopEgressProxy();
    delete process.env.FOLDRUN_EGRESS_URL;
    delete process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE;
  }
}

test("openLease: the store's lease, as each door may use it", () => withProxy(async () => {
  const job = (await egressHooks.lease({ tenant: "acme", runId: "browse:job-1", grant: browseGrant(Date.now() + 60_000) }))!;
  const run = (await egressHooks.lease({ tenant: "acme", runId: "run-1", grant: { secrets: {} } }))!;
  try {
    const t = tokenOf(job.proxy!);
    assert.ok(await openLease(t, "forward"));
    for (const d of DOORS.filter((x) => x !== "forward")) assert.equal(await openLease(t, d), null, d);
    assert.equal(await openLease(t, "forward", Date.now() + 61_000), null, "past its end");
    assert.ok(await openLease(tokenOf(run.proxy!), "e"), "a run's lease opens as before");
  } finally {
    await job.release();
    await run.release();
  }
}));

/** One request to the proxy's forward door: a plain-HTTP absolute URL or a CONNECT. */
function viaProxy(port: number, token: string, kind: "http" | "connect", target: string): Promise<number> {
  const auth = `Basic ${Buffer.from(`foldrun:${token}`).toString("base64")}`;
  return new Promise((resolve, reject) => {
    if (kind === "http") {
      const req = http.request({ host: "127.0.0.1", port, method: "GET", path: target, headers: { "proxy-authorization": auth, host: new URL(target).host } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
      return;
    }
    const s = net.connect(port, "127.0.0.1", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${auth}\r\n\r\n`));
    let head = "";
    s.on("data", (c) => {
      head += c.toString("latin1");
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(head);
      if (m) {
        s.destroy();
        resolve(Number(m[1]));
      }
    });
    s.on("error", reject);
    s.on("close", () => resolve(0));
  });
}

test("the forward door: a browse-job lease cannot reach a private address, and does not open at all on a proxy allowed to", async () => {
  let hits = 0;
  const upstream = http.createServer((_q, r) => (hits++, r.end("inside"))).listen(0, "127.0.0.1");
  await new Promise((r) => upstream.once("listening", r));
  const up = (upstream.address() as net.AddressInfo).port;
  try {
    await withProxy(async (port) => {
      const job = (await egressHooks.lease({ tenant: "acme", runId: "browse:job-2", grant: browseGrant(Date.now() + 60_000) }))!;
      const t = tokenOf(job.proxy!);
      try {
        // Guarded (the cluster's setting): an internal target is refused, both
        // ways, by the address guard (403) — not by the lease (407) — and the
        // upstream never sees a request.
        for (const [kind, target] of [["http", `http://127.0.0.1:${up}/`], ["connect", `127.0.0.1:${up}`], ["http", "http://169.254.169.254/latest/meta-data/"], ["connect", "169.254.169.254:80"]] as const) {
          assert.equal(await viaProxy(port, t, kind, target), 403, `${kind} ${target}`);
        }
        assert.equal(hits, 0, "nothing reached the private upstream");
        // A proxy told it may reach private space does not open the lease.
        process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE = "1";
        // (407: the forward door's own "no such lease", as a proxy says it.)
        assert.equal(await viaProxy(port, t, "http", `http://127.0.0.1:${up}/`), 407);
        assert.equal(await viaProxy(port, t, "connect", `127.0.0.1:${up}`), 407);
        // The /e/ door never opens it, whatever the target.
        const e = await new Promise<number>((resolve) => {
          http.get({ host: "127.0.0.1", port, path: `/e/${t}/http://127.0.0.1:${up}/` }, (res) => (res.resume(), resolve(res.statusCode ?? 0))).on("error", () => resolve(0));
        });
        assert.equal(e, 401);
      } finally {
        await job.release();
      }
    });
  } finally {
    upstream.close();
  }
});

test("plain HTTP: a purpose lease's deadline belongs to its request, so a reused keep-alive connection's next request survives it", async () => {
  const t0 = Date.now();
  const lease = (grant: EgressGrant) => ({ token: "t", key: "k", tenant: "acme", runId: "browse:x", grant, createdAt: t0, renewedAt: t0 }) as Parameters<typeof requestDeadline>[0];
  const browse = lease({ secrets: {}, purpose: "browse-job", expiresAt: t0 + 150 });
  let n = 0;
  const server = http.createServer((_q, res) => {
    n++;
    if (n === 1) {
      // Request A: under the browse lease, answered at once.
      assert.equal(requestDeadline(browse, res), true);
      res.end("a");
    } else {
      // Request B, same connection: an ordinary lease, answered after A's expiry.
      assert.equal(requestDeadline(lease({ secrets: {} }), res), true);
      setTimeout(() => res.end("b"), 300);
    }
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as net.AddressInfo).port;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const get = () => new Promise<{ body: string; socket: unknown }>((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, agent }, (res) => {
      // Captured now: keep-alive detaches res.socket by the time it ends.
      const socket = res.socket;
      assert.ok(socket);
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ body: b, socket }));
    }).on("error", reject);
  });
  try {
    const a = await get();
    const b = await get();
    assert.equal(a.body, "a");
    assert.equal(b.body, "b", "B finished after A's expiry, on the same connection");
    assert.equal(a.socket, b.socket, "the connection was reused");
    // Past its expiry, a browse request is not sent at all.
    const late = lease({ secrets: {}, purpose: "browse-job", expiresAt: Date.now() - 1 });
    assert.equal(requestDeadline(late, { destroyed: false, writableEnded: false } as http.ServerResponse), false);
  } finally {
    agent.destroy();
    server.close();
  }
});

test("the forward door: a browse-job lease reaches ports 80 and 443 only, its blocked sites never, and only its allowed sites when it has a list (Codex)", async () => {
  await withProxy(async (port) => {
    const deny = (await egressHooks.lease({ tenant: "acme", runId: "browse:job-ports", grant: { ...browseGrant(Date.now() + 60_000), network: { level: "open", hosts: [], deny: ["*.ads.example"] } } }))!;
    const only = (await egressHooks.lease({ tenant: "acme", runId: "browse:job-only", grant: { ...browseGrant(Date.now() + 60_000), network: { level: "none", hosts: ["a.example"] } } }))!;
    try {
      const t = tokenOf(deny.proxy!);
      assert.equal(await viaProxy(port, t, "connect", "example.com:8443"), 403, "a port past 80/443");
      assert.equal(await viaProxy(port, t, "connect", "example.com:22"), 403);
      assert.equal(await viaProxy(port, t, "http", "http://example.com:8080/"), 403);
      assert.equal(await viaProxy(port, t, "connect", "cdn.ads.example:443"), 403, "a blocked site, sub-domains too");
      assert.equal(await viaProxy(port, t, "http", "http://ads.example/"), 403);
      const o = tokenOf(only.proxy!);
      assert.equal(await viaProxy(port, o, "connect", "b.example:443"), 403, "outside the allowed list");
    } finally {
      await deny.release();
      await only.release();
    }
  });
});
