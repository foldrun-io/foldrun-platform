// web action=search against a search API holds the call's options, whatever
// the API itself supports: site= is enforced on what comes back (Brave and
// Parallel have no domain filter), and time_range= on an API that cannot
// filter by date is refused, never quietly dropped. Runs the gallery's real
// program with fetch stubbed — no network.
//
//   node --test tests/web-search-providers.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { GALLERY } from "../src/gallery.ts";

const program = GALLERY.find((t) => t.name === "web")!.extra!.find((f) => f.file === "web/search.mjs")!.content;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-web-search-"));
const file = path.join(dir, "search.mjs");
fs.writeFileSync(file, program);

// A stub fetch: records the request and answers in the provider's shape with
// results from three domains.
const stub = path.join(dir, "stub.mjs");
fs.writeFileSync(stub, `
const fs = await import("node:fs");
globalThis.fetch = async (url, init) => {
  fs.appendFileSync(${JSON.stringify(path.join(dir, "requests.log"))}, String(url) + " " + (init?.body ?? "") + "\\n");
  const rows = [
    { title: "A", url: "https://www.example.com/a", description: "a", snippet: "a", excerpts: ["a"] },
    { title: "B", url: "https://blog.example.com/b", description: "b", snippet: "b", excerpts: ["b"] },
    { title: "C", url: "https://other.org/c", description: "c", snippet: "c", excerpts: ["c"] },
  ];
  const body = { web: { results: rows }, results: rows };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};
`);

function search(via: string, secret: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", stub, file, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, FOLDRUN_WEB_SEARCH_VIA: via, [secret]: "k" },
  });
}

test("site= is enforced on Brave's results, and asked of Brave in the query", () => {
  const r = search("brave", "BRAVE_SEARCH_API_KEY", ["--query", "strata", "--site", "example.com"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /www\.example\.com\/a/);
  assert.match(r.stdout, /blog\.example\.com\/b/, "a subdomain of the site counts");
  assert.doesNotMatch(r.stdout, /other\.org/, "another domain never comes back");
  assert.match(fs.readFileSync(path.join(dir, "requests.log"), "utf8"), /q=site%3Aexample\.com\+strata/);
});

test("site= is enforced on Parallel's results too", () => {
  const r = search("parallel", "PARALLEL_API_KEY", ["--query", "strata", "--site", "example.com"]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /other\.org/);
});

test("time_range= on an API that cannot filter by date is refused, by name", () => {
  for (const [via, secret, label] of [["parallel", "PARALLEL_API_KEY", "Parallel"], ["jina", "JINA_API_KEY", "Jina Search"], ["dataforseo", "DATAFORSEO_AUTH_BASIC", "DataForSEO"]]) {
    const r = search(via, secret, ["--query", "strata", "--time_range", "week"]);
    assert.equal(r.status, 1, `${via} should refuse`);
    assert.match(r.stderr, new RegExp(`${label} cannot filter by date`));
  }
  const ok = search("brave", "BRAVE_SEARCH_API_KEY", ["--query", "strata", "--time_range", "week"]);
  assert.equal(ok.status, 0, "an API that can filter by date is asked to");
});

test("site= written as a URL or in capitals is read as its hostname, not filtered to nothing", () => {
  for (const site of ["https://example.com", "https://www.example.com/", "WWW.Example.com", "http://example.com:443"]) {
    fs.rmSync(path.join(dir, "requests.log"), { force: true });
    const r = search("brave", "BRAVE_SEARCH_API_KEY", ["--query", "strata", "--site", site]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /www\.example\.com\/a/, site);
    assert.match(r.stdout, /blog\.example\.com\/b/, site);
    assert.doesNotMatch(r.stdout, /other\.org/, site);
    assert.match(fs.readFileSync(path.join(dir, "requests.log"), "utf8"), /q=site%3Aexample\.com\+strata/, `${site}: the API is asked for the hostname`);
  }
});

test("site= with a path is refused in words, not filtered to nothing", () => {
  const r = search("brave", "BRAVE_SEARCH_API_KEY", ["--query", "strata", "--site", "example.com/blog"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /site= is a domain.*example\.com\/blog/);
});

test("an API that cannot filter by domain is asked for more than count when site= will filter", () => {
  fs.rmSync(path.join(dir, "requests.log"), { force: true });
  const r = search("parallel", "PARALLEL_API_KEY", ["--query", "strata", "--site", "example.com", "--count", "3"]);
  assert.equal(r.status, 0, r.stderr);
  const body = JSON.parse(fs.readFileSync(path.join(dir, "requests.log"), "utf8").replace(/^\S+ /, ""));
  assert.ok(body.max_results > 3, `asked for ${body.max_results}`);
  fs.rmSync(path.join(dir, "requests.log"), { force: true });
  search("parallel", "PARALLEL_API_KEY", ["--query", "strata", "--count", "3"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "requests.log"), "utf8").replace(/^\S+ /, "")).max_results, 3, "no site=, no extra");
});

test("a provider that times out or answers 503 is asked again, and a third failure is reported", () => {
  const flaky = path.join(dir, "flaky.mjs");
  const count = path.join(dir, "flaky.count");
  fs.writeFileSync(flaky, `
const fs = await import("node:fs");
globalThis.fetch = async () => {
  const n = (fs.existsSync(${JSON.stringify(count)}) ? Number(fs.readFileSync(${JSON.stringify(count)}, "utf8")) : 0) + 1;
  fs.writeFileSync(${JSON.stringify(count)}, String(n));
  const failUntil = Number(process.env.FAIL_UNTIL);
  if (n <= failUntil) {
    if (n % 2) throw new TypeError("fetch failed");
    return new Response("busy", { status: 503 });
  }
  const rows = [{ title: "A", url: "https://www.example.com/a", description: "a", snippet: "a", excerpts: ["a"] }];
  return new Response(JSON.stringify({ web: { results: rows }, results: rows }), { status: 200, headers: { "content-type": "application/json" } });
};
`);
  const run = (failUntil: number) => {
    fs.rmSync(count, { force: true });
    return spawnSync(process.execPath, ["--import", flaky, file, "--query", "strata"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, FOLDRUN_WEB_SEARCH_VIA: "brave", BRAVE_SEARCH_API_KEY: "k", FOLDRUN_WEB_RETRY_MS: "1", FAIL_UNTIL: String(failUntil) },
    });
  };
  const ok = run(2);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /example\.com\/a/);
  assert.equal(fs.readFileSync(count, "utf8"), "3", "a network error, a 503, then the answer");
  const gone = run(5);
  assert.notEqual(gone.status, 0);
  assert.match(gone.stderr, /unreachable: fetch failed/);
  assert.equal(fs.readFileSync(count, "utf8"), "3", "three tries, then it says so");
});
