// Speech to text through the gateway (11 Nov 2026): POST /v1/foldrun/transcribe
// takes a gateway key and a 16 kHz mono WAV, and asks foldrun's own Whisper
// pods — the Persian model for Persian — for the words.
//
//   node --test tests/transcribe.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-transcribe-"));
delete process.env.FOLDRUN_DATABASE_URL;

const t = await import("../src/transcribe.ts");
const door = await import("../src/gateway-door.ts");
type ApiKeyRow = NonNullable<Awaited<ReturnType<typeof import("../src/api-keys-db.ts").findApiKeyByHashDb>>>;

/** A WAV header and `seconds` of silence, in the shape asked. */
function wav(seconds: number, o: { rate?: number; channels?: number; bits?: number; format?: number } = {}): Buffer {
  const rate = o.rate ?? 16_000, channels = o.channels ?? 1, bits = o.bits ?? 16, format = o.format ?? 1;
  const data = Math.round(seconds * rate) * channels * (bits / 8);
  const b = Buffer.alloc(44 + data);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + data, 4);
  b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(format, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * channels * (bits / 8), 28);
  b.writeUInt16LE(channels * (bits / 8), 32);
  b.writeUInt16LE(bits, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(data, 40);
  return b;
}

test("only a 16 kHz mono 16-bit PCM WAV is read, and its length comes from the data chunk", () => {
  assert.deepEqual(t.readWav(wav(2.5)), { seconds: 2.5 });
  assert.match((t.readWav(Buffer.from("not a wav at all, no header here........................")) as { error: string }).error, /not a WAV/);
  assert.match((t.readWav(wav(1, { rate: 44_100 })) as { error: string }).error, /44100 Hz/);
  assert.match((t.readWav(wav(1, { channels: 2 })) as { error: string }).error, /2 channel/);
  assert.match((t.readWav(wav(1, { format: 3, bits: 32 })) as { error: string }).error, /PCM 16-bit/);
  // A streamed WAV says 0xFFFFFFFF: what is there counts, never the claim.
  const streamed = wav(1);
  streamed.writeUInt32LE(0xffffffff, 40);
  assert.deepEqual(t.readWav(streamed), { seconds: 1 });
  // A claim longer than the bytes is cut to the bytes.
  const lying = wav(1);
  lying.writeUInt32LE(10_000_000, 40);
  assert.deepEqual(t.readWav(lying), { seconds: 1 });
  assert.equal(t.langCode("Persian"), "fa");
  assert.equal(t.langCode("english"), "en");
  assert.equal(t.langCode("klingon"), "klingon");
  assert.equal(t.langProblem("fa"), null);
  assert.equal(t.langProblem("auto"), null);
  assert.ok(t.langProblem("fa;rm -rf"));
});

/** A fake whisper-server: records what each base URL was asked, answers
 *  with `answer(base, language)`. */
function fakeWhisper(answer: (base: string, language: string) => { text: string; language: string } | { status: number }) {
  const seen: { base: string; language: string; format: string; file: number }[] = [];
  t.setTranscribeFetchForTests(async (input, init) => {
    const url = String(input);
    const form = init!.body as FormData;
    const base = url.replace(/\/inference$/, "");
    const language = String(form.get("language"));
    seen.push({ base, language, format: String(form.get("response_format")), file: ((form.get("file") as Blob) ?? new Blob()).size });
    const a = answer(base, language);
    if ("status" in a) return new Response("nope", { status: a.status });
    return new Response(JSON.stringify(a), { status: 200, headers: { "content-type": "application/json" } });
  });
  return seen;
}

const ENV = { FOLDRUN_TRANSCRIBE_URL: "http://general:8080", FOLDRUN_TRANSCRIBE_FA_URL: "http://fa:8080/" };

