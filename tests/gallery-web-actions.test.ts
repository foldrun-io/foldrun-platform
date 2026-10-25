// Core's web-actions registry names web browse's modes and steps and what
// each vendor browser lacks; the tool's program has its own copies. Two
// lists of one fact drift, so this keeps them equal.
//
//   node --test tests/gallery-web-actions.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { GALLERY } from "../src/gallery.ts";
import { BROWSE_MODES, BROWSE_STEPS } from "../../foldrun-core/src/web-actions.ts";
import { BROWSER_APIS } from "../../foldrun-core/src/providers.ts";

const program = GALLERY.find((t) => t.name === "web")!.extra!.find((f) => f.file === "web/browse.mjs")!.content;
const list = (name: string) => {
  const m = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\]`).exec(program);
  assert.ok(m, `${name} in run.mjs`);
  return [...m[1].matchAll(/"([a-z0-9]+)"/g)].map((x) => x[1]);
};

test("core's BROWSE_MODES are the tool's MODES", () => {
  assert.deepEqual([...BROWSE_MODES], list("MODES"));
});

test("core's BROWSE_STEPS are the tool's ACTIONS", () => {
  assert.deepEqual([...BROWSE_STEPS], list("ACTIONS"));
});

test("each vendor's lacks is the same in core and in the tool", () => {
  const vendors = /const VENDORS = \{([\s\S]*?)\n\};/.exec(program)![1];
  for (const b of BROWSER_APIS) {
    const block = new RegExp(`\\n  ${b.name}: \\{([\\s\\S]*?)\\n  \\},`).exec(vendors)?.[1] ?? "";
    const m = /lacks: \[([^\]]*)\]/.exec(block);
    const inTool = m ? [...m[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]) : [];
    assert.deepEqual(inTool, b.lacks ?? [], b.name);
  }
});
