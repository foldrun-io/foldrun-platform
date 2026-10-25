// The platform's own requests to addresses a tenant chose.
//
// The egress proxy and every other call the platform makes on a tenant's
// behalf run on the worker or web tier, not in a sandbox — so a tenant who
// names an internal host (the database, Redis, the metadata endpoint, the
// API server) is asking the platform to reach inward for them. The
// NetworkPolicies refuse most of that; this is the second wall, in code, so
// one policy mistake does not open the door.
//
// The check runs at CONNECT time, on the addresses the socket is about to
// use. Checking a name before fetching it is not enough: DNS can answer a
// public address to the check and a private one to the fetch (rebinding).
//
//   FOLDRUN_EGRESS_ALLOW_PRIVATE=1   a single-tenant install whose agents
//                                    call APIs on its own LAN turns it off

import dns from "node:dns";
import net from "node:net";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";
import { capBody, MAX_BYTES } from "../../foldrun-core/src/untrusted-fetch.ts";

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT, and some pod networks
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local: the cloud metadata endpoint
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and the broadcast address
] as const) blocked.addSubnet(addr, prefix, "ipv4");
for (const [addr, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) blocked.addSubnet(addr, prefix, "ipv6");

export const privateAllowed = () => process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE === "1";

/** An IPv4 address hiding inside an IPv6 one — mapped (::ffff:a.b.c.d) or
 *  NAT64 (64:ff9b::a.b.c.d) — or null. Either reaches the IPv4 host. */
function embeddedV4(ip: string): string | null {
  const m = ip.toLowerCase().match(/^(?:::ffff:|64:ff9b::)(?:0:)?([0-9a-f.:]+)$/);
  if (!m) return null;
  if (net.isIPv4(m[1])) return m[1];
  const hex = m[1].split(":");
  if (hex.length !== 2) return null;
  const n = (parseInt(hex[0], 16) << 16) | parseInt(hex[1], 16);
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/** True when an IP literal is somewhere the platform must not be sent. */
export function isPrivateAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (net.isIPv4(bare)) return blocked.check(bare, "ipv4");
  if (net.isIPv6(bare)) {
    const v4 = embeddedV4(bare);
    return v4 ? blocked.check(v4, "ipv4") : blocked.check(bare, "ipv6");
  }
  return false;
}

export class PrivateAddressError extends Error {
  constructor(what: string) {
    super(
      `${what} — the platform does not send requests inward ` +
        `(FOLDRUN_EGRESS_ALLOW_PRIVATE=1 allows it on a single-tenant install that needs to)`,
    );
    this.name = "PrivateAddressError";
  }
}

/** A dns.lookup that refuses to hand back a private address. Every address
 *  a name resolves to is checked, not only the first: a socket may try the
 *  next one when the first fails. */
export const guardedLookup: typeof dns.lookup = ((hostname: string, options: dns.LookupOptions | ((...a: unknown[]) => void), callback?: (...a: unknown[]) => void) => {
  const cb = (typeof options === "function" ? options : callback)!;
  const opts: dns.LookupOptions = typeof options === "object" && options ? options : {};
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return cb(err);
    const list = addresses as dns.LookupAddress[];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad) return cb(new PrivateAddressError(`${hostname} resolves to ${bad.address}, a private or internal address`));
    if (opts.all) return cb(null, list);
    const first = list[0];
    if (!first) return cb(Object.assign(new Error(`no address for ${hostname}`), { code: "ENOTFOUND" }));
    cb(null, first.address, first.family);
  });
}) as typeof dns.lookup;

let agent: Agent | null = null;
/** The dispatcher for a fetch to a tenant-chosen URL. The lookup guards a
 *  name; an IP literal never reaches a lookup (the socket connects to it
 *  straight away), so the connector checks the host itself first. */
