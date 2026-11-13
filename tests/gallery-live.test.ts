// The gallery's docs and video tools against the real world (13 Nov 2026):
// Context7's live API, npm, Remotion's browser download and a real render.
// gallery-shelf.test.ts proves everything that can be proved offline; this
// proves the programs still work against the services they call, which
// change without telling us. CI runs it (.github/workflows/ci.yml,
// `gallery-live`) when gallery/ changes on main, and nightly; npm test
// skips it.
//
//   FOLDRUN_TEST_GALLERY_LIVE=1 node --test tests/gallery-live.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const program = (name: string) => path.join(here, "..", "gallery", "tools", name, "run.mjs");
const skip = process.env.FOLDRUN_TEST_GALLERY_LIVE === "1" ? false : "set FOLDRUN_TEST_GALLERY_LIVE=1 (network: Context7, npm, remotion.media)";

/** A workspace with one agent folder and the `workspace` link the runner makes. */
function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-live-"));
  const agent = path.join(ws, "agents", "a");
  fs.mkdirSync(agent, { recursive: true });
  fs.symlinkSync("../..", path.join(agent, "workspace"));
  return { ws, agent };
}

function call(name: string, args: Record<string, string>, cwd: string, timeout: number) {
  const argv = Object.entries(args).flatMap(([k, v]) => [`--${k}`, v]);
  const r = spawnSync(process.execPath, [program(name), ...argv], {
    cwd, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CONTEXT7_API_KEY: process.env.CONTEXT7_API_KEY ?? "" },
  });
  assert.equal(r.status, 0, `${name} ${argv.join(" ")} exited ${r.status}\n${r.stderr}\n${r.stdout}`);
  return r.stdout;
}

test("docs finds a library on Context7 and returns its current docs, pinned when asked", { skip, timeout: 180_000 }, () => {
  const { ws, agent } = workspace();
  const found = call("docs", { action: "search", library: "next.js", query: "app router" }, agent, 120_000);
  assert.match(found, /\/vercel\/next\.js/, "the search names Next.js's library id");

  const got = call("docs", { action: "get", library: "/vercel/next.js", query: "route handlers", max_output: "4000" }, agent, 120_000);
  assert.ok(got.length > 500, `some docs came back (${got.length} chars)`);

  const pinned = call("docs", { action: "get", library: "/vercel/next.js", version: "v15", query: "middleware", max_output: "3000", save: "workspace/storage/next-15.md" }, agent, 120_000);
  assert.ok(pinned.length > 0);
  assert.ok(fs.statSync(path.join(ws, "storage", "next-15.md")).size > 500, "save= wrote the docs into storage");
});

test("video scaffolds, installs, lists, renders a still and a short MP4", { skip, timeout: 900_000 }, () => {
  const { ws, agent } = workspace();
  const project = "workspace/storage/video/ci";
  call("video", { action: "new", project }, agent, 60_000);

  const comps = call("video", { action: "compositions", project }, agent, 600_000);
  assert.match(comps, /intro — 1920x1080, 30 fps, 150 frames/);

  call("video", { action: "still", project, composition: "intro", frame: "60", scale: "0.5" }, agent, 300_000);
  const png = path.join(ws, "storage", "video", "ci", "out", "intro-60.png");
  assert.deepEqual([...fs.readFileSync(png).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], "a PNG");

  const done = call("video", { action: "render", project, composition: "intro", frames: "0-29", scale: "0.25", props: JSON.stringify({ title: "CI" }) }, agent, 600_000);
  assert.match(done, /Rendered intro .* h264/);
  const mp4 = fs.readFileSync(path.join(ws, "storage", "video", "ci", "out", "intro.mp4"));
  assert.equal(mp4.subarray(4, 8).toString("latin1"), "ftyp", "an MP4");
  assert.ok(mp4.length > 1000, `the MP4 has frames in it (${mp4.length} bytes)`);
  assert.equal(fs.existsSync(path.join(ws, "storage", "video", "ci", ".remotion-bundle")), false, "the bundle stays under node_modules, never copied back");
});
