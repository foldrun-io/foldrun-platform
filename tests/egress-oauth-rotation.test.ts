// An OAuth provider that rotates refresh tokens (RFC 9700 §2.2.2), behind
// more than one egress replica.
//
// A refresh on one replica revokes the refresh token in the grant. Before 29
// Oct 2026 the replica wrote the new one to the vault — to the ACCOUNT copy
// even for a workspace's secret, since it passed no workspace — and the
// lease kept the old one, so the next refresh on another replica sent a
// revoked token. Now the replica records the rotation beside the lease
// (egress:rot:<lease>), every replica reads it before refreshing, and the
// worker writes it to the vault copy it came from on its heartbeat.
//
// A v2 lease also leaves no token in Redis: everything is keyed by its hash.
//
// Needs a Redis; skipped without one:
//   FOLDRUN_TEST_REDIS_URL=redis://127.0.0.1:6379 node --test tests/egress-oauth-rotation.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const REDIS = process.env.FOLDRUN_TEST_REDIS_URL;
const KEY = "egress-rotation-test-install-key-0123";
// The fake provider and API are on loopback.
process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE = "1";
process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-rotation-"));
process.env.FOLDRUN_SECRET_KEY = KEY;
// A released lease's rotation record is kept this long for a refresh still
// in flight; no wait here, each test settles it with a heartbeat.
process.env.FOLDRUN_EGRESS_ROTATION_GRACE_MS = "0";
if (REDIS) process.env.FOLDRUN_REDIS_URL = REDIS;

const { egressHooks, recordRotationForTest, renewEgressLeases, rotationAdvances, startEgressProxy, stopEgressProxy } = await import("../src/egress-proxy.ts");
const { egressKeyValues, leaseId, sealForLease } = await import("../src/egress-keys.ts");
const { cache } = await import("../src/cache.ts");
const { getSecret, setOAuth2Secret } = await import("../../foldrun-core/src/secrets.ts");

const CLIENT_SECRET = "client-secret-never-in-redis-7f3a";

/** A provider that rotates on every refresh and refuses a used token. */
function provider(beforeAnswer?: () => Promise<void>) {
  let current = "R0";
  let n = 0;
  const presented: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      await beforeAnswer?.();
      const rt = new URLSearchParams(body).get("refresh_token") ?? "";
      presented.push(rt);
      res.setHeader("content-type", "application/json");
      if (rt !== current) {
        res.writeHead(400).end(JSON.stringify({ error: "invalid_grant", error_description: `refresh token ${rt} was revoked` }));
        return;
      }
      n++;
      // The next in this chain: R0 → R1, S0 → S1.
      current = rt.replace(/\d+$/, (d) => String(Number(d) + 1));
      res.end(JSON.stringify({ access_token: `A${n}`, refresh_token: current, expires_in: 3600 }));
    });
  });
  return new Promise<{ url: string; presented: string[]; reconnect: (rt: string) => void; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}/token`,
        presented,
        // A person reconnects: the provider issues a fresh chain.
        reconnect: (rt: string) => void (current = rt),
        close: () => server.close(),
      }));
  });
}

/** The API the step calls: records the bearer it was sent. */
function api() {
  const auth: string[] = [];
  const server = http.createServer((req, res) => {
    auth.push(String(req.headers.authorization ?? ""));
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  return new Promise<{ host: string; auth: string[]; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ host: `127.0.0.1:${(server.address() as { port: number }).port}`, auth, close: () => server.close() }));
  });
}

const refreshOf = (stored: string | undefined) => (stored ? (JSON.parse(stored.slice(stored.indexOf("{"))) as { refresh_token: string }).refresh_token : null);

/** Replica B: its own process, so its token cache is empty; no install key. */
async function replicaWithoutKey(data: string, over: Record<string, string | undefined> = {}) {
  const port = 21000 + Math.floor(Math.random() * 1000);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FOLDRUN_ROLE: "egress",
    FOLDRUN_EGRESS_PORT: String(port),
    FOLDRUN_WORKER_PORT: String(port + 1000),
    FOLDRUN_EGRESS_URL: `http://127.0.0.1:${port}`,
    FOLDRUN_EGRESS_DRAIN_MS: "500",
    FOLDRUN_EGRESS_MINIMAL_BOOT: "1",
    FOLDRUN_INSTALL_KEY_ABSENT: "1",
    FOLDRUN_DATA: data,
    ...egressKeyValues(KEY),
  };
  delete env.FOLDRUN_SECRET_KEY;
  delete env.FOLDRUN_DATABASE_URL;
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "src/egress.ts"], { cwd: path.join(here, ".."), env });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) {
    ok = await fetch(`http://127.0.0.1:${port + 1000}/api/healthz`).then((r) => r.ok, () => false);
    if (!ok) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(ok, `replica B never became healthy:\n${log}`);
  return { port, log: () => log, stop: () => child.kill("SIGKILL") };
}

