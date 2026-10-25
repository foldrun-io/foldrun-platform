// The consent flow, end to end against a mock provider: start hands out an
// authorize URL carrying a single-use state; the callback trades the code
// for tokens and the vault ends up holding the right kind of secret.
//
//   node --test tests/oauth-connect.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { startOAuthConnect, completeOAuthConnect } from "../src/oauth-connect.ts";
import { listSecrets, resolveSecrets } from "../../foldrun-core/src/secrets.ts";

function withVault(body: () => void | Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-connect-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  const done = () => {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    fs.mkdirSync(path.join(root, "acme/workspaces/desk"), { recursive: true });
    const out = body();
    if (out && typeof (out as Promise<void>).then === "function") return (out as Promise<void>).finally(done);
    done();
  } catch (err) {
    done();
    throw err;
  }
}

/** A token endpoint that validates the code exchange and can answer with or
 *  without a refresh token. */
function provider(withRefresh: boolean): Promise<{ tokenUrl: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const form = new URLSearchParams(body);
      if (form.get("grant_type") === "authorization_code" && form.get("code") === "good-code" && form.get("client_secret") === "shh") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(withRefresh
          ? { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 }
          : { access_token: "gh-token" }));
      } else {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant" }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ tokenUrl: `http://127.0.0.1:${port}/token`, close: () => server.close() });
    });
  });
}

const CONFIG = (tokenUrl: string) => ({
  authorize_url: "https://provider.test/authorize",
  token_url: tokenUrl,
  client_id: "cid",
  client_secret: "shh",
  scopes: "ads.read offline",
  authorize_extra: { access_type: "offline" },
});

const REDIRECT = "http://127.0.0.1:3900/api/oauth/callback";

test("start builds the authorize URL with everything the provider needs", () =>
  withVault(async () => {
    const { url, nonce } = await startOAuthConnect("acme", "ADS_TOKEN", CONFIG("https://x/token"), REDIRECT, "desk");
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, "https://provider.test/authorize");
    assert.equal(parsed.searchParams.get("client_id"), "cid");
    assert.equal(parsed.searchParams.get("redirect_uri"), REDIRECT);
    assert.equal(parsed.searchParams.get("response_type"), "code");
    assert.equal(parsed.searchParams.get("scope"), "ads.read offline");
    assert.equal(parsed.searchParams.get("access_type"), "offline");
    assert.equal(parsed.searchParams.get("state"), nonce);
  }));

test("the full round trip lands an auto-refreshing secret in the right scope", () =>
  withVault(async () => {
    const p = await provider(true);
    try {
      const { nonce } = await startOAuthConnect("acme", "ADS_TOKEN", CONFIG(p.tokenUrl), REDIRECT, "desk");
      const result = await completeOAuthConnect(nonce, "good-code", REDIRECT);
      assert.equal(result.stored, "oauth2");
      const row = listSecrets("acme", "desk").find((s) => s.name === "ADS_TOKEN");
      assert.equal(row?.kind, "oauth2");
      assert.equal(row?.scope, "workspace");
      const { env } = resolveSecrets("acme", ["ADS_TOKEN"], "desk");
      assert.match(env.ADS_TOKEN, /rt-1/, "the refresh token from the exchange is in the recipe");
    } finally {
      p.close();
    }
  }));

test("a provider without refresh tokens yields a static secret, honestly", () =>
  withVault(async () => {
    const p = await provider(false);
    try {
      const { nonce } = await startOAuthConnect("acme", "GH_TOKEN", CONFIG(p.tokenUrl), REDIRECT);
      const result = await completeOAuthConnect(nonce, "good-code", REDIRECT);
      assert.equal(result.stored, "static");
      const { env } = resolveSecrets("acme", ["GH_TOKEN"]);
      assert.equal(env.GH_TOKEN, "gh-token");
      assert.equal(listSecrets("acme").find((s) => s.name === "GH_TOKEN")?.kind, undefined);
    } finally {
      p.close();
    }
  }));

