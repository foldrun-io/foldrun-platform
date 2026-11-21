// The OpenAI format on the gateway (the one-API plan, step 3, 21 Nov 2026):
// `POST /v1/chat/completions` in OpenAI's shape, served as a Claude-format
// call. The request is turned into a Messages request, sent to this
// gateway's own `/v1/messages` with the caller's key and user agent as they
// came, and the reply — whole or streamed — is turned back.
//
// Going through the door rather than beside it is the point: the key, its
// limits and buckets, the end customer, the plan and wallet, the provider by
// the model's name and the provider translators all apply exactly as they
// do to a Claude-format call. That includes "a Claude login answers Claude
// Code alone": an OpenAI-format client is not Claude Code, so it is never
// served on a subscription.
//
// What does not map is refused with a 400 that says so, never dropped in
// silence when it changes the answer (n > 1, audio, logprobs); what only
// tunes it (seed, penalties, store, metadata) is let go.

type Json = Record<string, unknown>;

export interface ChatRequest {
  /** The Messages request to send. */
  body: Json;
  stream: boolean;
  /** `stream_options.include_usage`: a last chunk with the usage. */
  includeUsage: boolean;
  /** The model as the caller named it, echoed in every reply. */
  model: string;
}

/** Why a request cannot be served in this format. A class, so a refusal is
 *  told apart by what it is, never by its fields — a tool call's arguments
 *  may well hold a `status` (Codex review, 21 Nov 2026). */
export class FormatRefusal {
  readonly status: number;
  readonly message: string;
  readonly param?: string;
  constructor(status: number, message: string, param?: string) {
    this.status = status;
    this.message = message;
    if (param) this.param = param;
  }
}

/** The default `max_tokens` when the caller sets none: OpenAI's is "as many
 *  as fit", Messages requires one. */
export const DEFAULT_MAX_TOKENS = 8192;

/** Fields that change what the answer is, and have no Messages equivalent. */
const REFUSED: Record<string, (v: unknown) => boolean> = {
  n: (v) => v !== undefined && v !== null && v !== 1,
  logprobs: (v) => v === true,
  top_logprobs: (v) => v !== undefined && v !== null,
  audio: (v) => v !== undefined && v !== null,
  modalities: (v) => Array.isArray(v) && v.some((m) => m !== "text"),
  prediction: (v) => v !== undefined && v !== null,
  logit_bias: (v) => !!v && typeof v === "object" && Object.keys(v).length > 0,
  // JSON mode and schemas are a promise about the reply's shape that this
  // translation cannot keep on every provider: refused, not dropped (Codex
  // review, 21 Nov 2026). Plain text is what every reply is anyway.
  response_format: (v) => isObj(v) && v.type !== "text",
  // The old function-calling fields: send tools and tool_choice (Codex review).
  functions: (v) => v !== undefined && v !== null,
  function_call: (v) => v !== undefined && v !== null,
};

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

function refuse(message: string, param?: string): FormatRefusal {
  return new FormatRefusal(400, message, param);
}

/** A `data:` URL's media type and base64 payload, or null. */
function dataUrl(url: string): { mediaType: string; data: string } | null {
  const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
  return m ? { mediaType: m[1]!.toLowerCase(), data: m[2]! } : null;
}

