// An account folder on a mirror pod is removed when the database does not list
// its account (tenant_keys) — but never one that still has revision heads or
// journal entries, or changes queued in this process: a missing key row must
// not cost an account its unpublished local state (FOL-126 follow-up M3).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeStaleAccountFolders } from "../src/boot.ts";
import { setRevisionBackend, resetJournalForTests } from "../../foldrun-core/src/workspace-revisions.ts";
import type { JournalStore } from "../../foldrun-core/src/journal-store.ts";

let root: string;
let heads: { tenant: string; workspace: string }[];
let journal: { tenant: string; workspace: string }[];
let headsFail = false;
let journalFail = false;

const OLD = new Date(Date.now() - 60 * 60_000);
function account(name: string, old = true): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "workspaces"), { recursive: true });
  if (old) fs.utimesSync(dir, OLD, OLD);
  return dir;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-sweep-"));
  process.env.FOLDRUN_DATA = root;
  heads = [];
  journal = [];
  headsFail = false;
  journalFail = false;
  const store = {
    kind: "pg",
    async allHeads() {
      if (headsFail) throw new Error("store down");
      return heads.map((h) => ({ ...h, workspaceHead: "r1", stateHead: null }));
    },
  };
  const js = {
    kind: "test",
    workspaces() {
      if (journalFail) throw new Error("journal down");
      return journal;
    },
    entries: () => [],
    put: () => "",
    remove() {},
    read: () => {
      throw new Error("none");
    },
    setAside() {},
    sweep() {},
    drop() {},
    move() {},
  } as unknown as JournalStore;
  setRevisionBackend({ blobs: {} as never, revisions: store as never, pins: {} as never }, { journal: () => true, read: () => true, journalStore: js });
});
afterEach(() => {
  setRevisionBackend(null);
  resetJournalForTests();
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.FOLDRUN_DATA;
});

test("an old folder of an unlisted account with neither heads nor journal is removed", async () => {
  const dir = account("gone");
  await removeStaleAccountFolders(new Set(["kept"]));
  assert.equal(fs.existsSync(dir), false);
});

test("an unlisted account that still has a head is kept", async () => {
  const dir = account("legacy");
  heads = [{ tenant: "legacy", workspace: "desk" }];
  await removeStaleAccountFolders(new Set(["kept"]));
  assert.equal(fs.existsSync(dir), true);
});

test("an unlisted account with a journal entry is kept", async () => {
  const dir = account("pending");
  journal = [{ tenant: "pending", workspace: "desk" }];
  await removeStaleAccountFolders(new Set(["kept"]));
  assert.equal(fs.existsSync(dir), true);
});

test("an unlisted account with changes queued in this process is kept", async () => {
  const dir = account("queued");
  const store = await import("../../foldrun-core/src/store.ts");
  fs.mkdirSync(path.join(dir, "workspaces", "desk"), { recursive: true });
  fs.writeFileSync(path.join(dir, "workspaces", "desk", "AGENTS.md"), "---\nname: desk\n---\n");
  store.writeWorkspaceFile("queued", "desk", "memory/a.md", "x\n", { by: "t", message: "m" });
  const wr = await import("../../foldrun-core/src/workspace-revisions.ts");
  assert.ok(wr.pendingRevisions() > 0, "the write is queued");
  await removeStaleAccountFolders(new Set(["kept"]));
  assert.equal(fs.existsSync(dir), true);
});

test("when the heads cannot be read nothing is removed", async () => {
  const dir = account("gone");
  headsFail = true;
  await assert.rejects(() => removeStaleAccountFolders(new Set(["kept"])));
  assert.equal(fs.existsSync(dir), true);
});

test("when the journal cannot be read nothing is removed", async () => {
  const dir = account("gone");
  journalFail = true;
  await assert.rejects(() => removeStaleAccountFolders(new Set(["kept"])));
  assert.equal(fs.existsSync(dir), true);
});

test("the existing guards stay: a young folder is kept, and a folder without workspaces/ is left alone", async () => {
  const young = account("young", false);
  const other = path.join(root, "other");
  fs.mkdirSync(other);
  fs.utimesSync(other, OLD, OLD);
  await removeStaleAccountFolders(new Set(["kept"]));
  assert.equal(fs.existsSync(young), true);
  assert.equal(fs.existsSync(other), true);
});