test("a state is single-use, and an unknown one is refused", () =>
  withVault(async () => {
    const p = await provider(true);
    try {
      const { nonce } = await startOAuthConnect("acme", "ADS_TOKEN", CONFIG(p.tokenUrl), REDIRECT);
      await completeOAuthConnect(nonce, "good-code", REDIRECT);
      await assert.rejects(completeOAuthConnect(nonce, "good-code", REDIRECT), /expired or was already used/);
      await assert.rejects(completeOAuthConnect("a".repeat(48), "good-code", REDIRECT), /expired or was already used/);
      await assert.rejects(completeOAuthConnect("../escape", "good-code", REDIRECT), /malformed/);
    } finally {
      p.close();
    }
  }));

test("a refused exchange reports the provider's reason and stores nothing", () =>
  withVault(async () => {
    const p = await provider(true);
    try {
      const { nonce } = await startOAuthConnect("acme", "ADS_TOKEN", CONFIG(p.tokenUrl), REDIRECT);
      await assert.rejects(completeOAuthConnect(nonce, "wrong-code", REDIRECT), /invalid_grant/);
      assert.equal(listSecrets("acme").length, 0);
    } finally {
      p.close();
    }
  }));

// ---------------------------------------------------------------- clients

import {
  saveOAuthClient,
  listOAuthClients,
  getOAuthClient,
  deleteOAuthClient,
} from "../src/oauth-clients.ts";

// The fake token endpoint listens on 127.0.0.1, which the platform refuses
// to reach by default (ssrf.ts); tests/ssrf.test.ts covers that refusal.
process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE = "1";

test("a saved client round-trips, lists without its secret, and runs the flow", () =>
  withVault(async () => {
    const p = await provider(true);
    try {
      await saveOAuthClient("acme", "google-ads", CONFIG(p.tokenUrl));
      const rows = await listOAuthClients("acme");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].client_id, "cid");
      assert.ok(!("client_secret" in rows[0]), "the secret never comes back through a list");

      const config = (await getOAuthClient("acme", "google-ads"))!;
      assert.equal(config.client_secret, "shh", "decrypted for the flow, and only there");

      // The whole point of saving: run consent from the stored client.
      const { nonce } = await startOAuthConnect("acme", "ADS_TOKEN", config, REDIRECT, "desk");
      const result = await completeOAuthConnect(nonce, "good-code", REDIRECT);
      assert.equal(result.stored, "oauth2");

      assert.ok(await deleteOAuthClient("acme", "google-ads"));
      assert.equal((await listOAuthClients("acme")).length, 0);
      assert.equal(await getOAuthClient("acme", "google-ads"), null);
    } finally {
      p.close();
    }
  }));

test("a client is validated on save, not at connect time", () =>
  withVault(async () => {
    await assert.rejects(
      () => saveOAuthClient("acme", "bad", { ...CONFIG("https://x/t"), client_id: "" }),
      /needs client_id/,
    );
    await assert.rejects(
      () => saveOAuthClient("acme", "Bad Name", CONFIG("https://x/t")),
      /kebab-case/,
    );
  }));

test("one saved app, two connections at different scopes: each keeps its own, the app's default is untouched", () =>
  withVault(async () => {
    const p = await provider(true);
    try {
      const { scopesForSecret } = await import("../src/oauth-connections.ts");
      await saveOAuthClient("acme", "google", CONFIG(p.tokenUrl));
      const app = (await getOAuthClient("acme", "google"))!;
      // The first connection takes the app's default scopes.
      let started = await startOAuthConnect("acme", "ADS_TOKEN", app, REDIRECT, "desk");
      await completeOAuthConnect(started.nonce, "good-code", REDIRECT);
      // The second asks for its own, as /api/oauth/start does with `scopes`.
      started = await startOAuthConnect("acme", "SEARCH_TOKEN", { ...app, scopes: "search.readonly" }, REDIRECT, "desk");
      assert.equal(new URL(started.url).searchParams.get("scope"), "search.readonly");
      await completeOAuthConnect(started.nonce, "good-code", REDIRECT);

      assert.equal(await scopesForSecret("acme", "SEARCH_TOKEN", "desk"), "search.readonly");
      assert.equal(await scopesForSecret("acme", "ADS_TOKEN", "desk"), "ads.read offline");
      const saved = await listOAuthClients("acme");
      assert.equal(saved.length, 1, "the same app is reused, not saved twice");
      assert.equal(saved[0].scopes, "ads.read offline", "a connection's scopes never overwrite the shared app's default");
    } finally {
      p.close();
    }
  }));

