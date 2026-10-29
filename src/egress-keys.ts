// The egress proxy's own keys, each for one purpose, so the proxy can run
// without the install's root key (FOLDRUN_SECRET_KEY).
//
// Until 29 Oct 2026 the egress pods held the install key, which opens every
// vault, every account key and every derived token on the install, and used
// it for four narrow things. Each is now a value of its own, derived from the
// install key on the side that has it (the worker, or `--print` below for
// the infra Secret) and handed to egress by itself:
//
//   FOLDRUN_EGRESS_CA_PRK       the egress CA's HKDF pseudo-random key:
//                               HKDF-Extract(salt "foldrun egress ca",
//                               install key). egress-ca.ts expands it to the
//                               same CA key and certificate body the install
//                               key makes.
//   FOLDRUN_OIDC_SEAL_KEY       the key the identity signing keys are sealed
//                               under (oidc-issuer.ts): HKDF(install key,
//                               info "foldrun oidc signing keys v1").
//   FOLDRUN_EGRESS_LEASE_PUBKEY the PUBLIC half of the key the worker signs
//                               every v2 lease with. The private half is
//                               HKDF(install key, info "foldrun egress lease
//                               v1") as an Ed25519 seed and never leaves the
//                               worker.
//
// A v2 lease's grant is sealed under a key derived from the lease token
// itself (the pod presents it on every request; Redis never holds it), so
// opening one needs no account key either.
//
// When a purpose value is in the environment AND the install key is too
// (FOLDRUN_SECRET_KEY — the env only, never a .secret-key file a shared
// volume may hold), they must agree: a CA or seal key that differs from
// what the worker derives is a pod that would sign certificates nobody
// trusts or fail to open every identity key, so it refuses to start.
//
//   node --experimental-strip-types src/egress-keys.ts --print
//     with FOLDRUN_SECRET_KEY set: prints the three values, one per line.

import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { installKeyMaterial } from "../../foldrun-core/src/secrets.ts";

const CA_SALT = "foldrun egress ca";
const OIDC_INFO = "foldrun oidc signing keys v1";
const LEASE_SIGN_INFO = "foldrun egress lease v1";
const GRANT_INFO = "foldrun egress grant v2";
const TOKEN_WRAP_INFO = "foldrun egress lease token wrap v1";
/** What a lease signature covers, ahead of the record: a signature made for
 *  anything else cannot be replayed as one. */
const LEASE_SIG_CONTEXT = "foldrun egress lease v2\0";

// ------------------------------------------------------------------ HKDF

/** HKDF-Extract (RFC 5869 §2.2) for the egress CA: HMAC-SHA256 keyed by the
 *  salt over the install key. What crypto.hkdfSync does first. */
export function caPrkFrom(material: string): Buffer {
  return crypto.createHmac("sha256", CA_SALT).update(Buffer.from(material, "utf8")).digest();
}

/** HKDF-Expand (RFC 5869 §2.3), SHA-256. Node has no expand-only call. */
export function hkdfExpand(prk: Buffer, info: string, length: number): Buffer {
  if (length > 255 * 32) throw new Error("hkdfExpand: too long");
  const blocks: Buffer[] = [];
  let prev = Buffer.alloc(0);
  for (let i = 1, have = 0; have < length; i++) {
    prev = crypto.createHmac("sha256", prk).update(Buffer.concat([prev, Buffer.from(info, "utf8"), Buffer.from([i])])).digest();
    blocks.push(prev);
    have += prev.length;
  }
  return Buffer.concat(blocks).subarray(0, length);
}

export function oidcSealKeyFrom(material: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", material, Buffer.alloc(0), OIDC_INFO, 32));
}

// Ed25519 has no "from seed" call; a PKCS#8 wrapper around the 32-byte seed
// is the standard spelling (RFC 8410 §7).
const ED25519_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");

export function leaseSigningKeyFrom(material: string): crypto.KeyObject {
  const seed = Buffer.from(crypto.hkdfSync("sha256", material, Buffer.alloc(0), LEASE_SIGN_INFO, 32));
  return crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, seed]), format: "der", type: "pkcs8" });
}

/** A lease public key as one line for an env var: base64 SPKI DER. */
export function publicKeyLine(key: crypto.KeyObject): string {
  const pub = key.type === "public" ? key : crypto.createPublicKey(key);
  return pub.export({ type: "spki", format: "der" }).toString("base64");
}

// ------------------------------------------------------------------- env

const envInstallKey = () => process.env.FOLDRUN_SECRET_KEY || null;

function hex32(name: string): Buffer | null {
  const v = process.env[name]?.trim();
  if (!v) return null;
  if (!/^[0-9a-f]{64}$/i.test(v)) throw new Error(`${name} must be 64 hex characters (32 bytes)`);
  return Buffer.from(v, "hex");
}

