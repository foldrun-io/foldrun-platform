// The egress proxy as its own role (egress.ts): its health answer, its
// drain on SIGTERM, and the role name boot accepts.
//
//   node --test tests/egress-role.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drainEgressProxy, startEgressProxy } from "../src/egress-proxy.ts";
import { egressHealth } from "../src/egress.ts";
import { roleOf } from "../src/boot.ts";

test("egress is a role boot accepts", () => {
  const prev = process.env.FOLDRUN_ROLE;
  process.env.FOLDRUN_ROLE = "egress";
  try {
    assert.equal(roleOf(), "egress");
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_ROLE;
    else process.env.FOLDRUN_ROLE = prev;
  }
});

test("health: 503 before ready, while draining, and with no Redis to read leases from", async () => {
  // Without Redis, leases would be this process's memory, which no worker
  // writes to, so the pod must not take traffic. Unset here so the test
  // means the same with or without a Redis in the environment.
  const prev = process.env.FOLDRUN_REDIS_URL;
  delete process.env.FOLDRUN_REDIS_URL;
  try {
    assert.equal((await egressHealth({ ready: false, draining: false })).status, 503);
    assert.equal((await egressHealth({ ready: true, draining: true })).status, 503);
    const r = await egressHealth({ ready: true, draining: false });
    assert.equal(r.status, 503);
    assert.equal(r.body.role, "egress");
    assert.equal(r.body.redis, null);
  } finally {
    if (prev !== undefined) process.env.FOLDRUN_REDIS_URL = prev;
  }
});

test("drain: idle connections close at once; a call in flight is waited for, then cut at the deadline", async () => {
  const { port } = await startEgressProxy(0);
  // An idle keep-alive socket must not hold the drain open.
  const idle = net.connect(port, "127.0.0.1");
  await new Promise((r) => idle.once("connect", r));
  // A request still being sent: the server is mid-call on this socket.
  const busy = net.connect(port, "127.0.0.1");
  await new Promise((r) => busy.once("connect", r));
  busy.write("POST /e/tok/https://api.example.test/v1 HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\npartial");
  await new Promise((r) => setTimeout(r, 50));

  const t = Date.now();
  const clean = await drainEgressProxy(300);
  assert.equal(clean, false, "a call in flight at the deadline is closed, and said so");
  assert.ok(Date.now() - t >= 280, "it waited for the call before closing it");
  idle.destroy();
  busy.destroy();
});

test("drain with nothing open finishes straight away", async () => {
  await startEgressProxy(0);
  const t = Date.now();
  assert.equal(await drainEgressProxy(5_000), true);
  assert.ok(Date.now() - t < 1_000);
});

test("run directly with no FOLDRUN_EGRESS_URL, egress.ts refuses to start", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const env = { ...process.env, FOLDRUN_ROLE: "egress", FOLDRUN_EGRESS_URL: "", FOLDRUN_WORKER_PORT: "0" };
  const { code, err } = await new Promise<{ code: number | null; err: string }>((resolve) => {
    const c = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "src/egress.ts"], { cwd: path.join(here, ".."), env });
    let err = "";
    c.stderr.on("data", (d) => (err += d));
    c.on("close", (code) => resolve({ code, err }));
  });
  assert.notEqual(code, 0);
  assert.match(err, /needs FOLDRUN_EGRESS_URL/);
});