/** One content part of a user (or system) message, as a Messages block. */
function partToBlock(p: unknown, where: string): Json | FormatRefusal {
  if (typeof p === "string") return { type: "text", text: p };
  if (!isObj(p)) return refuse(`${where}: a content part must be an object`, where);
  if (p.type === "text") {
    if (typeof p.text !== "string") return refuse(`${where}: a text part needs text`, where);
    return { type: "text", text: p.text };
  }
  if (p.type === "image_url") {
    const url = isObj(p.image_url) ? p.image_url.url : p.image_url;
    if (typeof url !== "string" || !url) return refuse(`${where}: an image_url part needs a url`, where);
    const d = dataUrl(url);
    if (d) return { type: "image", source: { type: "base64", media_type: d.mediaType, data: d.data } };
    if (!/^https?:\/\//i.test(url)) return refuse(`${where}: an image is an https URL or a data: URL`, where);
    return { type: "image", source: { type: "url", url } };
  }
  if (p.type === "file") {
    const f = isObj(p.file) ? p.file : {};
    const d = typeof f.file_data === "string" ? dataUrl(f.file_data) : null;
    if (d?.mediaType === "application/pdf") return { type: "document", source: { type: "base64", media_type: d.mediaType, data: d.data } };
    return refuse(`${where}: a file part is served as a PDF in file_data (a data: URL); a file_id is not`, where);
  }
  return refuse(`${where}: content parts of type ${JSON.stringify(p.type)} are not served (text, image_url and PDF files are)`, where);
}

function contentBlocks(content: unknown, where: string): Json[] | FormatRefusal {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return refuse(`${where}: content is a string or a list of parts`, where);
  const out: Json[] = [];
  for (let i = 0; i < content.length; i++) {
    const b = partToBlock(content[i], `${where}[${i}]`);
    if (b instanceof FormatRefusal) return b;
    out.push(b);
  }
  return out;
}

function textOf(content: unknown, where: string): string | FormatRefusal {
  const blocks = contentBlocks(content, where);
  if (blocks instanceof FormatRefusal) return blocks;
  const notText = blocks.find((b) => b.type !== "text");
  if (notText) return refuse(`${where}: only text is served here`, where);
  return blocks.map((b) => b.text as string).join("\n");
}

function toolArgs(raw: unknown, where: string): Json | FormatRefusal {
  if (raw === undefined || raw === null || raw === "") return {};
  if (isObj(raw)) return raw;
  if (typeof raw !== "string") return refuse(`${where}: arguments are a JSON string`, where);
  try {
    const v = JSON.parse(raw) as unknown;
    return isObj(v) ? v : refuse(`${where}: arguments must be a JSON object`, where);
  } catch {
    return refuse(`${where}: arguments are not valid JSON`, where);
  }
}

/** Messages wants turns that alternate; OpenAI allows a run of one role
 *  (several tool results, a user message after them). Joined into one. */
function push(turns: { role: string; content: Json[] }[], role: "user" | "assistant", blocks: Json[]): void {
  if (blocks.length === 0) return;
  const last = turns[turns.length - 1];
  // One by one: a spread of a very long list overflows the call's arguments (Codex review).
  if (last && last.role === role) for (const b of blocks) last.content.push(b);
  else turns.push({ role, content: blocks.slice() });
}

const STOP_OK = (s: unknown) => typeof s === "string" && s.length > 0;

/**
 * An OpenAI chat-completions request as a Messages request, or why not.
 * Pure: nothing is read or sent.
 */
export function chatToMessages(raw: unknown): ChatRequest | FormatRefusal {
  if (!isObj(raw)) return refuse("the body must be a JSON object");
  const model = raw.model;
  if (typeof model !== "string" || !model.trim()) return refuse("model is required", "model");
  for (const [field, bad] of Object.entries(REFUSED)) {
    if (bad(raw[field])) return refuse(`${field} is not served on foldrun's OpenAI format`, field);
  }
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) return refuse("messages must be a non-empty list", "messages");

  const system: string[] = [];
  const turns: { role: string; content: Json[] }[] = [];
  for (let i = 0; i < raw.messages.length; i++) {
    const m = raw.messages[i] as unknown;
    const where = `messages[${i}]`;
    if (!isObj(m)) return refuse(`${where} must be an object`, where);
    if (m.role === "system" || m.role === "developer") {
      // Before the first turn they are the system prompt; later, an
      // instruction mid-conversation, said as the user's.
      const t = textOf(m.content, `${where}.content`);
      if (t instanceof FormatRefusal) return t;
      if (turns.length === 0) system.push(t);
      else push(turns, "user", [{ type: "text", text: t }]);
    } else if (m.role === "user") {
      const blocks = contentBlocks(m.content, `${where}.content`);
      if (blocks instanceof FormatRefusal) return blocks;
      push(turns, "user", blocks);
    } else if (m.role === "assistant") {
      const blocks: Json[] = [];
      if (typeof m.refusal === "string" && m.refusal) blocks.push({ type: "text", text: m.refusal });
      const t = textOf(m.content, `${where}.content`);
      if (t instanceof FormatRefusal) return t;
      if (t) blocks.push({ type: "text", text: t });
      if (m.tool_calls !== undefined && m.tool_calls !== null) {
        if (!Array.isArray(m.tool_calls)) return refuse(`${where}.tool_calls must be a list`, `${where}.tool_calls`);
        for (let j = 0; j < m.tool_calls.length; j++) {
          const c = m.tool_calls[j] as unknown;
          const cw = `${where}.tool_calls[${j}]`;
          if (!isObj(c) || typeof c.id !== "string" || !isObj(c.function) || typeof c.function.name !== "string") {
            return refuse(`${cw} needs an id and a function with a name`, cw);
          }
          const input = toolArgs(c.function.arguments, `${cw}.function.arguments`);
          if (input instanceof FormatRefusal) return input;
          blocks.push({ type: "tool_use", id: c.id, name: c.function.name, input });
        }
      }
      // An empty assistant turn (a client's placeholder) has nothing to say.
      push(turns, "assistant", blocks);
    } else if (m.role === "tool") {
      if (typeof m.tool_call_id !== "string" || !m.tool_call_id) return refuse(`${where}.tool_call_id is required`, `${where}.tool_call_id`);
      const t = textOf(m.content, `${where}.content`);
      if (t instanceof FormatRefusal) return t;
      push(turns, "user", [{ type: "tool_result", tool_use_id: m.tool_call_id, content: t }]);
    } else if (m.role === "function") {
      return refuse(`${where}: the function role is OpenAI's old form — send tool messages`, `${where}.role`);
    } else {
      return refuse(`${where}.role ${JSON.stringify(m.role)} is not a chat role`, `${where}.role`);
    }
  }
  if (turns.length === 0) return refuse("messages has no user turn", "messages");
  if (turns[0]!.role !== "user") turns.unshift({ role: "user", content: [{ type: "text", text: "(continue)" }] });

  const body: Json = { model, messages: turns };
  if (system.length) body.system = system.join("\n\n");

  const max = raw.max_completion_tokens ?? raw.max_tokens;
  if (max !== undefined && max !== null) {
    if (typeof max !== "number" || !Number.isInteger(max) || max < 1) return refuse("max_completion_tokens must be a positive whole number", "max_completion_tokens");
    body.max_tokens = max;
  } else body.max_tokens = DEFAULT_MAX_TOKENS;

  if (raw.temperature !== undefined && raw.temperature !== null) {
    if (typeof raw.temperature !== "number" || raw.temperature < 0 || raw.temperature > 2) return refuse("temperature is a number from 0 to 2", "temperature");
    // OpenAI's runs 0–2, Messages' 0–1. Kept as sent up to 1, where most
    // calls sit and both mean the same; above it, Messages' most.
    body.temperature = Math.min(raw.temperature, 1);
  }
  if (raw.top_p !== undefined && raw.top_p !== null) {
    if (typeof raw.top_p !== "number" || raw.top_p < 0 || raw.top_p > 1) return refuse("top_p is a number from 0 to 1", "top_p");
    body.top_p = raw.top_p;
  }
  if (raw.stop !== undefined && raw.stop !== null) {
    const stops = typeof raw.stop === "string" ? [raw.stop] : raw.stop;
    if (!Array.isArray(stops) || !stops.every(STOP_OK)) return refuse("stop is a string or a list of strings", "stop");
    if (stops.length) body.stop_sequences = stops;
  }

  if (raw.tools !== undefined && raw.tools !== null) {
    if (!Array.isArray(raw.tools)) return refuse("tools must be a list", "tools");
    const tools: Json[] = [];
    for (let i = 0; i < raw.tools.length; i++) {
      const t = raw.tools[i] as unknown;
      if (!isObj(t) || t.type !== "function" || !isObj(t.function) || typeof t.function.name !== "string") {
        return refuse(`tools[${i}] must be {type: "function", function: {name, …}}`, `tools[${i}]`);
      }
      // A strict schema is a promise the reply's arguments keep; not every
      // provider behind this format can keep it: refused, not dropped.
      if (t.function.strict === true) return refuse(`tools[${i}].function.strict is not served yet — leave it out and check the arguments yourself`, `tools[${i}].function.strict`);
      const params = isObj(t.function.parameters) ? t.function.parameters : { type: "object", properties: {} };
      tools.push({ name: t.function.name, ...(typeof t.function.description === "string" ? { description: t.function.description } : {}), input_schema: params });
    }
    if (tools.length) body.tools = tools;
  }
  const tc = raw.tool_choice;
  if (tc !== undefined && tc !== null) {
    let choice: Json | null;
    if (tc === "auto") choice = { type: "auto" };
    else if (tc === "none") choice = { type: "none" };
    else if (tc === "required") choice = { type: "any" };
    else if (isObj(tc) && tc.type === "function" && isObj(tc.function) && typeof tc.function.name === "string") choice = { type: "tool", name: tc.function.name };
    else return refuse('tool_choice is "auto", "none", "required" or {type: "function", function: {name}}', "tool_choice");
    if ((choice.type === "any" || choice.type === "tool") && !body.tools) return refuse("tool_choice asks for a tool, and tools names none", "tool_choice");
    if (choice.type === "tool" && !(body.tools as Json[]).some((x) => x.name === choice.name)) return refuse(`tool_choice names ${JSON.stringify(choice.name)}, which tools does not`, "tool_choice");
    if (raw.parallel_tool_calls === false && choice.type !== "none") choice.disable_parallel_tool_use = true;
    if (body.tools || choice.type === "none") body.tool_choice = choice;
  } else if (raw.parallel_tool_calls === false && body.tools) {
    body.tool_choice = { type: "auto", disable_parallel_tool_use: true };
  }

  const stream = raw.stream === true;
  if (stream) body.stream = true;
  const includeUsage = stream && isObj(raw.stream_options) && raw.stream_options.include_usage === true;
  return { body, stream, includeUsage, model };
}

