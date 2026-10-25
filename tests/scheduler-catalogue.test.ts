import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The scheduler reads its flows from memory, not the disk, between rescans.
// A tick used to walk every tenant, workspace and flow file; on a shared
// filesystem with thousands of accounts that is thousands of round trips
// every 30 seconds. Now: a full scan on a slow cadence, and a workspace
// re-read only when core says it changed. This proves both halves — that
// the disk is NOT re-read on its own, and that a write through core IS
// seen on the next tick.

const flow = (name: string) =>
  `---\nname: ${name}\ntrigger: schedule\nschedule: "* * * * *"\n---\n1. [[writer]] — write\n`;

test("a flow written through core is on the next tick; one written behind its back waits for the rescan", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-catalogue-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "flows"), { recursive: true });
    fs.mkdirSync(path.join(ws, "agents/writer"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    fs.writeFileSync(path.join(ws, "agents/writer/agent.md"), "---\nname: writer\n---\nwrite\n");
    fs.writeFileSync(path.join(ws, "flows/nightly.md"), flow("nightly"));

    // The platform's hook is what marks a workspace dirty; importing the
    // entry point registers it, as every platform process does.
    await import("../src/index.ts");
    const { tick, resetCatalogue } = await import("../src/scheduler.ts");
    const { writeWorkspaceFile } = await import("../../foldrun-core/src/store.ts");
    resetCatalogue();
    const state = () => JSON.parse(fs.readFileSync(path.join(root, "schedule.json"), "utf8")) as { lastFired: Record<string, string> };

    const t0 = new Date("2026-09-08T10:00:05Z");
    await tick(t0);
    assert.ok(state().lastFired["acme/desk/nightly"], "first sighting is recorded");

    // Behind the scheduler's back: a file appears on disk with no word to the
    // platform. The catalogue does not know, and must not go looking.
    fs.writeFileSync(path.join(ws, "flows/sneaky.md"), flow("sneaky"));
    await tick(new Date(t0.getTime() + 30_000));
    assert.equal(state().lastFired["acme/desk/sneaky"], undefined, "the disk is not walked every tick");

    // Through core: the write marks the workspace dirty, and the next tick
    // re-reads that one workspace — the new flow is sighted, and so is the
    // sneaky one, because the workspace is read whole.
    writeWorkspaceFile("acme", "desk", "flows/hourly.md", flow("hourly"), { by: "test" });
    await tick(new Date(t0.getTime() + 60_000));
    assert.ok(state().lastFired["acme/desk/hourly"], "a write through core reaches the scheduler on the next tick");
    assert.ok(state().lastFired["acme/desk/sneaky"], "the whole workspace is re-read, not one file");

    // And a due flow still fires from the catalogue: the next minute.
    const due = await tick(new Date(t0.getTime() + 120_000));
    assert.ok(due.some((d) => d.flow.name === "nightly"), "the catalogue fires what the disk would have");
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A deploy marks its workspace dirty; the next tick must build its runtimes
// whichever path that tick takes. The rescan path used to drop the mark, so
// a deploy landing in a rescan tick (every five minutes, and always the first
// tick of a freshly rolled worker) was never warmed.
test("a changed workspace is warmed on the next tick, rescan or not", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-catalogue-warm-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    fs.mkdirSync(path.join(root, "acme/workspaces/desk/flows"), { recursive: true });
    fs.writeFileSync(path.join(root, "acme/workspaces/desk/AGENTS.md"), "---\nname: desk\n---\n");
    const { refreshCatalogue, resetCatalogue, markScheduleDirty, setWarmForTest } = await import("../src/scheduler.ts");
    const warmed: string[] = [];
    setWarmForTest((t, w) => warmed.push(`${t}/${w}`));
    try {
      resetCatalogue();
      // Empty catalogue: this tick is a full rescan.
      markScheduleDirty("acme", "desk");
      await refreshCatalogue(Date.now(), ["acme"]);
      assert.deepEqual(warmed, ["acme/desk"], "the rescan tick warmed the marked workspace");
      // A normal tick, straight after.
      markScheduleDirty("acme", "desk");
      await refreshCatalogue(Date.now(), ["acme"]);
      assert.deepEqual(warmed, ["acme/desk", "acme/desk"], "and so does a normal tick");
      // Nothing marked, nothing warmed.
      await refreshCatalogue(Date.now(), ["acme"]);
      assert.equal(warmed.length, 2);
    } finally {
      setWarmForTest(null);
      resetCatalogue();
    }
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
