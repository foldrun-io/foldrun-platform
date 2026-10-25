// The assistant's library: foldrun's customer docs, and nothing else.
//
// The set is foldrun-docs/customer-docs.mjs's — the same pages the CLI ships
// for a coding agent: no design records, no operator routes. The web reads
// the live checkout when there is one (it registers that source at boot);
// everything else — the worker that runs replies, an image whose foldrun-docs
// was deleted after the build — reads the bundle written before the build.
//
// Search is lexical (BM25 over sections, a heading counting twice): the docs
// are ~600 KB of plain English with a fixed vocabulary — `when:`, `each:`,
// `transport: script` — where the exact word is what the asker types and
// what the answer is filed under. No embeddings, no service, no index to
// rebuild.

import fs from "node:fs";
import path from "node:path";

let sectionCache: DocSection[] | null = null;
let vocabularyCache: Set<string> | null = null;

export interface DocSection {
  /** The doc's slug: flows, agents, tools… */
  doc: string;
  /** The doc's own title, from its `#` line. */
  docTitle: string;
  /** The heading this section sits under; "" for the text before the first. */
  heading: string;
  /** The headings above it, for a citation: ["Reaching the web", "Engines"]. */
  trail: string[];
  /** The id the dashboard's docs page gives the heading (components/markdown.tsx). */
  anchor: string;
  level: number;
  text: string;
}

/** Where the docs come from: `{ "flows.md": text, … }`, or null. */
export type DocsSource = () => Record<string, string> | null;

/**
 * The bundle the image writes before `next build` (scripts/assistant-docs.mjs
 * in foldrun-web): assistant-docs.json in the process's working directory —
 * foldrun-web for the web, foldrun-platform for the worker — or
 * FOLDRUN_ASSISTANT_DOCS. The web replaces this with the live docs when the
 * foldrun-docs checkout is beside it (registerDocsSource, at boot).
 */
const bundleSource: DocsSource = () => {
  const file = process.env.FOLDRUN_ASSISTANT_DOCS || path.join(process.cwd(), "assistant-docs.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
  } catch {
    return null;
  }
};

let source: DocsSource = bundleSource;

/** Use these docs instead of the bundle — the web's live checkout, a test's fixture. */
export function registerDocsSource(next: DocsSource | null) {
  source = next ?? bundleSource;
  cache = null;
  sectionCache = null;
  vocabularyCache = null;
}

let cache: { at: number; docs: Record<string, string> | null } | null = null;

/** `{ "flows.md": text, … }`, or null when this build has no docs at all. */
export function assistantDocs(): Record<string, string> | null {
  // In production the set cannot change under a running process; on a dev
  // machine a docs edit shows within a minute.
  if (cache && (process.env.NODE_ENV === "production" || Date.now() - cache.at < 60_000)) return cache.docs;
  let docs = source();
  if (docs && !Object.keys(docs).length) docs = null;
  cache = { at: Date.now(), docs };
  sectionCache = null;
  vocabularyCache = null;
  return docs;
}

/** The same id components/markdown.tsx gives a heading. */
export function anchorOf(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}


