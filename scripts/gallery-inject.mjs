#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
// The gallery's docs, video and skills entries are generated: their sources
// are files under gallery/ (tools/<name>/tool.md + run.mjs, skills/<name>/…),
// read and tested as files, and this writes them into src/gallery.ts as the
// string literals the platform ships. Run after editing any of them:
//
//   node scripts/gallery-inject.mjs
//
// tests/gallery-sources.test.ts fails when src/gallery.ts is behind them.
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const galleryTs = process.argv[2] ?? path.join(here, "..", "src", "gallery.ts");
const root = process.argv[3] ?? path.join(here, "..", "gallery");
const rd = (p) => fs.readFileSync(path.join(root, p), "utf8");
const J = (s) => JSON.stringify(s);
const tool = (name, title, description, snippet) => `  {
    name: ${J(name)},
    kind: "tools",
    title: ${J(title)},
    description:
      ${J(description)},
    file: ${J(`${name}/tool.md`)},
    snippet: ${J(snippet)},
    content: ${J(rd(`tools/${name}/tool.md`))},
    wrapper: { file: ${J(`${name}/run.mjs`)}, content: ${J(rd(`tools/${name}/run.mjs`))} },
  },`;
const skill = (name, title, description, snippet) => {
  const dir = path.join(root, "skills", name);
  const extra = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name !== "SKILL.md" || d !== dir) extra.push(path.relative(path.join(root, "skills"), f)); } };
  walk(dir);
  return `  {
    name: ${J(name)},
    kind: "skills",
    title: ${J(title)},
    description:
      ${J(description)},
    file: ${J(`${name}/SKILL.md`)},
    snippet: ${J(snippet)},
    content: ${J(rd(`skills/${name}/SKILL.md`))},${extra.length ? `
    extra: [
${extra.map((f) => `      { file: ${J(f)}, content: ${J(rd(`skills/${f}`))} },`).join("\n")}
    ],` : ""}
  },`;
};
const BEGIN = "  // ---- generated from foldrun-platform/gallery/ by scripts/gallery-inject.mjs: docs, video, skills ----";
const END = "  // ---- end generated ----";
const block = [BEGIN,
  tool("docs", "Library docs", "A library's or framework's current documentation and code examples, pinned to a version, from Context7's index — so code is written against today's API, not the model's memory. Keyless by default; an account's own CONTEXT7_API_KEY raises the limit.", "tools: [docs]"),
  tool("video", "Video (Remotion)", "Motion graphics and video written as React code with Remotion: start a project from a template, list its compositions, render a frame to check, render the video to MP4, WebM, GIF or ProRes. Remotion needs a Company License for companies of four or more.", "tools: [video]\nsize: large"),
  skill("modern-website", "Modern website", "Build a modern, high-end website or web app: Astro for content sites and Next.js for apps when nothing is named, the current stack, design and motion, bundled assets, and the checks a launch-ready site passes.", "skills: [modern-website]\ntools: [write, code, web, docs]"),
  skill("motion-video", "Motion video", "Make motion graphics and short videos as React code with Remotion and the video tool — intros, animated heroes, social clips, title cards, in Persian or English.", "skills: [motion-video]\ntools: [write, code, video, docs]\nsize: large"),
  skill("cloudhost-deploy", "Deploy to cloudhost", "Deploy a website or app to cloudhost (cloudhost.ir) through its MCP tools: where it goes, cloudhost.toml and bindings, previews first and production only on approval, the database, cache, bucket and secrets it needs.", "skills: [cloudhost-deploy, modern-website]\ntools: [write, code, web, docs, cloudhost]"),
  END].join("\n");
let src = fs.readFileSync(galleryTs, "utf8");
const b = src.indexOf(BEGIN);
if (b >= 0) {
  const e = src.indexOf(END, b);
  src = src.slice(0, b) + block + src.slice(e + END.length);
} else {
  const anchor = "\n];\n\n/**\n * A gallery entry as the starting content";
  if (!src.includes(anchor)) throw new Error("anchor not found");
  src = src.replace(anchor, "\n" + block + anchor);
}
fs.writeFileSync(galleryTs, src);
console.log("injected", block.length, "chars");
