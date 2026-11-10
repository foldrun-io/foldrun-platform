// A snapshot step's patch (Part B3): what the step changed in the folder it
// was sent, as a git patch the person applies (`git apply`).
//
// Made in the still-held pod, after the agent is done, by this script — git
// is in the runner image, not the worker's. Against a FRESH copy of what the
// step was handed (sent in again now, so nothing the agent did can move the
// base), with a controlled git: no system or global config, no external diff
// or textconv, no renames, CRLF as it is. The agent's folder is copied first
// and checked for links and special files on that copy, so a swap after the
// check cannot reach the patch. The patch stays in the pod's job folder
// (root's, not the agent's) and is fetched with `kubectl cp`, byte for byte.
//
// Then, on the worker, placeSnapshotPatch puts it at outputs/snapshot.patch
// in the copied-out tree — over anything the agent wrote by that name — with
// outputs/snapshot.json saying what it holds, or why there is none. A patch
// that could not be made is "unavailable", never an empty patch: an empty
// one means the step changed nothing.

import fs from "node:fs";
import path from "node:path";
import { packSnapshot } from "../../foldrun-core/src/snapshot-archive.ts";
import { snapshotEntries } from "./snapshots.ts";

type Kc = (args: string[], input?: string, timeoutMs?: number) => Promise<{ status: number | null; out: string }>;

/** The most a patch may be; past it the patch is not kept. */
export const SNAPSHOT_PATCH_MAX = 20 * 1024 * 1024;
const OUT = "/opt/runner/snapout";

/** The script. $1: the agent's folder, $2: the workspace root (/workspace), $3: where the patch goes. Base archive (base64) on stdin. */
export const SNAPSHOT_PATCH_SH = `set -eu
W="$2/$1/snapshot"
D=$(mktemp -d)
O="$3"
rm -rf "$O"; mkdir -p "$O"; chmod 700 "$O"
# Our repository lives OUTSIDE the tree it reads: nothing in the folder — a
# .git/config with hooks or an fsmonitor — can become git's own config.
export HOME="$D" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 GIT_DIR="$D/git" GIT_WORK_TREE="$D/r"
g() { git -c core.autocrlf=false -c core.safecrlf=false -c core.quotepath=off -c core.fileMode=true -c core.hooksPath=/dev/null -c user.name=foldrun -c user.email=foldrun@localhost "$@"; }
mkdir "$D/r"
g init -q
# The folder's own .gitattributes may not change a byte: no eol or text
# normalisation, no filters, no encodings (info/attributes outranks the tree's).
printf '* -text !eol -filter -ident !working-tree-encoding !diff !merge\n' > "$D/git/info/attributes"
# Through files, not pipes: sh has no pipefail, so a failed half of a pipe
# would pass as a short archive (Codex). set -e then checks every step.
base64 -d > "$D/base.tgz"
tar xzf "$D/base.tgz" -C "$D/r" --no-same-owner
g add -A -f
g commit -q --no-verify --allow-empty -m base
find "$D/r" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
# The folder itself, never through a link: its real path must be where it is
# (the agent could have put a link to anywhere in the pod in its place).
if [ -e "$W" ] || [ -L "$W" ]; then
  if [ "$(realpath -e "$W" 2>/dev/null)" != "$(realpath -e "$2")/$1/snapshot" ] || [ ! -d "$W" ]; then echo "FOLDRUN_SNAPSHOT_REFUSED snapshot/ is not a plain folder any more (a link, or a file)"; exit 0; fi
  (cd "$W" && tar cf "$D/agent.tar" --exclude=.git .)
  tar xf "$D/agent.tar" -C "$D/r" --no-same-owner --no-same-permissions
fi
L=$(find "$D/r" ! -type f ! -type d -print | sed "s|^$D/r/||" | head -5 | tr '\\n' ' ')
if [ -n "$L" ]; then echo "FOLDRUN_SNAPSHOT_REFUSED links or special files in snapshot/: $L"; exit 0; fi
g add -A
timeout 120 git -c core.quotepath=off diff --cached --binary --no-renames --no-ext-diff --no-textconv > "$O/snapshot.patch"
# What it touches, machine-readable (status NUL path NUL): no quoting to undo.
timeout 60 git diff --cached --name-status -z --no-renames > "$O/names"
echo "FOLDRUN_SNAPSHOT_OK $(wc -c < "$O/snapshot.patch")"
rm -rf "$D"
`;

export interface PatchSummary {
  added: string[];
  modified: string[];
  deleted: string[];
}
export type PatchResult = { ok: true; file: string; bytes: number; summary: PatchSummary } | { ok: false; reason: string };

