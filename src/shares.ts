// A public link to one file a workspace produced.
//
// Everything else in this platform is reached with a credential. A share is
// the deliberate exception: an unguessable URL that anyone — or anything —
// can fetch without one. That exists because some jobs are not finished until
// something outside can *fetch the bytes*, and no amount of API politeness
// substitutes for a URL.
//
// The case that forced it: Google Business Profile will not accept image bytes
// for a post. `media:startUpload` takes the upload and returns a dataRef, and
// then creating the post with that dataRef is refused —
// `media[0].source_url is required` — so a generated header image could only
// ever reach a profile through a URL Google could GET for itself. Uploading
// worked; referencing what we uploaded did not.
//
// The design rules, and why each one:
//
//   - The token is the whole credential, so it carries the entropy of one:
//     24 random bytes, not a slug, a hash of the path, or anything derived
//     from the file. A guessable share is a public file store.
//   - Only content is shareable — `storage/`, `files/`, `outputs/`. An agent
//     that can be talked into sharing a path is then confined to what it
//     produced, and can never hand out `memory/`, an agent's prompt, or a
//     credential. The allowlist is the security boundary, not a convention.
//   - The path is re-validated on every read, not only at creation. The
//     manifest is a file on disk; if it is ever edited by hand or restored
//     from elsewhere, a bad entry must still fail closed.
//   - Shares expire by default. A link nobody remembers making is the one
//     that leaks, so the default is 7 days and forever has to be asked for.
//   - Revocation is a tombstone, never a deletion, so a revoked token can
//     never be re-issued to a different file by chance.
//
// A share is a row (the `shares` table): web pods mint them from the Share
// button and worker pods mint them after every step that writes to
// storage/public/, and a manifest rewritten whole by both was a lost link
// waiting to happen. Without a database it is data/shares.json, as before.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { databaseEnabled, ormRequired } from "./db.ts";
import { shares as sharesTable } from "./schema.ts";
import { workspaceDir } from "../../foldrun-core/src/store.ts";
import { publicUrl } from "../../foldrun-core/src/webhook.ts";
import { Readable } from "node:stream";
import { fileStoreEnabled, getFile, readFileBytes, openFile, storedSize } from "../../foldrun-core/src/storage.ts";

/**
 * The folder file a share names, or null: a regular file whose real path is
 * inside the workspace (30 Oct 2026). existsSync/statSync follow links, so a
 * link at outputs/x — or a linked outputs/ — would have published whatever it
 * pointed at; the same containment readWorkspaceFile applies (FOL-83).
 */
function folderFile(tenant: string, workspace: string, norm: string): string | null {
  const root = workspaceDir(tenant, workspace);
  const abs = path.join(root, norm);
  try {
    if (!fs.statSync(abs).isFile()) return null;
    const real = fs.realpathSync(abs);
    const realRoot = fs.realpathSync(root);
    return real.startsWith(realRoot + path.sep) ? abs : null;
  } catch {
    return null;
  }
}

/** A `storage/…` path held by the file store rather than as a file in the
 *  workspace folder — which is where uploads, and what runs harvest into
 *  storage, actually live. The path under storage/, or null. */
function storedPath(tenant: string, workspace: string, norm: string): string | null {
  if (!norm.startsWith("storage/") || !fileStoreEnabled()) return null;
  const rel = norm.slice("storage/".length);
  try {
    return getFile(tenant, workspace, rel) ? rel : null;
  } catch {
    return null;
  }
}

export interface Share {
  token: string;
  tenant: string;
  workspace: string;
  /** Workspace-relative, always POSIX-separated. */
  path: string;
  contentType: string;
  createdAt: string;
  /** ISO timestamp, or null for a link that never expires. */
  expiresAt: string | null;
  createdBy: string | null;
  revokedAt: string | null;
}

const sharesFile = () => path.join(dataRoot(), "shares.json");

/** How long a link lives when the caller does not say. */
export const DEFAULT_TTL_DAYS = 7;

/**
 * What may be shared. Content the workspace produced — never its definitions.
 *
 * `agents/`, `tools/`, `skills/`, `memory/`, `knowledge/` and `state/` are all
 * absent on purpose: those are how the workspace *thinks*, and a public URL to
 * an agent's prompt or a memory file is a data leak wearing a feature's
 * clothes. If sharing one of those is ever genuinely wanted, it should be a
 * separate decision with its own name, not a widened regex here.
 */
