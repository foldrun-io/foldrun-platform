// The egress lease's clock: a sliding window renewed by the driver, and a
// store that fails closed rather than quietly falling back to one process's
// memory when Redis is configured but not answering.
//
// Its own file: the fail-closed case points the shared Redis client at a
// port nothing listens on, and that client is process-wide.
//
//   node --test tests/egress-lease.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { egressHooks, liveLeases, renewEgressLeases, sweepLeases, LeaseStoreUnavailable } from "../src/egress-proxy.ts";

const HOUR = 3600_000;

test("a lease renewed from the heartbeat outlives the window; one nobody renews is swept", async () => {
  process.env.FOLDRUN_EGRESS_URL = "http://worker:8090";
  delete process.env.FOLDRUN_REDIS_URL;
  try {
    const t0 = Date.now();
    const kept = (await egressHooks.lease({ tenant: "acme", runId: "run-long", grant: { secrets: {} } }))!;
    const dropped = (await egressHooks.lease({ tenant: "acme", runId: "run-dead", grant: { secrets: {} } }))!;
    assert.ok(kept && dropped);
    assert.equal(await liveLeases(), 2);
    // Five hours in, the driver of run-long is still heartbeating.
    assert.equal(await renewEgressLeases("run-long", t0 + 5 * HOUR), 1, "one lease of that run renewed");
    assert.equal(await renewEgressLeases("run-nobody", t0 + 5 * HOUR), 0);
    // Seven hours in: run-dead's driver never renewed; run-long's did at
    // five, so its window runs to eleven.
    assert.equal(sweepLeases(t0 + 7 * HOUR), 1);
    assert.equal(await liveLeases(), 1);
    // Nine hours: a step this long is not a bug, and its credentials hold.
    assert.equal(await renewEgressLeases("run-long", t0 + 9 * HOUR), 1);
    assert.equal(sweepLeases(t0 + 14 * HOUR), 0, "renewed at nine, good until fifteen");
    assert.equal(sweepLeases(t0 + 16 * HOUR), 1, "released by nobody: gone once the window passes");
    await kept.release();
    await dropped.release();
  } finally {
    delete process.env.FOLDRUN_EGRESS_URL;
  }
});

test("with Redis configured and down, a lease is refused with a clear error — unless one worker says memory is fine", async () => {
  process.env.FOLDRUN_EGRESS_URL = "http://worker:8090";
  process.env.FOLDRUN_REDIS_URL = "redis://127.0.0.1:1"; // nothing listens on port 1
  delete process.env.FOLDRUN_EGRESS_LOCAL_LEASES;
  const { cache } = await import("../src/cache.ts");
  try {
    await assert.rejects(
      egressHooks.lease({ tenant: "acme", runId: "run-1", grant: { secrets: {} } }),
      (err: unknown) => err instanceof LeaseStoreUnavailable && /FOLDRUN_EGRESS_LOCAL_LEASES/.test((err as Error).message),
      "the step is told the store is down, not handed a lease the other worker cannot see",
    );
    process.env.FOLDRUN_EGRESS_LOCAL_LEASES = "1";
    const lease = await egressHooks.lease({ tenant: "acme", runId: "run-1", grant: { secrets: {} } });
    assert.ok(lease, "the operator's word: one worker, memory will do");
    assert.equal(await renewEgressLeases("run-1"), 1, "and it renews like any other");
    await lease!.release();
  } finally {
    cache()?.disconnect();
    delete process.env.FOLDRUN_REDIS_URL;
    delete process.env.FOLDRUN_EGRESS_URL;
    delete process.env.FOLDRUN_EGRESS_LOCAL_LEASES;
  }
});
