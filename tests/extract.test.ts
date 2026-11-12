// Files to text (12 Nov 2026): extract.ts asks the parser pod for a file's
// text, cuts a recording's audio into segments for Whisper, keeps one
// immutable result per (account, sha256, options), and runs the work as a
// job a caller waits on or polls. The parser and Whisper are faked here
// through their test seams; the file store stands in for Postgres.
//
//   node --test tests/extract.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-extract-"));
process.env.FOLDRUN_DATA = DATA;
delete process.env.FOLDRUN_DATABASE_URL;
delete process.env.FOLDRUN_REDIS_URL;
process.env.FOLDRUN_EXTRACT_URL = "http://extract:8090";
process.env.FOLDRUN_TRANSCRIBE_URL = "http://general:8080";
process.env.FOLDRUN_TRANSCRIBE_FA_URL = "http://fa:8080";

const x = await import("../src/extract.ts");
const t = await import("../src/transcribe.ts");
const storage = await import("../../foldrun-core/src/storage.ts");

/** A 16 kHz mono WAV of `seconds` of a tone (or silence). */
function wav(seconds: number, silent = false): Buffer {
  const data = Math.round(seconds * 16_000) * 2;
  const b = Buffer.alloc(44 + data);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + data, 4);
  b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16_000, 24);
  b.writeUInt32LE(32_000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(data, 40);
  if (!silent) for (let i = 0; i < data; i += 64) b.writeInt16LE(9000, 44 + i);
  return b;
}

type Call = { route: string; query: URLSearchParams; bytes: number };
/** A fake parser: `extract` answers /extract; /audio answers a WAV of the
 *  segment's length (silent where `silentFrom` says). */
function fakeParser(extract: (q: URLSearchParams) => { status?: number; body: unknown }, o: { total?: number; silentAt?: number[] } = {}) {
  const calls: Call[] = [];
  x.setExtractFetchForTests(async (input, init) => {
    const url = new URL(String(input));
    const bytes = (init!.body as Uint8Array).byteLength;
    calls.push({ route: url.pathname.slice(1), query: url.searchParams, bytes });
    assert.equal(init!.redirect, "error", "redirects refused");
    if (url.pathname === "/audio") {
      const start = Number(url.searchParams.get("start"));
      const len = Math.min(Number(url.searchParams.get("seconds")), (o.total ?? 0) - start);
      return new Response(new Uint8Array(wav(len, o.silentAt?.includes(start))), { status: 200, headers: { "content-type": "audio/wav" } });
    }
    const a = extract(url.searchParams);
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { "content-type": "application/json", server: "foldrun-extract/0.1.0 Python/3.12" } });
  });
  return calls;
}

/** A fake whisper-server: `answer(base, language, detect)`. */
function fakeWhisper(answer: (base: string, language: string, detect: boolean) => { text: string; language: string }) {
  const seen: { base: string; language: string; detect: boolean }[] = [];
  t.setTranscribeFetchForTests(async (input, init) => {
    const form = init!.body as FormData;
    const base = String(input).replace(/\/inference$/, "");
    const language = String(form.get("language"));
    const detect = form.get("detect_language") === "true";
    seen.push({ base, language, detect });
    return Response.json(answer(base, language, detect));
  });
  return seen;
}

const image = (text: string, extra: Record<string, unknown> = {}) => ({
  body: { kind: "image", format: "png", text, confidence: 91.2, engine: "tesseract:fas+eng", ocr: true, needs_speech: false, truncated: false, warnings: [], ms: 40, ...extra },
});
const unique = (label: string) => Buffer.from(`${label}-${crypto.randomBytes(8).toString("hex")}`);

test.afterEach(() => {
  x.setExtractFetchForTests(null);
  t.setTranscribeFetchForTests(null);
});

