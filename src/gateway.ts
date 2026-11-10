// The gateway role (10 Nov 2026): foldrun's LLM gateway on its own pods,
// apart from the egress proxy that runs' model calls go through, so coding
// traffic and runs never slow each other and each scales on its own.
//
//   FOLDRUN_ROLE=gateway node src/gateway.ts
//
// Its own image (the Dockerfile's `gateway` target): Node and this code, no
// kubectl. The door itself is gateway-door.ts; this file boots the platform
// the minimal way (boot.ts: settings and the sealed provider keys, no
// migration, no loops, no records move), serves the health answer the probes
// read, and drains open streams on SIGTERM.
//
//   FOLDRUN_GATEWAY_PORT   the door (8091)
//   FOLDRUN_WORKER_PORT    health (3900), /healthz
//   FOLDRUN_GATEWAY_DRAIN_MS how long open streams may finish (10 min)

// First: the log boundary (FOL-121), before anything that might print.
import "./ops-boot.ts";
import { opsLog, opsError, withOpsReason } from "../../foldrun-core/src/ops-log.ts";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { boot } from "./boot.ts";
import { databaseEnabled } from "./db.ts";
import { startGatewayDoor, stopGatewayDoor } from "./gateway-door.ts";

const PORT = Number(process.env.FOLDRUN_WORKER_PORT) || 3900;
const DRAIN_MS = Number(process.env.FOLDRUN_GATEWAY_DRAIN_MS) || 10 * 60_000;

let ready = false;
let draining = false;

/** The health answer, apart from the server so a test can read it. Ready
 *  once the door listens; 503 while draining, so the Service stops sending
 *  new calls before the open ones are cut. The gateway reads its keys from
 *  the database: without one it serves nothing. */
export function gatewayHealth(state: { ready: boolean; draining: boolean }): { status: number; body: Record<string, unknown> } {
  const ok = state.ready && !state.draining && databaseEnabled();
  return {
    status: ok ? 200 : 503,
    body: { ok, role: "gateway", version: process.env.FOLDRUN_VERSION ?? null, draining: state.draining, database: databaseEnabled() },
  };
}

function serveHealth(): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method !== "GET" || !/^\/(api\/)?healthz\/?$/.test(req.url ?? "")) {
      res.writeHead(404).end();
      return;
    }
    const { status, body } = gatewayHealth({ ready, draining });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  server.listen(PORT, "0.0.0.0");
  return server;
}

async function main(): Promise<void> {
  process.env.FOLDRUN_ROLE ??= "gateway";
  if (process.env.FOLDRUN_ROLE !== "gateway") {
    throw withOpsReason(new Error(`gateway.ts runs the gateway role; FOLDRUN_ROLE is "${process.env.FOLDRUN_ROLE}"`), "wrong_role");
  }
  const health = serveHealth();
  try {
    await boot("gateway");
    const { port } = await startGatewayDoor();
    ready = true;
    opsLog("info", "gateway.ready", { port });
  } catch (err) {
    opsError("gateway.boot_failed", err);
    health.close();
    process.exit(1);
  }
  process.once("SIGTERM", async () => {
    draining = true;
    opsLog("info", "gateway.draining", { signal: "SIGTERM", secs: Math.round(DRAIN_MS / 1000) });
    const clean = await stopGatewayDoor(DRAIN_MS);
    opsLog("info", "gateway.exiting", { outcome: clean ? "drained" : "deadline" });
    health.close();
    process.exit(0);
  });
}

// Started as the main module only, so a test can import gatewayHealth.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    opsError("gateway.crashed", err);
    process.exit(1);
  });
}
