// foldrun as a workload-federation issuer (oidc-issuer.ts): discovery and
// JWKS for the cloud, tokens that verify against them with claims from the
// lease, pre-published rotation, and the proxy's /identity door refusing
// everything it should.
//
//   node --test tests/oidc-issuer.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-oidc-"));
process.env.FOLDRUN_SECRET_KEY = "test-install-key";
process.env.FOLDRUN_OIDC_ISSUER = "https://foldrun.example.test";
delete process.env.FOLDRUN_REDIS_URL;

const { oidcIssuer, oidcDiscovery, oidcJwks, mintIdentityToken, rotateOidcKey, subjectOf, PREPUBLISH_MS, RETIRE_AFTER_MS, TOKEN_SECONDS } = await import("../src/oidc-issuer.ts");
const { egressHooks, startEgressProxy, stopEgressProxy, IDENTITY_LIVENESS_MS } = await import("../src/egress-proxy.ts");

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString());
function verify(token: string, jwks: { keys: Array<Record<string, string>> }) {
  const [h, p, sig] = token.split(".");
  const header = decode(h!);
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  assert.ok(jwk, `kid ${header.kid} is published`);
  const key = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: "jwk" });
  assert.ok(crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(sig!, "base64url")), "the signature verifies");
  return { header, claims: decode(p!) };
}

test("discovery and JWKS: the federation profile, RS256, public parts only", async () => {
  assert.equal(oidcIssuer(), "https://foldrun.example.test");
  const d = oidcDiscovery(oidcIssuer()!);
  assert.equal(d.jwks_uri, "https://foldrun.example.test/.well-known/jwks.json");
  assert.deepEqual(d.id_token_signing_alg_values_supported, ["RS256"]);
  assert.deepEqual(d.response_types_supported, ["id_token"]);
  const jwks = await oidcJwks();
  assert.equal(jwks.keys.length, 1);
  for (const k of jwks.keys) for (const priv of ["d", "p", "q", "dp", "dq", "qi"]) assert.equal((k as Record<string, unknown>)[priv], undefined, `no ${priv}`);
  for (const bad of ["http://x.test", "https://x.test:8443", "https://x.test/?a=1", "https://x.test/#f"]) {
    process.env.FOLDRUN_OIDC_ISSUER = bad;
    assert.throws(() => oidcIssuer(), /must be https/);
  }
  process.env.FOLDRUN_OIDC_ISSUER = "https://foldrun.example.test";
});

test("a minted token verifies against the JWKS, with the subject and claims of the workload", async () => {
  const { token, expiresAt } = await mintIdentityToken({ tenant: "acme", workspace: "desk", agent: "writer", runId: "run-1" }, "sts.amazonaws.com");
  const { header, claims } = verify(token, await oidcJwks());
  assert.equal(header.alg, "RS256");
  assert.equal(claims.iss, "https://foldrun.example.test");
  assert.equal(claims.sub, "account:acme:workspace:desk:agent:writer");
  assert.equal(claims.aud, "sts.amazonaws.com");
  assert.equal(claims.exp - claims.iat, TOKEN_SECONDS);
  assert.equal(expiresAt, claims.exp * 1000);
  assert.equal(claims.run_id, "run-1");
  assert.throws(() => subjectOf({ tenant: "acme", workspace: "a:b", agent: "w" }), /cannot be part of a subject/);
});

test("rotation pre-publishes the next key, signs with it a day later, and retires the old one after its tokens expire", async () => {
  const t0 = Date.now();
  const before = (await oidcJwks(t0)).keys.map((k) => k.kid);
  const next = await rotateOidcKey(t0);
  const published = (await oidcJwks(t0)).keys.map((k) => k.kid);
  assert.ok(published.includes(next) && published.includes(before[0]!), "both published at once");
  const early = await mintIdentityToken({ tenant: "acme", workspace: "desk", agent: "w", runId: "r" }, "a", t0 + 1000);
  assert.equal(decode(early.token.split(".")[0]!).kid, before[0], "the old key still signs before the new one is active");
  const later = await mintIdentityToken({ tenant: "acme", workspace: "desk", agent: "w", runId: "r" }, "a", t0 + PREPUBLISH_MS + 1000);
  assert.equal(decode(later.token.split(".")[0]!).kid, next, "the new key signs once active");
  const after = (await oidcJwks(t0 + PREPUBLISH_MS + RETIRE_AFTER_MS + 1000)).keys.map((k) => k.kid);
  assert.deepEqual(after, [next], "the old key is retired once its last tokens have expired");
});

test("the /identity door: only a granted identity, only for a live lease, subject from the lease", async () => {
  const proxy = await startEgressProxy(0);
  process.env.FOLDRUN_EGRESS_URL = `http://127.0.0.1:${proxy.port}`;
  try {
    const grant = { secrets: {}, identities: { AWS_ID: { audience: "sts.amazonaws.com" } } };
    const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-9", grant, who: { workspace: "desk", agent: "writer" } }))!;
    const token = lease.url.split("/e/")[1]!;
    const get = (p: string) => fetch(`http://127.0.0.1:${proxy.port}${p}`);
    const ok = await get(`/identity/${token}/AWS_ID`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    const body = (await ok.json()) as { token: string };
    const { claims } = verify(body.token, await oidcJwks());
    assert.equal(claims.sub, "account:acme:workspace:desk:agent:writer");
    assert.equal(claims.aud, "sts.amazonaws.com", "the audience is the grant's, not the request's");
    assert.equal((await get(`/identity/${token}/OTHER_ID`)).status, 403, "not granted to this step");
    assert.equal((await get(`/identity/${"x".repeat(32)}/AWS_ID`)).status, 401, "no such lease");
    const noWho = (await egressHooks.lease({ tenant: "acme", runId: "run-10", grant }))!;
    assert.equal((await get(`/identity/${noWho.url.split("/e/")[1]}/AWS_ID`)).status, 403, "a lease that names no workload");
    await lease.release();
    assert.equal((await get(`/identity/${token}/AWS_ID`)).status, 401, "a released lease (a stopped step) gets nothing more");
    await noWho.release();
    assert.ok(IDENTITY_LIVENESS_MS < 6 * 3600_000, "far tighter than the lease's own window");
  } finally {
    delete process.env.FOLDRUN_EGRESS_URL;
    await stopEgressProxy();
  }
});
