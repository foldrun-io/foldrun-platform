// The OAuth client against a real authorization server: Keycloak, one realm,
// one client per variant, the consent driven headlessly. The proof behind the
// "supported" client rows of core src/oauth-capabilities.ts.
//
//   KEYCLOAK_URL=http://127.0.0.1:18080 KEYCLOAK_ADMIN_PASSWORD=… \
//     node --test tests/e2e-oauth-keycloak.test.ts
//
// Skipped without KEYCLOAK_URL. `scripts/oauth-conformance.sh` starts a
// throwaway Keycloak (pinned image), runs this, and removes it — what the box
// CI runner does before a promotion. Not part of `npm test` (e2e).

import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const KC = process.env.KEYCLOAK_URL?.replace(/\/+$/, "");
const ADMIN_PW = process.env.KEYCLOAK_ADMIN_PASSWORD ?? "";
const skip = !KC ? "KEYCLOAK_URL not set — scripts/oauth-conformance.sh runs this against a throwaway Keycloak" : false;

process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-kc-"));
// Keycloak listens on loopback; the SSRF guard refuses that otherwise.
process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE = "1";
fs.mkdirSync(path.join(process.env.FOLDRUN_DATA, "acme/workspaces/desk"), { recursive: true });

const { startOAuthConnect, completeOAuthConnect } = await import("../src/oauth-connect.ts");
const { saveOAuthClient, getOAuthClient } = await import("../src/oauth-clients.ts");
const { discoverOAuth } = await import("../../foldrun-core/src/oauth-discovery.ts");
const { resolveSecrets, materializeSecrets, oauth2ValueAt, revokeOAuth2Value, setOAuth2Secret, setTokenExchangeSecret } = await import("../../foldrun-core/src/secrets.ts");
const { fetchPublic } = await import("../src/ssrf.ts");
const { generateClientKey } = await import("../../foldrun-core/src/oauth-assertion.ts");
// private_key_jwt: a key foldrun makes, whose public JWK Keycloak is given.
const SIGNING = generateClientKey("ES256");

const REALM = `foldrun-${crypto.randomBytes(3).toString("hex")}`;
const ISSUER = `${KC}/realms/${REALM}`;
const REDIRECT = "http://127.0.0.1:3900/api/oauth/callback";
const USER = { username: "ana", password: crypto.randomBytes(12).toString("base64url") };

// ------------------------------------------------------------ Keycloak admin

