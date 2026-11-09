// The vendor egress door (FOL-145; phase 4 of foldrun-docs/proposals/
// browse-egress.md, design agreed with Codex on 8 Nov 2026).
//
// A vendor's remote browser is handed this door as its "customer proxy", so
// every page it loads comes back through foldrun and the step's `network:`
// list holds for it. The door faces the internet, so it is stricter than the
// internal forward door (egress-proxy.ts):
//
//   - it takes only a vendor session's own credential (vendor-egress-
//     credentials.ts: fv_<id>, ≤15 min, one lease), never a lease token;
//   - the site must be on the step's list (network.ts networkAllows);
//   - a site a secret is bound to is refused: a vendor's browser cannot
//     trust the egress CA, so the proxy cannot fill the secret there, and
//     tunnelling it instead would silently drop a promise — the trace says
//     "unsupported capability: vendor secret filling";
//   - ports 80 and 443 only;
//   - every address a name resolves to must be public (ssrf.ts), with NO
//     private-address override, and the socket goes to the address that was
//     checked (no second lookup to rebind);
//   - per-lease caps: connections at once, opens a minute, bytes both ways
//     — shared across door pods where the install has Redis;
//   - every second each credential still in use is checked again: revoked,
//     expired, or a store that cannot say, and its connections close.
//
// TLS to the door itself (a public certificate) is the server's: pass
// `tls` and it listens as HTTPS; tests run it plain.

import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns";
import { networkAllows, normalHost, siteCovers } from "../../foldrun-core/src/network.ts";
import { isPrivateAddress } from "./ssrf.ts";
import { cacheClient, cacheEnabled } from "./cache.ts";
import { vendorCredentialStore, verifyVendorCredential, type VendorCredentialRecord, type VendorCredentialStore } from "./vendor-egress-credentials.ts";

export const VENDOR_PORTS = [80, 443] as const;

export interface VendorCaps {
  /** Connections open at once, per lease. */
  connections: number;
  /** Connections opened in one minute, per lease. */
  opensPerMinute: number;
  /** Bytes both ways, per lease, over its life. */
  bytes: number;
}
export const DEFAULT_CAPS: VendorCaps = { connections: 32, opensPerMinute: 120, bytes: 100 * 1024 * 1024 };

/** The caps' accounting. Memory for one process; Redis for every door pod. */
export interface VendorCounter {
  /** Open one connection under a lease: null when allowed, else why not. */
  open(leaseKey: string, caps: VendorCaps, now: number): Promise<string | null>;
  close(leaseKey: string): Promise<void>;
  /** Add bytes; true while under the cap. */
  bytes(leaseKey: string, n: number, caps: VendorCaps): Promise<boolean>;
}

export interface VendorDoorEvent {
  kind: "connect" | "refused" | "closed";
  credentialId?: string;
  leaseKey?: string;
  vendor?: string;
  host?: string;
  port?: number;
  reason?: string;
  bytes?: number;
}

export interface VendorDoorOptions {
  store?: VendorCredentialStore;
  /** Every address for a name (default: dns.lookup, all). */
  resolve?: (host: string) => Promise<string[]>;
  /** A socket to a checked address (default: net.connect). */
  connect?: (address: string, port: number) => net.Socket;
  caps?: VendorCaps;
  counter?: VendorCounter;
  /** How often credentials in use are checked again (default 1 s). */
  recheckMs?: number;
  ports?: readonly number[];
  onEvent?: (e: VendorDoorEvent) => void;
  /** Serve HTTPS with this certificate (the public door). */
  tls?: { key: string | Buffer; cert: string | Buffer };
}

const lookupAll = (host: string) =>
  new Promise<string[]>((ok, no) => dns.lookup(host, { all: true }, (err, list) => (err ? no(err) : ok((list as dns.LookupAddress[]).map((a) => a.address)))));

/** `host:port` of a CONNECT; brackets of an IPv6 literal dropped. */
export function connectTarget(raw: string | undefined): { host: string; port: number } | null {
  const m = String(raw ?? "").match(/^\[?([^\]\s]+?)\]?:(\d{1,5})$/);
  if (!m) return null;
  const port = Number(m[2]);
  return port > 0 && port < 65536 ? { host: m[1]!, port } : null;
}