test("v2: a rotated refresh token reaches every replica, then the WORKSPACE vault; no token is left in Redis", { skip: !REDIS && "set FOLDRUN_TEST_REDIS_URL" }, async () => {
  const prov = await provider();
  const up = await api();
  const a = await startEgressProxy(0);
  const bData = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-rotation-b-"));
  const b = await replicaWithoutKey(bData);
  process.env.FOLDRUN_EGRESS_URL = `http://127.0.0.1:${a.port}`;
  process.env.FOLDRUN_EGRESS_LEASE_V2 = "1";
  try {
    // The same name in the account and in the workspace: the workspace's
    // is the one this step uses, and the only one a rotation may touch.
    setOAuth2Secret("acme", "CRM_TOKEN", { token_url: prov.url, client_id: "cid", client_secret: CLIENT_SECRET, refresh_token: "ACCOUNT-RT" });
    setOAuth2Secret("acme", "CRM_TOKEN", { token_url: prov.url, client_id: "cid", client_secret: CLIENT_SECRET, refresh_token: "R0" }, "desk");
    const stored = getSecret("acme", "CRM_TOKEN", "desk")!.value;
    assert.equal(refreshOf(stored), "R0");

    const grant = {
      secrets: { CRM_TOKEN: { value: stored, hosts: [up.host] } },
      healthKeys: { CRM_TOKEN: "workspace:desk:CRM_TOKEN" },
    };
    const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-rot-v2", grant, who: { workspace: "desk", agent: "writer" } }))!;
    const token = lease.url.split("/e/")[1]!;
    const call = async (port: number) => {
      const r = await fetch(`http://127.0.0.1:${port}/e/${token}/http://${up.host}/v1/things`, { headers: { authorization: "Bearer ${CRM_TOKEN}" } });
      assert.equal(r.status, 200, `replica on ${port} answered ${r.status}: ${await r.text()}\n${b.log()}`);
    };

    // Replica A refreshes: R0 → R1, which the provider now requires.
    await call(a.port);
    assert.deepEqual(prov.presented, ["R0"]);
    assert.equal(up.auth.at(-1), "Bearer A1");
    // The proxy did not write the vault (a v2 proxy need not be able to).
    assert.equal(refreshOf(getSecret("acme", "CRM_TOKEN", "desk")!.value), "R0");

    // Replica B, a cold cache: it must refresh with R1, never the revoked R0.
    await call(b.port);
    assert.deepEqual(prov.presented, ["R0", "R1"], b.log());
    assert.equal(up.auth.at(-1), "Bearer A2");

    // Nothing in Redis carries the token, or a secret in the clear.
    const r = cache()!;
    const everything: string[] = [];
    let cursor = "0";
    do {
      const [next, keys] = await r.scan(cursor, "COUNT", 200);
      cursor = next;
      for (const k of keys) {
        everything.push(k);
        const type = await r.type(k);
        if (type === "string") everything.push((await r.get(k)) ?? "");
        else if (type === "set") everything.push(...(await r.smembers(k)));
        else if (type === "list") everything.push(...(await r.lrange(k, 0, -1)));
        else if (type === "hash") everything.push(...Object.entries(await r.hgetall(k)).flat());
        else if (type === "zset") everything.push(...(await r.zrange(k, 0, -1)));
      }
    } while (cursor !== "0");
    const id = leaseId(token);
    assert.ok(everything.includes(`egress:lease:${id}`), "the lease is there, under its hash");
    assert.ok(everything.includes(`egress:rot:${id}`), "and the rotation beside it");
    for (const v of everything) {
      assert.ok(!v.includes(token), `the lease token is in Redis: ${v.slice(0, 120)}`);
      assert.ok(!v.includes(CLIENT_SECRET), `a secret is in Redis in the clear: ${v.slice(0, 120)}`);
    }

    // The worker's heartbeat writes the newest refresh token to the copy the
    // grant came from — the workspace's — and leaves the account's alone.
    await renewEgressLeases("run-rot-v2");
    assert.equal(refreshOf(getSecret("acme", "CRM_TOKEN", "desk")!.value), "R2");
    assert.equal(refreshOf(getSecret("acme", "CRM_TOKEN")!.value), "ACCOUNT-RT");

    // A later rotation, and the release: the vault ends on the newest.
    await call(a.port);
    assert.equal(prov.presented.at(-1), "R2");
    await lease.release();
    assert.equal(refreshOf(getSecret("acme", "CRM_TOKEN", "desk")!.value), "R3");
    // Settled once the grace is over — by the release's own timer or a
    // heartbeat, whichever holds the settle lock first.
    for (let i = 0; i < 40 && (await r.exists(`egress:rot:${id}`)); i++) {
      await renewEgressLeases("any-run");
      await new Promise((res) => setTimeout(res, 100));
    }
    assert.equal(await r.exists(`egress:rot:${id}`), 0, "the rotation record goes once the release's grace is over");
    assert.equal(await r.sismember("egress:recovering", id), 0, "and it is off the recovery list");
    assert.equal(fs.existsSync(path.join(bData, ".secret-key")), false, "replica B never made an install key");
  } finally {
    delete process.env.FOLDRUN_EGRESS_URL;
    delete process.env.FOLDRUN_EGRESS_LEASE_V2;
    b.stop();
    await stopEgressProxy();
    prov.close();
    up.close();
  }
});

