// Speech to text on foldrun's own pods (11 Nov 2026, design:
// foldrun-infra/docs/media-to-text-2026-11.md). The gateway's
// POST /v1/foldrun/transcribe hands a recording here; this sends it to a
// whisper.cpp server (`whisper-server`, its /inference route) in the
// foldrun-transcribe pods, which hold no credentials and reach nothing.
//
//   FOLDRUN_TRANSCRIBE_URL     the general model (large-v3-turbo): every language
//   FOLDRUN_TRANSCRIBE_FA_URL  the Persian model (whisper-large-fa-v1), when set
//
// Only WAV, PCM 16-bit, 16 kHz, mono is taken — what `foldrun talk` records
// and what whisper.cpp reads without converting. The header is checked here,
// before anything reaches a parser, so a length is known and capped up front.

export const SAMPLE_RATE = 16_000;
/** The longest recording taken, in seconds. `/talk` records at most 60. */
export const MAX_SECONDS = 120;
/** A WAV of MAX_SECONDS, with room for a longer header. */
export const MAX_BYTES = 44 + MAX_SECONDS * SAMPLE_RATE * 2 + 4096;
/** How long one transcription may take before it is refused. */
const TIMEOUT_MS = 90_000;

export interface Wav {
  seconds: number;
}

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
      return { seconds: bytes / (SAMPLE_RATE * 2) };
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

type Fetch = typeof fetch;
let fetchFn: Fetch = (...a) => fetch(...a);
export function setTranscribeFetchForTests(fn: Fetch | null): void {
  fetchFn = fn ?? ((...a) => fetch(...a));
}

/** One call to a whisper-server: verbose_json, so the detected language
 *  comes back with the text. Greedy at temperature 0, falling back as
 *  whisper.cpp does when a segment fails its checks. */
async function inference(base: string, wav: Buffer, language: string, signal: AbortSignal): Promise<{ text: string; language: string }> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "talk.wav");
  form.append("response_format", "verbose_json");
  form.append("temperature", "0.0");
  form.append("temperature_inc", "0.2");
  form.append("language", language);
  // The extra detection pass verbose_json would run for the probabilities
  // table: never needed, and it costs a second encoder pass.
  form.append("no_language_probabilities", "true");
  let res: Response;
  let raw: string;
  // The body read too: a connection lost or a timeout mid-answer is the
  // service failing, not this server.
  try {
    res = await fetchFn(`${base}/inference`, { method: "POST", body: form, signal });
    raw = await res.text();
  } catch (err) {
    if (signal.aborted) throw new TranscribeError(504, `the transcription was stopped (over ${TIMEOUT_MS / 1000} s, or the caller left) — try a shorter recording`);
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
};
export function langCode(name: string): string {
  const n = name.trim().toLowerCase();
  return LANG_CODES[n] ?? n;
}

/**
 * The words in a recording. `fa` goes to the Persian model when there is
 * one; `auto` asks the general model, and when it hears Persian and the
 * Persian model exists, that one transcribes it again; any other code goes
 * to the general model in that language.
 */
export async function transcribe(wav: Buffer, lang: string, env: NodeJS.ProcessEnv = process.env, cancel?: AbortSignal): Promise<Transcript> {
  const head = readWav(wav);
  if ("error" in head) throw new TranscribeError(400, head.error);
  if (head.seconds > MAX_SECONDS) throw new TranscribeError(413, `the recording is ${Math.round(head.seconds)} s — at most ${MAX_SECONDS} s`);
  if (head.seconds < 0.3) throw new TranscribeError(400, "the recording is empty");
  const s = servers(env);
  if (!s.general && !s.fa) throw new TranscribeError(503, "transcription is not set up on this installation (FOLDRUN_TRANSCRIBE_URL)");
  const abort = cancel ? AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), cancel]) : AbortSignal.timeout(TIMEOUT_MS);
  const seconds = Math.round(head.seconds * 10) / 10;
  const persian = async () => ({ ...(await inference(s.fa!, wav, "fa", abort)), language: "fa", model: "whisper-large-fa-v1", seconds });
  if (lang === "fa" && s.fa) return persian();
  if (!s.general) {
    if (lang === "auto" || lang === "fa") return persian();
    throw new TranscribeError(503, `only Persian is set up here — send lang=fa (asked for ${lang})`);
  }
  const first = await inference(s.general, wav, lang, abort);
  if (lang === "auto" && first.language === "fa" && s.fa && !abort.aborted) return persian();
  return { ...first, model: "whisper-large-v3-turbo", seconds };
}
