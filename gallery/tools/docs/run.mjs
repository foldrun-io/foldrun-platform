#!/usr/bin/env node
// docs — a library's current documentation, from Context7 (13 Nov 2026).
//
//   search: GET https://context7.com/api/v2/libs/search?libraryName=&query=
//   get:    GET https://context7.com/api/v2/context?libraryId=&query=&type=txt
//
// Checked against https://context7.com/docs/api-guide and the API
// reference on 13 Nov 2026. A key is optional (Authorization: Bearer); with
// none, Context7 serves a low rate. A key bound to context7.com arrives as
// the ${CONTEXT7_API_KEY} placeholder and is filled by the egress proxy: the
// request then goes through FOLDRUN_EGRESS, as the web tool's keyed calls do.
import { parseArgs } from "node:util";
import { writeFileSync, mkdirSync, realpathSync, lstatSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute, sep, join, basename } from "node:path";

const API = "https://context7.com/api";
const KEY_NAME = "CONTEXT7_API_KEY";

class Fail extends Error {}

const { values } = parseArgs({
  options: {
    action: { type: "string" },
    library: { type: "string" },
    query: { type: "string" },
    version: { type: "string" },
    count: { type: "string" },
    max_output: { type: "string" },
    save: { type: "string" },
  },
  strict: true,
  allowPositionals: false,
});

const action = (values.action ?? "").trim().toLowerCase();
const egress = process.env.FOLDRUN_EGRESS?.replace(/\/+$/, "");
const key = process.env[KEY_NAME] ?? "";
const isPlaceholder = /^\$\{[A-Z][A-Z0-9_]*\}$/.test(key);

/** One call, with the two retries a busy index deserves. Lookups only. */
async function call(pathAndQuery, accept = "application/json") {
  const target = `${API}${pathAndQuery}`;
  const url = key && isPlaceholder && egress ? `${egress}/${target}` : target;
  const headers = { accept, "user-agent": "foldrun-docs-tool/1" };
  if (key) headers.authorization = `Bearer ${key}`;
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(45_000) });
    } catch (err) {
      if (attempt < 2) { await sleep(attempt ? 6000 : 2000); continue; }
      throw new Fail(`Context7 unreachable: ${err instanceof Error ? err.message : err}`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      const after = Number(res.headers.get("retry-after"));
      await res.body?.cancel();
      await sleep(Number.isFinite(after) && after > 0 && after <= 30 ? after * 1000 : attempt ? 6000 : 2000);
      continue;
    }
    break;
  }
  return res;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms + Math.random() * 300));

