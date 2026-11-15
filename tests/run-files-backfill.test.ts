// The run-files backfill without a database: files for records, the core fs
// blob store and local output records as the stores (FOL-126, review M4/M5).
// What it must never do: say "done" for bytes it has not compared, skip a
// file or a folder without saying so, or touch the volume / the store in
// verify mode.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-bfv-"));
process.env.FOLDRUN_DATA = data;
delete process.env.FOLDRUN_DATABASE_URL;
const { fsBlobStore } = await import("../../foldrun-core/src/blob-store.ts");
const { localRunOutputStore, setRunOutputsBackend, listRunOutputs } = await import("../../foldrun-core/src/run-outputs.ts");
const { workspaceDir } = await import("../../foldrun-core/src/store.ts");
const { backfillRunFiles } = await import("../src/run-files-backfill.ts");
const { blobObjectKey, sha256Hex } = await import("../../foldrun-core/src/manifest.ts");

const blobs = fsBlobStore(path.join(data, ".objects-test"));
setRunOutputsBackend({ blobs, store: localRunOutputStore(path.join(data, ".records-test")), enabled: () => true, fileMaxBytes: () => 0, runMaxBytes: () => 0 });
after(() => {
  setRunOutputsBackend(null);
  fs.rmSync(data, { recursive: true, force: true });
});

let n = 0;
function workspace() {
  const T = `bv${Date.now().toString(36)}${n++}`;
  const root = workspaceDir(T, "desk");
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "---\nname: desk\n---\n");
  const out = (run: string, agent: string) => {
    const d = path.join(root, "runs", run, "outputs", agent);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  return { T, root, out };
}

test("verify: a stored file whose bytes differ from the volume's is reported, and nothing is written or deleted", async () => {
  const { T, out } = workspace();
  const d = out("run-1", "writer");
  fs.writeFileSync(path.join(d, "a.md"), "the draft\n");
  fs.writeFileSync(path.join(d, "b.md"), "second\n");
  assert.equal((await backfillRunFiles({ write: true, tenants: [T] })).outputs.copied, 1);
  // The volume copy changes after the copy (or the store was wrong): names still match.
  fs.writeFileSync(path.join(d, "a.md"), "THE DRAFT\n");
  const plain = await backfillRunFiles({ write: false, tenants: [T] });
  assert.equal(plain.outputs.present, 1, "the name-only check still calls it present");
  const before = (await listRunOutputs(T, "desk", "run-1")).length;
  const v = await backfillRunFiles({ write: false, verify: true, tenants: [T] });
  assert.deepEqual([v.verify?.checked, v.verify?.ok, v.verify?.mismatched], [2, 1, 1]);
  assert.match(v.verify!.problems[0], /run-1\/writer\/a\.md.*differ/);
  assert.ok(v.outputs.failed > 0, "a mismatch fails the run of the script");
  assert.equal(fs.readFileSync(path.join(d, "a.md"), "utf8"), "THE DRAFT\n", "the volume is untouched");
  assert.equal((await listRunOutputs(T, "desk", "run-1")).length, before, "the store is untouched");
  await assert.rejects(backfillRunFiles({ write: true, verify: true, tenants: [T] }), /verify/);
});

test("verify: a file the store lacks, and a blob that is gone, are named; matching ones pass", async () => {
  const { T, out } = workspace();
  const d = out("run-2", "writer");
  fs.writeFileSync(path.join(d, "a.md"), "alpha\n");
  fs.writeFileSync(path.join(d, "b.md"), "bravo\n");
  await backfillRunFiles({ write: true, tenants: [T] });
  fs.writeFileSync(path.join(d, "c.md"), "charlie\n"); // never copied
  fs.rmSync(path.join(data, ".objects-test", ...blobObjectKey(T, sha256Hex("bravo\n")).split("/")));
  const v = await backfillRunFiles({ write: false, verify: true, tenants: [T] });
  assert.deepEqual([v.verify?.checked, v.verify?.ok, v.verify?.missing, v.verify?.blobMissing], [3, 1, 1, 1]);
  assert.ok(v.verify!.problems.some((p) => /c\.md.*not in the store/.test(p)));
  assert.ok(v.verify!.problems.some((p) => /b\.md.*blob/.test(p)));
});

test("skipped runs, agents, calls and refused files are counted and named, not dropped", async () => {
  const { T, root, out } = workspace();
  const good = out("run-3", "writer");
  fs.writeFileSync(path.join(good, "ok.md"), "ok\n");
  fs.writeFileSync(path.join(good, "café.md"), "decomposed name\n"); // not NFC: refused
  fs.mkdirSync(path.join(root, "runs", "bad run!", "outputs"), { recursive: true }); // fails SAFE
  fs.writeFileSync(path.join(root, "runs", "stray.txt"), "not a run\n");
  fs.mkdirSync(path.join(root, "runs", "run-3", "outputs", "bad agent!"), { recursive: true });
  fs.mkdirSync(path.join(root, "runs", "run-3", "calls"), { recursive: true });
  fs.writeFileSync(path.join(root, "runs", "run-3", "calls", "notes.txt"), "x");
  const r = await backfillRunFiles({ write: true, tenants: [T] });
  assert.deepEqual([r.skipped.runs, r.skipped.agents, r.skipped.calls, r.outputs.refused], [2, 1, 1, 1]);
  for (const name of ["bad run!", "stray.txt", "bad agent!", "notes.txt"]) assert.ok(r.skipped.names.some((x) => x.includes(name)), name);
  assert.ok(r.outputs.failed > 0 && r.failures.some((f) => /refused/.test(f)));
});
