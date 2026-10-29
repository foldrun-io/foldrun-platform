// foldrun as a workload-federation issuer: a step proves who it is to a
// cloud that trusts this install's signature — AWS (AssumeRoleWithWebIdentity),
// Google Cloud (Workload Identity Federation), Microsoft Entra (federated
// credentials) — instead of holding a long-lived key. Nothing provider-specific
// lives here: foldrun signs a standard JWT; the client's own cloud trusts it.
//
// It is a federation issuer, not an OpenID Connect login provider: discovery
// publishes only what workload federation reads (issuer, jwks_uri, the
// id_token response type, public subjects, RS256), and there is no
// authorization endpoint because nobody signs in here.
//
// Off unless FOLDRUN_OIDC_ISSUER names this install's public https address.
// One install key set signs for every account (the install is the trust
// boundary); the signing keys are RSA (Entra supports only RS256), sealed
// under a key derived from the install key with HKDF — apart from every
// account's secrets — and stored as install records. Rotation pre-publishes:
// a new key appears in the JWKS a day before it signs, and an old one stays
// published until every token it signed has expired.
//
// A token lives TOKEN_SECONDS. Subject and claims come from the egress lease,
// which the runner wrote — never from anything the sandbox sends. Stopping a
// step stops renewal; it cannot recall a token already issued, which expires
// on its own (RFC 7519 §4.1.4).

import crypto from "node:crypto";
import path from "node:path";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { oidcSealKey } from "./egress-keys.ts";
import { keyedStore } from "./keyed-store.ts";
import { oidcKeys } from "./schema.ts";

/** How long a minted token lives. Short: renewal is cheap, a leak is brief. */
export const TOKEN_SECONDS = 600;
/** A new key is published this long before it signs (verifier caches). */
export const PREPUBLISH_MS = 24 * 3600_000;
/** An old key stays published this long after a newer one starts signing:
 *  every token it signed has expired by then, with room for clock skew. */
export const RETIRE_AFTER_MS = TOKEN_SECONDS * 1000 + 3600_000;

/**
 * This install's issuer identifier, or null when the feature is off. https,
 * no port, no query or fragment (AWS IAM, OIDC Discovery §3), no trailing
 * slash — it must equal the `iss` in every token, character for character.
 */
export function oidcIssuer(): string | null {
  const raw = process.env.FOLDRUN_OIDC_ISSUER?.trim();
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`FOLDRUN_OIDC_ISSUER is not a URL: ${raw}`);
  }
  if (u.protocol !== "https:" || u.port || u.search || u.hash || u.username || u.password) {
    throw new Error("FOLDRUN_OIDC_ISSUER must be https, with no port, query, fragment or credentials");
  }
  return raw.replace(/\/+$/, "");
}

interface KeyRecord {
  kid: string;
  createdAt: number;
  /** Signs from this moment; published from creation. */
  activeFrom: number;
  /** The private key, PKCS#8 PEM, sealed (sealKey). */
  sealed: string;
  /** The public key as a JWK, with kid, use and alg. */
  publicJwk: { kty: "RSA"; n: string; e: string; kid: string; use: "sig"; alg: "RS256" };
}

const INSTALL = "@install";
const store = keyedStore<KeyRecord>(oidcKeys, () => path.join(dataRoot(), ".oidc-keys.json"));

/** The key that seals signing keys: derived from the install key for this
 *  purpose alone, so it opens nothing else and nothing else opens it. An
 *  egress pod without the install key is given it as FOLDRUN_OIDC_SEAL_KEY
 *  (egress-keys.ts). */
function sealKey(): Buffer {
  return oidcSealKey();
}

/** The tag length is fixed, not taken from the input: a short tag would be
 *  a forgery's easy way in. */
const GCM = { authTagLength: 16 } as const;