test("v2: a rotation the vault cannot take at release is kept, and saved on a later heartbeat; a re-grant starts a new chain", { skip: !REDIS && "set FOLDRUN_TEST_REDIS_URL" }, async () => {
  const prov = await provider();
  const up = await api();
  const a = await startEgressProxy(0);
  process.env.FOLDRUN_EGRESS_URL = `http://127.0.0.1:${a.port}`;
  process.env.FOLDRUN_EGRESS_LEASE_V2 = "1";
  const deskDir = path.join(process.env.FOLDRUN_DATA!, "gamma", "workspaces", "desk");
  try {
    const config = (rt: string) => ({ token_url: prov.url, client_id: "cid", client_secret: CLIENT_SECRET, refresh_token: rt });
    setOAuth2Secret("gamma", "CRM_TOKEN", config("R0"), "desk");
    const grant = {
      secrets: { CRM_TOKEN: { value: getSecret("gamma", "CRM_TOKEN", "desk")!.value, hosts: [up.host] } },
      healthKeys: { CRM_TOKEN: "workspace:desk:CRM_TOKEN" },
    };
    const call = async (url: string) => {
      const r = await fetch(`${url}/http://${up.host}/v1/things`, { headers: { authorization: "Bearer ${CRM_TOKEN}" } });
      assert.equal(r.status, 200, await r.text());
    };

    // A re-grant (a person reconnected mid-step) starts a new chain: the
    // worker compares against the new grant, not what it wrote for the old.
    const one = (await egressHooks.lease({ tenant: "gamma", runId: "run-regrant", grant }))!;
    await call(one.url);
    await renewEgressLeases("run-regrant");
    assert.equal(refreshOf(getSecret("gamma", "CRM_TOKEN", "desk")!.value), "R1");
    prov.reconnect("S0");
    setOAuth2Secret("gamma", "CRM_TOKEN", config("S0"), "desk");
    grant.secrets.CRM_TOKEN.value = getSecret("gamma", "CRM_TOKEN", "desk")!.value;
    await one.commit();
    await call(one.url);
    assert.equal(prov.presented.at(-1), "S0", "the new grant is used, not the old chain's rotation");
    await renewEgressLeases("run-regrant");
    assert.equal(refreshOf(getSecret("gamma", "CRM_TOKEN", "desk")!.value), "S1");
    await one.release();

    // Release while the vault refuses the write: the lease goes, the
    // rotation record stays, and the next heartbeat (of any run) saves it.
    // A fresh chain, so this lease refreshes (S1's access token is cached).
    prov.reconnect("T0");
    setOAuth2Secret("gamma", "CRM_TOKEN", config("T0"), "desk");
    grant.secrets.CRM_TOKEN.value = getSecret("gamma", "CRM_TOKEN", "desk")!.value;
    const two = (await egressHooks.lease({ tenant: "gamma", runId: "run-release-fail", grant }))!;
    const id = leaseId(two.url.split("/e/")[1]!);
    await call(two.url);
    assert.equal(prov.presented.at(-1), "T0");
    process.env.FOLDRUN_EGRESS_ROTATION_GRACE_MS = "60000";
    fs.chmodSync(deskDir, 0o500);
    try {
      await two.release();
    } finally {
      fs.chmodSync(deskDir, 0o700);
    }
    const r = cache()!;
    assert.equal(await r.exists(`egress:lease:${id}`), 0, "the lease is gone");
    assert.equal(await r.exists(`egress:rot:${id}`), 1, "its unsaved rotation is not");
    assert.equal(refreshOf(getSecret("gamma", "CRM_TOKEN", "desk")!.value), "T0");
    await renewEgressLeases("some-other-run");
    assert.equal(await r.exists(`egress:rot:${id}`), 1, "kept through the grace, for a refresh still in flight");
    await renewEgressLeases("some-other-run", Date.now() + 61_000);
    assert.equal(refreshOf(getSecret("gamma", "CRM_TOKEN", "desk")!.value), "T1");
    assert.equal(await r.exists(`egress:rot:${id}`), 0, "saved, and then gone");
  } finally {
    process.env.FOLDRUN_EGRESS_ROTATION_GRACE_MS = "0";
    delete process.env.FOLDRUN_EGRESS_URL;
    delete process.env.FOLDRUN_EGRESS_LEASE_V2;
    await stopEgressProxy();
    prov.close();
    up.close();
  }
});

