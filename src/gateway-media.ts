// Images and PDFs in a model call, read into text before the call (FOL-268):
// a gateway key with `mediaToText` on has each base64 image block and PDF
// document block — in the person's turns and in tool results — read by
// foldrun's own extraction, and the model is sent the text, so no image or
// document tokens are spent on it. Off by default: it changes what the model
// sees. A block that cannot be read (no extraction on this install, a parser
// failure, a URL source) is left as it was.

import { extractFile, extractConfiguredFor, type ExtractResult } from "./extract.ts";

type Json = Record<string, unknown>;

/** At most this many blocks are read for one call; the rest go as they are. */
export const MEDIA_BLOCKS_MAX = 20;

export interface MediaToText {
  body: Buffer;
  /** Blocks replaced by their text. */
  read: number;
  /** Blocks that could not be read and went as they were. */
  left: number;
}

type Extract = (tenant: string, bytes: Buffer, opts: { name: string; signal?: AbortSignal }) => Promise<Pick<ExtractResult, "text">>;

let extractFn: Extract = (tenant, bytes, opts) => extractFile(tenant, bytes, opts);
let configuredFn: (tenant: string) => boolean = (tenant) => extractConfiguredFor(tenant);

export function setMediaToTextForTests(o: { extract?: Extract; configured?: (tenant: string) => boolean } | null): void {
  extractFn = o?.extract ?? ((tenant, bytes, opts) => extractFile(tenant, bytes, opts));
  configuredFn = o?.configured ?? ((tenant) => extractConfiguredFor(tenant));
}

/** The words that stand for a block: said plainly to be a reading of it, and where it ends. */
export function mediaTextBlock(kind: "image" | "PDF", text: string): Json {
  const how = kind === "image" ? "read by OCR" : "read into text";
  const body = text.trim() || "(no text was found in it)";
  return { type: "text", text: `[An ${kind === "image" ? "image" : "attached PDF"}, ${how} by foldrun before this call — you are given its text, not the ${kind === "image" ? "image" : "file"}:]\n${body}\n[end of the ${kind === "image" ? "image" : "PDF"}]` };
}

/** The base64 image or PDF a block carries, or null. */
function mediaOf(b: unknown): { kind: "image" | "PDF"; bytes: Buffer; name: string } | null {
  if (!b || typeof b !== "object") return null;
  const block = b as Json;
  const src = block.source as Json | undefined;
  if (!src || src.type !== "base64" || typeof src.data !== "string") return null;
  const type = String(src.media_type ?? "");
  if (block.type === "image" && /^image\/(png|jpeg|gif|webp)$/.test(type)) return { kind: "image", bytes: Buffer.from(src.data, "base64"), name: `image.${type.slice(6).replace("jpeg", "jpg")}` };
  if (block.type === "document" && type === "application/pdf") return { kind: "PDF", bytes: Buffer.from(src.data, "base64"), name: "document.pdf" };
  return null;
}

/**
 * The request with its image and PDF blocks read into text, or the same bytes when there are none, the body is
 * not JSON, or this install has no extraction. Blocks are read four at a time; each failure leaves its block.
 */
export async function mediaToText(tenant: string, body: Buffer, signal?: AbortSignal): Promise<MediaToText> {
  let json: Json;
  try {
    json = JSON.parse(body.toString("utf8")) as Json;
  } catch {
    return { body, read: 0, left: 0 };
  }
  if (!Array.isArray(json.messages) || !configuredFn(tenant)) return { body, read: 0, left: 0 };
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
  const todo = slots.slice(0, MEDIA_BLOCKS_MAX);
  let read = 0;
  let left = slots.length - todo.length;
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const s = todo[next++];
      try {
        const r = await extractFn(tenant, s.media.bytes, { name: s.media.name, signal });
        s.list[s.i] = mediaTextBlock(s.media.kind, r.text);
        read += 1;
      } catch {
        left += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, todo.length) }, worker));
  return { body: read ? Buffer.from(JSON.stringify(json)) : body, read, left };
}