test("an image: its OCR text, the parser asked for fas+eng (eng for lang=en), the hash of the bytes", async () => {
  const calls = fakeParser(() => image("سلام دنیا\nhello world"));
  const bytes = unique("photo");
  const r = await x.extractFile("acme", bytes, { name: "uploads/photo.PNG" });
  assert.equal(r.kind, "image");
  assert.equal(r.format, "png");
  assert.equal(r.text, "سلام دنیا\nhello world");
  assert.equal(r.confidence, 91.2);
  assert.deepEqual(r.engine, { parser: "tesseract:fas+eng" });
  assert.equal(r.cached, false);
  assert.equal(r.truncated, false);
  assert.equal(r.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].route, "extract");
  assert.equal(calls[0].query.get("lang"), "fas+eng");
  assert.equal(calls[0].query.get("ocr"), "auto");
  assert.equal(calls[0].query.get("name"), "photo.PNG", "only the file's own name reaches the parser");
  assert.equal(calls[0].bytes, bytes.length, "the file is sent whole");

  await x.extractFile("acme", unique("photo-en"), { lang: "en", ocr: "always" });
  assert.equal(calls[1].query.get("lang"), "eng");
  assert.equal(calls[1].query.get("ocr"), "always");
  await assert.rejects(x.extractFile("acme", unique("bad"), { lang: "klingon" }), (e: InstanceType<typeof x.ExtractError>) => e.status === 400 && e.code === "bad_request");
});

test("audio: cut into 300 s segments, each to Whisper, joined under one marker; auto keeps the language the first part was heard in", async () => {
  const total = 650;
  const calls = fakeParser(() => ({ body: { kind: "audio", format: "mp3", text: "", seconds: total, has_audio: true, needs_speech: true, engine: "ffmpeg", ocr: false, truncated: false, warnings: [] } }), { total });
  let n = 0;
  const seen = fakeWhisper((base, language, detect) => (detect ? { text: "", language: "persian" } : { text: `بخش ${++n}`, language: base === "http://fa:8080" ? "fa" : language }));
  const r = await x.extractFile("acme", unique("voice"), { name: "voice.mp3" });
  assert.deepEqual(calls.map((c) => [c.route, c.query.get("start"), c.query.get("seconds")]), [["extract", null, null], ["audio", "0", "300"], ["audio", "300", "300"], ["audio", "600", "300"]]);
  assert.deepEqual(
    seen.map((s) => [s.base, s.language, s.detect]),
    [["http://general:8080", "auto", true], ["http://fa:8080", "fa", false], ["http://fa:8080", "fa", false], ["http://fa:8080", "fa", false]],
    "one detection pass for the whole file, then Persian straight to the Persian model",
  );
  assert.equal(r.text, "[audio · 10:50 · transcript, fa]\nبخش 1\nبخش 2\nبخش 3");
  assert.equal(r.language, "fa");
  assert.equal(r.seconds, 650);
  assert.deepEqual(r.engine, { parser: "ffmpeg", speech: "whisper-large-fa-v1" });
});

test("a silent stretch is skipped, not a failure; all silent says no speech was heard", async () => {
  fakeParser(() => ({ body: { kind: "audio", format: "wav", text: "", seconds: 400, needs_speech: true, engine: "ffmpeg", truncated: false, warnings: [] } }), { total: 400, silentAt: [300] });
  fakeWhisper(() => ({ text: "hello", language: "en" }));
  const r = await x.extractFile("acme", unique("quiet"), { lang: "en" });
  assert.equal(r.text, "[audio · 6:40 · transcript, en]\nhello");
  assert.ok(r.warnings.some((w) => /1 silent part/.test(w)), r.warnings.join("; "));

  fakeParser(() => ({ body: { kind: "audio", format: "wav", text: "", seconds: 20, needs_speech: true, engine: "ffmpeg", truncated: false, warnings: [] } }), { total: 20, silentAt: [0] });
  const none = await x.extractFile("acme", unique("silent"), { lang: "en" });
  assert.equal(none.text, "[audio · 0:20 · no speech heard]");
  assert.ok(none.warnings.includes("no speech was heard in the audio"));
});