test("v2: a worker that takes the run over saves what the proxy rotated under the one before it", { skip: !REDIS && "set FOLDRUN_TEST_REDIS_URL" }, async () => {
  const prov = await provider();
  const up = await api();
  const a = await startEgressProxy(0);
  process.env.FOLDRUN_EGRESS_URL = `http://127.0.0.1:${a.port}`;
  process.env.FOLDRUN_EGRESS_LEASE_V2 = "1";
  const here = path.dirname(fileURLToPath(import.meta.url));
  // The worker after a restart: its own process, nothing in memory from the
  // one that wrote the lease — only Redis, the vault and the install key.
  const script = path.join(process.env.FOLDRUN_DATA!, "next-worker.mjs");
  fs.writeFileSync(script, `const p = await import(${JSON.stringify(path.join(here, "..", "src", "egress-proxy.ts"))});
const c = await import(${JSON.stringify(path.join(here, "..", "src", "cache.ts"))});
if (process.argv[2] === "--idle") {
  // A worker with no run to drive: only its own recovery loop.
  const stop = p.startEgressRotationRecovery(100);
  await new Promise((r) => setTimeout(r, 1500));
  stop();
} else {
  await p.renewEgressLeases(process.argv[2] ?? "run-recover", Date.now() + Number(process.argv[3] ?? 0));
}
c.cache()?.disconnect();
`);
  const nextWorker = (runId = "run-recover", aheadMs = 0, env: NodeJS.ProcessEnv = {}) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", script, runId, String(aheadMs)], { env: { ...process.env, ...env } });
      let log = "";
      child.stderr.on("data", (d) => (log += d));
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`next worker exited ${code}: ${log}`))));
    });
  try {
    setOAuth2Secret("delta", "CRM_TOKEN", { token_url: prov.url, client_id: "cid", client_secret: CLIENT_SECRET, refresh_token: "R0" }, "desk");
    const grant = {
      secrets: { CRM_TOKEN: { value: getSecret("delta", "CRM_TOKEN", "desk")!.value, hosts: [up.host] } },
      healthKeys: { CRM_TOKEN: "workspace:desk:CRM_TOKEN" },
    };
    const lease = (await egressHooks.lease({ tenant: "delta", runId: "run-recover", grant }))!;
    const token = lease.url.split("/e/")[1]!;
    const call = async (port: number) => {
      const r = await fetch(`http://127.0.0.1:${port}/e/${token}/http://${up.host}/v1/things`, { headers: { authorization: "Bearer ${CRM_TOKEN}" } });
      assert.equal(r.status, 200, await r.text());
    };
    await call(a.port);
    // The worker before died between checkpointing its intent and writing
    // the vault: the next one finishes the write.
    const id = leaseId(token);
    const r0 = grant.secrets.CRM_TOKEN.value;
    const r1 = r0.replace('"refresh_token":"R0"', '"refresh_token":"R1"');
    assert.notEqual(r1, r0);
    await cache()!.hset(`egress:rot:${id}`, "CRM_TOKEN@saved", sealForLease(token, `${id}|saved|CRM_TOKEN`, JSON.stringify({ base: r0, value: r1, prev: r0, done: false })));
    await nextWorker();
    assert.equal(refreshOf(getSecret("delta", "CRM_TOKEN", "desk")!.value), "R1", "recovered from Redis and saved");
    // Again (on a replica with a cold cache, so it refreshes), from what the
    // last worker saved — not from the chain's start, which the vault no
    // longer holds.
    const b = await replicaWithoutKey(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-rotation-b2-")));
    try {
      await call(b.port);
    } finally {
      b.stop();
    }
    assert.equal(prov.presented.at(-1), "R1");
    await nextWorker();
    assert.equal(refreshOf(getSecret("delta", "CRM_TOKEN", "desk")!.value), "R2");
    await lease.release();
    assert.equal(refreshOf(getSecret("delta", "CRM_TOKEN", "desk")!.value), "R2");

    // Released while the vault refused the write, and the worker that
    // released it never comes back: the recovery record (no grant, no
    // authority) lets the next worker save it once the grace is over.
    process.env.FOLDRUN_EGRESS_ROTATION_GRACE_MS = "60000";
    setOAuth2Secret("delta", "CRM_TOKEN", { token_url: prov.url, client_id: "cid", client_secret: CLIENT_SECRET, refresh_token: "U0" }, "desk");
    prov.reconnect("U0");
    grant.secrets.CRM_TOKEN.value = getSecret("delta", "CRM_TOKEN", "desk")!.value;
    const gone = (await egressHooks.lease({ tenant: "delta", runId: "run-released", grant }))!;
    const goneId = leaseId(gone.url.split("/e/")[1]!);
    const g = await fetch(`${gone.url}/http://${up.host}/v1/things`, { headers: { authorization: "Bearer ${CRM_TOKEN}" } });
    assert.equal(g.status, 200, await g.text());
    assert.equal(prov.presented.at(-1), "U0");
    const deskDir = path.join(process.env.FOLDRUN_DATA!, "delta", "workspaces", "desk");
    fs.chmodSync(deskDir, 0o500);
    try {
      await gone.release();
    } finally {
      fs.chmodSync(deskDir, 0o700);
    }
    const rc = cache()!;
    assert.equal(await rc.exists(`egress:lease:${goneId}`), 0);
    assert.equal(await rc.exists(`egress:recover:${goneId}`), 1, "a recovery record while the rotation is unsaved");
    assert.equal(await rc.sismember("egress:recovering", goneId), 1);
    const recovery = (await rc.get(`egress:recover:${goneId}`))!;
    assert.ok(!recovery.includes(gone.url.split("/e/")[1]!), "the recovery record holds no token");
    assert.ok(!recovery.includes(CLIENT_SECRET), "nor a secret");
    await nextWorker("unrelated-run");
    assert.equal(refreshOf(getSecret("delta", "CRM_TOKEN", "desk")!.value), "U0", "not during the grace");
    await nextWorker("unrelated-run", 61_000);
    assert.equal(refreshOf(getSecret("delta", "CRM_TOKEN", "desk")!.value), "U1", "saved by the next worker");
    assert.equal(await rc.exists(`egress:rot:${goneId}`), 0);
    assert.equal(await rc.sismember("egress:recovering", goneId), 0);

    // A proxy that could not reach Redis writes its rotation after all that
    // (its background retry): the lease goes back on the recovery list, and
    // the next worker saves it over the older rotation in the vault.
    const u1 = getSecret("delta", "CRM_TOKEN", "desk")!.value;
    const u2 = u1.replace('"refresh_token":"U1"', '"refresh_token":"U2"');
    assert.notEqual(u2, u1);
    assert.equal(await recordRotationForTest(gone.url.split("/e/")[1]!, "CRM_TOKEN", { base: grant.secrets.CRM_TOKEN.value, next: u2 }, u1, { tenant: "delta", runId: "run-released", healthKeys: grant.healthKeys }), true);
    assert.equal(await rc.sismember("egress:recovering", goneId), 1, "back on the list");
    await nextWorker("unrelated-run", 61_000);
    assert.equal(refreshOf(getSecret("delta", "CRM_TOKEN", "desk")!.value), "U2", "saved, late as it was");

    // And by a worker with no run to drive: its own recovery loop does it.
    const u3 = u1.replace('"refresh_token":"U1"', '"refresh_token":"U3"');
    assert.equal(await recordRotationForTest(gone.url.split("/e/")[1]!, "CRM_TOKEN", { base: grant.secrets.CRM_TOKEN.value, next: u3 }, u2, { tenant: "delta", runId: "run-released", healthKeys: grant.healthKeys }), true);
    assert.equal(await rc.sismember("egress:recovering", goneId), 1);
    await nextWorker("--idle", 0, { FOLDRUN_EGRESS_ROTATION_GRACE_MS: "0" });
    assert.equal(refreshOf(getSecret("delta", "CRM_TOKEN", "desk")!.value), "U3", "saved by an idle worker");
    assert.equal(await rc.sismember("egress:recovering", goneId), 0);

    // A worker that died with a lease still live (never released, its run
    // never resumed): another worker's recovery loop finds the lease by its
    // rotation record once the run has been silent long enough.
    setOAuth2Secret("delta", "CRM_TOKEN", { token_url: prov.url, client_id: "cid", client_secret: CLIENT_SECRET, refresh_token: "W0" }, "desk");
    prov.reconnect("W0");
    grant.secrets.CRM_TOKEN.value = getSecret("delta", "CRM_TOKEN", "desk")!.value;
    const orphan = (await egressHooks.lease({ tenant: "delta", runId: "run-orphan", grant }))!;
    const o = await fetch(`${orphan.url}/http://${up.host}/v1/things`, { headers: { authorization: "Bearer ${CRM_TOKEN}" } });
    assert.equal(o.status, 200, await o.text());
    assert.equal(prov.presented.at(-1), "W0");
    await nextWorker("--idle", 0, { FOLDRUN_EGRESS_ORPHAN_MS: "60000" });
    assert.equal(refreshOf(getSecret("delta", "CRM_TOKEN", "desk")!.value), "W0", "not while its run is fresh");
    await nextWorker("--idle", 0, { FOLDRUN_EGRESS_ORPHAN_MS: "0" });
    assert.equal(refreshOf(getSecret("delta", "CRM_TOKEN", "desk")!.value), "W1", "saved from the orphaned lease");
    await orphan.release();
    assert.equal(refreshOf(getSecret("delta", "CRM_TOKEN", "desk")!.value), "W1");
  } finally {
    process.env.FOLDRUN_EGRESS_ROTATION_GRACE_MS = "0";
    delete process.env.FOLDRUN_EGRESS_URL;
    delete process.env.FOLDRUN_EGRESS_LEASE_V2;
    await stopEgressProxy();
    prov.close();
    up.close();
  }
});

