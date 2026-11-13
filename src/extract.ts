// Files to text (12 Nov 2026; design: foldrun-infra/docs/media-to-text-2026-11.md).
//
// An image, a PDF, an office document, a recording or a video, turned into
// text on foldrun's own pods, so a model is sent text and nothing else:
//
//   foldrun-extract   the parser pod (FOLDRUN_EXTRACT_URL): OCR (Tesseract,
//                     fas+eng), PDF text layers (Poppler), office files
//                     (Docling), the audio track and video frames (ffmpeg).
//                     It holds no credentials and reaches nothing; what it
//                     answers is treated as untrusted here — bounded,
//                     shape-checked, cut to a length.
//   foldrun-transcribe  the Whisper pods (transcribe.ts). When the parser says
//                     a file `needs_speech`, its audio is cut into segments of
//                     SEGMENT_SECONDS by the parser's /audio, and each WAV is
//                     transcribed there.
//
// Results are ARTIFACTS, not a cache: one immutable result per (account,
// sha256, options key), pinned with the engines that made it. Never shared
// across accounts (a hit in another account's would tell one what another
// has read); a failed attempt never takes the slot. A second ask for the same
// file comes back `cached: true` without the parser being asked.
//
// Jobs: extraction can take minutes (an hour of audio is twelve segments of
// Whisper), longer than an HTTP request should wait. startExtractJob takes
// the work in the process that accepted it — a promise that writes its
// outcome to `extract_jobs` (files without a database) — and the caller
// waits up to a minute for it, or polls getJob. A running job's lease is
// moved on while it runs; a `running` row past its lease belongs to a
// process that stopped, and is failed when it is next read (reapStale).
//
// Not metered yet: the owner sets the prices (per image/page, per audio or
// video minute). TODO(billing): charge through billing() once the price list
// in foldrun-admin has the extraction meters — reserve before the parser is
// asked, settle once per artifact (a cached hit is not charged again).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { opsError, opsLog } from "../../foldrun-core/src/ops-log.ts";
import { accountDir, assertSafeName } from "../../foldrun-core/src/store.ts";
import { putFile } from "../../foldrun-core/src/storage.ts";
import { databaseEnabled, orm, tx } from "./db.ts";
import { extractArtifacts, extractJobs } from "./schema.ts";
import { rateLimit } from "./cache.ts";
import { SEGMENT_TIMEOUT_MS, speechConfiguredFor, TranscribeError, transcribeWav } from "./transcribe.ts";
import { onDemandFor, TOOL_CHANNEL, ToolStartError, toolsOnDemand, waitForTool } from "./tool-pod.ts";

// ---------------------------------------------------------------- types

export type ExtractKind = "image" | "pdf" | "office" | "audio" | "video" | "text" | "html";
export type ExtractLang = "fa" | "en" | "auto";
export type OcrMode = "auto" | "always" | "never";

export interface ExtractOptions {
  /** The file's name: the parser reads its type from the bytes, the extension helps. */
  name?: string;
  /** `fa`, `en` or `auto` (default): OCR `fas+eng` / `eng`, speech `fa` / `en` / detected. */
  lang?: string;
  ocr?: OcrMode;
  engine?: "docling";
  signal?: AbortSignal;
  /** The longest recording transcribed for this call, in seconds — under the
   *  install's own cap (FOLDRUN_EXTRACT_MAX_SPEECH_MIN), never over it. A
   *  longer one is refused (413 too_long) once the parser has said how long
   *  it is, before Whisper is asked: what a run's inputs use to keep a
   *  staging step short. Not part of the artifact's key — it refuses, it
   *  never changes the text. */
  maxSpeechSeconds?: number;
}

export interface ExtractResult {
  sha256: string;
  kind: ExtractKind;
  format: string;
  text: string;
  pages?: number;
  /** The page numbers that were read by OCR (a scanned PDF's). */
  ocrPages?: number[];
  seconds?: number;
  /** OCR's mean confidence, 0–100. */
  confidence?: number;
  /** The language Whisper heard (a code: fa, en, …), when there was speech. */
  language?: string;
  engine: { parser: string; speech?: string };
  truncated: boolean;
  warnings: string[];
  /** True when this account had already extracted this file with these options. */
  cached: boolean;
  ms: number;
}

