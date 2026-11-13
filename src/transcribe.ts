// Speech to text on foldrun's own pods (11 Nov 2026, design:
// foldrun-infra/docs/media-to-text-2026-11.md). The gateway's
// POST /v1/foldrun/transcribe hands a recording here; this sends it to a
// whisper.cpp server (`whisper-server`, its /inference route) in the
// foldrun-transcribe pods, which hold no credentials and reach nothing.
//
//   FOLDRUN_TRANSCRIBE_URL     the general model (large-v3-turbo): every language
//   FOLDRUN_TRANSCRIBE_FA_URL  the Persian model (whisper-large-fa-v1), when set
//   FOLDRUN_TRANSCRIBE_FA_MODEL  what results name that model (default
//                              whisper-large-fa-v1) — the label only, set with
//                              the image that serves it
//
// Only WAV, PCM 16-bit, 16 kHz, mono is taken — what `foldrun talk` records
// and what whisper.cpp reads without converting. The header is checked here,
// before anything reaches a parser, so a length is known and capped up front.

import { opsError } from "../../foldrun-core/src/ops-log.ts";
import { holdToolLease, STT_FA, STT_GEN, sttOnDemandFor, ToolStartError, toolStartMs, waitForTool } from "./tool-pod.ts";

export const SAMPLE_RATE = 16_000;
/** The longest recording taken, in seconds. `/talk` records at most 60. */
export const MAX_SECONDS = 120;
/** A WAV of MAX_SECONDS, with room for a longer header. */
export const MAX_BYTES = 44 + MAX_SECONDS * SAMPLE_RATE * 2 + 4096;
/** How long one transcription may take before it is refused. */
const TIMEOUT_MS = 90_000;
/** One segment of a long file (text extraction, extract.ts): its own caps,
 *  passed to transcribeWav — /talk's MAX_SECONDS and TIMEOUT_MS stay /talk's. */
export const SEGMENT_MAX_SECONDS = 600;
export const SEGMENT_TIMEOUT_MS = 600_000;

/**
 * The encoder window for a clip, in whisper's encoder positions (50 a second;
 * 1500 = its full 30 s; 0 = the full window, whisper-server's `audio_ctx`).
 * whisper.cpp encodes the full 30 s for any clip unless told otherwise: a 4 s
 * `/talk` took ~78 s on dev (2 vCPU, gVisor, 12 Nov 2026). Cut to the clip it
 * is several times faster, but upstream marks this experimental ("can
 * significantly reduce the quality of the output", whisper.h): on the same
 * models 256 and 384 made the English model repeat itself on a 3 s clip and
 * 512 did not, so 512 is the floor — provisional, measured on a handful of
 * clips. At 30 s or more it is always the full window (0, sent explicitly so a
 * server default cannot shrink it: whisper seeks in 30 s steps). Set
 * FOLDRUN_TRANSCRIBE_FULL_CONTEXT=1 to use the full window for every clip.
 */
export function audioCtx(seconds: number, env: NodeJS.ProcessEnv = process.env): number {
  if (env.FOLDRUN_TRANSCRIBE_FULL_CONTEXT === "1" || !(seconds < 30)) return 0;
  return Math.min(1500, Math.max(512, Math.ceil(seconds * 50) + 64));
}

export interface Wav {
  seconds: number;
  /** The loudest sample, 0–1 of full scale. */
  peak: number;
}

/** Below this peak (-60 dBFS, ~33 of 32768) a recording is all but digital
 *  silence — a muted or unplugged microphone. Whisper makes words up for that
 *  ("you" for 3 s of silence on dev, 12 Nov 2026), so it is refused before
 *  Whisper is asked. Deliberately low: this measures level, not speech, and
 *  quiet speech from a distant microphone must still pass. */
export const SILENCE_PEAK = 0.001;

/** A WAV's length, or why it is refused. Walks the RIFF chunks for `fmt `
 *  and `data`; anything but PCM 16-bit mono at 16 kHz is refused. */