// The whole point of the role: a lease the WORKER writes is honoured by a
// proxy in ANOTHER process. Needs a Redis (FOLDRUN_REDIS_URL); skipped
// without one, since without Redis there is no shared store to test.
test("a lease written by the worker process is honoured by a separate egress process", { skip: !process.env.FOLDRUN_REDIS_URL }, async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const { egressHooks } = await import("../src/egress-proxy.ts");
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-egress-role-"));
  // Both processes seal and open grants with the same install key, as the
  // worker and egress pods do from the same foldrun-keys Secret.
  const prevKey = process.env.FOLDRUN_SECRET_KEY;
  process.env.FOLDRUN_SECRET_KEY = "egress-role-test-0123456789abcdef";
  const proxyPort = 18000 + Math.floor(Math.random() * 1000);
  const healthPort = proxyPort + 1000;
  process.env.FOLDRUN_EGRESS_URL = `http://127.0.0.1:${proxyPort}`;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "src/egress.ts"], {
    cwd: path.join(here, ".."),
    env: {
      ...process.env,
      FOLDRUN_ROLE: "egress",
      FOLDRUN_EGRESS_PORT: String(proxyPort),
      FOLDRUN_WORKER_PORT: String(healthPort),
      FOLDRUN_DATA: data,
      FOLDRUN_SECRET_KEY: "egress-role-test-0123456789abcdef",
      FOLDRUN_EGRESS_DRAIN_MS: "1000",
    },
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  try {
    // Up and healthy: 200 only once prepared, listening, and Redis answers.
    let healthy = false;
    for (let i = 0; i < 60 && !healthy; i++) {
      healthy = await fetch(`http://127.0.0.1:${healthPort}/api/healthz`).then((r) => r.ok, () => false);
      if (!healthy) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(healthy, `egress never became healthy:\n${log}`);

    // This process plays the worker: it writes the lease to Redis.
    const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-cross", grant: { secrets: {} } }))!;
    const token = lease.url.split("/e/")[1];
    const inbox = await fetch(`http://127.0.0.1:${proxyPort}/inbox/${token}`);
    assert.equal(inbox.status, 200, `the other process found the worker's lease: ${inbox.status} ${await inbox.clone().text()}`);
    assert.deepEqual(await inbox.json(), { messages: [] });
    const unknown = await fetch(`http://127.0.0.1:${proxyPort}/inbox/${"x".repeat(24)}`);
    assert.equal(unknown.status, 401, "and still refuses a token nobody leased");
    await lease.release();
    const gone = await fetch(`http://127.0.0.1:${proxyPort}/inbox/${token}`);
    assert.equal(gone.status, 401, "a released lease is gone for every process");

    // A v2 lease, to a pod that still holds the install key: verified with
    // the key it derives, opened with the token.
    process.env.FOLDRUN_EGRESS_LEASE_V2 = "1";
    try {
      const v2 = (await egressHooks.lease({ tenant: "acme", runId: "run-cross-v2", grant: { secrets: {} } }))!;
      const t2 = v2.url.split("/e/")[1];
      assert.equal((await fetch(`http://127.0.0.1:${proxyPort}/inbox/${t2}`)).status, 200, "a v2 lease, read by a pod with the key");
      await v2.release();
    } finally {
      delete process.env.FOLDRUN_EGRESS_LEASE_V2;
    }

    // SIGTERM: health goes 503 at once, then the process exits cleanly.
    const exited = new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
    child.kill("SIGTERM");
    assert.equal(await exited, 0, log);
    assert.match(log, /SIGTERM, draining/);
  } finally {
    child.kill("SIGKILL");
    // The shared Redis client stays open for the next test, which closes it.
    delete process.env.FOLDRUN_EGRESS_URL;
    if (prevKey === undefined) delete process.env.FOLDRUN_SECRET_KEY;
    else process.env.FOLDRUN_SECRET_KEY = prevKey;
    fs.rmSync(data, { recursive: true, force: true });
  }
});

/** Start `src/egress.ts` as its own process with `env` over this one's
 *  (an undefined value removes the variable); resolves once it is healthy. */
async function spawnEgress(env: Record<string, string | undefined>) {
  const proxyPort = 19000 + Math.floor(Math.random() * 1000);
  const healthPort = proxyPort + 1000;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const full: NodeJS.ProcessEnv = { ...process.env, FOLDRUN_ROLE: "egress", FOLDRUN_EGRESS_PORT: String(proxyPort), FOLDRUN_WORKER_PORT: String(healthPort), FOLDRUN_EGRESS_DRAIN_MS: "1000", FOLDRUN_EGRESS_URL: `http://127.0.0.1:${proxyPort}` };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete full[k];
    else full[k] = v;
  }
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "src/egress.ts"], { cwd: path.join(here, ".."), env: full });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  let health: Record<string, unknown> | null = null;
  for (let i = 0; i < 60 && !health; i++) {
    health = await fetch(`http://127.0.0.1:${healthPort}/api/healthz`).then((r) => (r.ok ? (r.json() as Promise<Record<string, unknown>>) : null), () => null);
    if (!health) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(health, `egress never became healthy:\n${log}`);
  return { proxyPort, healthPort, child, health, log: () => log };
}