test("speech without a length is a bad answer (502), never stored as no speech", async () => {
  fakeParser(() => ({ body: { kind: "audio", format: "mp3", text: "", needs_speech: true, engine: "ffmpeg", truncated: false, warnings: [] } }), { total: 10 });
  fakeWhisper(() => ({ text: "hello", language: "en" }));
  const bytes = unique("nolength");
  await assert.rejects(x.extractFile("acme", bytes, { lang: "en" }), (e: { status?: number; code?: string }) => e.status === 502 && e.code === "parser_bad_answer");
  // Not cached: the next, well-formed answer is used.
  fakeParser(() => ({ body: { kind: "audio", format: "mp3", text: "", seconds: 10, needs_speech: true, engine: "ffmpeg", truncated: false, warnings: [] } }), { total: 10 });
  const ok = await x.extractFile("acme", bytes, { lang: "en" });
  assert.equal(ok.cached, false);
  assert.match(ok.text, /hello/);
});

test("video: what is said, then the on-screen text the parser read", async () => {
  fakeParser(() => ({ body: { kind: "video", format: "mp4", text: "[0:05 · on-screen text]\nقیمت ۲۰۰ تومان", seconds: 42, has_audio: true, needs_speech: true, confidence: 80, engine: "ffmpeg+tesseract:fas+eng", ocr: true, truncated: false, warnings: [] } }), { total: 42 });
  fakeWhisper(() => ({ text: "hello and welcome", language: "en" }));
  const r = await x.extractFile("acme", unique("clip"), { name: "clip.mp4", lang: "en" });
  assert.equal(r.text, "[video · 0:42 · speech]\nhello and welcome\n\n[0:05 · on-screen text]\nقیمت ۲۰۰ تومان");
  assert.equal(r.kind, "video");
  assert.equal(r.language, "en");
  assert.equal(r.engine.speech, "whisper-large-v3-turbo");

  // A video with no sound is the parser's text alone; Whisper is not asked.
  fakeParser(() => ({ body: { kind: "video", format: "webm", text: "[0:00 · on-screen text]\nslide", seconds: 10, has_audio: false, needs_speech: false, engine: "ffmpeg+tesseract:eng", truncated: false, warnings: [] } }));
  const seen = fakeWhisper(() => ({ text: "x", language: "en" }));
  assert.equal((await x.extractFile("acme", unique("mute"))).text, "[0:00 · on-screen text]\nslide");
  assert.equal(seen.length, 0);
});

test("the same file again is the artifact: cached, the parser asked once; other options are another extraction", async () => {
  const calls = fakeParser(() => image("once"));
  const bytes = unique("same");
  const first = await x.extractFile("acme", bytes, { name: "a.png" });
  const again = await x.extractFile("acme", bytes, { name: "b.png" });
  assert.equal(first.cached, false);
  assert.equal(again.cached, true);
  assert.equal(again.text, "once");
  assert.equal(again.sha256, first.sha256);
  assert.equal(calls.length, 1, "the parser was asked once");
  await x.extractFile("acme", bytes, { name: "a.png", lang: "en" });
  assert.equal(calls.length, 2, "lang changes the text: a second extraction");
  assert.notEqual(x.optionsKey(x.parseExtractOptions({ ocr: "never" })), x.optionsKey(x.parseExtractOptions({})));
});

test("artifacts are the account's own: another account's same file is extracted again", async () => {
  const calls = fakeParser(() => image("private"));
  const bytes = unique("shared-file");
  assert.equal((await x.extractFile("acme", bytes)).cached, false);
  const other = await x.extractFile("globex", bytes);
  assert.equal(other.cached, false, "no hit across accounts");
  assert.equal(calls.length, 2);
  assert.equal((await x.extractFile("globex", bytes)).cached, true);
  assert.equal(calls.length, 2);
});

