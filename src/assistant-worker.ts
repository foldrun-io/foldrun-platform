// The assistant role: a Deployment of its own that runs the dashboard
// assistant's replies (assistant/jobs.ts) and nothing else.
//
//   FOLDRUN_ROLE=assistant node --experimental-strip-types src/assistant-worker.ts
//
// Same image as the run worker. Apart from it on purpose: a reply holds a
// `claude` process for up to five minutes, so it scales on its own queue
// (KEDA on assistant_jobs), drains on SIGTERM for as long as a reply may
// take (the Deployment's grace period is set to match), and never competes
// with a flow's run for a worker's slot — while a run worker hands its runs
// back within seconds of a SIGTERM, which would cut a reply off part-way.

import http from "node:http";
import { boot } from "./boot.ts";
import { databaseEnabled, databaseReady } from "./db.ts";
import { startAssistantWorker, WORKER_CONCURRENCY } from "./assistant/jobs.ts";
import { assistantDocs } from "./assistant/docs.ts";

const PORT = Number(process.env.FOLDRUN_WORKER_PORT) || 3900;
let ready = false;
let draining = false;

/** GET /healthz (readiness): 200 once booted with its docs, 503 while
 *  draining or when the database is unreachable. GET /livez (liveness). */
function serveHealth(): http.Server {
  const server = http.createServer(async (req, res) => {
    // /livez: the process answers. A draining pod is alive — the liveness
    // probe must not kill it part-way through the replies it is finishing.
    if (req.method === "GET" && /^\/livez\/?$/.test(req.url ?? "")) {
      res.writeHead(ready ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify({ ok: ready, draining }));
      return;
    }
    if (req.method !== "GET" || !/^\/(api\/)?healthz\/?$/.test(req.url ?? "")) {
      res.writeHead(404).end();
      return;
    }
    const database = databaseEnabled() ? await databaseReady().catch(() => false) : null;
    const docs = !!assistantDocs();
    const ok = ready && !draining && database !== false && docs;
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok, role: "assistant", version: process.env.FOLDRUN_VERSION ?? null, database, docs, draining, concurrency: WORKER_CONCURRENCY }));
  });
  server.listen(PORT, "0.0.0.0");
  return server;
}

async function main(): Promise<void> {
  process.env.FOLDRUN_ROLE ??= "assistant";
  if (process.env.FOLDRUN_ROLE !== "assistant") {
    throw new Error(`assistant-worker.ts runs the assistant role; FOLDRUN_ROLE is "${process.env.FOLDRUN_ROLE}"`);
  }
  const health = serveHealth();
  try {
    await boot("assistant");
  } catch (err) {
    console.error("[foldrun] assistant: boot failed:", err instanceof Error ? err.message : err);
    health.close();
    process.exit(1);
  }
  if (!assistantDocs()) console.error("[foldrun] assistant: no docs bundle (assistant-docs.json) — replies will fail until the image has one");
  const loop = startAssistantWorker();
  ready = true;
  console.log(`[foldrun] assistant: ready (health on :${PORT}, ${WORKER_CONCURRENCY} at once)`);
  const shutdown = async (signal: string) => {
    if (draining) return;
    draining = true;
    console.log(`[foldrun] assistant: ${signal} — no new replies; finishing the ones in hand`);
    await loop.stop();
    console.log("[foldrun] assistant: drained, exiting");
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

void main();
