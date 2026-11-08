// Credentials for the vendor egress door (FOL-145; phase 4 of
// foldrun-docs/proposals/browse-egress.md, design agreed with Codex 8 Nov 2026).
//
// A vendor's remote browser (Browserbase, Steel, Hyperbrowser, Browserless)
// runs on the vendor's machines. To hold it to a step's `network:` list it
// is given foldrun's egress door as its "customer proxy": every page it
// loads comes back through us. That door faces the internet, so the
// credential it takes is NOT the step's lease token (which the internal
// forward door accepts, egress-proxy.ts proxyToken, and which carries far
// more than one browser session's authority). Instead, per vendor session:
//
//   - a random id and an independent 256-bit random password, sent as Basic
//     `fv_<id>:<password>`; only the password's SHA-256 is stored;
//   - bound to one lease (tenant, run, step) and one vendor;
//   - expiring at the earlier of the lease's end and 15 minutes — a longer
//     browsing session gets a new credential;
//   - revoked, all at once, when the lease ends;
//   - checked fail-closed: a store that cannot answer is a 503, never a pass.
//
// A lease token never authenticates here (no `fv_` id), and this credential
// never authenticates the internal doors (they look up lease tokens only).

import crypto from "node:crypto";
import { cacheClient, cacheEnabled } from "./cache.ts";

/** The longest one credential lives, whatever the lease says. */
export const VENDOR_SESSION_MAX_MS = 15 * 60 * 1000;
/** The Basic username's prefix: what tells this door's credential apart. */
export const VENDOR_USER_PREFIX = "fv_";

export interface VendorCredentialRecord {
  id: string;
  /** SHA-256 of the password, hex. The password itself is never kept. */
  hash: string;
  tenant: string;
  runId: string;
  /** The step (agent#group) the lease is for, as the trace names it. */
  step?: string;
  /** The vendor it was minted for (providers.ts BROWSER_APIS name). */
  vendor: string;
  /** The lease's store key (Lease.key) — never the lease token. */
  leaseKey: string;
  /** Epoch ms. */
  expiresAt: number;
  createdAt: number;
  /** What the door holds this session to — a projection of the lease, never
   *  its secrets: the step's `network:` level and sites… */
  policy: { level: "open" | "trusted" | "none"; hosts: string[] };
  /** …and the sites a secret is bound to, which a vendor browser may not
   *  load (it cannot trust the egress CA, so the proxy cannot fill them). */
  boundHosts: string[];
}

export interface VendorCredential {
  username: string;
  password: string;
  expiresAt: number;
  record: VendorCredentialRecord;
}

/** Where the records live: memory, or Redis where the install has it. */
export interface VendorCredentialStore {
  put(rec: VendorCredentialRecord, ttlSec: number): Promise<void>;
  get(id: string): Promise<VendorCredentialRecord | null>;
  del(id: string): Promise<void>;
  /** Every live credential id minted under one lease, for revocation. */
  idsForLease(leaseKey: string): Promise<string[]>;
  /** Mark a lease revoked for longer than any credential lives: a credential
   *  saved under it afterwards (a save racing the revocation) is refused. */
  markLeaseRevoked(leaseKey: string): Promise<void>;
  leaseRevoked(leaseKey: string): Promise<boolean>;
}

export class VendorCredentialStoreUnavailable extends Error {}

const sha256 = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const b64url = (n: number) => crypto.randomBytes(n).toString("base64url");

/** A new credential for one vendor session under one lease. Not stored yet. */
export function mintVendorCredential(o: {
  tenant: string;
  runId: string;
  step?: string;
  vendor: string;
  leaseKey: string;
  /** When the lease itself ends, epoch ms. */
  leaseExpiresAt: number;
  policy: { level: "open" | "trusted" | "none"; hosts: string[] };
  boundHosts: string[];
  now?: number;
}): VendorCredential {
  const now = o.now ?? Date.now();
  const id = b64url(16);
  const password = b64url(32);
  const expiresAt = Math.min(o.leaseExpiresAt, now + VENDOR_SESSION_MAX_MS);
  const record: VendorCredentialRecord = {
    id,
    hash: sha256(password),
    tenant: o.tenant,
    runId: o.runId,
    ...(o.step ? { step: o.step } : {}),
    vendor: o.vendor,
    leaseKey: o.leaseKey,
    expiresAt,
    createdAt: now,
    policy: { level: o.policy.level, hosts: [...o.policy.hosts] },
    boundHosts: [...o.boundHosts],
  };
  return { username: `${VENDOR_USER_PREFIX}${id}`, password, expiresAt, record };
}