test("the parser's refusals pass through with their status and code; a failure stores nothing", async () => {
  const calls = fakeParser(() => ({ status: 415, body: { error: { code: "unsupported", message: "this is a zip archive. Read here: images, PDF" } } }));
  const bytes = unique("zip");
  await assert.rejects(x.extractFile("acme", bytes), (e: InstanceType<typeof x.ExtractError>) => e instanceof x.ExtractError && e.status === 415 && e.code === "unsupported" && /zip archive/.test(e.message));
  fakeParser(() => ({ status: 413, body: { error: { code: "too_large", message: "the PDF has 9000 pages; the limit is 500" } } }));
  await assert.rejects(x.extractFile("acme", unique("big")), (e: InstanceType<typeof x.ExtractError>) => e.status === 413 && e.code === "too_large");
  fakeParser(() => ({ status: 500, body: { error: { code: "internal", message: "the parser failed on this file" } } }));
  await assert.rejects(x.extractFile("acme", unique("boom")), (e: InstanceType<typeof x.ExtractError>) => e.status === 502 && e.code === "parser_failed");
  // The 415 left no artifact: asked again, the parser is asked again.
  const again = fakeParser(() => image("now readable"));
  assert.equal((await x.extractFile("acme", bytes)).cached, false);
  assert.equal(again.length, 1);
  assert.equal(calls.length, 1);
});

test("unconfigured: 503, in the words the API answers", async () => {
  const saved = process.env.FOLDRUN_EXTRACT_URL;
  delete process.env.FOLDRUN_EXTRACT_URL;
  try {
    await assert.rejects(x.extractFile("acme", unique("any")), (e: InstanceType<typeof x.ExtractError>) => e.status === 503 && e.code === "not_configured" && e.message === "text extraction is not configured on this server");
    await assert.rejects(x.startExtractJob({ tenant: "acme", actor: "key:k1", bytes: unique("any") }), (e: InstanceType<typeof x.ExtractError>) => e.status === 503);
  } finally {
    process.env.FOLDRUN_EXTRACT_URL = saved;
  }
  // Speech asked for with no Whisper set up: 503, and no artifact taken.
  const savedT = process.env.FOLDRUN_TRANSCRIBE_URL;
  const savedFa = process.env.FOLDRUN_TRANSCRIBE_FA_URL;
  delete process.env.FOLDRUN_TRANSCRIBE_URL;
  delete process.env.FOLDRUN_TRANSCRIBE_FA_URL;
  const calls = fakeParser(() => ({ body: { kind: "audio", format: "ogg", text: "", seconds: 5, needs_speech: true, engine: "ffmpeg", truncated: false, warnings: [] } }), { total: 5 });
  const bytes = unique("voice-note");
  try {
    await assert.rejects(x.extractFile("acme", bytes), (e: InstanceType<typeof x.ExtractError>) => e.status === 503 && e.code === "speech_not_configured");
  } finally {
    process.env.FOLDRUN_TRANSCRIBE_URL = savedT;
    process.env.FOLDRUN_TRANSCRIBE_FA_URL = savedFa;
  }
  fakeWhisper(() => ({ text: "hi", language: "en" }));
  assert.equal((await x.extractFile("acme", bytes, { lang: "en" })).cached, false);
  assert.equal(calls.length, 3, "extracted again (extract + audio): the failed attempt took no artifact");
});

