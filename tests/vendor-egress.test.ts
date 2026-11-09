// FOL-145 phase B: the vendor egress door. A real door on localhost and a
// real CONNECT client; names resolve to a public-looking address the test
// routes to a local echo server (the door refuses 127.0.0.1 itself, as it
// must). Nothing here reaches the internet.
//
//   node --test tests/vendor-egress.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createVendorEgressServer, memoryVendorCounter, redisVendorCounter, refusalFor, type VendorCaps, type VendorCounter, type VendorDoorEvent, type VendorDoorTimeouts } from "../src/vendor-egress.ts";
import {
  memoryVendorCredentialStore,
  mintVendorCredential,
  revokeVendorCredentialsForLease,
  saveVendorCredential,
  type VendorCredentialStore,
} from "../src/vendor-egress-credentials.ts";

const PUBLIC = "93.184.215.14"; // stands in for a public site; routed to the echo server below
const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;

async function echoServer() {
  const s = net.createServer((c) => { c.on("error", () => {}); c.on("data", (d) => c.write(Buffer.concat([Buffer.from("echo:"), d]))); });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { s, port: (s.address() as net.AddressInfo).port };
}

async function door(store: VendorCredentialStore, opts: { caps?: VendorCaps; recheckMs?: number; resolve?: (h: string) => Promise<string[]> } = {}) {
  const echo = await echoServer();
  const events: VendorDoorEvent[] = [];
  const d = createVendorEgressServer({
    store,
    counter: memoryVendorCounter(),
    caps: opts.caps,
    recheckMs: opts.recheckMs ?? 100,
    resolve: opts.resolve ?? (async () => [PUBLIC]),
    connect: (address) => {
      assert.equal(address, PUBLIC, "the socket goes to the address that was checked");
      return net.connect({ host: "127.0.0.1", port: echo.port });
    },
    onEvent: (e) => events.push(e),
  });
  await new Promise<void>((r) => d.server.listen(0, "127.0.0.1", r));
  const port = (d.server.address() as net.AddressInfo).port;
  return { d, port, events, stop: async () => { await d.close(); echo.s.close(); } };
}