/** Messages' stop reason as OpenAI's finish reason. */
export function finishReason(stop: unknown): string {
  switch (stop) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    default:
      return "stop";
  }
}

/** Messages' usage as OpenAI's: prompt tokens count every input token,
 *  cached and written to the cache too, as OpenAI's do. */
export function chatUsage(u: unknown): Json {
  const x = isObj(u) ? u : {};
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const cached = n(x.cache_read_input_tokens);
  const prompt = n(x.input_tokens) + cached + n(x.cache_creation_input_tokens);
  const completion = n(x.output_tokens);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, prompt_tokens_details: { cached_tokens: cached } };
}

const chatId = (id: unknown) => `chatcmpl-${typeof id === "string" && id ? id.replace(/^msg_/, "") : Date.now().toString(36)}`;

/** A whole Messages reply as a chat completion. Thinking is not shown: it
 *  has no place in a chat completion's message. */
export function messageToChat(msg: unknown, model: string, now = Date.now()): Json {
  const m = isObj(msg) ? msg : {};
  const blocks = Array.isArray(m.content) ? (m.content as unknown[]).filter(isObj) : [];
  const text = blocks.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("");
  const calls = blocks
    .filter((b) => b.type === "tool_use")
    .map((b) => ({ id: String(b.id ?? ""), type: "function", function: { name: String(b.name ?? ""), arguments: JSON.stringify(b.input ?? {}) } }));
  const message: Json = { role: "assistant", content: text || (calls.length ? null : ""), refusal: null };
  if (calls.length) message.tool_calls = calls;
  return {
    id: chatId(m.id),
    object: "chat.completion",
    created: Math.floor(now / 1000),
    model,
    choices: [{ index: 0, message, logprobs: null, finish_reason: finishReason(m.stop_reason) }],
    usage: chatUsage(m.usage),
  };
}

