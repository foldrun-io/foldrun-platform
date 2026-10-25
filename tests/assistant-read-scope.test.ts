// The assistant reads only the asking account's files: a link inside a
// workspace — at the end of the path or anywhere on the way — never leads
// it into another account.
//
//   node --test tests/assistant-read-scope.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-assistant-read-"));
delete process.env.FOLDRUN_DATABASE_URL;

const { workspaceDir } = await import("../../foldrun-core/src/store.ts");
const { readReadable } = await import("../src/assistant/engine.ts");

test("a workspace's own files read; a link to another account's does not", () => {
  const mine = workspaceDir("acme", "desk");
  const theirs = workspaceDir("rival", "desk");
  fs.mkdirSync(path.join(mine, "knowledge"), { recursive: true });
  fs.mkdirSync(path.join(theirs, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(mine, "knowledge", "own.md"), "ours");
  fs.writeFileSync(path.join(theirs, "knowledge", "secret.md"), "theirs");
  fs.symlinkSync(path.join(theirs, "knowledge"), path.join(mine, "knowledge", "linked-dir"));
  fs.symlinkSync(path.join(theirs, "knowledge", "secret.md"), path.join(mine, "knowledge", "linked.md"));

  assert.equal(readReadable("acme", "desk", "knowledge/own.md"), "ours");
  assert.equal(readReadable("acme", "desk", "knowledge/linked.md"), null);
  assert.equal(readReadable("acme", "desk", "knowledge/linked-dir/secret.md"), null);
  assert.equal(readReadable("acme", "desk", "../../rival/workspaces/desk/knowledge/secret.md"), null);
  assert.equal(readReadable("acme", "other", "knowledge/own.md"), null);
});

test("a model address outside the assistant's allowed hosts is named, not dialled", async () => {
  const { unreachableModelHost } = await import("../src/assistant/engine.ts");
  const hosts = "api.anthropic.com";
  assert.equal(unreachableModelHost({}, hosts), null);
  assert.equal(unreachableModelHost({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" }, hosts), null);
  assert.equal(unreachableModelHost({ ANTHROPIC_BASE_URL: "https://gateway.example.com/v1" }, hosts), "gateway.example.com");
  assert.equal(unreachableModelHost({ ANTHROPIC_BASE_URL: "https://gateway.example.com/v1" }, ""), null);
  assert.equal(unreachableModelHost({ ANTHROPIC_BASE_URL: "https://gateway.example.com/v1" }, undefined), null);
});