/** A CONNECT through the door: the status line, and the open socket when 200. */
function connectVia(port: number, target: string, auth?: string): Promise<{ status: number; text: string; sock: net.Socket }> {
  return new Promise((ok, no) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    let buf = "";
    sock.on("error", no);
    sock.on("connect", () => sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ""}\r\n`));
    const onData = (d: Buffer) => {
      buf += d.toString("latin1");
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      sock.off("data", onData);
      const status = Number(buf.match(/^HTTP\/1\.1 (\d{3})/)?.[1] ?? 0);
      ok({ status, text: buf, sock });
    };
    sock.on("data", onData);
  });
}

async function credential(store: VendorCredentialStore, over: Partial<{ hosts: string[]; level: "open" | "trusted" | "none"; boundHosts: string[]; leaseKey: string; ttlMs: number }> = {}) {
  const c = mintVendorCredential({
    tenant: "acme", runId: "run-1", vendor: "browserbase",
    leaseKey: over.leaseKey ?? `lease-${Math.random()}`,
    leaseExpiresAt: Date.now() + (over.ttlMs ?? 600_000),
    policy: { level: over.level ?? "none", hosts: over.hosts ?? ["example.com"] },
    boundHosts: over.boundHosts ?? [],
  });
  await saveVendorCredential(c, store);
  return c;
}

const readOnce = (s: net.Socket) => new Promise<string>((ok) => s.once("data", (d) => ok(d.toString())));
const closedWithin = (s: net.Socket, ms: number) => new Promise<boolean>((ok) => {
  if (s.destroyed) return ok(true);
  const t = setTimeout(() => ok(false), ms);
  s.once("close", () => { clearTimeout(t); ok(true); });
});

test("refusalFor: the list, bound sites, ports, private literals — pure", () => {
  const rec = { policy: { level: "none" as const, hosts: ["example.com", "*.docs.example.org"] }, boundHosts: ["api.example.com"] };
  assert.equal(refusalFor(rec, "example.com", 443), null);
  assert.equal(refusalFor(rec, "a.docs.example.org", 443), null);
  assert.match(refusalFor(rec, "evil.test", 443)!.reason, /not on this step's network: list/);
  assert.match(refusalFor(rec, "api.example.com", 443)!.reason, /unsupported capability: vendor secret filling/);
  assert.match(refusalFor({ ...rec, policy: { level: "open", hosts: [] } }, "api.example.com", 443)!.reason, /vendor secret filling/, "a bound site is refused even on an open list");
  assert.match(refusalFor(rec, "example.com", 22)!.reason, /port 22/);
  assert.match(refusalFor({ ...rec, policy: { level: "open", hosts: [] } }, "10.0.0.5", 443)!.reason, /private/);
  assert.match(refusalFor({ ...rec, policy: { level: "open", hosts: [] } }, "169.254.169.254", 80)!.reason, /private/, "the cloud metadata address");
});

test("no credential, a lease token, a wrong password: 407 with a Basic challenge", async () => {
  const store = memoryVendorCredentialStore();
  const t = await door(store);
  try {
    const c = await credential(store);
    for (const auth of [undefined, basic("foldrun", "x".repeat(43)), basic(c.username, "y".repeat(43))]) {
      const r = await connectVia(t.port, "example.com:443", auth);
      assert.equal(r.status, 407, r.text);
      assert.match(r.text, /proxy-authenticate: Basic realm="foldrun vendor egress"/i);
      r.sock.destroy();
    }
  } finally { await t.stop(); }
});

test("a site on the list: tunnelled to the checked address, bytes both ways", async () => {
  const store = memoryVendorCredentialStore();
  const t = await door(store);
  try {
    const c = await credential(store);
    const r = await connectVia(t.port, "example.com:443", basic(c.username, c.password));
    assert.equal(r.status, 200, r.text);
    r.sock.write("hello");
    assert.equal(await readOnce(r.sock), "echo:hello");
    assert.equal(t.d.active(), 1);
    r.sock.destroy();
    assert.ok(t.events.some((e) => e.kind === "connect" && e.host === "example.com" && e.vendor === "browserbase"));
  } finally { await t.stop(); }
});

test("refused: off the list, a bound site, another port, a private literal, a name that resolves inward", async () => {
  const store = memoryVendorCredentialStore();
  const inward = await door(store, { resolve: async () => ["10.1.2.3"] });
  const t = await door(store);
  try {
    const c = await credential(store, { hosts: ["example.com", "api.example.com", "internal.example.com"], boundHosts: ["api.example.com"] });
    const auth = basic(c.username, c.password);
    const cases: [number, string, RegExp][] = [
      [t.port, "evil.test:443", /not on this step's network: list/],
      [t.port, "api.example.com:443", /vendor secret filling/],
      [t.port, "example.com:22", /port 22/],
      [t.port, "10.0.0.1:443", /private/],
      [inward.port, "internal.example.com:443", /resolves to a private or internal address/],
    ];
    for (const [port, target, why] of cases) {
      const r = await connectVia(port, target, auth);
      assert.equal(r.status, 403, `${target}: ${r.text}`);
      assert.match(r.text, why);
      r.sock.destroy();
    }
    assert.equal(t.d.active(), 0);
    assert.ok(t.events.filter((e) => e.kind === "refused").length >= 4, "every refusal is an event");
    assert.ok(!JSON.stringify(t.events).includes(c.password), "no event carries the password");
  } finally { await t.stop(); await inward.stop(); }
});

test("caps: connections at once and opens a minute, per lease", async () => {
  const store = memoryVendorCredentialStore();
  const t = await door(store, { caps: { connections: 1, opensPerMinute: 2, bytes: 1_000_000 } });
  try {
    const c = await credential(store);
    const auth = basic(c.username, c.password);
    const a = await connectVia(t.port, "example.com:443", auth);
    assert.equal(a.status, 200);
    const b = await connectVia(t.port, "example.com:443", auth);
    assert.equal(b.status, 429, b.text);
    assert.match(b.text, /at once/);
    // A refusal is not an open: one open so far. A second, then a third.
    a.sock.destroy();
    await closedWithin(a.sock, 500);
    await new Promise((r) => setTimeout(r, 50));
    const second = await connectVia(t.port, "example.com:443", auth);
    assert.equal(second.status, 200, `the second open in a minute: ${second.text}`);
    second.sock.destroy();
    await closedWithin(second.sock, 500);
    await new Promise((r) => setTimeout(r, 50));
    const third = await connectVia(t.port, "example.com:443", auth);
    assert.equal(third.status, 429, "the third open in a minute");
    assert.match(third.text, /a minute/);
    for (const x of [b, third]) x.sock.destroy();
  } finally { await t.stop(); }
});

test("bytes: a lease past its bytes is cut off", async () => {
  const store = memoryVendorCredentialStore();
  const t = await door(store, { caps: { connections: 8, opensPerMinute: 60, bytes: 64 } });
  try {
    const c = await credential(store);
    const r = await connectVia(t.port, "example.com:443", basic(c.username, c.password));
    assert.equal(r.status, 200);
    r.sock.write("x".repeat(100));
    assert.ok(await closedWithin(r.sock, 2_000), "closed once over the cap");
  } finally { await t.stop(); }
});

test("the lease ends: its open tunnel closes within a recheck, and no new one opens", async () => {
  const store = memoryVendorCredentialStore();
  const t = await door(store, { recheckMs: 100 });
  try {
    const c = await credential(store);
    const auth = basic(c.username, c.password);
    const r = await connectVia(t.port, "example.com:443", auth);
    assert.equal(r.status, 200);
    await revokeVendorCredentialsForLease(c.record.leaseKey, store);
    assert.ok(await closedWithin(r.sock, 1_000), "closed after revocation");
    const again = await connectVia(t.port, "example.com:443", auth);
    assert.equal(again.status, 407);
    again.sock.destroy();
  } finally { await t.stop(); }
});

test("a store that cannot answer: open tunnels close, new ones are refused (503)", async () => {
  const mem = memoryVendorCredentialStore();
  let down = false;
  const store: VendorCredentialStore = {
    ...mem,
    get: async (id) => { if (down) throw new Error("down"); return mem.get(id); },
    leaseRevoked: async (k) => { if (down) throw new Error("down"); return mem.leaseRevoked(k); },
  };
  const t = await door(store, { recheckMs: 100 });
  try {
    const c = await credential(mem);
    const auth = basic(c.username, c.password);
    const r = await connectVia(t.port, "example.com:443", auth);
    assert.equal(r.status, 200);
    down = true;
    assert.ok(await closedWithin(r.sock, 1_000), "closed when the store went away");
    const again = await connectVia(t.port, "example.com:443", auth);
    assert.equal(again.status, 503, again.text);
    again.sock.destroy();
  } finally { await t.stop(); }
});

test("plain HTTP through the door is refused: CONNECT only", async () => {
  const store = memoryVendorCredentialStore();
  const t = await door(store);
  try {
    const res = await fetch(`http://127.0.0.1:${t.port}/`, { method: "GET" });
    assert.equal(res.status, 405);
    assert.match(await res.text(), /CONNECT only/);
  } finally { await t.stop(); }
});