/** Messages' error type as OpenAI's. */
const ERROR_TYPES: Record<string, string> = {
  invalid_request_error: "invalid_request_error",
  authentication_error: "authentication_error",
  permission_error: "permission_error",
  not_found_error: "not_found_error",
  request_too_large: "invalid_request_error",
  rate_limit_error: "rate_limit_error",
  billing_error: "insufficient_quota",
  api_error: "server_error",
  overloaded_error: "server_error",
  timeout_error: "server_error",
};

/** A refusal in OpenAI's shape: from a Messages error body, or our own words. */
export function chatError(status: number, body: unknown, fallback = "the call failed"): Json {
  let type: string | null = null;
  let message = fallback;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body) as unknown;
    } catch {
      /* not JSON: the fallback stands */
    }
  }
  if (isObj(body) && isObj(body.error)) {
    if (typeof body.error.type === "string") type = body.error.type;
    if (typeof body.error.message === "string") message = body.error.message;
  }
  const mapped = (type && ERROR_TYPES[type]) ?? (status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" : status >= 500 ? "server_error" : "invalid_request_error");
  return { error: { message, type: mapped, param: null, code: status === 402 ? "insufficient_quota" : null } };
}

/**
 * A streamed Messages reply as chat-completion chunks. `feed` takes one
 * parsed SSE event and returns the `data:` lines to write (each ends in a
 * blank line); `end` returns what closes the stream. Text and tool-call
 * arguments pass through as they come; nothing is held back.
 */
