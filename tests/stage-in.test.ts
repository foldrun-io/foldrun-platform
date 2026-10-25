import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { stageInArgs, unpackIntoPod } from "../src/run-k8s.ts";

test("a fresh step stages in with ONE exec, no kubectl cp", () => {
  const { create, exec } = stageInArgs("/stg", "foldrun-runs", "pod-x");
  // One tar create, naming the three roots that cover all six inputs.
  assert.deepEqual(create, ["c", "-C", "/stg", "workspace", "library", "opt"]);
  // One exec, streamed in (-i), unpacking with tar — never cp.
  assert.equal(exec[0], "exec");
  assert.ok(exec.includes("-i"), "the archive is streamed to the pod");
  const dd = exec.indexOf("--");
  assert.deepEqual(exec.slice(dd + 1, dd + 3), ["sh", "-c"], "a single shell command");
  const payload = exec[dd + 3];
  assert.match(payload, /^tar x --no-same-owner --no-overwrite-dir -C \//, "unpack at the pod root, leaving the image's own dirs as they are");
  assert.match(payload, /mtimes\.json \/workspace/, "mtimes reapplied in the same exec");
  assert.ok(!exec.includes("cp") && !payload.includes("cp "), "no cp anywhere in the stage-in");
});

test("the one tar carries all six inputs, with the workspace's real mtimes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-stagein-"));
  const staging = path.join(dir, "staging");
  const cap = path.join(dir, "cap"); // stands in for the pod's root
  const log = path.join(dir, "kubectl.log");
  fs.mkdirSync(path.join(staging, "workspace"), { recursive: true });
  fs.mkdirSync(path.join(staging, "library", "scripts"), { recursive: true });
  const jobIn = path.join(staging, "opt", "runner", "job");
  fs.mkdirSync(jobIn, { recursive: true });
  fs.mkdirSync(cap, { recursive: true });

  const wsFile = path.join(staging, "workspace", "hello.txt");
  fs.writeFileSync(wsFile, "hi");
  const old = new Date("2026-09-13T00:00:00Z"); // the stale-freshness date from mtimeManifest's note
  fs.utimesSync(wsFile, old, old);
  fs.writeFileSync(path.join(staging, "library", "scripts", "x.mjs"), "export default 1");
  for (const f of ["input.json", "in.json", "mtimes.json"]) fs.writeFileSync(path.join(jobIn, f), "{}");
  fs.writeFileSync(path.join(jobIn, "env.sh"), "export A=1\n", { mode: 0o600 });

  // A kubectl that records which verbs it was called with and, on exec,
  // untars the streamed archive into `cap` — the pod's root stands in.
  const fake = path.join(dir, "kubectl");
  fs.writeFileSync(
    fake,
    `#!/bin/sh\necho "$1" >> "$KLOG"\ncase "$1" in\n  exec) tar x -C "$KCAP" ;;\n  cp) echo cp-used >> "$KLOG"; exit 1 ;;\nesac\n`,
    { mode: 0o755 },
  );
  const prev = { k: process.env.FOLDRUN_KUBECTL, c: process.env.KCAP, l: process.env.KLOG };
  Object.assign(process.env, { FOLDRUN_KUBECTL: fake, KCAP: cap, KLOG: log });
  try {
    const { create, exec } = stageInArgs(staging, "foldrun-runs", "pod-x");
    const r = await unpackIntoPod(create, exec);
    assert.equal(r.status, 0, r.out);

    const verbs = fs.readFileSync(log, "utf8").trim().split("\n");
    assert.deepEqual(verbs, ["exec"], "exactly one kubectl call, and it is the exec — never cp");

    const landed = fs
      .readdirSync(cap, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => path.relative(cap, path.join(d.parentPath ?? (d as unknown as { path: string }).path, d.name)))
      .sort();
    assert.deepEqual(landed, [
      "library/scripts/x.mjs",
      "opt/runner/job/env.sh",
      "opt/runner/job/in.json",
      "opt/runner/job/input.json",
      "opt/runner/job/mtimes.json",
      "workspace/hello.txt",
    ]);

    const mt = fs.statSync(path.join(cap, "workspace", "hello.txt")).mtime;
    assert.ok(Math.abs(mt.getTime() - old.getTime()) < 1000, `mtime carried: ${mt.toISOString()}`);
    assert.equal(fs.statSync(path.join(cap, "opt/runner/job/env.sh")).mode & 0o077, 0, "env.sh stays owner-only");
  } finally {
    prev.k === undefined ? delete process.env.FOLDRUN_KUBECTL : (process.env.FOLDRUN_KUBECTL = prev.k);
    prev.c === undefined ? delete process.env.KCAP : (process.env.KCAP = prev.c);
    prev.l === undefined ? delete process.env.KLOG : (process.env.KLOG = prev.l);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A staging dir holding the three roots, plus a stub kubectl from `script`. */
function rig(script: string, bigBytes = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-stagein-"));
  const staging = path.join(dir, "staging");
  for (const d of ["workspace", "library", "opt/runner/job"]) fs.mkdirSync(path.join(staging, d), { recursive: true });
  fs.writeFileSync(path.join(staging, "workspace", "big.bin"), Buffer.alloc(bigBytes, 7));
  const fake = path.join(dir, "kubectl");
  fs.writeFileSync(fake, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const prev = process.env.FOLDRUN_KUBECTL;
  process.env.FOLDRUN_KUBECTL = fake;
  return {
    staging,
    done() {
      prev === undefined ? delete process.env.FOLDRUN_KUBECTL : (process.env.FOLDRUN_KUBECTL = prev);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a kubectl that dies mid-stream fails the step, not the worker, and stops the tar", async () => {
  // 32 MB is far past a pipe buffer, so tar is still writing when kubectl
  // exits without reading: the write fails with EPIPE. Unhandled, that was
  // an uncaught error that ended the process (reproduced 18 Oct 2026).
  const r = rig(`echo "error: pod not found" >&2; exit 1`, 32 * 1024 * 1024);
  const uncaught: unknown[] = [];
  const onUncaught = (e: unknown) => uncaught.push(e);
  process.on("uncaughtException", onUncaught);
  try {
    const { create, exec } = stageInArgs(r.staging, "foldrun-runs", "pod-x");
    const res = await unpackIntoPod(create, exec, 20_000);
    assert.notEqual(res.status, 0);
    assert.match(res.out, /pod not found/);
    assert.doesNotMatch(res.out, /gave no answer/, "settled without waiting for the timeout — the tar was stopped");
    await new Promise((ok) => setTimeout(ok, 50));
    assert.deepEqual(uncaught, []);
  } finally {
    process.off("uncaughtException", onUncaught);
    r.done();
  }
});

test("a tar create that fails counts, even when the unpack exits 0", async () => {
  // The unpack drains whatever arrives and succeeds; the create names a
  // member that is not there, so tar exits non-zero after writing the rest.
  const r = rig(`cat > /dev/null; exit 0`);
  try {
    const { create, exec } = stageInArgs(r.staging, "foldrun-runs", "pod-x");
    const res = await unpackIntoPod([...create, "missing"], exec, 20_000);
    assert.notEqual(res.status, 0, res.out);
    assert.match(res.out, /^tar: .*missing/s);
  } finally {
    r.done();
  }
});

const gnuTar = /GNU tar/.test(spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout ?? "");

test("the unpack leaves dirs the pod already has as they were, whatever the worker's umask", { skip: !gnuTar && "needs GNU tar, as the pod has" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-stagein-"));
  const staging = path.join(dir, "staging");
  const root = path.join(dir, "root"); // the pod's / stands in
  fs.mkdirSync(path.join(root, "opt", "runner"), { recursive: true });
  fs.chmodSync(path.join(root, "opt"), 0o755);
  fs.chmodSync(path.join(root, "opt", "runner"), 0o755);
  const was = process.umask(0o077);
  try {
    for (const d of ["workspace", "library", "opt/runner/job"]) fs.mkdirSync(path.join(staging, d), { recursive: true });
  } finally {
    process.umask(was);
  }
  fs.writeFileSync(path.join(staging, "opt/runner/job/input.json"), "{}");
  try {
    const { create, exec } = stageInArgs(staging, "ns", "pod");
    const unpack = exec[exec.indexOf("--") + 3].split(" && ")[0].replace("-C /", `-C ${root}`);
    const archive = spawnSync("tar", create);
    assert.equal(archive.status, 0, String(archive.stderr));
    const x = spawnSync("sh", ["-c", unpack], { input: archive.stdout });
    assert.equal(x.status, 0, String(x.stderr));
    assert.equal(fs.statSync(path.join(root, "opt")).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(root, "opt", "runner")).mode & 0o777, 0o755);
    assert.ok(fs.existsSync(path.join(root, "opt/runner/job/input.json")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
