// Files to text, the finishing parts (12 Nov 2026): Whisper's repeated lines
// collapsed, its silence markers dropped, a cap on a run input's recording,
// the account's places for callers that are not jobs (withExtractSlot), the
// run-inputs hook the platform registers with core, and the Persian model's
// label from the environment.
//
//   node --test tests/extract-cleanup.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-extract-cleanup-"));
process.env.FOLDRUN_DATA = DATA;
delete process.env.FOLDRUN_DATABASE_URL;
delete process.env.FOLDRUN_REDIS_URL;
process.env.FOLDRUN_EXTRACT_URL = "http://extract:8090";
process.env.FOLDRUN_TRANSCRIBE_URL = "http://general:8080";
delete process.env.FOLDRUN_TRANSCRIBE_FA_URL;

const x = await import("../src/extract.ts");
const t = await import("../src/transcribe.ts");

function wav(seconds: number): Buffer {
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
  for (let i = 0; i < data; i += 64) b.writeInt16LE(9000, 44 + i);
  return b;
}

/** A recording of `total` seconds: /extract says it needs speech, /audio cuts it. */
function fakeRecording(total: number) {
  const calls: string[] = [];
  x.setExtractFetchForTests(async (input) => {
    const url = new URL(String(input));
    calls.push(url.pathname.slice(1));
    if (url.pathname === "/audio") {
      const start = Number(url.searchParams.get("start"));
      return new Response(new Uint8Array(wav(Math.min(300, total - start))), { status: 200 });
    }
    return Response.json({ kind: "audio", format: "mp3", text: "", seconds: total, needs_speech: true, engine: "ffmpeg", truncated: false, warnings: [] });
  });
  return calls;
}

const unique = (label: string) => Buffer.from(`${label}-${crypto.randomBytes(8).toString("hex")}`);

test.afterEach(() => {
  x.setExtractFetchForTests(null);
  t.setTranscribeFetchForTests(null);
});

test("collapseRepeats: three or more of one line or sentence in a row become one; two are left alone", () => {
  assert.deepEqual(x.collapseRepeats("a\nThank you.\nthank you\nThank you!\nb"), { text: "a\nThank you.\nb", removed: 2 });
  assert.deepEqual(x.collapseRepeats("no, no\nno, no\nnext"), { text: "no, no\nno, no\nnext", removed: 0 }, "two in a row stay");
  assert.deepEqual(x.collapseRepeats("Hi there. Subscribe. Subscribe. Subscribe. Bye."), { text: "Hi there. Subscribe. Bye.", removed: 2 });
  assert.deepEqual(x.collapseRepeats("ممنون. ممنون. ممنون. ممنون."), { text: "ممنون.", removed: 3 });
  assert.deepEqual(x.collapseRepeats("…and so. A. A. A."), { text: "…and so. A. A. A.", removed: 0 }, "a line the sentence pattern does not cover is left as it is");
  assert.deepEqual(x.collapseRepeats("one\n\n\n\ntwo"), { text: "one\n\n\n\ntwo", removed: 0 }, "blank lines are not a repeat");
  assert.deepEqual(x.collapseRepeats(""), { text: "", removed: 0 });
});

test("dropSilenceMarkers: a segment of nothing but [BLANK_AUDIO] is empty", () => {
  assert.equal(x.dropSilenceMarkers("[BLANK_AUDIO]"), "");
  assert.equal(x.dropSilenceMarkers(" [BLANK_AUDIO]\n(silence)\n[Music] "), "");
  assert.equal(x.dropSilenceMarkers("hello [BLANK_AUDIO] world"), "hello  world");
  assert.equal(x.dropSilenceMarkers("[speaker 1] hello"), "[speaker 1] hello", "other brackets stay");
});

test("a recording: Whisper's repeats across segments collapsed, a [BLANK_AUDIO] segment counted silent, and a warning says so", async () => {
  fakeRecording(900);
  let n = 0;
  t.setTranscribeFetchForTests(async () => {
    n++;
    const text = n === 1 ? "Welcome back.\nThanks for watching.\nThanks for watching." : n === 2 ? "Thanks for watching.\nThanks for watching." : "[BLANK_AUDIO]";
    return Response.json({ text, language: "en" });
  });
  const r = await x.extractFile("acme", unique("yt"), { name: "talk.mp3", lang: "en" });
  assert.equal(r.text, "[audio · 15:00 · transcript, en]\nWelcome back.\nThanks for watching.");
  assert.ok(r.warnings.includes("removed 3 repeated lines (likely Whisper hallucination)"), r.warnings.join("; "));
  assert.ok(r.warnings.some((w) => /1 silent part/.test(w)), r.warnings.join("; "));
});

