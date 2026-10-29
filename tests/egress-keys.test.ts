// The egress proxy's own keys (egress-keys.ts): each derived from the install
// key for one purpose, given to an egress pod that does not hold the install
// key, and refused when the two disagree.
//
//   node --test tests/egress-keys.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

process.env.FOLDRUN_DATA ??= fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-egress-keys-"));

const keys = await import("../src/egress-keys.ts");

const KEY = "egress-keys-pinned-test-key-0001"; // gitleaks:allow — a fixed test key, not a secret
// From this key: the seal key by the code before the split (oidc-issuer.ts
// at dd9db6a), the lease key as first shipped — a change to either
// derivation fails here.
const PINNED = {
  oidc: "329351fc6c644b494b968d2dc8d5556d22fd040f693f1b5e44bf1f3d09daf1c7",
  leasePub: "MCowBQYDK2VwAyEA8xZu76+KMmKuPJl8x1jBH4N5x2PfR8ItJ1pUaxgUgwk=",
};
const PURPOSE = ["FOLDRUN_SECRET_KEY", "FOLDRUN_EGRESS_CA_PRK", "FOLDRUN_OIDC_SEAL_KEY", "FOLDRUN_EGRESS_LEASE_PUBKEY", "FOLDRUN_INSTALL_KEY_ABSENT"] as const;

/** Run `body` with exactly these of the key variables set. */
function withEnv(vars: Partial<Record<(typeof PURPOSE)[number], string>>, body: () => void) {
  const prev = Object.fromEntries(PURPOSE.map((k) => [k, process.env[k]]));
  for (const k of PURPOSE) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    body();
  } finally {
    for (const k of PURPOSE) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test("HKDF split in two is the HKDF the CA was derived with: extract here, expand there", () => {
  for (const material of [KEY, "x", "a much longer install key ".repeat(20), "ünïcödé"]) {
    const prk = keys.caPrkFrom(material);
    for (const [info, len] of [["key v1/0", 32], ["key v1/7", 32], ["serial v1", 16], ["longer", 80]] as const) {
      const whole = Buffer.from(crypto.hkdfSync("sha256", Buffer.from(material, "utf8"), Buffer.from("foldrun egress ca"), Buffer.from(info), len));
      assert.deepEqual(keys.hkdfExpand(prk, info, len), whole, `${info}/${len}`);
    }
  }
});

test("the OIDC seal key is the one oidc-issuer.ts derived from the install key", () => {
  const before = Buffer.from(crypto.hkdfSync("sha256", KEY, Buffer.alloc(0), "foldrun oidc signing keys v1", 32));
  assert.deepEqual(keys.oidcSealKeyFrom(KEY), before);
});

test("pinned: one install key always gives these three values", () => {
  const v = keys.egressKeyValues(KEY);
  assert.equal(v.FOLDRUN_EGRESS_CA_PRK, crypto.createHmac("sha256", "foldrun egress ca").update(KEY).digest("hex"));
  assert.equal(v.FOLDRUN_OIDC_SEAL_KEY, PINNED.oidc);
  assert.equal(v.FOLDRUN_EGRESS_LEASE_PUBKEY, PINNED.leasePub);
  assert.match(v.FOLDRUN_EGRESS_CA_PRK, /^[0-9a-f]{64}$/);
});

test("--print gives the three values from FOLDRUN_SECRET_KEY, and refuses without it", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const run = (env: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "src/egress-keys.ts", "--print"], { cwd: path.join(here, ".."), env, encoding: "utf8" });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-print-"));
  const ok = run({ PATH: process.env.PATH, FOLDRUN_DATA: data, FOLDRUN_SECRET_KEY: KEY });
  assert.equal(ok.status, 0, ok.stderr);
  const v = keys.egressKeyValues(KEY);
  assert.equal(ok.stdout, `FOLDRUN_EGRESS_CA_PRK=${v.FOLDRUN_EGRESS_CA_PRK}\nFOLDRUN_OIDC_SEAL_KEY=${v.FOLDRUN_OIDC_SEAL_KEY}\nFOLDRUN_EGRESS_LEASE_PUBKEY=${v.FOLDRUN_EGRESS_LEASE_PUBKEY}\n`);
  const no = run({ PATH: process.env.PATH, FOLDRUN_DATA: data });
  assert.notEqual(no.status, 0);
  assert.match(no.stderr, /set FOLDRUN_SECRET_KEY/);
  assert.equal(fs.existsSync(path.join(data, ".secret-key")), false, "never creates an install key to derive from");
});