test("fa goes to the Persian model; auto asks the general one and hands Persian to the Persian model", async () => {
  const seen = fakeWhisper((base, language) => (base === "http://fa:8080" ? { text: " سلام دنیا ", language: "fa" } : { text: language === "en" || language === "auto" ? "hello world" : "x", language: language === "auto" ? "en" : language }));
  try {
    const fa = await t.transcribe(wav(2), "fa", ENV);
    assert.deepEqual(fa, { text: "سلام دنیا", language: "fa", model: "whisper-large-fa-v1", seconds: 2 });
    assert.deepEqual(seen.map((s) => [s.base, s.language, s.format]), [["http://fa:8080", "fa", "verbose_json"]], "trailing slash dropped; verbose_json so the language comes back");
    assert.equal(seen[0]!.file, wav(2).length, "the recording is sent whole");

    seen.length = 0;
    const en = await t.transcribe(wav(1), "auto", ENV);
    assert.equal(en.model, "whisper-large-v3-turbo");
    assert.equal(en.text, "hello world");
    assert.equal(seen.length, 1, "English heard: one pass");
  } finally {
    t.setTranscribeFetchForTests(null);
  }
  const seen2 = fakeWhisper((base) => (base === "http://fa:8080" ? { text: "سلام", language: "persian" } : { text: "salam", language: "persian" }));
  try {
    const auto = await t.transcribe(wav(1), "auto", ENV);
    assert.deepEqual([auto.text, auto.model], ["سلام", "whisper-large-fa-v1"]);
    assert.deepEqual(seen2.map((s) => s.base), ["http://general:8080", "http://fa:8080"], "Persian heard: the Persian model transcribes it again");
    // No Persian model set up: the general model's words stand.
    seen2.length = 0;
    const noFa = await t.transcribe(wav(1), "fa", { FOLDRUN_TRANSCRIBE_URL: "http://general:8080" });
    assert.deepEqual([noFa.text, noFa.model], ["salam", "whisper-large-v3-turbo"]);
  } finally {
    t.setTranscribeFetchForTests(null);
  }
});

test("refusals: not set up, too long, empty, a broken server — each a status a client can act on", async () => {
  const fail = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e as InstanceType<typeof t.TranscribeError>;
    }
    assert.fail("expected a refusal");
  };
  assert.equal((await fail(t.transcribe(wav(1), "fa", {})))!.status, 503);
  assert.equal((await fail(t.transcribe(wav(t.MAX_SECONDS + 1), "fa", ENV)))!.status, 413);
  assert.equal((await fail(t.transcribe(wav(0.1), "fa", ENV)))!.status, 400);
  assert.equal((await fail(t.transcribe(wav(1, { rate: 8000 }), "fa", ENV)))!.status, 400);
  assert.equal((await fail(t.transcribe(wav(1), "en", { FOLDRUN_TRANSCRIBE_FA_URL: "http://fa:8080" })))!.status, 503, "only Persian set up: another language is refused, not misheard");
  t.setTranscribeFetchForTests(async () => new Response(new ReadableStream({ start(c) { c.error(new Error("socket hang up")); } })));
  try {
    assert.equal((await fail(t.transcribe(wav(1), "fa", ENV)))!.status, 503, "a body that breaks mid-read is the service failing");
  } finally {
    t.setTranscribeFetchForTests(null);
  }
  fakeWhisper(() => ({ status: 500 }));
  try {
    assert.equal((await fail(t.transcribe(wav(1), "fa", ENV)))!.status, 502);
  } finally {
    t.setTranscribeFetchForTests(null);
  }
});

// ------------------------------------------------------- through the door

const sha = (k: string) => crypto.createHash("sha256").update(k).digest("hex");
const row = (secret: string, over: Partial<ApiKeyRow> = {}): ApiKeyRow => ({
  id: "k1",
  hash: sha(secret),
  prefix: "mda_abcdef12",
  label: "claude code",
  tenant: "acme",
  createdAt: new Date().toISOString(),
  revokedAt: null,
  role: "viewer",
  workspaces: null,
  purpose: "gateway",
  gateway: { capUsd: 5, dailyUsd: null },
  ...over,
});