function seal(kid: string, pem: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", sealKey(), iv, GCM);
  c.setAAD(Buffer.from(kid)); // bound to its kid: a sealed key cannot be moved to another record
  const enc = Buffer.concat([c.update(pem, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}

function unseal(kid: string, sealed: string): string {
  const raw = Buffer.from(sealed, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", sealKey(), raw.subarray(0, 12), GCM);
  d.setAAD(Buffer.from(kid));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

function newKey(activeFrom: number): KeyRecord {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pub = publicKey.export({ format: "jwk" });
  const kid = crypto.createHash("sha256").update(`${pub.n}.${pub.e}`).digest("base64url").slice(0, 16);
  return {
    kid,
    createdAt: Date.now(),
    activeFrom,
    sealed: seal(kid, privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
    // Public parts only: AWS refuses a JWKS with any private member in it.
    publicJwk: { kty: "RSA", n: String(pub.n), e: String(pub.e), kid, use: "sig", alg: "RS256" },
  };
}

async function allKeys(): Promise<KeyRecord[]> {
  return Object.values(await store.all(INSTALL)).sort((a, b) => a.activeFrom - b.activeFrom || a.kid.localeCompare(b.kid));
}

/** The key that signs now: the newest already active; the first is made on first use. */
async function signingKey(now = Date.now()): Promise<KeyRecord> {
  let keys = await allKeys();
  if (!keys.length) {
    const k = newKey(now);
    await store.put(INSTALL, k.kid, k);
    keys = await allKeys(); // two replicas racing both publish; the order picks one
  }
  const active = keys.filter((k) => k.activeFrom <= now);
  const key = active[active.length - 1];
  // Only an active key signs: one still being pre-published may not be in
  // every verifier's cache yet.
  if (!key) throw new Error("no identity signing key is active yet — try again shortly");
  return key;
}

/** The keys a verifier should know: every one not yet retired. A key is
 *  retired RETIRE_AFTER_MS after a newer one began signing. */
async function publishedKeys(now = Date.now()): Promise<KeyRecord[]> {
  const keys = await allKeys();
  return keys.filter((k, i) => {
    const next = keys.slice(i + 1).find((n) => n.activeFrom <= now);
    return !next || now - next.activeFrom < RETIRE_AFTER_MS;
  });
}

/** Add the next key: published now, signing after PREPUBLISH_MS. Retired
 *  keys are removed from the store. Returns the new kid. */
export async function rotateOidcKey(now = Date.now()): Promise<string> {
  // A store with no key yet gets an active one first: the next key is
  // published a day ahead of a key that already signs, never instead of it.
  await signingKey(now);
  // Retirement is decided on one snapshot, and only its keys can be removed:
  // a key another rotation adds meanwhile is never deleted by this one.
  const snapshot = await allKeys();
  const keep = new Set((await publishedKeys(now)).map((x) => x.kid));
  const k = newKey(now + PREPUBLISH_MS);
  await store.put(INSTALL, k.kid, k);
  for (const old of snapshot) if (!keep.has(old.kid)) await store.remove(INSTALL, old.kid);
  return k.kid;
}

/** GET /.well-known/jwks.json */
export async function oidcJwks(now = Date.now()): Promise<{ keys: KeyRecord["publicJwk"][] }> {
  if (!(await allKeys()).length) await signingKey(now);
  return { keys: (await publishedKeys(now)).map((k) => k.publicJwk) };
}

/** GET /.well-known/openid-configuration — the workload-federation profile. */
export function oidcDiscovery(issuer: string) {
  return {
    issuer,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ["id_token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    claims_supported: ["iss", "sub", "aud", "exp", "iat", "nbf", "jti", "account", "workspace", "agent", "flow", "run_id"],
  };
}

/** Who a token speaks for. Built by the platform from the lease the runner
 *  wrote; never from anything the sandbox sends. */
export interface IdentityContext {
  tenant: string;
  workspace: string;
  agent: string;
  runId: string;
  flow?: string;
}

/** The subject for a workload: account, workspace and agent, each a name the
 *  platform holds, in one fixed order. Within an account, a workspace or
 *  agent recreated under the same name is the same subject: the account is
 *  the boundary a trust policy should pin. */
export function subjectOf(c: Pick<IdentityContext, "tenant" | "workspace" | "agent">): string {
  for (const [what, v] of [["account", c.tenant], ["workspace", c.workspace], ["agent", c.agent]] as const) {
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(v)) throw new Error(`${what} "${v}" cannot be part of a subject`);
  }
  return `account:${c.tenant}:workspace:${c.workspace}:agent:${c.agent}`;
}

const b64url = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");

/** Mint one token for `audience`, signed by the current key. */
export async function mintIdentityToken(c: IdentityContext, audience: string, now = Date.now()): Promise<{ token: string; expiresAt: number }> {
  const issuer = oidcIssuer();
  if (!issuer) throw new Error("this install does not issue identity tokens (FOLDRUN_OIDC_ISSUER is not set)");
  if (!audience?.trim()) throw new Error("an identity token needs an audience");
  const key = await signingKey(now);
  const iat = Math.floor(now / 1000);
  const exp = iat + TOKEN_SECONDS;
  const header = { alg: "RS256", typ: "JWT", kid: key.kid };
  const claims = {
    iss: issuer,
    sub: subjectOf(c),
    aud: audience,
    iat,
    nbf: iat,
    exp,
    jti: crypto.randomUUID(),
    account: c.tenant,
    workspace: c.workspace,
    agent: c.agent,
    run_id: c.runId,
    ...(c.flow ? { flow: c.flow } : {}),
  };
  const unsigned = `${b64url(header)}.${b64url(claims)}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), unseal(key.kid, key.sealed)).toString("base64url");
  return { token: `${unsigned}.${signature}`, expiresAt: exp * 1000 };
}
