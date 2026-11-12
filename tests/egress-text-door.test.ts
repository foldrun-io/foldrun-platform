// tools: [text] — the egress proxy's /text/<lease> door (12 Nov 2026), end to
// end: core's extract_text (what the pod runs) and plain requests against the
// real proxy, with the extraction parser faked through extract.ts's seam.
//
//   node --test tests/egress-text-door.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-text-door-"));
process.env.FOLDRUN_DATA = DATA;
delete process.env.FOLDRUN_DATABASE_URL;
delete process.env.FOLDRUN_REDIS_URL;
process.env.FOLDRUN_EXTRACT_URL = "http://extract:8090";

const { egressHooks, parseTextDoorPath, startEgressProxy, stopEgressProxy } = await import("../src/egress-proxy.ts");
const x = await import("../src/extract.ts");
const { buildTextTools } = await import("../../foldrun-core/src/text-tool.ts");

const T = "t".repeat(24);

test("the door's path carries the lease and the query", () => {
  const d = parseTextDoorPath(`/text/${T}?name=a.png&lang=fa`)!;
  assert.equal(d.token, T);
  assert.equal(d.query.get("name"), "a.png");
  assert.equal(d.query.get("lang"), "fa");
  assert.equal(parseTextDoorPath("/text/short"), null);
  assert.equal(parseTextDoorPath(`/text/${T}/more`), null);
  assert.equal(parseTextDoorPath(`/e/${T}/https://x.com`), null);
});

async function withProxy<R>(fn: (base: string) => Promise<R>): Promise<R> {
  const proxy = await startEgressProxy(0);
  const prev = process.env.FOLDRUN_EGRESS_URL;
  process.env.FOLDRUN_EGRESS_URL = `http://127.0.0.1:${proxy.port}`;
  try {
    return await fn(process.env.FOLDRUN_EGRESS_URL);
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_EGRESS_URL;
    else process.env.FOLDRUN_EGRESS_URL = prev;
    await stopEgressProxy();
    x.setExtractFetchForTests(null);
  }
}

/** The parser, answering every file as an image with this text. */
function fakeParser(answer: () => { status?: number; body: unknown } = () => ({ body: { kind: "image", format: "png", text: "سلام\nhello", engine: "tesseract:fas+eng", ocr_pages: [1], needs_speech: false, truncated: false, warnings: [] } })) {
  const calls: { query: URLSearchParams; bytes: number }[] = [];
  x.setExtractFetchForTests(async (input, init) => {
    const url = new URL(String(input));
    calls.push({ query: url.searchParams, bytes: (init!.body as Uint8Array).byteLength });
    const a = answer();
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
  });
  return calls;
}