let adminToken = "";
async function admin(method: string, p: string, body?: unknown): Promise<Response> {
  const res = await fetch(`${KC}/admin/realms${p}`, {
    method,
    headers: { authorization: `Bearer ${adminToken}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok && res.status !== 409) throw new Error(`Keycloak admin ${method} ${p}: ${res.status} ${await res.text()}`);
  return res;
}

interface KcClient { clientId: string; secret?: string; attributes?: Record<string, string>; publicClient?: boolean; standardFlowEnabled?: boolean; serviceAccountsEnabled?: boolean; clientAuthenticatorType?: string }
async function client(c: KcClient): Promise<string> {
  await admin("POST", `/${REALM}/clients`, {
    clientId: c.clientId,
    enabled: true,
    protocol: "openid-connect",
    publicClient: c.publicClient ?? false,
    standardFlowEnabled: c.standardFlowEnabled ?? true,
    serviceAccountsEnabled: c.serviceAccountsEnabled ?? false,
    directAccessGrantsEnabled: false,
    redirectUris: [REDIRECT],
    clientAuthenticatorType: c.clientAuthenticatorType ?? "client-secret",
    ...(c.secret ? { secret: c.secret } : {}),
    attributes: { "pkce.code.challenge.method": "S256", ...(c.attributes ?? {}) },
  });
  return c.secret ?? "";
}

before(async () => {
  if (skip) return;
  const t = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: "admin", password: ADMIN_PW }),
  });
  adminToken = ((await t.json()) as { access_token: string }).access_token;
  assert.ok(adminToken, "Keycloak admin sign-in");
  // revokeRefreshToken: each refresh token works once and a new one comes
  // back — rotation enforced, so a dropped rotation fails the next refresh.
  await admin("POST", "", { realm: REALM, enabled: true, accessTokenLifespan: 300, revokeRefreshToken: true, refreshTokenMaxReuse: 0 });
  await admin("POST", `/${REALM}/users`, {
    username: USER.username, enabled: true, email: "ana@acme.test", emailVerified: true, firstName: "Ana", lastName: "Test",
    credentials: [{ type: "password", value: USER.password, temporary: false }],
  });
  await client({ clientId: "secret-app", secret: "secret-app-shh" });
  await client({ clientId: "public-app", publicClient: true });
  await client({ clientId: "device-app", publicClient: true, standardFlowEnabled: false, attributes: { "oauth2.device.authorization.grant.enabled": "true" } });
  // Token exchange (RFC 8693, Keycloak's standard v2): a subject client whose
  // tokens name exchange-app in their audience, and exchange-app allowed to exchange.
  const subjectId = await (async () => {
    await client({ clientId: "subject-app", secret: "subject-shh", serviceAccountsEnabled: true, standardFlowEnabled: false });
    const [c] = (await (await admin("GET", `/${REALM}/clients?clientId=subject-app`)).json()) as { id: string }[];
    return c.id;
  })();
  await admin("POST", `/${REALM}/clients/${subjectId}/protocol-mappers/models`, { name: "aud-exchange", protocol: "openid-connect", protocolMapper: "oidc-audience-mapper", config: { "included.client.audience": "exchange-app", "access.token.claim": "true" } });
  await client({ clientId: "exchange-app", secret: "exchange-shh", serviceAccountsEnabled: true, standardFlowEnabled: false, attributes: { "standard.token.exchange.enabled": "true" } });
  await client({ clientId: "dpop-app", secret: "dpop-shh", serviceAccountsEnabled: true, attributes: { "dpop.bound.access.tokens": "true" } });
  await client({
    clientId: "mtls-app", clientAuthenticatorType: "client-x509", serviceAccountsEnabled: true, standardFlowEnabled: false,
    attributes: { "x509.subjectdn": "CN=foldrun-client", "x509.casubjectdn": "CN=foldrun-conformance-ca", "x509.allow.regex.pattern.comparison": "false", "tls.client.certificate.bound.access.tokens": "true" },
  });
  await client({
    clientId: "jwt-app", clientAuthenticatorType: "client-jwt", serviceAccountsEnabled: true,
    attributes: { "use.jwks.string": "true", "jwks.string": JSON.stringify({ keys: [SIGNING.publicJwk] }), "token.endpoint.auth.signing.alg": "ES256" },
  });
});

// ------------------------------------------------------------ the person, headless

/** Cookies, as a browser keeps them for one site. */
class Jar {
  private c = new Map<string, string>();
  take(res: Response) {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(";");
      const i = pair.indexOf("=");
      this.c.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  header() { return [...this.c].map(([k, v]) => `${k}=${v}`).join("; "); }
}

/** Open the authorize URL, sign in as the user, and return the redirect back to us. */
async function consent(authorizeUrl: string): Promise<URL> {
  const jar = new Jar();
  let res = await fetch(authorizeUrl, { redirect: "manual" });
  jar.take(res);
  // Keycloak may hop (a 302 within itself) before the sign-in page; one that
  // lands on our redirect URI already is an error answer, said as such.
  for (let hop = 0; res.status >= 300 && res.status < 400 && hop < 5; hop++) {
    const to = new URL(res.headers.get("location")!, authorizeUrl).href;
    if (to.startsWith(REDIRECT)) throw new Error(`Keycloak answered before sign-in: ${to}`);
    res = await fetch(to, { redirect: "manual", headers: { cookie: jar.header() } });
    jar.take(res);
  }
  const html = await res.text();
  const action = html.match(/<form[^>]+id="kc-form-login"[^>]+action="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
  assert.ok(action, `the Keycloak sign-in page (status ${res.status}): ${html.slice(0, 300)}`);
  res = await fetch(action, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: new URLSearchParams({ username: USER.username, password: USER.password, credentialId: "" }),
  });
  const location = res.headers.get("location");
  assert.ok(location && location.startsWith(REDIRECT), `redirected back with a code (status ${res.status}, location ${location})`);
  return new URL(location);
}

async function introspect(token: string, clientId: string, secret: string): Promise<boolean> {
  const res = await fetch(`${ISSUER}/protocol/openid-connect/token/introspect`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}` },
    body: new URLSearchParams({ token }),
  });
  return ((await res.json()) as { active?: boolean }).active === true;
}

