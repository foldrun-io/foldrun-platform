// Images and PDFs in a model call, read into text before the call (FOL-268):
// a gateway key with `mediaToText` on has each base64 image block and PDF
// document block — in the person's turns and in tool results — read by
// foldrun's own extraction, and the model is sent the text, so no image or
// document tokens are spent on it. Off by default: it changes what the model
// sees. A block that cannot be read (no extraction on this install, a parser
// failure, a URL source) is left as it was.

import { extractFile, extractConfiguredFor, withExtractSlot, type ExtractResult } from "./extract.ts";
import { readsViaWorker, readViaWorker } from "./media-reads.ts";

type Json = Record<string, unknown>;

/** At most this many blocks are read for one call; the rest go as they are. */
export const MEDIA_BLOCKS_MAX = 20;
/** The most text one block becomes, and all of a call's together (the door's body limit is 32 MB). */
export const MEDIA_TEXT_BYTES = 200 * 1024;
export const MEDIA_TEXT_TOTAL_BYTES = 2 * 1024 * 1024;
/** How long one block, and the whole call's reading, may take before the rest go as they are. */
export const MEDIA_BLOCK_MS = 60_000;
/** The door's own request limit (gateway-door MAX_BODY). */
export const MEDIA_BODY_MAX = 32 * 1024 * 1024;
export const MEDIA_CALL_MS = 120_000;

export interface MediaToText {
  body: Buffer;
  /** Blocks replaced by their text. */
  read: number;
  /** Blocks that could not be read and went as they were. */
  left: number;
}

type Extract = (tenant: string, bytes: Buffer, opts: { name: string; signal?: AbortSignal }) => Promise<Pick<ExtractResult, "text">>;

let extractFn: Extract = (tenant, bytes, opts) => extractFile(tenant, bytes, opts);
/** Where this process cannot read files (the gateway), the worker reads them (media-reads.ts; owner, 25 Nov 2026). */
let viaWorkerFn: (() => boolean) | null = null;
let workerReadFn: Extract = (tenant, bytes, opts) => readViaWorker(tenant, bytes, { name: opts.name, signal: opts.signal, deadlineMs: MEDIA_BLOCK_MS });
let configuredFn: (tenant: string) => boolean = (tenant) => extractConfiguredFor(tenant);
type Slot = <T>(tenant: string, actor: string, fn: () => Promise<T>) => Promise<T>;
let slotFn: Slot = (tenant, actor, fn) => withExtractSlot(tenant, actor, fn);

export function setMediaToTextForTests(o: { extract?: Extract; configured?: (tenant: string) => boolean; slot?: Slot; viaWorker?: () => boolean; workerRead?: Extract } | null): void {
  extractFn = o?.extract ?? ((tenant, bytes, opts) => extractFile(tenant, bytes, opts));
  viaWorkerFn = o?.viaWorker ?? null;
  workerReadFn = o?.workerRead ?? ((tenant, bytes, opts) => readViaWorker(tenant, bytes, { name: opts.name, signal: opts.signal, deadlineMs: MEDIA_BLOCK_MS }));
  configuredFn = o?.configured ?? ((tenant) => extractConfiguredFor(tenant));
  slotFn = o?.slot ?? (o ? (_t, _a, fn) => fn() : (tenant, actor, fn) => withExtractSlot(tenant, actor, fn));
}

/** The words that stand for a block: said plainly to be a reading of it, and where it ends. */
export function mediaTextBlock(kind: "image" | "PDF", text: string, cut = false): Json {
  const how = kind === "image" ? "read by OCR" : "read into text";
  const body = (text.trim() || "(no text was found in it)") + (cut ? "\n[…the text was cut here]" : "");
  return { type: "text", text: `[An ${kind === "image" ? "image" : "attached PDF"}, ${how} by foldrun before this call — you are given its text, not the ${kind === "image" ? "image" : "file"}:]\n${body}\n[end of the ${kind === "image" ? "image" : "PDF"}]` };
}

/** The base64 image or PDF a block carries, or null. */
function mediaOf(b: unknown): { kind: "image" | "PDF"; bytes: Buffer; name: string; cache?: unknown } | null {
  if (!b || typeof b !== "object") return null;
  const block = b as Json;
  const src = block.source as Json | undefined;
  if (!src || src.type !== "base64" || typeof src.data !== "string") return null;
  const type = String(src.media_type ?? "");
  const cache = block.cache_control !== undefined ? { cache: block.cache_control } : {};
  if (block.type === "image" && /^image\/(png|jpeg|gif|webp)$/.test(type)) return { kind: "image", bytes: Buffer.from(src.data, "base64"), name: `image.${type.slice(6).replace("jpeg", "jpg")}`, ...cache };
  if (block.type === "document" && type === "application/pdf") return { kind: "PDF", bytes: Buffer.from(src.data, "base64"), name: "document.pdf", ...cache };
  return null;
}

