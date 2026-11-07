// A run's stage-in from the revision head (FOL-126 phase 3b), and the two
// settings that switch the revisions on.
//
//   node --test tests/stage-from-head.test.ts

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { stageFromHead } from "../src/stage-from-head.ts";
import { settingDef, validateSettingChanges } from "../src/settings.ts";
import { setRevisionBackend, resetJournalForTests, flushRevisions } from "../../foldrun-core/src/workspace-revisions.ts";
import { writeWorkspaceFile, workspaceDir } from "../../foldrun-core/src/store.ts";
import { fsBlobStore, bounded } from "../../foldrun-core/src/blob-store.ts";
import { localRevisionStore } from "../../foldrun-core/src/revision-store.ts";
import { isPlatformPath } from "../../foldrun-core/src/store.ts";

const T = "acme";
const W = "desk";
let root: string;
let out: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-stage-"));
  out = path.join(root, "staging");
  process.env.FOLDRUN_DATA = path.join(root, "data");
  fs.mkdirSync(path.join(workspaceDir(T, W), "agents"), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir(T, W), "AGENTS.md"), "---\nname: desk\n---\n");
});
afterEach(() => {
  setRevisionBackend(null);
  resetJournalForTests();
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.FOLDRUN_DATA;
});

const backend = () => ({ blobs: bounded(fsBlobStore(path.join(root, "objects")), { backoffMs: 1 }), revisions: localRevisionStore(path.join(root, "revs")) });

test("both settings are registered, off by default, and booleans", () => {
  for (const key of ["revisions.journal", "revisions.read"]) {
    const def = settingDef(key)!;
    assert.ok(def, key);
    assert.equal(def.type, "boolean");
    assert.equal(def.default, false);
    assert.equal(def.confirm, "on");
  }
  assert.equal(settingDef("revisions.journal")!.env, "FOLDRUN_REVISIONS");
  assert.equal(validateSettingChanges({ "revisions.journal": true }).ok, true);
  assert.equal(validateSettingChanges({ "revisions.journal": "yes" }).ok, false);
});

test("with reads off the caller copies the folder: stageFromHead answers false and writes nothing", async () => {
  setRevisionBackend(backend(), { journal: () => true, read: () => false });
  writeWorkspaceFile(T, W, "memory/a.md", "a\n", { by: "u" });
  await flushRevisions();
  assert.equal(await stageFromHead(T, W, workspaceDir(T, W), out, isPlatformPath), false);
  assert.equal(fs.existsSync(out), false);
});

test("with reads on the files come from the head, and what the head does not hold comes from the folder", async () => {
  setRevisionBackend(backend(), { journal: () => true, read: () => true });
  writeWorkspaceFile(T, W, "memory/a.md", "head\n", { by: "u" });
  await flushRevisions();
  // the folder moves behind the head; a binary file the head never held
  fs.writeFileSync(path.join(workspaceDir(T, W), "memory", "a.md"), "folder\n");
  fs.writeFileSync(path.join(workspaceDir(T, W), "logo.bin"), Buffer.from([0, 1, 2, 255]));
  assert.equal(await stageFromHead(T, W, workspaceDir(T, W), out, isPlatformPath), true);
  assert.equal(fs.readFileSync(path.join(out, "memory", "a.md"), "utf8"), "head\n");
  assert.deepEqual([...fs.readFileSync(path.join(out, "logo.bin"))], [0, 1, 2, 255]);
  assert.equal(fs.readFileSync(path.join(out, "AGENTS.md"), "utf8"), "---\nname: desk\n---\n");
});

test("a head that cannot give every blob falls back to the folder (nothing staged by the head)", async () => {
  setRevisionBackend(backend(), { journal: () => true, read: () => true });
  writeWorkspaceFile(T, W, "memory/a.md", "head\n", { by: "u" });
  await flushRevisions();
  fs.rmSync(path.join(root, "objects"), { recursive: true, force: true });
  assert.equal(await stageFromHead(T, W, workspaceDir(T, W), out, isPlatformPath), false);
});

test("a workspace with no head yet is staged from the folder", async () => {
  setRevisionBackend(backend(), { journal: () => true, read: () => true });
  assert.equal(await stageFromHead(T, W, workspaceDir(T, W), out, isPlatformPath), false);
});