/** An access token works where an API would check it: the realm's userinfo
 *  (Keycloak's introspection calls these inactive — its sessions differ). */
async function accessLive(token: string): Promise<boolean> {
  const res = await fetch(`${ISSUER}/protocol/openid-connect/userinfo`, { headers: { authorization: `Bearer ${token}` } });
  await res.body?.cancel();
  return res.status === 200;
}

const recipeOf = (name: string) => JSON.parse(resolveSecrets("acme", [name], "desk").env[name].slice("@oauth2 ".length));

// ------------------------------------------------------------ the rows

test("discovery (RFC 8414 / OIDC) from the realm's issuer, with iss_parameter, revocation, device and PAR", { skip }, async () => {
  const d = await discoverOAuth(ISSUER, (u, init) => fetchPublic(u, init), { hasSecret: true });
  assert.equal(d.issuer, ISSUER);
  assert.equal(d.token_url, `${ISSUER}/protocol/openid-connect/token`);
  assert.equal(d.iss_parameter, true);
  assert.ok(d.revocation_url && d.device_url && d.par_url);
  assert.equal(d.token_auth, undefined, "Keycloak lists client_secret_post: the form body");
});

for (const token_auth of ["client_secret_post", "client_secret_basic"] as const) {
  test(`authorization code + PKCE S256 + PAR, ${token_auth}, iss checked; the refresh works and rotates`, { skip }, async () => {
    const d = await discoverOAuth(ISSUER, (u, init) => fetchPublic(u, init), { hasSecret: true, tokenAuth: token_auth });
    const app = `kc-${token_auth.replace(/_/g, "-")}`;
    await saveOAuthClient("acme", app, {
      authorize_url: d.authorize_url!, token_url: d.token_url, client_id: "secret-app", client_secret: "secret-app-shh", scopes: "openid offline_access",
      issuer: d.issuer, iss_parameter: d.iss_parameter, token_auth, ...(d.revocation_url ? { revocation_url: d.revocation_url } : {}), ...(d.par_url ? { par_url: d.par_url } : {}),
    });
    const name = `KC_${token_auth.toUpperCase()}`;
    const { url, nonce } = await startOAuthConnect("acme", name, (await getOAuthClient("acme", app))!, REDIRECT, "desk");
    assert.ok(new URL(url).searchParams.get("request_uri"), "PAR: the browser carries a request_uri");
    const back = await consent(url);
    assert.equal(back.searchParams.get("state"), nonce);
    assert.equal(back.searchParams.get("iss"), ISSUER, "RFC 9207");
    const r = await completeOAuthConnect(nonce, back.searchParams.get("code")!, REDIRECT, { iss: back.searchParams.get("iss") });
    assert.equal(r.stored, "oauth2");
    const first = recipeOf(name);
    assert.equal(first.token_auth, token_auth);
    const live = await materializeSecrets(resolveSecrets("acme", [name], "desk").env, { tenant: "acme", workspace: "desk" });
    assert.ok(await accessLive(live[name]), "the refreshed access token opens userinfo at Keycloak");
    // Rotation enforced: the refresh got a new refresh token, it is the one
    // stored now, it is live, and the one it replaced is spent.
    const after = recipeOf(name);
    assert.notEqual(after.refresh_token, first.refresh_token, "the rotated refresh token replaced the old one in the vault");
    assert.ok(await introspect(after.refresh_token, "secret-app", "secret-app-shh"), "the stored refresh token is live");
    assert.equal(await introspect(first.refresh_token, "secret-app", "secret-app-shh"), false, "the one it replaced is spent");
  });
}

