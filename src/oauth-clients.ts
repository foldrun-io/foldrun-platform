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
): Promise<void> {
  if (!CLIENT_NAME.test(name)) throw new Error(`client name "${name}" — kebab-case only`);
  for (const field of ["authorize_url", "token_url", "client_id"] as const) {
    if (!config[field]?.trim()) throw new Error(`an OAuth client needs ${field}`);
  }
  // No secret is a public app: allowed, with PKCE (RFC 9700 §2.1.1).
  const problem = clientConfigProblem(config);
  if (problem) throw new Error(problem);
  if (!/^https:\/\//.test(config.authorize_url)) throw new Error("authorize_url must be https");
  if (config.issuer !== undefined && (!/^https:\/\/[^?#]+$/.test(config.issuer))) throw new Error("issuer must be an https URL with no query or fragment");
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
    createdAt: new Date().toISOString(),
  });
}

/** Metadata only — the client_secret never comes back out through a list. */
export async function listOAuthClients(
  tenant: string,
): Promise<Omit<OAuthClientRecord, "client_secret">[]> {
  return Object.values(await store.all(tenant))
    .map(({ client_secret: _secret, ...rest }) => rest)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The full config, decrypted — for starting a consent flow, nothing else. */
export async function getOAuthClient(tenant: string, name: string): Promise<OAuthProviderConfig | null> {
  const rec = await store.get(tenant, name);
  if (!rec) return null;
  const secret = decryptValue(tenant, rec.client_secret);
  if (secret === null) return null; // key rotated away from under it
  return {
    authorize_url: rec.authorize_url,
    token_url: rec.token_url,
    client_id: rec.client_id,
    client_secret: secret,
    scopes: rec.scopes,
    authorize_extra: rec.authorize_extra,
    ...(rec.pkce === false ? { pkce: false } : {}),
    ...(rec.issuer ? { issuer: rec.issuer } : {}),
  };
}

export async function deleteOAuthClient(tenant: string, name: string): Promise<boolean> {
  return store.remove(tenant, name);
}
