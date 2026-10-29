// The egress proxy's own front door.
//
//   FOLDRUN_ROLE=egress node --experimental-strip-types foldrun-platform/src/egress.ts
//
// The proxy every run pod sends its model and API calls through (egress-
// proxy.ts) used to live inside the worker process, so anything that
// restarted the worker cut every step's call in flight: on 6 Oct 2026 a
// worker killed by its liveness probe every 4.5 minutes failed every desk
// that was running with ECONNREFUSED. Leases are in Redis, so the proxy
// needs nothing from the worker but the lease it wrote; here it runs alone,
// two replicas behind the foldrun-egress Service, rolled one at a time.
//
// Health on 3900 like the worker's: 200 once prepared and listening with
// Redis answering. On SIGTERM it reports 503, stops taking connections and
// lets the calls in flight finish (FOLDRUN_EGRESS_DRAIN_MS, ten minutes by
// default; the pod's terminationGracePeriodSeconds must be longer).
//
// Without the install key (29 Oct 2026): FOLDRUN_EGRESS_MINIMAL_BOOT=1 boots
// with nothing but the platform plugged in (boot.ts prepareEgress), and the
// pod is given only what it uses — FOLDRUN_EGRESS_LEASE_PUBKEY to check the
// worker's signature on a v2 lease, FOLDRUN_EGRESS_CA_PRK for the forward
// door's CA, FOLDRUN_OIDC_SEAL_KEY for the identity door (egress-keys.ts).
// A v1 lease (sealed under an account key) is then refused; health reports
// how many are still live as legacyLeases, which must be 0 before the key
// is taken away.

import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { boot, egressMinimalBoot } from "./boot.ts";
import { cacheEnabled, cacheReady } from "./cache.ts";
import { drainEgressProxy, egressUrl, legacyLeases, liveLeases, setGrantKeyReload, setLegacyLeasesReadable, startEgressProxy } from "./egress-proxy.ts";
import { assertEgressKeys } from "./egress-keys.ts";
import { oidcIssuer } from "./oidc-issuer.ts";
import { databaseEnabled } from "./db.ts";
import { loadTenantKeys } from "./tenant-keys.ts";

const PORT = Number(process.env.FOLDRUN_WORKER_PORT) || 3900;
const DRAIN_MS = Number(process.env.FOLDRUN_EGRESS_DRAIN_MS) || 10 * 60_000;

let ready = false;
let draining = false;

/** v1 leases on the store, counted at most every 15 s: the probes ask every
 *  few seconds, and the count is a SCAN. */
let legacyCount: { at: number; n: number | null } = { at: 0, n: null };
async function legacyLeaseCount(): Promise<number | null> {
  if (Date.now() - legacyCount.at < 15_000) return legacyCount.n;
  const n = await legacyLeases().catch(() => null);
  legacyCount = { at: Date.now(), n };
  return n;
}

/** The health answer, apart from the server so a test can read it.
 *  `legacyLeases`: live v1 leases — the ones a pod without the install key
 *  cannot open. 0 everywhere is when the key may be taken off egress. */
export async function egressHealth(state: { ready: boolean; draining: boolean }): Promise<{ status: number; body: Record<string, unknown> }> {
  const redis = cacheEnabled() ? await cacheReady().catch(() => false) : null;
  // No Redis means leases in this process's memory, which no worker can
  // write to: a proxy that would 401 every call is not healthy.
  const ok = state.ready && !state.draining && redis === true;
  return {
    status: ok ? 200 : 503,
    body: {
      ok,
      role: "egress",
      version: process.env.FOLDRUN_VERSION ?? null,
      redis,
      draining: state.draining,
      legacyLeases: redis === true ? await legacyLeaseCount() : null,
      minimalBoot: egressMinimalBoot(),
    },
  };
}

function serveHealth(): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.method !== "GET" || !/^\/(api\/)?healthz\/?$/.test(req.url ?? "")) {
      res.writeHead(404).end();
      return;
    }
    const { status, body } = await egressHealth({ ready, draining });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  server.listen(PORT, "0.0.0.0");
  return server;
}

async function main(): Promise<void> {
  process.env.FOLDRUN_ROLE ??= "egress";
  if (process.env.FOLDRUN_ROLE !== "egress") {
    throw new Error(`egress.ts runs the egress role; FOLDRUN_ROLE is "${process.env.FOLDRUN_ROLE}"`);
  }
  if (!egressUrl()) throw new Error("egress.ts needs FOLDRUN_EGRESS_URL: without it no step is told to send here");
  const health = serveHealth();
  try {
    const minimal = egressMinimalBoot();
    // Every key this pod will use, read before it takes traffic: a missing
    // one, or one that disagrees with the install key, stops it here.
    assertEgressKeys({ minimal, forward: process.env.FOLDRUN_EGRESS_FORWARD !== "0", oidc: Boolean(oidcIssuer()) });
    await boot("egress");
    if (minimal) {
      // A minimal boot loads no account keys, so a v1 lease (sealed under
      // one) cannot be opened here — with or without the install key. It is
      // refused outright, never read: without the key, reading one would
      // reach for a key core could create on the volume; with it, the grant
      // would fail to open while the pod still reported itself healthy.
      setLegacyLeasesReadable(false);
    } else if (databaseEnabled()) {
      // A lease sealed under an account key minted since our last refresh:
      // reload the keys once and try again, rather than refuse the step.
      setGrantKeyReload(() => loadTenantKeys());
    }
    const { port } = await startEgressProxy();
    ready = true;
    console.log(`[foldrun] egress: ready, proxy on :${port} (health on :${PORT})`);
  } catch (err) {
    console.error("[foldrun] egress: boot failed:", err instanceof Error ? err.message : err);
    health.close();
    process.exit(1);
  }
  process.once("SIGTERM", async () => {
    draining = true;
    const open = await liveLeases().catch(() => null);
    console.log(`[foldrun] egress: SIGTERM, draining (up to ${Math.round(DRAIN_MS / 1000)}s; ${open ?? "?"} live lease(s) on the store)`);
    const clean = await drainEgressProxy(DRAIN_MS);
    console.log(`[foldrun] egress: ${clean ? "every call finished" : "drain deadline: closed what was left"}, exiting`);
    health.close();
    process.exit(0);
  });
}

// Imported by its test for egressHealth; run directly, it is the process.
// The image starts it as `src/egress.ts` from the package directory, so the
// argument is resolved before it is compared.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) void main();