test("a callback whose iss is not the realm is refused before the code is traded", { skip }, async () => {
  const d = await discoverOAuth(ISSUER, (u, init) => fetchPublic(u, init), { hasSecret: true });
  const cfg = { authorize_url: d.authorize_url!, token_url: d.token_url, client_id: "secret-app", client_secret: "secret-app-shh", scopes: "openid", issuer: d.issuer, iss_parameter: true, ...(d.par_url ? { par_url: d.par_url } : {}) };
  const { url, nonce } = await startOAuthConnect("acme", "KC_MIXUP", cfg, REDIRECT, "desk");
  const back = await consent(url);
  await assert.rejects(completeOAuthConnect(nonce, back.searchParams.get("code")!, REDIRECT, { iss: `${KC}/realms/master` }), /expected/);
});

test("a public app (no secret) connects with PKCE alone and refreshes with its client id", { skip }, async () => {
  const d = await discoverOAuth(ISSUER, (u, init) => fetchPublic(u, init), { hasSecret: false });
  const cfg = { authorize_url: d.authorize_url!, token_url: d.token_url, client_id: "public-app", client_secret: "", scopes: "openid offline_access", issuer: d.issuer, iss_parameter: d.iss_parameter, ...(d.par_url ? { par_url: d.par_url } : {}) };
  const { url, nonce } = await startOAuthConnect("acme", "KC_PUBLIC", cfg, REDIRECT, "desk");
  const back = await consent(url);
  assert.equal((await completeOAuthConnect(nonce, back.searchParams.get("code")!, REDIRECT, { iss: back.searchParams.get("iss") })).stored, "oauth2");
  const live = await materializeSecrets(resolveSecrets("acme", ["KC_PUBLIC"], "desk").env, { tenant: "acme", workspace: "desk" });
  assert.match(live.KC_PUBLIC, /^ey/, "an access token (a JWT at Keycloak)");
});

test("client credentials (machine to machine) through the same token request builder", { skip }, async () => {
  await client({ clientId: "m2m-app", secret: "m2m-shh", standardFlowEnabled: false, serviceAccountsEnabled: true });
  for (const token_auth of ["client_secret_basic", "client_secret_post"] as const) {
    setOAuth2Secret("acme", "KC_M2M", { token_url: `${ISSUER}/protocol/openid-connect/token`, client_id: "m2m-app", client_secret: "m2m-shh", grant_type: "client_credentials", token_auth }, "desk");
    const live = await materializeSecrets(resolveSecrets("acme", ["KC_M2M"], "desk").env, { tenant: "acme", workspace: "desk" });
    // Keycloak answers introspection of a client-credentials token
    // "inactive" (its session is transient), so the token's claims are read.
    const claims = JSON.parse(Buffer.from(live.KC_M2M.split(".")[1], "base64url").toString("utf8")) as { iss: string; azp: string; exp: number };
    assert.equal(claims.iss, ISSUER, token_auth);
    assert.equal(claims.azp, "m2m-app");
    assert.ok(claims.exp * 1000 > Date.now());
  }
});

test("revocation (RFC 7009): the deleted connection's refresh and access tokens are dead at Keycloak", { skip }, async () => {
  const name = "KC_CLIENT_SECRET_BASIC";
  const live = await materializeSecrets(resolveSecrets("acme", [name], "desk").env, { tenant: "acme", workspace: "desk" });
  const refresh = recipeOf(name).refresh_token as string;
  assert.ok(await introspect(refresh, "secret-app", "secret-app-shh"));
  assert.ok(await accessLive(live[name]));
  const r = await revokeOAuth2Value(oauth2ValueAt("acme", name, "desk")!, { tenant: "acme", fetcher: (u, init) => fetchPublic(u, init) });
  assert.deepEqual(r.revoked, ["refresh_token", "access_token"], JSON.stringify(r));
  assert.equal(await introspect(refresh, "secret-app", "secret-app-shh"), false, "the refresh token is revoked");
  assert.equal(await accessLive(live[name]), false, "and the access token");
});

