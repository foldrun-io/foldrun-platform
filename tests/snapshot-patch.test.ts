// The snapshot patch script (Part B3), run for real in the runner image:
// what the step changed comes back as a patch that `git apply` reproduces;
// .git and ignored build output stay out; a link refuses it; CRLF and
// binary survive. Skipped where there is no docker or no runner image.
//
//   node --test tests/snapshot-patch.test.ts      (FOLDRUN_TEST_RUNNER_IMAGE to pick the image)

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { packSnapshot } from "../../foldrun-core/src/snapshot-archive.ts";
import { SNAPSHOT_PATCH_SH, parseNameStatus, placeSnapshotPatch } from "../src/snapshot-patch.ts";

const IMAGE = process.env.FOLDRUN_TEST_RUNNER_IMAGE ?? "foldrun-runner:ca1c9ecc97ea";
const docker = spawnSync("docker", ["image", "inspect", IMAGE], { encoding: "utf8" });
const skip = docker.status !== 0 ? `no docker image ${IMAGE}` : false;

const f = (p: string, text: string | Buffer, mode = 0o644) => ({ path: p, mode, content: Buffer.isBuffer(text) ? text : Buffer.from(text) });
const BASE = [
  f(".gitignore", "dist/\n"),
  f("a.txt", "one\ntwo\n"),
  f("del.txt", "going\n"),
  f("crlf.txt", "line\r\n"),
  f("img.bin", Buffer.from([0, 1, 2, 3, 255])),
  f("run.sh", "#!/bin/sh\n", 0o755),
];

function tree(root: string, files: Record<string, string | Buffer>) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
}

// Under the home folder: a docker VM (colima, Docker Desktop) shares that,
// and not the system temp folder.
const SHARED = path.join(os.homedir(), ".cache", "foldrun-tests");
function runScript(setup: (snap: string) => void): { status: number | null; out: string; dir: string } {
  fs.mkdirSync(SHARED, { recursive: true });
  const dir = fs.mkdtempSync(path.join(SHARED, "snappatch-"));
  const snap = path.join(dir, "ws/agents/coder/snapshot");
  fs.mkdirSync(snap, { recursive: true });
  for (const e of BASE) {
    fs.writeFileSync(path.join(snap, e.path), e.content, { mode: e.mode });
  }
  setup(snap);
  const base = packSnapshot(BASE).archive.toString("base64");
  // The patch is read out as the worker would (a copy): the script leaves its
  // folder root's and 0700, as in the pod.
  const r = spawnSync("docker", ["run", "-i", "--rm", "--network", "none", "--entrypoint", "sh", "-v", `${dir}:/t`, IMAGE, "-c", `${SNAPSHOT_PATCH_SH}\ncp /t/out/snapshot.patch /t/patch && cp /t/out/names /t/names && chmod 644 /t/patch /t/names`, "sh", "agents/coder", "/t/ws", "/t/out"], { input: base, encoding: "utf8" });
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? ""), dir };
}

test("the patch is what changed, and git apply on the original reproduces it", { skip }, () => {
  const r = runScript((snap) => {
    tree(snap, { "a.txt": "one\nTWO\n", "new/file.ts": "export {};\n", "crlf.txt": "line\r\nmore\r\n", "img.bin": Buffer.from([9, 9, 0, 9]) });
    fs.rmSync(path.join(snap, "del.txt"));
    tree(snap, { "dist/out.js": "built", ".git/config": "[core]\n", "sub/.git/HEAD": "x" });
  });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /FOLDRUN_SNAPSHOT_OK \d+/);
  const patch = fs.readFileSync(path.join(r.dir, "patch"));
  const s = parseNameStatus(fs.readFileSync(path.join(r.dir, "names")));
  assert.deepEqual(s.added, ["new/file.ts"]);
  assert.deepEqual(s.deleted, ["del.txt"]);
  assert.deepEqual(s.modified.sort(), ["a.txt", "crlf.txt", "img.bin"]);
  assert.ok(!patch.toString("utf8").includes("dist/out.js"), "ignored build output is not in the patch");
  assert.ok(!patch.toString("utf8").includes(".git/"), "no .git");

  // Apply it to a fresh copy of the original, as the person would.
  const apply = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-snapapply-"));
  for (const e of BASE) fs.writeFileSync(path.join(apply, e.path), e.content, { mode: e.mode });
  spawnSync("git", ["init", "-q"], { cwd: apply });
  const ok = spawnSync("git", ["apply", "--binary", "-"], { cwd: apply, input: patch });
  assert.equal(ok.status, 0, String(ok.stderr));
  assert.equal(fs.readFileSync(path.join(apply, "a.txt"), "utf8"), "one\nTWO\n");
  assert.equal(fs.readFileSync(path.join(apply, "crlf.txt"), "utf8"), "line\r\nmore\r\n", "CRLF kept");
  assert.deepEqual([...fs.readFileSync(path.join(apply, "img.bin"))], [9, 9, 0, 9], "binary reconstructed");
  assert.equal(fs.existsSync(path.join(apply, "del.txt")), false);
  assert.equal(fs.readFileSync(path.join(apply, "new/file.ts"), "utf8"), "export {};\n");
});

