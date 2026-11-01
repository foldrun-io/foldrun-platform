// Saved OAuth clients — the user's own registered apps, as first-class
// things. The platform supplies none: every record here began as someone
// pasting the client id and secret from their provider's console. Once
// saved, a client can run the consent flow any number of times — first
// connect, re-consent after a revocation, a second secret with different
// scopes — which is the whole reason it is worth saving.
//
//   data/<tenant>/oauth-clients.json    client_secret encrypted, 0600

import path from "node:path";
import { accountDir } from "../../foldrun-core/src/store.ts";
import { encryptValue, decryptValue } from "../../foldrun-core/src/secrets.ts";
import { keyedStore } from "./keyed-store.ts";
import { oauthClients } from "./schema.ts";
import type { OAuthProviderConfig } from "./oauth-connect.ts";
import { clientConfigProblem } from "./oauth-params.ts";
import type { TokenAuth } from "../../foldrun-core/src/oauth-token.ts";
import { isSecureUrl, issuerProblem } from "../../foldrun-core/src/oauth-discovery.ts";
import { generateClientKey, publicJwkOf, type AssertionAlg } from "../../foldrun-core/src/oauth-assertion.ts";

export interface OAuthClientRecord {
  name: string; // kebab-case identity, e.g. "google-ads"
  authorize_url: string;
  token_url: string;
  client_id: string;
  client_secret: { iv: string; tag: string; data: string };
  scopes: string;
  authorize_extra?: Record<string, string>;
  /** PKCE: on unless false (oauth-connect.ts). */
  pkce?: boolean;
  /** The authorization server's issuer, checked against the callback's `iss`. */
  issuer?: string;
  /** How it authenticates at the token endpoint; absent is the form body. */
  token_auth?: TokenAuth;
  /** From discovery (oauth-connect.ts OAuthProviderConfig). */
  iss_parameter?: boolean;
  revocation_url?: string;
  device_url?: string;
  par_url?: string;
  /** token_auth private_key_jwt: the private key sealed like the secret, and
   *  the public JWK (not secret) the provider registers — listed. */
  client_assertion_key?: { iv: string; tag: string; data: string };
  client_assertion_kid?: string;
  client_assertion_alg?: AssertionAlg;
  client_assertion_cert?: string;
  public_jwk?: Record<string, unknown>;
  /** DPoP-bound tokens for every connection made from it. */
  dpop?: boolean;
  /** tls_client_auth: the certificate (not secret, listed) and its key and
   *  passphrase sealed. */
  tls_client_cert?: string;
  tls_client_key?: { iv: string; tag: string; data: string };
  tls_client_passphrase?: { iv: string; tag: string; data: string };
  createdAt: string;
}

const CLIENT_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// A row per client in `oauth_clients` with a database; the account's
// oauth-clients.json (0600) without one.
export const oauthClientFile = (tenant: string) => path.join(accountDir(tenant), "oauth-clients.json");
const store = keyedStore<OAuthClientRecord>(oauthClients, oauthClientFile);