test("private_key_jwt (RFC 7523): code + PKCE + PAR signed with foldrun's key, the refresh signed again, and client credentials", { skip }, async () => {
  const d = await discoverOAuth(ISSUER, (u, init) => fetchPublic(u, init), { hasSecret: false, tokenAuth: "private_key_jwt" });
  assert.equal(d.token_auth, "private_key_jwt");
  const cfg = {
    authorize_url: d.authorize_url!, token_url: d.token_url, client_id: "jwt-app", client_secret: "", scopes: "openid offline_access",
    issuer: d.issuer, iss_parameter: d.iss_parameter, token_auth: "private_key_jwt" as const, ...(d.par_url ? { par_url: d.par_url } : {}),
    client_assertion_key: SIGNING.privateKey, client_assertion_kid: SIGNING.publicJwk.kid,
  };
  const { url, nonce } = await startOAuthConnect("acme", "KC_JWT", cfg, REDIRECT, "desk");
  assert.ok(new URL(url).searchParams.get("request_uri"), "PAR, signed with the key too");
  const back = await consent(url);
  assert.equal((await completeOAuthConnect(nonce, back.searchParams.get("code")!, REDIRECT, { iss: back.searchParams.get("iss") })).stored, "oauth2");
  const live = await materializeSecrets(resolveSecrets("acme", ["KC_JWT"], "desk").env, { tenant: "acme", workspace: "desk" });
  assert.ok(await accessLive(live.KC_JWT), "the refresh, signed with a fresh assertion, gave a working access token");

  setOAuth2Secret("acme", "KC_JWT_M2M", { token_url: d.token_url, client_id: "jwt-app", grant_type: "client_credentials", token_auth: "private_key_jwt", client_assertion_key: SIGNING.privateKey }, "desk");
  const m2m = await materializeSecrets(resolveSecrets("acme", ["KC_JWT_M2M"], "desk").env, { tenant: "acme", workspace: "desk" });
  const claims = JSON.parse(Buffer.from(m2m.KC_JWT_M2M.split(".")[1], "base64url").toString("utf8")) as { azp: string; iss: string };
  assert.equal(claims.azp, "jwt-app");
  assert.equal(claims.iss, ISSUER);
});

test("private_key_jwt: an assertion signed by another key is refused by Keycloak", { skip }, async () => {
  const other = generateClientKey("ES256");
  setOAuth2Secret("acme", "KC_JWT_WRONG", { token_url: `${ISSUER}/protocol/openid-connect/token`, client_id: "jwt-app", grant_type: "client_credentials", token_auth: "private_key_jwt", client_assertion_key: other.privateKey }, "desk");
  await assert.rejects(materializeSecrets(resolveSecrets("acme", ["KC_JWT_WRONG"], "desk").env, { tenant: "acme", workspace: "desk" }), /KC_JWT_WRONG/);
});

/** The person approving a device code at Keycloak: the page with the code,
 *  the sign-in, then the grant screen if Keycloak shows one. */