async function failFor(res, library) {
  let detail = "";
  try {
    const body = await res.text();
    try {
      const j = JSON.parse(body);
      detail = j.message || j.error || "";
      if (j.redirectUrl) return new Fail(`${library} has moved — use library=${j.redirectUrl}`);
    } catch {
      detail = body.slice(0, 200);
    }
  } catch {}
  switch (res.status) {
    case 301: case 302: case 307: case 308: {
      const to = res.headers.get("location");
      return new Fail(`${library} has moved${to ? ` — use library=${to.replace(/^.*\/libs?\//, "/")}` : ""}`);
    }
    case 202: return new Fail(`${library} is still being indexed by Context7 — try again in a few minutes, or read its docs site with web action=fetch`);
    case 401: case 403: return new Fail(`Context7 refused the key (${res.status}) — check ${KEY_NAME} with \`foldrun secrets\`${detail ? `: ${detail}` : ""}`);
    case 402: return new Fail(`Context7's spending limit for this key is reached (402) — raise it at context7.com, or unset ${KEY_NAME} for the keyless rate`);
    case 404: return new Fail(`Context7 has nothing for ${library}${detail ? ` (${detail})` : ""} — try action=search, another version, or a different query`);
    case 429: return new Fail(`Context7's rate limit is reached (429)${key ? "" : ` — keyless calls share a low limit; set ${KEY_NAME} for your own`}`);
    default: return new Fail(`Context7 answered ${res.status}${detail ? `: ${detail}` : ""}`);
  }
}

function needQuery() {
  const q = (values.query ?? "").trim();
  if (!q) throw new Fail(`docs action=${action} needs query= — what you are doing with the library, in a sentence`);
  if (q.length > 500) throw new Fail("query= is at most 500 characters");
  return q;
}

async function search(name, query, count) {
  const qs = new URLSearchParams({ libraryName: name, query });
  const res = await call(`/v2/libs/search?${qs}`);
  if (!res.ok) throw await failFor(res, name);
  const body = await res.json();
  const results = Array.isArray(body?.results) ? body.results : [];
  return results.slice(0, count);
}

function describe(r, i) {
  const bits = [
    r.trustScore !== undefined ? `trust ${r.trustScore}/10` : null,
    r.benchmarkScore !== undefined ? `benchmark ${r.benchmarkScore}` : null,
    r.totalSnippets !== undefined ? `${r.totalSnippets} snippets` : null,
    r.stars ? `${r.stars} stars` : null,
    r.lastUpdateDate ? `updated ${String(r.lastUpdateDate).slice(0, 10)}` : null,
  ].filter(Boolean);
  const versions = Array.isArray(r.versions) && r.versions.length ? `\n   versions: ${r.versions.slice(0, 8).join(", ")}${r.versions.length > 8 ? ` (+${r.versions.length - 8} more)` : ""}` : "";
  return `${i + 1}. ${r.title ?? r.id} — id ${r.id}\n   ${r.description ?? ""}\n   ${bits.join(" · ")}${versions}`;
}

/** Inside the workspace or the agent's own folder, never beside them. */
function safePath(rel) {
  const abs = resolve(process.cwd(), rel);
  const root = resolve(process.cwd(), "..", "..");
  const back = relative(root, abs);
  if (back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back)) throw new Fail(`save= ${rel} is outside the workspace`);
  // And once links are resolved: `workspace/…` goes through the agent
  // folder's own link to the root, which is inside; any other link is not.
  return confined(abs, root, `save= ${rel}`);
}

/** The real path of `abs`, symlinks resolved, refused unless it is inside
 *  `root`. A part that does not exist yet is taken as written below its
 *  deepest existing parent; a link that leads nowhere is refused, because
 *  writing through it would land wherever it points (Codex review). */
function confined(abs, root, what) {
  const realRoot = realpathSync(root);
  const rest = [];
  let probe = abs;
  for (;;) {
    try { lstatSync(probe); break; } catch {}
    const up = dirname(probe);
    if (up === probe) break;
    rest.unshift(basename(probe));
    probe = up;
  }
  let base;
  try { base = realpathSync(probe); } catch { throw new Fail(`${what} goes through a link that leads nowhere`); }
  const real = rest.length ? join(base, ...rest) : base;
  const back = relative(realRoot, real);
  if (back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back)) throw new Fail(`${what} is outside the workspace`);
  return real;
}


async function main() {
  if (action !== "search" && action !== "get") throw new Fail(`docs needs action=: search or get (got "${values.action ?? ""}")`);
  const library = (values.library ?? "").trim();
  if (!library) throw new Fail(`docs action=${action} needs library= — ${action === "search" ? "a name, e.g. next.js" : "an id from action=search (/vercel/next.js) or a name"}`);
  const query = needQuery();

  if (action === "search") {
    const count = Math.min(10, Math.max(1, Number(values.count) || 5));
    const found = await search(library, query, count);
    if (!found.length) {
      console.log(`No library in Context7's index matches "${library}". Read its own docs site with web action=fetch instead.`);
      return;
    }
    console.log(`Libraries matching "${library}" (pass the id to docs action=get):\n\n${found.map(describe).join("\n\n")}`);
    return;
  }

  // get — where a saved copy goes is checked before anything is asked.
  const savePath = values.save ? safePath(values.save) : null;
  let id = library;
  let chose = "";
  if (!id.startsWith("/")) {
    const [best] = await search(library, query, 1);
    if (!best) throw new Fail(`No library in Context7's index matches "${library}" — read its docs site with web action=fetch`);
    id = best.id;
    chose = `(library=${library} → ${best.title ?? id}, id ${id}; pass the id to skip this lookup)\n\n`;
  }
  const version = (values.version ?? "").trim().replace(/^@/, "");
  if (version) {
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(version)) throw new Fail(`version= "${version}" is not a version — e.g. 16.2 or v16.2.9`);
    id = `${id.replace(/\/+$/, "").replace(/@[^/]*$/, "")}/${/^\d/.test(version) ? `v${version}` : version}`;
  }
  const qs = new URLSearchParams({ libraryId: id, query, type: "txt" });
  const res = await call(`/v2/context?${qs}`, "text/plain");
  if (!res.ok) throw await failFor(res, id);
  const text = (await res.text()).trim();
  if (!text) throw new Fail(`Context7 returned nothing for ${id} — try a different query`);

  const cap = values.max_output === undefined ? 15000 : Number(values.max_output);
  if (!Number.isInteger(cap) || cap < 2000 || cap > 60000) throw new Fail("max_output= is a whole number from 2000 to 60000");
  let saved = "";
  if (savePath) {
    const abs = savePath;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `# ${id}\n\n${text}\n`);
    saved = values.save;
  }
  const head = `${chose}# ${id}${version ? "" : " (latest indexed)"}\n\n`;
  const body = text.length > cap
    ? `${text.slice(0, cap)}\n\n(…${text.length - cap} more characters — ${saved ? `the whole answer is in ${saved}` : "max_output= up to 60000 reads more, save= keeps it all"})`
    : text;
  console.log(head + body + (saved && text.length <= cap ? `\n\n(also saved to ${saved})` : ""));
}

main().catch((err) => {
  console.error(err instanceof Fail ? `docs: ${err.message}` : `docs: ${err?.stack ?? err}`);
  process.exit(1);
});