// ------------------------------------------------ the Codex review's cases

/** A door whose upstream counts what it receives, with every knob open. */
async function door2(store: VendorCredentialStore, o: { caps?: VendorCaps; counter?: VendorCounter; timeouts?: Partial<VendorDoorTimeouts>; recheckMs?: number; resolve?: (h: string) => Promise<string[]>; expectAddress?: string } = {}) {
  let received = 0;
  const up = net.createServer((c) => { c.on("error", () => {}); c.on("data", (d) => { received += d.length; }); });
  await new Promise<void>((r) => up.listen(0, "127.0.0.1", r));
  const upPort = (up.address() as net.AddressInfo).port;
  const seen: string[] = [];
  const d = createVendorEgressServer({
    store,
    counter: o.counter ?? memoryVendorCounter(),
    caps: o.caps,
    timeouts: o.timeouts,
    recheckMs: o.recheckMs ?? 50,
    resolve: o.resolve ?? (async () => [PUBLIC]),
    connect: (address) => { seen.push(address); return net.connect({ host: "127.0.0.1", port: upPort }); },
  });
  await new Promise<void>((r) => d.server.listen(0, "127.0.0.1", r));
  const port = (d.server.address() as net.AddressInfo).port;
  return { d, port, seen, received: () => received, stop: async () => { await d.close(); up.close(); } };
}

test("bytes are counted before they are forwarded: a stalled shared count cannot let traffic past the cap", async () => {
  const store = memoryVendorCredentialStore();
  const mem = memoryVendorCounter();
  const stalled: VendorCounter = { open: mem.open, close: mem.close, bytes: () => new Promise(() => {}) };
  const t = await door2(store, { caps: { connections: 8, opensPerMinute: 60, bytes: 1_000 }, counter: stalled });
  try {
    const c = await credential(store);
    const r = await connectVia(t.port, "example.com:443", basic(c.username, c.password));
    assert.equal(r.status, 200);
    for (let i = 0; i < 20 && !r.sock.destroyed; i++) { r.sock.write("y".repeat(200)); await new Promise((x) => setTimeout(x, 5)); }
    assert.ok(await closedWithin(r.sock, 2_000), "cut off");
    assert.ok(t.received() <= 1_000, `the site got ${t.received()} bytes, at most the cap`);
  } finally { await t.stop(); }
});

