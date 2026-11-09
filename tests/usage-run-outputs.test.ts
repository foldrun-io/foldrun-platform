// FOL-126 phase 5: the usage statement's storage line for a workspace's run
// history counts what its runs published to the object store, which is no
// longer under runs/ on the volume.
//
//   node --test tests/usage-run-outputs.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fsBlobStore } from "../../foldrun-core/src/blob-store.ts";
import { localRunOutputStore, publishRunOutputs, setRunOutputsBackend } from "../../foldrun-core/src/run-outputs.ts";

test("runsBytes counts the bytes published to the store, and drops them with the run", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-usage-ro-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    const { accountUsage } = await import("../src/usage.ts");
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    const before = (await accountUsage("acme")).workspaces.find((w) => w.workspace === "desk")!.storage.runsBytes;
    const be = { blobs: fsBlobStore(path.join(root, ".objects")), store: localRunOutputStore(path.join(root, ".run-outputs")), enabled: () => true, fileMaxBytes: () => 0, runMaxBytes: () => 0 };
    setRunOutputsBackend(be);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-usage-out-"));
    fs.writeFileSync(path.join(out, "big.bin"), "x".repeat(4096));
    await publishRunOutputs(be, "acme", "desk", "run-1", "writer", out);
    const after = (await accountUsage("acme")).workspaces.find((w) => w.workspace === "desk")!.storage.runsBytes;
    assert.equal(after - before, 4096);
    await be.store.drop({ tenant: "acme", workspace: "desk", runId: "run-1" });
    assert.equal((await accountUsage("acme")).workspaces.find((w) => w.workspace === "desk")!.storage.runsBytes, before);
  } finally {
    setRunOutputsBackend(null);
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