test("a rotation replaces only the record it started from", () => {
  const r = (base: string, next: string) => ({ base, next });
  assert.equal(rotationAdvances(null, r("B", "N1"), "B"), "write");
  assert.equal(rotationAdvances(r("OTHER", "X"), r("B", "N1"), "B"), "write", "another chain's record");
  assert.equal(rotationAdvances(r("B", "N1"), r("B", "N2"), "N1"), "write", "from the recorded one");
  assert.equal(rotationAdvances(r("B", "N1"), r("B", "N1"), "B"), "same");
  assert.equal(rotationAdvances(r("B", "N2"), r("B", "N1"), "B"), "stale", "a delayed callback, older than the record");
});

for (const v2 of [true, false]) {
  test(`${v2 ? "v2" : "v1"}: a delayed rotation never overwrites a newer one, and racing writers leave exactly one`, { skip: !REDIS && "set FOLDRUN_TEST_REDIS_URL" }, async () => {
    process.env.FOLDRUN_EGRESS_URL = "http://127.0.0.1:1";
    if (v2) process.env.FOLDRUN_EGRESS_LEASE_V2 = "1";
    else delete process.env.FOLDRUN_EGRESS_LEASE_V2;
    try {
      const lease = (await egressHooks.lease({ tenant: "acme", runId: `run-cas-${v2}`, grant: { secrets: {} } }))!;
      const token = lease.url.split("/e/")[1]!;
      const rot = (next: string) => ({ base: "B", next });
      assert.equal(await recordRotationForTest(token, "K", rot("N1"), "B"), true);
      assert.equal(await recordRotationForTest(token, "K", rot("N2"), "N1"), true);
      // Two requests shared the exchange B → N1; the second's callback is late.
      assert.equal(await recordRotationForTest(token, "K", rot("N1"), "B"), false, "stale: N2 is newer");
      // Five refreshes from N2 at once (racing replicas): one record wins,
      // the rest see it and stand down.
      const results = await Promise.all([1, 2, 3, 4, 5].map((i) => recordRotationForTest(token, "K", rot(`M${i}`), "N2")));
      assert.equal(results.filter(Boolean).length, 1, JSON.stringify(results));
      await lease.release();
    } finally {
      delete process.env.FOLDRUN_EGRESS_URL;
      delete process.env.FOLDRUN_EGRESS_LEASE_V2;
    }
  });
}

