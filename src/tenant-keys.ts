// One encryption key per account.
//
// Every account's vault used to be encrypted with the same key: masterKey()
// took no tenant argument, so FOLDRUN_SECRET_KEY opened all of them. One leak
// was total, and rotating for a single customer meant rotating for everybody.
//
// Envelope encryption fixes the shape. Each account gets a random data key; the
// data key is stored encrypted under the install key. The install key alone no
// longer opens anything — it opens the keys, which are in Postgres, while the
// secrets they protect are on the data volume. A stolen copy of either half is
// not a compromise.
//
// PRELOADED AT BOOT, on purpose. Fetching a key is a query, and the secrets API
// is synchronous and called from everywhere; making it async would push a third
// await cascade through the one code path where a mistake makes data
// undecryptable. Loading every key once at startup keeps the lookup a Map read.

import crypto from "node:crypto";
import { KMSClient, EncryptCommand, DecryptCommand } from "@aws-sdk/client-kms";
import { orm, databaseEnabled } from "./db.ts";
import { tenantKeys } from "./schema.ts";
import { and, eq } from "drizzle-orm";

/** The full 16-byte tag, or an error — see core/src/secrets.ts for why a
 *  GCM decipher must be told the tag length it expects. */
const GCM = { authTagLength: 16 } as const;

/** tenant → data key. Populated by loadTenantKeys(), read synchronously. */
const keys = new Map<string, Buffer>();

// ------------------------------------------------------------- the root key
//
// What protects the thing that protects everything. Every key manager has this
// problem; the difference between the options is only where it is answered.
//
//   env   FOLDRUN_SECRET_KEY, hashed. The root key is a VALUE, so it exists
//         anywhere that value lands: /etc/foldrun/env, the k8s Secret, the pod
//         environment, and — until the backup was sealed — every archive.
//
//   kms   A cloud KMS. The root key is never a value anyone can hold: you send
//         ciphertext and get plaintext back. On EC2 the instance's IAM role
//         means there is no credential to store at all, which is the part
//         self-hosting structurally cannot match. It also brings an audit line
//         per decrypt and revocation without re-encrypting anything.
//
// Both are implemented. FOLDRUN_ROOT_KEY picks which one wraps NEW keys:
// `env` (the default) or `kms`, with FOLDRUN_KMS_KEY_ID naming the key (an id,
// ARN or alias). Every wrapped key carries a PREFIX naming the provider that
// sealed it, so a half-migrated install reads correctly and accounts move one
// at a time (rewrapTenantKeys). The KMS client takes its endpoint from
// AWS_ENDPOINT_URL_KMS when set — the box runs local-kms, which speaks the
// same API — and its credentials from the standard chain (a pod role in AWS,
// so nothing is stored). Each account's key is bound to the account with an
// encryption context: KMS refuses to open one account's key under another's
// name, so a wrapped key cannot be swapped between rows.
const ENV_PREFIX = "env:";

function installKey(): Buffer {
  const fromEnv = process.env.FOLDRUN_SECRET_KEY;
  if (!fromEnv) throw new Error("FOLDRUN_SECRET_KEY is required to wrap an account key");
  return crypto.createHash("sha256").update(fromEnv).digest();
}

const KMS_PREFIX = "kms:";

/** The provider new keys are wrapped with. */
export function rootKeyProvider(): "env" | "kms" {
  const p = (process.env.FOLDRUN_ROOT_KEY ?? "env").toLowerCase();
  if (p !== "env" && p !== "kms") throw new Error(`FOLDRUN_ROOT_KEY must be env or kms, not "${p}"`);
  return p;
}

let kmsClient: KMSClient | null = null;
function kms(): KMSClient {
  // Region and endpoint from the environment (AWS_REGION, AWS_ENDPOINT_URL_KMS).
  kmsClient ??= new KMSClient({});
  return kmsClient;
}

function kmsKeyId(): string {
  const id = process.env.FOLDRUN_KMS_KEY_ID;
  if (!id) throw new Error("FOLDRUN_ROOT_KEY=kms needs FOLDRUN_KMS_KEY_ID (a key id, ARN or alias)");
  return id;
}

/** What binds a wrapped key to its account: KMS will not decrypt it under another. */
const contextFor = (tenant: string) => ({ purpose: "foldrun-account-key", tenant });