export async function makeSnapshotPatch(kc: Kc, ns: string, pod: string, staging: string, tenant: string, workspace: string, id: string, agentRel: string): Promise<PatchResult> {
  try {
    const entries = await snapshotEntries(tenant, workspace, id);
    const base = packSnapshot(entries).archive.toString("base64");
    const ran = await kc(["exec", "-i", "-n", ns, pod, "--", "sh", "-c", SNAPSHOT_PATCH_SH, "sh", agentRel, "/workspace", OUT], base, 180_000);
    const refused = /FOLDRUN_SNAPSHOT_REFUSED (.*)/.exec(ran.out);
    if (refused) return { ok: false, reason: refused[1]!.trim() };
    const made = /FOLDRUN_SNAPSHOT_OK (\d+)/.exec(ran.out);
    if (ran.status !== 0 || !made) return { ok: false, reason: `the patch could not be made: ${ran.out.trim().split("\n").slice(-3).join(" ").slice(0, 300) || `exit ${ran.status}`}` };
    const bytes = Number(made[1]);
    if (bytes > SNAPSHOT_PATCH_MAX) return { ok: false, reason: `the patch is ${bytes} bytes — the most kept is ${SNAPSHOT_PATCH_MAX}` };
    const local = path.join(staging, "snapshot.patch");
    const got = await kc(["cp", `${ns}/${pod}:${OUT}/snapshot.patch`, local], undefined, 120_000);
    if (got.status !== 0 || !fs.existsSync(local)) return { ok: false, reason: `the patch could not be fetched: ${got.out.trim().slice(0, 200)}` };
    const size = fs.statSync(local).size;
    if (size !== bytes) return { ok: false, reason: `the patch came back ${size} bytes, not ${bytes}` };
    const names = path.join(staging, "snapshot.names");
    const gotNames = await kc(["cp", `${ns}/${pod}:${OUT}/names`, names], undefined, 60_000);
    if (gotNames.status !== 0 || !fs.existsSync(names)) return { ok: false, reason: "the patch's file list could not be fetched" };
    return { ok: true, file: local, bytes, summary: parseNameStatus(fs.readFileSync(names)) };
  } catch (err) {
    return { ok: false, reason: `the patch could not be made: ${(err as Error).message.slice(0, 300)}` };
  }
}

/** `git diff --name-status -z`: status NUL path NUL, repeated. */
export function parseNameStatus(raw: Buffer): PatchSummary {
  const out: PatchSummary = { added: [], modified: [], deleted: [] };
  const parts = raw.toString("utf8").split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i]!;
    const file = parts[i + 1]!;
    if (status.startsWith("A")) out.added.push(file);
    else if (status.startsWith("D")) out.deleted.push(file);
    else out.modified.push(file);
  }
  return out;
}

/**
 * Put the patch (or why there is none) in the copied-out tree's
 * <agent>/outputs/, over whatever the agent left there by those names. The
 * trail's line comes back.
 */
export function placeSnapshotPatch(wsOut: string, agentRel: string, result: PatchResult): { ok: boolean; text: string } {
  const outputs = path.join(wsOut, agentRel, "outputs");
  // outputs/ itself must be a folder: a file or link the agent put in its
  // place goes (it would have thrown here and lost the whole copy-back — Codex).
  try {
    if (!fs.lstatSync(outputs).isDirectory()) fs.rmSync(outputs, { force: true });
  } catch {
    /* not there: made below */
  }
  // A link or folder the agent planted by these names is removed, not followed.
  fs.mkdirSync(outputs, { recursive: true });
  for (const n of ["snapshot.patch", "snapshot.json"]) fs.rmSync(path.join(outputs, n), { recursive: true, force: true });
  if (!result.ok) {
    // A marker in the patch's place, through the same copy-back (and so the
    // same revision) as a real one: an earlier run's patch — a re-run does not
    // clear outputs/ — must not read as this one's, and copy-back never
    // deletes. `git apply` refuses the marker; it never applies a stale change (Codex).
    fs.writeFileSync(path.join(outputs, "snapshot.patch"), `# foldrun: no patch for this run — ${result.reason.replace(/\n/g, " ")}\n`);
    fs.writeFileSync(path.join(outputs, "snapshot.json"), JSON.stringify({ status: "unavailable", reason: result.reason }, null, 2) + "\n");
    return { ok: false, text: `snapshot: no patch — ${result.reason}` };
  }
  const bytes = fs.readFileSync(result.file);
  const summary = result.summary;
  fs.writeFileSync(path.join(outputs, "snapshot.patch"), bytes);
  const changed = summary.added.length + summary.modified.length + summary.deleted.length;
  fs.writeFileSync(path.join(outputs, "snapshot.json"), JSON.stringify({ status: changed ? "changed" : "unchanged", bytes: result.bytes, ...summary }, null, 2) + "\n");
  return {
    ok: true,
    text: changed
      ? `snapshot: patch ready — ${summary.modified.length} changed, ${summary.added.length} added, ${summary.deleted.length} deleted (outputs/snapshot.patch)`
      : "snapshot: the step changed nothing in snapshot/",
  };
}
