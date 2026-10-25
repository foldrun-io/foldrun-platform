// Untouched gallery copies follow the gallery after a deploy; edited ones stay.
//
//   node --test tests/gallery-sync.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GALLERY, installGalleryTool, syncAllGalleryCopies, syncGalleryCopies, writeGalleryCopy } from "../src/gallery.ts";
import { libraryDir, readLibraryFile, writeLibraryFile } from "../../foldrun-core/src/library.ts";
import { saveWorkspace } from "../../foldrun-core/src/store.ts";

function withData(body: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-gallery-sync-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    body(root);
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function withDataAsync(body: (root: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-gallery-sync-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    await body(root);
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function galleryMovesOnAsync(name: string, body: () => Promise<void>) {
  const tool = GALLERY.find((t) => t.name === name)!;
  const before = { content: tool.content, wrapper: tool.wrapper?.content };
  tool.content = `${tool.content}\n<!-- next version -->\n`;
  if (tool.wrapper) tool.wrapper.content = `${tool.wrapper.content}\n// next version\n`;
  try {
    await body();
  } finally {
    tool.content = before.content;
    if (tool.wrapper) tool.wrapper.content = before.wrapper!;
  }
}

/** Pretend the platform shipped a new version of a tool, for the length of body. */
function galleryMovesOn(name: string, body: () => void) {
  const tool = GALLERY.find((t) => t.name === name)!;
  const before = { content: tool.content, wrapper: tool.wrapper?.content };
  tool.content = `${tool.content}\n<!-- next version -->\n`;
  if (tool.wrapper) tool.wrapper.content = `${tool.wrapper.content}\n// next version\n`;
  try {
    body();
  } finally {
    tool.content = before.content;
    if (tool.wrapper) tool.wrapper.content = before.wrapper!;
  }
}

test("an untouched install is upgraded when the gallery moves on, wrapper and all", () =>
  withData(() => {
    installGalleryTool("acme", "web");
    galleryMovesOn("web", () => {
      const r = syncGalleryCopies("acme");
      assert.deepEqual(r.upgraded, ["web"]);
      assert.match(readLibraryFile("acme", "tools", "web/tool.md"), /next version/);
      assert.match(readLibraryFile("acme", "tools", "web/run.mjs"), /next version/);
      // And again is a no-op: it is current now.
      assert.deepEqual(syncGalleryCopies("acme").upgraded, []);
    });
  }));

test("an edited copy is never overwritten, and is reported as kept", () =>
  withData(() => {
    installGalleryTool("acme", "web");
    const edited = `${readLibraryFile("acme", "tools", "web/run.mjs")}\n// ours\n`;
    writeLibraryFile("acme", "tools", "web/run.mjs", edited, { by: "matt" });
    galleryMovesOn("web", () => {
      const r = syncGalleryCopies("acme");
      assert.deepEqual(r.upgraded, []);
      assert.deepEqual(r.kept, ["web"]);
      assert.equal(readLibraryFile("acme", "tools", "web/run.mjs"), edited);
    });
  }));

test("a copy from before stamps is judged by its history", () =>
  withData(() => {
    const tool = GALLERY.find((t) => t.name === "web")!;
    // Upgraded by the button in the old days: no stamp, but the last revision says gallery.
    writeGalleryCopy("acme", tool, { by: "matt", message: "upgraded web to the gallery's current version" });
    fs.rmSync(path.join(libraryDir("acme"), ".gallery-installs.json"));
    galleryMovesOn("web", () => {
      assert.deepEqual(syncGalleryCopies("acme").upgraded, ["web"]);
    });
  }));

test("a pre-stamp copy a person saved by hand is kept", () =>
  withData(() => {
    const tool = GALLERY.find((t) => t.name === "web")!;
    writeLibraryFile("acme", "tools", tool.file, tool.content, { by: "matt" });
    writeLibraryFile("acme", "tools", tool.wrapper!.file, `${tool.wrapper!.content}\n// mine\n`, { by: "matt" });
    galleryMovesOn("web", () => {
      assert.deepEqual(syncGalleryCopies("acme").kept, ["web"]);
    });
  }));

test("tools an account never installed are not added", () =>
  withData(() => {
    installGalleryTool("acme", "web");
    const r = syncGalleryCopies("acme");
    assert.deepEqual(r.upgraded, []);
    assert.deepEqual(fs.readdirSync(path.join(libraryDir("acme"), "tools")), ["web"], "only what was installed");
  }));

test("every account is synced once, and a held lock means another worker is doing it", () =>
  withDataAsync(async (root) => {
    // An account is a directory with workspaces; that is what listTenants walks.
    saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: "---\nname: desk\n---\n" }]);
    installGalleryTool("acme", "web");
    await galleryMovesOnAsync("web", async () => {
      const locks = path.join(root, ".locks");
      fs.mkdirSync(locks, { recursive: true });
      fs.writeFileSync(path.join(locks, "gallery-sync.lock"), "123");
      assert.deepEqual(await syncAllGalleryCopies(locks), [], "a fresh lock is respected");
      fs.rmSync(path.join(locks, "gallery-sync.lock"));
      const all = await syncAllGalleryCopies(locks);
      assert.deepEqual(all.find((r) => r.tenant === "acme")?.upgraded, ["web"]);
      assert.equal(fs.existsSync(path.join(locks, "gallery-sync.lock")), false, "released");
    });
  }));