test("a purpose value is used without the install key; one that disagrees with it refuses", () => {
  const v = keys.egressKeyValues(KEY);
  withEnv({ FOLDRUN_EGRESS_CA_PRK: v.FOLDRUN_EGRESS_CA_PRK, FOLDRUN_OIDC_SEAL_KEY: v.FOLDRUN_OIDC_SEAL_KEY, FOLDRUN_EGRESS_LEASE_PUBKEY: v.FOLDRUN_EGRESS_LEASE_PUBKEY, FOLDRUN_INSTALL_KEY_ABSENT: "1" }, () => {
    assert.equal(keys.egressCaPrk().toString("hex"), v.FOLDRUN_EGRESS_CA_PRK);
    assert.equal(keys.oidcSealKey().toString("hex"), v.FOLDRUN_OIDC_SEAL_KEY);
    assert.equal(keys.publicKeyLine(keys.leaseVerifyKey()), v.FOLDRUN_EGRESS_LEASE_PUBKEY);
    keys.assertEgressKeys({ minimal: true, forward: true, oidc: true });
  });
  // Both present and agreeing: fine.
  withEnv({ FOLDRUN_SECRET_KEY: KEY, FOLDRUN_EGRESS_CA_PRK: v.FOLDRUN_EGRESS_CA_PRK, FOLDRUN_OIDC_SEAL_KEY: v.FOLDRUN_OIDC_SEAL_KEY, FOLDRUN_EGRESS_LEASE_PUBKEY: v.FOLDRUN_EGRESS_LEASE_PUBKEY }, () => {
    keys.assertEgressKeys({ minimal: false, forward: true, oidc: true });
  });
  // Each one that disagrees with the install key stops the pod.
  const other = keys.egressKeyValues("some-other-install-key");
  for (const name of ["FOLDRUN_EGRESS_CA_PRK", "FOLDRUN_OIDC_SEAL_KEY", "FOLDRUN_EGRESS_LEASE_PUBKEY"] as const) {
    withEnv({ FOLDRUN_SECRET_KEY: KEY, ...v, [name]: other[name] }, () => {
      assert.throws(() => keys.assertEgressKeys({ minimal: false, forward: true, oidc: true }), new RegExp(`${name} does not match`));
    });
  }
  // Minimal, no install key, a value missing: named.
  withEnv({ FOLDRUN_EGRESS_LEASE_PUBKEY: v.FOLDRUN_EGRESS_LEASE_PUBKEY, FOLDRUN_INSTALL_KEY_ABSENT: "1" }, () => {
    assert.throws(() => keys.assertEgressKeys({ minimal: true, forward: true, oidc: true }), /needs FOLDRUN_EGRESS_CA_PRK, FOLDRUN_OIDC_SEAL_KEY/);
    keys.assertEgressKeys({ minimal: true, forward: false, oidc: false });
  });
  withEnv({ FOLDRUN_EGRESS_CA_PRK: "not-hex" }, () => assert.throws(() => keys.egressCaPrk(), /64 hex/));
  withEnv({ FOLDRUN_EGRESS_LEASE_PUBKEY: crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "der" }).toString("base64") }, () =>
    assert.throws(() => keys.leaseVerifyKey(), /Ed25519/));
});

test("a lease record verifies only under the worker's key, and only as signed", () => {
  const v = keys.egressKeyValues(KEY);
  let sig = "";
  const rec = JSON.stringify({ v: 2, id: "x".repeat(64), tenant: "acme" });
  withEnv({ FOLDRUN_SECRET_KEY: KEY }, () => {
    sig = keys.signLeaseRecord(rec);
    assert.ok(keys.verifyLeaseRecord(rec, sig));
  });
  withEnv({ FOLDRUN_EGRESS_LEASE_PUBKEY: v.FOLDRUN_EGRESS_LEASE_PUBKEY, FOLDRUN_INSTALL_KEY_ABSENT: "1" }, () => {
    assert.ok(keys.verifyLeaseRecord(rec, sig), "egress verifies with the public key alone");
    assert.equal(keys.verifyLeaseRecord(rec.replace("acme", "acmf"), sig), false, "a changed record");
    assert.equal(keys.verifyLeaseRecord(rec, ""), false, "no signature");
    const forger = crypto.generateKeyPairSync("ed25519").privateKey;
    assert.equal(keys.verifyLeaseRecord(rec, crypto.sign(null, Buffer.from(`foldrun egress lease v2\0${rec}`), forger).toString("base64")), false, "another key");
  });
});

test("a recovery record and a lease record are signed apart: neither passes for the other", () => {
  withEnv({ FOLDRUN_SECRET_KEY: KEY }, () => {
    const rec = JSON.stringify({ kind: "recover", v: 1, id: "y".repeat(64) });
    assert.ok(keys.verifyRecoveryRecord(rec, keys.signRecoveryRecord(rec)));
    assert.equal(keys.verifyLeaseRecord(rec, keys.signRecoveryRecord(rec)), false);
    assert.equal(keys.verifyRecoveryRecord(rec, keys.signLeaseRecord(rec)), false);
  });
});

test("a grant sealed under one token opens with that token and that binding only", () => {
  const sealed = keys.sealForLease("token-aaaaaaaaaaaaaaaa", "id|acme|run-1", "the grant");
  assert.equal(keys.openForLease("token-aaaaaaaaaaaaaaaa", "id|acme|run-1", sealed), "the grant");
  assert.equal(keys.openForLease("token-bbbbbbbbbbbbbbbb", "id|acme|run-1", sealed), null);
  assert.equal(keys.openForLease("token-aaaaaaaaaaaaaaaa", "id|acme|run-2", sealed), null);
  const raw = Buffer.from(sealed, "base64");
  raw[raw.length - 1] ^= 1;
  assert.equal(keys.openForLease("token-aaaaaaaaaaaaaaaa", "id|acme|run-1", raw.toString("base64")), null);
  assert.equal(keys.leaseId("t"), crypto.createHash("sha256").update("t").digest("hex"));
});