/** Store a minted credential until it expires. Refuses one already expired. */
export async function saveVendorCredential(c: VendorCredential, s: VendorCredentialStore = vendorCredentialStore(), now = Date.now()): Promise<void> {
  const ttlSec = Math.ceil((c.record.expiresAt - now) / 1000);
  if (ttlSec <= 0) throw new Error("vendor egress: a credential that has already expired is not stored");
  if (await s.leaseRevoked(c.record.leaseKey)) throw new Error("vendor egress: that lease has ended — no credential for it");
  await s.put(c.record, ttlSec);
  // A revocation that ran between the check above and the put did not see
  // this id: look again, and take it back out if so.
  if (await s.leaseRevoked(c.record.leaseKey)) {
    await s.del(c.record.id);
    throw new Error("vendor egress: that lease has ended — no credential for it");
  }
}

/** `fv_<id>` and the password from a Proxy-Authorization Basic header. */
export function parseVendorAuth(header: string | string[] | undefined): { id: string; password: string } | null {
  const v = Array.isArray(header) ? header[0] : header;
  const m = v?.match(/^Basic\s+([A-Za-z0-9+/=]+)\s*$/i);
  if (!m) return null;
  const decoded = Buffer.from(m[1]!, "base64").toString("utf8");
  const i = decoded.indexOf(":");
  if (i < 0) return null;
  const user = decoded.slice(0, i);
  const password = decoded.slice(i + 1);
  if (!user.startsWith(VENDOR_USER_PREFIX)) return null;
  const id = user.slice(VENDOR_USER_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(id) || !/^[A-Za-z0-9_-]{32,128}$/.test(password)) return null;
  return { id, password };
}

/** Check a request's credential. 407 for anything that is not a live one of
 *  ours; 503 when the store cannot say (fail closed). */
export async function verifyVendorCredential(
  header: string | string[] | undefined,
  s: VendorCredentialStore = vendorCredentialStore(),
  at?: number,
): Promise<{ record: VendorCredentialRecord } | { status: 407 | 503; message: string }> {
  const auth = parseVendorAuth(header);
  if (!auth) return { status: 407, message: "vendor egress: this door takes a vendor session's credential (fv_…), and only that" };
  let rec: VendorCredentialRecord | null;
  let revoked = false;
  try {
    rec = await s.get(auth.id);
    if (rec) revoked = await s.leaseRevoked(rec.leaseKey);
  } catch {
    return { status: 503, message: "vendor egress: the credential store did not answer — refused" };
  }
  // The clock is read after the lookup, so a slow store cannot let a
  // credential that expired meanwhile through.
  const now = at ?? Date.now();
  const want = Buffer.from(rec?.hash ?? "0".repeat(64), "hex");
  const got = Buffer.from(sha256(auth.password), "hex");
  // Compared in constant time even when the id is unknown.
  const same = want.length === got.length && crypto.timingSafeEqual(want, got);
  if (!rec || !same) return { status: 407, message: "vendor egress: no such credential" };
  if (revoked) return { status: 407, message: "vendor egress: that credential's lease has ended" };
  if (rec.expiresAt <= now) return { status: 407, message: "vendor egress: that credential has expired — the session gets a new one" };
  return { record: rec };
}

/** Revoke one credential. */
export async function revokeVendorCredential(id: string, s: VendorCredentialStore = vendorCredentialStore()): Promise<void> {
  await s.del(id);
}

/** Revoke every credential minted under a lease (the lease ended). Returns
 *  how many went. */
export async function revokeVendorCredentialsForLease(leaseKey: string, s: VendorCredentialStore = vendorCredentialStore()): Promise<number> {
  // The mark first: a save racing this revocation sees it and takes itself
  // back out (saveVendorCredential), and verify refuses under it.
  await s.markLeaseRevoked(leaseKey);
  const ids = await s.idsForLease(leaseKey);
  for (const id of ids) await s.del(id);
  return ids.length;
}

// --------------------------------------------------------------- the stores

/** How long a lease's revoked mark lasts: longer than any credential. */
const REVOKED_TTL_SEC = Math.ceil(VENDOR_SESSION_MAX_MS / 1000) + 60;

