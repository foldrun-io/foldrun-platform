// The demo every new account can make. Its agents wrote to ../../files/,
// the folder storage/ replaced, so nothing they produced reached the
// Storage page, and they had no file tools, so they produced nothing.

import test from "node:test";
import assert from "node:assert/strict";
import { demoWorkspaceFiles } from "../src/demo-workspace.ts";

const files = demoWorkspaceFiles();

test("the demo says workspace/… for the workspace root, and never the retired files/", () => {
  for (const f of files) {
    assert.doesNotMatch(f.content, /\.\.\/\.\.\//, `${f.path} climbs with ../../`);
    assert.doesNotMatch(f.content, /(^|[\s`=(])files\//m, `${f.path} names the retired files/`);
  }
});

test("an agent told to read or write a file is granted the file tools", () => {
  for (const f of files.filter((x) => x.path.startsWith("agents/"))) {
    if (/workspace\/storage\//.test(f.content) && !/crm-upload/.test(f.content)) {
      assert.match(f.content, /^tools: \[write\]$/m, `${f.path} writes files and has no file tools`);
    }
  }
});

test("each producing step checks its artefact, and the approval shows the CSV", () => {
  const flow = files.find((f) => f.path === "flows/extract-and-import.md")!.content;
  for (const out of ["leads.csv", "leads-enriched.csv", "leads-checked.md"]) {
    assert.match(flow, new RegExp(`verify: file: workspace/storage/${out.replace(".", "\\.")}`));
  }
  assert.match(flow, /preview: workspace\/storage\/leads-enriched\.csv/);
});
