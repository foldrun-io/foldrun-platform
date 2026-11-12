// Stage a run's workspace from the revision head (FOL-126 phase 3b).
//
// With `revisions.read` on, the files a step starts from come from the head
// (head → manifest → blobs through the store, the node-local cache seam in
// between) instead of a copy of the folder. The folder stays the fallback and
// the source of everything the head does not hold: binary files, the files no
// journal entry has reached yet, platform paths are never staged either way.
//
// Where both exist they are compared, and while the folder is the working copy
// THE FOLDER WINS: a path whose head differs is staged from the folder, and one
// the folder no longer has is not staged at all. It is said
// (`revisions.stage_in_differs`, a count) and the head is brought to the folder
// in the background (requestReconcile). Until 13 Nov 2026 the head won: on dev
// one desk's head held 416 files that had changed or been deleted since the
// import (old frames, a browser cache), and every step was handed them.

import fs from "node:fs";
import path from "node:path";
import { opsLog } from "../../foldrun-core/src/ops-log.ts";
import { readHeadTree, requestReconcile } from "../../foldrun-core/src/workspace-revisions.ts";

/** Copies the workspace into `into`. True when it came from the head (files
 *  the head does not hold are copied from the folder); false when the caller
 *  must copy the folder itself (reads off, no head, a blob missing). */
export async function stageFromHead(
  tenant: string,
  workspace: string,
  root: string,
  into: string,
  skip: (rel: string) => boolean,
): Promise<boolean> {
  const tree = await readHeadTree(tenant, workspace);
  if (!tree) return false;
  const staged = tree.filter((f) => !skip(f.path));
  const inHead = new Set(staged.map((f) => f.path));
  fs.cpSync(root, into, {
    recursive: true,
    preserveTimestamps: true,
    filter: (src) => {
      const rel = path.relative(root, src);
      return !skip(rel) && !inHead.has(rel);
    },
  });
  const differs: string[] = [];
  for (const f of staged) {
    const dest = path.join(into, f.path);
    const real = path.join(root, f.path);
    let st: fs.Stats;
    let now: Buffer;
    try {
      const l = fs.lstatSync(real);
      if (!l.isFile()) throw new Error("not a regular file");
      st = l;
      now = fs.readFileSync(real);
    } catch {
      differs.push(f.path); // the head has a file the folder does not: not staged
      continue;
    }
    const same = now.equals(f.bytes);
    if (!same) differs.push(f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // Same bytes: the head's copy (and the file's own time). Different: the folder's.
    fs.writeFileSync(dest, same ? f.bytes : now, { mode: (same ? f.mode : st.mode) & 0o111 ? 0o755 : 0o644 });
    fs.utimesSync(dest, st.mtime, st.mtime);
  }
  if (differs.length) {
    opsLog("warn", "revisions.stage_in_differs", { tenant, workspace, count: differs.length });
    requestReconcile(tenant, workspace);
  }
  return true;
}
