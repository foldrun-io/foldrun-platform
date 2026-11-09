// FOL-134: the first read of open questions right after a process starts
// must wait for Redis to come up, not fail. The client queues nothing while
// it connects (enableOfflineQueue: false), so the inbox's first render after
// every web pod start threw "Stream isn't writeable…" and answered 500.
//
// A fake Redis that is slow to answer the client's ready check stands in for
// a connection that is still coming up — no real Redis needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

/** A RESP server that answers INFO after `delayMs`, HGETALL with an empty
 *  hash and anything else with OK. */
function slowRedis(delayMs: number) {
  const seen: string[] = [];
  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      // One command per RESP array; good enough for what the client sends.
      for (;;) {
        const m = /^\*(\d+)\r\n/.exec(buf);
        if (!m) return;
        let rest = buf.slice(m[0].length);
        const parts: string[] = [];
        for (let i = 0; i < Number(m[1]); i++) {
          const b = /^\$(\d+)\r\n/.exec(rest);
          if (!b || rest.length < b[0].length + Number(b[1]) + 2) return;
          parts.push(rest.slice(b[0].length, b[0].length + Number(b[1])));
          rest = rest.slice(b[0].length + Number(b[1]) + 2);
        }
        buf = rest;
        const cmd = parts[0].toUpperCase();
        seen.push(cmd);
        if (cmd === "INFO") {
          const body = "# Server\r\nloading:0\r\n";
          setTimeout(() => sock.write(`$${body.length}\r\n${body}\r\n`), delayMs);
        } else if (cmd === "HGETALL") sock.write("*0\r\n");
        else sock.write("+OK\r\n");
      }
    });
  });
  return new Promise<{ url: string; seen: string[]; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ url: `redis://127.0.0.1:${port}`, seen, close: () => server.close() });
    });
  });
}

test("open questions read right after start waits for Redis instead of throwing", async () => {
  const redis = await slowRedis(300);
  const prev = process.env.FOLDRUN_REDIS_URL;
  process.env.FOLDRUN_REDIS_URL = redis.url;
  const { cache } = await import("../src/cache.ts");
  const { openQuestions } = await import("../src/operator-store.ts");
  try {
    // The client is made here, so this read lands while it is still connecting.
    assert.deepEqual(await openQuestions("acme"), []);
    assert.ok(redis.seen.includes("HGETALL"), `the read reached Redis: ${redis.seen.join(",")}`);
  } finally {
    cache()?.disconnect();
    redis.close();
    if (prev === undefined) delete process.env.FOLDRUN_REDIS_URL;
    else process.env.FOLDRUN_REDIS_URL = prev;
  }
});

test("a Redis that never comes up costs one short wait per process, not one per call", async () => {
  // A port nothing listens on, and a module copy of its own (the query
  // string), so this client is not the one the test above made.
  const port = await new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
  const prev = process.env.FOLDRUN_REDIS_URL;
  process.env.FOLDRUN_REDIS_URL = `redis://127.0.0.1:${port}`;
  const fresh = (await import(`../src/cache.ts?down`)) as typeof import("../src/cache.ts");
  try {
    let t = Date.now();
    const c = await fresh.cacheClient(300);
    assert.ok(Date.now() - t >= 250, "the first call waits for the first connection");
    await assert.rejects(c!.hgetall("x"));
    t = Date.now();
    await fresh.cacheClient(300);
    assert.ok(Date.now() - t < 100, `a later call does not wait again (${Date.now() - t}ms)`);
  } finally {
    fresh.cache()?.disconnect();
    if (prev === undefined) delete process.env.FOLDRUN_REDIS_URL;
    else process.env.FOLDRUN_REDIS_URL = prev;
  }
});
