#!/usr/bin/env node
// Edit a program the gallery ships as a string literal in src/gallery.ts —
// web/browse.mjs above all — as an ordinary file, without a noisy diff.
//
//   node scripts/gallery-file.mjs web/browse.mjs extract /tmp/browse.mjs
//   …edit /tmp/browse.mjs, run it, test it…
//   node scripts/gallery-file.mjs web/browse.mjs inject /tmp/browse.mjs
//
// The literals mix escaped and raw non-ASCII, so a plain JSON.stringify of the
// whole program would rewrite every line. inject keeps the original encoding
// of every line that did not change and encodes only the new ones; a no-edit
// round trip leaves `git diff` empty. (Generated entries — docs, video, the
// skills — come from gallery/ through scripts/gallery-inject.mjs instead.)
//
// GALLERY_TS=<path> works on another copy of gallery.ts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const [name, verb, other] = process.argv.slice(2);
if (!name || !["extract", "inject"].includes(verb) || !other) {
  console.error("usage: node scripts/gallery-file.mjs <file in the gallery, e.g. web/browse.mjs> extract <out> | inject <edited>");
  process.exit(2);
}
const ts = process.env.GALLERY_TS ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "gallery.ts");
const src = fs.readFileSync(ts, "utf8");
const marker = `{ file: ${JSON.stringify(name)}, content: "`;
const at = src.indexOf(marker);
if (at < 0 || src.indexOf(marker, at + 1) >= 0) throw new Error("marker not found exactly once");
const start = at + marker.length;
// The closing quote: walk the escapes.
let i = start;
while (src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
const raw = src.slice(start, i);
// Split on the \n escape, never on a backslash-n inside the program.
const rawLines = [];
let cur = "", j = 0;
while (j < raw.length) {
  if (raw[j] === "\\") {
    if (raw[j + 1] === "n") { rawLines.push(cur); cur = ""; j += 2; continue; }
    cur += raw.slice(j, j + 2); j += 2; continue;
  }
  cur += raw[j]; j++;
}
rawLines.push(cur);
const decode = (r) => JSON.parse(`"${r}"`);
const decoded = rawLines.map(decode);
if (decoded.join("\n") !== JSON.parse(`"${raw}"`)) throw new Error("line split does not round-trip");
if (verb === "extract") { fs.writeFileSync(other, decoded.join("\n")); console.log(`extracted ${decoded.length} lines`); }
else if (verb === "inject") {
  const want = fs.readFileSync(other, "utf8").split("\n");
  const pool = new Map();
  decoded.forEach((d, k) => { if (!pool.has(d)) pool.set(d, rawLines[k]); });
  const enc = (l) => JSON.stringify(l).slice(1, -1);
  let reused = 0, fresh = 0;
  const out = want.map((l) => { if (pool.has(l)) { reused++; return pool.get(l); } fresh++; return enc(l); });
  const newRaw = out.join("\\n");
  if (JSON.parse(`"${newRaw}"`) !== want.join("\n")) throw new Error("encoding does not round-trip");
  fs.writeFileSync(ts, src.slice(0, start) + newRaw + src.slice(i));
  console.log(`injected: ${reused} lines kept, ${fresh} new or changed`);
}