function wrapEnv(dataKey: Buffer): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", installKey(), iv, GCM);
  const enc = Buffer.concat([c.update(dataKey), c.final()]);
  return ENV_PREFIX + Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}

function unwrapEnv(body: string): Buffer {
  const raw = Buffer.from(body, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", installKey(), raw.subarray(0, 12), GCM);
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
}

async function wrap(tenant: string, dataKey: Buffer, provider = rootKeyProvider()): Promise<string> {
  if (provider === "env") return wrapEnv(dataKey);
  const out = await kms().send(new EncryptCommand({ KeyId: kmsKeyId(), Plaintext: dataKey, EncryptionContext: contextFor(tenant) }));
  if (!out.CiphertextBlob) throw new Error("KMS returned no ciphertext");
  return KMS_PREFIX + Buffer.from(out.CiphertextBlob).toString("base64");
}

async function unwrap(tenant: string, wrapped: string): Promise<Buffer> {
  // An unprefixed blob predates the provider seam and is env-wrapped. Same
  // rule as the secret records: absence means the original, so nothing written
  // before this has to be migrated before it can be read.
  const provider = wrappedBy(wrapped);
  const body = wrapped.includes(":") ? wrapped.slice(wrapped.indexOf(":") + 1) : wrapped;
  if (provider === "env") return unwrapEnv(body);
  if (provider === "kms") {
    // The key id is inside the ciphertext; the context must match the account.
    const out = await kms().send(new DecryptCommand({ CiphertextBlob: Buffer.from(body, "base64"), EncryptionContext: contextFor(tenant) }));
    if (!out.Plaintext) throw new Error("KMS returned no plaintext");
    return Buffer.from(out.Plaintext);
  }
  throw new Error(`account key is sealed by the "${provider}" root-key provider, which this build cannot open`);
}

/** Which provider sealed a stored key — for an operator asking what is where. */
export function wrappedBy(wrapped: string): string {
  const i = wrapped.indexOf(":");
  return i === -1 ? "env" : wrapped.slice(0, i);
}

/** Every account key, unwrapped into memory. Called once at boot. */
export async function loadTenantKeys(): Promise<number> {
  const q = orm();
  if (!q) return 0;
  const rows = await q.select({ tenant: tenantKeys.tenant, wrapped: tenantKeys.wrapped }).from(tenantKeys);
  for (const r of rows) {
    try {
      keys.set(r.tenant, await unwrap(r.tenant, r.wrapped));
    } catch (err) {
      // Wrapped under a different root key — the account is unreadable
      // until that key comes back. Loudly absent beats silently wrong: with no
      // key in the map, its secrets fall back to the install key and fail to
      // decrypt, which is what actually happened rather than a plausible lie.
      console.error(`[keys] cannot unwrap the key for ${r.tenant} (${wrappedBy(r.wrapped)}): ${err instanceof Error ? err.message : err}`);
    }
  }
  return keys.size;
}

/** Mint a key for an account that has none. Idempotent across replicas. */
export async function ensureTenantKey(tenant: string): Promise<boolean> {
  const q = orm();
  if (!q) return false;
  if (keys.has(tenant)) return false;
  const fresh = crypto.randomBytes(32);
  const rows = await q
    .insert(tenantKeys)
    .values({ tenant, wrapped: await wrap(tenant, fresh) })
    .onConflictDoNothing({ target: tenantKeys.tenant })
    .returning({ wrapped: tenantKeys.wrapped });
  if (rows[0]) {
    keys.set(tenant, fresh);
    return true;
  }
  // Another replica won the insert; take theirs so both agree.
  const existing = await q.select({ wrapped: tenantKeys.wrapped }).from(tenantKeys).where(eq(tenantKeys.tenant, tenant));
  if (existing[0]) keys.set(tenant, await unwrap(tenant, existing[0].wrapped));
  return false;
}

/**
 * The account's key, or null when this install has none — no database, or an
 * account whose key has not been minted yet. Null means "use the install key",
 * which is what every record written before this existed is encrypted with.
 */
export function tenantKey(tenant: string): Buffer | null {
  const own = keys.get(tenant);
  // A miss on an install with a database is most likely an account minted
  // by ANOTHER replica since this one loaded its keys — a signup on pod A
  // that pod B has never heard of. Nothing here can wait (the secrets API
  // is synchronous), so the answer stays "install key" this once and a
  // reload is scheduled; the next call finds the key. Debounced, so a
  // burst of misses for one unknown name is one query.
  if (!own && databaseEnabled()) refreshTenantKeysSoon();
  return own ?? null;
}

let refreshTimer: NodeJS.Timeout | null = null;
let refreshInterval: NodeJS.Timeout | null = null;
const REFRESH_DEBOUNCE_MS = 2_000;

/** Reload every account key shortly — coalesced, never more than one in flight. */
export function refreshTenantKeysSoon(): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    loadTenantKeys().catch((err) => console.error("[keys] reload failed:", err instanceof Error ? err.message : err));
  }, REFRESH_DEBOUNCE_MS);
  refreshTimer.unref?.();
}

