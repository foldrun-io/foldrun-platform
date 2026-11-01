// The OAuth consent flow: click Connect, approve in the provider's screen,
// and the refresh token lands in the vault — nobody copies tokens by hand.
//
// What stays with the account is the OAuth *client* (id + secret): that is
// unavoidable — a consent screen belongs to a registered app — so presets
// fill in every provider URL and the user brings the two values from their
// provider's console. The hosted platform can ship its own registered
// clients later by the same mechanism; nothing here is per-provider code.
//
// Shape: start() parks a pending consent (ten-minute TTL) holding the
// client config — its secret encrypted — keyed by an unguessable nonce: a row
// with a database, a 0600 file without one, and hands back the provider's
// authorize URL with that nonce as `state`. The callback trades the code for
// tokens, stores the result — an auto-refreshing oauth2 secret when the
// provider returned a refresh token, a static one when it only issues
// long-lived access tokens (GitHub) — and takes the pending consent, once. The
// nonce is the callback's whole authority: single-use, expiring, and bound
// to the tenant that started the flow.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { setSecret, setOAuth2Secret, SECRET_NAME, encryptValue, decryptValue } from "../../foldrun-core/src/secrets.ts";
import { oauthTokenRequest, readTokenResponse, type TokenAuth, type TokenResponse } from "../../foldrun-core/src/oauth-token.ts";
import { startDeviceAuthorization, pollDeviceToken } from "../../foldrun-core/src/oauth-device.ts";
import { generateDpopKey, dpopProof, dpopNonceFor, noteDpopNonce } from "../../foldrun-core/src/oauth-dpop.ts";
import type { AssertionAlg } from "../../foldrun-core/src/oauth-assertion.ts";
import { isSecureUrl } from "../../foldrun-core/src/oauth-discovery.ts";
import { databaseEnabled } from "./db.ts";
import { putOAuthPendingDb, takeOAuthPendingDb, peekOAuthPendingDb } from "./short-lived-db.ts";
import { rememberConnection } from "./oauth-connections.ts";
import { fetchPublic } from "./ssrf.ts";
import { oauthBefore, revokeReplaced, type OAuthRevokeResult } from "./oauth-revoke.ts";

export interface OAuthProviderConfig {
  authorize_url: string;
  token_url: string;
  client_id: string;
  /** Empty for a public app (no secret), which then needs PKCE. */
  client_secret: string;
  scopes: string;
  /** Extra authorize-URL params (Google: access_type=offline&prompt=consent).
   *  Never the ones the flow itself sets (RESERVED_PARAMS). */
  authorize_extra?: Record<string, string>;
  /** PKCE (RFC 7636, S256). On unless false; false only for an app with a
   *  secret whose provider refuses the parameters (RFC 9700 §2.1.1). */
  pkce?: boolean;
  /** The authorization server's issuer identifier. When set, the callback's
   *  `iss` (RFC 9207) must be present and equal it; unset, an `iss` that comes
   *  back must at least be the authorize URL's origin. */
  issuer?: string;
  /** How the client authenticates at the token endpoint — client_secret_post
   *  (absent: the form body), client_secret_basic, or none (a public app).
   *  Notion, Spotify, Reddit and Zoom take Basic only (core oauth-token.ts). */
  token_auth?: TokenAuth;
  /** Whether the server sends `iss` with every authorization response
   *  (RFC 9207 metadata). With an issuer set: true or absent, a callback
   *  without `iss` is refused; false (discovered, not advertised), a missing
   *  `iss` is accepted and a present one must still match. */
  iss_parameter?: boolean;
  /** The provider's revocation endpoint (RFC 7009): a deleted or replaced
   *  connection's tokens are revoked there. */
  revocation_url?: string;
  /** The device authorization endpoint (RFC 8628), for `--device`. */
  device_url?: string;
  /** The pushed authorization request endpoint (RFC 9126); with it the
   *  authorize parameters are sent there first. */
  par_url?: string;
  /** token_auth private_key_jwt: the private key (PEM or JWK) — sealed when
   *  parked or saved, like the client secret — its kid, alg, and the
   *  certificate when the provider names keys by it (core oauth-assertion.ts). */
  client_assertion_key?: string;
  client_assertion_kid?: string;
  client_assertion_alg?: AssertionAlg;
  client_assertion_cert?: string;
  /** DPoP (RFC 9449): each connection gets its own key at the code exchange,
   *  and its tokens are bound to it (core oauth-dpop.ts). */
  dpop?: boolean;
  /** tls_client_auth (RFC 8705): the client certificate and key — the key
   *  sealed when parked or saved, like a secret. */
  tls_client_cert?: string;
  tls_client_key?: string;
  tls_client_passphrase?: string;
}