/** Every doc cut at its ##, ### and #### headings. A fenced block is never cut. */
export function docSections(): DocSection[] {
  const docs = assistantDocs();
  if (!docs) return [];
  if (sectionCache) return sectionCache;
  const out: DocSection[] = [];
  for (const [file, text] of Object.entries(docs)) {
    const doc = file.replace(/\.md$/, "");
    const docTitle = /^# (.+)$/m.exec(text)?.[1].trim() ?? doc;
    const trail: string[] = [];
    let current: DocSection = { doc, docTitle, heading: "", trail: [], anchor: "", level: 1, text: "" };
    let fenced = false;
    const flush = () => {
      if (current.text.trim()) out.push({ ...current, text: current.text.trim() });
    };
    for (const line of text.split("\n")) {
      if (/^\s*```/.test(line)) fenced = !fenced;
      const h = fenced ? null : /^(#{2,4}) (.+)$/.exec(line);
      if (!h) {
        if (!/^# /.test(line) || current.heading) current.text += `${line}\n`;
        continue;
      }
      flush();
      const level = h[1].length;
      const heading = h[2].trim();
      trail.length = Math.max(0, level - 2);
      trail.push(heading);
      current = { doc, docTitle, heading, trail: [...trail], anchor: anchorOf(heading), level, text: `${line}\n` };
    }
    flush();
  }
  sectionCache = out;
  return out;
}

const STOP = new Set(
  "a an and are as at be by can do does for from has have how i if in is it its me my no not of on or so that the their them then there these this to was what when where which who why will with you your".split(" "),
);

/** A light stem, so "approve", "approval" and "approved" meet. Names with a
 *  dot or a dash (`web.search`, `on-fail`) are kept whole. */
function stem(t: string): string {
  if (t.length <= 4 || /[._-]/.test(t)) return t;
  return t.replace(/(ings?|ed|es|s|als?|ly)$/, "").replace(/e$/, "");
}

/** Words, keeping the shapes foldrun's vocabulary is made of: `on-fail`, `web.search`, `each:`. */
export function terms(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9._-]*[a-z0-9]|[a-z0-9]/g) ?? []).filter((t) => !STOP.has(t)).map(stem);
}

export interface DocHit {
  doc: string;
  docTitle: string;
  section: string;
  anchor: string;
  url: string;
  text: string;
  score: number;
}

export function docUrl(doc: string, anchor: string): string {
  return `/dashboard/docs/${doc}${anchor ? `#${anchor}` : ""}`;
}

/** The best sections for a query, BM25, each cut to `snippet` characters. */
export function searchDocs(query: string, k = 6, snippet = 1_600): DocHit[] {
  const sections = docSections();
  const q = [...new Set(terms(query))];
  if (!q.length || !sections.length) return [];
  const bags = sections.map((s) => terms(`${s.trail.join(" ")} ${s.trail.join(" ")} ${s.text}`));
  const avg = bags.reduce((n, b) => n + b.length, 0) / bags.length;
  const df = new Map<string, number>();
  for (const b of bags) for (const t of new Set(b)) df.set(t, (df.get(t) ?? 0) + 1);
  const N = bags.length;
  const scored = bags.map((bag, i) => {
    const tf = new Map<string, number>();
    for (const t of bag) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      score += (idf * f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (bag.length / avg)));
    }
    return { i, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ i, score }) => {
      const s = sections[i];
      return {
        doc: s.doc,
        docTitle: s.docTitle,
        section: s.trail.join(" › ") || s.docTitle,
        anchor: s.anchor,
        url: docUrl(s.doc, s.anchor),
        text: s.text.length > snippet ? `${s.text.slice(0, snippet)}\n… (read_doc for the rest)` : s.text,
        score: Math.round(score * 100) / 100,
      };
    });
}

/**
 * One doc, or one section of it with everything under that heading. Without
 * a section a long doc answers with its outline and its opening, so the
 * model asks for the part it needs rather than reading 100 KB.
 */
export function readDoc(doc: string, section: string | undefined, max = 24_000): { ok: true; text: string; url: string } | { ok: false; error: string } {
  const docs = assistantDocs();
  const slug = doc.replace(/\.md$/, "").trim().toLowerCase();
  const text = docs?.[`${slug}.md`];
  if (!docs || text === undefined) {
    return { ok: false, error: `no doc "${doc}" — the docs are: ${Object.keys(docs ?? {}).map((f) => f.replace(/\.md$/, "")).join(", ")}` };
  }
  const sections = docSections().filter((s) => s.doc === slug);
  if (section && section.trim()) {
    const want = section.trim().toLowerCase().replace(/^#+\s*/, "");
    const i =
      sections.findIndex((s) => s.heading.toLowerCase() === want || s.anchor === anchorOf(want)) >= 0
        ? sections.findIndex((s) => s.heading.toLowerCase() === want || s.anchor === anchorOf(want))
        : sections.findIndex((s) => s.heading.toLowerCase().includes(want));
    if (i < 0) return { ok: false, error: `no section "${section}" in ${slug} — its headings: ${sections.filter((s) => s.heading).map((s) => s.heading).join(" · ")}` };
    const head = sections[i];
    let body = head.text;
    for (let j = i + 1; j < sections.length && sections[j].level > head.level; j++) body += `\n\n${sections[j].text}`;
    return { ok: true, text: cut(body, max, slug), url: docUrl(slug, head.anchor) };
  }
  if (text.length <= max) return { ok: true, text, url: docUrl(slug, "") };
  const outline = sections.filter((s) => s.heading && s.level <= 3).map((s) => `${"  ".repeat(s.level - 2)}- ${s.heading}`).join("\n");
  return {
    ok: true,
    text: `${slug} is ${Math.round(text.length / 1000)} KB — read the section you need: read_doc { doc: "${slug}", section: "<heading>" }.\n\nIts headings:\n${outline}\n\nIt opens:\n${text.slice(0, 6_000)}`,
    url: docUrl(slug, ""),
  };
}

function cut(text: string, max: number, slug: string): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n\n… (cut at ${max} characters — read a narrower section of ${slug})`;
}

/** Every doc and its ## headings, for the system prompt: where to look. */
export function docsOutline(): string {
  const docs = assistantDocs();
  if (!docs) return "";
  const sections = docSections();
  return Object.keys(docs)
    .map((file) => {
      const doc = file.replace(/\.md$/, "");
      const own = sections.filter((s) => s.doc === doc);
      const title = own[0]?.docTitle ?? doc;
      const heads = own.filter((s) => s.level === 2).map((s) => s.heading.replace(/`/g, ""));
      return `- ${doc} (${title}): ${heads.join(" · ")}`;
    })
    .join("\n");
}


/**
 * Every name the docs spell as code: `model`, `on-fail`, `transport` — in
 * backticks, or as a key at the start of a line in a fenced block. A
 * frontmatter key outside this set is one the docs never describe, which is
 * the assistant's line between what foldrun reads and what a model made up.
 */
export function documentedNames(): Set<string> {
  const docs = assistantDocs();
  if (vocabularyCache) return vocabularyCache;
  const names = new Set<string>();
  for (const text of Object.values(docs ?? {})) {
    for (const m of text.matchAll(/`([^`\n]{1,200})`/g)) {
      for (const k of m[1].matchAll(/(?:^|[\s{[,(])([A-Za-z_][\w-]*)\s*:/g)) names.add(k[1]);
      const bare = /^([A-Za-z_][\w.-]*)$/.exec(m[1].trim());
      if (bare) names.add(bare[1]);
    }
    let fenced = false;
    for (const line of text.split("\n")) {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        continue;
      }
      if (!fenced) continue;
      const key = /^\s*(?:-\s+)?([A-Za-z_][\w-]*)\s*:/.exec(line);
      if (key) names.add(key[1]);
    }
  }
  vocabularyCache = names;
  return names;
}