const SHAREABLE = /^(storage|files|outputs)\//;

export function assertShareablePath(rel: string): string {
  const norm = path.normalize(rel).replaceAll("\\", "/");
  if (path.isAbsolute(norm) || norm.startsWith("..") || norm.split("/").includes("..")) {
    throw new Error(`illegal path: ${rel}`);
  }
  if (!SHAREABLE.test(norm)) {
    throw new Error(
      `not a shareable path: ${rel} — only storage/, files/ and outputs/ can be given a public link`,
    );
  }
  return norm;
}

const TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".mp4": "video/mp4",
  ".zip": "application/zip",
};

/**
 * Markdown and SVG are deliberately not served as their "real" types. An SVG
 * is a script-bearing document and this origin serves other people's files;
 * text/plain and nosniff at the route keep a shared file from becoming a
 * cross-site scripting surface on our own domain.
 */
export function contentTypeFor(rel: string): string {
  const ext = path.extname(rel).toLowerCase();
  if (ext === ".svg") return "text/plain; charset=utf-8";
  return TYPES[ext] ?? "application/octet-stream";
}

function readAll(): Share[] {
  try {
    const raw = JSON.parse(fs.readFileSync(sharesFile(), "utf8"));
    return Array.isArray(raw) ? (raw as Share[]) : [];
  } catch {
    return []; // absent or unreadable is "no shares", never a crash
  }
}

function writeAll(shares: Share[]) {
  const file = sharesFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(shares, null, 2));
  fs.renameSync(tmp, file); // atomic, so a concurrent reader never sees half a manifest
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const rowToShare = (r: typeof sharesTable.$inferSelect): Share => ({
  token: r.token,
  tenant: r.tenant,
  workspace: r.workspace,
  path: r.path,
  contentType: r.contentType,
  createdAt: r.createdAt.toISOString(),
  expiresAt: iso(r.expiresAt),
  createdBy: r.createdBy,
  revokedAt: iso(r.revokedAt),
});
const shareToRow = (s: Share) => ({
  token: s.token,
  tenant: s.tenant,
  workspace: s.workspace,
  path: s.path,
  contentType: s.contentType,
  createdAt: new Date(s.createdAt),
  expiresAt: s.expiresAt ? new Date(s.expiresAt) : null,
  createdBy: s.createdBy,
  revokedAt: s.revokedAt ? new Date(s.revokedAt) : null,
});

async function findByToken(token: string): Promise<Share | undefined> {
  if (!databaseEnabled()) return readAll().find((s) => s.token === token);
  const [r] = await ormRequired().select().from(sharesTable).where(eq(sharesTable.token, token));
  return r ? rowToShare(r) : undefined;
}

export interface CreateShareOptions {
  /** Days until the link stops working. `null` means never. */
  ttlDays?: number | null;
  createdBy?: string;
}

export async function createShare(
  tenant: string,
  workspace: string,
  rel: string,
  opts: CreateShareOptions = {},
): Promise<Share> {
  const norm = assertShareablePath(rel);
  const onDisk = folderFile(tenant, workspace, norm) !== null;
  if (!onDisk && !storedPath(tenant, workspace, norm)) {
    throw new Error(`file not found: ${rel}`);
  }

  const ttl = opts.ttlDays === undefined ? DEFAULT_TTL_DAYS : opts.ttlDays;
  const share: Share = {
    token: crypto.randomBytes(24).toString("base64url"),
    tenant,
    workspace,
    path: norm,
    contentType: contentTypeFor(norm),
    createdAt: new Date().toISOString(),
    expiresAt: ttl === null ? null : new Date(Date.now() + ttl * 86_400_000).toISOString(),
    createdBy: opts.createdBy ?? null,
    revokedAt: null,
  };

  // Re-sharing the same file mints a new token rather than reusing the old
  // one: the previous link may already be somewhere it cannot be recalled
  // from, and its expiry is its own.
  if (databaseEnabled()) await ormRequired().insert(sharesTable).values(shareToRow(share));
  else writeAll([...readAll(), share]);
  return share;
}

