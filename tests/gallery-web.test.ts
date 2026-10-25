// `web`: one gallery tool, eight action programs beside its dispatcher.
// The joins that nothing checks at build time: the definition's args are
// exactly the dispatcher's;
// every provider the runtime accepts for a newer action has an adapter with
// its key's vault name and host. And the dispatcher, run for real.
//
//   node --test tests/gallery-web.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync, spawn } from "node:child_process";
import { GALLERY, galleryFiles, materialiseGallery, galleryTemplate } from "../src/gallery.ts";
import { ACTION_APIS } from "../../foldrun-core/src/providers.ts";

const web = GALLERY.find((t) => t.name === "web")!;
const file = (name: string) => web.extra!.find((f) => f.file === `web/${name}.mjs`)!.content;

test("web ships a dispatcher and one program per action, and is the gallery's only web tool", () => {
  assert.ok(web, "a web entry");
  assert.deepEqual(web.extra!.map((f) => f.file).sort(), ["answer", "browse", "crawl", "extract", "fetch", "map", "monitor", "search"].map((a) => `web/${a}.mjs`));
  for (const old of ["web_search", "web_fetch", "web_browse"]) {
    assert.equal(GALLERY.find((t) => t.name === old), undefined, `${old} is gone`);
  }
  assert.equal(galleryFiles(web).length, 10, "definition, dispatcher, eight programs");
});

