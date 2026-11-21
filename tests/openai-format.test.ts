// The OpenAI format's shapes (src/openai-format.ts, 21 Nov 2026): a chat
// completion request as a Messages request, and the reply back.
//
//   node --test tests/openai-format.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatStream, DEFAULT_MAX_TOKENS, FormatRefusal, SseEvents, chatError, chatToMessages, innerUserAgent, messageToChat } from "../src/openai-format.ts";
import { fromClaudeCode, upstreamEnded } from "../src/gateway-door.ts";

const ok = (v: ReturnType<typeof chatToMessages>) => {
  assert.ok(!(v instanceof FormatRefusal), JSON.stringify(v));
  return v as Exclude<typeof v, FormatRefusal>;
};

test("system and developer lead as the system prompt; turns of one role are joined; tool results answer their calls", () => {
  const r = ok(
    chatToMessages({
      model: "gpt-5",
      messages: [
        { role: "system", content: "one" },
        { role: "developer", content: [{ type: "text", text: "two" }] },
        { role: "user", content: "hi" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: '{"a":1}' } }, { id: "c2", type: "function", function: { name: "g", arguments: "" } }] },
        { role: "tool", tool_call_id: "c1", content: "r1" },
        { role: "tool", tool_call_id: "c2", content: [{ type: "text", text: "r2" }] },
        { role: "user", content: "and?" },
      ],
    }),
  );
  assert.equal(r.body.system, "one\n\ntwo");
  assert.equal(r.body.max_tokens, DEFAULT_MAX_TOKENS);
  assert.deepEqual(r.body.messages, [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "f", input: { a: 1 } }, { type: "tool_use", id: "c2", name: "g", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "r1" }, { type: "tool_result", tool_use_id: "c2", content: "r2" }, { type: "text", text: "and?" }] },
  ]);
  assert.equal(r.stream, false);
});

test("images, PDFs, sampling, stops and tool choice map; what would change the answer is refused, by name", () => {
  const r = ok(
    chatToMessages({
      model: "m",
      max_tokens: 50,
      temperature: 1.6,
      top_p: 0.9,
      stop: "END",
      stream: true,
      stream_options: { include_usage: true },
      seed: 3,
      parallel_tool_calls: false,
      tool_choice: { type: "function", function: { name: "f" } },
      tools: [{ type: "function", function: { name: "f", description: "d" } }],
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            { type: "image_url", image_url: { url: "https://x.example/a.png" } },
            { type: "file", file: { file_data: "data:application/pdf;base64,JVBE" } },
          ],
        },
      ],
    }),
  );
  const parts = (r.body.messages as any[])[0].content;
  assert.deepEqual(parts[0], { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
  assert.deepEqual(parts[1], { type: "image", source: { type: "url", url: "https://x.example/a.png" } });
  assert.equal(parts[2].type, "document");
  assert.equal(r.body.max_tokens, 50);
  assert.equal(r.body.temperature, 1, "OpenAI's 0–2 held to Messages' most");
  assert.deepEqual(r.body.stop_sequences, ["END"]);
  assert.deepEqual(r.body.tool_choice, { type: "tool", name: "f", disable_parallel_tool_use: true });
  assert.deepEqual(r.body.tools, [{ name: "f", description: "d", input_schema: { type: "object", properties: {} } }]);
  assert.equal(r.body.seed, undefined, "a tuning field is let go");
  assert.equal(r.stream, true);
  assert.equal(r.includeUsage, true);

  for (const [field, value] of [["n", 2], ["logprobs", true], ["audio", {}], ["modalities", ["text", "audio"]], ["logit_bias", { "1": 5 }], ["response_format", { type: "json_object" }], ["functions", [{ name: "f" }]], ["function_call", "auto"], ["response_format", { type: "json_schema", json_schema: { name: "x", schema: {} } }]] as const) {
    const bad = chatToMessages({ model: "m", messages: [{ role: "user", content: "x" }], [field]: value });
    assert.equal((bad as any).status, 400, field);
    assert.equal((bad as any).param, field);
  }
  assert.equal((chatToMessages({ model: "m", messages: [] }) as any).param, "messages");
  assert.equal((chatToMessages({ messages: [{ role: "user", content: "x" }] }) as any).param, "model");
  assert.equal((chatToMessages({ model: "m", messages: [{ role: "function", content: "x" }] }) as any).status, 400);
  assert.equal((chatToMessages({ model: "m", messages: [{ role: "user", content: [{ type: "input_audio" }] }] }) as any).status, 400);
  assert.equal((chatToMessages({ model: "m", messages: [{ role: "assistant", tool_calls: [{ id: "a", function: { name: "f", arguments: "{" } }] }] }) as any).status, 400, "arguments that are not JSON");
  assert.equal((chatToMessages({ model: "m", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "file:///etc/passwd" } }] }] }) as any).status, 400, "only https and data: images");
});