export function readWav(buf: Buffer): Wav | { error: string } {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return { error: "not a WAV file — send audio/wav, PCM 16-bit, 16 kHz, mono" };
  let off = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > buf.length) return { error: "the WAV's format chunk is cut short" };
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (!fmt) return { error: "the WAV has no format chunk before its data" };
      if (fmt.format !== 1 || fmt.bits !== 16 || fmt.channels !== 1 || fmt.rate !== SAMPLE_RATE) return { error: `the WAV is ${fmt.rate} Hz, ${fmt.bits}-bit, ${fmt.channels} channel(s), format ${fmt.format} — send PCM 16-bit, 16 kHz, mono` };
      // A streamed WAV may say 0 or 0xFFFFFFFF here: what is there counts.
      const bytes = Math.min(size === 0 || size === 0xffffffff ? buf.length - body : size, buf.length - body);
      let max = 0;
      for (let i = body; i + 1 < body + bytes; i += 2) {
        const v = Math.abs(buf.readInt16LE(i));
        if (v > max) max = v;
      }
      return { seconds: bytes / (SAMPLE_RATE * 2), peak: max / 32768 };
    }
    off = body + size + (size % 2);
  }
  return { error: "the WAV has no data chunk" };
}

/** A language as the caller names it: `auto`, or a two- or three-letter code. */
export function langProblem(lang: string): string | null {
  return lang === "auto" || /^[a-z]{2,3}$/.test(lang) ? null : "lang is `auto` or a language code such as fa or en";
}

export interface Transcript {
  text: string;
  language: string;
  model: string;
  seconds: number;
}

export class TranscribeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Servers {
  general: string | null;
  fa: string | null;
}

export function servers(env: NodeJS.ProcessEnv = process.env): Servers {
  const u = (v: string | undefined) => (v && /^https?:\/\//.test(v) ? v.replace(/\/+$/, "") : null);
  return { general: u(env.FOLDRUN_TRANSCRIBE_URL), fa: u(env.FOLDRUN_TRANSCRIBE_FA_URL) };
}

/** Speech to text for this account: a fixed Whisper (operator env), or the
 *  account's own Whisper pods on demand (tool-pod.ts). */
export function speechConfiguredFor(tenant: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const s = servers(env);
  return !!(s.general || s.fa) || (!!tenant && sttOnDemandFor(tenant, env));
}

/** The Persian model's name as results carry it. */
export const DEFAULT_FA_MODEL = "whisper-large-fa-v1";
export function faModel(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.FOLDRUN_TRANSCRIBE_FA_MODEL?.trim();
  // A label, not a path: printable, bounded.
  return v && /^[A-Za-z0-9._\/:-]{1,120}$/.test(v) ? v : DEFAULT_FA_MODEL;
}

type Fetch = typeof fetch;
let fetchFn: Fetch = (...a) => fetch(...a);
export function setTranscribeFetchForTests(fn: Fetch | null): void {
  fetchFn = fn ?? ((...a) => fetch(...a));
}

/** One call to a whisper-server: verbose_json, so the detected language
 *  comes back with the text. Greedy at temperature 0, falling back as
 *  whisper.cpp does when a segment fails its checks. */
async function inference(base: string, wav: Buffer, language: string, signal: AbortSignal, ctx: number, detectOnly = false, timeoutMs = TIMEOUT_MS): Promise<{ text: string; language: string }> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "talk.wav");
  form.append("response_format", "verbose_json");
  form.append("temperature", "0.0");
  form.append("temperature_inc", "0.2");
  form.append("language", language);
  // The extra detection pass verbose_json would run for the probabilities
  // table: never needed, and it costs a second encoder pass.
  form.append("no_language_probabilities", "true");
  form.append("audio_ctx", String(ctx));
  // Detection alone: whisper.cpp returns right after the language pass
  // (whisper_full, detect_language), with no text — one encoder pass.
  if (detectOnly) form.append("detect_language", "true");
  let res: Response;
  let raw: string;
  // The body read too: a connection lost or a timeout mid-answer is the
  // service failing, not this server.
  try {
    res = await fetchFn(`${base}/inference`, { method: "POST", body: form, signal, redirect: "error" });
    raw = await res.text();
  } catch (err) {
    if (signal.aborted) throw stopped(timeoutMs);
    throw new TranscribeError(503, `the transcription service did not answer (${(err as Error).message}) — try again in a moment`);
  }
  if (!res.ok) throw new TranscribeError(502, `the transcription service answered ${res.status}`);
  let j: { text?: unknown; language?: unknown; error?: unknown };
  try {
    j = JSON.parse(raw);
  } catch {
    throw new TranscribeError(502, "the transcription service sent something that is not JSON");
  }
  if (typeof j.error === "string") throw new TranscribeError(502, `the transcription service refused it: ${j.error.slice(0, 200)}`);
  if (typeof j.text !== "string") throw new TranscribeError(502, "the transcription service sent no text");
  return { text: j.text.trim(), language: typeof j.language === "string" ? langCode(j.language) : language };
}