/**
 * Keep replicas converged: reload the keys on a timer, so an account minted
 * on one pod is known to every pod within `everyMs` even if nothing on this
 * pod asked for it. Idempotent; returns a stop function for tests.
 */
export function startTenantKeyRefresh(everyMs = 5 * 60_000): () => void {
  if (!refreshInterval && databaseEnabled()) {
    refreshInterval = setInterval(() => {
      loadTenantKeys().catch((err) => console.error("[keys] periodic reload failed:", err instanceof Error ? err.message : err));
    }, everyMs);
    refreshInterval.unref?.();
  }
  return () => {
    if (refreshInterval) clearInterval(refreshInterval);
    refreshInterval = null;
  };
}

export function tenantKeysEnabled(): boolean {
  return databaseEnabled();
}

/**
 * Destroy an account's key. This is the shred.
 *
 * Every secret that account ever had is AES-GCM ciphertext under this key, and
 * the key exists in exactly one place. Delete it and the ciphertext is inert
 * everywhere at once — including inside the fourteen nightly archives and the
 * copies in R2, which no delete-my-data routine could ever reach into and
 * scrub. That is the only honest answer to an erasure request once backups
 * exist, and it only works because the keys were separated per account before
 * there was more than one.
 *
 * Irreversible by construction. There is no second copy to recover from.
 */
export async function destroyTenantKey(tenant: string): Promise<boolean> {
  const q = orm();
  if (!q) return false;
  const gone = await q.delete(tenantKeys).where(eq(tenantKeys.tenant, tenant)).returning({ tenant: tenantKeys.tenant });
  keys.delete(tenant);
  return gone.length > 0;
}

/**
 * Move every account key to the current root-key provider — env to kms when
 * FOLDRUN_ROOT_KEY=kms. Only the small keys move: each is unwrapped with the
 * provider that sealed it and wrapped again with the new one; no secret is
 * re-encrypted. The write is a compare-and-set on the old value, so two pods
 * doing this at once cannot both move one key. Returns how many moved and
 * which accounts could not be opened (their old root key is missing).
 */
export async function rewrapTenantKeys(): Promise<{ moved: number; unreadable: string[] }> {
  const q = orm();
  if (!q) return { moved: 0, unreadable: [] };
  const target = rootKeyProvider();
  const rows = await q.select({ tenant: tenantKeys.tenant, wrapped: tenantKeys.wrapped }).from(tenantKeys);
  let moved = 0;
  const unreadable: string[] = [];
  for (const r of rows) {
    if (wrappedBy(r.wrapped) === target) continue;
    let dataKey: Buffer;
    try {
      dataKey = await unwrap(r.tenant, r.wrapped);
    } catch {
      unreadable.push(r.tenant);
      continue;
    }
    const next = await wrap(r.tenant, dataKey, target);
    const got = await q
      .update(tenantKeys)
      .set({ wrapped: next, rotatedAt: new Date() })
      .where(and(eq(tenantKeys.tenant, r.tenant), eq(tenantKeys.wrapped, r.wrapped)))
      .returning({ tenant: tenantKeys.tenant });
    if (got.length) moved++;
    keys.set(r.tenant, dataKey);
  }
  return { moved, unreadable };
}

/** For tests and for the rewrap: forget what is cached. */
export function forgetTenantKeys(): void {
  keys.clear();
}