test("nothing changed is an empty patch; a link in snapshot/ refuses it", { skip }, () => {
  const same = runScript(() => {});
  assert.match(same.out, /FOLDRUN_SNAPSHOT_OK 0\b/);
  const linked = runScript((snap) => fs.symlinkSync("/etc/passwd", path.join(snap, "leak.txt")));
  assert.match(linked.out, /FOLDRUN_SNAPSHOT_REFUSED links or special files in snapshot\/: leak\.txt/);
});

test("placing: over whatever the agent named snapshot.patch; no patch says why, never an empty one", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-snapplace-"));
  fs.mkdirSync(path.join(out, "agents/coder/outputs"), { recursive: true });
  fs.writeFileSync(path.join(out, "agents/coder/outputs/snapshot.patch"), "the agent's own, fake");
  const line = placeSnapshotPatch(out, "agents/coder", { ok: false, reason: "pod gone" });
  assert.equal(line.ok, false);
  const marker = fs.readFileSync(path.join(out, "agents/coder/outputs/snapshot.patch"), "utf8");
  assert.match(marker, /^# foldrun: no patch for this run — pod gone/, "the agent's fake is replaced by a marker");
  const tryIt = spawnSync("git", ["apply", "--check", "-"], { input: marker, encoding: "utf8" });
  assert.notEqual(tryIt.status, 0, "git apply refuses the marker");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, "agents/coder/outputs/snapshot.json"), "utf8")), { status: "unavailable", reason: "pod gone" });
  const file = path.join(out, "p");
  fs.writeFileSync(file, "diff --git a/x b/x\nnew file mode 100644\n");
  const ok = placeSnapshotPatch(out, "agents/coder", { ok: true, file, bytes: 40, summary: { added: ["x"], modified: [], deleted: [] } });
  assert.match(ok.text, /1 added/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, "agents/coder/outputs/snapshot.json"), "utf8")).status, "changed");
});

test("the folder's .gitattributes cannot rewrite bytes; a quoted name is listed; snapshot/ swapped for a link refuses it (Codex)", { skip }, () => {
  const extra = [f(".gitattributes", "* text eol=lf\n"), f("win.txt", "a\r\nb\r\n"), f('we"ird.txt', "q\n")];
  BASE.push(...extra);
  try {
    const r = runScript((snap) => tree(snap, { "win.txt": "a\r\nB\r\n", 'we"ird.txt': "Q\n" }));
    assert.equal(r.status, 0, r.out);
    const s = parseNameStatus(fs.readFileSync(path.join(r.dir, "names")));
    assert.deepEqual(s.modified.sort(), ["we\"ird.txt", "win.txt"]);
    const patch = fs.readFileSync(path.join(r.dir, "patch"));
    const apply = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-snapapply2-"));
    for (const e of BASE) fs.writeFileSync(path.join(apply, e.path), e.content, { mode: e.mode });
    spawnSync("git", ["init", "-q"], { cwd: apply });
    const ok = spawnSync("git", ["apply", "--binary", "-"], { cwd: apply, input: patch });
    assert.equal(ok.status, 0, String(ok.stderr));
    assert.equal(fs.readFileSync(path.join(apply, "win.txt"), "utf8"), "a\r\nB\r\n", "CRLF kept despite eol=lf");
  } finally {
    BASE.splice(BASE.length - extra.length, extra.length);
  }
  const swapped = runScript((snap) => {
    fs.rmSync(snap, { recursive: true });
    fs.symlinkSync("/etc", snap);
  });
  assert.match(swapped.out, /FOLDRUN_SNAPSHOT_REFUSED snapshot\/ is not a plain folder/);
});

test("outputs/ swapped for a file by the agent: the patch is still placed (Codex)", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-snapplace2-"));
  fs.mkdirSync(path.join(out, "agents/coder"), { recursive: true });
  fs.writeFileSync(path.join(out, "agents/coder/outputs"), "not a folder");
  const line = placeSnapshotPatch(out, "agents/coder", { ok: false, reason: "x" });
  assert.equal(line.ok, false);
  assert.ok(fs.statSync(path.join(out, "agents/coder/outputs")).isDirectory());
  assert.ok(fs.existsSync(path.join(out, "agents/coder/outputs/snapshot.json")));
});