test("the door: a gateway key and a WAV in, the words out; anything else refused before Whisper is asked", async () => {
  const rows = [row("mda_good"), row("mda_account", { id: "k2", purpose: undefined, gateway: undefined })];
  door.setGatewayKeyLookupForTests(async (h) => rows.find((r) => r.hash === h) ?? null);
  door.setGatewayTouchForTests(async () => {});
  const seen = fakeWhisper(() => ({ text: "سلام", language: "fa" }));
  Object.assign(process.env, ENV);
  const d = await door.startGatewayDoor(0);
  const post = (q: string, headers: Record<string, string>, body: Buffer) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port: d.port, path: `/v1/foldrun/transcribe${q}`, method: "POST", headers: { "content-type": "audio/wav", ...headers } }, (res) => {
        let b = "";
        res.on("data", (c: Buffer) => (b += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode!, body: b }));
      });
      r.on("error", reject);
      r.end(body);
    });
  try {
    const ok = await post("?lang=fa", { authorization: "Bearer mda_good" }, wav(1.5));
    assert.equal(ok.status, 200, ok.body);
    assert.deepEqual(JSON.parse(ok.body), { text: "سلام", language: "fa", model: "whisper-large-fa-v1", seconds: 1.5 });

    assert.equal((await post("?lang=fa", {}, wav(1))).status, 401, "no key");
    assert.equal((await post("?lang=fa", { "x-api-key": "mda_account" }, wav(1))).status, 403, "an account key is not a gateway key");
    assert.equal((await post("?lang=f%3Bx", { "x-api-key": "mda_good" }, wav(1))).status, 400, "a language that is not a code");
    const big = await post("?lang=fa", { "x-api-key": "mda_good" }, Buffer.alloc(t.MAX_BYTES + 10));
    assert.equal(big.status, 413);
    const notWav = await post("", { "x-api-key": "mda_good" }, Buffer.alloc(2000, 7));
    assert.equal(notWav.status, 400);
    assert.match(JSON.parse(notWav.body).error.message, /not a WAV/);
    assert.equal(seen.length, 1, "only the good recording reached Whisper");
  } finally {
    await d.close();
    t.setTranscribeFetchForTests(null);
    door.setGatewayKeyLookupForTests(null);
    door.setGatewayTouchForTests(null);
    delete process.env.FOLDRUN_TRANSCRIBE_URL;
    delete process.env.FOLDRUN_TRANSCRIBE_FA_URL;
  }
});

test("the door: an end customer is checked first — a blocked one is refused before Whisper or the key's buckets", async () => {
  const customers = await import("../src/customers.ts");
  const rows = [row("mda_good")];
  door.setGatewayKeyLookupForTests(async (h) => rows.find((r) => r.hash === h) ?? null);
  door.setGatewayTouchForTests(async () => {});
  const seen = fakeWhisper(() => ({ text: "hi", language: "english" }));
  Object.assign(process.env, ENV);
  const d = await door.startGatewayDoor(0);
  const post = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${d.port}/v1/foldrun/transcribe?lang=en`, { method: "POST", headers: { "content-type": "audio/wav", "x-api-key": "mda_good", ...headers }, body: new Uint8Array(wav(1)) });
  try {
    await customers.blockCustomer("acme", "c-bad", "ana@acme.test", "abuse");
    const blocked = await post({ "x-foldrun-customer": "c-bad" });
    assert.equal(blocked.status, 403);
    assert.match(await blocked.text(), /c-bad is blocked by this account/);
    assert.equal((await post({ "x-foldrun-customer": "has space" })).status, 400);
    assert.equal(seen.length, 0, "neither reached Whisper");
    const ok = await post({ "x-foldrun-customer": "c-good" });
    assert.equal(ok.status, 200, await ok.text());
    assert.equal(seen.length, 1);
  } finally {
    await customers.unblockCustomer("acme", "c-bad");
    await d.close();
    t.setTranscribeFetchForTests(null);
    door.setGatewayKeyLookupForTests(null);
    door.setGatewayTouchForTests(null);
    delete process.env.FOLDRUN_TRANSCRIBE_URL;
    delete process.env.FOLDRUN_TRANSCRIBE_FA_URL;
  }
});

test("a caller gone stops the work: the Whisper call is aborted and no Persian second pass starts", async () => {
  const cancel = new AbortController();
  const bases: string[] = [];
  t.setTranscribeFetchForTests(async (input, init) => {
    bases.push(String(input));
    cancel.abort(); // the caller leaves while the first pass runs
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    return new Response(JSON.stringify({ text: "salam", language: "persian" }));
  });
  try {
    await assert.rejects(t.transcribe(wav(1), "auto", ENV, cancel.signal), (e: { status: number }) => e.status === 504);
    assert.equal(bases.length, 1, "no second pass after the caller left");
  } finally {
    t.setTranscribeFetchForTests(null);
  }
});