/** whisper.cpp names the language it heard in full ("persian"); callers get
 *  the code. Names not listed here are passed on as they came. */
const LANG_CODES: Record<string, string> = {
  persian: "fa", english: "en", arabic: "ar", turkish: "tr", urdu: "ur", pashto: "ps", french: "fr", german: "de", spanish: "es",
  italian: "it", portuguese: "pt", dutch: "nl", russian: "ru", ukrainian: "uk", polish: "pl", chinese: "zh", japanese: "ja",
  korean: "ko", hindi: "hi", indonesian: "id", hebrew: "he", greek: "el", swedish: "sv", norwegian: "no", danish: "da", czech: "cs",
  finnish: "fi", vietnamese: "vi", thai: "th", malay: "ms", romanian: "ro", hungarian: "hu", catalan: "ca", tamil: "ta", bengali: "bn",
  cantonese: "yue", tagalog: "tl", swahili: "sw", azerbaijani: "az", kazakh: "kk", uzbek: "uz", armenian: "hy", georgian: "ka",
  serbian: "sr", croatian: "hr", bulgarian: "bg", slovak: "sk", lithuanian: "lt", latvian: "lv", estonian: "et", slovenian: "sl",
  punjabi: "pa", marathi: "mr", telugu: "te", kannada: "kn", malayalam: "ml", gujarati: "gu", nepali: "ne", sinhala: "si",
  burmese: "my", khmer: "km", lao: "lo", amharic: "am", somali: "so", welsh: "cy", icelandic: "is", albanian: "sq",
  macedonian: "mk", belarusian: "be", tajik: "tg", mongolian: "mn", afrikaans: "af", galician: "gl", basque: "eu", hausa: "ha",
  yoruba: "yo", latin: "la", maori: "mi", bosnian: "bs", sindhi: "sd", turkmen: "tk", tatar: "tt", bashkir: "ba", yiddish: "yi",
};
export function langCode(name: string): string {
  const n = name.trim().toLowerCase();
  return LANG_CODES[n] ?? n;
}

function stopped(timeoutMs: number): TranscribeError {
  return new TranscribeError(504, `the transcription was stopped (over ${timeoutMs / 1000} s, or the caller left) — try a shorter recording`);
}

/**
 * The words in a recording. `fa` goes to the Persian model when there is
 * one; `auto` asks the general model, and when it hears Persian and the
 * Persian model exists, that one transcribes it again; any other code goes
 * to the general model in that language.
 *
 * `/talk`'s entry (the gateway's POST /v1/foldrun/transcribe): at most
 * MAX_SECONDS of audio, TIMEOUT_MS to answer.
 */
export async function transcribe(wav: Buffer, lang: string, env: NodeJS.ProcessEnv = process.env, cancel?: AbortSignal, tenant?: string): Promise<Transcript> {
  return transcribeWith(wav, lang, env, { maxSeconds: MAX_SECONDS, timeoutMs: TIMEOUT_MS, cancel, tenant });
}

export interface TranscribeWavOptions {
  /** `fa`, `en`, `auto`, or another language code (langProblem). */
  lang: string;
  signal?: AbortSignal;
  /** Default SEGMENT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** The longest WAV taken, in seconds. Default SEGMENT_MAX_SECONDS. */
  maxSeconds?: number;
  env?: NodeJS.ProcessEnv;
  /** The account whose file it is: its own Whisper pods when on demand. */
  tenant?: string;
}

/**
 * The same, for one segment of a long file (extract.ts cuts audio into
 * segments of at most SEGMENT_MAX_SECONDS and sends each here): the same
 * models, the same checks (a silent segment is a 422), its own larger caps.
 * A segment of 30 s or more is encoded over the full window (audioCtx).
 */
export async function transcribeWav(wav: Buffer, opts: TranscribeWavOptions): Promise<Transcript> {
  const problem = langProblem(opts.lang);
  if (problem) throw new TranscribeError(400, problem);
  return transcribeWith(wav, opts.lang, opts.env ?? process.env, {
    maxSeconds: opts.maxSeconds ?? SEGMENT_MAX_SECONDS,
    timeoutMs: opts.timeoutMs ?? SEGMENT_TIMEOUT_MS,
    cancel: opts.signal,
    tenant: opts.tenant,
  });
}