export function isLive(share: Share, now = Date.now()): boolean {
  if (share.revokedAt) return false;
  if (share.expiresAt && Date.parse(share.expiresAt) <= now) return false;
  return true;
}

/**
 * A name for a link that is not the link (30 Oct 2026). The token is the
 * credential, so a list shown to someone who may not hold it masks it — and
 * they still need a handle to revoke by. A hash of the token: stable, unique
 * as the token is, and useless for fetching the file.
 */
export function shareId(token: string): string {
  return `sh_${crypto.createHash("sha256").update(token).digest("base64url").slice(0, 22)}`;
}

/** What a list shows in place of a token its reader may not hold: enough to
 *  tell two links apart, nowhere near enough to fetch either. */
export function maskToken(token: string): string {
  return `${token.slice(0, 4)}…`;
}

/** Who reads a list of links: an admin, or the person (or their key) who made
 *  a link, sees its token; everyone else sees that it exists. */
export interface ShareReader {
  admin: boolean;
  /** What createdBy records for this reader — their email; null when unknown. */
  name: string | null;
}

export function readerSeesToken(share: Pick<Share, "createdBy">, reader: ShareReader): boolean {
  if (reader.admin) return true;
  return !!reader.name && !!share.createdBy && share.createdBy.toLowerCase() === reader.name.toLowerCase();
}

/** The token behind an id, among one workspace's links — for a revoke by id. */
export async function tokenForShareId(tenant: string, workspace: string, id: string): Promise<string | null> {
  if (!/^sh_[A-Za-z0-9_-]{22}$/.test(id)) return null;
  return (await listShares(tenant, workspace)).find((s) => shareId(s.token) === id)?.token ?? null;
}

/**
 * Turn a token into bytes on disk, or null. Null covers every reason equally —
 * unknown, expired, revoked, since-deleted, or a manifest entry that no longer
 * passes the path rule — because the caller is an unauthenticated request and
 * telling it *which* is telling it something it has not earned.
 */
export interface ResolvedShare {
  share: Share;
  file: string;
  /** The whole file in memory. Kept for callers that want a Buffer; the
   *  public route uses size() and open() instead. */
  read: () => Promise<Buffer | null>;
  /** Its length, by stat or HEAD — never by reading it (30 Oct 2026). */
  size: () => Promise<number | null>;
  /** The bytes as a stream with their length, so serving a 1 GB file costs a
   *  buffer's worth of memory, not a gigabyte per request (30 Oct 2026). */
  open: () => Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>;
}

export async function resolveShare(token: string): Promise<ResolvedShare | null> {
  if (!token) return null;
  const share = await findByToken(token);
  if (!share || !isLive(share)) return null;

  let norm: string;
  try {
    norm = assertShareablePath(share.path); // defence in depth: the manifest is just a file
  } catch {
    return null;
  }
  const file = folderFile(share.tenant, share.workspace, norm);
  if (file) {
    const size = async () => { try { return fs.statSync(file).size; } catch { return null; } };
    return {
      share,
      file,
      read: async () => { try { return fs.readFileSync(file); } catch { return null; } },
      size,
      open: async () => {
        // Opened before answering, so a file deleted since resolve is a 404,
        // not a 200 that dies mid-body.
        try {
          const fd = await fs.promises.open(file, "r");
          const { size: n } = await fd.stat();
          return { body: Readable.toWeb(fd.createReadStream()) as unknown as ReadableStream<Uint8Array>, size: n };
        } catch {
          return null;
        }
      },
    };
  }
  // Not a file in the folder: the file store's copy, read through the store.
  const stored = storedPath(share.tenant, share.workspace, norm);
  if (!stored) return null;
  return {
    share,
    file: `${share.workspace}/${norm}`,
    read: () => readFileBytes(share.tenant, share.workspace, stored),
    size: () => storedSize(share.tenant, share.workspace, stored).catch(() => null),
    open: async () => {
      const got = await openFile(share.tenant, share.workspace, stored).catch(() => null);
      return got ? { body: got.body, size: got.size } : null;
    },
  };
}