test("a connection made with no scopes reconnects with none, not the app's default", () =>
  withVault(async () => {
    const p = await provider(true);
    try {
      const { scopesForSecret } = await import("../src/oauth-connections.ts");
      await saveOAuthClient("acme", "google", CONFIG(p.tokenUrl));
      const app = (await getOAuthClient("acme", "google"))!;
      const started = await startOAuthConnect("acme", "BARE_TOKEN", { ...app, scopes: "" }, REDIRECT, "desk");
      await completeOAuthConnect(started.nonce, "good-code", REDIRECT);
      assert.equal(await scopesForSecret("acme", "BARE_TOKEN", "desk"), "");
    } finally {
      p.close();
    }
  }));

test("a static token from a saved app keeps the app and its scopes, so it can be reconnected", () =>
  withVault(async () => {
    const p = await provider(false);
    try {
      const { scopesForSecret, clientForSecret, connectionStatus } = await import("../src/oauth-connections.ts");
      await saveOAuthClient("acme", "code-host", CONFIG(p.tokenUrl));
      const app = (await getOAuthClient("acme", "code-host"))!;
      const started = await startOAuthConnect("acme", "REPO_TOKEN", { ...app, scopes: "repo" }, REDIRECT, "desk");
      const result = await completeOAuthConnect(started.nonce, "good-code", REDIRECT);
      assert.equal(result.stored, "static");
      assert.equal(await clientForSecret("acme", "REPO_TOKEN", "desk"), "code-host");
      assert.equal(await scopesForSecret("acme", "REPO_TOKEN", "desk"), "repo");
      const row = (await connectionStatus("acme")).find((c) => c.name === "REPO_TOKEN");
      assert.equal(row?.client, "code-host");
      assert.equal(row?.workspace, "desk");
    } finally {
      p.close();
    }
  }));

/** A token endpoint that records what it was sent. */
function recordingProvider(): Promise<{ tokenUrl: string; seen: URLSearchParams[]; close: () => void }> {
  const seen: URLSearchParams[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push(new URLSearchParams(body));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const { port } = server.address() as { port: number };
    resolve({ tokenUrl: `http://127.0.0.1:${port}/token`, seen, close: () => server.close() });
  }));
}

test("PKCE: on by default, S256 of the verifier the callback sends; off sends neither", () =>
  withVault(async () => {
    const { createHash } = await import("node:crypto");
    const p = await recordingProvider();
    try {
      const { url, nonce } = await startOAuthConnect("acme", "PK_TOKEN", CONFIG(p.tokenUrl), REDIRECT, "desk");
      const q = new URL(url).searchParams;
      assert.equal(q.get("code_challenge_method"), "S256");
      await completeOAuthConnect(nonce, "c", REDIRECT);
      const verifier = p.seen[0].get("code_verifier")!;
      assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(q.get("code_challenge"), createHash("sha256").update(verifier).digest("base64url"));

      const off = await startOAuthConnect("acme", "NO_PKCE", { ...CONFIG(p.tokenUrl), pkce: false }, REDIRECT, "desk");
      assert.equal(new URL(off.url).searchParams.get("code_challenge"), null);
      await completeOAuthConnect(off.nonce, "c", REDIRECT);
      assert.equal(p.seen[1].get("code_verifier"), null);
    } finally { p.close(); }
  }));

test("a public app (no secret) connects with PKCE and stores a secretless recipe; without PKCE it is refused", () =>
  withVault(async () => {
    const p = await recordingProvider();
    try {
      const pub = { ...CONFIG(p.tokenUrl), client_secret: "" };
      const { nonce } = await startOAuthConnect("acme", "PUB_TOKEN", pub, REDIRECT, "desk");
      await completeOAuthConnect(nonce, "c", REDIRECT);
      assert.equal(p.seen[0].get("client_secret"), null);
      const { env } = resolveSecrets("acme", ["PUB_TOKEN"], "desk");
      assert.doesNotMatch(env.PUB_TOKEN, /client_secret/);
      await assert.rejects(startOAuthConnect("acme", "PUB_TOKEN", { ...pub, pkce: false }, REDIRECT, "desk"), /public client and needs PKCE/);
      await assert.rejects(saveOAuthClient("acme", "pub", { ...pub, pkce: false }), /needs PKCE/);
      await saveOAuthClient("acme", "pub", pub);
      assert.equal((await getOAuthClient("acme", "pub"))?.client_secret, "");
    } finally { p.close(); }
  }));

