import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountPriority, priorityWeight } from "../src/limits.ts";
import { parseFlow } from "../../foldrun-core/src/store.ts";

// The queue lane: the account's priority plus the flow's, as a number the
// claim orders by. The cap decides how much of the fleet a lane may hold;
// this only decides who is claimed first when slots are short.

test("priority levels weigh 10 / 0 / -10, and anything else is normal", () => {
  assert.equal(priorityWeight("high"), 10);
  assert.equal(priorityWeight("normal"), 0);
  assert.equal(priorityWeight("low"), -10);
  assert.equal(priorityWeight(undefined), 0);
  assert.equal(priorityWeight("urgent"), 0, "an unknown word is not a lane");
});

test("a flow's priority parses, and the account's is read from its AGENTS.md", async () => {
  const flow = parseFlow("f.md", "---\nname: f\npriority: high\n---\n1. [[a]] — x\n");
  assert.equal(flow.priority, "high");
  assert.equal(parseFlow("g.md", "---\nname: g\npriority: whenever\n---\n1. [[a]] — x\n").priority, null);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-prio-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    fs.mkdirSync(path.join(root, "acme/workspaces"), { recursive: true });
    assert.equal(await accountPriority("acme"), 0, "no account file: normal");
    fs.writeFileSync(path.join(root, "acme/AGENTS.md"), "---\npriority: low\n---\n");
    assert.equal(await accountPriority("acme"), -10);
    // A high flow on a low account is normal: the lanes add.
    assert.equal((await accountPriority("acme")) + priorityWeight(flow.priority), 0);
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