test("a conversation that opens with the assistant gets a user turn first, as Messages requires", () => {
  const r = ok(chatToMessages({ model: "m", messages: [{ role: "assistant", content: "hello" }, { role: "user", content: "hi" }] }));
  assert.equal((r.body.messages as any[])[0].role, "user");
});

test("a whole reply: text joined, tool calls with JSON arguments, finish reasons and usage as OpenAI counts them", () => {
  const c = messageToChat(
    { id: "msg_abc", content: [{ type: "thinking", thinking: "…" }, { type: "text", text: "a" }, { type: "text", text: "b" }, { type: "tool_use", id: "t1", name: "f", input: { x: 1 } }], stop_reason: "tool_use", usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2, output_tokens: 7 } },
    "my-model",
    1_700_000_000_000,
  ) as any;
  assert.equal(c.id, "chatcmpl-abc");
  assert.equal(c.created, 1_700_000_000);
  assert.equal(c.model, "my-model");
  assert.equal(c.choices[0].message.content, "ab");
  assert.equal(c.choices[0].message.tool_calls[0].function.arguments, '{"x":1}');
  assert.equal(c.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(c.usage, { prompt_tokens: 17, completion_tokens: 7, total_tokens: 24, prompt_tokens_details: { cached_tokens: 5 } });
  assert.equal((messageToChat({ content: [], stop_reason: "max_tokens" }, "m") as any).choices[0].finish_reason, "length");
});

test("errors: Messages' types become OpenAI's, a 402 is insufficient_quota", () => {
  assert.deepEqual(chatError(429, JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow" } })), { error: { message: "slow", type: "rate_limit_error", param: null, code: null } });
  assert.equal((chatError(402, { type: "error", error: { type: "billing_error", message: "m" } }) as any).error.code, "insufficient_quota");
  assert.equal((chatError(502, "<html>") as any).error.type, "server_error");
});

test("the stream: frames split anywhere are read whole; a tool call's arguments pass as they come", () => {
  const raw = [
    { type: "message_start", message: { id: "msg_s", usage: { input_tokens: 3, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "secret" } },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hi" } },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "t", name: "f" } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{}" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } },
    { type: "message_stop" },
  ]
    .map((e) => `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`)
    .join("");
  const sse = new SseEvents();
  const bytes = new TextEncoder().encode(raw);
  const evs: unknown[] = [];
  for (let i = 0; i < bytes.length; i += 7) evs.push(...sse.push(bytes.slice(i, i + 7)));
  assert.equal(evs.length, 9);
  const tr = new ChatStream("m", true, 0);
  const out = [...evs.flatMap((e) => tr.feed(e)), ...tr.end()];
  const chunks = out.filter((l) => l !== "data: [DONE]\n\n").map((l) => JSON.parse(l.slice(6)));
  assert.ok(!out.join("").includes("secret"), "thinking is not shown");
  assert.equal(chunks[0].id, "chatcmpl-s");
  assert.deepEqual(chunks[1].choices[0].delta, { content: "hi" });
  assert.deepEqual(chunks[2].choices[0].delta.tool_calls[0], { index: 0, id: "t", type: "function", function: { name: "f", arguments: "" } });
  assert.deepEqual(chunks[3].choices[0].delta.tool_calls[0], { index: 0, function: { arguments: "{}" } });
  assert.equal(chunks[4].choices[0].finish_reason, "stop");
  assert.equal(chunks[5].usage.completion_tokens, 9);
  assert.equal(out[out.length - 1], "data: [DONE]\n\n");
  const failed = new ChatStream("m", false);
  assert.match(failed.feed({ type: "error", error: { type: "overloaded_error", message: "busy" } })[0]!, /"busy"/);
  assert.deepEqual(failed.end(), ["data: [DONE]\n\n"]);
});

test("the inner call's user agent is never Claude Code's, whatever the client sends", () => {
  for (const ua of ["claude-cli/2.1.3 (external, cli)", "claude-code/1.0", undefined, "x\r\nclaude-cli/1"]) {
    const inner = innerUserAgent(ua);
    assert.equal(fromClaudeCode(inner), false, String(ua));
    assert.ok(!/[\r\n]/.test(inner));
  }
});

test("a tool call whose arguments hold a status is translated, not taken for a refusal (Codex review)", () => {
  const r = ok(chatToMessages({ model: "m", messages: [{ role: "user", content: "x" }, { role: "assistant", tool_calls: [{ id: "a", type: "function", function: { name: "f", arguments: '{"status":200,"message":"ok"}' } }] }, { role: "tool", tool_call_id: "a", content: "done" }] }));
  assert.deepEqual((r.body.messages as any[])[1].content[0].input, { status: 200, message: "ok" });
  assert.ok(ok(chatToMessages({ model: "m", response_format: { type: "text" }, messages: [{ role: "user", content: "x" }] })));
});

test("a stream that ends without message_stop was cut off: it ends in an error, not a finish (Codex review)", () => {
  const tr = new ChatStream("m", true);
  tr.feed({ type: "message_start", message: { id: "msg_x" } });
  tr.feed({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "half" } });
  const end = tr.end();
  assert.equal(end.length, 2);
  assert.match(end[0]!, /"error"/);
  assert.equal(end[1], "data: [DONE]\n\n");
});

