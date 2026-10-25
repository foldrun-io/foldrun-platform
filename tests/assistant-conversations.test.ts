// The assistant's conversations: kept per owner, listed newest first,
// searched by title and text, read and deleted only by their owner, and
// trimmed to KEEP. File store here; the Postgres store is the same API.
//
//   node --test tests/assistant-conversations.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-assistant-conv-"));
delete process.env.FOLDRUN_DATABASE_URL;

const c = await import("../src/assistant/conversations.ts");

const T = "acme";
const me = "user:u1";
const them = "user:u2";

test("saved, listed newest first, searched, read and deleted by its owner only", async () => {
  const a = await c.saveConversation(T, { workspace: "desk", owner: me, messages: [{ role: "user", content: "make a weekly flow" }, { role: "assistant", content: "Proposed flows/weekly.md" }], files: [] });
  await new Promise((r) => setTimeout(r, 5));
  const b = await c.saveConversation(T, {
    workspace: "ads",
    owner: me,
    messages: [{ role: "user", content: "how does when: rows of work?" }],
    files: [{ path: "flows/x.md", content: "x", before: null, sha256: null }],
  });
  await c.saveConversation(T, { workspace: "desk", owner: them, messages: [{ role: "user", content: "theirs: a weekly flow" }], files: [] });

  const mine = await c.listConversations(T, me);
  assert.deepEqual(mine.map((x) => x.id), [b, a], "newest first, only mine");
  assert.equal(mine[0].title, "how does when: rows of work?");
  assert.equal(mine[0].unsaved, 1);
  assert.deepEqual((await c.listConversations(T, me, { workspace: "desk" })).map((x) => x.id), [a]);
  assert.deepEqual((await c.listConversations(T, me, { q: "WEEKLY" })).map((x) => x.id), [a], "case-insensitive, title or text");
  assert.deepEqual((await c.listConversations(T, me, { q: "flows/weekly" })).map((x) => x.id), [a], "matches the replies too");

  assert.equal((await c.getConversation(T, them, a)), null, "not someone else's");
  assert.equal((await c.getConversation(T, me, a))?.messages.length, 2);
  assert.equal(await c.deleteConversation(T, them, a), false);
  assert.equal(await c.deleteConversation(T, me, a), true);
  assert.equal(await c.getConversation(T, me, a), null);
});

test("saving under an id updates it; someone else's id is never written over", async () => {
  const id = await c.saveConversation(T, { workspace: "desk", owner: me, messages: [{ role: "user", content: "first" }], files: [] });
  await c.saveConversation(T, { id, workspace: "desk", owner: me, messages: [{ role: "user", content: "first" }, { role: "assistant", content: "second" }], files: [] });
  assert.equal((await c.getConversation(T, me, id))?.messages.length, 2);
  await c.saveConversation(T, { id, workspace: "desk", owner: them, messages: [{ role: "user", content: "hijack" }], files: [] });
  assert.equal((await c.getConversation(T, me, id))?.messages[0].content, "first");
  assert.equal(await c.getConversation(T, me, "../../etc/passwd"), null, "an id is a shape, not a path");
});

test("titles are the first question on one line", () => {
  assert.equal(c.titleOf([{ role: "user", content: "  a\n b " }]), "a b");
  assert.equal(c.titleOf([]), "(empty)");
});