// The pod with no root key (29 Oct 2026): FOLDRUN_EGRESS_MINIMAL_BOOT=1 and
// only the three purpose values. Everything a step needs from the proxy
// still works for a v2 lease; nothing it could not have written is honoured.
test("without the install key: a signed v2 lease is honoured; v1, forged and unsigned ones are not", { skip: !process.env.FOLDRUN_REDIS_URL }, async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const crypto = await import("node:crypto");
  const http = await import("node:http");
  const tls = await import("node:tls");
  const { egressHooks, legacyLeases } = await import("../src/egress-proxy.ts");
  const { egressKeyValues, leaseId, sealForLease } = await import("../src/egress-keys.ts");
  const { cache } = await import("../src/cache.ts");
  const KEY = "egress-role-minimal-test-key-0123456789";
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-egress-minimal-"));
  const prev = { key: process.env.FOLDRUN_SECRET_KEY, v2: process.env.FOLDRUN_EGRESS_LEASE_V2, url: process.env.FOLDRUN_EGRESS_URL };
  // This process is the worker: it holds the install key and signs leases.
  process.env.FOLDRUN_SECRET_KEY = KEY;
  const eg = await spawnEgress({
    FOLDRUN_SECRET_KEY: undefined,
    FOLDRUN_DATABASE_URL: undefined,
    FOLDRUN_INSTALL_KEY_ABSENT: "1",
    FOLDRUN_EGRESS_MINIMAL_BOOT: "1",
    FOLDRUN_DATA: data,
    ...egressKeyValues(KEY),
  });
  const inbox = (token: string) => fetch(`http://127.0.0.1:${eg.proxyPort}/inbox/${token}`).then((r) => r.status);
  try {
    process.env.FOLDRUN_EGRESS_URL = `http://127.0.0.1:${eg.proxyPort}`;
    assert.equal(eg.health.minimalBoot, true);
    assert.equal(typeof eg.health.legacyLeases, "number", "health says how many v1 leases are live");

    // v2: the worker's lease, read by a pod with no install key.
    process.env.FOLDRUN_EGRESS_LEASE_V2 = "1";
    const grant = { secrets: { BOUND_KEY: { value: "the-bound-value", hosts: ["bound.example.test"] } } };
    const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-minimal", grant }))!;
    const token = lease.url.split("/e/")[1]!;
    assert.equal(await inbox(token), 200, eg.log());

    // The forward door signs with the CA from FOLDRUN_EGRESS_CA_PRK, and the
    // sandbox trusts it with the CA the worker put in the lease.
    assert.ok(lease.ca && lease.proxy);
    const socket = await new Promise<import("node:net").Socket>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: eg.proxyPort, method: "CONNECT", path: "bound.example.test:443", headers: { "proxy-authorization": `Basic ${Buffer.from(`foldrun:${token}`).toString("base64")}` } });
      req.on("connect", (res, sock) => (res.statusCode === 200 ? resolve(sock) : reject(new Error(`CONNECT ${res.statusCode}`))));
      req.on("error", reject);
      req.end();
    });
    await new Promise<void>((resolve, reject) => {
      const secure = tls.connect({ socket, servername: "bound.example.test", ca: lease.ca, rejectUnauthorized: true }, () => {
        secure.destroy();
        resolve();
      });
      secure.on("error", reject);
    });

    // Forged: a record at a v2 key this proxy could open, but not signed by
    // the worker — signed by another key, not signed at all, or v1-shaped.
    const r = cache()!;
    const planted: string[] = [];
    const forged = async (shape: (rec: string) => unknown) => {
      const t = crypto.randomBytes(24).toString("base64url");
      const id = leaseId(t);
      planted.push(`egress:lease:${id}`);
      const now = Date.now();
      const rec = JSON.stringify({ v: 2, id, tenant: "acme", runId: "run-forged", createdAt: now, renewedAt: now, test: false, grant: sealForLease(t, `${id}|acme|run-forged`, JSON.stringify({ secrets: {} })) });
      await r.set(`egress:lease:${id}`, JSON.stringify(shape(rec)), "EX", 60);
      return t;
    };
    const stranger = crypto.generateKeyPairSync("ed25519").privateKey;
    assert.equal(await inbox(await forged((rec) => ({ v: 2, rec, sig: crypto.sign(null, Buffer.from(`foldrun egress lease v2\0${rec}`), stranger).toString("base64") }))), 401, "signed by another key");
    assert.equal(await inbox(await forged((rec) => ({ v: 2, rec }))), 401, "unsigned");
    assert.equal(await inbox(await forged((rec) => JSON.parse(rec))), 401, "a bare record at a v2 key");
    // The id presented as if it were a token reaches nothing either.
    assert.equal(await inbox(leaseId(token)), 401);
    await r.del(...planted);

    // v1: sealed under the account key, which this pod has not got.
    delete process.env.FOLDRUN_EGRESS_LEASE_V2;
    const before = await legacyLeases();
    const v1 = (await egressHooks.lease({ tenant: "acme", runId: "run-minimal-v1", grant: { secrets: {} } }))!;
    assert.equal(await legacyLeases(), before + 1, "a v1 lease is counted");
    assert.equal(await inbox(v1.url.split("/e/")[1]!), 401, "a v1 lease cannot be opened without the key");
    await v1.release();
    assert.equal(await legacyLeases(), before);

    await lease.release();
    assert.equal(await inbox(token), 401, "a released v2 lease is gone");

    // Nothing reached for the install key: no .secret-key was made, and
    // nothing asked (FOLDRUN_INSTALL_KEY_ABSENT=1 makes asking throw).
    assert.equal(fs.existsSync(path.join(data, ".secret-key")), false, eg.log());
    assert.doesNotMatch(eg.log(), /FOLDRUN_INSTALL_KEY_ABSENT/);

    const exited = new Promise<number | null>((res) => eg.child.once("exit", (c) => res(c)));
    eg.child.kill("SIGTERM");
    assert.equal(await exited, 0, eg.log());
  } finally {
    eg.child.kill("SIGKILL");
    for (const [k, v] of [["FOLDRUN_SECRET_KEY", prev.key], ["FOLDRUN_EGRESS_LEASE_V2", prev.v2], ["FOLDRUN_EGRESS_URL", prev.url]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test("minimal boot with the install key still present: v1 refused outright, v2 honoured", { skip: !process.env.FOLDRUN_REDIS_URL }, async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const { egressHooks } = await import("../src/egress-proxy.ts");
  const { egressKeyValues } = await import("../src/egress-keys.ts");
  const KEY = "egress-role-minimal-with-key-0123456789";
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-egress-minimal-key-"));
  const prev = { key: process.env.FOLDRUN_SECRET_KEY, v2: process.env.FOLDRUN_EGRESS_LEASE_V2, url: process.env.FOLDRUN_EGRESS_URL };
  process.env.FOLDRUN_SECRET_KEY = KEY;
  // The key is there, but a minimal boot loads no account keys: a v1 grant
  // would not open, so v1 is refused rather than half-served.
  const eg = await spawnEgress({ FOLDRUN_SECRET_KEY: KEY, FOLDRUN_DATABASE_URL: undefined, FOLDRUN_EGRESS_MINIMAL_BOOT: "1", FOLDRUN_DATA: data, ...egressKeyValues(KEY) });
  const inbox = (token: string) => fetch(`http://127.0.0.1:${eg.proxyPort}/inbox/${token}`).then((r) => r.status);
  try {
    process.env.FOLDRUN_EGRESS_URL = `http://127.0.0.1:${eg.proxyPort}`;
    delete process.env.FOLDRUN_EGRESS_LEASE_V2;
    const v1 = (await egressHooks.lease({ tenant: "acme", runId: "run-minimal-key-v1", grant: { secrets: {} } }))!;
    assert.equal(await inbox(v1.url.split("/e/")[1]!), 401, eg.log());
    process.env.FOLDRUN_EGRESS_LEASE_V2 = "1";
    const v2 = (await egressHooks.lease({ tenant: "acme", runId: "run-minimal-key-v2", grant: { secrets: {} } }))!;
    assert.equal(await inbox(v2.url.split("/e/")[1]!), 200, eg.log());
    await v1.release();
    await v2.release();
  } finally {
    eg.child.kill("SIGKILL");
    for (const [k, v] of [["FOLDRUN_SECRET_KEY", prev.key], ["FOLDRUN_EGRESS_LEASE_V2", prev.v2], ["FOLDRUN_EGRESS_URL", prev.url]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test("a pod given a purpose key that disagrees with its install key refuses to start", async () => {
  const { egressKeyValues } = await import("../src/egress-keys.ts");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FOLDRUN_ROLE: "egress",
    FOLDRUN_EGRESS_URL: "http://127.0.0.1:1",
    FOLDRUN_WORKER_PORT: "0",
    FOLDRUN_EGRESS_PORT: "0",
    FOLDRUN_SECRET_KEY: "the-install-key-0123456789",
    FOLDRUN_EGRESS_CA_PRK: egressKeyValues("another-install-key").FOLDRUN_EGRESS_CA_PRK,
  };
  const { code, err } = await new Promise<{ code: number | null; err: string }>((resolve) => {
    const c = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "src/egress.ts"], { cwd: path.join(here, ".."), env });
    let err = "";
    c.stderr.on("data", (d) => (err += d));
    c.on("close", (code) => resolve({ code, err }));
  });
  assert.notEqual(code, 0);
  assert.match(err, /FOLDRUN_EGRESS_CA_PRK does not match/);
});

// A grant sealed under a key this proxy does not hold yet (an account key
// minted since its last refresh): the proxy reloads its keys once and finds
// the lease, instead of refusing the step's first call. Redis only.
test("a grant this proxy cannot open yet is retried after reloading keys", { skip: !process.env.FOLDRUN_REDIS_URL }, async () => {
  const { egressHooks, setGrantKeyReload, startEgressProxy, stopEgressProxy } = await import("../src/egress-proxy.ts");
  const { cache } = await import("../src/cache.ts");
  const prev = process.env.FOLDRUN_SECRET_KEY;
  process.env.FOLDRUN_EGRESS_URL = "http://127.0.0.1:1";
  try {
    process.env.FOLDRUN_SECRET_KEY = "key-the-worker-sealed-with-0123456789";
    const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-reload", grant: { secrets: {} } }))!;
    const token = lease.url.split("/e/")[1];
    const { port } = await startEgressProxy(0);
    process.env.FOLDRUN_SECRET_KEY = "a-key-this-proxy-has-not-got-yet-0000";
    setGrantKeyReload(null);
    assert.equal((await fetch(`http://127.0.0.1:${port}/inbox/${token}`)).status, 401, "without a reload: refused");
    let reloads = 0;
    setGrantKeyReload(async () => {
      reloads++;
      process.env.FOLDRUN_SECRET_KEY = "key-the-worker-sealed-with-0123456789";
    });
    assert.equal((await fetch(`http://127.0.0.1:${port}/inbox/${token}`)).status, 200, "reloaded once, then found");
    assert.equal(reloads, 1);
    await lease.release();
    await stopEgressProxy();
  } finally {
    setGrantKeyReload(null);
    if (prev === undefined) delete process.env.FOLDRUN_SECRET_KEY;
    else process.env.FOLDRUN_SECRET_KEY = prev;
    delete process.env.FOLDRUN_EGRESS_URL;
    cache()?.disconnect();
  }
});