// With Redis the lock is a lease there, not a file on the data volume. Two
// workers booting together: one syncs, the other stands down; no file.
//   docker run -d --rm -p 56379:6379 redis:7-alpine
//   FOLDRUN_TEST_REDIS_URL=redis://127.0.0.1:56379 npm test
const REDIS = process.env.FOLDRUN_TEST_REDIS_URL;
test("with Redis, two workers booting together sync once and leave no lock file", { skip: !REDIS && "set FOLDRUN_TEST_REDIS_URL" }, () =>
  withDataAsync(async (root) => {
    const prev = process.env.FOLDRUN_REDIS_URL;
    process.env.FOLDRUN_REDIS_URL = REDIS;
    try {
      saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: "---\nname: desk\n---\n" }]);
      const locks = path.join(root, ".locks");
      const [a, b] = await Promise.all([syncAllGalleryCopies(locks), syncAllGalleryCopies(locks)]);
      assert.equal([a, b].filter((r) => r.length > 0).length, 1, "exactly one worker synced");
      assert.equal(fs.existsSync(locks), false, "the data volume holds no lock");
      assert.ok((await syncAllGalleryCopies(locks)).length > 0, "the lease is released after");
    } finally {
      // The shared client would hold the test process open.
      (await import("../src/cache.ts")).cache()?.disconnect();
      if (prev === undefined) delete process.env.FOLDRUN_REDIS_URL;
      else process.env.FOLDRUN_REDIS_URL = prev;
    }
  }));

test("a stamp for a name no longer in the gallery is dropped; the account's files are not touched", () =>
  withData(() => {
    installGalleryTool("acme", "web");
    const file = path.join(libraryDir("acme"), ".gallery-installs.json");
    const stamps = JSON.parse(fs.readFileSync(file, "utf8"));
    stamps.web_fetch = { "tools/web_fetch/tool.md": "0".repeat(64) };
    fs.writeFileSync(file, JSON.stringify(stamps));
    // A file of that name left on the shelf is the account's now.
    writeLibraryFile("acme", "tools", "web_fetch/tool.md", "---\nname: web_fetch\n---\nmine\n", { by: "matt" });
    const r = syncGalleryCopies("acme");
    assert.deepEqual(r.forgotten, ["web_fetch"]);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(after.web_fetch, undefined, "the stamp is gone");
    assert.ok(after.web, "the gallery's own stamps stay");
    assert.match(readLibraryFile("acme", "tools", "web_fetch/tool.md")!, /mine/, "the file is not the sync's to delete");
    assert.equal(syncGalleryCopies("acme").forgotten, undefined, "again is a no-op");
  }));