export class ChatStream {
  private id = chatId(undefined);
  private created: number;
  private tools = new Map<number, number>(); // content block index → tool call index
  private argsSeen = new Map<number, boolean>(); // content block index → had argument deltas
  private startInput = new Map<number, unknown>(); // content block index → the block's own input
  private usage: Json = {};
  private finish: string | null = null;
  private failed = false;
  private started = false;
  private stopped = false;

  private readonly model: string;
  private readonly includeUsage: boolean;

  constructor(model: string, includeUsage: boolean, now = Date.now()) {
    this.model = model;
    this.includeUsage = includeUsage;
    this.created = Math.floor(now / 1000);
  }

  private chunk(delta: Json, finish: string | null = null): string {
    return `data: ${JSON.stringify({ id: this.id, object: "chat.completion.chunk", created: this.created, model: this.model, choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }] })}\n\n`;
  }

  feed(ev: unknown): string[] {
    if (!isObj(ev) || this.failed) return [];
    switch (ev.type) {
      case "message_start": {
        const m = isObj(ev.message) ? ev.message : {};
        this.id = chatId(m.id);
        this.usage = { ...(isObj(m.usage) ? m.usage : {}) };
        if (this.started) return [];
        this.started = true;
        return [this.chunk({ role: "assistant", content: "" })];
      }
      case "content_block_start": {
        const b = isObj(ev.content_block) ? ev.content_block : {};
        if (b.type !== "tool_use") return [];
        const at = this.tools.size;
        this.tools.set(Number(ev.index), at);
        this.argsSeen.set(Number(ev.index), false);
        this.startInput.set(Number(ev.index), b.input);
        return [this.chunk({ tool_calls: [{ index: at, id: String(b.id ?? ""), type: "function", function: { name: String(b.name ?? ""), arguments: "" } }] })];
      }
      case "content_block_delta": {
        const d = isObj(ev.delta) ? ev.delta : {};
        if (d.type === "text_delta" && typeof d.text === "string" && d.text) return [this.chunk({ content: d.text })];
        if (d.type === "input_json_delta" && typeof d.partial_json === "string" && d.partial_json) {
          const at = this.tools.get(Number(ev.index));
          if (at === undefined) return [];
          this.argsSeen.set(Number(ev.index), true);
          return [this.chunk({ tool_calls: [{ index: at, function: { arguments: d.partial_json } }] })];
        }
        return [];
      }
      case "message_delta": {
        const d = isObj(ev.delta) ? ev.delta : {};
        if (d.stop_reason !== undefined && d.stop_reason !== null) this.finish = finishReason(d.stop_reason);
        if (isObj(ev.usage)) this.usage = { ...this.usage, ...ev.usage };
        return [];
      }
      case "error": {
        this.failed = true;
        const e = chatError(500, ev, "the model's reply broke off");
        return [`data: ${JSON.stringify(e)}\n\n`];
      }
      case "content_block_stop": {
        // A tool call that streamed no arguments still has some: the block's
        // own input, or {} — an empty string parses as nothing (Codex review).
        const at = this.tools.get(Number(ev.index));
        if (at === undefined || this.argsSeen.get(Number(ev.index))) return [];
        const input = this.startInput.get(Number(ev.index));
        return [this.chunk({ tool_calls: [{ index: at, function: { arguments: JSON.stringify(isObj(input) ? input : {}) } }] })];
      }
      case "message_stop":
        this.stopped = true;
        return [];
      default:
        return []; // ping, thinking
    }
  }