test("the parser's answer is untrusted: oversized text is cut, a wrong shape or non-JSON is a 502", async () => {
  const huge = "ا".repeat(x.MAX_TEXT_BYTES); // two bytes each: twice the cap
  fakeParser(() => image(huge, { warnings: ["w".repeat(5000), 42, "ok"], format: "../../etc", ocr_pages: [1, -3, "x", 2], pages: 1e12 }));
  const r = await x.extractFile("acme", unique("huge"));
  assert.ok(Buffer.byteLength(r.text, "utf8") <= x.MAX_TEXT_BYTES, "cut to the cap");
  assert.ok(!r.text.endsWith("\uFFFD"), "cut on a character boundary");
  assert.equal(r.truncated, true);
  assert.ok(r.warnings.some((w) => /cut at/.test(w)));
  assert.ok(r.warnings.every((w) => typeof w === "string" && w.length <= 300), "warnings: strings only, bounded");
  assert.equal(r.format, "unknown", "a format that is not a short token is not believed");
  assert.equal(r.pages, undefined, "an absurd page count is dropped");
  assert.deepEqual(r.ocrPages, [1, 2]);

  fakeParser(() => ({ body: { kind: "exe", text: "x" } }));
  await assert.rejects(x.extractFile("acme", unique("exe")), (e: InstanceType<typeof x.ExtractError>) => e.status === 502 && e.code === "parser_bad_answer");
  x.setExtractFetchForTests(async () => new Response("<html>proxy error</html>", { status: 200 }));
  await assert.rejects(x.extractFile("acme", unique("html")), (e: InstanceType<typeof x.ExtractError>) => e.status === 502 && /not JSON/.test(e.message));
  // A body longer than any answer could be is refused before it is read whole.
  x.setExtractFetchForTests(async () => new Response("{}", { status: 200, headers: { "content-length": String(64 * 1024 * 1024) } }));
  await assert.rejects(x.extractFile("acme", unique("long")), (e: InstanceType<typeof x.ExtractError>) => e.status === 502);
  // Too large a file never reaches the parser.
  process.env.FOLDRUN_EXTRACT_MAX_MB = "0.001";
  try {
    await assert.rejects(x.extractFile("acme", Buffer.alloc(2048, 1)), (e: InstanceType<typeof x.ExtractError>) => e.status === 413 && e.code === "too_large");
  } finally {
    delete process.env.FOLDRUN_EXTRACT_MAX_MB;
  }
});

test("a job: done, waited for, and its text written beside the file", async () => {
  const ws = path.join(DATA, "acme", "workspaces", "desk");
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
  fakeParser(() => image("متن نامه"));
  const job = await x.startExtractJob({ tenant: "acme", workspace: "desk", actor: "user:u1", bytes: unique("letter"), options: { name: "letter.jpg" }, write: { path: "inbox/letter.jpg.txt", by: "user:ana@acme.test" } });
  assert.equal(job.status, "running");
  assert.ok(x.isExtractJobId(job.id));
  const done = await x.waitForJob("acme", job.id, 10);
  assert.equal(done?.status, "done", JSON.stringify(done?.error));
  assert.equal(done?.result?.text, "متن نامه");
  assert.equal(done?.wrote, "inbox/letter.jpg.txt");
  const written = await storage.readFileBytes("acme", "desk", "inbox/letter.jpg.txt");
  assert.equal(written?.toString("utf8"), "متن نامه");
  assert.equal(storage.getFile("acme", "desk", "inbox/letter.jpg.txt")?.by, "user:ana@acme.test");
  // Another account cannot read it, and a made-up id is nothing.
  assert.equal(await x.getJob("globex", job.id), null);
  assert.equal(await x.getJob("acme", "xj-nosuchjob0000"), null);
  assert.equal(await x.getJob("acme", "../../etc/passwd"), null);
  // Writing is to a .txt only.
  await assert.rejects(x.startExtractJob({ tenant: "acme", workspace: "desk", actor: "user:u1", bytes: unique("y"), write: { path: "inbox/a.pdf", by: "user:a" } }), (e: InstanceType<typeof x.ExtractError>) => e.status === 400);
});

