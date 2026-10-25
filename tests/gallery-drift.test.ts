// The Library page's drift badge: is this file one of the gallery's, and
// does it still match what the gallery ships now?
//
//   node --test tests/gallery-drift.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { GALLERY, galleryDrift } from "../src/gallery.ts";

test("a library file that is not from the gallery has no drift status", () => {
  assert.equal(galleryDrift("crm/tool.md", () => "anything"), null);
  assert.equal(galleryDrift("email.md", () => null), null, "not installed");
});

test("an exact copy is current; a changed definition or program differs", () => {
  const browser = GALLERY.find((t) => t.name === "web")!;
  const files: Record<string, string> = {
    [browser.file]: browser.content,
    [browser.wrapper!.file]: browser.wrapper!.content,
    ...Object.fromEntries(browser.extra!.map((f) => [f.file, f.content])),
  };
  const read = (rel: string) => files[rel] ?? null;
  assert.equal(galleryDrift(browser.file, read)!.status, "current");
  files[browser.wrapper!.file] = browser.wrapper!.content + "\n// local edit\n";
  assert.equal(galleryDrift(browser.file, read)!.status, "differs", "the program changed, the definition did not");
  files[browser.wrapper!.file] = browser.wrapper!.content;
  files[browser.file] = browser.content.replace("timeout: 600", "timeout: 300");
  assert.equal(galleryDrift(browser.file, read)!.status, "differs");
});