export function publicOnlyDispatcher(): Agent {
  if (agent) return agent;
  const base = buildConnector({ lookup: guardedLookup } as buildConnector.BuildOptions);
  const connect: buildConnector.connector = (opts, cb) => {
    const host = String(opts.hostname ?? "");
    if (net.isIP(host.replace(/^\[|\]$/g, "")) && isPrivateAddress(host)) {
      return cb(new PrivateAddressError(`${host} is a private or internal address`), null);
    }
    return base(opts, cb);
  };
  return (agent = new Agent({ connect }));
}

/** A client certificate to present on the TLS connection (mutual TLS).
 *  `pool` names its connection pool: a pool belongs to one certificate
 *  version of one secret, so two never share a socket. `identity` names the
 *  secret across versions, so a rotated certificate retires the old pool. */
export interface ClientCert {
  pool: string;
  identity: string;
  cert: string;
  key: string;
  passphrase?: string;
}

const certAgents = new Map<string, { agent: Agent; usedAt: number; identity: string }>();
const certPoolOf = new Map<string, string>();
/** A certificate pool unused this long is closed and forgotten, and at most
 *  this many are kept: a worker serves many accounts for a long time, and
 *  each pool holds a private key. */
const CERT_POOL_IDLE_MS = 10 * 60 * 1000;
const CERT_POOLS_MAX = 64;

function retire(pool: string): void {
  const had = certAgents.get(pool);
  if (!had) return;
  certAgents.delete(pool);
  if (certPoolOf.get(had.identity) === pool) certPoolOf.delete(had.identity);
  void had.agent.close().catch(() => undefined);
}

/** The guarded dispatcher, presenting a client certificate: the same lookup
 *  guard and IP-literal check as publicOnlyDispatcher, with the certificate
 *  added to the TLS options. Server certificates are still verified. */
export function certDispatcher(c: ClientCert): Agent {
  const now = Date.now();
  for (const [pool, v] of certAgents) if (now - v.usedAt > CERT_POOL_IDLE_MS) retire(pool);
  const have = certAgents.get(c.pool);
  if (have) {
    have.usedAt = now;
    return have.agent;
  }
  const previous = certPoolOf.get(c.identity);
  if (previous && previous !== c.pool) retire(previous);
  // Over the cap: the least recently used goes.
  while (certAgents.size >= CERT_POOLS_MAX) {
    let oldest: [string, number] | null = null;
    for (const [pool, v] of certAgents) if (!oldest || v.usedAt < oldest[1]) oldest = [pool, v.usedAt];
    retire(oldest![0]);
  }
  const tls = { cert: c.cert, key: c.key, ...(c.passphrase ? { passphrase: c.passphrase } : {}) };
  const base = buildConnector({ ...(privateAllowed() ? {} : { lookup: guardedLookup }), ...tls } as buildConnector.BuildOptions);
  const connect: buildConnector.connector = (opts, cb) => {
    const host = String(opts.hostname ?? "");
    if (!privateAllowed() && net.isIP(host.replace(/^\[|\]$/g, "")) && isPrivateAddress(host)) {
      return cb(new PrivateAddressError(`${host} is a private or internal address`), null);
    }
    return base(opts, cb);
  };
  const made = new Agent({ connect });
  certAgents.set(c.pool, { agent: made, usedAt: now, identity: c.identity });
  certPoolOf.set(c.identity, c.pool);
  return made;
}

/** Refuse before connecting when the URL names an internal host outright —
 *  an IP literal skips DNS, so the lookup above would never see it. Null
 *  when the URL may be fetched. */
export function refuseInternalUrl(url: string): string | null {
  if (privateAllowed()) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "not a URL";
  }
  const bare = host.replace(/^\[|\]$/g, "");
  if (isPrivateAddress(bare)) return `${host} is a private or internal address`;
  if (bare === "localhost" || bare.endsWith(".localhost") || bare.endsWith(".internal") || bare.endsWith(".local")) {
    return `${host} is an internal name`;
  }
  // Cluster DNS: a bare service name, or *.svc / *.cluster.local.
  if (!bare.includes(".") || bare.endsWith(".svc") || bare.includes(".svc.")) return `${host} is an internal name`;
  return null;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