async function approveDevice(verificationUrl: string): Promise<void> {
  const jar = new Jar();
  const follow = async (res: Response, base: string): Promise<Response> => {
    for (let hop = 0; res.status >= 300 && res.status < 400 && hop < 6; hop++) {
      const to = new URL(res.headers.get("location")!, base).href;
      res = await fetch(to, { redirect: "manual", headers: { cookie: jar.header() } });
      jar.take(res);
    }
    return res;
  };
  let res = await fetch(verificationUrl, { redirect: "manual" });
  jar.take(res);
  res = await follow(res, verificationUrl);
  let html = await res.text();
  const login = html.match(/<form[^>]+id="kc-form-login"[^>]+action="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
  assert.ok(login, `the device sign-in page: ${html.slice(0, 300)}`);
  res = await fetch(login, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() }, body: new URLSearchParams({ username: USER.username, password: USER.password, credentialId: "" }) });
  jar.take(res);
  res = await follow(res, login);
  html = await res.text();
  // The grant screen ("Do you grant these access privileges?"), when shown.
  const grant = html.match(/<form[^>]+action="([^"]+)"[^>]*>[\s\S]*?name="accept"/)?.[1]?.replace(/&amp;/g, "&");
  if (grant) {
    const grantUrl = new URL(grant, login).href;
    res = await fetch(grantUrl, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() }, body: new URLSearchParams({ accept: "Yes" }) });
    jar.take(res);
    res = await follow(res, grantUrl);
    html = await res.text();
  }
  assert.ok(res.status < 400, `the device was approved (status ${res.status}): ${html.slice(0, 200)}`);
}

test("device authorization (RFC 8628): started for a saved app, approved by the person at Keycloak, polled until stored", { skip }, async () => {
  const { startDeviceConnect, pollDeviceConnect } = await import("../src/oauth-connect.ts");
  const d = await discoverOAuth(ISSUER, (u, init) => fetchPublic(u, init), { hasSecret: false });
  assert.ok(d.device_url);
  const cfg = { authorize_url: d.authorize_url!, token_url: d.token_url, client_id: "device-app", client_secret: "", scopes: "openid offline_access", device_url: d.device_url, issuer: d.issuer };
  const started = await startDeviceConnect("acme", "KC_DEVICE", cfg, "desk");
  assert.match(started.user_code, /^[A-Z0-9-]+$/);
  assert.deepEqual(await pollDeviceConnect("acme", started.id), { status: "pending" }, "nobody has approved yet");
  await approveDevice(started.verification_uri_complete ?? `${started.verification_uri}?user_code=${started.user_code}`);
  let r = await pollDeviceConnect("acme", started.id);
  for (let i = 0; r.status !== "connected" && i < 5; i++) {
    await new Promise((res) => setTimeout(res, 1000));
    r = await pollDeviceConnect("acme", started.id);
  }
  assert.equal(r.status, "connected", JSON.stringify(r));
  const live = await materializeSecrets(resolveSecrets("acme", ["KC_DEVICE"], "desk").env, { tenant: "acme", workspace: "desk" });
  assert.ok(await accessLive(live.KC_DEVICE), "the device grant refreshes into a working access token");
});

