// FOL-128 item 1: a browsing step held to its network: list that asks for
// Firefox trusts the egress CA — the proxy ends TLS with a leaf the CA signs
// on a host one of the step's secrets is granted to. Firefox trusts a CA only
// from its own profile's NSS database (not the system store, SSL_CERT_FILE,
// security.enterprise_roots or a distribution policy: each tried in the
// runner image on 8 Nov 2026), so web browse puts the CA there with certutil
// and launches a persistent context on that profile.
//
// The source half always runs. The real half runs where FOLDRUN_TEST_PLAYWRIGHT
// names a folder whose node_modules holds playwright@1.63 with Firefox
// installed, and certutil (libnss3-tools) is on PATH: the program's own
// trustEgressCaInProfile makes the profile, a local HTTPS server answers with
// a leaf the platform's real egress CA signed, and real Firefox must load the
// page through that profile — and must refuse it without.
//
//   node --test tests/browse-firefox-ca.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import https from "node:https";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { GALLERY } from "../src/gallery.ts";
import { egressCaPem, leafFor } from "../src/egress-ca.ts";

process.env.FOLDRUN_SECRET_KEY ??= "browse-firefox-ca-test-key";

const browseSrc = () => GALLERY.find((t) => t.name === "web")!.extra!.find((f) => f.file === "web/browse.mjs")!.content;

/** The program's own function, lifted with what it reads from the module;
 *  what it says goes to `said`. */
function liftTrust(said: string[]) {
  const m = browseSrc().match(/function trustEgressCaInProfile\([\s\S]*?\n\}\n/);
  assert.ok(m, "trustEgressCaInProfile is in browse.mjs");
  const quiet = { ...console, error: (s: unknown) => said.push(String(s)) };
  return new Function("process", "fs", "os", "path", "execFileSync", "X509Certificate", "values", "console", `${m![0]}; return trustEgressCaInProfile;`)(
    process, fs, os, path, execFileSync, X509Certificate, {}, quiet,
  ) as (existing: string | null) => string | null;
}

test("the browse program, held Firefox: a profile that trusts the egress CA, for steps that browse in their own sandbox", () => {
  const src = browseSrc();
  assert.match(src, /const firefoxCaProfile = CONFINED && !SERVICE_SIDE && values\.browser === "firefox" && process\.env\.FOLDRUN_EGRESS_CA \? trustEgressCaInProfile\(profileDir\) : null;/);
  // Trusted as a CA for TLS servers, under one nickname (a session's profile keeps one).
  assert.match(src, /execFileSync\("certutil", \["-A", "-d", `sql:\$\{dir\}`, "-n", "foldrun egress CA", "-t", "C,,", "-i", pemFile\]/);
  assert.match(src, /if \(!new X509Certificate\(pem\)\.ca\) throw new Error\("FOLDRUN_EGRESS_CA is not a CA certificate"\)/);
  // The PEM in a private folder, written without following a link (Codex review).
  assert.match(src, /pemDir = fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\), "foldrun-egress-ca-"\)\);/);
  assert.match(src, /fs\.writeFileSync\(pemFile, pem, \{ mode: 0o600, flag: "wx" \}\);/);
  assert.match(src, /if \(pemDir\) \{ try \{ fs\.rmSync\(pemDir, \{ recursive: true, force: true \}\); \} catch \{\} \}/);
  assert.doesNotMatch(src, /foldrun-egress-ca-\$\{process\.pid\}/);
  // The profile is launched as a persistent context; without one, the old path.
  assert.match(src, /else if \(!SERVICE_SIDE && \(profileDir \|\| extensionDirs\.length \|\| firefoxCaProfile\)\)/);
  assert.match(src, /const dir = profileDir \?\? firefoxCaProfile \?\? fs\.mkdtempSync/);
  // When it cannot be made, the engine still says it will not trust the proxy.
  assert.match(src, /firefox could not be told to trust the egress proxy's certificate/);
});

test("trustEgressCaInProfile refuses a certificate that is not a CA, and says so", () => {
  const prev = process.env.FOLDRUN_EGRESS_CA;
  process.env.FOLDRUN_EGRESS_CA = Buffer.from(leafFor("127.0.0.1").cert).toString("base64");
  const said: string[] = [];
  try {
    assert.equal(liftTrust(said)(null), null);
    assert.match(said.join("\n"), /not a CA certificate/);
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_EGRESS_CA; else process.env.FOLDRUN_EGRESS_CA = prev;
  }
});

const PW = process.env.FOLDRUN_TEST_PLAYWRIGHT;
const hasCertutil = (() => { try { execFileSync("sh", ["-c", "command -v certutil"], { stdio: "ignore" }); return true; } catch { return false; } })();
function firefoxOf(dir: string | undefined) {
  if (!dir) return null;
  try {
    const pw = createRequire(path.join(dir, "package.json"))("playwright");
    return fs.existsSync(pw.firefox.executablePath()) ? pw : null;
  } catch { return null; }
}
const pw = firefoxOf(PW);
const skip = !PW ? "set FOLDRUN_TEST_PLAYWRIGHT" : !pw ? "no Playwright Firefox in FOLDRUN_TEST_PLAYWRIGHT" : !hasCertutil ? "no certutil (libnss3-tools)" : false;

test("real Firefox: a page behind a leaf the egress CA signed loads through the profile, and not without it", { skip, timeout: 120_000 }, async () => {
  const leaf = leafFor("127.0.0.1");
  const ca = egressCaPem();
  // The proxy sends the leaf and the CA; the server here does the same.
  const server = https.createServer({ cert: leaf.cert + ca, key: leaf.key }, (_q, r) => r.end("behind-the-egress-ca"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `https://127.0.0.1:${(server.address() as net.AddressInfo).port}/`;
  const prev = process.env.FOLDRUN_EGRESS_CA;
  process.env.FOLDRUN_EGRESS_CA = Buffer.from(ca).toString("base64");
  const said: string[] = [];
  const trust = liftTrust(said);
  try {
    // Without the profile: Firefox's own roots, so the page is refused.
    const plain = await pw.firefox.launch({ headless: true });
    try {
      const page = await (await plain.newContext()).newPage();
      await assert.rejects(page.goto(url, { timeout: 15_000 }), /SEC_ERROR_UNKNOWN_ISSUER|certificate/i);
    } finally { await plain.close(); }

    // With it: the program's own function makes the profile, and the page loads.
    const dir = trust(null);
    assert.ok(dir, `a profile was made (${said.join(" | ")})`);
    assert.ok(fs.existsSync(path.join(dir, "cert9.db")), "its NSS database exists");
    assert.match(said.join("\n"), /firefox trusts the egress proxy's certificate \(a profile for this call\)/);
    const ctx = await pw.firefox.launchPersistentContext(dir, { headless: true });
    try {
      const page = await ctx.newPage();
      await page.goto(url, { timeout: 15_000 });
      assert.equal((await page.textContent("body"))?.trim(), "behind-the-egress-ca");
    } finally { await ctx.close(); }

    // A session's profile: imported again under the same nickname, still one entry.
    const session = fs.mkdtempSync(path.join(os.tmpdir(), "ff-session-"));
    try {
      assert.equal(trust(session), session);
      assert.equal(trust(session), session);
      const list = execFileSync("certutil", ["-L", "-d", `sql:${session}`]).toString();
      assert.equal(list.split("\n").filter((l) => l.startsWith("foldrun egress CA")).length, 1);
    } finally { fs.rmSync(session, { recursive: true, force: true }); }
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_EGRESS_CA; else process.env.FOLDRUN_EGRESS_CA = prev;
    server.close();
  }
});