/**
 * The request with its image and PDF blocks read into text, or the same bytes when there are none, the body is
 * not JSON, or this install has no extraction. One at a time, in one of the account's extraction places (the
 * cap its jobs count against; none free: every block goes as it was), within MEDIA_BLOCK_MS each and
 * MEDIA_CALL_MS for all, and stopped when `signal` aborts (the caller left). A block read before by this
 * account comes from its cache, so a conversation's history is not read again each turn. Each failure, and
 * each block past the time or the text total, goes as it was. A block's cache_control stays on its text.
 * Best effort: a count_tokens call and the call after it may differ when a place was free for one only.
 */
export async function mediaToText(tenant: string, body: Buffer, opts: { signal?: AbortSignal; actor?: string } = {}): Promise<MediaToText> {
  let json: Json;
  try {
    json = JSON.parse(body.toString("utf8")) as Json;
  } catch {
    return { body, read: 0, left: 0 };
  }
  if (!Array.isArray(json.messages)) return { body, read: 0, left: 0 };
  // Every content array a block can sit in: a message's, and a tool result's inside it.
  const slots: { list: unknown[]; i: number; media: NonNullable<ReturnType<typeof mediaOf>> }[] = [];
  const visit = (list: unknown) => {
    if (!Array.isArray(list)) return;
    list.forEach((b, i) => {
      const media = mediaOf(b);
      if (media) slots.push({ list, i, media });
      else if (b && typeof b === "object" && (b as Json).type === "tool_result") visit((b as Json).content);
    });
  };
  for (const m of json.messages as Json[]) if (m && typeof m === "object") visit(m.content);
  if (!slots.length) return { body, read: 0, left: 0 };
  // This process cannot read files (no parser it may reach or make): every block goes as it was, and is counted as
  // left, so the caller's header says so — a key set to text never looks read when nothing was (FOL-268, dev 25 Nov).
  // Read here where this process can; else by the worker, where the install says one reads (the gateway).
  const here = configuredFn(tenant);
  const viaWorker = !here && (viaWorkerFn ? viaWorkerFn() : readsViaWorker());
  if (!here && !viaWorker) return { body, read: 0, left: slots.length };
  const readOne: Extract = here ? extractFn : workerReadFn;
  // The worker takes the account's extraction slot when it reads, so a block waiting in the queue holds no slot and
  // keeps no parser up (Codex).
  const slot: Slot = here ? slotFn : (_t, _a, fn) => fn();
  const todo = slots.slice(0, MEDIA_BLOCKS_MAX);
  let read = 0;
  let total = 0;
  const deadline = Date.now() + MEDIA_CALL_MS;
  try {
    await slot(tenant, opts.actor ?? "gateway", async () => {
      for (const s of todo) {
        const wait = Math.min(MEDIA_BLOCK_MS, deadline - Date.now());
        if (opts.signal?.aborted || wait <= 0 || total >= MEDIA_TEXT_TOTAL_BYTES) break;
        const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(wait)]) : AbortSignal.timeout(wait);
        try {
          const r = await readOne(tenant, s.media.bytes, { name: s.media.name, signal });
          const room = Math.min(MEDIA_TEXT_BYTES, MEDIA_TEXT_TOTAL_BYTES - total);
          const whole = Buffer.from(r.text, "utf8");
          const cut = whole.length > room;
          const text = cut ? whole.subarray(0, room).toString("utf8").replace(/\uFFFD$/, "") : r.text;
          total += Math.min(whole.length, room);
          s.list[s.i] = { ...mediaTextBlock(s.media.kind, text, cut), ...(s.media.cache !== undefined ? { cache_control: s.media.cache } : {}) };
          read += 1;
        } catch {
          /* this block goes as it was */
        }
      }
    });
  } catch {
    /* no extraction place free: every block goes as it was */
  }
  if (!read) return { body, read, left: slots.length };
  // Never larger than the door takes: past it, the call goes as it was sent (Codex).
  const out = Buffer.from(JSON.stringify(json));
  if (out.length > MEDIA_BODY_MAX && out.length > body.length) return { body, read: 0, left: slots.length };
  return { body: out, read, left: slots.length - read };
}