/** The client certificate an app authenticates with, as fetchPublic takes it. */
function certOf(config: OAuthProviderConfig) {
  if (!config.tls_client_cert || !config.tls_client_key) return undefined;
  // A pool per certificate: never one client's connection for another's.
  // Keyed on the certificate AND its key: knowing a certificate never reuses
  // another client's connection, which holds its key (Codex review).
  const fp = crypto.createHash("sha256").update(`${config.tls_client_cert}\n${config.tls_client_key}`).digest("hex");
  return { pool: `oauth-mtls:${fp}`, identity: fp, cert: config.tls_client_cert, key: config.tls_client_key, ...(config.tls_client_passphrase ? { passphrase: config.tls_client_passphrase } : {}) };
}

export { RESERVED_PARAMS, clientConfigProblem } from "./oauth-params.ts";
import { RESERVED_PARAMS, clientConfigProblem } from "./oauth-params.ts";

// Presets live in core so the CLI's `foldrun connect` and this callback read
// one list; re-exported here for the routes that already import it from us.
export { OAUTH_PRESETS } from "../../foldrun-core/src/oauth-presets.ts";

interface Pending {
  tenant: string;
  name: string;
  workspace?: string;
  config: OAuthProviderConfig;
  createdAt: number;
  /** PKCE code_verifier, sent with the code (sealed while parked). */
  verifier?: string;
  /** SHA-256 of the browser binding cookie the start set: the callback
   *  must come back to the browser that started (RFC 9700 §2.1). */
  binding?: string;
  /** The hand-off this consent was accepted from: used up when it completes. */
  handoff?: string;
}

/** A CLI-started consent waiting for a signed-in person to accept it in the
 *  browser (the hand-off page) before any provider is asked. */
export interface Handoff {
  kind: "handoff";
  tenant: string;
  client: string;
  name: string;
  workspace?: string;
  scopes?: string;
  by: string;
  createdAt: number;
}

const TTL_MS = 10 * 60 * 1000;

const pendingDir = () => path.join(dataRoot(), ".oauth-pending");

function pendingFile(nonce: string) {
  if (!/^[a-f0-9]{48}$/.test(nonce)) throw new Error("malformed state");
  return path.join(pendingDir(), `${nonce}.json`);
}

/** What is parked: the config with its client secret encrypted, never in the clear. */
type Parked = Omit<Pending, "config" | "verifier"> & {
  config: Omit<OAuthProviderConfig, "client_secret" | "client_assertion_key" | "tls_client_key" | "tls_client_passphrase"> & { client_secret: ReturnType<typeof encryptValue>; client_assertion_key?: ReturnType<typeof encryptValue>; tls_client_key?: ReturnType<typeof encryptValue>; tls_client_passphrase?: ReturnType<typeof encryptValue> };
  verifier?: ReturnType<typeof encryptValue>;
};

async function savePending(nonce: string, p: Pending): Promise<void> {
  const { verifier, ...rest } = p;
  const { client_assertion_key: _key, tls_client_key: _tk, tls_client_passphrase: _tp, ...plain } = p.config;
  const parked: Parked = {
    ...rest,
    config: {
      ...plain,
      client_secret: encryptValue(p.tenant, p.config.client_secret),
      // Signing and certificate keys are credentials like the secret: never parked in the clear.
      ...(p.config.client_assertion_key ? { client_assertion_key: encryptValue(p.tenant, p.config.client_assertion_key) } : {}),
      ...(p.config.tls_client_key ? { tls_client_key: encryptValue(p.tenant, p.config.tls_client_key) } : {}),
      ...(p.config.tls_client_passphrase ? { tls_client_passphrase: encryptValue(p.tenant, p.config.tls_client_passphrase) } : {}),
    },
    ...(verifier ? { verifier: encryptValue(p.tenant, verifier) } : {}),
  };
  await park(nonce, p.tenant, parked as unknown as Record<string, unknown>, p.createdAt);
}

async function park(nonce: string, tenant: string, payload: Record<string, unknown>, createdAt: number): Promise<void> {
  if (databaseEnabled()) {
    await putOAuthPendingDb(nonce, tenant, payload, new Date(createdAt + TTL_MS));
    return;
  }
  writeParked(nonce, payload);
}

