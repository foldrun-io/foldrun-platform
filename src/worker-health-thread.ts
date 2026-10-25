// The thread that answers the worker's probes (worker-health.ts). It reads
// only the shared slots the main thread writes, so a main thread held by
// synchronous work cannot stop it answering.
//
//   GET /api/healthz (and /healthz): 200 when ok, else 503, with
//   { ok, role, version, database, redis, tickAgeMs, stale, loopLagMs,
//     blocked, checkedAgeMs }

import http from "node:http";
import { workerData } from "node:worker_threads";
import { healthVerdict, readSnapshot, type HealthLimits } from "./worker-health.ts";

const { slots, port, version, limits } = workerData as {
  slots: BigInt64Array;
  port: number;
  version: string | null;
  limits: HealthLimits;
};

const server = http.createServer((req, res) => {
  if (req.method !== "GET" || !/^\/(api\/)?healthz\/?$/.test(req.url ?? "")) {
    res.writeHead(404).end();
    return;
  }
  const v = healthVerdict(readSnapshot(slots), Date.now(), limits);
  res.writeHead(v.ok ? 200 : 503, { "content-type": "application/json" });
  res.end(JSON.stringify({ role: "worker", version, ...v }));
});
server.on("error", (err) => {
  // A port that cannot be bound is fatal for the thread; the main thread
  // starts it again, and says so in the log each time.
  console.error("[foldrun] worker health thread: listen failed:", err.message);
  process.exit(1);
});
server.listen(port, "0.0.0.0");