test("a failed job says why; a job whose process stopped is failed when next read", async () => {
  fakeParser(() => ({ status: 422, body: { error: { code: "unreadable", message: "the PDF is damaged" } } }));
  const job = await x.startExtractJob({ tenant: "acme", actor: "key:k9", bytes: unique("damaged") });
  const out = await x.waitForJob("acme", job.id, 10);
  assert.equal(out?.status, "failed");
  assert.deepEqual(out?.error, { status: 422, code: "unreadable", message: "the PDF is damaged" });

  // A running job no process holds any more: its lease ran out.
  const id = x.newExtractJobId();
  const file = path.join(DATA, "acme", "extract", "jobs", `${id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ id, tenant: "acme", workspace: null, actor: "key:k9", status: "running", options: { lang: "auto", ocr: "auto" }, wrote: null, writePath: null, createdAt: new Date().toISOString(), finishedAt: null, leaseUntil: Date.now() - 1000 }));
  const reaped = await x.getJob("acme", id);
  assert.equal(reaped?.status, "failed");
  assert.equal(reaped?.error?.code, "worker_stopped");
  assert.match(reaped!.error!.message, /the server working on it stopped/);
});

test("limits: a credential's rate and an account's jobs in flight, refused with 429 and Retry-After", async () => {
  process.env.FOLDRUN_EXTRACT_RATE_PER_MIN = "2";
  try {
    fakeParser(() => image("fast"));
    const a = await x.startExtractJob({ tenant: "rate", actor: "key:r1", bytes: unique("r") });
    await x.startExtractJob({ tenant: "rate", actor: "key:r1", bytes: unique("r") });
    await assert.rejects(x.startExtractJob({ tenant: "rate", actor: "key:r1", bytes: unique("r") }), (e: InstanceType<typeof x.ExtractError>) => e.status === 429 && e.code === "rate_limited" && typeof e.retryAfter === "number" && e.retryAfter > 0);
    // Another credential has its own rate.
    await x.startExtractJob({ tenant: "rate", actor: "key:r2", bytes: unique("r") });
    await x.waitForJob("rate", a.id, 5);
  } finally {
    delete process.env.FOLDRUN_EXTRACT_RATE_PER_MIN;
  }

  process.env.FOLDRUN_EXTRACT_ACCOUNT_CAP = "1";
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  x.setExtractFetchForTests(async () => {
    await gate;
    return Response.json(image("slow").body);
  });
  try {
    const slow = await x.startExtractJob({ tenant: "busy", actor: "key:b1", bytes: unique("s") });
    const still = await x.waitForJob("busy", slow.id, 0.2);
    assert.equal(still?.status, "running", "waited, not finished: as it stands");
    await assert.rejects(x.startExtractJob({ tenant: "busy", actor: "key:b2", bytes: unique("s") }), (e: InstanceType<typeof x.ExtractError>) => e.status === 429 && e.code === "too_many_running" && e.retryAfter === 15);
    // Another account is not held by this one's.
    const other = await x.startExtractJob({ tenant: "free", actor: "key:f1", bytes: unique("s") });
    release();
    assert.equal((await x.waitForJob("busy", slow.id, 5))?.status, "done");
    assert.equal((await x.waitForJob("free", other.id, 5))?.status, "done");
    // Once it is done, the account may start another.
    fakeParser(() => image("next"));
    const next = await x.startExtractJob({ tenant: "busy", actor: "key:b2", bytes: unique("s") });
    assert.equal((await x.waitForJob("busy", next.id, 5))?.status, "done");
  } finally {
    delete process.env.FOLDRUN_EXTRACT_ACCOUNT_CAP;
  }
});

test("markers and options: the clock, the language mapping, the options key", () => {
  assert.equal(x.clock(0), "0:00");
  assert.equal(x.clock(161), "2:41");
  assert.equal(x.clock(3725), "1:02:05");
  assert.equal(x.ocrLangFor("fa"), "fas+eng");
  assert.equal(x.ocrLangFor("auto"), "fas+eng");
  assert.equal(x.ocrLangFor("en"), "eng");
  assert.equal(x.speechLangFor("auto"), "auto");
  assert.deepEqual(x.parseExtractOptions({ name: "C:\\Users\\a\\scan.PDF" }), { lang: "auto", ocr: "auto", name: "scan.PDF" });
  assert.equal(x.optionsKey(x.parseExtractOptions({ name: "a.PDF" })), "v1;lang=auto;ocr=auto;engine=;ext=pdf");
  assert.throws(() => x.parseExtractOptions({ ocr: "sometimes" }), /ocr is auto, always or never/);
  assert.throws(() => x.parseExtractOptions({ engine: "marker" }), /engine is docling/);
});
