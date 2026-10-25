// The web tools' programs, where they touch the machine: files they write
// stay in the agent's directory, a browser call cleans up when the step is
// killed, a vendor session is released (or says it was not), numbered
// elements belong to the page they were read on, and a download by URL is a
// navigation like any other. Pieces are lifted out of the programs where
// running the whole thing would need a browser.
//
//   node --test tests/web-tools-hardening.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { GALLERY } from "../src/gallery.ts";

const web = GALLERY.find((t) => t.name === "web")!;
const program = (file: string) => web.extra!.find((e) => e.file === file)!.content;
const browse = program("web/browse.mjs");
const between = (src: string, from: string, to: string) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${from} … ${to} in the program`);
  return src.slice(a, b);
};

function tmp() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "web-hardening-")));
  const cwd = path.join(root, "agents", "a");
  fs.mkdirSync(cwd, { recursive: true });
  return { root, cwd, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function run(file: string, args: string[], cwd: string) {
  const p = path.join(cwd, "..", path.basename(file));
  fs.writeFileSync(p, program(file));
  return spawnSync(process.execPath, [p, ...args], { cwd, encoding: "utf8", timeout: 20_000, env: { ...process.env, FOLDRUN_EGRESS: "" } });
}

test("fetch, extract and crawl refuse to write outside the agent directory, before any request", () => {
  const t = tmp();
  try {
    const outside = path.join(t.root, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(t.cwd, "link"));
    const cases: [string, string[]][] = [
      ["web/fetch.mjs", ["--url", "http://127.0.0.1:9/", "--save"]],
      ["web/extract.mjs", ["--url", "http://127.0.0.1:9/", "--save"]],
      ["web/crawl.mjs", ["--url", "http://127.0.0.1:9/", "--out"]],
    ];
    for (const [file, args] of cases) {
      for (const bad of ["../escape.json", "/etc/foldrun-escape.json", "link/through-a-symlink.json"]) {
        const r = run(file, [...args, bad], t.cwd);
        assert.equal(r.status, 1, `${file} ${bad}: ${r.stdout}${r.stderr}`);
        assert.match(r.stderr, /is outside the agent directory/, `${file} ${bad}`);
      }
    }
    assert.deepEqual(fs.readdirSync(outside), [], "nothing was written through the link");
    assert.ok(!fs.existsSync(path.join(t.root, "escape.json")));
  } finally {
    t.done();
  }
});

test("a path inside the agent directory is still written", async () => {
  const t = tmp();
  // A page that is not text is saved; a server in another process answers,
  // since spawnSync holds this one.
  const server = spawn(process.execPath, ["-e", `require("http").createServer((q,r)=>{r.writeHead(200,{"content-type":"application/pdf"});r.end("%PDF-1")}).listen(0,"127.0.0.1",function(){console.log(this.address().port)})`]);
  try {
    const port = await new Promise<string>((r) => server.stdout.once("data", (d) => r(String(d).trim())));
    const r = run("web/fetch.mjs", ["--url", `http://127.0.0.1:${port}/x.pdf`, "--save", "outputs/x.pdf"], t.cwd);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(t.cwd, "outputs", "x.pdf"), "utf8"), "%PDF-1");
  } finally {
    server.kill();
    t.done();
  }
});

test("browse: SIGTERM and SIGINT leave through process.exit, so every exit handler runs", async () => {
  const handlers = between(browse, "for (const [sig, code] of [[\"SIGTERM\"", "const playwright = loadPlaywright();");
  const t = tmp();
  try {
    const marker = path.join(t.cwd, "cleaned");
    const script = path.join(t.cwd, "sig.mjs");
    // An exit handler the way the program registers them (Xvfb, the engine,
    // the profile, the vendor release), then the handlers, then a wait.
    fs.writeFileSync(script, `import fs from "node:fs";\nprocess.on("exit", () => fs.writeFileSync(${JSON.stringify(marker)}, "yes"));\n${handlers}\nconsole.log("ready");\nsetInterval(() => {}, 1000);\n`);
    for (const [sig, code] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
      fs.rmSync(marker, { force: true });
      const c = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
      await new Promise((r) => c.stdout.once("data", r));
      c.kill(sig);
      const exit = await new Promise<number | null>((r) => c.on("close", (n) => r(n)));
      assert.equal(exit, code, sig);
      assert.equal(fs.readFileSync(marker, "utf8"), "yes", `${sig}: the exit handler ran`);
    }
  } finally {
    t.done();
  }
});

