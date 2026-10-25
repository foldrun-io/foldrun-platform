// Built-in tools gallery: listing, and assignment to account or workspace.
//
//   node --test tests/gallery.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { GALLERY, galleryTemplate, installGalleryTool, materialiseGallery } from "../src/gallery.ts";
import { readLibraryFile } from "../../foldrun-core/src/library.ts";
import { parseToolDef, readWorkspaceFile, saveWorkspace, workspaceTools, writeWorkspaceFile } from "../../foldrun-core/src/store.ts";
import { missingToolPrograms } from "../../foldrun-core/src/tool-programs.ts";
import { isEditablePath, listWorkspaceFiles } from "../../foldrun-core/src/store.ts";
import { SCRIPT_LANGUAGES, toolStarter } from "../../foldrun-core/src/kinds.ts";
import { fencedCode } from "../../foldrun-core/src/store.ts";

function withData(body: () => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-gallery-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    body();
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("web ships as a folder: a definition, and the programs beside it", () => {
  const browser = GALLERY.find((t) => t.name === "web");
  assert.ok(browser, "web tool exists");
  assert.equal(browser!.kind, "tools");
  assert.equal(browser!.file, "web/tool.md");
  assert.equal(browser!.snippet, "tools: [web]");
  assert.equal(browser!.wrapper?.file, "web/run.mjs", "the program is a file");

  const { data, content } = matter(browser!.content);
  const def = parseToolDef(data as Record<string, unknown>, "web", content);
  assert.equal(def!.kind, "script");
  const spec = def!.spec as { run?: string; code?: string };
  // Points at the file, carries no code — the shape every script tool takes.
  assert.equal(spec.run, "run.mjs");
  assert.equal(spec.code, undefined);
  assert.match(browser!.extra!.find((f) => f.file === "web/browse.mjs")!.content, /engine\.launch/);

  // And the definition's prose must not itself parse as a program: the body
  // keeps a ```yaml usage example, which no interpreter claims.
  assert.equal(fencedCode(content), null);
});

test("installing web writes its files at either scope", () =>
  withData(() => {
    assert.equal(installGalleryTool("acme", "web"), "web/tool.md");
    assert.match(readLibraryFile("acme", "tools", "web/browse.mjs"), /engine\.launch/);

    saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: "---\nname: desk\n---\n" }]);
    assert.equal(installGalleryTool("acme", "web", "desk"), "tools/web/tool.md");
    // Byte-identical at both scopes: nothing to rewrite, because a folder
    // tool's run: names the file beside it and never the scope it sits in.
    assert.equal(
      readWorkspaceFile("acme", "desk", "tools/web/tool.md"),
      readLibraryFile("acme", "tools", "web/tool.md"),
    );
    assert.equal(
      readWorkspaceFile("acme", "desk", "tools/web/browse.mjs"),
      readLibraryFile("acme", "tools", "web/browse.mjs"),
    );
  }));

test("an installed gallery script tool loads with its program on disk", () =>
  withData(() => {
    saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: "---\nname: desk\n---\n" }]);
    installGalleryTool("acme", "web", "desk");
    const def = workspaceTools("acme", "desk").web;
    assert.equal(def.kind, "script");
    assert.equal((def.spec as { run?: string }).run, "workspace/tools/web/run.mjs");
    // The check `foldrun check` runs, applied to what the gallery installed.
    assert.deepEqual(missingToolPrograms("acme", "desk"), []);
  }));

test("an unknown tool is refused", () =>
  withData(() => {
    assert.throws(() => installGalleryTool("acme", "nope"), /no such gallery tool/);
  }));

// -------------------------------------------------- start-from templates


test("a wrong-kind template is refused, and an unknown one too", () => {
  // browser lives on the tools shelf now, so asking the scripts shelf for it
  // returns null — which callers treat exactly like "no template chosen".
  assert.equal(galleryTemplate("scripts", "web", "x"), null);
  assert.equal(galleryTemplate("tools", "nope", "x"), null);
});