export async function listShares(tenant: string, workspace?: string): Promise<Share[]> {
  if (!databaseEnabled()) {
    return readAll()
      .filter((s) => s.tenant === tenant && (!workspace || s.workspace === workspace))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  const where = workspace ? and(eq(sharesTable.tenant, tenant), eq(sharesTable.workspace, workspace)) : eq(sharesTable.tenant, tenant);
  const rows = await ormRequired().select().from(sharesTable).where(where).orderBy(desc(sharesTable.createdAt));
  return rows.map(rowToShare);
}

/** True if this call revoked it; false if it was already revoked or not
 *  theirs. With `workspace`, only a link minted in that workspace — the
 *  route is `/workspaces/<ws>/shares`, and the name in the URL means it. */
export async function revokeShare(tenant: string, token: string, workspace?: string): Promise<boolean> {
  if (!databaseEnabled()) {
    const shares = readAll();
    const hit = shares.find((s) => s.token === token && s.tenant === tenant && (!workspace || s.workspace === workspace));
    if (!hit || hit.revokedAt) return false;
    hit.revokedAt = new Date().toISOString();
    writeAll(shares);
    return true;
  }
  const got = await ormRequired()
    .update(sharesTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(sharesTable.token, token), eq(sharesTable.tenant, tenant), isNull(sharesTable.revokedAt), ...(workspace ? [eq(sharesTable.workspace, workspace)] : [])))
    .returning({ token: sharesTable.token });
  return got.length === 1;
}

/**
 * Drop entries that expired long enough ago to be beyond argument. Kept well
 * past expiry so that "why did this link stop working" stays answerable.
 */
export async function pruneShares(olderThanDays = 30): Promise<number> {
  const cutoff = Date.now() - olderThanDays * 86_400_000;
  if (!databaseEnabled()) {
    const shares = readAll();
    const keep = shares.filter((s) => {
      const dead = s.revokedAt ?? s.expiresAt;
      return !dead || Date.parse(dead) > cutoff;
    });
    if (keep.length !== shares.length) writeAll(keep);
    return shares.length - keep.length;
  }
  const at = new Date(cutoff);
  // The file rule, as SQL: dead is revokedAt if set, else expiresAt.
  const gone = await ormRequired()
    .delete(sharesTable)
    .where(or(lt(sharesTable.revokedAt, at), and(isNull(sharesTable.revokedAt), lt(sharesTable.expiresAt, at))))
    .returning({ token: sharesTable.token });
  return gone.length;
}

/** shares.json into rows, once. A token already there is kept. */
export async function importSharesFile(): Promise<number> {
  if (!databaseEnabled() || !fs.existsSync(sharesFile())) return 0;
  const all = readAll();
  let n = 0;
  for (const s of all) {
    const got = await ormRequired().insert(sharesTable).values(shareToRow(s)).onConflictDoNothing().returning({ token: sharesTable.token });
    n += got.length;
  }
  fs.renameSync(sharesFile(), `${sharesFile()}.imported-${new Date().toISOString().slice(0, 10)}`);
  return n;
}

/**
 * A workspace deleted: every live link to it stops (30 Oct 2026). Revoked, not
 * deleted, as revokeShare does — "why did this link stop working" stays
 * answerable until pruneShares. Until then a deleted workspace's links kept
 * serving from the store it left behind, and came back to life for the next
 * workspace given its name.
 */
export async function revokeWorkspaceShares(tenant: string, workspace: string): Promise<number> {
  if (!databaseEnabled()) {
    const shares = readAll();
    const now = new Date().toISOString();
    let n = 0;
    for (const s of shares) {
      if (s.tenant === tenant && s.workspace === workspace && !s.revokedAt) {
        s.revokedAt = now;
        n++;
      }
    }
    if (n) writeAll(shares);
    return n;
  }
  const got = await ormRequired()
    .update(sharesTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(sharesTable.tenant, tenant), eq(sharesTable.workspace, workspace), isNull(sharesTable.revokedAt)))
    .returning({ token: sharesTable.token });
  return got.length;
}

/**
 * A workspace renamed: its links follow it (30 Oct 2026), as its files do —
 * a link already in a Google post or an email keeps working. Live links left
 * under the new name by a workspace that no longer exists are revoked first,
 * so none of them starts serving this workspace's files.
 */