test("a strict tool schema is refused, not quietly weakened (Codex review)", () => {
  const r = chatToMessages({ model: "m", messages: [{ role: "user", content: "x" }], tools: [{ type: "function", function: { name: "f", strict: true, parameters: { type: "object" } } }] });
  assert.ok(r instanceof FormatRefusal);
  assert.equal(r.param, "tools[0].function.strict");
});

test("a tool call that streamed no arguments gets its block's input, or {} (Codex review)", () => {
  const tr = new ChatStream("m", false);
  tr.feed({ type: "message_start", message: { id: "msg_t" } });
  tr.feed({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "now", input: {} } });
  const out = tr.feed({ type: "content_block_stop", index: 0 });
  assert.equal(JSON.parse(out[0]!.slice(6)).choices[0].delta.tool_calls[0].function.arguments, "{}");
  tr.feed({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t2", name: "f", input: {} } });
  tr.feed({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"a":1}' } });
  assert.deepEqual(tr.feed({ type: "content_block_stop", index: 1 }), [], "arguments that streamed are not sent twice");
});

test("a tool choice that cannot be kept is refused; a very long part list is translated (Codex review)", () => {
  const base = { model: "m", messages: [{ role: "user", content: "x" }] };
  assert.equal((chatToMessages({ ...base, tool_choice: "required" }) as FormatRefusal).param, "tool_choice");
  assert.equal((chatToMessages({ ...base, tool_choice: { type: "function", function: { name: "g" } }, tools: [{ type: "function", function: { name: "f" } }] }) as FormatRefusal).param, "tool_choice");
  assert.ok(!(chatToMessages({ ...base, tool_choice: "none" }) instanceof FormatRefusal), "none needs no tools");
  const parts = Array.from({ length: 200_000 }, () => ({ type: "text", text: "a" }));
  const r = ok(chatToMessages({ model: "m", messages: [{ role: "user", content: "x" }, { role: "user", content: parts }] }));
  assert.equal((r.body.messages as any[])[0].content.length, 200_001);
});

test("a provider's stream is over on a finish reason or a Responses end event, nothing else", () => {
  assert.equal(upstreamEnded("chat", { choices: [{ delta: { content: "x" } }] }), false);
  assert.equal(upstreamEnded("chat", { choices: [{ delta: {}, finish_reason: "stop" }] }), true);
  assert.equal(upstreamEnded("chat", { choices: [] }), false);
  assert.equal(upstreamEnded("responses", { type: "response.output_text.delta" }), false);
  for (const t of ["response.completed", "response.incomplete", "response.failed"]) assert.equal(upstreamEnded("responses", { type: t }), true, t);
});

test("a Responses provider's own error event ends its stream, so its words are said", () => {
  assert.equal(upstreamEnded("responses", { type: "error", message: "quota" }), true);
});