test("DPoP (RFC 9449): a connection made with DPoP gets a bound token — refused as a Bearer, accepted with a proof", { skip }, async () => {
  const { dpopProof, dpopAth } = await import("../../foldrun-core/src/oauth-dpop.ts");
  const d = await discoverOAuth(ISSUER, (u, init) => fetchPublic(u, init), { hasSecret: true });
  const cfg = { authorize_url: d.authorize_url!, token_url: d.token_url, client_id: "dpop-app", client_secret: "dpop-shh", scopes: "openid offline_access", issuer: d.issuer, iss_parameter: d.iss_parameter, dpop: true, ...(d.par_url ? { par_url: d.par_url } : {}) };
  const { url, nonce } = await startOAuthConnect("acme", "KC_DPOP", cfg, REDIRECT, "desk");
  const back = await consent(url);
  assert.equal((await completeOAuthConnect(nonce, back.searchParams.get("code")!, REDIRECT, { iss: back.searchParams.get("iss") })).stored, "oauth2");
  const recipe = recipeOf("KC_DPOP");
  assert.match(recipe.dpop_key, /BEGIN PRIVATE KEY/, "the connection holds its own DPoP key");
  const live = await materializeSecrets(resolveSecrets("acme", ["KC_DPOP"], "desk").env, { tenant: "acme", workspace: "desk" });
  const token = live.KC_DPOP;
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { cnf?: { jkt?: string } };
  assert.ok(claims.cnf?.jkt, "the token is bound to the key (cnf.jkt)");
  const userinfo = `${ISSUER}/protocol/openid-connect/userinfo`;
  const bearer = await fetch(userinfo, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(bearer.status, 401, "a copied DPoP token is useless without the key");
  const proofed = await fetch(userinfo, { headers: { authorization: `DPoP ${token}`, dpop: dpopProof(recipe.dpop_key, { htm: "GET", htu: userinfo, ath: dpopAth(token) }) } });
  assert.equal(proofed.status, 200, "with a proof for this call — what the egress proxy adds");
});

const MTLS = process.env.KEYCLOAK_MTLS_URL;
const mtlsSkip = skip || (!MTLS ? "KEYCLOAK_MTLS_URL not set (scripts/oauth-conformance.sh sets up Keycloak's https port)" : false);

test("mutual TLS (RFC 8705): tls_client_auth with the client certificate, and the token bound to it (cnf.x5t#S256)", { skip: mtlsSkip }, async () => {
  const crypto = await import("node:crypto");
  const cert = fs.readFileSync(process.env.KEYCLOAK_CLIENT_CERT!, "utf8");
  const key = fs.readFileSync(process.env.KEYCLOAK_CLIENT_KEY!, "utf8");
  const tokenUrl = `${MTLS}/realms/${REALM}/protocol/openid-connect/token`;
  setOAuth2Secret("acme", "KC_MTLS", { token_url: tokenUrl, client_id: "mtls-app", grant_type: "client_credentials", token_auth: "tls_client_auth", tls_client_cert: cert, tls_client_key: key }, "desk");
  const live = await materializeSecrets(resolveSecrets("acme", ["KC_MTLS"], "desk").env, { tenant: "acme", workspace: "desk" });
  const claims = JSON.parse(Buffer.from(live.KC_MTLS.split(".")[1], "base64url").toString("utf8")) as { azp: string; cnf?: { "x5t#S256"?: string } };
  assert.equal(claims.azp, "mtls-app");
  assert.equal(claims.cnf?.["x5t#S256"], crypto.createHash("sha256").update(new crypto.X509Certificate(cert).raw).digest("base64url"), "bound to this certificate");
  // Without the certificate, the same client is refused.
  setOAuth2Secret("acme", "KC_MTLS_NOCERT", { token_url: tokenUrl, client_id: "mtls-app", grant_type: "client_credentials", client_secret: "none" }, "desk");
  await assert.rejects(materializeSecrets(resolveSecrets("acme", ["KC_MTLS_NOCERT"], "desk").env, { tenant: "acme", workspace: "desk" }), /KC_MTLS_NOCERT/);
});

test("token exchange (RFC 8693): a token-exchange secret trades its subject's token for one issued to the exchanging client", { skip }, async () => {
  const tokenUrl = `${ISSUER}/protocol/openid-connect/token`;
  setOAuth2Secret("acme", "KC_SUBJECT", { token_url: tokenUrl, client_id: "subject-app", client_secret: "subject-shh", grant_type: "client_credentials" }, "desk");
  setTokenExchangeSecret("acme", "KC_EXCHANGED", { token_url: tokenUrl, client_id: "exchange-app", client_secret: "exchange-shh", token_auth: "client_secret_basic", subject_secret: "KC_SUBJECT", requested_token_type: "urn:ietf:params:oauth:token-type:access_token" }, "desk");
  const live = await materializeSecrets(resolveSecrets("acme", ["KC_SUBJECT", "KC_EXCHANGED"], "desk").env, { tenant: "acme", workspace: "desk" });
  const claim = (t: string) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString("utf8")) as { azp: string; iss: string };
  assert.equal(claim(live.KC_SUBJECT).azp, "subject-app");
  assert.equal(claim(live.KC_EXCHANGED).azp, "exchange-app", "a new token, issued to the exchanging client");
  assert.notEqual(live.KC_EXCHANGED, live.KC_SUBJECT);
});
