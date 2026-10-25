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
