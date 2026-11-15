// A pod's copy of the workspaces kept current by notification (15 Nov 2026):
// what a payload may name, and one sync per name at a time.
//
//   node --test tests/mirror-notify.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHeadsPayload, coalescer } from "../src/mirror-notify.ts";

test("a payload names one workspace, or one account; anything else is ignored", () => {
  assert.deepEqual(parseHeadsPayload("acme/desk"), { tenant: "acme", workspace: "desk" });
  assert.deepEqual(parseHeadsPayload("acme/@library"), { tenant: "acme", workspace: "@library" });
  assert.deepEqual(parseHeadsPayload("cloudhost/p-prj-d114c4880a37df7e"), { tenant: "cloudhost", workspace: "p-prj-d114c4880a37df7e" });
  assert.deepEqual(parseHeadsPayload("acme"), { tenant: "acme", workspace: null });
  for (const bad of ["", "/desk", "acme/", "acme/desk/x", "../etc", "acme/..", "acme/de sk", "a".repeat(200)]) {
    assert.equal(parseHeadsPayload(bad), null, bad);
  }
});

test("a burst for one name is one run, plus exactly one more if asked again while it ran", async () => {
  const runs: string[] = [];
  let release!: () => void;
  let gate = new Promise<void>((r) => (release = r));
  const q = coalescer(async (k) => {
    runs.push(k);
    await gate;
  });
  q.ask("acme/desk");
  for (let i = 0; i < 50; i++) q.ask("acme/desk"); // a deploy touching it again and again
  q.ask("acme/other");
  assert.deepEqual(runs, ["acme/desk", "acme/other"], "one run each, at once");
  const first = release;
  gate = Promise.resolve();
  first();
  await q.idle();
  assert.deepEqual(runs, ["acme/desk", "acme/other", "acme/desk"], "one more for the asks that landed while it ran");
  q.ask("acme/desk");
  await q.idle();
  assert.equal(runs.length, 4, "a later ask is a new run");
});

test("one name's failure does not stop it being synced next time, or the others", async () => {
  const runs: string[] = [];
  const q = coalescer(async (k) => {
    runs.push(k);
    if (k === "bad/ws") throw new Error("BlobMissing");
  });
  q.ask("bad/ws");
  q.ask("good/ws");
  await q.idle();
  q.ask("bad/ws");
  await q.idle();
  assert.deepEqual(runs, ["bad/ws", "good/ws", "bad/ws"]);
});