test("v2: a rotation the store refused is written by the proxy's background retry, with no further request", { skip: !REDIS && "set FOLDRUN_TEST_REDIS_URL" }, async () => {
  let block: (() => Promise<void>) | null = null;
  const prov = await provider(async () => {
    await block?.();
  });
  const up = await api();
  const a = await startEgressProxy(0);
  process.env.FOLDRUN_EGRESS_URL = `http://127.0.0.1:${a.port}`;
  process.env.FOLDRUN_EGRESS_LEASE_V2 = "1";
  try {
    setOAuth2Secret("eps", "CRM_TOKEN", { token_url: prov.url, client_id: "cid", client_secret: CLIENT_SECRET, refresh_token: "R0" }, "desk");
    const grant = {
      secrets: { CRM_TOKEN: { value: getSecret("eps", "CRM_TOKEN", "desk")!.value, hosts: [up.host] } },
      healthKeys: { CRM_TOKEN: "workspace:desk:CRM_TOKEN" },
    };
    const lease = (await egressHooks.lease({ tenant: "eps", runId: "run-unsaved", grant }))!;
    const id = leaseId(lease.url.split("/e/")[1]!);
    const rc = cache()!;
    // While the provider answers (after the proxy read the record, before it
    // writes one), the record's key turns into something Redis refuses to
    // write a field to: the store fails exactly when the token has rotated.
    block = async () => {
      await rc.set(`egress:rot:${id}`, "not a hash");
    };
    const r = await fetch(`${lease.url}/http://${up.host}/v1/things`, { headers: { authorization: "Bearer ${CRM_TOKEN}" } });
    assert.equal(r.status, 200, await r.text());
    block = null;
    assert.equal(await rc.type(`egress:rot:${id}`), "string", "the write was refused");
    await rc.del(`egress:rot:${id}`); // the store recovers
    // No request follows: the background retry records it.
    let recorded = false;
    for (let i = 0; i < 40 && !recorded; i++) {
      recorded = (await rc.hlen(`egress:rot:${id}`)) > 0;
      if (!recorded) await new Promise((res) => setTimeout(res, 250));
    }
    assert.ok(recorded, "the held rotation reached the store on its own");
    await renewEgressLeases("run-unsaved");
    assert.equal(refreshOf(getSecret("eps", "CRM_TOKEN", "desk")!.value), "R1");
    await lease.release();
  } finally {
    delete process.env.FOLDRUN_EGRESS_URL;
    delete process.env.FOLDRUN_EGRESS_LEASE_V2;
    await stopEgressProxy();
    prov.close();
    up.close();
  }
});

