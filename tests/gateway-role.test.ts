// The gateway role (10 Nov 2026): its own process and image, booted the
// minimal way, healthy only when it can serve, draining on SIGTERM.
//
//   node --test tests/gateway-role.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");

const { roleOf, movesRecords } = await import("../src/boot.ts");
const { gatewayHealth } = await import("../src/gateway.ts");

test("gateway is a role of its own, and never moves records", () => {
  const prev = process.env.FOLDRUN_ROLE;
  process.env.FOLDRUN_ROLE = "gateway";
  try {
    assert.equal(roleOf(), "gateway");
    assert.equal(movesRecords("gateway"), false, "only the worker (or the laptop) moves records");
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_ROLE;
    else process.env.FOLDRUN_ROLE = prev;
  }
});

test("health: 200 only when listening, not draining, and with a database", () => {
  const prev = process.env.FOLDRUN_DATABASE_URL;
  try {
    delete process.env.FOLDRUN_DATABASE_URL;
    assert.equal(gatewayHealth({ ready: true, draining: false }).status, 503, "no database: it could open no key");
    process.env.FOLDRUN_DATABASE_URL = "postgres://x@127.0.0.1:1/x";
    assert.equal(gatewayHealth({ ready: true, draining: false }).status, 200);
    assert.equal(gatewayHealth({ ready: false, draining: false }).status, 503, "not listening yet");
    assert.equal(gatewayHealth({ ready: true, draining: true }).status, 503, "draining: no new calls");
    assert.equal(gatewayHealth({ ready: true, draining: false }).body.role, "gateway");
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATABASE_URL;
    else process.env.FOLDRUN_DATABASE_URL = prev;
  }
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

test("the process boots as the gateway, serves the door and its health, and exits on SIGTERM", async () => {
  const [doorPort, healthPort] = [await freePort(), await freePort()];
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "src/gateway.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      FOLDRUN_ROLE: "gateway",
      FOLDRUN_GATEWAY_PORT: String(doorPort),
      FOLDRUN_WORKER_PORT: String(healthPort),
      FOLDRUN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), "gw-role-")),
      FOLDRUN_DATABASE_URL: "",
      FOLDRUN_GATEWAY_DRAIN_MS: "2000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  try {
    let door: Response | null = null;
    for (let i = 0; i < 100 && !door; i++) {
      door = await fetch(`http://127.0.0.1:${doorPort}/healthz`).catch(() => null);
      if (!door) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(door, `the door never listened:\n${out}`);
    assert.equal(door!.status, 200);
    const h = await fetch(`http://127.0.0.1:${healthPort}/healthz`);
    const body = (await h.json()) as { role: string; database: boolean };
    assert.equal(body.role, "gateway");
    assert.equal(h.status, 503, "no database here: not ready to serve keys");
    assert.match(out, /gateway\.ready/);
    const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
    child.kill("SIGTERM");
    assert.equal(await exited, 0, out);
    assert.match(out, /gateway\.exiting/);
  } finally {
    child.kill("SIGKILL");
  }
});
