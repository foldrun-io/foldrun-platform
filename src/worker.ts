// The worker's own front door.
//
//   FOLDRUN_ROLE=worker node --experimental-strip-types foldrun-platform/src/worker.ts
//
// One process: boot, then drive runs, tick the scheduler and run the egress
// proxy — what foldrun-web/instrumentation.ts used to start from inside a
// Next.js server that served nothing. No dashboard, no React, no HTTP but
// the health endpoint below, which answers the same probes the manifests
// have always pointed at the worker (/api/healthz on 3900), so a rollout
// from the old image needs no manifest change.
//
// Shutdown is queue.ts's: on SIGTERM it stops claiming, hands every run it
// is driving back to the queue for the next worker to re-attach, releases
// its lease and exits.

import { boot } from "./boot.ts";
import { databaseEnabled, databaseReady } from "./db.ts";
import { cacheEnabled, cacheReady } from "./cache.ts";
import { workerTickAge } from "./queue.ts";
import { startHealth, withDeadline } from "./worker-health.ts";

const PORT = Number(process.env.FOLDRUN_WORKER_PORT) || 3900;

/** GET /api/healthz (and /healthz), answered from its own thread
 *  (worker-health.ts, FOL-18) so a main thread busy with synchronous work
 *  still answers: 503 before boot completes (a rolling update waits on
 *  it), 503 when the tick has gone stale or the main thread has been held
 *  past FOLDRUN_WORKER_BLOCKED_MS (the liveness probe replaces it). */
function serveHealth() {
  return startHealth({
    port: PORT,
    version: process.env.FOLDRUN_VERSION ?? null,
    tickAge: () => workerTickAge(),
    checks: async () => {
      const [database, redis] = await Promise.all([
        databaseEnabled() ? withDeadline(databaseReady()) : Promise.resolve(null),
        cacheEnabled() ? withDeadline(cacheReady()) : Promise.resolve(null),
      ]);
      return { database, redis };
    },
  });
}

async function main(): Promise<void> {
  process.env.FOLDRUN_ROLE ??= "worker";
  if (process.env.FOLDRUN_ROLE !== "worker") {
    throw new Error(`worker.ts runs the worker role; FOLDRUN_ROLE is "${process.env.FOLDRUN_ROLE}"`);
  }
  const health = serveHealth();
  try {
    await boot("worker");
  } catch (err) {
    console.error("[foldrun] worker: boot failed:", err instanceof Error ? err.message : err);
    await health.close();
    process.exit(1);
  }
  health.setReady();
  console.log(`[foldrun] worker: ready (health on :${PORT})`);
}

void main();