// Starting from a folder entry must seed the folder. Handing back only the
// definition would write a `run:` pointing at a file nobody created — the
// exact state `foldrun check` now reports as an error.
test("starting from a folder gallery entry seeds both of its files", () => {
  const seed = galleryTemplate("tools", "web", "my-browser")!;
  assert.deepEqual(seed.slice(0, 2).map((f) => f.file), ["my-browser/tool.md", "my-browser/run.mjs"]);
  assert.ok(seed.some((f) => f.file === "my-browser/browse.mjs"), "and every program beside it");
  const { data } = matter(seed[0].content);
  assert.equal(data.name, "my-browser");
  // run: still names the file beside it — the folder was renamed, not the
  // program, and neither travels without the other.
  assert.equal(data.run, "run.mjs");
  assert.match(seed[0].content, /tools: \[my-browser\]/);
  assert.match(seed.find((f) => f.file === "my-browser/browse.mjs")!.content, /engine\.launch/);
});

// --------------------------------------------------- creating a new tool

test("a new script tool is a folder: the definition, and the program beside it", () => {
  const files = toolStarter("my-thing", "script");
  assert.deepEqual(files.map((f) => f.file), [
    "tools/my-thing/tool.md",
    "tools/my-thing/run.mjs",
  ]);

  const { data, content } = matter(files[0].content);
  const def = parseToolDef(data as Record<string, unknown>, "my-thing", content);
  assert.equal(def!.kind, "script");
  const spec = def!.spec as { run?: string; code?: string };
  // The program is a file, so the definition points at it and carries no code.
  assert.equal(spec.run, "run.mjs");
  assert.equal(spec.code, undefined);

  // And it is a real program, not a snippet: it validates its own argument,
  // because every declared arg is optional at the call site.
  assert.match(files[1].content, /parseArgs/);
  assert.match(files[1].content, /process\.exit\(1\)/);
});

// The failure this guards: a body that opens with a usage example in a fence
// whose language tag happens to be executable. `run:` wins — the parser never
// looks at the body — but the starter should not be the file that teaches the
// habit, so its examples are tagged with something no interpreter claims.
test("the starter's own examples cannot be mistaken for the program", () => {
  const [manifest] = toolStarter("my-thing", "script");
  const { content } = matter(manifest.content);
  const fence = fencedCode(content);
  assert.equal(fence, null, `a fenced block in the starter parsed as code: ${fence?.ext}`);
});

test("an API or MCP tool is still one flat file", () => {
  for (const [transport, kind] of [["http", "http"], ["mcp", "mcp"]] as const) {
    const files = toolStarter("my-thing", transport);
    assert.equal(files.length, 1, `${transport} is one file`);
    assert.equal(files[0].file, "tools/my-thing.md");
    const def = parseToolDef(matter(files[0].content).data as Record<string, unknown>, "my-thing");
    assert.equal(def!.kind, kind);
  }
});

// Creating a script tool is one action that writes two files, and both have
// to land. The starter returning a manifest whose `run:` names a file nobody
// wrote is the exact failure `foldrun check` now reports — so the create flow
// must not be able to produce it.
test("creating a script tool writes the program its definition points at", () =>
  withData(() => {
    saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: "---\nname: desk\n---\n" }]);
    for (const f of toolStarter("my-thing", "script")) {
      writeWorkspaceFile("acme", "desk", f.file, f.content);
    }

    // It loads as a tool, under the name that was asked for.
    const def = workspaceTools("acme", "desk")["my-thing"];
    assert.ok(def, "the new tool did not load");
    assert.equal(def.kind, "script");

    // And its program is on disk where the definition says — the check that
    // `foldrun check` runs, applied to what "New tool" just produced.
    assert.deepEqual(missingToolPrograms("acme", "desk"), []);
  }));

