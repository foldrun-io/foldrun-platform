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
import { databaseEnabled } from "./db.ts";
import { putOAuthPendingDb, takeOAuthPendingDb, peekOAuthPendingDb } from "./short-lived-db.ts";
import { rememberConnection } from "./oauth-connections.ts";
import { fetchPublic } from "./ssrf.ts";

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
  config: Omit<OAuthProviderConfig, "client_secret"> & { client_secret: ReturnType<typeof encryptValue> };
  verifier?: ReturnType<typeof encryptValue>;
};

async function savePending(nonce: string, p: Pending): Promise<void> {
  const { verifier, ...rest } = p;
  const parked: Parked = {
    ...rest,
    config: { ...p.config, client_secret: encryptValue(p.tenant, p.config.client_secret) },
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
  return { ...parked, config: { ...parked.config, client_secret: secret }, ...(verifier ? { verifier } : {}) } as Pending;
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
  if (!/^https:\/\//.test(config.authorize_url)) throw new Error("authorize_url must be https");

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
  return { url: url.href, nonce };
}

export interface ConnectResult {
  tenant: string;
  name: string;
  workspace?: string;
  /** How it was stored: auto-refreshing, or static (no refresh token issued). */
  stored: "oauth2" | "static";
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
    if (iss !== pending.config.issuer) throw new Error(`the provider answered as ${iss ?? "nobody"} — expected ${pending.config.issuer}`);
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
  const res = await fetchPublic(pending.config.token_url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: pending.config.client_id,
      ...(pending.config.client_secret ? { client_secret: pending.config.client_secret } : {}),
      ...(pending.verifier ? { code_verifier: pending.verifier } : {}),
    }).toString(),
    signal: AbortSignal.timeout(15_000),
    // The body carries the client secret: it goes to the token URL the
    // tenant configured or nowhere, never on to wherever a 307 points.
    redirect: "error",
  });
  const payload = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    refresh_token_expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || (!payload.refresh_token && !payload.access_token)) {
    throw new Error(
      `the provider refused the exchange (${res.status}): ${payload.error_description ?? payload.error ?? "no tokens in the reply"}`,
    );
  }

  if (payload.refresh_token) {
    setOAuth2Secret(
      pending.tenant,
      pending.name,
      {
        token_url: pending.config.token_url,
        client_id: pending.config.client_id,
        ...(pending.config.client_secret ? { client_secret: pending.config.client_secret } : {}),
        refresh_token: payload.refresh_token,
      },
      pending.workspace,
    );
    // Keep the client beside the secret, so the next reconnect is one click.
    await rememberConnection(pending.tenant, pending.name, pending.workspace, pending.config, {
      refreshExpiresIn: payload.refresh_token_expires_in,
    });
    return { tenant: pending.tenant, name: pending.name, workspace: pending.workspace, stored: "oauth2" };
  }

  // No refresh token — a provider whose access tokens live long (GitHub).
  // A static secret is the honest representation of that.
  setSecret(pending.tenant, pending.name, payload.access_token!, pending.workspace);
  // Which app made it, and at what scopes: Reconnect needs both.
  await rememberConnection(pending.tenant, pending.name, pending.workspace, pending.config);
  return { tenant: pending.tenant, name: pending.name, workspace: pending.workspace, stored: "static" };
}