/** Why the door refuses this site for this session, or null. Pure. */
/** A CONNECT host, lowercased; an IP literal kept whole (network.ts
 *  normalHost would read an IPv6 address's last group as a port). */
export function doorHost(host: string): string {
  const bare = host.trim().replace(/^\[|\]$/g, "").toLowerCase();
  return net.isIP(bare) ? bare : normalHost(bare);
}

export function refusalFor(rec: Pick<VendorCredentialRecord, "policy" | "boundHosts">, host: string, port: number, ports: readonly number[] = VENDOR_PORTS): { status: number; reason: string } | null {
  const h = doorHost(host);
  if (!ports.includes(port)) return { status: 403, reason: `port ${port} — this door opens ${ports.join(" and ")} only` };
  if (net.isIP(h) && isPrivateAddress(h)) return { status: 403, reason: "a private or internal address" };
  if (rec.boundHosts.some((s) => siteCovers(s, h))) return { status: 403, reason: "unsupported capability: vendor secret filling — a secret is bound to this site, and a vendor's browser cannot be handed it; use foldrun's own browser for this step" };
  if (!networkAllows(rec.policy, h)) return { status: 403, reason: "not on this step's network: list" };
  return null;
}

export function memoryVendorCounter(): VendorCounter {
  const open = new Map<string, number>();
  const opens = new Map<string, { minute: number; n: number }>();
  const bytes = new Map<string, number>();
  return {
    async open(leaseKey, caps, now) {
      const minute = Math.floor(now / 60_000);
      const o = opens.get(leaseKey);
      const n = o && o.minute === minute ? o.n : 0;
      if (n >= caps.opensPerMinute) return `more than ${caps.opensPerMinute} connections a minute for this step`;
      if ((open.get(leaseKey) ?? 0) >= caps.connections) return `more than ${caps.connections} connections at once for this step`;
      if ((bytes.get(leaseKey) ?? 0) >= caps.bytes) return `this step's ${caps.bytes} bytes are used`;
      opens.set(leaseKey, { minute, n: n + 1 });
      open.set(leaseKey, (open.get(leaseKey) ?? 0) + 1);
      return null;
    },
    async close(leaseKey) {
      const n = (open.get(leaseKey) ?? 1) - 1;
      if (n > 0) open.set(leaseKey, n);
      else open.delete(leaseKey);
    },
    async bytes(leaseKey, n, caps) {
      const t = (bytes.get(leaseKey) ?? 0) + n;
      bytes.set(leaseKey, t);
      // Old minutes' open counts go; a single process keeps no more than it needs.
      const minute = Math.floor(Date.now() / 60_000);
      for (const [k, v] of opens) if (v.minute < minute - 1) opens.delete(k);
      return t <= caps.bytes;
    },
  };
}

type RedisLike = {
  eval: (script: string, numKeys: number, ...args: (string | number)[]) => Promise<unknown>;
  decr: (k: string) => Promise<number>;
  incrby: (k: string, n: number) => Promise<number>;
  set: (...a: (string | number)[]) => Promise<unknown>;
  expire: (k: string, s: number) => Promise<unknown>;
};

// One admission, atomically: bytes left, an open this minute, a slot now —
// all or nothing, with their expiries in the same step (a partial failure
// cannot leave a slot taken). Returns 0 (admitted), 1 (bytes used), 2 (a
// minute's opens), 3 (at once).
const ADMIT = `
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used >= tonumber(ARGV[1]) then return 1 end
local opens = tonumber(redis.call('GET', KEYS[2]) or '0')
if opens >= tonumber(ARGV[2]) then return 2 end
local at = tonumber(redis.call('GET', KEYS[3]) or '0')
if at >= tonumber(ARGV[3]) then return 3 end
redis.call('INCR', KEYS[2]); redis.call('EXPIRE', KEYS[2], 120)
redis.call('INCR', KEYS[3]); redis.call('EXPIRE', KEYS[3], 3600)
return 0`;
// A slot back, never below zero.
const RELEASE = `
local n = tonumber(redis.call('GET', KEYS[1]) or '0')
if n > 0 then redis.call('DECR', KEYS[1]) end
return 0`;

/** The caps shared by every door pod. A pod that dies holding connections
 *  leaves its count to expire with the key (an hour at most). */
