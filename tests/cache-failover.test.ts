// A failover, as ElastiCache does it (production engine Valkey, 10 Nov 2026):
// a connection still open to the old primary — a replica now — answers
// writes with READONLY. The client must reconnect (finding the new primary)
// rather than keep writing to a replica, and the failed command must fail
// fast so its caller falls back.
//
//   FOLDRUN_TEST_REDIS_FAILOVER_URL=redis://localhost:56380 node --test tests/cache-failover.test.ts
//
// Its own variable, and a server no other test uses: the test makes the
// whole server a replica for a moment (REPLICAOF is server-wide), and a test
// writing to it at the same time would fail.

import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.FOLDRUN_TEST_REDIS_FAILOVER_URL;

test("READONLY means reconnect (and do not resend); any other error does not", async () => {
  const { reconnectOnFailover } = await import("../src/cache.ts");
  assert.equal(reconnectOnFailover(new Error("READONLY You can't write against a read only replica.")), 1);
  assert.equal(reconnectOnFailover(new Error("ERR unknown command")), false);
  assert.equal(reconnectOnFailover(new Error("NOAUTH Authentication required")), false);
  assert.equal(reconnectOnFailover(new Error("this is READONLY somewhere else")), false, "only the server's READONLY reply");
});

test("a write that lands on a demoted primary reconnects, fails fast, and works once a primary answers again", { skip: url ? false : "set FOLDRUN_TEST_REDIS_FAILOVER_URL (a throwaway Redis or Valkey no other test uses) to run" }, async () => {
  process.env.FOLDRUN_REDIS_URL = url;
  const { cache } = await import("../src/cache.ts");
  const { Redis } = await import("ioredis");
  const admin = new Redis(url!);
  const c = cache()!;
  try {
    if (c.status !== "ready") await new Promise((r) => c.once("ready", r));
    await c.set("failover-test", "1");
    let reconnects = 0;
    c.on("reconnecting", () => reconnects++);
    // The node becomes a replica of a primary that is not there: writes now
    // answer READONLY, as the old primary's do after a failover.
    await admin.replicaof("127.0.0.1", 1);
    const t0 = Date.now();
    await assert.rejects(c.set("failover-test", "2"), /READONLY/);
    assert.ok(Date.now() - t0 < 2_000, "the failed write fails fast");
    for (let i = 0; i < 50 && reconnects === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(reconnects >= 1, "READONLY made the client reconnect");
    // A primary again (the promoted replica, behind the same endpoint).
    await admin.replicaof("NO", "ONE");
    let ok = false;
    for (let i = 0; i < 100 && !ok; i++) {
      ok = await c.set("failover-test", "3").then(() => true, () => false);
      if (!ok) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(ok, "writes go through once a primary answers");
    assert.equal(await c.get("failover-test"), "3");
  } finally {
    await admin.replicaof("NO", "ONE").catch(() => {});
    await admin.del("failover-test").catch(() => {});
    admin.disconnect();
    c.disconnect();
  }
});