  end(): string[] {
    if (this.failed) return ["data: [DONE]\n\n"];
    // Ended without message_stop: cut off on the way, said as an error, not
    // a finished answer (Codex review, 21 Nov 2026).
    if (!this.stopped) return [`data: ${JSON.stringify(chatError(502, null, "the model's reply broke off before it ended — retry"))}\n\n`, "data: [DONE]\n\n"];
    const out = [this.chunk({}, this.finish ?? "stop")];
    if (this.includeUsage) out.push(`data: ${JSON.stringify({ id: this.id, object: "chat.completion.chunk", created: this.created, model: this.model, choices: [], usage: chatUsage(this.usage) })}\n\n`);
    out.push("data: [DONE]\n\n");
    return out;
  }
}

/** The user agent the OpenAI format's inner call carries: its own name
 *  first, so the door never reads it as Claude Code (fromClaudeCode) and a
 *  Claude login is never asked, whatever the client calls itself; the
 *  client's own after it, for the record. */
export function innerUserAgent(ua: string | string[] | undefined): string {
  const v = (Array.isArray(ua) ? ua[0] : ua)?.replace(/[\r\n]/g, " ").trim().slice(0, 200);
  return v ? `foldrun-openai/1 (${v})` : "foldrun-openai/1";
}

/** Splits an SSE byte stream into the JSON of each `data:` line, across
 *  chunk boundaries. */
export class SseEvents {
  private buf = "";
  private dec = new TextDecoder();
  push(chunk: Uint8Array): unknown[] {
    this.buf += this.dec.decode(chunk, { stream: true });
    const out: unknown[] = [];
    let cut: number;
    while ((cut = this.buf.search(/\r?\n\r?\n/)) >= 0) {
      const frame = this.buf.slice(0, cut);
      this.buf = this.buf.slice(cut).replace(/^\r?\n\r?\n/, "");
      const data = frame
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data || data === "[DONE]") continue;
      try {
        out.push(JSON.parse(data));
      } catch {
        /* a frame that is not JSON carries nothing to translate */
      }
    }
    return out;
  }
}