const token = (url: string) => url.match(/\/e\/([A-Za-z0-9_-]+)$/)![1]!;
const post = (base: string, tok: string, body: Buffer, q = "name=photo.png") =>
  fetch(`${base}/text/${tok}?${q}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(body) });
const file = (label: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(`${label}-${crypto.randomBytes(8).toString("hex")}`)]);

test("no such lease: refused (401), and nothing is sent to the parser", async () => {
  const calls = fakeParser();
  await withProxy(async (base) => {
    const res = await post(base, "z".repeat(32), file("nolease"));
    assert.equal(res.status, 401);
    assert.match(((await res.json()) as { error: string }).error, /no such lease/);
    assert.equal(calls.length, 0);
  });
});

test("a lease without text: true is refused (403) — the tool is the agent's grant, not the pod's choice", async () => {
  const calls = fakeParser();
  await withProxy(async (base) => {
    const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-plain", grant: { secrets: {} } }))!;
    const res = await post(base, token(lease.url), file("plain"));
    assert.equal(res.status, 403);
    assert.match(((await res.json()) as { error: string }).error, /tools: \[text\]/);
    const get = await fetch(`${base}/text/${token(lease.url)}`);
    assert.equal(get.status, 405);
    assert.equal(calls.length, 0);
    await lease.release();
  });
});

test("a text lease: the file goes to extractFile for its account, the result comes back, the trace names the file and never the text", async () => {
  const calls = fakeParser();
  await withProxy(async (base) => {
    const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-text", grant: { secrets: {} }, text: true }))!;
    const bytes = file("good");
    const res = await post(base, token(lease.url), bytes, "name=scans%2Fphoto.png&lang=fa&ocr=always");
    assert.equal(res.status, 200);
    const r = (await res.json()) as { kind: string; text: string; sha256: string; cached: boolean };
    assert.equal(r.kind, "image");
    assert.equal(r.text, "سلام\nhello");
    assert.equal(r.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.bytes, bytes.length);
    assert.equal(calls[0]!.query.get("name"), "photo.png", "only the file's own name");
    assert.equal(calls[0]!.query.get("lang"), "fas+eng");
    assert.equal(calls[0]!.query.get("ocr"), "always");
    // The same file again: the account's artifact, not the parser.
    const again = (await (await post(base, token(lease.url), bytes, "name=photo.png&lang=fa&ocr=always")).json()) as { cached: boolean };
    assert.equal(again.cached, true);
    assert.equal(calls.length, 1);
    const trace = (await lease.drainLog()).map((l) => JSON.stringify(l)).join("\n");
    assert.match(trace, /text: photo\.png \(1 KB\) sent to the extraction service/);
    assert.match(trace, /text: photo\.png → image \(png\), 10 chars/);
    assert.doesNotMatch(trace, /hello|سلام/, "the text never sits in the trace");
    await lease.release();
  });
});

test("core's extract_text through the door: the header and the text, ocrPages counted", async () => {
  fakeParser();
  await withProxy(async () => {
    const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-tool", grant: { secrets: {} }, text: true }))!;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "text-tool-"));
    fs.mkdirSync(path.join(dir, "agents", "reader"), { recursive: true });
    fs.writeFileSync(path.join(dir, "agents", "reader", "scan.png"), file("tool"));
    const tools = buildTextTools({ egress: lease.url, agentDir: path.join(dir, "agents", "reader"), workspaceRoot: dir, libraryRoot: path.join(dir, "lib") });
    const out = (await tools.call({ path: "scan.png" })) as { content: { text: string }[]; isError?: boolean };
    assert.notEqual(out.isError, true, out.content[0]!.text);
    assert.match(out.content[0]!.text, /^\[extract_text\] scan\.png: image \(png\)/);
    assert.match(out.content[0]!.text, /hello/);
    await lease.release();
  });
});

test("past the cap: 413 before the body is read; no content-length: 411", async () => {
  const calls = fakeParser();
  const prev = process.env.FOLDRUN_EXTRACT_MAX_MB;
  process.env.FOLDRUN_EXTRACT_MAX_MB = "0.001"; // ~1 KB
  try {
    await withProxy(async (base) => {
      const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-big", grant: { secrets: {} }, text: true }))!;
      const res = await post(base, token(lease.url), Buffer.alloc(4096, 1));
      assert.equal(res.status, 413);
      assert.match(((await res.json()) as { error: string }).error, /at most/);
      // Chunked, no length: refused.
      const http = await import("node:http");
      const status = await new Promise<number>((resolve, reject) => {
        const u = new URL(`${base}/text/${token(lease.url)}?name=a.png`);
        const r = http.request({ host: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method: "POST", headers: { "transfer-encoding": "chunked" } }, (res2) => {
          res2.resume();
          resolve(res2.statusCode ?? 0);
        });
        r.on("error", reject);
        r.end("abc");
      });
      assert.equal(status, 411);
      assert.equal(calls.length, 0);
      await lease.release();
    });
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_EXTRACT_MAX_MB;
    else process.env.FOLDRUN_EXTRACT_MAX_MB = prev;
  }
});

test("the service's own refusal passes through with its status; a bug is a 502", async () => {
  let answer: () => { status?: number; body: unknown } = () => ({ status: 415, body: { error: { code: "unsupported", message: "this file type is not read" } } });
  fakeParser(() => answer());
  await withProxy(async (base) => {
    const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-refused", grant: { secrets: {} }, text: true }))!;
    const res = await post(base, token(lease.url), file("refused"));
    assert.equal(res.status, 415);
    assert.deepEqual(await res.json(), { error: "this file type is not read", code: "unsupported" });
    // Not JSON at all from the parser: its 502.
    answer = () => ({ body: "not an object" });
    const bad = await post(base, token(lease.url), file("bad"));
    assert.equal(bad.status, 502);
    // An unknown lang: our 400.
    const lang = await post(base, token(lease.url), file("lang"), "name=a.png&lang=klingon");
    assert.equal(lang.status, 400);
    await lease.release();
  });
});

test("rate: past the step's files a minute, 429 with Retry-After", async () => {
  fakeParser();
  const prev = process.env.FOLDRUN_EXTRACT_DOOR_RATE_PER_MIN;
  process.env.FOLDRUN_EXTRACT_DOOR_RATE_PER_MIN = "2";
  try {
    await withProxy(async (base) => {
      const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-rate", grant: { secrets: {} }, text: true }))!;
      assert.equal((await post(base, token(lease.url), file("r1"))).status, 200);
      assert.equal((await post(base, token(lease.url), file("r2"))).status, 200);
      const third = await post(base, token(lease.url), file("r3"));
      assert.equal(third.status, 429);
      assert.ok(Number(third.headers.get("retry-after")) > 0);
      assert.match(((await third.json()) as { error: string }).error, /2 files a minute/);
      // Another step's lease has its own count.
      const other = (await egressHooks.lease({ tenant: "acme", runId: "run-rate-2", grant: { secrets: {} }, text: true }))!;
      assert.equal((await post(base, token(other.url), file("r4"))).status, 200);
      await lease.release();
      await other.release();
    });
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_EXTRACT_DOOR_RATE_PER_MIN;
    else process.env.FOLDRUN_EXTRACT_DOOR_RATE_PER_MIN = prev;
  }
});

test("the account's extractions in flight: every place taken, 429 too_many_running", async () => {
  fakeParser();
  const prev = process.env.FOLDRUN_EXTRACT_ACCOUNT_CAP;
  process.env.FOLDRUN_EXTRACT_ACCOUNT_CAP = "1";
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  try {
    await withProxy(async (base) => {
      const busy = x.withExtractSlot("busyco", "key:other", () => held);
      await new Promise((r) => setTimeout(r, 50));
      const lease = (await egressHooks.lease({ tenant: "busyco", runId: "run-full", grant: { secrets: {} }, text: true }))!;
      const res = await post(base, token(lease.url), file("full"));
      assert.equal(res.status, 429);
      assert.equal((await res.json() as { code: string }).code, "too_many_running");
      assert.equal(res.headers.get("retry-after"), "15");
      release();
      await busy;
      assert.equal((await post(base, token(lease.url), file("free"))).status, 200, "a place again once the other finished");
      await lease.release();
    });
  } finally {
    release?.();
    if (prev === undefined) delete process.env.FOLDRUN_EXTRACT_ACCOUNT_CAP;
    else process.env.FOLDRUN_EXTRACT_ACCOUNT_CAP = prev;
  }
});

test("the proxy's memory for files: past FOLDRUN_EXTRACT_DOOR_MEMORY_MB a call is told to retry (429), nothing is read", async () => {
  const calls = fakeParser();
  const prev = process.env.FOLDRUN_EXTRACT_DOOR_MEMORY_MB;
  process.env.FOLDRUN_EXTRACT_DOOR_MEMORY_MB = "0.001"; // ~1 KB held at most
  try {
    await withProxy(async (base) => {
      const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-mem", grant: { secrets: {} }, text: true }))!;
      const res = await post(base, token(lease.url), Buffer.alloc(4096, 1));
      assert.equal(res.status, 429);
      assert.equal(res.headers.get("retry-after"), "15");
      assert.equal(calls.length, 0);
    });
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_EXTRACT_DOOR_MEMORY_MB;
    else process.env.FOLDRUN_EXTRACT_DOOR_MEMORY_MB = prev;
  }
});

test("a caller that stalls mid-upload is cut off at the upload deadline (408), and nothing is sent", async () => {
  const calls = fakeParser();
  const prev = process.env.FOLDRUN_EXTRACT_DOOR_UPLOAD_SECONDS;
  process.env.FOLDRUN_EXTRACT_DOOR_UPLOAD_SECONDS = "0.3";
  try {
    await withProxy(async (base) => {
      const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-stall", grant: { secrets: {} }, text: true }))!;
      const http = await import("node:http");
      const status = await new Promise<number>((resolve, reject) => {
        const u = new URL(`${base}/text/${token(lease.url)}?name=a.png`);
        const r = http.request({ host: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method: "POST", headers: { "content-length": "4096" } }, (res2) => {
          res2.resume();
          resolve(res2.statusCode ?? 0);
        });
        r.on("error", () => resolve(-1));
        r.write(Buffer.alloc(100, 1)); // then nothing more
        setTimeout(() => reject(new Error("no answer")), 5000).unref();
      });
      assert.ok(status === 408 || status === -1, `got ${status}`);
      assert.equal(calls.length, 0);
    });
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_EXTRACT_DOOR_UPLOAD_SECONDS;
    else process.env.FOLDRUN_EXTRACT_DOOR_UPLOAD_SECONDS = prev;
  }
});