test("the flow's own parameters cannot be overridden by authorize_extra or the authorize URL's query", () =>
  withVault(async () => {
    const sneaky = { ...CONFIG("https://x/token"), authorize_url: "https://provider.test/authorize?redirect_uri=https://evil.test/cb&state=zzz" };
    const { url, nonce } = await startOAuthConnect("acme", "SAFE_TOKEN", sneaky, REDIRECT, "desk");
    const q = new URL(url).searchParams;
    assert.equal(q.get("redirect_uri"), REDIRECT);
    assert.equal(q.get("state"), nonce);
    assert.equal(q.getAll("redirect_uri").length, 1);
    await assert.rejects(startOAuthConnect("acme", "SAFE_TOKEN", { ...CONFIG("https://x/token"), authorize_extra: { redirect_uri: "https://evil.test" } }, REDIRECT), /cannot set redirect_uri/);
  }));

test("a bound consent refuses a code that comes back without its browser cookie; the right cookie lands it", () =>
  withVault(async () => {
    const { newBinding } = await import("../src/oauth-connect.ts");
    const p = await recordingProvider();
    try {
      const b = newBinding();
      let started = await startOAuthConnect("acme", "BOUND_TOKEN", CONFIG(p.tokenUrl), REDIRECT, "desk", b.hash);
      await assert.rejects(completeOAuthConnect(started.nonce, "c", REDIRECT, { binding: "someone-else" }), /started in another browser/);
      assert.equal(p.seen.length, 0, "refused before any network");
      started = await startOAuthConnect("acme", "BOUND_TOKEN", CONFIG(p.tokenUrl), REDIRECT, "desk", b.hash);
      const r = await completeOAuthConnect(started.nonce, "c", REDIRECT, { binding: b.cookie });
      assert.equal(r.stored, "oauth2");
    } finally { p.close(); }
  }));

test("iss: a pinned issuer must come back exactly; unpinned, a returned iss must be the authorize origin", () =>
  withVault(async () => {
    const p = await recordingProvider();
    try {
      const pinned = { ...CONFIG(p.tokenUrl), issuer: "https://provider.test" };
      let s = await startOAuthConnect("acme", "ISS_TOKEN", pinned, REDIRECT, "desk");
      await assert.rejects(completeOAuthConnect(s.nonce, "c", REDIRECT, {}), /answered as nobody/);
      s = await startOAuthConnect("acme", "ISS_TOKEN", pinned, REDIRECT, "desk");
      await completeOAuthConnect(s.nonce, "c", REDIRECT, { iss: "https://provider.test" });
      s = await startOAuthConnect("acme", "ISS_TOKEN", CONFIG(p.tokenUrl), REDIRECT, "desk");
      await assert.rejects(completeOAuthConnect(s.nonce, "c", REDIRECT, { iss: "https://attacker.test" }), /not the server this connect went to/);
      // An issuer with a path on the same site (a Keycloak realm) is fine unpinned.
      s = await startOAuthConnect("acme", "ISS_TOKEN", CONFIG(p.tokenUrl), REDIRECT, "desk");
      await completeOAuthConnect(s.nonce, "c", REDIRECT, { iss: "https://provider.test/realms/acme" });
    } finally { p.close(); }
  }));

test("a hand-off is shown, then used once, and is never mistaken for a consent", () =>
  withVault(async () => {
    const { parkHandoff, peekHandoff, takeHandoff } = await import("../src/oauth-connect.ts");
    const id = await parkHandoff({ tenant: "acme", client: "google", name: "GSC_OAUTH", workspace: "desk", scopes: "s", by: "key:cli" });
    assert.equal((await peekHandoff(id))?.name, "GSC_OAUTH");
    assert.equal((await peekHandoff(id))?.client, "google", "peeking does not use it");
    await assert.rejects(completeOAuthConnect(id, "c", REDIRECT), /expired or was already used/);
    assert.equal((await peekHandoff(id))?.name, "GSC_OAUTH", "a hand-off's id used as a state does not use it up");
    assert.equal((await takeHandoff(id))?.name, "GSC_OAUTH");
    assert.equal(await takeHandoff(id), null, "used once");
    assert.equal(await peekHandoff("not-an-id"), null);
  }));