test("a first chunk past the cap (sent with the CONNECT) is never forwarded", async () => {
  const store = memoryVendorCredentialStore();
  const t = await door2(store, { caps: { connections: 8, opensPerMinute: 60, bytes: 100 } });
  try {
    const c = await credential(store);
    const sock = net.connect({ host: "127.0.0.1", port: t.port });
    sock.on("error", () => {});
    await new Promise<void>((r) => sock.on("connect", () => r()));
    sock.write(`CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: ${basic(c.username, c.password)}\r\n\r\n${"z".repeat(500)}`);
    assert.ok(await closedWithin(sock, 2_000));
    await new Promise((x) => setTimeout(x, 50));
    assert.equal(t.received(), 0, "the oversized head did not reach the site");
  } finally { await t.stop(); }
});

test("a client that leaves while it is being admitted holds no slot and opens nothing", async () => {
  const mem = memoryVendorCredentialStore();
  let release!: () => void;
  const slow: VendorCredentialStore = { ...mem, get: async (id) => { await new Promise<void>((r) => (release = r)); return mem.get(id); } };
  const counted = memoryVendorCounter();
  let opened = 0;
  const counter: VendorCounter = { ...counted, open: async (...a) => { opened++; return counted.open(...a); } };
  const t = await door2(slow, { counter });
  try {
    const c = await credential(mem);
    const sock = net.connect({ host: "127.0.0.1", port: t.port });
    sock.on("error", () => {});
    await new Promise<void>((r) => sock.on("connect", () => r()));
    sock.write(`CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: ${basic(c.username, c.password)}\r\n\r\n`);
    await new Promise((x) => setTimeout(x, 30));
    sock.destroy();
    await new Promise((x) => setTimeout(x, 30));
    release();
    await new Promise((x) => setTimeout(x, 50));
    assert.equal(opened, 0, "no slot was taken for a client that had gone");
    assert.equal(t.seen.length, 0, "and no connection to the site");
    assert.equal(t.d.active(), 0);
  } finally { await t.stop(); }
});

test("a store that hangs: the recheck's deadline closes the tunnel", async () => {
  const mem = memoryVendorCredentialStore();
  let hang = false;
  const store: VendorCredentialStore = { ...mem, get: async (id) => { if (hang) return new Promise(() => {}); return mem.get(id); } };
  const t = await door2(store, { recheckMs: 50, timeouts: { recheckMs: 150 } });
  try {
    const c = await credential(mem);
    const r = await connectVia(t.port, "example.com:443", basic(c.username, c.password));
    assert.equal(r.status, 200);
    hang = true;
    assert.ok(await closedWithin(r.sock, 1_500), "closed when the store stopped answering");
  } finally { await t.stop(); }
});

test("a credential that expires closes its tunnel here, even with a store that hangs", async () => {
  const mem = memoryVendorCredentialStore();
  const c = mintVendorCredential({ tenant: "acme", runId: "r", vendor: "steel", leaseKey: `lease-${Math.random()}`, leaseExpiresAt: Date.now() + 1_500, policy: { level: "none", hosts: ["example.com"] }, boundHosts: [] });
  await saveVendorCredential(c, mem);
  // Admission asks leaseRevoked too, so it answers until the tunnel is open;
  // from then on it hangs, and only the credential's own expiry can close it.
  let hang = false;
  const t = await door2({ ...mem, leaseRevoked: async (k) => (hang ? new Promise<boolean>(() => {}) : mem.leaseRevoked(k)) }, { recheckMs: 50, timeouts: { recheckMs: 10_000 } });
  try {
    const r = await connectVia(t.port, "example.com:443", basic(c.username, c.password));
    assert.equal(r.status, 200);
    hang = true;
    assert.ok(await closedWithin(r.sock, 3_000), "closed at its expiry");
  } finally { await t.stop(); }
});

