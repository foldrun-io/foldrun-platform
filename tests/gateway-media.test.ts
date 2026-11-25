import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mediaToText, setMediaToTextForTests, MEDIA_BLOCKS_MAX } from "../src/gateway-media.ts";

afterEach(() => setMediaToTextForTests(null));

const png = { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("png-bytes").toString("base64") } };
const pdf = { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from("pdf-bytes").toString("base64") } };

test("FOL-268: image and PDF blocks, in turns and tool results, become their text", async () => {
  const seen: string[] = [];
  setMediaToTextForTests({ configured: () => true, extract: async (_t, b, o) => (seen.push(`${o.name}:${b.toString()}`), { text: `text of ${b.toString()}` }) });
  const body = Buffer.from(JSON.stringify({ model: "m", messages: [
    { role: "user", content: [{ type: "text", text: "look" }, png] },
    { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [pdf] }] },
  ] }));
  const out = await mediaToText("acme", body);
  assert.equal(out.read, 2);
  assert.equal(out.left, 0);
  assert.deepEqual(seen.sort(), ["document.pdf:pdf-bytes", "image.png:png-bytes"]);
  const j = JSON.parse(out.body.toString());
  assert.equal(j.messages[0].content[1].type, "text");
  assert.match(j.messages[0].content[1].text, /read by OCR by foldrun[\s\S]*text of png-bytes\n\[end of the image\]/);
  assert.match(j.messages[2].content[0].content[0].text, /attached PDF[\s\S]*text of pdf-bytes/);
});

test("FOL-268: a block that cannot be read goes as it was; no extraction leaves the body alone", async () => {
  setMediaToTextForTests({ configured: () => true, extract: async () => { throw new Error("parser down"); } });
  const body = Buffer.from(JSON.stringify({ messages: [{ role: "user", content: [png] }] }));
  const out = await mediaToText("acme", body);
  assert.deepEqual([out.read, out.left], [0, 1]);
  assert.equal(out.body, body);
  setMediaToTextForTests({ configured: () => false, extract: async () => ({ text: "x" }) });
  const off = await mediaToText("acme", body);
  assert.deepEqual([off.read, off.left, off.body === body], [0, 0, true]);
  // URL images and non-JSON bodies are not touched.
  setMediaToTextForTests({ configured: () => true, extract: async () => ({ text: "x" }) });
  const url = Buffer.from(JSON.stringify({ messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://x/y.png" } }] }] }));
  assert.equal((await mediaToText("acme", url)).body, url);
  const junk = Buffer.from("not json");
  assert.equal((await mediaToText("acme", junk)).body, junk);
});

test("FOL-268: at most MEDIA_BLOCKS_MAX blocks are read; the rest are counted as left", async () => {
  setMediaToTextForTests({ configured: () => true, extract: async () => ({ text: "t" }) });
  const body = Buffer.from(JSON.stringify({ messages: [{ role: "user", content: Array.from({ length: MEDIA_BLOCKS_MAX + 3 }, () => png) }] }));
  const out = await mediaToText("acme", body);
  assert.deepEqual([out.read, out.left], [MEDIA_BLOCKS_MAX, 3]);
});