test("the definition's args are the dispatcher's, action by action", () => {
  const argsBlock = /\nargs:\n([\s\S]*?)\ntimeout:/.exec(web.content)![1];
  const declared = [...argsBlock.matchAll(/^  ([a-z_]+):/gm)].map((m) => m[1]);
  const ARGS = JSON.parse(/const ARGS = (\{[^\n]*\});/.exec(web.wrapper!.content)![1]) as Record<string, string[]>;
  assert.deepEqual(new Set(declared), new Set(["action", ...Object.values(ARGS).flat()]));
  // each action's own args are the ones its program parses
  for (const a of ["crawl", "map", "extract", "answer", "monitor"]) {
    const opts = /parseArgs\(\{\s*options: \{([\s\S]*?)\n  \},/.exec(file(a))![1];
    assert.deepEqual([...opts.matchAll(/^\s+([a-z_]+): \{ type/gm)].map((m) => m[1]), ARGS[a], a);
  }
});

test("every provider the runtime accepts for a newer action, that action's program can call — same key, same host", () => {
  for (const [action, apis] of Object.entries(ACTION_APIS)) {
    const src = file(action);
    for (const api of apis) {
      assert.match(src, new RegExp(`\\b${api.name}: \\{`), `${action}: ${api.name} has an adapter`);
      const block = src.slice(src.search(new RegExp(`\\b${api.name}: \\{`)));
      assert.ok(block.includes(api.secret), `${action}: ${api.name} reads ${api.secret}`);
      assert.ok(block.includes(api.host), `${action}: ${api.name} calls ${api.host}`);
    }
    assert.ok(src.includes(`FOLDRUN_WEB_\${ACTION}_VIA`) && src.includes(`const ACTION = "${action.toUpperCase()}"`), `${action} reads FOLDRUN_WEB_${action.toUpperCase()}_VIA`);
    assert.ok(src.includes("FOLDRUN_EGRESS"), `${action} sends keys through the proxy`);
  }
});

test("laid down, copied as a template, the folder travels whole", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-web-"));
  try {
    const written = materialiseGallery(root);
    for (const f of galleryFiles(web)) assert.ok(written.includes(path.join(f.kind, f.file)), f.file);
    const copy = galleryTemplate("tools", "web", "my-web")!;
    assert.equal(copy.length, 10);
    assert.ok(copy.every((f) => f.file.startsWith("my-web/")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The dispatcher and two of foldrun's own actions, run for real against a
// local site — no network beyond this machine.
async function withSite(fn: (base: string, dir: string, agent: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-web-run-"));
  materialiseGallery(path.join(root, "gallery"));
  const agent = path.join(root, "ws", "agents", "a");
  fs.mkdirSync(agent, { recursive: true });
  const pages: Record<string, string> = {
    "/": '<html><head><title>Home</title><script type="application/ld+json">{"@type":"Organization","name":"Acme"}</script></head><body><p>Welcome to the home page of this small test site.</p><a href="/b">B</a><div class="item"><span class="n">one</span></div><div class="item"><span class="n">two</span></div></body></html>',
    "/b": "<html><head><title>Page B</title></head><body><p>The second page of the site, linked from home.</p></body></html>",
    "/robots.txt": "User-agent: *\nDisallow:\n",
    // Not linked from home, so crawl and map never meet it: fetch's page cap.
    "/big": `<html><head><title>Big</title></head><body>${Array.from({ length: 600 }, (_, i) => `<p>Line ${i} of a long article that goes on.</p>`).join("")}</body></html>`,
  };
  const server = http.createServer((req, res) => {
    const body = pages[req.url ?? ""];
    if (body === undefined) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": req.url === "/robots.txt" ? "text/plain" : "text/html" });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await fn(base, path.join(root, "gallery", "tools", "web"), agent);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const run = (dir: string, cwd: string, args: string[], env: Record<string, string> = {}) =>
  new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const c = spawn(process.execPath, [path.join(dir, "run.mjs"), ...args], { cwd, env: { ...process.env, ...env } });
    let out = "", err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("close", (code) => resolve({ code, out, err }));
  });

test("the dispatcher names a wrong action, a stray argument and a forbidden action, and runs the right one", () =>
  withSite(async (base, dir, agent) => {
    assert.match((await run(dir, agent, ["--action", "nope"])).err, /no action "nope"/);
    const stray = await run(dir, agent, ["--action", "map", "--url", base, "--query", "x"]);
    assert.equal(stray.code, 1);
    assert.match(stray.err, /web action=map does not take query — it takes url, limit, search/);
    assert.match((await run(dir, agent, ["--action", "crawl", "--url", base], { FOLDRUN_WEB_ACTIONS: "search,fetch" })).err, /may not crawl/);
    const crawl = await run(dir, agent, ["--action", "crawl", "--url", `${base}/`, "--limit", "5"]);
    assert.equal(crawl.code, 0, crawl.err);
    assert.match(crawl.out, /^2 pages from 127\.0\.0\.1/);
    const [site] = fs.readdirSync(path.join(agent, "outputs", "crawl"));
    assert.deepEqual(fs.readdirSync(path.join(agent, "outputs", "crawl", site)).sort(), ["001-index.md", "002-b.md", "index.md"]);
  }));

// A fetched page stays in the conversation and is re-sent every turn after,
// so each page is cut at max_output (default 8000) with a closing line that
// counts the rest; a researcher run spent ~470k input tokens on a 3-line
// answer before (FOL-28). max_output reaches fetch now instead of being set
// aside (it was, from 6 Oct 2026, as a browse-only option).
test("fetch cuts each page at max_output, says how much is left, and save= keeps it all", () =>
  withSite(async (base, dir, agent) => {
    const full = (await run(dir, agent, ["--action", "fetch", "--url", `${base}/big`, "--max_output", "20000"])).out;
    assert.ok(full.length > 8000 && full.length <= 20000 + 300, `the page is long: ${full.length}`);
    const d = await run(dir, agent, ["--action", "fetch", "--url", `${base}/big`]);
    assert.equal(d.code, 0, d.err);
    assert.ok(d.out.length < 8300, `cut at the default: ${d.out.length}`);
    assert.match(d.out, /\(…\d+ more characters not shown — max_output= up to 20000 reads more, save= keeps the whole page\)\s*$/);
    // Either spelling: agents write --max_output=1000 as often as --max_output 1000.
    for (const flag of [["--max_output", "1000"], ["--max_output=1000"]]) {
      const small = await run(dir, agent, ["--action", "fetch", "--url", `${base}/big`, ...flag]);
      assert.equal(small.code, 0, small.err);
      assert.ok(small.out.length < 1300, `cut at 1000: ${small.out.length}`);
    }
    assert.match((await run(dir, agent, ["--action", "map", "--url", base, "--query=x"])).err, /does not take query/, "a stray --name=value is still named");
    assert.match((await run(dir, agent, ["--action", "fetch", "--url", `${base}/big`, "--max_output", "50"])).err, /from 200 to 20000/);
    const saved = await run(dir, agent, ["--action", "fetch", "--url", `${base}/big`, "--save", "outputs/big.md"]);
    assert.match(saved.out, /the whole page is in outputs\/big\.md\)\s*$/);
    assert.ok(fs.readFileSync(path.join(agent, "outputs", "big.md"), "utf8").length > 8000, "save= wrote every character");
    // A short page is untouched; several pages are each cut on their own.
    assert.doesNotMatch((await run(dir, agent, ["--action", "fetch", "--url", `${base}/b`])).out, /more characters not shown/);
    const many = await run(dir, agent, ["--action", "fetch", "--urls", `${base}/big,${base}/b`]);
    assert.equal((many.out.match(/more characters not shown/g) ?? []).length, 1, many.out.slice(-400));
  }));

test("extract with no fields returns the page's own JSON-LD; each= gives one row per block", () =>
  withSite(async (base, dir, agent) => {
    const own = await run(dir, agent, ["--action", "extract", "--url", `${base}/`]);
    assert.equal(own.code, 0, own.err);
    assert.match(own.out, /"name": "Acme"/);
    const rows = await run(dir, agent, ["--action", "extract", "--url", `${base}/`, "--each", ".item", "--fields", '{"n":".n"}']);
    assert.match(rows.out, /^2 rows/);
    assert.match(rows.out, /"n": "one"[\s\S]*"n": "two"/);
    // A schema needs a model, so a provider — said, not attempted.
    assert.match((await run(dir, agent, ["--action", "extract", "--url", base, "--prompt", "the name"])).err, /needs a provider — set web\.extract/);
  }));

test("monitor: the first call is the baseline, the next says nothing changed, state lives in the workspace", () =>
  withSite(async (base, dir, agent) => {
    const first = await run(dir, agent, ["--action", "monitor", "--url", `${base}/b`, "--name", "b"]);
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /baseline/);
    assert.match((await run(dir, agent, ["--action", "monitor", "--url", `${base}/b`, "--name", "b"])).out, /nothing new/);
    assert.ok(fs.existsSync(path.join(agent, "..", "..", "state", "web-monitor", "b.json")));
  }));

test("every program at least parses", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-web-parse-"));
  try {
    for (const f of galleryFiles(web).filter((f) => f.file.endsWith(".mjs"))) {
      const p = path.join(root, path.basename(f.file));
      fs.writeFileSync(p, f.content);
      const r = spawnSync(process.execPath, ["--check", p], { encoding: "utf8" });
      assert.equal(r.status, 0, `${f.file}: ${r.stderr}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