test("v2: two leases holding one credential each save their rotations, and the vault ends on the newest", { skip: !REDIS && "set FOLDRUN_TEST_REDIS_URL" }, async () => {
  const prov = await provider();
  const up = await api();
  const a = await startEgressProxy(0);
  process.env.FOLDRUN_EGRESS_URL = `http://127.0.0.1:${a.port}`;
  process.env.FOLDRUN_EGRESS_LEASE_V2 = "1";
  try {
    setOAuth2Secret("zeta", "CRM_TOKEN", { token_url: prov.url, client_id: "cid", client_secret: CLIENT_SECRET, refresh_token: "R0" }, "desk");
    const value = getSecret("zeta", "CRM_TOKEN", "desk")!.value;
    const grantOf = () => ({ secrets: { CRM_TOKEN: { value, hosts: [up.host] } }, healthKeys: { CRM_TOKEN: "workspace:desk:CRM_TOKEN" } });
    // Two parallel steps of one run, the same workspace secret.
    const one = (await egressHooks.lease({ tenant: "zeta", runId: "run-shared", grant: grantOf() }))!;
    const two = (await egressHooks.lease({ tenant: "zeta", runId: "run-shared", grant: grantOf() }))!;
    const call = async (port: number, url: string) => {
      const token = url.split("/e/")[1]!;
      const r = await fetch(`http://127.0.0.1:${port}/e/${token}/http://${up.host}/v1/things`, { headers: { authorization: "Bearer ${CRM_TOKEN}" } });
      assert.equal(r.status, 200, await r.text());
    };
    // One exchange R0 → R1, shared by both leases (the proxy's token cache):
    // both record R0 → R1.
    await call(a.port, one.url);
    await call(a.port, two.url);
    assert.deepEqual(prov.presented, ["R0"]);
    // The second goes on alone, on a replica with a cold cache: R1 → R2.
    const b = await replicaWithoutKey(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-rotation-shared-")));
    try {
      await call(b.port, two.url);
    } finally {
      b.stop();
    }
    assert.deepEqual(prov.presented, ["R0", "R1"]);
    // The heartbeat saves the first's R1, then the second's R2 over it: the
    // vault holds R1, which a rotation made and R2 succeeds.
    await renewEgressLeases("run-shared");
    assert.equal(refreshOf(getSecret("zeta", "CRM_TOKEN", "desk")!.value), "R2");
    await renewEgressLeases("run-shared");
    await one.release();
    await two.release();
    assert.equal(refreshOf(getSecret("zeta", "CRM_TOKEN", "desk")!.value), "R2", "never back to an older one");

    // A person reconnects while a lease still holds an unsaved rotation from
    // before: the reconnect is not a value any rotation made, so it stays.
    const three = (await egressHooks.lease({ tenant: "zeta", runId: "run-shared-2", grant: { secrets: { CRM_TOKEN: { value: getSecret("zeta", "CRM_TOKEN", "desk")!.value, hosts: [up.host] } }, healthKeys: { CRM_TOKEN: "workspace:desk:CRM_TOKEN" } } }))!;
    const b2 = await replicaWithoutKey(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-rotation-shared2-")));
    try {
      await call(b2.port, three.url);
    } finally {
      b2.stop();
    }
    setOAuth2Secret("zeta", "CRM_TOKEN", { token_url: prov.url, client_id: "cid", client_secret: CLIENT_SECRET, refresh_token: "P0" }, "desk");
    await renewEgressLeases("run-shared-2");
    assert.equal(refreshOf(getSecret("zeta", "CRM_TOKEN", "desk")!.value), "P0", "a reconnect is never overwritten");
    await three.release();
  } finally {
    delete process.env.FOLDRUN_EGRESS_URL;
    delete process.env.FOLDRUN_EGRESS_LEASE_V2;
    await stopEgressProxy();
    prov.close();
    up.close();
  }
});

test("v2: a lease issued before the worker saved another lease's rotation follows it to the newest token", { skip: !REDIS && "set FOLDRUN_TEST_REDIS_URL" }, async () => {
  const prov = await provider();
  const up = await api();
  const a = await startEgressProxy(0);
  process.env.FOLDRUN_EGRESS_URL = `http://127.0.0.1:${a.port}`;
  process.env.FOLDRUN_EGRESS_LEASE_V2 = "1";
  try {
    setOAuth2Secret("eta", "CRM_TOKEN", { token_url: prov.url, client_id: "cid", client_secret: CLIENT_SECRET, refresh_token: "R0" }, "desk");
    const grantNow = () => ({ secrets: { CRM_TOKEN: { value: getSecret("eta", "CRM_TOKEN", "desk")!.value, hosts: [up.host] } }, healthKeys: { CRM_TOKEN: "workspace:desk:CRM_TOKEN" } });
    const call = async (port: number, url: string) => {
      const r = await fetch(`http://127.0.0.1:${port}/e/${url.split("/e/")[1]}/http://${up.host}/v1/things`, { headers: { authorization: "Bearer ${CRM_TOKEN}" } });
      assert.equal(r.status, 200, await r.text());
    };
    const first = (await egressHooks.lease({ tenant: "eta", runId: "run-pending-1", grant: grantNow() }))!;
    await call(a.port, first.url);
    assert.equal(refreshOf(getSecret("eta", "CRM_TOKEN", "desk")!.value), "R0", "not saved yet");
    // Another step starts now: its grant is the vault's R0, which the
    // provider has revoked. A cold replica must still send R1.
    const second = (await egressHooks.lease({ tenant: "eta", runId: "run-pending-2", grant: grantNow() }))!;
    const b = await replicaWithoutKey(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-rotation-pending-")));
    try {
      await call(b.port, second.url);
    } finally {
      b.stop();
    }
    assert.deepEqual(prov.presented, ["R0", "R1"]);
    // Both saved; the vault ends on the newest.
    await renewEgressLeases("run-pending-1");
    await renewEgressLeases("run-pending-2");
    assert.equal(refreshOf(getSecret("eta", "CRM_TOKEN", "desk")!.value), "R2");
    await first.release();
    await second.release();
    assert.equal(refreshOf(getSecret("eta", "CRM_TOKEN", "desk")!.value), "R2");
  } finally {
    delete process.env.FOLDRUN_EGRESS_URL;
    delete process.env.FOLDRUN_EGRESS_LEASE_V2;
    await stopEgressProxy();
    prov.close();
    up.close();
  }
});

test("v2: a quiet long-lived lease's heartbeat keeps its credential's rotation history alive", { skip: !REDIS && "set FOLDRUN_TEST_REDIS_URL" }, async () => {
  const prov = await provider();
  const up = await api();
  const a = await startEgressProxy(0);
  process.env.FOLDRUN_EGRESS_URL = `http://127.0.0.1:${a.port}`;
  process.env.FOLDRUN_EGRESS_LEASE_V2 = "1";
  const r = cache()!;
  try {
    setOAuth2Secret("iota", "CRM_TOKEN", { token_url: prov.url, client_id: "cid", client_secret: CLIENT_SECRET, refresh_token: "R0" }, "desk");
    const grantNow = () => ({ secrets: { CRM_TOKEN: { value: getSecret("iota", "CRM_TOKEN", "desk")!.value, hosts: [up.host] } }, healthKeys: { CRM_TOKEN: "workspace:desk:CRM_TOKEN" } });
    // The long one holds R0 and says nothing for hours; another step of
    // another run rotates the same credential, and finishes.
    const quiet = (await egressHooks.lease({ tenant: "iota", runId: "run-quiet", grant: grantNow() }))!;
    const busy = (await egressHooks.lease({ tenant: "iota", runId: "run-busy", grant: grantNow() }))!;
    const rr = await fetch(`${busy.url}/http://${up.host}/v1/things`, { headers: { authorization: "Bearer ${CRM_TOKEN}" } });
    assert.equal(rr.status, 200, await rr.text());
    const keysOf = async (pattern: string) => {
      const out: string[] = [];
      let cursor = "0";
      do {
        const [next, keys] = await r.scan(cursor, "MATCH", pattern, "COUNT", 500);
        cursor = next;
        out.push(...keys);
      } while (cursor !== "0");
      return out;
    };
    // This credential's records: the only ones the busy lease's rotation made.
    const id = leaseId(quiet.url.split("/e/")[1]!);
    const creds = await r.smembers(`egress:creds:${id}`);
    assert.equal(creds.length, 1, "the quiet lease names the credential it holds");
    const succ = `egress:succ:${creds[0]}`;
    const rotated = `egress:rotated:${creds[0]}`;
    assert.ok((await keysOf(succ)).length === 1 && (await keysOf(rotated)).length === 1);
    // Hours pass: the history is about to expire.
    await r.pexpire(succ, 2_000);
    await r.pexpire(rotated, 2_000);
    // The quiet lease's run beats: its credential's history lives on with it.
    await renewEgressLeases("run-quiet");
    assert.ok((await r.ttl(succ)) > 3600, `succ ttl ${await r.ttl(succ)}`);
    assert.ok((await r.ttl(rotated)) > 3600, `rotated ttl ${await r.ttl(rotated)}`);
    await busy.release();
    await quiet.release();
    assert.equal(await r.exists(`egress:creds:${id}`), 0, "and goes with the lease");
  } finally {
    delete process.env.FOLDRUN_EGRESS_URL;
    delete process.env.FOLDRUN_EGRESS_LEASE_V2;
    await stopEgressProxy();
    prov.close();
    up.close();
  }
});

test("a workspace secret's rotation never lands on an account secret holding the same value", { skip: !REDIS && "set FOLDRUN_TEST_REDIS_URL" }, async () => {
  const prov = await provider();
  const up = await api();
  const a = await startEgressProxy(0);
  process.env.FOLDRUN_EGRESS_URL = `http://127.0.0.1:${a.port}`;
  delete process.env.FOLDRUN_EGRESS_LEASE_V2;
  try {
    // The same connection stored twice, byte for byte.
    const config = { token_url: prov.url, client_id: "cid", client_secret: CLIENT_SECRET, refresh_token: "R0" };
    setOAuth2Secret("kappa", "CRM_TOKEN", config);
    setOAuth2Secret("kappa", "CRM_TOKEN", config, "desk");
    const value = getSecret("kappa", "CRM_TOKEN", "desk")!.value;
    assert.equal(getSecret("kappa", "CRM_TOKEN")!.value, value);
    const lease = (await egressHooks.lease({ tenant: "kappa", runId: "run-scope", grant: { secrets: { CRM_TOKEN: { value, hosts: [up.host] } }, healthKeys: { CRM_TOKEN: "workspace:desk:CRM_TOKEN" } } }))!;
    const r = await fetch(`${lease.url}/http://${up.host}/v1/things`, { headers: { authorization: "Bearer ${CRM_TOKEN}" } });
    assert.equal(r.status, 200, await r.text());
    assert.equal(refreshOf(getSecret("kappa", "CRM_TOKEN", "desk")!.value), "R1");
    // The worker's merge at release compares against R0 again: the
    // workspace copy no longer holds it, and the account's must not take it.
    await lease.release();
    assert.equal(refreshOf(getSecret("kappa", "CRM_TOKEN", "desk")!.value), "R1");
    assert.equal(refreshOf(getSecret("kappa", "CRM_TOKEN")!.value), "R0", "the account's copy untouched");
  } finally {
    delete process.env.FOLDRUN_EGRESS_URL;
    await stopEgressProxy();
    prov.close();
    up.close();
  }
});

test("v1: the proxy writes a workspace secret's rotated refresh token to the workspace, not the account", { skip: !REDIS && "set FOLDRUN_TEST_REDIS_URL" }, async () => {
  const prov = await provider();
  const up = await api();
  const a = await startEgressProxy(0);
  process.env.FOLDRUN_EGRESS_URL = `http://127.0.0.1:${a.port}`;
  delete process.env.FOLDRUN_EGRESS_LEASE_V2;
  try {
    setOAuth2Secret("beta", "CRM_TOKEN", { token_url: prov.url, client_id: "cid", client_secret: CLIENT_SECRET, refresh_token: "ACCOUNT-RT" });
    setOAuth2Secret("beta", "CRM_TOKEN", { token_url: prov.url, client_id: "cid", client_secret: CLIENT_SECRET, refresh_token: "R0" }, "desk");
    const stored = getSecret("beta", "CRM_TOKEN", "desk")!.value;
    const grant = { secrets: { CRM_TOKEN: { value: stored, hosts: [up.host] } }, healthKeys: { CRM_TOKEN: "workspace:desk:CRM_TOKEN" } };
    const lease = (await egressHooks.lease({ tenant: "beta", runId: "run-rot-v1", grant }))!;
    const token = lease.url.split("/e/")[1]!;
    const r = await fetch(`http://127.0.0.1:${a.port}/e/${token}/http://${up.host}/v1/things`, { headers: { authorization: "Bearer ${CRM_TOKEN}" } });
    assert.equal(r.status, 200, await r.text());
    assert.equal(refreshOf(getSecret("beta", "CRM_TOKEN", "desk")!.value), "R1", "written where it came from");
    assert.equal(refreshOf(getSecret("beta", "CRM_TOKEN")!.value), "ACCOUNT-RT", "the account's copy untouched");
    await lease.release();

    // The proxy's own vault write fails (R1 → R2 here): the worker makes it
    // from the rotation record when it releases the lease.
    const grant2 = { secrets: { CRM_TOKEN: { value: getSecret("beta", "CRM_TOKEN", "desk")!.value, hosts: [up.host] } }, healthKeys: { CRM_TOKEN: "workspace:desk:CRM_TOKEN" } };
    const lease2 = (await egressHooks.lease({ tenant: "beta", runId: "run-rot-v1b", grant: grant2 }))!;
    const deskDir = path.join(process.env.FOLDRUN_DATA!, "beta", "workspaces", "desk");
    // R1's access token is cached in this process; a cold replica refreshes.
    const b = await replicaWithoutKey(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-rotation-v1b-")), { FOLDRUN_SECRET_KEY: KEY, FOLDRUN_EGRESS_MINIMAL_BOOT: undefined, FOLDRUN_INSTALL_KEY_ABSENT: undefined, FOLDRUN_DATA: process.env.FOLDRUN_DATA });
    fs.chmodSync(deskDir, 0o500);
    try {
      const r2 = await fetch(`http://127.0.0.1:${b.port}/e/${lease2.url.split("/e/")[1]}/http://${up.host}/v1/things`, { headers: { authorization: "Bearer ${CRM_TOKEN}" } });
      assert.equal(r2.status, 200, await r2.text());
    } finally {
      fs.chmodSync(deskDir, 0o700);
      b.stop();
    }
    assert.equal(prov.presented.at(-1), "R1");
    assert.equal(refreshOf(getSecret("beta", "CRM_TOKEN", "desk")!.value), "R1", "the proxy's write failed");
    await lease2.release();
    assert.equal(refreshOf(getSecret("beta", "CRM_TOKEN", "desk")!.value), "R2", "made at release");
  } finally {
    delete process.env.FOLDRUN_EGRESS_URL;
    await stopEgressProxy();
    prov.close();
    up.close();
    // The shared client would hold the test process open.
    cache()?.disconnect();
  }
});