/** Headers that carry a credential for the origin they were written for. */
const CREDENTIAL_HEADERS = ["authorization", "proxy-authorization", "cookie"];

/** fetch() for a URL a tenant chose: refused outright when it names an
 *  internal host, and pinned to public addresses at connect time.
 *
 *  Redirects are followed here, one hop at a time, never by undici: a
 *  Location is a URL the far end chose, so every hop is checked the way the
 *  first was (a 302 to http://169.254.169.254/ is a request inward like any
 *  other). A hop to another origin drops the credential headers, and a 307
 *  or 308 that would resend a body to another origin is not followed — the
 *  caller gets the redirect itself. `redirect: "manual"` hands back the first
 *  response untouched; `redirect: "error"` throws on any redirect, for a
 *  request (a token exchange) that must reach the URL it names or nothing.
 *
 *  The answer is read to `maxBytes` (core's MAX_BYTES, 1 MiB, unless the
 *  caller says): past it the body errors with ResponseTooLarge, never ends
 *  short as if whole. Infinity for a caller that streams with its own
 *  limits (the egress proxy). */
export async function fetchPublic(url: string, init: RequestInit = {}, opts: { clientCert?: ClientCert; maxBytes?: number } = {}): Promise<Response> {
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  const mode = init.redirect ?? "follow";
  let current = url;
  let cert = opts.clientCert;
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  const headers = new Headers(init.headers);
  for (let hop = 0; ; hop++) {
    const why = refuseInternalUrl(current);
    if (why) throw new PrivateAddressError(hop ? `redirected to ${why}` : why);
    const res = await hop_.fetch(current, { ...init, method, headers, body: body ?? undefined, redirect: "manual" }, cert);
    const location = res.headers.get("location");
    if (!REDIRECTS.has(res.status) || !location || mode === "manual") return capBody(res, maxBytes, current);
    if (mode === "error") {
      await res.body?.cancel().catch(() => {});
      throw new Error(`${current} redirected (${res.status}) to ${location}; this request does not follow redirects`);
    }
    if (hop >= MAX_REDIRECTS) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`${url}: more than ${MAX_REDIRECTS} redirects`);
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return capBody(res, maxBytes, current);
    }
    const crossOrigin = next.origin !== new URL(current).origin;
    // The fetch spec: a 303 (and a 301/302 answering a POST) becomes a GET
    // without its body; a 307/308 resends the same method and body.
    if (res.status === 303 ? method !== "HEAD" : (res.status === 301 || res.status === 302) && method === "POST") {
      method = "GET";
      body = undefined;
      for (const h of ["content-type", "content-length", "content-encoding", "content-language", "content-location"]) headers.delete(h);
    }
    if (body != null && (crossOrigin || typeof body !== "string")) return capBody(res, maxBytes, current); // a body we will not resend there, or cannot resend
    if (crossOrigin) for (const h of CREDENTIAL_HEADERS) headers.delete(h);
    // A client certificate is for the site it was presented to, never the
    // one a redirect points at.
    if (crossOrigin) cert = undefined;
    await res.body?.cancel().catch(() => {});
    current = next.href;
  }
}

/** One request, no redirects followed. A seam: the redirect tests stand a
 *  "public" first hop in front of a loopback server. */
export const hop_ = { fetch: fetchOnce };

async function fetchOnce(url: string, init: RequestInit, clientCert?: ClientCert): Promise<Response> {
  // A client certificate rides on its own guarded dispatcher (certDispatcher).
  if (clientCert) return (await undiciFetch(url, { ...init, dispatcher: certDispatcher(clientCert) } as never)) as unknown as Response;
  if (privateAllowed()) return fetch(url, init);
  // undici's own fetch: a dispatcher from this package handed to Node's
  // bundled fetch is a cross-version pairing that breaks on upgrades.
  return (await undiciFetch(url, { ...init, dispatcher: publicOnlyDispatcher() } as never)) as unknown as Response;
}