// Three questions, and the third used to be answered silently: "script tool"
// meant JavaScript, which you found out by opening the file it wrote. The
// runner has always chosen an interpreter from the extension, so the choice
// was real and merely hidden.
test("a script tool is written in the language you picked", () => {
  const expected: Record<string, { program: string; marker: RegExp }> = {
    javascript: { program: "tools/x/run.mjs", marker: /parseArgs/ },
    python: { program: "tools/x/run.py", marker: /argparse/ },
    bash: { program: "tools/x/run.sh", marker: /#!\/usr\/bin\/env bash/ },
  };

  for (const lang of SCRIPT_LANGUAGES) {
    const files = toolStarter("x", "script", lang.value);
    const want = expected[lang.value];
    assert.deepEqual(
      files.map((f) => f.file),
      ["tools/x/tool.md", want.program],
      `${lang.value} writes the wrong files`,
    );

    // The definition points at the program that was actually written —
    // this is the pair `foldrun check` verifies.
    const { data } = matter(files[0].content);
    assert.equal(data.run, want.program.split("/").pop(), `${lang.value}: run: disagrees`);
    assert.match(files[1].content, want.marker, `${lang.value}: not that language`);

    // Every language keeps the same contract: validate the argument the
    // model may omit, and fail loudly rather than returning nothing.
    assert.match(files[1].content, /input/, `${lang.value}: does not read its arg`);
    assert.match(files[1].content, /1|required/, `${lang.value}: no failure path`);
  }
});

test("no language, or an unknown one, still writes a working tool", () => {
  // An older client that does not send the field must not create a folder
  // with a definition and no program.
  for (const files of [toolStarter("x", "script"), toolStarter("x", "script", "klingon" as never)]) {
    assert.deepEqual(files.map((f) => f.file), ["tools/x/tool.md", "tools/x/run.mjs"]);
    assert.equal(matter(files[0].content).data.run, "run.mjs");
  }
});

// The program half of a folder tool must be VISIBLE, not merely writable.
//
// The file tree admitted markdown, scripts/, skill assets and state/ — and
// not tools/<name>/run.*. So the code you were told to edit was writable,
// readable, and absent from the tree that is the only way to reach it. The
// listing now asks the writer, which is the same fix the state/ case got and
// the reason this cannot drift a third time.
test("a folder tool's program appears in the file tree", () =>
  withData(() => {
    saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: "---\nname: desk\n---\n" }]);
    for (const f of toolStarter("counter", "script", "python")) {
      writeWorkspaceFile("acme", "desk", f.file, f.content);
    }

    const files = listWorkspaceFiles("acme", "desk");
    assert.ok(files.includes("tools/counter/tool.md"), "the definition is listed");
    assert.ok(files.includes("tools/counter/run.py"), "the program is listed");
  }));

test("everything the writer accepts is listed, and nothing it refuses is", () =>
  withData(() => {
    saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: "---\nname: desk\n---\n" }]);
    for (const f of toolStarter("counter", "script")) {
      writeWorkspaceFile("acme", "desk", f.file, f.content);
    }
    // The invariant, not a list of paths: a file that can be saved is a file
    // that shows, or someone is told to edit something they cannot find.
    for (const rel of listWorkspaceFiles("acme", "desk")) {
      assert.equal(isEditablePath(rel), true, `${rel} is listed but not editable`);
    }
  }));

test("the gallery materialises as a directory: web is a folder tool, program beside it", () =>
  withData(() => {
    const root = path.join(process.env.FOLDRUN_DATA!, "gallery");
    const written = materialiseGallery(root);
    assert.ok(written.includes(path.join("tools", "web", "tool.md")), "the definition");
    assert.ok(written.includes(path.join("tools", "web", "run.mjs")), "the program beside it");
    const def = parseToolDef(matter(fs.readFileSync(path.join(root, "tools", "web", "tool.md"), "utf8")).data as Record<string, unknown>, "web");
    assert.equal(def?.kind, "script", "our own search, not an http tool — http tools do not register under k8s isolation");
    // Written again: same files, no duplicates, nothing left behind.
    assert.deepEqual(materialiseGallery(root).sort(), written.sort());

    // A file from a previous version of the gallery does not survive —
    // the old flat websearch.md would otherwise resolve to the same tool
    // name as the folder that replaced it.
    fs.writeFileSync(path.join(root, "tools", "websearch.md"), "---\nname: websearch\n---\nstale\n");
    materialiseGallery(root);
    assert.equal(fs.existsSync(path.join(root, "tools", "websearch.md")), false, "a renamed entry leaves nothing behind");
    assert.ok(fs.existsSync(path.join(root, "tools", "web", "tool.md")), "and the current one is there");
  }));
