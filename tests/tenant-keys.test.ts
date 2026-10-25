// Per-account encryption keys.
//
// The property: FOLDRUN_SECRET_KEY alone no longer opens an account's vault,
// and one account's key does not open another's. Tested without a database,
// which is the case where there ARE no account keys — so what these prove is
// the fallback and the format, and the box proves the rest.
//
//   node --test tests/tenant-keys.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { setSecret, getSecret, encryptValue, decryptValue } from "../../foldrun-core/src/secrets.ts";

function withInstall(body: () => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-keys-"));
  const prevData = process.env.FOLDRUN_DATA;
  const prevKey = process.env.FOLDRUN_SECRET_KEY;
  process.env.FOLDRUN_DATA = root;
  process.env.FOLDRUN_SECRET_KEY = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(path.join(root, "acme/workspaces"), { recursive: true });
    fs.mkdirSync(path.join(root, "other/workspaces"), { recursive: true });
    body();
  } finally {
    if (prevData === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prevData;
    if (prevKey === undefined) delete process.env.FOLDRUN_SECRET_KEY;
    else process.env.FOLDRUN_SECRET_KEY = prevKey;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("with no database a secret round-trips on the install key, as it always did", () => {
  withInstall(() => {
    setSecret("acme", "API_TOKEN", "sk-live-1");
    assert.equal(getSecret("acme", "API_TOKEN")?.value, "sk-live-1");
  });
});

test("a record written without a database carries no key marker", () => {
  withInstall(() => {
    // The marker is what tells a reader which key opened it. Its ABSENCE has
    // to keep meaning "the install key", or every vault written before account
    // keys existed becomes unreadable the moment one is minted.
    const sealed = encryptValue("acme", "hello");
    assert.equal((sealed as { k?: string }).k, undefined);
    assert.equal(decryptValue("acme", sealed), "hello");
  });
});

test("an account cannot read another account's secret", () => {
  withInstall(() => {
    setSecret("acme", "SHARED_NAME", "acme-value");
    setSecret("other", "SHARED_NAME", "other-value");
    assert.equal(getSecret("acme", "SHARED_NAME")?.value, "acme-value");
    assert.equal(getSecret("other", "SHARED_NAME")?.value, "other-value");
  });
});

test("a tampered ciphertext is refused, not returned as garbage", () => {
  withInstall(() => {
    setSecret("acme", "API_TOKEN", "sk-live-1");
    const file = path.join(process.env.FOLDRUN_DATA!, "acme", "secrets.json");
    const all = JSON.parse(fs.readFileSync(file, "utf8"));
    // Flip a byte of the ciphertext. GCM authenticates, so this must fail the
    // tag check rather than decrypt to something.
    const raw = Buffer.from(all.API_TOKEN.data, "base64");
    raw[0] ^= 0xff;
    all.API_TOKEN.data = raw.toString("base64");
    fs.writeFileSync(file, JSON.stringify(all));
    assert.equal(getSecret("acme", "API_TOKEN"), null);
  });
});

// ------------------------------------------------------------- the root key
//
// Wrapped keys carry a prefix naming the provider that sealed them, so accounts
// can move to a different root key one at a time and a half-migrated install
// reads correctly instead of throwing. These prove the format, which is the
// part that has to be right BEFORE a provider is added — a stored blob whose
// origin cannot be told is a key nobody can migrate.

import { wrappedBy } from "../src/tenant-keys.ts";

test("a wrapped key says which provider sealed it", () => {
  assert.equal(wrappedBy("env:AAAA"), "env");
  assert.equal(wrappedBy("kms:arn-blob"), "kms");
});

test("an unprefixed blob is read as env, so nothing written before the seam breaks", () => {
  // Absence means the original — the same rule the secret records use. Without
  // it, every key stored before providers existed becomes unopenable the moment
  // one is added.
  assert.equal(wrappedBy("AAAAnotprefixed"), "env");
});