export function redisVendorCounter(client: () => Promise<RedisLike | null>): VendorCounter {
  const k = (kind: string, leaseKey: string) => `foldrun:vendor-egress:${kind}:${leaseKey}`;
  const c = async () => {
    const r = await client();
    if (!r) throw new Error("vendor egress: Redis is not reachable");
    return r;
  };
  return {
    async open(leaseKey, caps, now) {
      const r = await c();
      const got = Number(await r.eval(ADMIT, 3, k("bytes", leaseKey), k(`opens:${Math.floor(now / 60_000)}`, leaseKey), k("open", leaseKey), caps.bytes, caps.opensPerMinute, caps.connections));
      if (got === 1) return `this step's ${caps.bytes} bytes are used`;
      if (got === 2) return `more than ${caps.opensPerMinute} connections a minute for this step`;
      if (got === 3) return `more than ${caps.connections} connections at once for this step`;
      return null;
    },
    async close(leaseKey) {
      await (await c()).eval(RELEASE, 1, k("open", leaseKey));
    },
    async bytes(leaseKey, n, caps) {
      const r = await c();
      const bk = k("bytes", leaseKey);
      const t = await r.incrby(bk, n);
      await r.expire(bk, 3_600);
      return t <= caps.bytes;
    },
  };
}

function reply(socket: net.Socket, status: number, reason: string, extra = ""): void {
  const text: Record<number, string> = { 400: "Bad Request", 403: "Forbidden", 407: "Proxy Authentication Required", 429: "Too Many Requests", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout" };
  const body = `foldrun vendor egress: ${reason}\n`;
  try {
    if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${text[status] ?? "Error"}\r\n${extra}content-type: text/plain\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
  } catch {}
}

/** A promise with a deadline: rejects with `timeout` when it does not settle in `ms`. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((ok, no) => {
    const t = setTimeout(() => no(Object.assign(new Error("timeout"), { code: "TIMEOUT" })), ms);
    t.unref(); // a deadline never keeps the process alive on its own
    p.then((v) => { clearTimeout(t); ok(v); }, (e) => { clearTimeout(t); no(e); });
  });
}

export interface VendorDoorTimeouts {
  /** From the CONNECT to admission (credential, DNS, caps). */
  admitMs: number;
  /** For the site to accept the connection. */
  connectMs: number;
  /** A tunnel with no bytes either way is closed. */
  idleMs: number;
  /** One recheck of a credential's store record. */
  recheckMs: number;
}
export const DEFAULT_TIMEOUTS: VendorDoorTimeouts = { admitMs: 10_000, connectMs: 10_000, idleMs: 5 * 60_000, recheckMs: 2_000 };

