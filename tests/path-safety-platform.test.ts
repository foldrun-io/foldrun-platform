// Path-safety property tests (platform): the public share path rule and the
// avatar file names. Seeded generator from foldrun-core's tests; no network.
//
//   node --test tests/path-safety-platform.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostile, tryIt, isInside } from "../../foldrun-core/tests/path-safety-gen.ts";
import { assertShareablePath, createShare, resolveShare, revokeShare } from "../src/shares.ts";
import { setAvatar, readAvatar, deleteAvatar } from "../src/avatars.ts";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);

async function inTempData(fn: (root: string, ws: string, outside: string) => Promise<void>) {
  const prev = process.env.FOLDRUN_DATA;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-ps-plat-"));
  const root = path.join(base, "data");
  process.env.FOLDRUN_DATA = root;
  const ws = path.join(root, "acct", "workspaces", "desk");
  fs.mkdirSync(path.join(ws, "storage"), { recursive: true });
  fs.mkdirSync(path.join(ws, "outputs"), { recursive: true });
  fs.writeFileSync(path.join(ws, "storage", "cover.jpg"), "JPEGBYTES");
  const outside = path.join(base, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "TOP SECRET");
  try {
    await fn(root, ws, outside);
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

test("assertShareablePath: only storage/, files/ and outputs/; no dot segment survives; idempotent", () => {
  let accepted = 0;
  for (const h of hostile(31, 900)) {
    for (const pre of ["", "storage/", "outputs/", "files/", "storage/a/", "agents/", "state/", "storage\\"]) {
      const norm = tryIt(() => assertShareablePath(pre + h));
      if (norm === null) continue;
      accepted++;
      assert.match(norm, /^(storage|files|outputs)\//, JSON.stringify(pre + h));
      assert.ok(!path.isAbsolute(norm) && !norm.split("/").some((s) => s === ".." || s === "."), JSON.stringify([pre + h, norm]));
      assert.equal(assertShareablePath(norm), norm, `idempotent: ${JSON.stringify(pre + h)}`);
      assert.ok(isInside("/srv/ws", path.join("/srv/ws", norm)), norm);
    }
  }
  assert.ok(accepted > 100, String(accepted));
});

test("shares: whatever a link resolves to is a regular file inside the workspace, links out of it are never served", () => inTempData(async (root, ws, outside) => {
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(ws, "outputs", "file-link.txt"));
  fs.symlinkSync(outside, path.join(ws, "outputs", "dir-link"));
  fs.symlinkSync(outside, path.join(ws, "storage-link"));
  fs.writeFileSync(path.join(ws, "outputs", "ok.txt"), "fine");
  const cases = [...hostile(32, 500).flatMap((h) => [`outputs/${h}`, `storage/${h}`, `files/${h}`]), "outputs/file-link.txt", "outputs/dir-link/secret.txt", "outputs/ok.txt", "outputs/./ok.txt", "outputs//ok.txt", "outputs\\ok.txt", "storage/../outputs/ok.txt"];
  let served = 0;
  for (const rel of cases) {
    const share = await createShare("acct", "desk", rel, { ttlDays: 1 }).catch(() => null);
    if (!share) continue;
    const got = await resolveShare(share.token);
    if (!got) continue;
    served++;
    const bytes = await got.read();
    assert.ok(bytes && !bytes.toString().includes("TOP SECRET"), `served outside bytes for ${JSON.stringify(rel)}`);
    if (!got.file.startsWith("desk/")) assert.ok(isInside(ws, got.file), `${rel} -> ${got.file}`);
    await revokeShare("acct", share.token);
  }
  assert.ok(served >= 2, String(served));
  assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "TOP SECRET");
}));

test("avatars: an id is one plain name; the picture lands in the account's avatars folder and nowhere else", () => inTempData(async (root, ws, outside) => {
  fs.mkdirSync(path.join(root, "acct"), { recursive: true });
  const dir = path.join(root, "acct", "avatars");
  const before = fs.readdirSync(root).sort();
  let accepted = 0;
  for (const h of hostile(33, 700)) {
    for (const kind of ["user", "workspace", "account"] as const) {
      const ok = tryIt(() => setAvatar("acct", kind, h, PNG));
      if (!ok) continue;
      accepted++;
      assert.ok(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(h), JSON.stringify(h));
      assert.ok(readAvatar("acct", kind, h), `reader accepts what the writer did: ${JSON.stringify(h)}`);
      for (const f of fs.readdirSync(dir)) assert.ok(isInside(dir, path.join(dir, f)));
      assert.equal(deleteAvatar("acct", kind, h), true, `delete accepts it too: ${JSON.stringify(h)}`);
      assert.equal(readAvatar("acct", kind, h), null);
    }
  }
  assert.ok(accepted > 20, String(accepted));
  assert.deepEqual(fs.readdirSync(root).sort(), before);
  assert.deepEqual(fs.readdirSync(dir), [], "every picture the test set was deleted");
  // two ids never share a file: `a` and `a.png` are different pictures
  setAvatar("acct", "user", "a", PNG);
  setAvatar("acct", "user", "a.png", Buffer.concat([PNG, Buffer.from([1])]));
  assert.equal(readAvatar("acct", "user", "a")!.bytes.length, PNG.length);
  assert.equal(readAvatar("acct", "user", "a.png")!.bytes.length, PNG.length + 1);
}));
