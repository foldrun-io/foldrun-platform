// Client certificates (mutual TLS): the egress proxy picks the one bound to
// exactly the host it is calling, and the guarded dispatcher presents it on
// a real TLS connection to a server that demands one. Throwaway certificates
// are made with openssl for the test run — never committed.
//
//   node --test tests/client-cert.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-mtls-"));
const ssl = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
if (hasOpenssl) {
  ssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "1", "-subj", "/CN=test-ca");
  for (const who of ["server", "client"]) {
    ssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${who}.key`, "-out", `${who}.csr`, "-subj", `/CN=${who === "server" ? "localhost" : "client"}`);
    fs.writeFileSync(path.join(dir, `${who}.ext`), who === "server" ? "subjectAltName=DNS:localhost\n" : "extendedKeyUsage=clientAuth\n");
    ssl("x509", "-req", "-in", `${who}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${who}.crt`, "-days", "1", "-extfile", `${who}.ext`);
  }
}
const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");

test("the proxy presents only a certificate bound to exactly this host, and refuses two", { skip: !hasOpenssl }, async () => {
  const { clientCertFor } = await import("../src/egress-proxy.ts");
  const value = "@client-cert " + JSON.stringify({ cert: read("client.crt"), key: read("client.key") });
  const grant = { secrets: { BANK_CERT: { value, hosts: ["api.bank.test"] }, PLAIN: { value: "tok", hosts: ["api.bank.test"] } }, healthKeys: { BANK_CERT: "workspace:desk:BANK_CERT" } };
  const hit = clientCertFor(grant, "acme", "API.bank.test");
  assert.ok("cert" in hit && hit.cert, "matched, case-insensitively");
  assert.equal((hit as { name: string }).name, "BANK_CERT");
  assert.deepEqual(clientCertFor(grant, "acme", "other.bank.test"), {}, "another host gets none");
  assert.equal((clientCertFor(grant, "acme", "api.bank.test:8443") as { name: string }).name, "BANK_CERT", "a port does not change the host");
  assert.deepEqual(clientCertFor({ secrets: { W: { value, hosts: ["*.bank.test"] } } }, "acme", "api.bank.test"), {}, "a wildcard binding presents nothing");
  const two = clientCertFor({ secrets: { ...grant.secrets, SECOND: { value, hosts: ["api.bank.test"] } } }, "acme", "api.bank.test");
  assert.match((two as { error: string }).error, /BANK_CERT and SECOND are client certificates bound to api.bank.test/);
  // A new certificate version is a new pool; another account is another pool.
  const v2 = clientCertFor({ secrets: { BANK_CERT: { value: value + " ", hosts: ["api.bank.test"] } }, healthKeys: grant.healthKeys }, "acme", "api.bank.test");
  const other = clientCertFor(grant, "beta", "api.bank.test");
  const pools = [hit, v2, other].map((r) => (r as { cert: { pool: string } }).cert.pool);
  assert.equal(new Set(pools).size, 3);
});

test("a server that demands a client certificate accepts the presented one and refuses without it", { skip: !hasOpenssl }, () => {
  // A child process, so the test CA can be trusted the way Node trusts an
  // extra CA (NODE_EXTRA_CA_CERTS is read at start-up).
  const script = path.join(dir, "probe.mts");
  fs.writeFileSync(script, `
import https from "node:https";
import fs from "node:fs";
import { fetchPublic } from ${JSON.stringify(path.resolve("src/ssrf.ts"))};
const d = ${JSON.stringify(dir)};
const server = https.createServer({ key: fs.readFileSync(d + "/server.key"), cert: fs.readFileSync(d + "/server.crt"), ca: fs.readFileSync(d + "/ca.crt"), requestCert: true, rejectUnauthorized: true },
  (req, res) => { res.end("hello " + req.socket.getPeerCertificate().subject.CN); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = "https://localhost:" + server.address().port + "/";
const cert = { pool: "p1", identity: "acme:X", cert: fs.readFileSync(d + "/client.crt", "utf8"), key: fs.readFileSync(d + "/client.key", "utf8") };
const out = {};
out.with = await (await fetchPublic(url, {}, { clientCert: cert })).text();
try { await fetchPublic(url); out.without = "answered"; } catch { out.without = "refused"; }
console.log(JSON.stringify(out));
server.close();
process.exit(0);
`);
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", script], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(dir, "ca.crt"), FOLDRUN_EGRESS_ALLOW_PRIVATE: "1" },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split("\n").pop()!);
  assert.equal(out.with, "hello client", "the certificate was presented");
  assert.equal(out.without, "refused", "without it the server refuses");
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
