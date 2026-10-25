// A model key re-granted mid-step reaches the upstream only once the lease
// is committed AFTER the re-grant.
//
// With Redis the proxy reads a serialised copy of the grant on every
// request, so commit() is the only thing that publishes a change to it. The
// memory store shares the grant by reference and hides the ordering, which
// is how the rotation retry in foldrun-core's runner shipped committing
// first and re-granting second: every retry after the 4-hourly OAuth
// refresh sent the token the refresh had just revoked, and 401'd again.
//
// Needs a Redis; skipped without one:
//   FOLDRUN_TEST_REDIS_URL=redis://127.0.0.1:6379 node --test tests/egress-rotation-redis.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { egressHooks, startEgressProxy, stopEgressProxy } from "../src/egress-proxy.ts";
import { cache } from "../src/cache.ts";
import { proxyModelEnv, type EgressGrant } from "../../foldrun-core/src/egress.ts";

const REDIS = process.env.FOLDRUN_TEST_REDIS_URL;
// The fake upstream is on loopback.
process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE = "1";
// The Redis store encrypts the grant, and the key it makes goes under the
// data root; without this it lands in ./data, beside the source.
process.env.FOLDRUN_DATA ??= fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-test-"));

function upstream() {
  const auth: (string | null)[] = [];
  const server = http.createServer((req, res) => {
    auth.push((req.headers.authorization as string | undefined) ?? null);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  return new Promise<{ host: string; auth: typeof auth; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ host: `127.0.0.1:${port}`, auth, close: () => server.close() });
    });
  });
}

test("a rotated model key reaches the upstream only when committed after the re-grant", { skip: !REDIS && "set FOLDRUN_TEST_REDIS_URL" }, async () => {
  const prev = { url: process.env.FOLDRUN_EGRESS_URL, redis: process.env.FOLDRUN_REDIS_URL };
  process.env.FOLDRUN_REDIS_URL = REDIS;
  const up = await upstream();
  const proxy = await startEgressProxy(0);
  process.env.FOLDRUN_EGRESS_URL = `http://127.0.0.1:${proxy.port}`;
  try {
    const grant: EgressGrant = { secrets: {} };
    const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-rot", grant }))!;
    const env = (token: string) => ({ ANTHROPIC_BASE_URL: `http://${up.host}`, CLAUDE_CODE_OAUTH_TOKEN: token });
    const call = async () => {
      const r = await fetch(`${lease.url}/http://${up.host}/v1/messages`, { method: "POST", headers: { authorization: "Bearer ${FOLDRUN_MODEL_KEY}" } });
      assert.equal(r.status, 200, `proxy answered ${r.status}: ${await r.clone().text()}`);
    };

    // First attempt, as the runner does it: grant, then commit.
    proxyModelEnv(env("old-token-aaaa"), lease.url, grant);
    await lease.commit();
    await call();
    assert.equal(up.auth.at(-1), "Bearer old-token-aaaa");

    // The order the rotation retry shipped with: commit, then re-grant.
    await lease.commit();
    proxyModelEnv(env("new-token-bbbb"), lease.url, grant);
    await call();
    assert.equal(up.auth.at(-1), "Bearer old-token-aaaa", "committed before the re-grant, so the proxy still sends the revoked token");

    // The order that works: re-grant, then commit.
    proxyModelEnv(env("new-token-cccc"), lease.url, grant);
    await lease.commit();
    await call();
    assert.equal(up.auth.at(-1), "Bearer new-token-cccc");

    await lease.release();
  } finally {
    for (const [k, v] of [["FOLDRUN_EGRESS_URL", prev.url], ["FOLDRUN_REDIS_URL", prev.redis]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await stopEgressProxy();
    up.close();
    // The shared client would hold the test process open.
    cache()?.disconnect();
  }
});