/** Park a record only if none has its id: false when one already does. */
async function parkOnce(nonce: string, tenant: string, payload: Record<string, unknown>, createdAt: number): Promise<boolean> {
  if (databaseEnabled()) {
    try {
      await putOAuthPendingDb(nonce, tenant, payload, new Date(createdAt + TTL_MS));
      return true;
    } catch {
      return false; // the id is taken: someone claimed first
    }
  }
  fs.mkdirSync(pendingDir(), { recursive: true });
  try {
    fs.writeFileSync(pendingFile(nonce), JSON.stringify(payload), { mode: 0o600, flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function writeParked(nonce: string, parked: Record<string, unknown>): void {
  // Sweep the stale while we're here — a pending consent someone abandoned
  // should not sit on disk for longer than its ten minutes.
  if (fs.existsSync(pendingDir())) {
    for (const f of fs.readdirSync(pendingDir())) {
      try {
        const old = JSON.parse(fs.readFileSync(path.join(pendingDir(), f), "utf8")) as Pending;
        if (Date.now() - old.createdAt > TTL_MS) fs.rmSync(path.join(pendingDir(), f), { force: true });
      } catch {
        fs.rmSync(path.join(pendingDir(), f), { force: true });
      }
    }
  }
  fs.mkdirSync(pendingDir(), { recursive: true });
  fs.writeFileSync(pendingFile(nonce), JSON.stringify(parked), { mode: 0o600 });
}

/** Take a parked record: whoever asks second gets null. */
async function takeParked(nonce: string): Promise<Record<string, unknown> | null> {
  if (databaseEnabled()) {
    pendingFile(nonce); // the same shape check as the file path
    const got = await takeOAuthPendingDb(nonce);
    return got ? got.payload : null;
  }
  const file = pendingFile(nonce);
  if (!fs.existsSync(file)) return null;
  const parked = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  fs.rmSync(file, { force: true });
  return parked;
}

/** Read a parked record without taking it (the hand-off page shows it first). */
async function peekParked(nonce: string): Promise<Record<string, unknown> | null> {
  if (databaseEnabled()) {
    pendingFile(nonce);
    const got = await peekOAuthPendingDb(nonce);
    return got && !got.expired ? got.payload : null;
  }
  const file = pendingFile(nonce);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

/** Take a parked consent: whoever asks second gets null; a hand-off is not one. */
async function takePending(nonce: string): Promise<Pending | null> {
  // Look before taking: only a consent is one. A hand-off's or a claim's id
  // used as a state must not use the record up (a claim's id can be worked
  // out from its hand-off's).
  const seen = await peekParked(nonce);
  if (!seen || seen.kind !== undefined) return null;
  const raw = await takeParked(nonce);
  if (!raw || raw.kind !== undefined) return null;
  const parked = raw as unknown as Parked;
  // A consent parked before 2026-09-24 carries its secret in the clear.
  const sealed = parked.config.client_secret as unknown;
  const secret = typeof sealed === "string" ? sealed : decryptValue(parked.tenant, sealed as ReturnType<typeof encryptValue>);
  if (secret === null) return null;
  const verifier = parked.verifier ? decryptValue(parked.tenant, parked.verifier) : undefined;
  if (verifier === null) return null;
  const open = (v: ReturnType<typeof encryptValue> | undefined) => (v ? decryptValue(parked.tenant, v) : undefined);
  const key = open(parked.config.client_assertion_key);
  const tlsKey = open(parked.config.tls_client_key);
  const tlsPass = open(parked.config.tls_client_passphrase);
  if (key === null || tlsKey === null || tlsPass === null) return null;
  return { ...parked, config: { ...parked.config, client_secret: secret, ...(key ? { client_assertion_key: key } : {}), ...(tlsKey ? { tls_client_key: tlsKey } : {}), ...(tlsPass ? { tls_client_passphrase: tlsPass } : {}) }, ...(verifier ? { verifier } : {}) } as Pending;
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** A new browser binding: the cookie value to set, and its hash to park. */
export function newBinding(): { cookie: string; hash: string } {
  const cookie = crypto.randomBytes(32).toString("base64url");
  return { cookie, hash: sha256(cookie) };
}

/** Park a CLI-started consent for a signed-in person to accept. */
export async function parkHandoff(h: Omit<Handoff, "kind" | "createdAt">): Promise<string> {
  if (!SECRET_NAME.test(h.name)) throw new Error(`secret name "${h.name}" must be UPPER_SNAKE_CASE`);
  const id = crypto.randomBytes(24).toString("hex");
  const rec: Handoff = { ...h, kind: "handoff", createdAt: Date.now() };
  await park(id, h.tenant, rec as unknown as Record<string, unknown>, rec.createdAt);
  return id;
}

/** The hand-off, for the page to show; null when gone, expired or not one. */
export async function peekHandoff(id: string): Promise<Handoff | null> {
  if (!/^[a-f0-9]{48}$/.test(id)) return null;
  const raw = await peekParked(id);
  if (!raw || raw.kind !== "handoff") return null;
  const h = raw as unknown as Handoff;
  return Date.now() - h.createdAt > TTL_MS ? null : h;
}

/** Use the hand-off once (the person pressed Accept). */
export async function takeHandoff(id: string): Promise<Handoff | null> {
  if (!/^[a-f0-9]{48}$/.test(id)) return null;
  const raw = await takeParked(id);
  if (!raw || raw.kind !== "handoff") return null;
  const h = raw as unknown as Handoff;
  return Date.now() - h.createdAt > TTL_MS ? null : h;
}

/** Begin a consent flow. Returns where to send the browser. */
export async function startOAuthConnect(
  tenant: string,
  name: string,
  config: OAuthProviderConfig,
  redirectUri: string,
  workspace?: string,
  /** The hash of the browser binding cookie (newBinding): the callback must
   *  bring the same cookie back. Absent only for a flow with no browser of
   *  its own to bind (tests, the CLI's local loopback flow). */
  binding?: string,
  /** The hand-off being accepted, if any: it stays until a consent from it
   *  completes, so a lost answer to Accept can be retried. */
  handoff?: string,
): Promise<{ url: string; nonce: string }> {
  if (!SECRET_NAME.test(name)) throw new Error(`secret name "${name}" must be UPPER_SNAKE_CASE`);
  for (const field of ["authorize_url", "token_url", "client_id"] as const) {
    if (!config[field]?.trim()) throw new Error(`oauth connect needs ${field}`);
  }
  const problem = clientConfigProblem(config);
  if (problem) throw new Error(problem);
  // https, or a server on this machine (loopback), as token_url may be.
  if (!isSecureUrl(config.authorize_url)) throw new Error("authorize_url must be https");

  const nonce = crypto.randomBytes(24).toString("hex");
  // RFC 7636: 32 random bytes as an unpadded base64url verifier (43 chars),
  // and its S256 challenge.
  const verifier = config.pkce === false ? undefined : crypto.randomBytes(32).toString("base64url");
  await savePending(nonce, { tenant, name, workspace, config, createdAt: Date.now(), ...(verifier ? { verifier } : {}), ...(binding ? { binding } : {}), ...(handoff ? { handoff } : {}) });

  const url = new URL(config.authorize_url);
  // Extras first, so nothing they (or the authorize URL's own query) say
  // about the flow's parameters survives what the flow sets after them.
  for (const [k, v] of Object.entries(config.authorize_extra ?? {})) url.searchParams.set(k, v);
  for (const k of RESERVED_PARAMS) url.searchParams.delete(k);
  url.searchParams.set("client_id", config.client_id);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  if (config.scopes.trim()) url.searchParams.set("scope", config.scopes.trim());
  url.searchParams.set("state", nonce);
  if (verifier) {
    url.searchParams.set("code_challenge", crypto.createHash("sha256").update(verifier).digest("base64url"));
    url.searchParams.set("code_challenge_method", "S256");
  }
  if (config.par_url) return { url: await pushAuthorizationRequest(config, url, new URL(config.authorize_url)), nonce };
  return { url: url.href, nonce };
}

/**
 * PAR (RFC 9126): the authorize parameters go to the provider's pushed
 * authorization request endpoint first, client-authenticated as at the token
 * URL, and the browser carries only client_id and the request_uri it gave
 * back — nothing for the browser or its history to alter or leak. Used
 * whenever the app has a par_url (discovery keeps it), which a provider that
 * requires PAR needs and every other one accepts.
 */
async function pushAuthorizationRequest(config: OAuthProviderConfig, built: URL, endpoint: URL): Promise<string> {
  // A signed assertion's aud: the issuer when known (RFC 9126 §2 and FAPI
  // name it), else the token URL — both are the authorization server's.
  const request = oauthTokenRequest(config, Object.fromEntries(built.searchParams), { clientIdInBody: true, audience: config.issuer ?? config.token_url });
  const cert = certOf(config);
  const res = await fetchPublic(config.par_url!, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  }, cert ? { clientCert: cert } : {});
  const answer = (await res.json().catch(() => ({}))) as { request_uri?: unknown; error?: string; error_description?: string };
  if (!res.ok || typeof answer.request_uri !== "string" || !answer.request_uri) {
    throw new Error(`the provider refused the pushed authorization request (${res.status}): ${answer.error_description ?? answer.error ?? "no request_uri in the reply"}`);
  }
  // The authorize URL as configured — its own query may route the request
  // (a tenant, a policy) — with the flow's parameters replaced by these two.
  const url = endpoint;
  for (const k of RESERVED_PARAMS) url.searchParams.delete(k);
  url.searchParams.set("client_id", config.client_id);
  url.searchParams.set("request_uri", answer.request_uri);
  return url.href;
}

export interface ConnectResult {
  tenant: string;
  name: string;
  workspace?: string;
  /** How it was stored: auto-refreshing, or static (no refresh token issued). */
  stored: "oauth2" | "static";
  /** A reconnect replaced an oauth2 secret: what revoking the old grant at
   *  the provider came to (RFC 7009). Absent when nothing was replaced. */
  revoked?: OAuthRevokeResult;
}

/** The callback: trade the code for tokens and store the secret. */
export async function completeOAuthConnect(
  nonce: string,
  code: string,
  redirectUri: string,
  /** What came back with the code: the binding cookie the start set, and the
   *  provider's `iss` (RFC 9207) when it sent one. */
  back: { binding?: string; iss?: string | null } = {},
): Promise<ConnectResult> {
  const pending = await takePending(nonce); // single-use, before any network
  if (!pending) throw new Error("this connect link expired or was already used — start again");
  if (Date.now() - pending.createdAt > TTL_MS) {
    throw new Error("this connect link expired — start again");
  }
  // The consent must come back to the browser that started it: a code that
  // arrives in another browser (a link sent to someone else) is refused.
  if (pending.binding && (!back.binding || sha256(back.binding) !== pending.binding)) {
    throw new Error("this connect was started in another browser — start it again here");
  }
  // Mix-up defence: the code must come from the server the flow went to.
  const iss = back.iss ?? null;
  if (pending.config.issuer) {
    // A server that does not advertise RFC 9207 (discovered with
    // iss_parameter false) may leave `iss` out; one it sends must match.
    const mayOmit = pending.config.iss_parameter === false && iss === null;
    if (!mayOmit && iss !== pending.config.issuer) throw new Error(`the provider answered as ${iss ?? "nobody"} — expected ${pending.config.issuer}`);
  } else if (iss !== null) {
    // Unpinned: an issuer may carry a path (a Keycloak realm), so only its
    // site is compared — it must be the server the consent was sent to.
    let origin: string | null = null;
    try {
      origin = new URL(iss).origin;
    } catch {
      origin = null;
    }
    if (origin !== new URL(pending.config.authorize_url).origin) {
      throw new Error(`the provider answered as ${iss} — not the server this connect went to`);
    }
  }
  // A consent accepted from a hand-off claims it, once, before anything is
  // stored: a retried Accept leaves more than one consent pointing at it, and
  // only the first to come back may write the secret. The claim is its own
  // record, so a hand-off that expired after it was accepted does not refuse
  // a consent still within its own ten minutes; the hand-off goes with it.
  if (pending.handoff) {
    const claim = crypto.createHash("sha256").update(`claim:${pending.handoff}`).digest("hex").slice(0, 48);
    const now = Date.now();
    // createdAt: the file store's sweep expires a record by it.
    if (!(await parkOnce(claim, pending.tenant, { kind: "claim", createdAt: now }, now))) {
      throw new Error("this connection was already completed from another try — nothing more to do");
    }
    try {
      const result = await exchangeAndStore(pending, code, redirectUri);
      // Stored: the hand-off is done with. Until then it stays, so a failed
      // exchange can be tried again from it.
      await takeHandoff(pending.handoff).catch(() => null);
      return result;
    } catch (err) {
      await takeParked(claim).catch(() => null); // release the claim for another try
      throw err;
    }
  }
  return exchangeAndStore(pending, code, redirectUri);
}

/** Trade the code for tokens and store the secret. */
async function exchangeAndStore(pending: Pending, code: string, redirectUri: string): Promise<ConnectResult> {
  // The one token-request builder (core oauth-token.ts): the secret goes in
  // the body or a Basic header as the app's token_auth says.
  // DPoP: this connection's own key, made now; its tokens are bound to it.
  const dpopKey = pending.config.dpop ? generateDpopKey() : undefined;
  const cert = certOf(pending.config);
  const tokenUrl = pending.config.token_url;
  let res!: Response;
  let text = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    // Built per try: a signed assertion's jti and a DPoP proof are good once.
    const request = oauthTokenRequest(pending.config, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      ...(pending.verifier ? { code_verifier: pending.verifier } : {}),
    }, { audience: tokenUrl });
    const nonce = dpopKey ? dpopNonceFor(tokenUrl, dpopKey) : undefined;
    res = await fetchPublic(tokenUrl, {
      method: "POST",
      headers: dpopKey ? { ...request.headers, dpop: dpopProof(dpopKey, { htm: "POST", htu: tokenUrl, ...(nonce ? { nonce } : {}) }) } : request.headers,
      body: request.body,
      signal: AbortSignal.timeout(15_000),
      // The request carries the client secret: it goes to the token URL the
      // tenant configured or nowhere, never on to wherever a 307 points.
      redirect: "error",
    }, cert ? { clientCert: cert } : {});
    text = await res.text().catch(() => "");
    if (!dpopKey) break;
    noteDpopNonce(tokenUrl, res, dpopKey);
    // The server wants a nonce in the proof (RFC 9449 §8): once more, with it.
    if (attempt === 0 && res.status === 400 && res.headers.get("dpop-nonce") && readTokenResponse(text, res.headers.get("content-type") ?? "").error === "use_dpop_nonce") continue;
    break;
  }
  // JSON or form-encoded, Slack's nested user token, expires_in as a string.
  const payload = readTokenResponse(text, res.headers.get("content-type") ?? "");
  if (!res.ok || (!payload.refresh_token && !payload.access_token)) {
    throw new Error(
      `the provider refused the exchange (${res.status}): ${payload.error_description ?? payload.error ?? "no tokens in the reply"}`,
    );
  }
  return storeGrant(pending, payload, dpopKey);
}

/** Store what a provider granted — a consent's code exchange or an approved
 *  device code — as the connection's secret, the same way for both. */
async function storeGrant(pending: Pick<Pending, "tenant" | "name" | "workspace" | "config">, payload: TokenResponse, dpopKey?: string): Promise<ConnectResult> {
  // A DPoP- or certificate-bound token is useless without its key, and only
  // a refreshing recipe carries one: refused, not stored unusable (Codex review).
  // DPoP asked for, Bearer given: the server ignored the proof, and a DPoP
  // connection would send its token in a form no resource accepts (Codex review).
  if (dpopKey && (payload.token_type ?? "").toLowerCase() !== "dpop") {
    throw new Error(`the provider answered with a ${payload.token_type ?? "untyped"} token, not a DPoP one — it does not do DPoP for this app; connect without DPoP`);
  }
  if (!payload.refresh_token && (dpopKey || certOf(pending.config))) {
    throw new Error("the provider issued no refresh token — a DPoP- or certificate-bound connection needs one (ask for offline access, or connect without DPoP)");
  }
  // What this replaces, read before the write: its tokens are revoked once
  // the new grant is stored, so a reconnect leaves no live grant behind.
  const before = oauthBefore(pending.tenant, pending.name, pending.workspace);

  if (payload.refresh_token) {
    setOAuth2Secret(
      pending.tenant,
      pending.name,
      {
        token_url: pending.config.token_url,
        client_id: pending.config.client_id,
        ...(pending.config.client_secret ? { client_secret: pending.config.client_secret } : {}),
        refresh_token: payload.refresh_token,
        ...(pending.config.token_auth ? { token_auth: pending.config.token_auth } : {}),
        ...(pending.config.revocation_url ? { revocation_url: pending.config.revocation_url } : {}),
        ...(pending.config.client_assertion_key ? {
          client_assertion_key: pending.config.client_assertion_key,
          ...(pending.config.client_assertion_kid ? { client_assertion_kid: pending.config.client_assertion_kid } : {}),
          ...(pending.config.client_assertion_alg ? { client_assertion_alg: pending.config.client_assertion_alg } : {}),
          ...(pending.config.client_assertion_cert ? { client_assertion_cert: pending.config.client_assertion_cert } : {}),
        } : {}),
        ...(dpopKey ? { dpop_key: dpopKey } : {}),
        ...(pending.config.tls_client_cert && pending.config.tls_client_key ? {
          tls_client_cert: pending.config.tls_client_cert,
          tls_client_key: pending.config.tls_client_key,
          ...(pending.config.tls_client_passphrase ? { tls_client_passphrase: pending.config.tls_client_passphrase } : {}),
        } : {}),
        ...(Object.keys(payload.fields).length ? { fields: payload.fields } : {}),
      },
      pending.workspace,
    );
    // Keep the client beside the secret, so the next reconnect is one click.
    await rememberConnection(pending.tenant, pending.name, pending.workspace, pending.config, {
      refreshExpiresIn: payload.refresh_token_expires_in,
    });
    const revoked = await revokeReplaced(pending.tenant, pending.name, pending.workspace, before, pending.config);
    return { tenant: pending.tenant, name: pending.name, workspace: pending.workspace, stored: "oauth2", ...(revoked ? { revoked } : {}) };
  }

  // No refresh token — a provider whose access tokens live long (GitHub).
  // A static secret is the honest representation of that.
  setSecret(pending.tenant, pending.name, payload.access_token!, pending.workspace);
  // Which app made it, and at what scopes: Reconnect needs both.
  await rememberConnection(pending.tenant, pending.name, pending.workspace, pending.config);
  const revoked = await revokeReplaced(pending.tenant, pending.name, pending.workspace, before, pending.config);
  return { tenant: pending.tenant, name: pending.name, workspace: pending.workspace, stored: "static", ...(revoked ? { revoked } : {}) };
}

// ---------------------------------------------------------------- device

/** A device authorization waiting for a person (RFC 8628), parked like a
 *  consent: the device code and the app's credentials sealed. */
interface ParkedDevice {
  kind: "device";
  tenant: string;
  name: string;
  workspace?: string;
  config: Parked["config"];
  device_code: ReturnType<typeof encryptValue>;
  code_verifier: ReturnType<typeof encryptValue>;
  expiresAt: number;
  createdAt: number;
}

export interface DeviceStarted {
  id: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  /** Seconds before the code runs out (at most the ten minutes a parked
   *  consent lives). */
  expires_in: number;
  /** Seconds between polls. */
  interval: number;
}

/** Ask the provider for a device code for a saved app; park it. */
export async function startDeviceConnect(tenant: string, name: string, config: OAuthProviderConfig, workspace?: string): Promise<DeviceStarted> {
  if (!SECRET_NAME.test(name)) throw new Error(`secret name "${name}" must be UPPER_SNAKE_CASE`);
  if (!config.device_url) throw new Error("this app has no device authorization endpoint — Discover it from the issuer, or give device_url");
  if (config.dpop) throw new Error("connecting with a code is not supported for a DPoP app — connect with the browser instead");
  if (!isSecureUrl(config.device_url)) throw new Error("device_url must be https");
  const problem = clientConfigProblem({ ...config, pkce: true });
  if (problem) throw new Error(problem);
  const cert = certOf(config);
  const started = await startDeviceAuthorization({ ...config, device_url: config.device_url }, config.scopes, (u, init) => fetchPublic(u, init, { maxBytes: 64 * 1024, ...(cert ? { clientCert: cert } : {}) }), config.authorize_extra ?? {});
  const id = crypto.randomBytes(24).toString("hex");
  const now = Date.now();
  const expiresIn = Math.min(started.expires_in, TTL_MS / 1000);
  const { client_assertion_key: _key, tls_client_key: _tk, tls_client_passphrase: _tp, ...plain } = config;
  const parked: ParkedDevice = {
    kind: "device",
    tenant,
    name,
    ...(workspace ? { workspace } : {}),
    config: {
      ...plain,
      client_secret: encryptValue(tenant, config.client_secret),
      ...(config.client_assertion_key ? { client_assertion_key: encryptValue(tenant, config.client_assertion_key) } : {}),
      ...(config.tls_client_key ? { tls_client_key: encryptValue(tenant, config.tls_client_key) } : {}),
      ...(config.tls_client_passphrase ? { tls_client_passphrase: encryptValue(tenant, config.tls_client_passphrase) } : {}),
    },
    device_code: encryptValue(tenant, started.device_code),
    code_verifier: encryptValue(tenant, started.code_verifier),
    expiresAt: now + expiresIn * 1000,
    createdAt: now,
  };
  await park(id, tenant, parked as unknown as Record<string, unknown>, now);
  return {
    id,
    user_code: started.user_code,
    verification_uri: started.verification_uri,
    ...(started.verification_uri_complete ? { verification_uri_complete: started.verification_uri_complete } : {}),
    expires_in: expiresIn,
    interval: started.interval,
  };
}

export type DevicePollResult =
  | { status: "pending"; interval?: number }
  | { status: "slow_down" }
  | ({ status: "connected" } & ConnectResult)
  | { status: "denied" | "expired"; reason: string };

/**
 * One poll of a parked device authorization: one token request. Approved, the
 * grant is stored exactly as a consent's would be and the parked code used
 * up; denied or expired, it is used up and said. Nothing else is written, so
 * a poll is safe to repeat at the interval the provider asks for.
 */
export async function pollDeviceConnect(tenant: string, id: string): Promise<DevicePollResult> {
  if (!/^[a-f0-9]{48}$/.test(id)) throw new Error("no such device authorization");
  const seen = await peekDevice(id);
  if (!seen || seen.rec.kind !== "device" || seen.rec.tenant !== tenant) throw new Error("no such device authorization — it was used, ran out, or is another account's");
  // Ran out: said as the terminal answer it is, before any lock — taking the
  // lock sweeps expired rows, and a database read hides them (Codex review).
  if (seen.expired || Date.now() > (seen.rec as unknown as ParkedDevice).expiresAt) {
    await takeParked(id).catch(() => null);
    return { status: "expired", reason: "the code ran out before anyone approved it" };
  }
  // One poll at a time: the one holding the lock talks to the provider, so a
  // second poll can never use the record up while an approved answer is on
  // its way (Codex review). Others are told to wait.
  const lock = crypto.createHash("sha256").update(`device-lock:${id}`).digest("hex").slice(0, 48);
  const owner = crypto.randomBytes(12).toString("hex");
  const now = Date.now();
  if (!(await parkOnce(lock, tenant, { kind: "claim", owner, createdAt: now }, now))) {
    // A lease, not a lock forever: one left by a process that died mid-poll
    // (a poll takes at most the 15-second token request) is taken over. Two
    // polls taking over the same dead lease at once can both ask the
    // provider; that loses nothing — a device code's tokens are handed out
    // once, so at most one stores the grant and the other gets the
    // provider's error (Codex review: accepted, not made atomic).
    const held = await peekParked(lock);
    if (!held || now - Number(held.createdAt ?? 0) < DEVICE_LEASE_MS) return { status: "pending" };
    await takeParked(lock).catch(() => null);
    if (!(await parkOnce(lock, tenant, { kind: "claim", owner, createdAt: now }, now))) return { status: "pending" };
  }
  try {
    // Read again under the lock: another poll may have used it up between
    // the first read and taking the lock (Codex review).
    const fresh = await peekDevice(id);
    if (!fresh || fresh.rec.kind !== "device" || fresh.rec.tenant !== tenant) throw new Error("no such device authorization — it was used, ran out, or is another account's");
    if (fresh.expired) return { status: "expired", reason: "the code ran out before anyone approved it" };
    return await pollLocked(tenant, id, fresh.rec as unknown as ParkedDevice);
  } finally {
    // Released only by its owner: a lease taken over is the new holder's.
    const held = await peekParked(lock).catch(() => null);
    if (held?.owner === owner) await takeParked(lock).catch(() => null);
  }
}

/** How long a device poll's lease holds before another poll may take it. */
const DEVICE_LEASE_MS = 30_000;

/** A parked device authorization, expired or not (a database read of the
 *  usual kind hides an expired row; a device poll must say "expired"). */
async function peekDevice(id: string): Promise<{ rec: Record<string, unknown>; expired: boolean } | null> {
  if (databaseEnabled()) {
    const got = await peekOAuthPendingDb(id);
    return got ? { rec: got.payload, expired: got.expired } : null;
  }
  const rec = await peekParked(id);
  return rec ? { rec, expired: false } : null;
}

async function pollLocked(tenant: string, id: string, d: ParkedDevice): Promise<DevicePollResult> {
  if (Date.now() > d.expiresAt) {
    await takeParked(id).catch(() => null);
    return { status: "expired", reason: "the code ran out before anyone approved it" };
  }
  const secret = decryptValue(tenant, d.config.client_secret as ReturnType<typeof encryptValue>);
  const deviceCode = decryptValue(tenant, d.device_code);
  const verifier = d.code_verifier ? decryptValue(tenant, d.code_verifier) : undefined;
  const key = d.config.client_assertion_key ? decryptValue(tenant, d.config.client_assertion_key) : undefined;
  const tlsKey = d.config.tls_client_key ? decryptValue(tenant, d.config.tls_client_key) : undefined;
  const tlsPass = d.config.tls_client_passphrase ? decryptValue(tenant, d.config.tls_client_passphrase) : undefined;
  if (secret === null || deviceCode === null || key === null || verifier === null || tlsKey === null || tlsPass === null) throw new Error("the parked device authorization cannot be opened");
  const config: OAuthProviderConfig = { ...d.config, client_secret: secret, ...(key ? { client_assertion_key: key } : {}), ...(tlsKey ? { tls_client_key: tlsKey } : {}), ...(tlsPass ? { tls_client_passphrase: tlsPass } : {}) } as OAuthProviderConfig;
  const cert = certOf(config);
  const poll = await pollDeviceToken(config, deviceCode, (u, init) => fetchPublic(u, init, { maxBytes: 64 * 1024, ...(cert ? { clientCert: cert } : {}) }), verifier);
  if (poll.status === "pending") return { status: "pending" };
  if (poll.status === "slow_down") return { status: "slow_down" };
  // Approved, denied or expired: the code is used up — by this poll, which
  // holds the lock.
  await takeParked(id);
  if (poll.status === "approved") {
    const stored = await storeGrant({ tenant, name: d.name, workspace: d.workspace, config }, poll.token);
    return { status: "connected", ...stored };
  }
  return { status: poll.status, reason: poll.reason };
}
