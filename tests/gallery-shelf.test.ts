// The gallery's docs and video tools and its skills (13 Nov 2026): generated
// from gallery/, laid down on the shelf, read by the runner, and their
// programs' argument checks — everything here runs offline.
//
//   node --test tests/gallery-shelf.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GALLERY, galleryFiles, galleryDrift, galleryTemplate, materialiseGallery } from "../src/gallery.ts";
import { readToolDir } from "../../foldrun-core/src/store.ts";
import { parseScripts } from "../../foldrun-core/src/script-tools.ts";
import { discoverSkills } from "../../foldrun-core/src/runner.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");

test("src/gallery.ts carries exactly what gallery/ holds — run scripts/gallery-inject.mjs after editing it", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-inject-"));
  const copy = path.join(tmp, "gallery.ts");
  fs.copyFileSync(path.join(repo, "src", "gallery.ts"), copy);
  const r = spawnSync(process.execPath, [path.join(repo, "scripts", "gallery-inject.mjs"), copy, path.join(repo, "gallery")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(copy, "utf8"), fs.readFileSync(path.join(repo, "src", "gallery.ts"), "utf8"), "src/gallery.ts is behind gallery/ — run node scripts/gallery-inject.mjs");
});

test("the shelf: docs and video beside web, and three skills", () => {
  const names = (kind: string) => GALLERY.filter((t) => t.kind === kind).map((t) => t.name).sort();
  assert.deepEqual(names("tools"), ["docs", "video", "web"]);
  assert.deepEqual(names("skills"), ["cloudhost-deploy", "modern-website", "motion-video"]);
});

test("the shelf materialises skills as Agent Skills folders, references beside SKILL.md", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-shelf-"));
  const written = materialiseGallery(root);
  for (const f of ["skills/modern-website/SKILL.md", "skills/modern-website/references/stack.md", "skills/modern-website/references/quality.md", "skills/cloudhost-deploy/references/config.md", "skills/motion-video/SKILL.md", "tools/docs/tool.md", "tools/docs/run.mjs", "tools/video/tool.md", "tools/video/run.mjs"]) {
    assert.ok(written.includes(f), `${f} laid down`);
  }
  // The runner's own reader finds every skill, each with a description.
  const skills = discoverSkills(root, "skills");
  assert.deepEqual(skills.map((s) => s.name).sort(), ["cloudhost-deploy", "modern-website", "motion-video"]);
  for (const s of skills) assert.ok(s.description.length > 40, `${s.name} has a description the model can choose by`);
  assert.equal(skills.find((s) => s.name === "modern-website")!.hasReferences, true);
});

test("a skill's references stay on the skills shelf; a tool's program on the tools shelf", () => {
  const skill = GALLERY.find((t) => t.name === "modern-website")!;
  assert.ok(galleryFiles(skill).every((f) => f.kind === "skills"));
  const tool = GALLERY.find((t) => t.name === "video")!;
  assert.deepEqual(galleryFiles(tool).map((f) => `${f.kind}/${f.file}`), ["tools/video/tool.md", "tools/video/run.mjs"]);
});

test("a copied gallery skill is current until it changes", () => {
  const skill = GALLERY.find((t) => t.name === "motion-video")!;
  const files: Record<string, string> = { [skill.file]: skill.content };
  assert.equal(galleryDrift(skill.file, (rel) => files[rel] ?? null, "skills")!.status, "current");
  files[skill.file] += "\nlocal note\n";
  assert.equal(galleryDrift(skill.file, (rel) => files[rel] ?? null, "skills")!.status, "differs");
  assert.equal(galleryDrift(skill.file, (rel) => files[rel] ?? null), null, "not a tool");
});

test("starting a new skill from a gallery one copies its folder under the new name", () => {
  const seed = galleryTemplate("skills", "modern-website", "our-site")!;
  assert.deepEqual(seed.map((f) => f.file).sort(), ["our-site/SKILL.md", "our-site/references/quality.md", "our-site/references/stack.md"]);
  assert.match(seed.find((f) => f.file === "our-site/SKILL.md")!.content, /^name: our-site$/m);
});

test("docs and video parse as script tools, each naming the sites its program reaches", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-tools-"));
  materialiseGallery(root);
  const defs = readToolDir(path.join(root, "tools"), "account");
  for (const [name, sites] of [["docs", ["context7.com"]], ["video", ["registry.npmjs.org", "remotion.media"]]] as const) {
    const def = defs[name];
    assert.equal(def?.kind, "script", `${name} is a script tool`);
    const [spec] = parseScripts([def!.spec]);
    assert.deepEqual(spec.network, sites);
    assert.equal(spec.run, `account/tools/${name}/run.mjs`);
  }
  // video's runtime carries the Debian libraries its browser needs.
  assert.match(JSON.stringify(defs.video!.spec), /libnss3/);
});

