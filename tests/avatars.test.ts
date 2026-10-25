// Avatars: sniffed, capped, stored by kind and id, addressed by a URL that
// changes when the picture does.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sniffImage, setAvatar, readAvatar, deleteAvatar, avatarUrl, AVATAR_MAX_BYTES } from "../src/avatars.ts";

function withData(run: () => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-avatars-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    run();
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(8)]);

test("the format comes from the bytes", () => {
  assert.equal(sniffImage(PNG), "png");
  assert.equal(sniffImage(JPG), "jpg");
  assert.equal(sniffImage(WEBP), "webp");
  assert.equal(sniffImage(Buffer.from("<svg onload=alert(1)>")), null);
});

test("set, read, replace in another format, delete", () =>
  withData(() => {
    assert.equal(avatarUrl("acme", "workspace", "leads"), null);
    setAvatar("acme", "workspace", "leads", PNG);
    const first = avatarUrl("acme", "workspace", "leads")!;
    assert.ok(first.startsWith("/api/avatars/workspace/leads?v="));
    assert.equal(readAvatar("acme", "workspace", "leads")?.mime, "image/png");
    setAvatar("acme", "workspace", "leads", JPG);
    assert.equal(readAvatar("acme", "workspace", "leads")?.mime, "image/jpeg");
    // One file per kind and id: the PNG went when the JPEG came.
    assert.equal(fs.readdirSync(path.join(process.env.FOLDRUN_DATA!, "acme", "avatars")).length, 1);
    assert.equal(deleteAvatar("acme", "workspace", "leads"), true);
    assert.equal(readAvatar("acme", "workspace", "leads"), null);
    assert.equal(deleteAvatar("acme", "workspace", "leads"), false);
  }));

test("what is refused: too big, not an image, a path for an id", () =>
  withData(() => {
    assert.throws(() => setAvatar("acme", "user", "u1", Buffer.alloc(AVATAR_MAX_BYTES + 1, 1)), /too large/);
    assert.throws(() => setAvatar("acme", "user", "u1", Buffer.from("hello")), /not a PNG/);
    assert.throws(() => setAvatar("acme", "user", "../x", PNG), /invalid avatar id/);
    assert.throws(() => setAvatar("acme", "user", "u1", Buffer.alloc(0)), /empty/);
  }));
