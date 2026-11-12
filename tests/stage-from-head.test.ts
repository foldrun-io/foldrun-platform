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
import { setRevisionBackend, resetJournalForTests, flushRevisions, readAtHead } from "../../foldrun-core/src/workspace-revisions.ts";
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

test("with reads on, a file comes from the head where it agrees with the folder; where it does not the folder wins and the head is repaired", async () => {
  setRevisionBackend(backend(), { journal: () => true, read: () => true });
  writeWorkspaceFile(T, W, "memory/a.md", "head\n", { by: "u" });
  writeWorkspaceFile(T, W, "memory/gone.md", "gone\n", { by: "u" });
  writeWorkspaceFile(T, W, "memory/same.md", "same\n", { by: "u" });
  await flushRevisions();
  // the folder moves without the journal: one file changes, one is deleted;
  // and a file the head never held
  fs.writeFileSync(path.join(workspaceDir(T, W), "memory", "a.md"), "folder\n");
  fs.rmSync(path.join(workspaceDir(T, W), "memory", "gone.md"));
  fs.writeFileSync(path.join(workspaceDir(T, W), "logo.bin"), Buffer.from([0, 1, 2, 255]));
  assert.equal(await stageFromHead(T, W, workspaceDir(T, W), out, isPlatformPath), true);
  assert.equal(fs.readFileSync(path.join(out, "memory", "a.md"), "utf8"), "folder\n", "the folder is the working copy");
  assert.equal(fs.existsSync(path.join(out, "memory", "gone.md")), false, "a file deleted from the folder is not handed to the step");
  assert.equal(fs.readFileSync(path.join(out, "memory", "same.md"), "utf8"), "same\n");
  assert.deepEqual([...fs.readFileSync(path.join(out, "logo.bin"))], [0, 1, 2, 255]);
  assert.equal(fs.readFileSync(path.join(out, "AGENTS.md"), "utf8"), "---\nname: desk\n---\n");
  // the difference asked for a repair: the head now says what the folder does
  await flushRevisions({ tenant: T, workspace: W });
  assert.equal((await readAtHead(T, W, "memory/a.md"))?.toString(), "folder\n");
  assert.equal(await readAtHead(T, W, "memory/gone.md"), null);
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