test("both programs are valid JavaScript", () => {
  for (const name of ["docs", "video"]) {
    const r = spawnSync(process.execPath, ["--check", path.join(repo, "gallery", "tools", name, "run.mjs")], { encoding: "utf8" });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
  }
});

/** A workspace with one agent, the program run from the agent's folder. */
function agentDir() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-ws-"));
  const dir = path.join(ws, "agents", "a");
  fs.mkdirSync(dir, { recursive: true });
  return { ws, dir };
}
const runTool = (name: string, args: string[], cwd: string) =>
  spawnSync(process.execPath, [path.join(repo, "gallery", "tools", name, "run.mjs"), ...args], { cwd, encoding: "utf8", env: { ...process.env, CONTEXT7_API_KEY: "" } });

test("docs refuses a call it cannot make before anything leaves", () => {
  const { dir } = agentDir();
  let r = runTool("docs", [], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /needs action=: search or get/);
  r = runTool("docs", ["--action", "get", "--library", "astro"], dir);
  assert.match(r.stderr, /needs query=/);
  r = runTool("docs", ["--action", "search", "--query", "x"], dir);
  assert.match(r.stderr, /needs library=/);
  r = runTool("docs", ["--action", "get", "--library", "/withastro/docs", "--query", "x", "--version", "7; rm -rf /"], dir);
  assert.match(r.stderr, /is not a version/);
});

test("video new writes a project, refuses to write over one, and keeps inside the workspace", () => {
  const { ws, dir } = agentDir();
  fs.symlinkSync("../..", path.join(dir, "workspace"));
  let r = runTool("video", ["--action", "new", "--project", "workspace/storage/video/launch"], dir);
  assert.equal(r.status, 0, r.stderr);
  for (const f of ["package.json", "src/index.ts", "src/Root.tsx", "src/Intro.tsx", "remotion.config.ts"]) {
    assert.ok(fs.existsSync(path.join(ws, "storage", "video", "launch", f)), f);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ws, "storage", "video", "launch", "package.json"), "utf8"));
  const remotion = Object.entries(pkg.dependencies).filter(([n]) => n === "remotion" || n.startsWith("@remotion/")).map(([, v]) => v);
  assert.equal(new Set(remotion).size, 1, "every Remotion package at one version");
  assert.match(r.stdout, /workspace\/storage\/video\/launch/);
  r = runTool("video", ["--action", "new", "--project", "workspace/storage/video/launch"], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already has a project/);
  r = runTool("video", ["--action", "new", "--project", "../../../elsewhere"], dir);
  assert.match(r.stderr, /outside the workspace/);
  r = runTool("video", ["--action", "render", "--project", "workspace/storage/video/none"], dir);
  assert.match(r.stderr, /has no package\.json/);
  r = runTool("video", ["--action", "render", "--project", "workspace/storage/video/launch", "--props", "[1]"], dir);
  assert.match(r.stderr, /props= is not a JSON object/);
});

test("a link inside the workspace that leads out of it is refused, by both programs (Codex review)", () => {
  const { ws, dir } = agentDir();
  fs.symlinkSync("../..", path.join(dir, "workspace"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-outside-"));
  fs.mkdirSync(path.join(ws, "storage"), { recursive: true });
  fs.symlinkSync(outside, path.join(ws, "storage", "link"));
  fs.symlinkSync(path.join(outside, "nowhere"), path.join(ws, "storage", "dangling"));

  let r = runTool("video", ["--action", "new", "--project", "workspace/storage/link/new"], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /outside the workspace/);
  assert.equal(fs.existsSync(path.join(outside, "new")), false, "nothing written out there");
  r = runTool("video", ["--action", "new", "--project", "workspace/storage/dangling"], dir);
  assert.match(r.stderr, /outside the workspace|leads nowhere/);

  r = runTool("docs", ["--action", "get", "--library", "/x/y", "--query", "q", "--save", "workspace/storage/link/victim.md"], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /outside the workspace/);
  r = runTool("docs", ["--action", "get", "--library", "/x/y", "--query", "q", "--save", "../../storage/link/victim.md"], dir);
  assert.match(r.stderr, /outside the workspace/);
  assert.equal(fs.existsSync(path.join(outside, "victim.md")), false);
});