test("maxSpeechSeconds: a recording past it is refused once the parser says how long it is, before Whisper", async () => {
  const calls = fakeRecording(900);
  let whisper = 0;
  t.setTranscribeFetchForTests(async () => {
    whisper++;
    return Response.json({ text: "x", language: "en" });
  });
  await assert.rejects(x.extractFile("acme", unique("long"), { name: "long.mp3", maxSpeechSeconds: 600 }), (e: InstanceType<typeof x.ExtractError>) => e.status === 413 && e.code === "too_long" && /10:00/.test(e.message));
  assert.deepEqual(calls, ["extract"]);
  assert.equal(whisper, 0);
});

test("the Persian model's label: FOLDRUN_TRANSCRIBE_FA_MODEL, else whisper-large-fa-v1", () => {
  assert.equal(t.faModel({}), "whisper-large-fa-v1");
  assert.equal(t.faModel({ FOLDRUN_TRANSCRIBE_FA_MODEL: "givia/whisper-large-v3-turbo-persian" }), "givia/whisper-large-v3-turbo-persian");
  assert.equal(t.faModel({ FOLDRUN_TRANSCRIBE_FA_MODEL: "  " }), "whisper-large-fa-v1");
  assert.equal(t.faModel({ FOLDRUN_TRANSCRIBE_FA_MODEL: "bad label; rm" }), "whisper-large-fa-v1", "a label, not anything");
});

test("withExtractSlot: the account's places, shared with the jobs; freed when fn ends, even when it throws", async () => {
  const prev = process.env.FOLDRUN_EXTRACT_ACCOUNT_CAP;
  process.env.FOLDRUN_EXTRACT_ACCOUNT_CAP = "1";
  try {
    let release!: () => void;
    const held = x.withExtractSlot("slotco", "lease:r1", () => new Promise<string>((r) => (release = () => r("done"))));
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(x.withExtractSlot("slotco", "lease:r2", async () => 1), (e: InstanceType<typeof x.ExtractError>) => e.status === 429 && e.code === "too_many_running" && e.retryAfter === 15);
    await assert.rejects(
      x.startExtractJob({ tenant: "slotco", actor: "key:k", bytes: Buffer.from("x") }),
      (e: InstanceType<typeof x.ExtractError>) => e.code === "too_many_running",
      "an API job counts the same places",
    );
    assert.equal(await x.withExtractSlot("otherco", "lease:r3", async () => "other account"), "other account", "per account");
    release();
    assert.equal(await held, "done");
    await assert.rejects(x.withExtractSlot("slotco", "lease:r4", async () => { throw new Error("boom"); }), /boom/);
    assert.equal(await x.withExtractSlot("slotco", "lease:r5", async () => 2), 2, "the failed one gave its place back");
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_EXTRACT_ACCOUNT_CAP;
    else process.env.FOLDRUN_EXTRACT_ACCOUNT_CAP = prev;
  }
});

test("extractRunInput waits for a place while the staging's signal lets it, then gives up with a 429", async () => {
  x.setExtractFetchForTests(async () => Response.json({ kind: "image", format: "png", text: "receipt", engine: "tesseract", needs_speech: false, truncated: false, warnings: [] }));
  const prev = process.env.FOLDRUN_EXTRACT_ACCOUNT_CAP;
  process.env.FOLDRUN_EXTRACT_ACCOUNT_CAP = "1";
  try {
    let release!: () => void;
    const held = x.withExtractSlot("waitco", "key:other", () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 20));
    const ask = { tenant: "waitco", workspace: "desk", runId: "run-1", name: "r.png", bytes: unique("receipt") };
    // Out of time while every place is busy.
    await assert.rejects(x.extractRunInput({ ...ask, signal: AbortSignal.timeout(300) }), (e: InstanceType<typeof x.ExtractError>) => e.status === 429);
    // Freed partway through the wait: it goes ahead.
    const waiting = x.extractRunInput({ ...ask, signal: AbortSignal.timeout(10_000) });
    setTimeout(() => release(), 200);
    assert.deepEqual(await waiting, { text: "receipt", warnings: [] });
    await held;
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_EXTRACT_ACCOUNT_CAP;
    else process.env.FOLDRUN_EXTRACT_ACCOUNT_CAP = prev;
  }
});

test("platformExtractHooks: extractText only where the extraction pods are configured", () => {
  assert.equal(x.platformExtractHooks({ FOLDRUN_EXTRACT_URL: "http://extract:8090" }).extractText, x.extractRunInput);
  assert.deepEqual(x.platformExtractHooks({}), {});
});