export async function saveOAuthClient(
  tenant: string,
  name: string,
  config: OAuthProviderConfig,
  /** generateKey: token_auth private_key_jwt with no key given — make one
   *  (EC P-256) and keep it; the answer's publicJwk is what the provider
   *  registers. */
  opts: { generateKey?: boolean } = {},
): Promise<{ publicJwk?: Record<string, unknown> }> {
  if (!CLIENT_NAME.test(name)) throw new Error(`client name "${name}" — kebab-case only`);
  if (config.token_auth === "private_key_jwt" && !config.client_assertion_key?.trim() && opts.generateKey) {
    const made = generateClientKey("ES256");
    config = { ...config, client_assertion_key: made.privateKey, client_assertion_kid: made.publicJwk.kid, client_assertion_alg: made.publicJwk.alg };
  }
  for (const field of ["authorize_url", "token_url", "client_id"] as const) {
    if (!config[field]?.trim()) throw new Error(`an OAuth client needs ${field}`);
  }
  // No secret is a public app: allowed, with PKCE (RFC 9700 §2.1.1).
  const problem = clientConfigProblem(config);
  if (problem) throw new Error(problem);
  // https, or a server on this machine (loopback), as token_url may be.
  if (!isSecureUrl(config.authorize_url)) throw new Error("authorize_url must be https");
  // https (or loopback), no query or fragment: the same rule discovery holds an issuer to.
  if (config.issuer !== undefined && (typeof config.issuer !== "string" || issuerProblem(config.issuer))) throw new Error("issuer must be an https URL with no query or fragment");
  for (const k of ["revocation_url", "device_url", "par_url"] as const) {
    // https, or loopback (a provider on this machine), as token_url may be.
    if (config[k] !== undefined && (typeof config[k] !== "string" || !isSecureUrl(config[k]!))) throw new Error(`${k} must be https`);
  }
  if (config.iss_parameter !== undefined && typeof config.iss_parameter !== "boolean") throw new Error("iss_parameter is true or false");
  // The public half of a signing key, shown wherever the app is listed.
  const publicJwk = config.token_auth === "private_key_jwt" && config.client_assertion_key
    ? publicJwkOf(config.client_assertion_key, { ...(config.client_assertion_kid ? { kid: config.client_assertion_kid } : {}), ...(config.client_assertion_alg ? { alg: config.client_assertion_alg } : {}) }) as Record<string, unknown>
    : undefined;
  await store.put(tenant, name, {
    name,
    authorize_url: config.authorize_url,
    token_url: config.token_url,
    client_id: config.client_id,
    client_secret: encryptValue(tenant, config.client_secret ?? ""),
    scopes: config.scopes ?? "",
    ...(config.authorize_extra ? { authorize_extra: config.authorize_extra } : {}),
    ...(config.pkce === false ? { pkce: false } : {}),
    ...(config.issuer ? { issuer: config.issuer } : {}),
    ...(config.token_auth ? { token_auth: config.token_auth } : {}),
    ...(typeof config.iss_parameter === "boolean" ? { iss_parameter: config.iss_parameter } : {}),
    ...(config.revocation_url ? { revocation_url: config.revocation_url } : {}),
    ...(config.device_url ? { device_url: config.device_url } : {}),
    ...(config.par_url ? { par_url: config.par_url } : {}),
    ...(publicJwk ? {
      client_assertion_key: encryptValue(tenant, config.client_assertion_key!),
      ...(config.client_assertion_kid ? { client_assertion_kid: config.client_assertion_kid } : {}),
      ...(config.client_assertion_alg ? { client_assertion_alg: config.client_assertion_alg } : {}),
      ...(config.client_assertion_cert ? { client_assertion_cert: config.client_assertion_cert } : {}),
      public_jwk: publicJwk,
    } : {}),
    ...(config.dpop === true ? { dpop: true } : {}),
    ...(config.tls_client_cert && config.tls_client_key ? {
      tls_client_cert: config.tls_client_cert,
      tls_client_key: encryptValue(tenant, config.tls_client_key),
      ...(config.tls_client_passphrase ? { tls_client_passphrase: encryptValue(tenant, config.tls_client_passphrase) } : {}),
    } : {}),
    createdAt: new Date().toISOString(),
  });
  return publicJwk ? { publicJwk } : {};
}

/** Metadata only — the client_secret never comes back out through a list. */
export async function listOAuthClients(
  tenant: string,
): Promise<Omit<OAuthClientRecord, "client_secret" | "client_assertion_key" | "tls_client_key" | "tls_client_passphrase">[]> {
  // Neither credential comes out, sealed or not; the public JWK does.
  return Object.values(await store.all(tenant))
    .map(({ client_secret: _secret, client_assertion_key: _key, tls_client_key: _tk, tls_client_passphrase: _tp, ...rest }) => rest)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The full config, decrypted — for starting a consent flow, nothing else. */
export async function getOAuthClient(tenant: string, name: string): Promise<OAuthProviderConfig | null> {
  const rec = await store.get(tenant, name);
  if (!rec) return null;
  const secret = decryptValue(tenant, rec.client_secret);
  if (secret === null) return null; // key rotated away from under it
  const assertionKey = rec.client_assertion_key ? decryptValue(tenant, rec.client_assertion_key) : undefined;
  const tlsKey = rec.tls_client_key ? decryptValue(tenant, rec.tls_client_key) : undefined;
  const tlsPass = rec.tls_client_passphrase ? decryptValue(tenant, rec.tls_client_passphrase) : undefined;
  if (assertionKey === null || tlsKey === null || tlsPass === null) return null;
  return {
    authorize_url: rec.authorize_url,
    token_url: rec.token_url,
    client_id: rec.client_id,
    client_secret: secret,
    scopes: rec.scopes,
    authorize_extra: rec.authorize_extra,
    ...(rec.pkce === false ? { pkce: false } : {}),
    ...(rec.issuer ? { issuer: rec.issuer } : {}),
    ...(rec.token_auth ? { token_auth: rec.token_auth } : {}),
    ...(typeof rec.iss_parameter === "boolean" ? { iss_parameter: rec.iss_parameter } : {}),
    ...(rec.revocation_url ? { revocation_url: rec.revocation_url } : {}),
    ...(rec.device_url ? { device_url: rec.device_url } : {}),
    ...(rec.par_url ? { par_url: rec.par_url } : {}),
    ...(assertionKey ? {
      client_assertion_key: assertionKey,
      ...(rec.client_assertion_kid ? { client_assertion_kid: rec.client_assertion_kid } : {}),
      ...(rec.client_assertion_alg ? { client_assertion_alg: rec.client_assertion_alg } : {}),
      ...(rec.client_assertion_cert ? { client_assertion_cert: rec.client_assertion_cert } : {}),
    } : {}),
    ...(rec.dpop ? { dpop: true } : {}),
    ...(rec.tls_client_cert && tlsKey ? { tls_client_cert: rec.tls_client_cert, tls_client_key: tlsKey, ...(tlsPass ? { tls_client_passphrase: tlsPass } : {}) } : {}),
  };
}

export async function deleteOAuthClient(tenant: string, name: string): Promise<boolean> {
  return store.remove(tenant, name);
}