export async function moveWorkspaceShares(tenant: string, from: string, to: string): Promise<number> {
  if (from === to) return 0;
  await revokeWorkspaceShares(tenant, to);
  if (!databaseEnabled()) {
    const shares = readAll();
    let n = 0;
    for (const s of shares) {
      if (s.tenant === tenant && s.workspace === from) {
        s.workspace = to;
        n++;
      }
    }
    if (n) writeAll(shares);
    return n;
  }
  const got = await ormRequired()
    .update(sharesTable)
    .set({ workspace: to })
    .where(and(eq(sharesTable.tenant, tenant), eq(sharesTable.workspace, from)))
    .returning({ token: sharesTable.token });
  return got.length;
}

/** Every link an account ever minted — with the account. */
export async function deleteShares(tenant: string): Promise<number> {
  if (!databaseEnabled()) return 0;
  return (await ormRequired().delete(sharesTable).where(eq(sharesTable.tenant, tenant)).returning({ token: sharesTable.token })).length;
}

/** Anything here is published. The directory name is the whole contract. */
export const PUBLIC_DIR = "storage/public";

/**
 * Where the URLs are written back, deliberately OUTSIDE `storage/public/` so
 * the index of what is public is not itself public.
 */
export const PUBLIC_URLS_FILE = "storage/public-urls.json";

/**
 * Give every file under `storage/public/` a link, and write the map where the
 * next step can read it.
 *
 * This exists because the agent cannot mint its own. A run's sandbox is denied
 * every private network range on purpose — it may reach the internet, never
 * this platform's API — so an agent that needed a public URL had no way to ask
 * for one, and handing sandboxes an API key to fix that would give every step
 * editor rights over the whole account.
 *
 * So the platform does it, at the one moment it can: after a step's files have
 * been copied back to the host, before the next step's sandbox is filled from
 * them. A step writes an image to `storage/public/`, the step ends, and the
 * step after it reads the URL out of a plain JSON file with no network at all.
 *
 * Auto-shares do not expire. A directory called `public` is a deliberate
 * publish, and an asset URL that dies in a week — inside a live Google post,
 * an email, a client's browser tab — is a silent breakage nobody connects back
 * to this. Revocation stays available and is the intended way to take one
 * down.
 */
export async function syncPublicShares(
  tenant: string,
  workspace: string,
): Promise<{ added: string[]; urls: Record<string, string> }> {
  const root = workspaceDir(tenant, workspace);
  const dir = path.join(root, PUBLIC_DIR);
  if (!fs.existsSync(dir)) return { added: [], urls: {} };
  // No public origin means no honest URL to write. Say nothing and change
  // nothing rather than filling the manifest with links that resolve nowhere.
  if (!publicUrl()) return { added: [], urls: {} };

  const files: string[] = [];
  const walk = (abs: string) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) {
        files.push(path.relative(root, child).replaceAll("\\", "/"));
      }
    }
  };
  walk(dir);

  const live = (await listShares(tenant, workspace)).filter((s) => isLive(s));
  const byPath = new Map(live.map((s) => [s.path, s]));
  const added: string[] = [];
  const urls: Record<string, string> = {};

  for (const rel of files.sort()) {
    let share = byPath.get(rel);
    if (!share) {
      try {
        share = await createShare(tenant, workspace, rel, { ttlDays: null, createdBy: "storage/public" });
        added.push(rel);
      } catch {
        continue; // a name the path rule refuses is skipped, never fatal
      }
    }
    urls[rel] = shareUrl(share.token);
  }

  const manifest = path.join(root, PUBLIC_URLS_FILE);
  const next = JSON.stringify(urls, null, 2) + "\n";
  const before = fs.existsSync(manifest) ? fs.readFileSync(manifest, "utf8") : "";
  if (before !== next) {
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(manifest, next);
  }
  return { added, urls };
}

/**
 * The absolute URL for a token. `FOLDRUN_PUBLIC_URL` is the origin the outside
 * world reaches this install on — and if it is unset there is no honest answer,
 * so this throws rather than handing back a localhost URL that will be pasted
 * somewhere and quietly fail for everyone but us.
 */
export function shareUrl(token: string): string {
  const base = publicUrl();
  if (!base) {
    throw new Error(
      "FOLDRUN_PUBLIC_URL is not set — a share link needs the origin this install is reachable at from outside",
    );
  }
  return `${base}/s/${token}`;
}
