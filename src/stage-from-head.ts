// Stage a run's workspace from the revision head (FOL-126 phase 3b).
//
// With `revisions.read` on, the files a step starts from come from the head
// (head → manifest → blobs through the store, the node-local cache seam in
// between) instead of a copy of the folder. The folder stays the fallback and
// the source of everything the head does not hold: binary files, the files no
// journal entry has reached yet, platform paths are never staged either way.
//
// Where both exist they are compared, and a head that differs from the folder
// is said (`revisions.stage_in_differs`, a count and a few names): while the
// folder is still the working copy, a differing head is a journal that is
// behind, and the operator should see that before relying on the setting.

import fs from "node:fs";
import path from "node:path";
import { opsLog } from "../../foldrun-core/src/ops-log.ts";
import { readHeadTree } from "../../foldrun-core/src/workspace-revisions.ts";

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
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let mtime: Date | null = null;
    try {
      const real = path.join(root, f.path);
      const st = fs.statSync(real);
      if (fs.readFileSync(real).equals(f.bytes)) mtime = st.mtime; // same bytes: the file's own time
      else differs.push(f.path);
    } catch {
      differs.push(f.path); // the head has a file the folder does not
    }
    fs.writeFileSync(dest, f.bytes, { mode: f.mode & 0o111 ? 0o755 : 0o644 });
    if (mtime) fs.utimesSync(dest, mtime, mtime);
  }
  if (differs.length) opsLog("warn", "revisions.stage_in_differs", { tenant, workspace, count: differs.length, paths: differs.slice(0, 5).join(",") });
  return true;
}
