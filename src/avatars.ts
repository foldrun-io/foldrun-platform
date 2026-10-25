// Pictures for the things that have a face in the dashboard: a person, a
// workspace, the account. One store, one shape, one URL scheme, so every
// place that draws an avatar draws the same one.
//
// Stored as files under <account>/avatars/, named by kind and id, in the
// format they arrived in (PNG, JPEG or WebP, sniffed from the bytes rather
// than trusted from a header), at most a megabyte. The URL carries the
// file's mtime, so a browser may cache forever and a new picture is a new
// URL.

import fs from "node:fs";
import path from "node:path";
import { accountDir } from "../../foldrun-core/src/store.ts";

export type AvatarKind = "user" | "workspace" | "account";
export const AVATAR_KINDS: AvatarKind[] = ["user", "workspace", "account"];
export const AVATAR_MAX_BYTES = 1024 * 1024;

const EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

/** The image format, from the bytes. Null when it is not one we keep. */
export function sniffImage(bytes: Buffer): "png" | "jpg" | "webp" | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return null;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function assertId(id: string) {
  if (!SAFE_ID.test(id)) throw new Error(`invalid avatar id "${id}"`);
}

const dirOf = (tenant: string) => path.join(accountDir(tenant), "avatars");

function existing(tenant: string, kind: AvatarKind, id: string): { file: string; ext: string } | null {
  assertId(id);
  for (const ext of Object.keys(EXT)) {
    const file = path.join(dirOf(tenant), `${kind}-${id}.${ext}`);
    if (fs.existsSync(file)) return { file, ext };
  }
  return null;
}

export function setAvatar(tenant: string, kind: AvatarKind, id: string, bytes: Buffer): { ext: string } {
  assertId(id);
  if (bytes.length === 0) throw new Error("empty image");
  if (bytes.length > AVATAR_MAX_BYTES) throw new Error(`image too large — the limit is ${AVATAR_MAX_BYTES / 1024 / 1024} MB`);
  const ext = sniffImage(bytes);
  if (!ext) throw new Error("not a PNG, JPEG or WebP image");
  const old = existing(tenant, kind, id);
  if (old) fs.rmSync(old.file, { force: true });
  fs.mkdirSync(dirOf(tenant), { recursive: true });
  fs.writeFileSync(path.join(dirOf(tenant), `${kind}-${id}.${ext}`), bytes);
  return { ext };
}

export function readAvatar(tenant: string, kind: AvatarKind, id: string): { bytes: Buffer; mime: string; mtimeMs: number } | null {
  const hit = existing(tenant, kind, id);
  if (!hit) return null;
  return { bytes: fs.readFileSync(hit.file), mime: EXT[hit.ext], mtimeMs: fs.statSync(hit.file).mtimeMs };
}

export function deleteAvatar(tenant: string, kind: AvatarKind, id: string): boolean {
  const hit = existing(tenant, kind, id);
  if (!hit) return false;
  fs.rmSync(hit.file, { force: true });
  return true;
}

/** The URL a page puts in an <img>, or null when there is no picture. The
 *  mtime in the query makes a new picture a new URL. */
export function avatarUrl(tenant: string, kind: AvatarKind, id: string): string | null {
  const hit = existing(tenant, kind, id);
  if (!hit) return null;
  return `/api/avatars/${kind}/${encodeURIComponent(id)}?v=${Math.round(fs.statSync(hit.file).mtimeMs)}`;
}
