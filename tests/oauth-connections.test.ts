// OAuth connections: the client is remembered when a secret is connected, so
// reconnecting needs nothing typed; old secrets are migrated; health and
// expiry are computed; a dead grant quotes a one-click reconnect link.
//
//   node --test tests/oauth-connections.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { startOAuthConnect, completeOAuthConnect } from "../src/oauth-connect.ts";
import { getOAuthClient, listOAuthClients, deleteOAuthClient } from "../src/oauth-clients.ts";
import {
  rememberConnection, migrateConnections, connectionStatus, clientForSecret, stateOf, daysLeft, noteOAuthRefresh,
} from "../src/oauth-connections.ts";
import { setOAuth2Secret, getSecret, listSecrets, materializeSecrets } from "../../foldrun-core/src/secrets.ts";
import { OAUTH_PRESETS } from "../../foldrun-core/src/oauth-presets.ts";
import { registerPlatform, resetPlatform } from "../../foldrun-core/src/platform.ts";

// The fake token endpoint listens on 127.0.0.1, which the platform refuses
// to reach by default (ssrf.ts); tests/ssrf.test.ts covers that refusal.
process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE = "1";

async function withVault(body: () => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-conns-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  fs.mkdirSync(path.join(root, "acme/workspaces/desk"), { recursive: true });
  try {
    await body();
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function provider(reply: (form: URLSearchParams) => { status: number; body: object }) {
  return new Promise<{ tokenUrl: string; close: () => void }>((resolve) => {
    const server = http.createServer((req, res) => {
      let s = "";
      req.on("data", (c) => (s += c));
      req.on("end", () => {
        const r = reply(new URLSearchParams(s));
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(JSON.stringify(r.body));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ tokenUrl: `http://127.0.0.1:${port}/token`, close: () => server.close() });
    });
  });
}

test("connect remembers the client; a reconnect reuses it and writes the same secret at the same scope", () =>
  withVault(async () => {
    const p = await provider((f) =>
      f.get("grant_type") === "authorization_code"
        ? { status: 200, body: { access_token: "at", refresh_token: `rt-${f.get("code")}`, refresh_token_expires_in: 365 * 86400 } }
        : { status: 400, body: { error: "invalid_grant" } });
    try {
      const config = { authorize_url: "https://auth.example/authorize", token_url: p.tokenUrl, client_id: "cid", client_secret: "shh", scopes: "a b" };
      const first = await startOAuthConnect("acme", "LI_OAUTH", config, "https://dash/cb", "desk");
      await completeOAuthConnect(first.nonce, "one", "https://dash/cb");

      const client = await clientForSecret("acme", "LI_OAUTH", "desk");
      assert.ok(client, "the client is saved beside the secret");
      assert.equal((await getOAuthClient("acme", client!))?.client_secret, "shh");
      const [row] = await connectionStatus("acme");
      assert.equal(row.workspace, "desk");
      assert.equal(row.status, "ok");
      assert.ok(row.daysLeft! >= 364, "refresh_token_expires_in is kept");

      // Reconnect: nothing but the secret name — the stored client runs.
      const again = await startOAuthConnect("acme", "LI_OAUTH", (await getOAuthClient("acme", (await clientForSecret("acme", "LI_OAUTH", "desk"))!))!, "https://dash/cb", "desk");
      await completeOAuthConnect(again.nonce, "two", "https://dash/cb");
      const hit = getSecret("acme", "LI_OAUTH", "desk");
      assert.equal(hit?.scope, "workspace");
      assert.match(hit!.value, /rt-two/);
      assert.equal(listSecrets("acme").some((s) => s.name === "LI_OAUTH"), false, "never leaks to account scope");
      assert.equal((await listOAuthClients("acme")).length, 1, "the same client is reused, not duplicated");
    } finally {
      p.close();
    }
  }));

test("migration lifts the client out of an existing oauth2 secret", () =>
  withVault(async () => {
    setOAuth2Secret("acme", "LINKEDIN_OAUTH", {
      token_url: OAUTH_PRESETS.linkedin.token_url, client_id: "li-cid", client_secret: "li-sec", refresh_token: "rt",
    }, "desk");
    assert.equal(await migrateConnections("acme"), 1);
    assert.equal(await migrateConnections("acme"), 0, "idempotent");
    const client = await clientForSecret("acme", "LINKEDIN_OAUTH", "desk");
    assert.equal(client, "linkedin");
    const cfg = (await getOAuthClient("acme", "linkedin"))!;
    assert.equal(cfg.authorize_url, OAUTH_PRESETS.linkedin.authorize_url);
    assert.equal(cfg.client_id, "li-cid");
    // A new secret name for the same provider borrows it.
    assert.equal(await clientForSecret("acme", "OTHER_LI", undefined, "linkedin"), "linkedin");
  }));

test("a caller who may not change saved clients links to one and rewrites none (30 Oct 2026)", () =>
  withVault(async () => {
    const google = OAUTH_PRESETS.google;
    // The account's app, saved by an unscoped admin's connect.
    await rememberConnection("acme", "GMAIL", undefined, { token_url: google.token_url, client_id: "acct-cid", client_secret: "acct-sec", scopes: "mail" });
    const before = (await getOAuthClient("acme", "google"))!;
    // A workspace-scoped admin's recipe with the same app id: its own
    // consent page and a junk secret must not land on the account's app.
    const linked = await rememberConnection("acme", "MINE", "desk", {
      token_url: google.token_url, client_id: "acct-cid", client_secret: "junk", authorize_url: "https://evil.example/authorize",
      authorize_extra: { prompt: "none" },
    }, { keepSavedClients: true });
    assert.equal(linked, "google", "linked to the account's app, for its reconnect");
    assert.deepEqual(await getOAuthClient("acme", "google"), before, "the saved app is untouched");
    // An app the account has not saved is not saved by such a caller —
    // not now, and not by the migration that reads its secret back later
    // (a known provider is what migration lifts; Codex, 30 Oct 2026).
    const theirs = { token_url: google.token_url, client_id: "their-cid", client_secret: "their-sec", refresh_token: "rt", authorize_url: "https://evil.example/authorize" };
    setOAuth2Secret("acme", "OTHER", theirs, "desk");
    assert.equal(await rememberConnection("acme", "OTHER", "desk", theirs, { keepSavedClients: true }), null);
    setOAuth2Secret("acme", "MINE", { token_url: google.token_url, client_id: "acct-cid", client_secret: "junk", refresh_token: "rt" }, "desk");
    await migrateConnections("acme");
    assert.equal(await clientForSecret("acme", "OTHER", "desk"), null);
    assert.deepEqual((await listOAuthClients("acme")).map((c) => c.name), ["google"]);
    assert.deepEqual(await getOAuthClient("acme", "google"), before);
    // The account removes its app: the linked connection is unlinked, and
    // its secret's config does not come back as the account's app.
    await deleteOAuthClient("acme", "google");
    await migrateConnections("acme");
    assert.deepEqual(await listOAuthClients("acme"), []);
    assert.equal(await clientForSecret("acme", "MINE", "desk"), null);
    assert.equal(await migrateConnections("acme"), 0, "and settled: nothing to do again");
  }));

test("status and expiry math", () => {
  const now = Date.parse("2026-09-14T00:00:00Z");
  const at = (days: number) => new Date(now + days * 86_400_000).toISOString();
  const base = { name: "X", client: "c", connectedAt: at(-30) };
  assert.equal(stateOf({ ...base, refreshExpiresAt: at(100) }, now), "ok");
  assert.equal(daysLeft({ ...base, refreshExpiresAt: at(100) }, now), 100);
  assert.equal(stateOf({ ...base, refreshExpiresAt: at(10) }, now), "expiring");
  assert.equal(stateOf({ ...base, refreshExpiresAt: at(-1) }, now), "expired");
  assert.equal(stateOf({ ...base, lastError: "invalid_grant", lastErrorAt: at(-1) }, now), "failed");
  assert.equal(stateOf({ ...base, lastError: "old", lastErrorAt: at(-40) }, now), "ok", "a failure before the last connect is history");
  assert.equal(stateOf({ name: "X", client: null }, now), "no-client");
});

test("a dead grant fails the step quoting a one-click reconnect link, recorded once", () =>
  withVault(async () => {
    const p = await provider(() => ({ status: 400, body: { error: "invalid_grant", error_description: "revoked" } }));
    process.env.FOLDRUN_PUBLIC_URL = "https://dev.example";
    registerPlatform({ noteOAuthRefresh });
    try {
      setOAuth2Secret("acme", "LI_OAUTH", { token_url: p.tokenUrl, client_id: "c", client_secret: "s", refresh_token: "dead" }, "desk");
      await rememberConnection("acme", "LI_OAUTH", "desk", { token_url: p.tokenUrl, client_id: "c", client_secret: "s", authorize_url: "https://auth.example/a" }, { connectedAt: "2026-09-01T00:00:00.000Z" });
      const env = { LI_OAUTH: getSecret("acme", "LI_OAUTH", "desk")!.value };
      await assert.rejects(
        materializeSecrets(env, { tenant: "acme", workspace: "desk" }),
        /LI_OAUTH: token refresh failed \(400\).*reconnect it in one click: https:\/\/dev\.example\/dashboard\/desk\/settings\?reconnect=LI_OAUTH/,
      );
      const [row] = await connectionStatus("acme");
      assert.equal(row.status, "failed");
      const notified = row.notifiedAt;
      assert.ok(notified);
      await assert.rejects(materializeSecrets(env, { tenant: "acme", workspace: "desk" }));
      assert.equal((await connectionStatus("acme"))[0].notifiedAt, notified, "one email per breakage, not per step");
    } finally {
      resetPlatform();
      delete process.env.FOLDRUN_PUBLIC_URL;
      p.close();
    }
  }));
