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
import { markGet, markInsert, markPut, marksInDatabase } from "./marks.ts";

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

/** An avatar as a row with a database (FOL-126): set on one web pod, shown by
 *  every other; no shared disk. The image is at most 1 MB. */
interface AvatarRow {
  ext: string;
  b64: string;
  at: number;
  /** Removed: no picture, whatever a pod's old file says (Codex review). */
  deleted?: boolean;
}
const rowKey = (kind: AvatarKind, id: string) => `${kind}-${id}`;
function avatarRow(tenant: string, kind: AvatarKind, id: string): AvatarRow | null {
  assertId(id);
  if (!marksInDatabase()) return null;
  try {
    return markGet<AvatarRow>(tenant, "avatar", rowKey(kind, id)) ?? null;
  } catch {
    return null;
  }
}

export function setAvatar(tenant: string, kind: AvatarKind, id: string, bytes: Buffer): { ext: string } {
  assertId(id);
  if (bytes.length === 0) throw new Error("empty image");
  if (bytes.length > AVATAR_MAX_BYTES) throw new Error(`image too large — the limit is ${AVATAR_MAX_BYTES / 1024 / 1024} MB`);
  const ext = sniffImage(bytes);
  if (!ext) throw new Error("not a PNG, JPEG or WebP image");
  const old = existing(tenant, kind, id);
  if (marksInDatabase()) {
    // The row first: an upload that fails leaves the old picture (Codex review).
    markPut(tenant, "avatar", rowKey(kind, id), { ext, b64: bytes.toString("base64"), at: Date.now() } satisfies AvatarRow);
    if (old) fs.rmSync(old.file, { force: true });
    return { ext };
  }
  if (old) fs.rmSync(old.file, { force: true });
  fs.mkdirSync(dirOf(tenant), { recursive: true });
  fs.writeFileSync(path.join(dirOf(tenant), `${kind}-${id}.${ext}`), bytes);
  return { ext };
}

export function readAvatar(tenant: string, kind: AvatarKind, id: string): { bytes: Buffer; mime: string; mtimeMs: number } | null {
  const row = avatarRow(tenant, kind, id);
  if (row?.deleted) return null;
  if (row) return { bytes: Buffer.from(row.b64, "base64"), mime: EXT[row.ext], mtimeMs: row.at };
  const hit = existing(tenant, kind, id);
  if (!hit) return null;
  return { bytes: fs.readFileSync(hit.file), mime: EXT[hit.ext], mtimeMs: fs.statSync(hit.file).mtimeMs };
}

export function deleteAvatar(tenant: string, kind: AvatarKind, id: string): boolean {
  const row = avatarRow(tenant, kind, id);
  const hit = existing(tenant, kind, id);
  const had = (!!row && !row.deleted) || (!row && !!hit);
  // A marker, not a missing row: another pod's old file must not bring it back.
  if (marksInDatabase()) markPut(tenant, "avatar", rowKey(kind, id), { ext: "", b64: "", at: Date.now(), deleted: true } satisfies AvatarRow);
  if (hit) fs.rmSync(hit.file, { force: true });
  return had;
}

/** One account's avatar files into rows, once (FOL-126: before the shared
 *  volume goes). A picture that already has a row (set or deleted since) is
 *  left. Returns how many were copied. */
export function importAvatarFiles(tenant: string): number {
  if (!marksInDatabase()) return 0;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dirOf(tenant));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  let n = 0;
  for (const name of names) {
    const m = /^(user|workspace|account)-(.+)\.([a-z]+)$/.exec(name);
    if (!m || !(m[3] in EXT) || !SAFE_ID.test(m[2])) continue;
    const kind = m[1] as AvatarKind;
    const file = path.join(dirOf(tenant), name);
    // Only where no row is yet: an upload or a delete made meanwhile wins (Codex review).
    if (markInsert(tenant, "avatar", rowKey(kind, m[2]), { ext: m[3], b64: fs.readFileSync(file).toString("base64"), at: Math.round(fs.statSync(file).mtimeMs) } satisfies AvatarRow)) n++;
  }
  return n;
}

/** The URL a page puts in an <img>, or null when there is no picture. The
 *  mtime in the query makes a new picture a new URL. */
export function avatarUrl(tenant: string, kind: AvatarKind, id: string): string | null {
  const row = avatarRow(tenant, kind, id);
  if (row?.deleted) return null;
  if (row) return `/api/avatars/${kind}/${encodeURIComponent(id)}?v=${row.at}`;
  const hit = existing(tenant, kind, id);
  if (!hit) return null;
  return `/api/avatars/${kind}/${encodeURIComponent(id)}?v=${Math.round(fs.statSync(hit.file).mtimeMs)}`;
}
