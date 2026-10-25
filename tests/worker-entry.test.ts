// The worker runs as its own process, with no Next.js around it: it boots,
// answers the probes the manifests point at it, and stops cleanly on
// SIGTERM. Nothing here needs a database — the file-store shape, the
// laptop's — which is exactly the case that proves the entrypoint stands
// on its own.
//
//   node --test tests/worker-entry.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const WORKER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/worker.ts");

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

const get = async (url: string) => {
  const res = await fetch(url).catch(() => null);
  if (!res) return null;
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
};

test("the worker entrypoint boots without Next.js, answers healthz, and exits cleanly on SIGTERM", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "worker-entry-"));
  const port = await freePort();
  const child = spawn(process.execPath, ["--experimental-strip-types", WORKER], {
    env: {
      ...process.env,
      FOLDRUN_DATA: data,
      FOLDRUN_ROLE: "worker",
      FOLDRUN_WORKER_PORT: String(port),
      FOLDRUN_VERSION: "vtest",
      FOLDRUN_DATABASE_URL: "",
      FOLDRUN_REDIS_URL: "",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));
  try {
    // Before boot completes the probe says not ready; after, 200 with the role.
    let last: { status: number; body: Record<string, unknown> } | null = null;
    for (let i = 0; i < 100; i++) {
      last = await get(`http://127.0.0.1:${port}/api/healthz`);
      if (last?.status === 200) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(last?.status, 200, `worker never became ready:\n${out.slice(-2000)}`);
    assert.equal(last?.body.role, "worker");
    assert.equal(last?.body.version, "vtest");
    assert.equal(last?.body.database, null, "no database on this install");
    assert.equal((await get(`http://127.0.0.1:${port}/healthz`))?.status, 200, "the short path too");
    assert.equal((await get(`http://127.0.0.1:${port}/api/other`))?.status, 404);
    assert.match(out, /worker: ready/);
    child.kill("SIGTERM");
    const code = await Promise.race([exited, new Promise<null>((r) => setTimeout(() => r(null), 15_000))]);
    assert.equal(code, 0, `expected a clean exit on SIGTERM:\n${out.slice(-2000)}`);
    assert.match(out, /lease released, exiting/);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test("the worker entrypoint refuses any other role", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "worker-entry-"));
  const child = spawn(process.execPath, ["--experimental-strip-types", WORKER], {
    env: { ...process.env, FOLDRUN_DATA: data, FOLDRUN_ROLE: "web", FOLDRUN_WORKER_PORT: String(await freePort()) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const code = await new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));
  assert.notEqual(code, 0);
  assert.match(err, /runs the worker role/);
  fs.rmSync(data, { recursive: true, force: true });
});

// With a database the boot migrates, and the migration files are found from
// wherever the worker was started: its own package (the image's WORKDIR),
// or the folder that holds every package. The first image shipped with
// WORKDIR /app and crash-looped on the box with "no migration files at
// /app/drizzle" — this is the case that would have caught it.
const DB = process.env.FOLDRUN_TEST_DATABASE_URL;
for (const [label, cwd] of [
  ["its own package", path.dirname(path.dirname(WORKER))],
  ["the folder holding every package", path.dirname(path.dirname(path.dirname(WORKER)))],
] as const) {
  test(`with a database, the worker started from ${label} finds its migrations and becomes ready`, { skip: DB ? false : "set FOLDRUN_TEST_DATABASE_URL" }, async () => {
    const u = new URL(DB!);
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "worker-entry-db-"));
    const port = await freePort();
    const child = spawn(process.execPath, ["--experimental-strip-types", WORKER], {
      cwd,
      env: {
        ...process.env,
        FOLDRUN_DATA: data,
        FOLDRUN_ROLE: "worker",
        FOLDRUN_WORKER_PORT: String(port),
        FOLDRUN_DATABASE_URL: `${u.protocol}//${u.username}@${u.host}${u.pathname}`,
        FOLDRUN_DATABASE_PASSWORD: u.password,
        FOLDRUN_SECRET_KEY: "test-install-key",
        FOLDRUN_MIGRATIONS_DIR: "",
        FOLDRUN_REDIS_URL: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    try {
      let last: { status: number; body: Record<string, unknown> } | null = null;
      for (let i = 0; i < 150; i++) {
        last = await get(`http://127.0.0.1:${port}/api/healthz`);
        if (last?.status === 200 || child.exitCode !== null) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.equal(last?.status, 200, `worker from ${cwd} never became ready:\n${out.slice(-1500)}`);
      assert.equal(last?.body.database, true, "the database was reached");
      assert.doesNotMatch(out, /no migration files/);
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
      fs.rmSync(data, { recursive: true, force: true });
    }
  });
}