export function memoryVendorCredentialStore(): VendorCredentialStore {
  const recs = new Map<string, { rec: VendorCredentialRecord; until: number }>();
  const revoked = new Map<string, number>();
  const live = (id: string) => {
    const e = recs.get(id);
    if (e && e.until <= Date.now()) recs.delete(id);
    return recs.get(id)?.rec ?? null;
  };
  return {
    async put(rec, ttlSec) { recs.set(rec.id, { rec, until: Date.now() + ttlSec * 1000 }); },
    async get(id) { return live(id); },
    async del(id) { recs.delete(id); },
    async idsForLease(leaseKey) { return [...recs.keys()].filter((id) => live(id)?.leaseKey === leaseKey); },
    async markLeaseRevoked(leaseKey) { revoked.set(leaseKey, Date.now() + REVOKED_TTL_SEC * 1000); },
    async leaseRevoked(leaseKey) { return (revoked.get(leaseKey) ?? 0) > Date.now(); },
  };
}

const KEY = (id: string) => `foldrun:vendor-egress:cred:${id}`;
const leaseHashOf = (leaseKey: string) => crypto.createHash("sha256").update(leaseKey).digest("hex");
const LEASE_KEY = (leaseKey: string) => `foldrun:vendor-egress:lease:${leaseHashOf(leaseKey)}`;
const REVOKED_KEY = (leaseKey: string) => `foldrun:vendor-egress:revoked:${leaseHashOf(leaseKey)}`;

export function redisVendorCredentialStore(client: () => Promise<{
  set: (...a: (string | number)[]) => Promise<unknown>;
  get: (k: string) => Promise<string | null>;
  del: (...k: string[]) => Promise<unknown>;
  sadd: (k: string, ...m: string[]) => Promise<unknown>;
  smembers: (k: string) => Promise<string[]>;
  srem: (k: string, ...m: string[]) => Promise<unknown>;
  exists: (...k: string[]) => Promise<number>;
  multi: () => { sadd: (k: string, ...m: string[]) => unknown; expire: (k: string, s: number) => unknown; set: (...a: (string | number)[]) => unknown; exec: () => Promise<[Error | null, unknown][] | null> };
} | null>): VendorCredentialStore {
  const c = async () => {
    const r = await client();
    if (!r) throw new VendorCredentialStoreUnavailable("vendor egress: Redis is not reachable");
    return r;
  };
  return {
    async put(rec, ttlSec) {
      // One transaction, the index before the credential: never a live
      // credential its lease's index does not name. The index lives longer
      // than any credential (each save sets it to the longest a credential
      // can live, plus a minute), so a short one never shortens it.
      const r = await c();
      const m = r.multi();
      m.sadd(LEASE_KEY(rec.leaseKey), rec.id);
      m.expire(LEASE_KEY(rec.leaseKey), REVOKED_TTL_SEC);
      m.set(KEY(rec.id), JSON.stringify(rec), "EX", ttlSec);
      const out = await m.exec();
      if (!out || out.some(([err]) => err)) throw new VendorCredentialStoreUnavailable("vendor egress: the credential was not stored");
    },
    async get(id) {
      const raw = await (await c()).get(KEY(id));
      return raw ? (JSON.parse(raw) as VendorCredentialRecord) : null;
    },
    async del(id) {
      const r = await c();
      const raw = await r.get(KEY(id));
      await r.del(KEY(id));
      if (raw) await r.srem(LEASE_KEY((JSON.parse(raw) as VendorCredentialRecord).leaseKey), id);
    },
    async idsForLease(leaseKey) {
      // Only ids whose credential still exists; the expired ones leave the index.
      const r = await c();
      const ids = await r.smembers(LEASE_KEY(leaseKey));
      const live: string[] = [];
      for (const id of ids) {
        if (await r.exists(KEY(id))) live.push(id);
        else await r.srem(LEASE_KEY(leaseKey), id);
      }
      return live;
    },
    async markLeaseRevoked(leaseKey) {
      await (await c()).set(REVOKED_KEY(leaseKey), "1", "EX", REVOKED_TTL_SEC);
    },
    async leaseRevoked(leaseKey) {
      return (await (await c()).exists(REVOKED_KEY(leaseKey))) > 0;
    },
  };
}

let redisStore: VendorCredentialStore | null = null;
let memStore: VendorCredentialStore | null = null;
/** Redis where the install has it (every worker and door see one set),
 *  memory otherwise (one process: tests, a laptop). Asked on every call, so
 *  a process never stays on memory once Redis is configured. */
export function vendorCredentialStore(): VendorCredentialStore {
  if (cacheEnabled()) return (redisStore ??= redisVendorCredentialStore(() => cacheClient() as never));
  return (memStore ??= memoryVendorCredentialStore());
}
