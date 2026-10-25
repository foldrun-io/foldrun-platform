// No bare fetch() to a URL a tenant chose (FOL-85). This code runs on the web
// and worker tiers, which reach the cluster's services and their own loopback,
// so a tenant's URL goes through fetchPublic (ssrf.ts) — or core's
// fetchUntrusted, which is fetchPublic here — and is refused inward, checked
// at every redirect hop, and read to a limit. A bare fetch() skips all of it.
//
// So every raw request in src/ is counted, per file, against the list below.
// A new one fails here until it goes through fetchPublic or is added with the
// reason its URL is not the tenant's. A count that drops fails too, so the
// list never outlives what it excuses.
//
//   node --test tests/raw-fetch-scan.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PRIVATE } from "./billing-boundary-lists.ts";

const SRC = path.join(import.meta.dirname, "..", "src");

/** A call, not a method of something else (`hop_.fetch(`), nor a longer
 *  name (`fetchPublic(`). */
const RAW = /(^|[^.\w$])(fetch|undiciFetch)\(|\bhttps?\.(request|get)\(/g;

const ALLOWED: Record<string, { count: number; why: string }> = {
  "ssrf.ts": { count: 3, why: "the guard itself: one hop on its public-only (or client-certificate) dispatcher, and plain fetch only when FOLDRUN_EGRESS_ALLOW_PRIVATE=1" },
  "gallery.ts": { count: 22, why: "the gallery's web tools, as text: scripts written into a workspace and run inside a step's sandbox" },
  "status.ts": { count: 2, why: "FOLDRUN_STATUS_WEB_URL and FOLDRUN_PUBLIC_URL, operator env" },
  "stripe-api.ts": { count: 1, why: "Stripe, a fixed host (api.stripe.com)" },
};

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.(ts|mjs|js)$/.test(e.name) ? [p] : [];
  });
}

function rawCalls(file: string): number {
  let n = 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue; // prose about fetch(), not a call
    n += [...line.matchAll(RAW)].length;
  }
  return n;
}

test("every raw fetch in src/ is one the list explains — a tenant's URL goes through fetchPublic", () => {
  const found: Record<string, number> = {};
  for (const file of sources(SRC)) {
    const n = rawCalls(file);
    if (n) found[path.relative(SRC, file)] = n;
  }
  for (const [file, n] of Object.entries(found)) {
    assert.ok(ALLOWED[file], `${file}: ${n} raw fetch() — use fetchPublic (ssrf.ts), or add it to ALLOWED with why its URL is not a tenant's`);
    assert.equal(n, ALLOWED[file].count, `${file}: ${n} raw fetch() where ${ALLOWED[file].count} are explained — ${ALLOWED[file].why}`);
  }
  for (const file of Object.keys(ALLOWED)) {
    // A billing module is absent from a checkout without billing; its entry
    // still holds where it is present (billing-boundary-lists.ts).
    if (!fs.existsSync(path.join(SRC, file)) && PRIVATE.has(file.replace(/\.ts$/, ""))) continue;
    assert.ok(found[file], `${file} is in ALLOWED but has no raw fetch() any more — take it out`);
  }
});

test("the scan sees a call and ignores a method or a longer name", () => {
  const count = (s: string) => [...s.matchAll(RAW)].length;
  assert.equal(count("const r = await fetch(url)"), 1);
  assert.equal(count("return (await undiciFetch(url, init))"), 1);
  assert.equal(count("http.get(u)"), 1);
  assert.equal(count("hop_.fetch(u); await fetchPublic(u); platform.fetchUntrusted(u)"), 0);
});
