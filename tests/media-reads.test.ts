// FOL-268 (owner, 25 Nov 2026: a job for the worker): the gateway queues an image or PDF block, the worker reads it.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

delete process.env.FOLDRUN_DATABASE_URL;
const { readViaWorker, startMediaReads, resetMediaReadsForTests, sweepMediaReads, MEDIA_READS_PER_ACCOUNT } = await import("../src/media-reads.ts");
const { mediaToText, setMediaToTextForTests } = await import("../src/gateway-media.ts");

afterEach(() => {
  resetMediaReadsForTests();
  setMediaToTextForTests(null);
});

test("a block queued by the gateway is read by the worker and its text comes back", async () => {
  const seen: string[] = [];
  startMediaReads(async (tenant, bytes, o) => (seen.push(`${tenant}:${o.name}:${bytes.toString()}`), { text: `TEXT ${bytes.toString()}` }));
  const r = await readViaWorker("acme", Buffer.from("png-bytes"), { name: "image.png", deadlineMs: 5000 });
  assert.equal(r.text, "TEXT png-bytes");
  assert.deepEqual(seen, ["acme:image.png:png-bytes"]);
});

test("a worker's failure, or no worker at all within the deadline, is thrown — the block then goes as it was", async () => {
  startMediaReads(async () => {
    throw new Error("parser down");
  });
  await assert.rejects(readViaWorker("acme", Buffer.from("x"), { name: "image.png", deadlineMs: 5000 }), /parser down/);
  resetMediaReadsForTests();
  await assert.rejects(readViaWorker("acme", Buffer.from("x"), { name: "image.png", deadlineMs: 300 }), /not read in time/);
});

test("a caller that leaves cancels its block; past the account's limit a block is refused", async () => {
  const gone = new AbortController();
  const p = readViaWorker("acme", Buffer.from("x"), { name: "image.png", deadlineMs: 5000, signal: gone.signal });
  gone.abort();
  await assert.rejects(p, /went away|not read/);
  resetMediaReadsForTests();
  const waits = Array.from({ length: MEDIA_READS_PER_ACCOUNT }, () => readViaWorker("acme", Buffer.from("x"), { name: "image.png", deadlineMs: 400 }).catch(() => "timed out"));
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(readViaWorker("acme", Buffer.from("x"), { name: "image.png", deadlineMs: 400 }), /too many/);
  await Promise.all(waits);
  assert.equal(await sweepMediaReads(Date.now() + 60_000), 0, "the timed-out rows were already cancelled");
});

test("the gateway, which cannot read files itself, has the worker read them when the install says so", async () => {
  setMediaToTextForTests({ configured: () => false, viaWorker: () => true, slot: (_t, _a, fn) => fn() });
  startMediaReads(async (_t, bytes) => ({ text: `worker read ${bytes.toString()}` }));
  const png = { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("png-bytes").toString("base64") } };
  const body = Buffer.from(JSON.stringify({ model: "m", messages: [{ role: "user", content: [png, { type: "text", text: "what does it say?" }] }] }));
  const out = await mediaToText("acme", body);
  assert.deepEqual([out.read, out.left], [1, 0]);
  assert.match(out.body.toString(), /worker read png-bytes/);
  assert.doesNotMatch(out.body.toString(), /"type":"image"/);
  // Not told a worker reads: left as it was, and said so.
  setMediaToTextForTests({ configured: () => false, viaWorker: () => false });
  const off = await mediaToText("acme", body);
  assert.deepEqual([off.read, off.left, off.body === body], [0, 1, true]);
});