/** A refusal or a failure, with the HTTP status and a code a program can branch on. */
export class ExtractError extends Error {
  readonly status: number;
  readonly code: string;
  /** Seconds, on a 429. */
  readonly retryAfter?: number;
  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

// ---------------------------------------------------------------- settings

const KINDS = new Set<ExtractKind>(["image", "pdf", "office", "audio", "video", "text", "html"]);
/** One audio segment sent to Whisper, in seconds. */
export const SEGMENT_SECONDS = 300;
const envNum = (name: string, fallback: number, env: NodeJS.ProcessEnv = process.env) => {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
/** The largest file extracted, in bytes (FOLDRUN_EXTRACT_MAX_MB, default 100). */
export const extractMaxBytes = (env: NodeJS.ProcessEnv = process.env) => Math.floor(envNum("FOLDRUN_EXTRACT_MAX_MB", 100, env) * 1024 * 1024);
/** The longest text kept, in UTF-8 bytes — the parser's own cap, held here too. */
export const MAX_TEXT_BYTES = 8 * 1024 * 1024;
/** The parser's JSON answer: the text plus room for the rest. */
const MAX_PARSER_JSON = MAX_TEXT_BYTES * 2 + 1024 * 1024;
/** One WAV segment from /audio: 16 kHz × 2 bytes × SEGMENT_SECONDS, plus slack. */
const MAX_WAV_BYTES = SEGMENT_SECONDS * 32_000 + 1024 * 1024;
const PARSER_TIMEOUT_MS = () => envNum("FOLDRUN_EXTRACT_PARSER_TIMEOUT_S", 960) * 1000;
const AUDIO_TIMEOUT_MS = 300_000;
/** The longest speech transcribed, in minutes (default 4 hours, the parser's own cap). */
const maxSpeechSeconds = () => envNum("FOLDRUN_EXTRACT_MAX_SPEECH_MIN", 240) * 60;

/** The parser's address, or null: operator env, an in-cluster service. */
export function extractBase(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env.FOLDRUN_EXTRACT_URL;
  return v && /^https?:\/\/[^\s]+$/.test(v) ? v.replace(/\/+$/, "") : null;
}

export function extractConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return extractBase(env) !== null;
}

/** For one account: a fixed parser, or its own pod on demand (tool-pod.ts). */
export function extractConfiguredFor(tenant: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return extractBase(env) !== null || onDemandFor(tenant, env);
}

/** The parser this account's file goes to: the fixed one when set, else its
 *  pod on demand, waited for (a cold start is a runner node and an image
 *  pull). Null when neither. */
async function parserBaseFor(tenant: string, signal: AbortSignal): Promise<string | null> {
  const fixed = extractBase();
  if (fixed) return fixed;
  if (!onDemandFor(tenant)) return null;
  try {
    return await waitForTool(tenant, signal);
  } catch (err) {
    if (err instanceof ToolStartError) throw new ExtractError(503, "tool_starting", err.message, 30);
    throw err;
  }
}

type Fetch = typeof fetch;
let fetchFn: Fetch = (...a) => fetch(...a);
/** Test seam: the parser's HTTP. Whisper's is transcribe.ts setTranscribeFetchForTests. */
export function setExtractFetchForTests(fn: Fetch | null): void {
  fetchFn = fn ?? ((...a) => fetch(...a));
}

// ---------------------------------------------------------------- options

export interface ParsedOptions {
  name?: string;
  lang: ExtractLang;
  ocr: OcrMode;
  engine?: "docling";
}

/** The caller's options, checked: 400 for anything not taken. */
export function parseExtractOptions(o: { name?: unknown; lang?: unknown; ocr?: unknown; engine?: unknown }): ParsedOptions {
  const out: ParsedOptions = { lang: "auto", ocr: "auto" };
  if (o.lang !== undefined && o.lang !== null && o.lang !== "") {
    if (o.lang !== "fa" && o.lang !== "en" && o.lang !== "auto") throw new ExtractError(400, "bad_request", "lang is fa, en or auto");
    out.lang = o.lang;
  }
  if (o.ocr !== undefined && o.ocr !== null && o.ocr !== "") {
    if (o.ocr !== "auto" && o.ocr !== "always" && o.ocr !== "never") throw new ExtractError(400, "bad_request", "ocr is auto, always or never");
    out.ocr = o.ocr;
  }
  if (o.engine !== undefined && o.engine !== null && o.engine !== "") {
    if (o.engine !== "docling") throw new ExtractError(400, "bad_request", "engine is docling, or leave it out for the default");
    out.engine = "docling";
  }
  if (o.name !== undefined && o.name !== null && o.name !== "") {
    if (typeof o.name !== "string") throw new ExtractError(400, "bad_request", "name is the file's name");
    // Only the last segment, printable, bounded: it reaches the parser as a hint.
    const base = o.name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, "").slice(-200);
    if (base) out.name = base;
  }
  return out;
}

/** The OCR languages the parser is asked for. */
export const ocrLangFor = (lang: ExtractLang) => (lang === "en" ? "eng" : "fas+eng");
/** The language Whisper is asked for. */
export const speechLangFor = (lang: ExtractLang) => lang;

/** What makes two extractions of one file the same: the options that change
 *  the text, and the name's extension (it can change how a file is read).
 *  `v1`: the shape of the text (its markers); a change there is a new key. */
export function optionsKey(o: ParsedOptions): string {
  const ext = o.name && /\.([a-z0-9]{1,8})$/i.exec(o.name)?.[1]?.toLowerCase();
  return `v1;lang=${o.lang};ocr=${o.ocr};engine=${o.engine ?? ""};ext=${ext ?? ""}`;
}

// ---------------------------------------------------------------- artifacts

const artifactFile = (tenant: string, sha: string, key: string) =>
  path.join(accountDir(tenant), "extract", "artifacts", `${sha}.${crypto.createHash("sha256").update(key).digest("hex").slice(0, 16)}.json`);

async function readArtifact(tenant: string, sha: string, key: string): Promise<ExtractResult | null> {
  if (databaseEnabled() && orm()) {
    const rows = await orm()!
      .select({ result: extractArtifacts.result })
      .from(extractArtifacts)
      .where(and(eq(extractArtifacts.tenant, tenant), eq(extractArtifacts.sha256, sha), eq(extractArtifacts.optionsKey, key)))
      .limit(1);
    return rows[0] ? (rows[0].result as ExtractResult) : null;
  }
  try {
    const j = JSON.parse(fs.readFileSync(artifactFile(tenant, sha, key), "utf8")) as { optionsKey: string; result: ExtractResult };
    return j.optionsKey === key ? j.result : null;
  } catch {
    return null;
  }
}

/** Kept once: a row that exists is never replaced (an engine upgrade makes
 *  new rows under a new key, it never rewrites what an account already has). */
async function writeArtifact(tenant: string, sha: string, key: string, engineSpec: string, result: ExtractResult): Promise<void> {
  const stored = { ...result, cached: false };
  if (databaseEnabled() && orm()) {
    await orm()!.insert(extractArtifacts).values({ tenant, sha256: sha, optionsKey: key, engineSpec, result: stored }).onConflictDoNothing();
    return;
  }
  const file = artifactFile(tenant, sha, key);
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ optionsKey: key, engineSpec, createdAt: new Date().toISOString(), result: stored }), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- the parser

interface ParserOut {
  kind: ExtractKind;
  format: string;
  text: string;
  pages?: number;
  ocrPages?: number[];
  seconds?: number;
  confidence?: number;
  engine: string;
  needsSpeech: boolean;
  truncated: boolean;
  warnings: string[];
}