test("IPv6: a literal address reaches the socket whole", async () => {
  const store = memoryVendorCredentialStore();
  const t = await door2(store);
  try {
    const c = await credential(store, { level: "open", hosts: [] });
    const r = await connectVia(t.port, "[2606:4700:4700::1111]:443", basic(c.username, c.password));
    assert.equal(r.status, 200, r.text);
    assert.equal(t.seen[0], "2606:4700:4700::1111");
    r.sock.destroy();
    const bad = await connectVia(t.port, "[::ffff:10.0.0.1]:443", basic(c.username, c.password));
    assert.equal(bad.status, 403, "an IPv4-mapped private address is refused");
    bad.sock.destroy();
  } finally { await t.stop(); }
});

test("an idle tunnel is closed", async () => {
  const store = memoryVendorCredentialStore();
  const t = await door2(store, { timeouts: { idleMs: 150 } });
  try {
    const c = await credential(store);
    const r = await connectVia(t.port, "example.com:443", basic(c.username, c.password));
    assert.equal(r.status, 200);
    assert.ok(await closedWithin(r.sock, 1_500), "closed after going idle");
  } finally { await t.stop(); }
});

const REDIS = process.env.FOLDRUN_TEST_REDIS_URL;
test("Redis counter: admission is atomic, a slot never goes below zero", { skip: !REDIS && "set FOLDRUN_TEST_REDIS_URL" }, async () => {
  const { Redis } = await import("ioredis");
  const r = new Redis(REDIS!, { maxRetriesPerRequest: 1 });
  try {
    const counter = redisVendorCounter(async () => r as never);
    const lease = `lease-${Math.random()}`;
    const caps = { connections: 2, opensPerMinute: 3, bytes: 1_000 };
    const now = Date.now();
    assert.equal(await counter.open(lease, caps, now), null);
    assert.equal(await counter.open(lease, caps, now), null);
    assert.match((await counter.open(lease, caps, now))!, /at once/);
    await counter.close(lease); await counter.close(lease); await counter.close(lease);
    assert.equal(Number(await r.get(`foldrun:vendor-egress:open:${lease}`)), 0, "never below zero");
    assert.equal(await counter.open(lease, caps, now), null, "the third open in the minute");
    assert.match((await counter.open(lease, caps, now))!, /a minute/);
    assert.equal(await counter.bytes(lease, 999, caps), true);
    assert.equal(await counter.bytes(lease, 2, caps), false);
    assert.match((await counter.open(`${lease}`, { ...caps, opensPerMinute: 99 }, now + 60_000))!, /bytes are used/);
  } finally { r.disconnect(); }
});

test("admission has a deadline: a store that never answers is a 504, not a socket held forever", async () => {
  const mem = memoryVendorCredentialStore();
  const hanging: VendorCredentialStore = { ...mem, get: () => new Promise(() => {}) };
  const t = await door2(hanging, { timeouts: { admitMs: 150 } });
  try {
    const c = await credential(mem);
    const r = await connectVia(t.port, "example.com:443", basic(c.username, c.password));
    assert.equal(r.status, 504, r.text);
    r.sock.destroy();
  } finally { await t.stop(); }
});

test("half-close: the client's hang-up reaches the site, and the site's last bytes reach the client", async () => {
  const store = memoryVendorCredentialStore();
  let sawEnd = false;
  const up = net.createServer((c) => {
    c.on("error", () => {});
    c.on("end", () => { sawEnd = true; c.end("bye:" + "x".repeat(200_000)); });
  });
  await new Promise<void>((r) => up.listen(0, "127.0.0.1", r));
  const upPort = (up.address() as net.AddressInfo).port;
  const d = createVendorEgressServer({ store, counter: memoryVendorCounter(), recheckMs: 50, resolve: async () => [PUBLIC], connect: () => net.connect({ host: "127.0.0.1", port: upPort }) });
  await new Promise<void>((r) => d.server.listen(0, "127.0.0.1", r));
  const port = (d.server.address() as net.AddressInfo).port;
  try {
    const c = await credential(store);
    const r = await connectVia(port, "example.com:443", basic(c.username, c.password));
    assert.equal(r.status, 200);
    let got = "";
    r.sock.on("data", (x) => { got += x.toString(); });
    r.sock.end();
    await closedWithin(r.sock, 3_000);
    assert.ok(sawEnd, "the site saw the client's end");
    assert.equal(got.length, 4 + 200_000, "every byte the site sent after it reached the client");
  } finally { await d.close(); up.close(); }
});