function disagree(name: string): Error {
  return new Error(
    `${name} does not match the one FOLDRUN_SECRET_KEY derives — refusing to start. ` +
      `Recompute it from the install key (node --experimental-strip-types src/egress-keys.ts --print), or remove one of the two.`,
  );
}

/** Derived values, cached per input: these run per request on the proxy. */
const memo = new Map<string, unknown>();
function cached<T>(key: string, make: () => T): T {
  if (memo.has(key)) return memo.get(key) as T;
  const v = make();
  if (memo.size > 32) memo.clear();
  memo.set(key, v);
  return v;
}
const fp = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** The egress CA's PRK: FOLDRUN_EGRESS_CA_PRK, else from the install key. */
export function egressCaPrk(): Buffer {
  const env = hex32("FOLDRUN_EGRESS_CA_PRK");
  if (!env) {
    const material = installKeyMaterial();
    return cached(`ca:${fp(material)}`, () => caPrkFrom(material));
  }
  const k = envInstallKey();
  if (k && !cached(`ca-agree:${fp(k)}:${env.toString("hex")}`, () => crypto.timingSafeEqual(caPrkFrom(k), env))) throw disagree("FOLDRUN_EGRESS_CA_PRK");
  return env;
}

/** The OIDC seal key: FOLDRUN_OIDC_SEAL_KEY, else from the install key. */
export function oidcSealKey(): Buffer {
  const env = hex32("FOLDRUN_OIDC_SEAL_KEY");
  if (!env) {
    const material = installKeyMaterial();
    return cached(`oidc:${fp(material)}`, () => oidcSealKeyFrom(material));
  }
  const k = envInstallKey();
  if (k && !cached(`oidc-agree:${fp(k)}:${env.toString("hex")}`, () => crypto.timingSafeEqual(oidcSealKeyFrom(k), env))) throw disagree("FOLDRUN_OIDC_SEAL_KEY");
  return env;
}

/** The key the worker signs v2 leases with. Always the install key's: only
 *  a process that holds it writes leases. */
export function leaseSigningKey(): crypto.KeyObject {
  const material = installKeyMaterial();
  return cached(`sign:${fp(material)}`, () => leaseSigningKeyFrom(material));
}

/** The key a v2 lease must verify under: FOLDRUN_EGRESS_LEASE_PUBKEY (base64
 *  SPKI DER, or PEM), else the install key's. */
export function leaseVerifyKey(): crypto.KeyObject {
  const raw = process.env.FOLDRUN_EGRESS_LEASE_PUBKEY?.trim();
  if (!raw) {
    const material = installKeyMaterial();
    return cached(`verify:${fp(material)}`, () => crypto.createPublicKey(leaseSigningKeyFrom(material)));
  }
  const key = cached(`verify-env:${raw}`, () => {
    let k: crypto.KeyObject;
    try {
      k = raw.startsWith("-----BEGIN")
        ? crypto.createPublicKey(raw)
        : crypto.createPublicKey({ key: Buffer.from(raw, "base64"), format: "der", type: "spki" });
    } catch {
      throw new Error("FOLDRUN_EGRESS_LEASE_PUBKEY is not a public key (base64 SPKI DER, or PEM)");
    }
    if (k.asymmetricKeyType !== "ed25519") throw new Error("FOLDRUN_EGRESS_LEASE_PUBKEY must be an Ed25519 public key");
    return k;
  });
  const k = envInstallKey();
  if (k && !cached(`verify-agree:${fp(k)}:${raw}`, () => publicKeyLine(leaseSigningKeyFrom(k)) === publicKeyLine(key))) throw disagree("FOLDRUN_EGRESS_LEASE_PUBKEY");
  return key;
}

/**
 * For the egress role at start: every key it will need, read now, so a
 * missing or disagreeing one stops the pod before it takes traffic rather
 * than failing a step's first call. `minimal` is a pod without the install
 * key: then each purpose value must be in the environment.
 */
export function assertEgressKeys(opts: { minimal: boolean; forward: boolean; oidc: boolean }): void {
  const noRoot = opts.minimal && !envInstallKey();
  if (noRoot) {
    const need = [
      "FOLDRUN_EGRESS_LEASE_PUBKEY",
      ...(opts.forward ? ["FOLDRUN_EGRESS_CA_PRK"] : []),
      ...(opts.oidc ? ["FOLDRUN_OIDC_SEAL_KEY"] : []),
    ].filter((n) => !process.env[n]?.trim());
    if (need.length) throw new Error(`egress without FOLDRUN_SECRET_KEY needs ${need.join(", ")} (src/egress-keys.ts --print computes them)`);
  }
  // Read each one the pod will use: a malformed value, or one that differs
  // from the install key's, throws here.
  leaseVerifyKey();
  if (opts.forward || process.env.FOLDRUN_EGRESS_CA_PRK) egressCaPrk();
  if (opts.oidc || process.env.FOLDRUN_OIDC_SEAL_KEY) oidcSealKey();
}

// ---------------------------------------------------------------- leases