const clean = (s: string, max: number) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max);
const finite = (v: unknown, max: number): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : undefined);

/** Text cut to MAX_TEXT_BYTES of UTF-8, on a character boundary. */
export function capText(text: string, max = MAX_TEXT_BYTES): { text: string; cut: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return { text, cut: false };
  // A cut through a character leaves U+FFFD at the end: dropped.
  return { text: bytes.subarray(0, max).toString("utf8").replace(/�+$/, ""), cut: true };
}

/** The parser's answer, believed only as far as its shape: anything else is a 502. */
export function checkParserOut(j: unknown): ParserOut {
  const bad = (what: string) => new ExtractError(502, "parser_bad_answer", `the text extraction service sent an answer this server does not read (${what})`);
  if (!j || typeof j !== "object" || Array.isArray(j)) throw bad("not an object");
  const o = j as Record<string, unknown>;
  if (typeof o.kind !== "string" || !KINDS.has(o.kind as ExtractKind)) throw bad("kind");
  if (typeof o.text !== "string") throw bad("text");
  const capped = capText(o.text);
  const warnings = Array.isArray(o.warnings) ? o.warnings.filter((w): w is string => typeof w === "string").slice(0, 20).map((w) => clean(w, 300)) : [];
  if (capped.cut) warnings.push(`the text was cut at ${MAX_TEXT_BYTES.toLocaleString("en")} bytes`);
  const pages = finite(o.pages, 1_000_000);
  const seconds = finite(o.seconds, 7 * 24 * 3600);
  const confidence = finite(o.confidence, 100);
  const ocrPages = Array.isArray(o.ocr_pages) ? o.ocr_pages.filter((p): p is number => Number.isInteger(p) && (p as number) > 0 && (p as number) <= 1_000_000).slice(0, 10_000) : undefined;
  return {
    kind: o.kind as ExtractKind,
    format: typeof o.format === "string" && /^[a-z0-9.+-]{1,32}$/i.test(o.format) ? o.format.toLowerCase() : "unknown",
    text: capped.text,
    ...(pages !== undefined ? { pages: Math.floor(pages) } : {}),
    ...(ocrPages && ocrPages.length ? { ocrPages } : {}),
    ...(seconds !== undefined ? { seconds: Math.round(seconds * 10) / 10 } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    engine: typeof o.engine === "string" && o.engine ? clean(o.engine, 120) : "unknown",
    needsSpeech: o.needs_speech === true,
    truncated: o.truncated === true || capped.cut,
    warnings,
  };
}

/** A body read to `max` bytes, no further. */
async function readCapped(res: Response, max: number, what: string): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  const tooBig = () => new ExtractError(502, "parser_bad_answer", `the text extraction service sent more than ${max.toLocaleString("en")} bytes for ${what}`);
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    throw tooBig();
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw tooBig();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** The parser's own refusal ({error: {code, message}}), as an ExtractError
 *  with its status — 400, 413, 415, 422, 503, 504 pass through; anything
 *  else is the service failing (502). */
function parserRefusal(status: number, raw: Buffer): ExtractError {
  let code = "parser_failed";
  let message = `the text extraction service answered ${status}`;
  try {
    const e = (JSON.parse(raw.toString("utf8")) as { error?: { code?: unknown; message?: unknown } }).error;
    if (typeof e?.code === "string" && /^[a-z][a-z0-9_]{0,40}$/.test(e.code)) code = e.code;
    if (typeof e?.message === "string" && e.message) message = clean(e.message, 500);
  } catch {
    // not JSON: the status says enough
  }
  const passed = [400, 413, 415, 422, 503, 504].includes(status);
  return new ExtractError(passed ? status : 502, passed ? code : "parser_failed", message);
}

/** One request to the parser, with the file as the body. A 503 `busy` (every
 *  slot working) is tried again, three times, a second apart and growing. */
async function parser(base: string, route: "extract" | "audio", query: Record<string, string>, bytes: Buffer, signal: AbortSignal, timeoutMs: number, max: number): Promise<{ body: Buffer; server: string }> {
  const url = `${base}/${route}?${new URLSearchParams(query).toString()}`;
  for (let attempt = 0; ; attempt++) {
    const abort = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    let res: Response;
    let body: Buffer;
    try {
      res = await fetchFn(url, {
        method: "POST",
        body: bytes as unknown as Uint8Array<ArrayBuffer>,
        headers: { "content-type": "application/octet-stream" },
        signal: abort,
        redirect: "error",
      });
      body = res.ok ? await readCapped(res, max, route === "audio" ? "an audio segment" : "the text") : await readCapped(res, 64 * 1024, "an error");
    } catch (err) {
      if (err instanceof ExtractError) throw err;
      if (abort.aborted) throw new ExtractError(504, "timeout", signal.aborted ? "the extraction was stopped (it ran out of time, or the caller left)" : `the text extraction service took more than ${Math.round(timeoutMs / 1000)} s`);
      throw new ExtractError(503, "unavailable", "the text extraction service did not answer — try again in a moment");
    }
    if (res.ok) return { body, server: clean(res.headers.get("server") ?? "", 120) };
    const refusal = parserRefusal(res.status, body);
    if (refusal.status === 503 && attempt < 3 && !signal.aborted) {
      await sleep(1000 * 2 ** attempt, signal);
      continue;
    }
    throw refusal;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

// ---------------------------------------------------------------- speech

/** `m:ss`, or `h:mm:ss` from an hour. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** The words in a file's audio: segment by segment, cut by the parser and
 *  transcribed by Whisper. A silent segment is skipped, not a failure. */
async function speech(tenant: string, base: string, bytes: Buffer, seconds: number, lang: ExtractLang, signal: AbortSignal, cap?: number): Promise<{ text: string; language?: string; model?: string; warnings: string[] }> {
  const warnings: string[] = [];
  // A fixed Whisper, or the account's own pods on demand (tool-pod.ts).
  if (!speechConfiguredFor(tenant)) throw new ExtractError(503, "speech_not_configured", "speech to text is not configured on this server (FOLDRUN_TRANSCRIBE_URL)");
  const most = cap !== undefined && Number.isFinite(cap) && cap > 0 ? Math.min(cap, maxSpeechSeconds()) : maxSpeechSeconds();
  if (seconds > most) throw new ExtractError(413, "too_long", `the recording is ${clock(seconds)} long; at most ${clock(most)} of speech is transcribed`);
  let asked: string = speechLangFor(lang);
  let language: string | undefined;
  let model: string | undefined;
  const parts: string[] = [];
  let silent = 0;
  for (let start = 0; start < seconds; start += SEGMENT_SECONDS) {
    if (seconds - start < 0.3) break;
    const { body: wav } = await parser(base, "audio", { start: String(start), seconds: String(SEGMENT_SECONDS) }, bytes, signal, AUDIO_TIMEOUT_MS, MAX_WAV_BYTES);
    let t;
    try {
      t = await transcribeWav(wav, { lang: asked, signal, timeoutMs: SEGMENT_TIMEOUT_MS, tenant });
    } catch (err) {
      if (err instanceof TranscribeError && (err.status === 422 || (err.status === 400 && /empty/.test(err.message)))) {
        silent++;
        continue;
      }
      if (err instanceof TranscribeError) throw new ExtractError(err.status === 503 || err.status === 504 ? err.status : 502, "speech_failed", err.message);
      throw err;
    }
    // A segment that came back as nothing but whisper.cpp's own silence
    // markers ([BLANK_AUDIO]) was silent: skipped like one refused as silent.
    const said = dropSilenceMarkers(t.text);
    if (!said) {
      silent++;
      continue;
    }
    parts.push(said);
    language ??= t.language;
    model ??= t.model;
    // The rest of the file in the language its first words were heard in:
    // one detection pass, not one per segment.
    if (asked === "auto" && /^[a-z]{2,3}$/.test(t.language)) asked = t.language;
  }
  if (!parts.length) warnings.push("no speech was heard in the audio");
  else if (silent) warnings.push(`${silent} silent part${silent === 1 ? "" : "s"} of ${clock(SEGMENT_SECONDS)} skipped`);
  // Across segments too: a hallucinated line often runs over a cut.
  const cleaned = collapseRepeats(parts.join("\n"));
  if (cleaned.removed) warnings.push(`removed ${cleaned.removed} repeated line${cleaned.removed === 1 ? "" : "s"} (likely Whisper hallucination)`);
  return { text: cleaned.text, language, model, warnings };
}

/** whisper.cpp's markers for a stretch with no words in it — a line that is
 *  only `[BLANK_AUDIO]`, `(silence)`, `[Music]` and the like — dropped. What
 *  is left, trimmed; empty when the segment said nothing else. */
export function dropSilenceMarkers(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/[\[(]\s*(?:blank[_ ]audio|silence|no speech|music|موسیقی|سکوت)\s*[\])]/gi, "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** Repeats at or past this many in a row are Whisper's, not the speaker's:
 *  over silence or music it writes one sentence again and again (the
 *  owner's YouTube pipeline, Nov 2026). Two in a row is left alone — people
 *  do say "no, no". */
export const REPEAT_RUN = 3;

/** One unit as compared: case, spacing and closing punctuation set aside. */
const unitKey = (u: string) => u.trim().replace(/\s+/g, " ").replace(/[\s.!?؟…,،;؛:]+$/u, "").toLowerCase();

/** Runs of one identical unit repeated REPEAT_RUN or more times in a row,
 *  collapsed to its first occurrence: whole lines first, then the sentences
 *  inside each line. `removed` counts the units dropped. */
export function collapseRepeats(text: string): { text: string; removed: number } {
  let removed = 0;
  const collapse = (units: string[]): string[] => {
    const out: string[] = [];
    for (let i = 0; i < units.length; ) {
      const key = unitKey(units[i]!);
      let j = i + 1;
      if (key) while (j < units.length && unitKey(units[j]!) === key) j++;
      out.push(units[i]!);
      if (j - i >= REPEAT_RUN) removed += j - i - 1;
      else for (let k = i + 1; k < j; k++) out.push(units[k]!);
      i = j;
    }
    return out;
  };
  const lines = collapse(text.split("\n")).map((line) => {
    // A sentence with what follows it (its closing marks and spaces), so a
    // line put back together reads as it did.
    const sentences = line.match(/[^.!?؟…]+(?:[.!?؟…]+|$)\s*/gu);
    // Only a line the pattern covers whole (one opening with "…" is not).
    if (!sentences || sentences.length < REPEAT_RUN || sentences.join("") !== line) return line;
    const kept = collapse(sentences);
    return kept.length === sentences.length ? line : kept.join("").trimEnd();
  });
  return { text: lines.join("\n"), removed };
}

// ---------------------------------------------------------------- extract

/**
 * A file's text, for one account. A file this account already extracted with
 * the same options comes back from its artifact (`cached: true`) and the
 * parser is not asked.
 */
export async function extractFile(tenant: string, bytes: Buffer, opts: ExtractOptions = {}): Promise<ExtractResult> {
  const started = Date.now();
  assertSafeName(tenant, "tenant");
  const o = parseExtractOptions(opts);
  if (!bytes.length) throw new ExtractError(400, "bad_request", "the file is empty");
  const max = extractMaxBytes();
  if (bytes.length > max) throw new ExtractError(413, "too_large", `the file is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; text is extracted from files of at most ${Math.round(max / 1024 / 1024)} MB`);
  if (!extractConfiguredFor(tenant)) throw new ExtractError(503, "not_configured", "text extraction is not configured on this server");
  const signal = opts.signal ?? new AbortController().signal;

  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const key = optionsKey(o);
  // A cached artifact is answered whatever its length, maxSpeechSeconds
  // included: that cap bounds the WORK a caller waits for (run inputs at step
  // start), and a stored transcript costs none (Codex review 12 Nov 2026,
  // considered and kept on purpose).
  const hit = await readArtifact(tenant, sha256, key);
  if (hit) return { ...hit, cached: true, ms: Date.now() - started };
  // Only now the parser: a file already read costs no pod (tool-pod.ts).
  const base = await parserBaseFor(tenant, signal);
  if (!base) throw new ExtractError(503, "not_configured", "text extraction is not configured on this server");

  const q: Record<string, string> = { lang: ocrLangFor(o.lang), ocr: o.ocr };
  if (o.name) q.name = o.name;
  if (o.engine) q.engine = o.engine;
  const { body, server } = await parser(base, "extract", q, bytes, signal, PARSER_TIMEOUT_MS(), MAX_PARSER_JSON);
  let parsed: ParserOut;
  try {
    parsed = checkParserOut(JSON.parse(body.toString("utf8")));
  } catch (err) {
    if (err instanceof ExtractError) throw err;
    throw new ExtractError(502, "parser_bad_answer", "the text extraction service sent something that is not JSON");
  }

  let text = parsed.text;
  const warnings = [...parsed.warnings];
  let language: string | undefined;
  let speechModel: string | undefined;
  let truncated = parsed.truncated;
  if (parsed.needsSpeech && (parsed.kind === "audio" || parsed.kind === "video")) {
    // No length, no speech pass: a malformed answer must fail (and not be
    // stored as an artifact), never become "no speech heard" for good.
    if (parsed.seconds === undefined || !(parsed.seconds > 0)) {
      throw new ExtractError(502, "parser_bad_answer", "the text extraction service said the file has speech but gave no length for it");
    }
    const seconds = parsed.seconds;
    const heard = await speech(tenant, base, bytes, seconds, o.lang, signal, opts.maxSpeechSeconds);
    language = heard.language;
    speechModel = heard.model;
    warnings.push(...heard.warnings);
    if (parsed.kind === "audio") {
      text = heard.text ? `[audio · ${clock(seconds)} · transcript, ${language ?? "?"}]\n${heard.text}` : `[audio · ${clock(seconds)} · no speech heard]`;
    } else {
      const said = heard.text ? `[video · ${clock(seconds)} · speech]\n${heard.text}` : `[video · ${clock(seconds)} · no speech heard]`;
      text = parsed.text ? `${said}\n\n${parsed.text}` : said;
    }
    const capped = capText(text);
    if (capped.cut) {
      text = capped.text;
      truncated = true;
      warnings.push(`the text was cut at ${MAX_TEXT_BYTES.toLocaleString("en")} bytes`);
    }
  }

  const result: ExtractResult = {
    sha256,
    kind: parsed.kind,
    format: parsed.format,
    text,
    ...(parsed.pages !== undefined ? { pages: parsed.pages } : {}),
    ...(parsed.ocrPages ? { ocrPages: parsed.ocrPages } : {}),
    ...(parsed.seconds !== undefined ? { seconds: parsed.seconds } : {}),
    ...(parsed.confidence !== undefined ? { confidence: parsed.confidence } : {}),
    ...(language ? { language } : {}),
    engine: { parser: parsed.engine, ...(speechModel ? { speech: speechModel } : {}) },
    truncated,
    warnings,
    cached: false,
    ms: Date.now() - started,
  };
  const engineSpec = JSON.stringify({ service: server || "unknown", parser: parsed.engine, speech: speechModel ?? null, segmentSeconds: SEGMENT_SECONDS, options: key });
  try {
    await writeArtifact(tenant, sha256, key, engineSpec, result);
  } catch (err) {
    // The text is still the caller's; the next ask extracts it again.
    opsError("extract.artifact_write_failed", err, { tenant });
  }
  opsLog("info", "extract.done", { tenant, kind: result.kind, op: speechModel ? "speech" : "parse", ms: result.ms, secs: result.seconds, count: result.pages, bytes: Buffer.byteLength(text, "utf8") });
  return result;
}

// ---------------------------------------------------------------- jobs

export type ExtractJobStatus = "running" | "done" | "failed";
export interface ExtractJobError {
  status: number;
  code: string;
  message: string;
}
export interface ExtractJob {
  id: string;
  tenant: string;
  workspace: string | null;
  /** `<kind>:<id>` of the credential that asked. */
  actor: string;
  status: ExtractJobStatus;
  options: ParsedOptions;
  result?: ExtractResult;
  error?: ExtractJobError;
  /** The storage path the text was written to; null when it was not (yet). */
  wrote: string | null;
  /** The storage path it is to be written to, when it was asked to be. */
  writePath: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface StartExtractJob {
  tenant: string;
  /** The workspace it is about (a storage file's), or null for a file sent whole. */
  workspace?: string | null;
  /** `<kind>:<id>` of the credential — the rate limit's key and who may read the job. */
  actor: string;
  bytes: Buffer;
  options?: { name?: string; lang?: string; ocr?: OcrMode; engine?: "docling" };
  /** Write the text to this storage path of `workspace` (it must end in .txt),
   *  as `by` (`user:<email>`, `key:<label>`), once it is done. */
  write?: { path: string; by: string };
}

/** Extractions one credential may start a minute (FOLDRUN_EXTRACT_RATE_PER_MIN, default 20). */
export const ratePerMinute = () => envNum("FOLDRUN_EXTRACT_RATE_PER_MIN", 20);
/** Extractions one account may have running at once (FOLDRUN_EXTRACT_ACCOUNT_CAP, default 3). */
export const accountCap = () => envNum("FOLDRUN_EXTRACT_ACCOUNT_CAP", 3);
/** How long a running job's lease lasts, and how often it is moved on. */
const LEASE_SECONDS = 120;
const RENEW_MS = 30_000;
/** The longest one job may run (FOLDRUN_EXTRACT_JOB_MINUTES, default 180). */
const jobTimeoutMs = () => envNum("FOLDRUN_EXTRACT_JOB_MINUTES", 180) * 60_000;
/** Finished jobs are kept this long, for a caller polling for one. */
const JOB_KEEP_MS = 24 * 3600_000;
const STOPPED: ExtractJobError = { status: 503, code: "worker_stopped", message: "the server working on it stopped — ask again" };

export const newExtractJobId = () => `xj-${Date.now().toString(36)}${crypto.randomBytes(8).toString("hex")}`;
const JOB_ID = /^xj-[a-z0-9]{10,40}$/;
export const isExtractJobId = (id: string) => JOB_ID.test(id);

/** The jobs this process is running, by id: what waitForJob awaits without polling. */
const local = new Map<string, Promise<void>>();

const jobsDir = (tenant: string) => path.join(accountDir(tenant), "extract", "jobs");
const jobFile = (tenant: string, id: string) => path.join(jobsDir(tenant), `${id}.json`);
type FileJob = ExtractJob & { leaseUntil: number };

function readFileJob(tenant: string, id: string): FileJob | null {
  try {
    return JSON.parse(fs.readFileSync(jobFile(tenant, id), "utf8")) as FileJob;
  } catch {
    return null;
  }
}
function writeFileJob(job: FileJob): void {
  const file = jobFile(job.tenant, job.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(job), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
/** Without a database: one chain per account, so count-then-insert is one step in this process. */
const fileChains = new Map<string, Promise<unknown>>();
function chained<T>(tenant: string, fn: () => T | Promise<T>): Promise<T> {
  const run = (fileChains.get(tenant) ?? Promise.resolve()).then(fn);
  fileChains.set(tenant, run.catch(() => undefined));
  return run;
}

type JobRow = typeof extractJobs.$inferSelect;
const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());
function fromRow(r: JobRow): ExtractJob {
  return {
    id: r.id,
    tenant: r.tenant,
    workspace: r.workspace,
    actor: r.actor,
    status: r.status as ExtractJobStatus,
    options: r.options as ParsedOptions,
    ...(r.result ? { result: r.result as ExtractResult } : {}),
    ...(r.error ? { error: r.error as ExtractJobError } : {}),
    wrote: r.status === "done" ? r.writePath : null,
    writePath: r.writePath,
    createdAt: iso(r.createdAt)!,
    finishedAt: iso(r.finishedAt),
  };
}

/** Running jobs of an account whose lease ran out: failed, never run again. */
async function reapStale(tenant: string): Promise<void> {
  if (databaseEnabled() && orm()) {
    await orm()!
      .update(extractJobs)
      .set({ status: "failed", error: STOPPED, finishedAt: sql`now()` })
      .where(and(eq(extractJobs.tenant, tenant), eq(extractJobs.status, "running"), sql`${extractJobs.leaseUntil} < now()`));
    return;
  }
  await chained(tenant, () => {
    let names: string[] = [];
    try {
      names = fs.readdirSync(jobsDir(tenant)).filter((n) => n.endsWith(".json"));
    } catch {
      return;
    }
    const now = Date.now();
    for (const n of names) {
      const job = readFileJob(tenant, n.replace(/\.json$/, ""));
      if (!job) continue;
      if (job.status === "running" && job.leaseUntil < now) writeFileJob({ ...job, status: "failed", error: STOPPED, finishedAt: new Date().toISOString() });
      else if (job.status !== "running" && now - Date.parse(job.finishedAt ?? job.createdAt) > JOB_KEEP_MS) fs.rmSync(jobFile(tenant, job.id), { force: true });
    }
  });
}

let lastSweep = 0;
/** Finished jobs past JOB_KEEP_MS, every account — at most every ten minutes per process. */
async function sweepOld(): Promise<void> {
  if (!(databaseEnabled() && orm()) || Date.now() - lastSweep < 600_000) return;
  lastSweep = Date.now();
  await orm()!.delete(extractJobs).where(and(sql`${extractJobs.status} <> 'running'`, sql`${extractJobs.createdAt} < now() - make_interval(secs => ${JOB_KEEP_MS / 1000})`));
}

/** The credential's rate, then the account's jobs in flight: 429 with Retry-After past either. */
async function admit(job: ExtractJob): Promise<void> {
  const rate = await rateLimit(`extract:${job.tenant}:${job.actor}`, ratePerMinute(), 60);
  if (!rate.allowed) throw new ExtractError(429, "rate_limited", `at most ${ratePerMinute()} extractions a minute per key or person — try again in ${rate.retryAfter} s`, rate.retryAfter);
  await takeSlot(job);
}

/** One of the account's accountCap() places, recorded as a `running` job:
 *  429 too_many_running when they are all taken. */
async function takeSlot(job: ExtractJob): Promise<void> {
  await reapStale(job.tenant);
  const cap = accountCap();
  const full = () => new ExtractError(429, "too_many_running", `this account already has ${cap} extractions running — try again when one finishes`, 15);
  if (databaseEnabled() && orm()) {
    const ok = await tx(async (t) => {
      // Count and insert as one step per account, across every web pod.
      await t.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`extract:${job.tenant}`}))`);
      const { rows } = await t.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM extract_jobs WHERE tenant = ${job.tenant} AND status = 'running' AND lease_until > now()`);
      if ((rows[0]?.n ?? 0) >= cap) return false;
      await t.insert(extractJobs).values({
        id: job.id,
        tenant: job.tenant,
        workspace: job.workspace,
        actor: job.actor,
        status: "running",
        options: job.options,
        writePath: job.writePath,
        leaseUntil: sql`now() + make_interval(secs => ${LEASE_SECONDS})`,
      });
      // The worker makes this account's parser pod on it (tool-pod.ts);
      // delivered on commit, never on a rollback.
      if (toolsOnDemand()) await t.execute(sql`SELECT pg_notify(${TOOL_CHANNEL}, ${job.tenant})`);
      return true;
    });
    if (!ok) throw full();
    await sweepOld().catch((err) => opsError("extract.sweep_failed", err));
    return;
  }
  await chained(job.tenant, () => {
    let running = 0;
    try {
      for (const n of fs.readdirSync(jobsDir(job.tenant))) {
        const j = n.endsWith(".json") ? readFileJob(job.tenant, n.replace(/\.json$/, "")) : null;
        if (j?.status === "running" && j.leaseUntil > Date.now()) running++;
      }
    } catch {
      // no jobs yet
    }
    if (running >= cap) throw full();
    writeFileJob({ ...job, leaseUntil: Date.now() + LEASE_SECONDS * 1000 });
  });
}

async function renew(job: ExtractJob): Promise<void> {
  if (databaseEnabled() && orm()) {
    await orm()!
      .update(extractJobs)
      .set({ leaseUntil: sql`now() + make_interval(secs => ${LEASE_SECONDS})` })
      .where(and(eq(extractJobs.id, job.id), eq(extractJobs.status, "running")));
    return;
  }
  await chained(job.tenant, () => {
    const j = readFileJob(job.tenant, job.id);
    if (j?.status === "running") writeFileJob({ ...j, leaseUntil: Date.now() + LEASE_SECONDS * 1000 });
  });
}

/** The outcome, written once: only over a row still `running` (a reaped job stays failed). */
async function finish(job: ExtractJob, status: "done" | "failed", out: { result?: ExtractResult; error?: ExtractJobError }): Promise<void> {
  if (databaseEnabled() && orm()) {
    await orm()!
      .update(extractJobs)
      .set({ status, result: out.result ?? null, error: out.error ?? null, finishedAt: sql`now()` })
      .where(and(eq(extractJobs.id, job.id), eq(extractJobs.status, "running")));
    return;
  }
  await chained(job.tenant, () => {
    const j = readFileJob(job.tenant, job.id);
    if (!j || j.status !== "running") return;
    writeFileJob({ ...j, status, ...(out.result ? { result: out.result } : {}), ...(out.error ? { error: out.error } : {}), wrote: status === "done" ? j.writePath : null, finishedAt: new Date().toISOString() });
  });
}

/** An error as a job stores it: our own refusals with their words; anything
 *  else (a bug, a system error naming a path) as one generic sentence. */
function jobError(err: unknown): ExtractJobError {
  if (err instanceof ExtractError) return { status: err.status, code: err.code, message: err.message };
  const carried = (err as { status?: unknown })?.status;
  const sys = typeof (err as NodeJS.ErrnoException)?.syscall === "string";
  if (err instanceof Error && typeof carried === "number" && !sys) return { status: carried, code: "refused", message: err.message };
  return { status: 500, code: "internal", message: "the extraction failed on our side" };
}

async function runJob(job: ExtractJob, bytes: Buffer, write: StartExtractJob["write"]): Promise<void> {
  const signal = AbortSignal.timeout(jobTimeoutMs());
  const beat = setInterval(() => void renew(job).catch((err) => opsError("extract.renew_failed", err, { tenant: job.tenant })), RENEW_MS);
  beat.unref?.();
  try {
    const result = await extractFile(job.tenant, bytes, { ...job.options, signal });
    if (write && job.workspace) {
      try {
        await putFile(job.tenant, job.workspace, write.path, Buffer.from(result.text, "utf8"), write.by);
      } catch (err) {
        const e = jobError(err);
        await finish(job, "failed", { result, error: { status: e.status === 500 ? 500 : e.status, code: "write_failed", message: e.status === 500 ? `the text was made but could not be written to ${write.path}` : `the text was made but could not be written to ${write.path}: ${e.message}` } });
        return;
      }
    }
    await finish(job, "done", { result });
  } catch (err) {
    const e = jobError(err);
    if (e.status >= 500) opsError("extract.failed", err, { tenant: job.tenant, jobId: job.id, reason: e.code, status: e.status }, e.status === 503 || e.status === 504 ? "warn" : "error");
    await finish(job, "failed", { error: e });
  } finally {
    clearInterval(beat);
  }
}

/**
 * Take an extraction: refused at once (429) past the credential's rate or the
 * account's jobs in flight, else recorded `running` and worked on in this
 * process. Returns the job as recorded; waitForJob or getJob for its outcome.
 */
export async function startExtractJob(input: StartExtractJob): Promise<ExtractJob> {
  assertSafeName(input.tenant, "tenant");
  if (input.workspace) assertSafeName(input.workspace, "workspace");
  const options = parseExtractOptions(input.options ?? {});
  if (!input.bytes.length) throw new ExtractError(400, "bad_request", "the file is empty");
  const max = extractMaxBytes();
  if (input.bytes.length > max) throw new ExtractError(413, "too_large", `the file is ${(input.bytes.length / 1024 / 1024).toFixed(1)} MB; text is extracted from files of at most ${Math.round(max / 1024 / 1024)} MB`);
  if (!extractConfiguredFor(input.tenant)) throw new ExtractError(503, "not_configured", "text extraction is not configured on this server");
  if (input.write) {
    if (!input.workspace) throw new ExtractError(400, "bad_request", "the text is written into a workspace's storage: name the workspace");
    if (!/\.txt$/i.test(input.write.path)) throw new ExtractError(400, "bad_request", "the text is written to a .txt file");
  }
  const job: ExtractJob = {
    id: newExtractJobId(),
    tenant: input.tenant,
    workspace: input.workspace ?? null,
    actor: input.actor,
    status: "running",
    options,
    wrote: null,
    writePath: input.write?.path ?? null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
  };
  await admit(job);
  const work = runJob(job, input.bytes, input.write)
    .catch((err) => opsError("extract.job_lost", err, { tenant: job.tenant }))
    .finally(() => local.delete(job.id));
  local.set(job.id, work);
  return job;
}

/**
 * `fn` run in one of the account's extraction places — the same accountCap()
 * the jobs count against, held as a `running` row (its lease moved on while
 * fn works) so every web, worker and egress pod sees it. For the callers that
 * are not jobs: the egress proxy's /text door (an agent's extract_text) and a
 * run's inputs at staging. Refused at once (ExtractError 429
 * too_many_running) when every place is taken; no rate limit of its own —
 * each caller keeps its own. The row is finished done or failed, without
 * the text (that is the artifact's).
 */
export async function withExtractSlot<T>(
  tenant: string,
  actor: string,
  fn: () => Promise<T>,
  opts: { workspace?: string | null; options?: ParsedOptions } = {},
): Promise<T> {
  assertSafeName(tenant, "tenant");
  const job: ExtractJob = {
    id: newExtractJobId(),
    tenant,
    workspace: opts.workspace ?? null,
    actor,
    status: "running",
    options: opts.options ?? { lang: "auto", ocr: "auto" },
    wrote: null,
    writePath: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
  };
  await takeSlot(job);
  const beat = setInterval(() => void renew(job).catch((err) => opsError("extract.renew_failed", err, { tenant })), RENEW_MS);
  beat.unref?.();
  try {
    const out = await fn();
    await finish(job, "done", {}).catch((err) => opsError("extract.slot_finish_failed", err, { tenant }));
    return out;
  } catch (err) {
    await finish(job, "failed", { error: jobError(err) }).catch((e) => opsError("extract.slot_finish_failed", e, { tenant }));
    throw err;
  } finally {
    clearInterval(beat);
  }
}

/** A run's inputs at staging: how long one recording may be (10 minutes). */
export const INPUT_SPEECH_SECONDS = 600;

/**
 * The text of one of a run's inputs, for the `.txt` written beside it at
 * staging (core run-inputs.ts textBesideInputs, through platform.extractText).
 * Waits for one of the account's places while `signal` lets it — the
 * staging's own time budget — rather than giving up at the first 429; a
 * recording longer than INPUT_SPEECH_SECONDS is refused before Whisper is
 * asked. Errors are ExtractErrors; the caller notes them and moves on.
 */
export async function extractRunInput(ask: { tenant: string; workspace: string; runId: string; name: string; bytes: Buffer; signal: AbortSignal }): Promise<{ text: string; warnings: string[] }> {
  for (;;) {
    try {
      return await withExtractSlot(
        ask.tenant,
        `run:${ask.runId}`,
        async () => {
          const r = await extractFile(ask.tenant, ask.bytes, { name: ask.name, signal: ask.signal, maxSpeechSeconds: INPUT_SPEECH_SECONDS });
          return { text: r.text, warnings: r.warnings };
        },
        { workspace: ask.workspace },
      );
    } catch (err) {
      if (err instanceof ExtractError && err.code === "too_many_running" && !ask.signal.aborted) {
        await sleep(2000, ask.signal);
        if (!ask.signal.aborted) continue;
        throw new ExtractError(429, "too_many_running", "the account's extractions were all busy until the time for inputs ran out");
      }
      throw err;
    }
  }
}

/** What index.ts registers with core: extractText for run inputs' `.txt`,
 *  only on an install that has the extraction pods. */
export function platformExtractHooks(env: NodeJS.ProcessEnv = process.env): { extractText?: typeof extractRunInput } {
  return extractConfigured(env) || toolsOnDemand(env) ? { extractText: extractRunInput } : {};
}

/** One job of this account, or null. A running job past its lease is failed here. */
export async function getJob(tenant: string, id: string): Promise<ExtractJob | null> {
  if (!isExtractJobId(id)) return null;
  assertSafeName(tenant, "tenant");
  if (databaseEnabled() && orm()) {
    const rows = await orm()!.select().from(extractJobs).where(and(eq(extractJobs.tenant, tenant), eq(extractJobs.id, id))).limit(1);
    if (!rows[0]) return null;
    if (rows[0].status === "running" && new Date(rows[0].leaseUntil).getTime() < Date.now()) {
      await reapStale(tenant);
      return getJob(tenant, id);
    }
    return fromRow(rows[0]);
  }
  const j = readFileJob(tenant, id);
  if (!j || j.tenant !== tenant) return null;
  if (j.status === "running" && j.leaseUntil < Date.now()) {
    await reapStale(tenant);
    return getJob(tenant, id);
  }
  const { leaseUntil: _lease, ...job } = j;
  return job;
}

/** The job once it is done or failed, or as it stands after `seconds` (0–60). */
export async function waitForJob(tenant: string, id: string, seconds: number, signal?: AbortSignal): Promise<ExtractJob | null> {
  const wait = Math.max(0, Math.min(60, Number.isFinite(seconds) ? seconds : 0));
  const deadline = Date.now() + wait * 1000;
  const mine = local.get(id);
  if (mine && wait > 0) {
    const stop = new AbortController();
    const parts = [mine, sleep(wait * 1000, stop.signal)];
    if (signal) parts.push(sleep(wait * 1000, signal));
    await Promise.race(parts);
    stop.abort();
  }
  for (;;) {
    const job = await getJob(tenant, id);
    if (!job || job.status !== "running" || Date.now() >= deadline || signal?.aborted) return job;
    await sleep(Math.min(500, deadline - Date.now()), signal);
  }
}

/** An account's extraction records, when the account is deleted (tenant-delete.ts).
 *  Without a database they are files under the account's folder, removed with it. */
export async function deleteTenantExtracts(tenant: string): Promise<void> {
  if (!(databaseEnabled() && orm())) return;
  await orm()!.delete(extractArtifacts).where(eq(extractArtifacts.tenant, tenant));
  await orm()!.delete(extractJobs).where(eq(extractJobs.tenant, tenant));
}