async function transcribeWith(wav: Buffer, lang: string, env: NodeJS.ProcessEnv, o: { maxSeconds: number; timeoutMs: number; cancel?: AbortSignal; tenant?: string }): Promise<Transcript> {
  const head = readWav(wav);
  if ("error" in head) throw new TranscribeError(400, head.error);
  if (head.seconds > o.maxSeconds) throw new TranscribeError(413, `the recording is ${Math.round(head.seconds)} s — at most ${o.maxSeconds} s`);
  if (head.seconds < 0.3) throw new TranscribeError(400, "the recording is empty");
  if (head.peak < SILENCE_PEAK) throw new TranscribeError(422, "the recording level is too low — it is all but silent; check that the microphone is on and not muted");
  const s = servers(env);
  // Fixed Whisper servers win; else the account's own pods, made on demand
  // (tool-pod.ts) — both models, from one image.
  const onDemand = !s.general && !s.fa && !!o.tenant && sttOnDemandFor(o.tenant, env);
  if (!s.general && !s.fa && !onDemand) throw new TranscribeError(503, "transcription is not set up on this installation (FOLDRUN_TRANSCRIBE_URL)");
  const hasFa = !!s.fa || onDemand;
  const hasGeneral = !!s.general || onDemand;
  const cancel = o.cancel ?? new AbortController().signal;
  // Fixed servers: one deadline for the whole call, as always. On demand:
  // one per inference, so a cold pod (a runner node, the pull, the model
  // load: tool-pod.ts's own wait) is never counted as the recording's time.
  const total = AbortSignal.any([AbortSignal.timeout(o.timeoutMs), cancel]);
  const timed = () => (onDemand ? AbortSignal.any([AbortSignal.timeout(o.timeoutMs), cancel]) : total);
  const seconds = Math.round(head.seconds * 10) / 10;
  const ctx = audioCtx(head.seconds, env);
  const held: { release: () => Promise<void> }[] = [];
  const bases = new Map<"general" | "fa", string>();
  /** A model's address: the fixed one, or the account's pod — its lease held
   *  until this call ends, and the pod waited for. Persian is asked for only
   *  when it is wanted: lang=fa, or heard on the general model. */
  const base = async (model: "general" | "fa"): Promise<string> => {
    const fixed = s[model];
    if (fixed) return fixed;
    const known = bases.get(model);
    if (known) return known;
    const kind = model === "fa" ? STT_FA : STT_GEN;
    held.push(await holdToolLease(kind, o.tenant!));
    try {
      const url = await waitForTool(o.tenant!, cancel, env, toolStartMs(env), kind);
      bases.set(model, url);
      return url;
    } catch (err) {
      if (err instanceof ToolStartError) throw new TranscribeError(503, err.message);
      if (cancel.aborted) throw stopped(o.timeoutMs);
      throw err;
    }
  };
  try {
    const persian = async () => ({ ...(await inference(await base("fa"), wav, "fa", timed(), ctx, false, o.timeoutMs)), language: "fa", model: faModel(env), seconds });
    if (lang === "fa" && hasFa) return await persian();
    if (!hasGeneral) {
      if (lang === "auto" || lang === "fa") return await persian();
      throw new TranscribeError(503, `only Persian is set up here — send lang=fa (asked for ${lang})`);
    }
    // auto with a Persian model: ask the general model which language it is
    // (one encoder pass, no text), then transcribe once on the right model.
    // Transcribing on the general model first and again on the Persian one cost
    // three encoder passes for Persian (~72 s on dev); this costs two (~48 s).
    if (lang === "auto" && hasFa) {
      const general = await base("general");
      const heard = await inference(general, wav, "auto", timed(), ctx, true, o.timeoutMs);
      if (heard.language === "fa") return await persian();
      if (total.aborted && !onDemand) throw stopped(o.timeoutMs);
      if (cancel.aborted) throw stopped(o.timeoutMs);
      if (/^[a-z]{2,3}$/.test(heard.language)) {
        const words = await inference(general, wav, heard.language, timed(), ctx, false, o.timeoutMs);
        return { ...words, language: heard.language, model: "whisper-large-v3-turbo", seconds };
      }
    }
    const first = await inference(await base("general"), wav, lang, timed(), ctx, false, o.timeoutMs);
    return { ...first, model: "whisper-large-v3-turbo", seconds };
  } finally {
    for (const h of held) await h.release().catch((err) => opsError("transcribe.lease_release_failed", err, { tenant: o.tenant }));
  }
}