/** Where a v2 lease lives: the SHA-256 of its token, so Redis never holds a
 *  token that would open the lease's door. */
export function leaseId(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/** The key a v2 grant is sealed under: only the holder of the token (the
 *  pod, and the worker that minted it) can derive it. */
function grantKey(token: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", token, Buffer.alloc(0), GRANT_INFO, 32));
}

/** The tag length is fixed, never taken from the input: a short tag is a
 *  forgery's easy way in. */
const GCM = { authTagLength: 16 } as const;

/** AES-256-GCM under the lease token's key, bound to `aad`. base64 of
 *  iv(12) || tag(16) || ciphertext. */
export function sealForLease(token: string, aad: string, plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", grantKey(token), iv, GCM);
  c.setAAD(Buffer.from(aad, "utf8"));
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}

/** The plain text, or null when it will not open (wrong token, moved to
 *  another lease, tampered with). */
export function openForLease(token: string, aad: string, sealed: string): string | null {
  try {
    const raw = Buffer.from(sealed, "base64");
    if (raw.length < 28) return null;
    const d = crypto.createDecipheriv("aes-256-gcm", grantKey(token), raw.subarray(0, 12), GCM);
    d.setAAD(Buffer.from(aad, "utf8"));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** The key a v2 lease's token is wrapped under for the worker: derived from
 *  the install key, which an egress pod without it cannot derive. A worker
 *  that took a run over from one that stopped opens the token with it, and
 *  through the token the rotation record the proxy keeps for that lease. */
function tokenWrapKey(): Buffer {
  const material = installKeyMaterial();
  return cached(`wrap:${fp(material)}`, () => Buffer.from(crypto.hkdfSync("sha256", material, Buffer.alloc(0), TOKEN_WRAP_INFO, 32)));
}

/** The token, sealed for any worker (bound to the lease id). */
export function wrapTokenForWorker(token: string, id: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", tokenWrapKey(), iv, GCM);
  c.setAAD(Buffer.from(id, "utf8"));
  const enc = Buffer.concat([c.update(token, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}

/** The token back, on a worker; null when it will not open. */
export function unwrapTokenForWorker(wrapped: string, id: string): string | null {
  try {
    const raw = Buffer.from(wrapped, "base64");
    if (raw.length < 28) return null;
    const d = crypto.createDecipheriv("aes-256-gcm", tokenWrapKey(), raw.subarray(0, 12), GCM);
    d.setAAD(Buffer.from(id, "utf8"));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** The worker's signature over a lease record (the exact stored string). */
export function signLeaseRecord(rec: string): string {
  return crypto.sign(null, Buffer.from(LEASE_SIG_CONTEXT + rec, "utf8"), leaseSigningKey()).toString("base64");
}

/** A released lease's recovery record (egress-proxy.ts keepForRecovery),
 *  signed under its own context: it can never pass for a lease. */
const RECOVERY_SIG_CONTEXT = "foldrun egress recovery v1\0";
export function signRecoveryRecord(rec: string): string {
  return crypto.sign(null, Buffer.from(RECOVERY_SIG_CONTEXT + rec, "utf8"), leaseSigningKey()).toString("base64");
}
export function verifyRecoveryRecord(rec: string, sig: string): boolean {
  try {
    return crypto.verify(null, Buffer.from(RECOVERY_SIG_CONTEXT + rec, "utf8"), leaseVerifyKey(), Buffer.from(sig, "base64"));
  } catch {
    return false;
  }
}

/** Did the worker sign this record? */
export function verifyLeaseRecord(rec: string, sig: string): boolean {
  try {
    return crypto.verify(null, Buffer.from(LEASE_SIG_CONTEXT + rec, "utf8"), leaseVerifyKey(), Buffer.from(sig, "base64"));
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------- print

/** The three values the egress Secret holds, from one install key. */
export function egressKeyValues(material: string): { FOLDRUN_EGRESS_CA_PRK: string; FOLDRUN_OIDC_SEAL_KEY: string; FOLDRUN_EGRESS_LEASE_PUBKEY: string } {
  return {
    FOLDRUN_EGRESS_CA_PRK: caPrkFrom(material).toString("hex"),
    FOLDRUN_OIDC_SEAL_KEY: oidcSealKeyFrom(material).toString("hex"),
    FOLDRUN_EGRESS_LEASE_PUBKEY: publicKeyLine(leaseSigningKeyFrom(material)),
  };
}

function main(argv: string[]): void {
  if (!argv.includes("--print")) {
    console.error("usage: FOLDRUN_SECRET_KEY=… node --experimental-strip-types src/egress-keys.ts --print");
    process.exit(2);
  }
  // The env only: never read (or, worse, create) a .secret-key file here.
  const material = envInstallKey();
  if (!material) {
    console.error("egress-keys: set FOLDRUN_SECRET_KEY to the install key to derive from");
    process.exit(2);
  }
  for (const [k, v] of Object.entries(egressKeyValues(material))) console.log(`${k}=${v}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2));
