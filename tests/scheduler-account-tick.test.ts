// POST /api/schedule ("Run scheduler now") is one account admin's button,
// and it ran the install's whole pass — every account's due flows. tick()
// with `tenant` fires that account's alone, and a later full tick still
// fires everyone else's. 30 Oct 2026.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const flow = (name: string) => `---\nname: ${name}\ntrigger: schedule\nschedule: "* * * * *"\n---\n1. [[writer]] — write\n`;

test("an account's pass fires its own due flows and leaves every other account's for the real tick", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-account-tick-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    for (const tenant of ["acme", "other"]) {
      const ws = path.join(root, `${tenant}/workspaces/desk`);
      fs.mkdirSync(path.join(ws, "flows"), { recursive: true });
      fs.mkdirSync(path.join(ws, "agents/writer"), { recursive: true });
      fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
      fs.writeFileSync(path.join(ws, "agents/writer/agent.md"), "---\nname: writer\n---\nwrite\n");
      fs.writeFileSync(path.join(ws, "flows/nightly.md"), flow("nightly"));
    }
    const { tick, resetCatalogue } = await import("../src/scheduler.ts");
    resetCatalogue();
    const state = () => JSON.parse(fs.readFileSync(path.join(root, "schedule.json"), "utf8")) as { lastFired: Record<string, string> };

    const t0 = new Date("2026-09-08T10:00:05Z");
    await tick(t0); // first sighting of both, nothing fires
    const otherSeen = state().lastFired["other/desk/nightly"];
    assert.ok(otherSeen);

    const mine = await tick(new Date(t0.getTime() + 60_000), { tenant: "acme" });
    assert.deepEqual(mine.map((d) => d.tenant), ["acme"], "only the caller's account fires");
    assert.equal(state().lastFired["other/desk/nightly"], otherSeen, "another account's schedule is not touched");

    const all = await tick(new Date(t0.getTime() + 120_000));
    assert.ok(all.some((d) => d.tenant === "other"), "the full tick still fires the other account");
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("nextFire answers a day the calendar never has at once", async () => {
  const { nextFire, parseCron } = await import("../src/scheduler.ts");
  assert.equal(nextFire(parseCron("0 0 30 2 *")!, new Date("2026-01-01T00:00:00Z"), "UTC", 400), null);
  assert.equal(nextFire(parseCron("0 9 * * *")!, new Date("2026-01-01T00:00:00Z"))?.toISOString(), "2026-01-01T09:00:00.000Z");
});
