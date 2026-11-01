// The egress proxy's sender constraints (part H): which DPoP key and which
// client certificate a request's oauth2 connections bind their tokens to
// (senderConstraint) — the proxy then signs a proof per call and presents the
// certificate, while the sandbox holds only the placeholder.
//
//   node --test tests/egress-dpop.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { senderConstraint } from "../src/egress-proxy.ts";
import { generateDpopKey } from "../../foldrun-core/src/oauth-dpop.ts";

const recipe = (extra: object) => "@oauth2 " + JSON.stringify({ token_url: "https://p.example/token", client_id: "c", refresh_token: "r", ...extra });

test("a used DPoP connection gives its key and live token; an unused one or a plain secret gives nothing", () => {
  const key = generateDpopKey();
  const raw = { BSKY: recipe({ dpop_key: key }), PLAIN: "static-key", OTHER: recipe({ dpop_key: generateDpopKey() }) };
  const live = { BSKY: "at-bsky", PLAIN: "static-key", OTHER: "at-other" };
  const got = senderConstraint(["PLAIN", "BSKY"], raw, live);
  assert.deepEqual(got.dpop, { key, token: "at-bsky" });
  assert.equal(got.cert, undefined);
  assert.deepEqual(senderConstraint(["PLAIN"], raw, live), {}, "a plain secret binds nothing");
});

test("a certificate-authenticated connection gives its certificate for the call (RFC 8705 bound tokens)", () => {
  const raw = { BANK: recipe({ token_auth: "tls_client_auth", tls_client_cert: "-----BEGIN CERTIFICATE-----x", tls_client_key: "-----BEGIN PRIVATE KEY-----y", tls_client_passphrase: "p" }) };
  const got = senderConstraint(["BANK"], raw, { BANK: "at" });
  assert.equal(got.certName, "BANK");
  assert.equal(got.cert?.cert, "-----BEGIN CERTIFICATE-----x");
  assert.equal(got.cert?.passphrase, "p");
  assert.match(got.cert?.identity ?? "", /^[a-f0-9]{64}$/);
});

test("the DPoP key is the Authorization token's connection's; two different bound certificates are a conflict (Codex review)", async () => {
  const k1 = generateDpopKey();
  const k2 = generateDpopKey();
  const raw = { A: recipe({ dpop_key: k1 }), B: recipe({ dpop_key: k2 }) };
  const live = { A: "at-a", B: "at-b" };
  assert.equal(senderConstraint(["A", "B"], raw, live, "Bearer at-b").dpop?.key, k2, "B's token is in Authorization");
  const certs = { X: recipe({ tls_client_cert: "c1", tls_client_key: "k1" }), Y: recipe({ tls_client_cert: "c2", tls_client_key: "k2" }) };
  assert.match(senderConstraint(["X", "Y"], certs, { X: "a", Y: "b" }).conflict ?? "", /different client certificates/);
  assert.equal(senderConstraint(["X", "X"], certs, { X: "a" }).conflict, undefined);
});