test("browse: a vendor session is released with a real timeout, and a failed release is said", async () => {
  const lifted = between(browse, "const RELEASE_CHILD = ", "\nasync function vendorPlan");
  assert.doesNotMatch(lifted, /JSON\.stringify\(\{[^}]*signal/, "no AbortSignal is serialised");
  const said: string[] = [];
  const fakeFs = { writeSync: (_fd: number, text: string) => said.push(text) };
  const releaseSession = new Function("spawnSync", "fs", "process", `${lifted}\nreturn releaseSession;`)(spawnSync, fakeFs, process) as (
    r: { url: string; method: string; headers: Record<string, string> },
    label: string,
  ) => void;

  // The release runs synchronously (it is called from an "exit" handler), so
  // the vendor stands in from another process.
  const t = tmp();
  const log = path.join(t.cwd, "seen.json");
  const server = spawn(process.execPath, ["-e", `require("http").createServer((q,r)=>{require("fs").writeFileSync(${JSON.stringify(log)},JSON.stringify({m:q.method,u:q.url,k:q.headers["x-key"]}));r.end("{}")}).listen(0,"127.0.0.1",function(){console.log(this.address().port)})`]);
  try {
    const port = await new Promise<string>((r) => server.stdout.once("data", (d) => r(String(d).trim())));
    releaseSession({ url: `http://127.0.0.1:${port}/v1/sessions/st-1/release`, method: "POST", headers: { "x-key": "K" } }, "Steel");
    assert.deepEqual(JSON.parse(fs.readFileSync(log, "utf8")), { m: "POST", u: "/v1/sessions/st-1/release", k: "K" });
    assert.deepEqual(said, [], "a release that worked says nothing");

    releaseSession({ url: "http://127.0.0.1:9/nobody", method: "POST", headers: {} }, "Hyperbrowser");
    assert.equal(said.length, 1);
    assert.match(said[0], /could not release the Hyperbrowser session/);
  } finally {
    server.kill();
    t.done();
  }
});

test("browse: numbered elements belong to the page they were read on", () => {
  const samePage = new Function(`${between(browse, "function samePage(", "\nasync function refTarget")}\nreturn samePage;`)() as (a: string, b: string) => boolean;
  assert.ok(samePage("https://a.example/list?page=2", "https://a.example/list?page=3"), "a query may change under it");
  assert.ok(samePage("https://a.example/list/", "https://a.example/list#top"));
  assert.ok(!samePage("https://a.example/list", "https://a.example/item/7"), "another path is another page");
  assert.ok(!samePage("https://a.example/list", "https://b.example/list"), "another origin too");
  const refTarget = between(browse, "async function refTarget(", "\n}\n");
  assert.match(refTarget, /if \(saved\.url && !samePage\(saved\.url, page\.url\(\)\)\)/, "checked before any element is looked for");
  assert.match(refTarget, /read this page with mode=aria and use its numbers/);
});

test("browse: a download by URL is a navigation — deny: goto covers it and allowed_domains holds", () => {
  assert.match(browse, /if \(kind === "download" && \/\^https\?:\\\/\\\/\/i\.test\(String\(step\[kind\]\)\)\) denyAs\("goto", "download with a url"\);/);
  const download = between(browse, "    case \"download\": {", "arrivedDownloads.length = 0;");
  assert.match(download, /if \(byUrl\) checkAllowed\(v\);/);
  assert.match(browse, /async function navigate\(p, url\) \{\n  checkAllowed\(url\);/, "navigate and download share one check");
});