export function createVendorEgressServer(o: VendorDoorOptions & { timeouts?: Partial<VendorDoorTimeouts> } = {}) {
  const store = o.store ?? vendorCredentialStore();
  const resolve = o.resolve ?? lookupAll;
  const connect = o.connect ?? ((address: string, port: number) => net.connect({ host: address, port }));
  const caps = o.caps ?? DEFAULT_CAPS;
  const counter = o.counter ?? (cacheEnabled() ? redisVendorCounter(() => cacheClient() as never) : memoryVendorCounter());
  const ports = o.ports ?? VENDOR_PORTS;
  const tmo: VendorDoorTimeouts = { ...DEFAULT_TIMEOUTS, ...o.timeouts };
  const emit = (e: VendorDoorEvent) => { try { o.onEvent?.(e); } catch {} };
  /** Per credential: its sockets, its expiry (enforced here, without the
   *  store), and whether a recheck is already in flight. */
  const live = new Map<string, { sockets: Set<net.Socket>; expiresAt: number; checking: boolean }>();
  /** Bytes per lease counted in this process, checked BEFORE a chunk is
   *  forwarded; the shared count follows. A slow store cannot let traffic
   *  run past the cap here; across pods the overshoot is bounded by them. */
  const localBytes = new Map<string, number>();
  /** When each lease last moved a byte here: a lease idle past any
   *  credential's life (20 min > 15) is dropped from localBytes — its
   *  lifetime cap is the shared count's from then on. */
  const lastActive = new Map<string, number>();
  const EVICT_MS = 20 * 60_000;

  const server: http.Server = o.tls ? https.createServer({ key: o.tls.key, cert: o.tls.cert, minVersion: "TLSv1.2" }) : http.createServer();
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;

  // Plain-HTTP requests through the door are refused: a vendor's browser
  // reaches https:// pages with CONNECT, and a forward HTTP request would
  // need the door to read and rewrite traffic it has no reason to see.
  server.on("request", (req, res) => {
    res.writeHead(405, { "content-type": "text/plain", connection: "close" });
    res.end("foldrun vendor egress: this door is for CONNECT only\n");
    emit({ kind: "refused", reason: `${req.method} ${req.url?.slice(0, 80)} — CONNECT only` });
  });

  server.on("connect", (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    // Cancellation from the first moment: a client that goes while it is
    // being admitted releases whatever was reserved, and nothing opens for it.
    let gone = false;
    client.on("error", () => {});
    client.once("close", () => { gone = true; });
    // The HTTP server keeps sockets half-open, so a client that hangs up is
    // first an `end`, not a `close`: that counts as gone too.
    client.once("end", () => { if (!admitted) { gone = true; client.destroy(); } });
    const admitTimer = setTimeout(() => { if (!admitted) { gone = true; reply(client, 504, "admission took too long"); client.destroy(); } }, tmo.admitMs);
    let admitted = false;
    void (async () => {
      const target = connectTarget(req.url);
      if (!target) return reply(client, 400, "CONNECT host:port");
      const auth = await verifyVendorCredential(req.headers["proxy-authorization"], store);
      if (gone) return;
      if ("status" in auth) {
        emit({ kind: "refused", host: target.host, port: target.port, reason: auth.message });
        return reply(client, auth.status, auth.message.replace(/^vendor egress: /, ""), auth.status === 407 ? 'proxy-authenticate: Basic realm="foldrun vendor egress"\r\n' : "");
      }
      const rec = auth.record;
      const host = doorHost(target.host);
      const base = { credentialId: rec.id, leaseKey: rec.leaseKey, vendor: rec.vendor, host, port: target.port };
      const no = refusalFor(rec, host, target.port, ports);
      if (no) {
        emit({ kind: "refused", ...base, reason: no.reason });
        return reply(client, no.status, no.reason);
      }
      // Every address the name resolves to must be public, and the socket
      // goes to one of THOSE addresses — a second lookup could be rebound.
      let address = host;
      if (!net.isIP(address)) {
        let list: string[];
        try {
          list = await resolve(address);
        } catch {
          if (gone) return;
          emit({ kind: "refused", ...base, reason: "no address for that name" });
          return reply(client, 502, "no address for that name");
        }
        if (gone) return;
        const bad = list.find((a) => isPrivateAddress(a));
        if (!list.length || bad) {
          emit({ kind: "refused", ...base, reason: "it resolves to a private or internal address" });
          return reply(client, 403, "it resolves to a private or internal address");
        }
        address = list[0]!;
      }
      if ((localBytes.get(rec.leaseKey) ?? 0) >= caps.bytes) {
        emit({ kind: "refused", ...base, reason: `this step's ${caps.bytes} bytes are used` });
        return reply(client, 429, `this step's ${caps.bytes} bytes are used`);
      }
      let capped: string | null;
      try {
        capped = await counter.open(rec.leaseKey, caps, Date.now());
      } catch {
        if (!gone) reply(client, 503, "the door's accounting did not answer — refused");
        return;
      }
      if (capped) {
        emit({ kind: "refused", ...base, reason: capped });
        return reply(client, 429, capped);
      }
      // A slot is held from here: every way out gives it back, once.
      let released = false;
      const release = () => { if (!released) { released = true; void counter.close(rec.leaseKey).catch(() => {}); } };
      if (gone) return release();
      admitted = true;
      clearTimeout(admitTimer);

      let closed = false;
      let moved = 0;
      let idle: NodeJS.Timeout | null = null;
      const entry = live.get(rec.id) ?? { sockets: new Set<net.Socket>(), expiresAt: rec.expiresAt, checking: false };
      live.set(rec.id, entry);
      entry.sockets.add(client);
      let upstream: net.Socket;
      const done = () => {
        if (closed) return;
        closed = true;
        if (idle) clearTimeout(idle);
        entry.sockets.delete(client);
        if (!entry.sockets.size) live.delete(rec.id);
        client.destroy();
        upstream?.destroy();
        release();
        emit({ kind: "closed", ...base, bytes: moved });
      };
      const touch = () => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(done, tmo.idleMs);
      };
      try {
        upstream = connect(address, target.port);
      } catch {
        reply(client, 502, "the site could not be reached");
        return done();
      }
      upstream.on("error", () => { if (!closed) reply(client, 502, "the site could not be reached"); done(); });
      // A hang-up from the client is passed on from the start, even while
      // the site is still connecting (end() then waits for the connection).
      client.on("end", () => { if (!closed) upstream.end(); });
      upstream.on("end", () => { if (!closed) client.end(); });
      // Switched off once connected (below), so a timeout here means the
      // site never accepted the connection.
      upstream.setTimeout(tmo.connectMs, () => { reply(client, 504, "the site did not answer"); done(); });
      // One side closing ENDS the other — its queued bytes still flush —
      // and the other's own close finishes the job; five seconds at most.
      const finish = (other: net.Socket) => () => {
        if (closed) return;
        if (other.destroyed || !other.writable) return done();
        other.end();
        other.once("close", done);
        setTimeout(done, 5_000).unref();
      };
      client.on("close", finish(upstream));
      upstream.on("close", finish(client));
      if (gone) return done();

      /** Count a chunk before it is forwarded; refuse it past the cap. */
      const admit = (n: number): boolean => {
        const t = (localBytes.get(rec.leaseKey) ?? 0) + n;
        if (t > caps.bytes) return false;
        localBytes.set(rec.leaseKey, t);
        lastActive.set(rec.leaseKey, Date.now());
        moved += n;
        // The shared count follows; past the cap, or not answering in time,
        // and the tunnel closes (fail closed).
        void within(counter.bytes(rec.leaseKey, n, caps), tmo.recheckMs).then((under) => { if (!under) done(); }, () => done());
        return true;
      };
      const relay = (from: net.Socket, to: net.Socket) => {
        // (Each side's end is passed on above, as pipe() did.)
        from.on("data", (chunk: Buffer) => {
          if (closed) return;
          if (!admit(chunk.length)) return done();
          touch();
          if (!to.write(chunk)) {
            from.pause();
            to.once("drain", () => from.resume());
          }
        });
      };
      upstream.on("connect", () => {
        if (closed) return;
        upstream.setTimeout(0);
        if (head?.length && !admit(head.length)) return done();
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head?.length) upstream.write(head);
        emit({ kind: "connect", ...base });
        touch();
        relay(client, upstream);
        relay(upstream, client);
      });
    })()
      .catch(() => { try { client.destroy(); } catch {} })
      .finally(() => { if (!admitted) clearTimeout(admitTimer); });
  });

  // Each tick: a credential past its expiry closes here, store or not; the
  // rest are checked again — one check at a time per credential, each with a
  // deadline. Revoked, unknown, a store that cannot say or does not answer in
  // time: its connections close.
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [lease, at] of lastActive) {
      if (now - at > EVICT_MS) { lastActive.delete(lease); localBytes.delete(lease); }
    }
    for (const [id, entry] of live) {
      const kill = () => { for (const s of [...entry.sockets]) s.destroy(); };
      if (entry.expiresAt <= now) { kill(); continue; }
      if (entry.checking) continue;
      entry.checking = true;
      void (async () => {
        let ok = false;
        try {
          const r = await within(store.get(id), tmo.recheckMs);
          ok = !!r && r.expiresAt > Date.now() && !(await within(store.leaseRevoked(r.leaseKey), tmo.recheckMs));
        } catch {
          ok = false;
        }
        entry.checking = false;
        if (!ok) kill();
      })();
    }
  }, o.recheckMs ?? 1_000);
  timer.unref();
  server.on("close", () => clearInterval(timer));

  return {
    server,
    /** Connections open now, across credentials. */
    active: () => [...live.values()].reduce((n, e) => n + e.sockets.size, 0),
    close: () => new Promise<void>((ok) => {
      clearInterval(timer);
      for (const e of live.values()) for (const s of e.sockets) s.destroy();
      server.close(() => ok());
    }),
  };
}