test("a connection keeps its app's PKCE and issuer settings when it is remembered", () =>
  withVault(async () => {
    const p = await recordingProvider();
    try {
      await saveOAuthClient("acme", "strict", { ...CONFIG(p.tokenUrl), pkce: false, issuer: "https://provider.test" });
      const app = (await getOAuthClient("acme", "strict"))!;
      const s = await startOAuthConnect("acme", "STRICT_TOKEN", app, REDIRECT, "desk");
      await completeOAuthConnect(s.nonce, "c", REDIRECT, { iss: "https://provider.test" });
      const after = (await getOAuthClient("acme", "strict"))!;
      assert.equal(after.pkce, false, "PKCE stays off for the app that refuses it");
      assert.equal(after.issuer, "https://provider.test");
    } finally { p.close(); }
  }));

test("a hand-off stays through retries and is used up when a consent from it completes", () =>
  withVault(async () => {
    const { parkHandoff, peekHandoff } = await import("../src/oauth-connect.ts");
    const p = await recordingProvider();
    try {
      const id = await parkHandoff({ tenant: "acme", client: "x", name: "HO_TOKEN", workspace: "desk", by: "key:cli" });
      const first = await startOAuthConnect("acme", "HO_TOKEN", CONFIG(p.tokenUrl), REDIRECT, "desk", undefined, id);
      await startOAuthConnect("acme", "HO_TOKEN", CONFIG(p.tokenUrl), REDIRECT, "desk", undefined, id); // a retried Accept
      assert.ok(await peekHandoff(id), "still there after two starts");
      const second = await startOAuthConnect("acme", "HO_TOKEN", CONFIG(p.tokenUrl), REDIRECT, "desk", undefined, id);
      await completeOAuthConnect(first.nonce, "c", REDIRECT);
      assert.equal(await peekHandoff(id), null, "done once a consent from it completes");
      await assert.rejects(completeOAuthConnect(second.nonce, "c", REDIRECT), /already completed/, "a later consent from the same hand-off stores nothing");
      assert.equal(p.seen.length, 1, "and asks the provider nothing");
    } finally { p.close(); }
  }));

test("a hand-off consent whose exchange fails releases its claim, so the hand-off can be tried again", () =>
  withVault(async () => {
    const { parkHandoff, peekHandoff } = await import("../src/oauth-connect.ts");
    const p = await provider(true); // refuses any code but "good-code"
    try {
      const id = await parkHandoff({ tenant: "acme", client: "x", name: "RETRY_HO", workspace: "desk", by: "key:cli" });
      const bad = await startOAuthConnect("acme", "RETRY_HO", CONFIG(p.tokenUrl), REDIRECT, "desk", undefined, id);
      await assert.rejects(completeOAuthConnect(bad.nonce, "wrong-code", REDIRECT), /refused the exchange/);
      assert.ok(await peekHandoff(id), "the hand-off is still there after a failed exchange");
      const good = await startOAuthConnect("acme", "RETRY_HO", CONFIG(p.tokenUrl), REDIRECT, "desk", undefined, id);
      const r = await completeOAuthConnect(good.nonce, "good-code", REDIRECT);
      assert.equal(r.stored, "oauth2");
      assert.equal(await peekHandoff(id), null);
      // The claim's id, used as a state, neither works nor frees a second completion.
      const { createHash } = await import("node:crypto");
      const claimId = createHash("sha256").update(`claim:${id}`).digest("hex").slice(0, 48);
      await assert.rejects(completeOAuthConnect(claimId, "good-code", REDIRECT), /expired or was already used/);
      const late = await startOAuthConnect("acme", "RETRY_HO", CONFIG(p.tokenUrl), REDIRECT, "desk", undefined, id);
      await assert.rejects(completeOAuthConnect(late.nonce, "good-code", REDIRECT), /already completed/);
    } finally { p.close(); }
  }));
