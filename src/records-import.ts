// The files that held runs, the trigger log and the storage index, moved into
// their tables (FOL-126 phase 2), safely while other processes keep working
// (FOL-152).
//
//   runs/<id>.json          → run_records   (the whole record + its list row)
//   runs/.index.json        → set aside (the table's rows are the index)
//   trigger-log.jsonl       → trigger_events
//   storage/<ws>/index.json → workspace_files
//
// Where a workspace's records are is its routing row (records-routing.ts),
// the same for every process, never which files happen to exist. First, once
// per install (seedRouting): a workspace FOL-126's release already serves from
// its rows starts in the database, and one with rows of that release beside
// record files is marked `legacy` (its rows are added to, never deleted for
// want of a file). Then a move, for all the workspaces still on files at
// once, under one fenced lock:
//
//   1. copy   every workspace's files into rows while the files stay the
//             records (every process goes on reading and writing them); note
//             each file's inode, size and mtime as it was read
//   2. hold   one transaction puts them (and, when the install's default is
//             still files, the default) at `moving`; then wait until every
//             process seen lately has acknowledged that routing — from then
//             on no process reads or writes those files or rows
//   3. settle with nothing moving, make the rows exactly what the files say:
//             what changed since the copy is copied again, a run whose file
//             is gone loses its row, the storage rows become the index
//   4. flip   one transaction: `database`, for good
//   5. set aside every record file of a workspace in the database, as
//             `.imported-<date>` — housekeeping only now, since no read
//             depends on which files exist
//
// A workspace whose copy or settle fails goes back to `files` whole (its rows
// are only ever a draft until the flip) and the next boot tries again. A
// workspace whose folder vanished between 1 and 2 (a rename, a delete) goes
// back to `files` too. The default moves the same way: before it flips, every
// workspace with no row of its own (one made during the move) is settled too.
// A record file found in a workspace already in the database (step 5 runs at
// every boot) is set aside as `.imported-<date>` when its rows say the same, and as
// `.stray-<date>` — named in the ops log, never merged in — when they do not:
// a write from a process of an older release, or one that hung in the kernel
// past the barrier. Run output folders (runs/<id>/) stay where they are.
//
// ROLLOUT (FOL-152). A process of the release before this one reads no
// routing: while one runs, a move would hide what it reads and it would
// write files no one imports. So:
//   1. deploy this release with FOLDRUN_RECORDS=files everywhere, and wait
//      until no process of the old release is left (every deployment's
//      rollout finished: web, worker, assistant);
//   2. remove FOLDRUN_RECORDS=files (rolling is fine: processes of this
//      release in files mode take part in the barrier). The first process to
//      boot in database mode moves everything; the others find it done.
//   3. check the ops log for records.on_files (still on files, and why) and
//      records.stray_set_aside.
// FOLDRUN_RECORDS=files never moves anything back: a workspace in the
// database stays there.

import fs from "node:fs";
import path from "node:path";
import { opsLog, opsError } from "../../foldrun-core/src/ops-log.ts";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { listTenants, workspaceDir, summarizeRun, STORAGE_DIR, type RunRecord } from "../../foldrun-core/src/store.ts";
import { withFileLock, type FileRecord } from "../../foldrun-core/src/storage.ts";
import type { TriggerEvent } from "../../foldrun-core/src/trigger-log.ts";
import { sql } from "drizzle-orm";
import { tx, db, type Db } from "./db.ts";
import { runRecords, workspaceFiles } from "./schema.ts";
import { withFencedLock, assertFence, type Fence } from "./fenced-lock.ts";
import { ackWindowMs, BUMP_GEN, DEFAULT, invalidateRouting, loadRouting, routingPod } from "./records-routing.ts";

const CHUNK = 100;
const KEEP_TRIGGER_EVENTS = 500;
const LIVE = new Set(["queued", "running", "awaiting-approval"]);

/** How long the barrier waits for every process to acknowledge. */
const ackWaitMs = () => Number(process.env.FOLDRUN_RECORDS_ACK_WAIT_MS) || 60_000;
/** How long a move may hold its workspaces at `moving` in all: the barrier,
 *  then the settle. Past it the flip is refused and the files stand. */
const moveBudgetMs = () => ackWaitMs() + (Number(process.env.FOLDRUN_RECORDS_SETTLE_MS) || 120_000);

/** Rename `file` to `<file>.imported-<date>` (or `.<label>-<date>`); a name already taken gets a number.
 *  False when there was nothing to rename (another pod did it). */
export function setAside(file: string, label = "imported"): boolean {
  const day = new Date().toISOString().slice(0, 10);
  for (let n = 1; ; n++) {
    const to = `${file}.${label}-${day}${n > 1 ? `-${n}` : ""}`;
    try {
      if (fs.existsSync(to)) continue;
      fs.renameSync(file, to);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return false;
      if (code === "EEXIST" || code === "ENOTEMPTY" || code === "EISDIR") continue;
      throw err;
    }
  }
}

/** When a file was last written: what "newer than the row" compares. */
function fileTime(file: string): Date {
  try {
    return new Date(fs.statSync(file).mtimeMs);
  } catch {
    return new Date();
  }
}

/** Which version of a file this is. Every writer of these files replaces them
 *  by rename (a new inode) or appends (a new size), so a write since the copy
 *  always changes it. */
function signature(file: string): string | null {
  try {
    const st = fs.statSync(file);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

export interface ImportCounts {
  runs: number;
  runsSkipped: number;
  triggerEvents: number;
  storageFiles: number;
  /** Record files found in a workspace already in the database that its rows do not match: set aside, not merged. */
  strays: number;
}

const runsDirOf = (tenant: string, workspace: string) => path.join(workspaceDir(tenant, workspace), "runs");
const logFileOf = (tenant: string, workspace: string) => path.join(workspaceDir(tenant, workspace), "trigger-log.jsonl");
const storageRootOf = (tenant: string) => path.join(dataRoot(), tenant, STORAGE_DIR);
const indexFileOf = (tenant: string, workspace: string) => path.join(storageRootOf(tenant), workspace, "index.json");

/** The folder's entries; none when there is no folder. Any other failure
 *  (EACCES, an I/O error on the volume) throws: an empty answer would read as
 *  "every run was deleted" and the settle would delete their rows. */
function entries(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR") return [];
    throw err;
  }
}

function liveRunNames(dir: string): string[] {
  return entries(dir).filter((f) => f.endsWith(".json") && !f.startsWith("."));
}

/** Did a release before this one already move this workspace (FOL-126's boot
 *  import set its files aside)? Then rows it wrote since may have no file at
 *  all, and the settle must not delete them for that. */
function movedBefore(tenant: string, workspace: string): boolean {
  const imported = /\.imported-\d{4}-\d{2}-\d{2}/;
  if (entries(runsDirOf(tenant, workspace)).some((f) => imported.test(f))) return true;
  const has = (dir: string, base: string) => entries(dir).some((f) => f.startsWith(`${base}.imported-`));
  return has(workspaceDir(tenant, workspace), "trigger-log.jsonl") || has(path.join(storageRootOf(tenant), workspace), "index.json");
}

/** What the copy saw of one workspace, for the settle to compare against. */
interface Seen {
  hadFolder: boolean;
  runs: Map<string, string | null>;
  log: string | null;
  index: string | null;
}

/** Copy run files into rows. `force`: the files are the records (the settle,
 *  nothing moving), so they replace any row; otherwise a row is replaced only
 *  by a file newer than it — rows a release before this one wrote while a
 *  workspace was half moved. A file that cannot be read as a run is set aside
 *  as `.unreadable-<date>` and counted, not guessed at. */
async function copyRuns(tenant: string, workspace: string, names: string[], fence: Fence, force: boolean, counts: ImportCounts): Promise<void> {
  const dir = runsDirOf(tenant, workspace);
  for (let i = 0; i < names.length; i += CHUNK) {
    const rows: (typeof runRecords.$inferInsert)[] = [];
    for (const f of names.slice(i, i + CHUNK)) {
      const file = path.join(dir, f);
      let run: RunRecord;
      let summary: ReturnType<typeof summarizeRun>;
      try {
        run = JSON.parse(fs.readFileSync(file, "utf8")) as RunRecord;
        if (!run || typeof run.id !== "string" || typeof run.startedAt !== "string" || typeof run.status !== "string" || !Array.isArray(run.steps)) throw new Error("not a run");
        // Built here, inside the guard: a record that parses but is not shaped
        // like a run (a step with no events) is quarantined alone, it does not
        // stop the workspace.
        summary = summarizeRun(run);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // gone since the listing
        // Torn or foreign: kept for a person to look at under another name, so
        // it is neither read as a run again nor counted on every boot.
        if (setAside(file, "unreadable")) {
          counts.runsSkipped++;
          opsLog("warn", "records.import_skipped", { tenant, workspace, kind: "runs", count: 1, reason: "unreadable" });
        }
        continue;
      }
      rows.push({
        updatedAt: fileTime(file),
        tenant,
        workspace,
        runId: run.id,
        flow: run.flow ?? null,
        status: run.status,
        live: LIVE.has(run.status),
        startedAt: run.startedAt,
        finishedAt: run.finishedAt ?? null,
        summary,
        record: run,
      });
    }
    if (!rows.length) continue;
    await tx(async (t) => {
      await assertFence(t, fence);
      await t
        .insert(runRecords)
        .values(rows)
        .onConflictDoUpdate({
          target: [runRecords.tenant, runRecords.workspace, runRecords.runId],
          set: {
            flow: sql`excluded.flow`, status: sql`excluded.status`, live: sql`excluded.live`, startedAt: sql`excluded.started_at`,
            finishedAt: sql`excluded.finished_at`, summary: sql`excluded.summary`, record: sql`excluded.record`, updatedAt: sql`excluded.updated_at`,
          },
          ...(force ? {} : { setWhere: sql`${runRecords.updatedAt} < excluded.updated_at` }),
        });
    });
  }
}

function readTriggerLog(file: string): TriggerEvent[] {
  const events: TriggerEvent[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as TriggerEvent;
      if (e && typeof e.t === "string" && typeof e.flow === "string" && typeof e.trigger === "string" && typeof e.outcome === "string") events.push(e);
    } catch {
      // a torn line loses that line, as it always did
    }
  }
  return events;
}

/** The trigger log's newest 500, oldest first so the identity column orders
 *  them as the file did. The table has no natural key, so an event is skipped
 *  when one with the same instant, flow, trigger, outcome and run is already
 *  there: copying the same file twice (the copy, then the settle) adds nothing. */
async function copyTriggerLog(tenant: string, workspace: string, fence: Fence): Promise<number> {
  const file = logFileOf(tenant, workspace);
  if (!fs.existsSync(file)) return 0;
  const keep = readTriggerLog(file).slice(-KEEP_TRIGGER_EVENTS);
  await tx(async (t) => {
    await assertFence(t, fence);
    for (let i = 0; i < keep.length; i += CHUNK) {
      const rows = keep.slice(i, i + CHUNK).map((e, ord) => ({ ord, t: e.t, flow: e.flow, trigger: e.trigger, outcome: e.outcome, detail: e.detail ?? null, run_id: e.runId ?? null }));
      await t.execute(sql`
        INSERT INTO trigger_events (tenant, workspace, t, flow, trigger, outcome, detail, run_id)
        SELECT ${tenant}, ${workspace}, v.t, v.flow, v.trigger, v.outcome, v.detail, v.run_id
        FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS v(ord int, t text, flow text, trigger text, outcome text, detail text, run_id text)
        WHERE NOT EXISTS (
          SELECT 1 FROM trigger_events e
          WHERE e.tenant = ${tenant} AND e.workspace = ${workspace} AND e.t = v.t AND e.flow = v.flow
            AND e.trigger = v.trigger AND e.outcome = v.outcome AND e.run_id IS NOT DISTINCT FROM v.run_id)
        ORDER BY v.ord`);
    }
  });
  return keep.length;
}

function readIndexFile(file: string): FileRecord[] {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { files?: FileRecord[] };
  return (raw.files ?? []).filter((f) => f && typeof f.path === "string" && typeof f.sha === "string" && Number.isFinite(f.size));
}

/** The storage index into rows (the blobs stay where they are). `exact`: the
 *  index is the whole truth (the settle), so a path it no longer names loses
 *  its row too. An index that cannot be read stops the workspace's move. */
async function copyIndex(tenant: string, workspace: string, fence: Fence, force: boolean, exact: boolean): Promise<number> {
  const file = indexFileOf(tenant, workspace);
  let files: FileRecord[];
  try {
    files = readIndexFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    opsLog("warn", "records.import_skipped", { tenant, workspace, kind: "storage_index", reason: "unreadable" });
    throw new Error(`the storage index of ${tenant}/${workspace} cannot be read`);
  }
  for (let i = 0; i < files.length; i += CHUNK) {
    await tx(async (t) => {
      await assertFence(t, fence);
      await t
        .insert(workspaceFiles)
        .values(files.slice(i, i + CHUNK).map((f) => ({ tenant, workspace, path: f.path, sha: f.sha, size: f.size, mime: f.mime, updatedAt: new Date(f.updatedAt), by: f.by })))
        .onConflictDoUpdate({
          target: [workspaceFiles.tenant, workspaceFiles.workspace, workspaceFiles.path],
          set: { sha: sql`excluded.sha`, size: sql`excluded.size`, mime: sql`excluded.mime`, updatedAt: sql`excluded.updated_at`, by: sql`excluded.by` },
          ...(force ? {} : { setWhere: sql`${workspaceFiles.updatedAt} < excluded.updated_at` }),
        });
    });
  }
  if (exact) {
    await tx(async (t) => {
      await assertFence(t, fence);
      await t.execute(sql`DELETE FROM workspace_files WHERE tenant = ${tenant} AND workspace = ${workspace} AND path NOT IN (SELECT jsonb_array_elements_text(${JSON.stringify(files.map((f) => f.path))}::jsonb))`);
    });
  }
  return files.length;
}

/** Step 1: copy, with the files still the records. */
async function copyWorkspace(tenant: string, workspace: string, fence: Fence, legacy: boolean, counts: ImportCounts): Promise<Seen> {
  const seen: Seen = { hadFolder: fs.existsSync(workspaceDir(tenant, workspace)), runs: new Map(), log: null, index: null };
  const dir = runsDirOf(tenant, workspace);
  const names = liveRunNames(dir);
  // The files are the records of a workspace on files, so they replace any
  // row (a draft of an earlier attempt) — except where a release before this
  // one already moved it and may have written rows newer than its files.
  const force = !legacy && !movedBefore(tenant, workspace);
  // Each signature is taken BEFORE its file is read: a write in between shows
  // as a change at the settle, never as one missed.
  for (const f of names) seen.runs.set(f, signature(path.join(dir, f)));
  await copyRuns(tenant, workspace, names, fence, force, counts);
  seen.log = signature(logFileOf(tenant, workspace));
  const n = await copyTriggerLog(tenant, workspace, fence);
  if (n) {
    counts.triggerEvents += n;
    opsLog("info", "records.imported", { tenant, workspace, kind: "trigger_log", count: n });
  }
  seen.index = signature(indexFileOf(tenant, workspace));
  const m = await copyIndex(tenant, workspace, fence, force, false);
  if (m) {
    counts.storageFiles += m;
    opsLog("info", "records.imported", { tenant, workspace, kind: "storage_index", count: m });
  }
  return seen;
}

/** Step 3: with nothing moving, the rows become exactly what the files say.
 *  `seen` null: nothing was copied before (a workspace made during the move),
 *  so everything is. Under the storage file lock, so an index operation that
 *  took it before the barrier (an upload, a purge) has finished first. */
async function settleWorkspace(tenant: string, workspace: string, fence: Fence, seen: Seen | null, legacy: boolean, counts: ImportCounts): Promise<void> {
  const storageRoot = storageRootOf(tenant);
  const work = async () => {
    const dir = runsDirOf(tenant, workspace);
    const names = liveRunNames(dir);
    const changed = names.filter((f) => !seen || seen.runs.get(f) !== signature(path.join(dir, f)));
    await copyRuns(tenant, workspace, changed, fence, true, counts);
    const before = legacy || movedBefore(tenant, workspace);
    if (!before) {
      // A run with no file left was deleted while it was on files (or is a
      // draft row of an earlier attempt): its row goes. Not where a release
      // before this one already moved the workspace — rows it wrote since
      // have no file at all.
      const keep = [...liveRunNames(dir)].map((f) => f.slice(0, -".json".length));
      await tx(async (t) => {
        await assertFence(t, fence);
        await t.execute(sql`DELETE FROM run_records WHERE tenant = ${tenant} AND workspace = ${workspace} AND run_id NOT IN (SELECT jsonb_array_elements_text(${JSON.stringify(keep)}::jsonb))`);
      });
    }
    if (!seen || seen.log !== signature(logFileOf(tenant, workspace))) {
      const n = await copyTriggerLog(tenant, workspace, fence);
      if (!seen) counts.triggerEvents += n;
    }
    if (fs.existsSync(indexFileOf(tenant, workspace))) {
      if (!seen || seen.index !== signature(indexFileOf(tenant, workspace)) || !before) {
        const n = await copyIndex(tenant, workspace, fence, true, !before);
        if (!seen) counts.storageFiles += n;
      }
    } else if (!before) {
      // No index on files means no stored files: so none in the rows either.
      await tx(async (t) => {
        await assertFence(t, fence);
        await t.execute(sql`DELETE FROM workspace_files WHERE tenant = ${tenant} AND workspace = ${workspace}`);
      });
    }
  };
  if (fs.existsSync(storageRoot)) await withFileLock(path.join(storageRoot, `.${workspace}.lock`), work);
  else await work();
}

/** Same JSON, whatever the key order (jsonb keeps its own). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Step 5, for a workspace in the database: set every record file aside —
 *  `.imported-<date>` when its rows say the same, `.stray-<date>` when they do
 *  not. A stray is never merged in: whether it is newer than its row cannot be
 *  known from here, so a person decides. A rename that fails is a warning: no
 *  read depends on it, and the next boot tries again. */
async function setAsideWorkspace(tenant: string, workspace: string, counts: ImportCounts): Promise<void> {
  const p = db()!;
  let strays = 0;
  let imported = 0;
  const aside = (file: string, label: string) => {
    try {
      return setAside(file, label);
    } catch (err) {
      opsError("records.set_aside_failed", err, { tenant, workspace }, "warn");
      return false;
    }
  };
  const dir = runsDirOf(tenant, workspace);
  const names = liveRunNames(dir);
  for (let i = 0; i < names.length; i += CHUNK) {
    const chunk = names.slice(i, i + CHUNK);
    const files = new Map<string, unknown>();
    for (const f of chunk) {
      try {
        files.set(f, JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        if (aside(path.join(dir, f), "unreadable")) counts.runsSkipped++;
      }
    }
    const ids = [...files.values()].map((r) => (r as { id?: unknown })?.id).filter((x): x is string => typeof x === "string");
    const rows = new Map<string, unknown>();
    if (ids.length) {
      const r = await p.query("SELECT run_id, record FROM run_records WHERE tenant = $1 AND workspace = $2 AND run_id = ANY($3::text[])", [tenant, workspace, ids]);
      for (const x of r.rows) rows.set(x.run_id as string, x.record);
    }
    for (const [f, run] of files) {
      const id = (run as { id?: unknown })?.id;
      const same = typeof id === "string" && rows.has(id) && canonical(rows.get(id)) === canonical(run);
      if (aside(path.join(dir, f), same ? "imported" : "stray")) {
        if (same) imported++;
        else strays++;
      }
    }
  }
  aside(path.join(dir, ".index.json"), "imported");
  const log = logFileOf(tenant, workspace);
  if (fs.existsSync(log)) {
    const keep = readTriggerLog(log).slice(-KEEP_TRIGGER_EVENTS);
    const rows = keep.map((e) => ({ t: e.t, flow: e.flow, trigger: e.trigger, outcome: e.outcome, run_id: e.runId ?? null }));
    const r = await p.query(
      `SELECT v.t FROM jsonb_to_recordset($3::jsonb) AS v(t text, flow text, trigger text, outcome text, run_id text)
       WHERE NOT EXISTS (SELECT 1 FROM trigger_events e WHERE e.tenant = $1 AND e.workspace = $2 AND e.t = v.t AND e.flow = v.flow
         AND e.trigger = v.trigger AND e.outcome = v.outcome AND e.run_id IS NOT DISTINCT FROM v.run_id)`,
      [tenant, workspace, JSON.stringify(rows)],
    );
    // A line the table no longer has may simply be older than the newest 500
    // it keeps; only one at least as new as the oldest row kept is a stray.
    const oldest = (await p.query("SELECT min(t) AS t FROM trigger_events WHERE tenant = $1 AND workspace = $2", [tenant, workspace])).rows[0].t as string | null;
    const missing = r.rows.some((x) => oldest === null || (x.t as string) >= oldest);
    if (aside(log, missing ? "stray" : "imported") && missing) strays++;
  }
  const index = indexFileOf(tenant, workspace);
  if (fs.existsSync(index)) {
    let same = false;
    try {
      const files = readIndexFile(index);
      const r = await p.query("SELECT path, sha, size FROM workspace_files WHERE tenant = $1 AND workspace = $2", [tenant, workspace]);
      const have = new Map(r.rows.map((x) => [x.path as string, `${x.sha}:${Number(x.size)}`]));
      same = files.length === have.size && files.every((f) => have.get(f.path) === `${f.sha}:${f.size}`);
    } catch {
      same = false;
    }
    if (aside(index, same ? "imported" : "stray") && !same) strays++;
  }
  counts.runs += imported;
  counts.strays += strays;
  if (imported) opsLog("info", "records.imported", { tenant, workspace, kind: "runs", count: imported });
  if (strays) opsLog("warn", "records.stray_set_aside", { tenant, workspace, count: strays });
}

/** What the import left: counts of what moved, and the workspaces that are
 *  still on FILES (their records could not all be moved) — served from those
 *  files by every process and tried again at the next boot. */
export interface ImportResult {
  counts: ImportCounts | null;
  onFiles: { tenant: string; workspace: string }[];
}

interface Routing {
  def: string;
  rows: Map<string, string>;
  /** Workspaces whose rows predate the routing (seedRouting). */
  legacy: Set<string>;
}
const k = (tenant: string, workspace: string) => `${tenant}\0${workspace}`;

async function readRouting(): Promise<Routing> {
  const r = await db()!.query("SELECT tenant, workspace, state, legacy FROM records_routing");
  const out: Routing = { def: "files", rows: new Map(), legacy: new Set() };
  for (const x of r.rows) {
    if (x.tenant === DEFAULT && x.workspace === DEFAULT) out.def = x.state as string;
    else {
      out.rows.set(k(x.tenant as string, x.workspace as string), x.state as string);
      if (x.legacy) out.legacy.add(k(x.tenant as string, x.workspace as string));
    }
  }
  return out;
}

const SAFE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A tenant's workspaces, from the folders alone. Not core's listWorkspaces:
 *  that counts each workspace's runs through the records port, and a
 *  workspace this import holds at `moving` would make it wait, then refuse. */
function workspaceNames(tenant: string): string[] {
  const base = path.join(dataRoot(), tenant);
  const current = path.join(base, "workspaces");
  const dir = fs.existsSync(current) ? current : fs.existsSync(path.join(base, "projects")) ? path.join(base, "projects") : current;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => SAFE_NAME.test(n) && fs.statSync(path.join(dir, n)).isDirectory());
}

/** Every tenant's workspaces, and the tenants that could not be listed. */
function enumerate(): { all: { tenant: string; workspace: string }[]; failed: string[] } {
  const all: { tenant: string; workspace: string }[] = [];
  const failed: string[] = [];
  for (const tenant of listTenants()) {
    try {
      for (const workspace of workspaceNames(tenant)) all.push({ tenant, workspace });
    } catch (err) {
      opsError("records.import_failed", err, { tenant });
      failed.push(tenant);
    }
  }
  return { all, failed };
}

/** Does this workspace still hold a record file? (What FOL-126's release
 *  decided "on files" by, for the whole workspace.) */
function hasRecordFiles(tenant: string, workspace: string): boolean {
  return liveRunNames(runsDirOf(tenant, workspace)).length > 0 || fs.existsSync(logFileOf(tenant, workspace)) || fs.existsSync(indexFileOf(tenant, workspace));
}

/**
 * The routing's first contact with an install (every process with a
 * database, in either mode, at boot, before it serves). FOL-126's release, run
 * with a database, served a workspace from its rows whenever it had no record
 * files left — moved by its import, or made after it and never on files at
 * all — so such a workspace starts in the database here too, instead of
 * falling back to files it does not have. One with rows AND record files was
 * on files for that release (or for a process of it in files mode), and its
 * rows may hold runs no file has: it stays on files until a move, marked
 * `legacy`, so the move adds its files to its rows and deletes none of them.
 * Once only: the install's default row marks it done.
 */
export async function seedRouting(): Promise<void> {
  const seeded = async () => Boolean((await db()!.query("SELECT 1 FROM records_routing WHERE tenant = '*' AND workspace = '*'")).rows.length);
  if (await seeded()) return;
  await withFencedLock(
    "records-import",
    async (fence) => {
      if (await seeded()) return;
      const routing = await readRouting();
      const r = await db()!.query(
        "SELECT DISTINCT tenant, workspace FROM run_records UNION SELECT DISTINCT tenant, workspace FROM trigger_events UNION SELECT DISTINCT tenant, workspace FROM workspace_files",
      );
      const withRows = new Set(r.rows.map((x) => k(x.tenant as string, x.workspace as string)));
      const listed = enumerate();
      // An account that cannot be listed may hold workspaces only the
      // database has: nothing is marked done until every one was looked at.
      if (listed.failed.length) throw new Error(`the workspaces of ${listed.failed.length} account(s) could not be listed — the routing is not seeded yet`);
      const database: { tenant: string; workspace: string }[] = [];
      const legacy: { tenant: string; workspace: string }[] = [];
      for (const w of listed.all) {
        const key = k(w.tenant, w.workspace);
        if (routing.rows.has(key)) continue;
        const before = withRows.has(key) || movedBefore(w.tenant, w.workspace);
        if (!before) continue;
        (hasRecordFiles(w.tenant, w.workspace) ? legacy : database).push(w);
      }
      await route(fence, async (t) => {
        for (const [list, state, old] of [[database, "database", false], [legacy, "files", true]] as const) {
          if (!list.length) continue;
          await t.execute(sql`
            INSERT INTO records_routing (tenant, workspace, state, legacy)
            SELECT v.tenant, v.workspace, ${state}, ${old} FROM jsonb_to_recordset(${JSON.stringify(list)}::jsonb) AS v(tenant text, workspace text)
            ON CONFLICT (tenant, workspace) DO NOTHING`);
        }
      });
      if (database.length || legacy.length) opsLog("info", "records.routing_seeded", { count: database.length, legacy: legacy.length });
    },
    Math.max(5 * 60_000, moveBudgetMs() + 60_000),
  );
}

/** Wait until every process seen in the last ackWindowMs routes by `gen`
 *  (this one excepted: it reads its own changes at once). */
async function barrier(gen: number): Promise<boolean> {
  const until = Date.now() + ackWaitMs();
  for (;;) {
    const r = await db()!.query(
      "SELECT count(*)::int AS n FROM records_routing_pods WHERE pod <> $1 AND gen < $2 AND beat_at > now() - ($3::int * interval '1 millisecond')",
      [routingPod(), gen, ackWindowMs()],
    );
    if (Number(r.rows[0].n) === 0) return true;
    if (Date.now() >= until) return false;
    await new Promise((res) => setTimeout(res, 200));
  }
}

/** A routing change, in one fenced transaction with its generation bump.
 *  Every statement in it is bounded (5 s, waits for locks included), and so
 *  is every pause between them (idle in transaction: the session is ended and
 *  the change rolled back). `last` runs after the bump, as the transaction's
 *  final statement: a flip checks its deadline there, so nothing but the
 *  COMMIT — itself bounded by the idle limit — stands between that check and
 *  the change becoming visible, and the processes start treating a hold as
 *  given up only 30 s after its deadline. */
async function route(fence: Fence, fn: (t: Db) => Promise<void>, last?: (t: Db) => Promise<void>): Promise<number> {
  const gen = await tx(async (t) => {
    await t.execute(sql`SET LOCAL statement_timeout = 5000`);
    await t.execute(sql`SET LOCAL lock_timeout = 5000`);
    await t.execute(sql`SET LOCAL idle_in_transaction_session_timeout = 5000`);
    await assertFence(t, fence);
    await fn(t);
    const r = await t.execute<{ gen: string }>(sql.raw(BUMP_GEN));
    if (last) await last(t);
    return Number(r.rows[0].gen);
  });
  // This process routes by the change at once — or, if it cannot read it
  // back, by nothing it read before: its old `files` must not outlive it.
  await loadRouting().catch(() => invalidateRouting());
  return gen;
}

async function moveAll(fence: Fence, counts: ImportCounts): Promise<void> {
  // A move a stalled or dead holder of this lock left half done: its
  // workspaces go back to files (their rows are only a draft), and its own
  // writes from now on are refused by the fence.
  const stuck = await db()!.query("SELECT count(*)::int AS n FROM records_routing WHERE state = 'moving'");
  if (Number(stuck.rows[0].n)) {
    await route(fence, async (t) => {
      await t.execute(sql`UPDATE records_routing SET state = 'files', moving_until = NULL, changed_at = now() WHERE state = 'moving'`);
    });
    opsLog("warn", "records.move_abandoned", { count: Number(stuck.rows[0].n) });
  }
  await db()!.query("DELETE FROM records_routing_pods WHERE beat_at < now() - interval '1 day'");

  let routing = await readRouting();
  const { all, failed } = enumerate();
  // Every workspace there is gets a row of its own while the default is
  // files: the default can then move without carrying them along unawares.
  const rowless = all.filter((w) => !routing.rows.has(k(w.tenant, w.workspace)));
  if (routing.def === "files" && rowless.length) {
    await route(fence, async (t) => {
      await t.execute(sql`
        INSERT INTO records_routing (tenant, workspace, state)
        SELECT v.tenant, v.workspace, 'files' FROM jsonb_to_recordset(${JSON.stringify(rowless)}::jsonb) AS v(tenant text, workspace text)
        ON CONFLICT (tenant, workspace) DO NOTHING`);
    });
    routing = await readRouting();
  }

  // 1. copy
  const seen = new Map<string, { tenant: string; workspace: string; seen: Seen }>();
  for (const [key, state] of routing.rows) {
    if (state !== "files") continue;
    const [tenant, workspace] = key.split("\0");
    // A name with no folder: its records are gone with it, unless its stored
    // files are still there (a rename may be moving them right now).
    if (!fs.existsSync(workspaceDir(tenant, workspace)) && fs.existsSync(path.join(storageRootOf(tenant), workspace))) continue;
    try {
      seen.set(key, { tenant, workspace, seen: await copyWorkspace(tenant, workspace, fence, routing.legacy.has(key), counts) });
    } catch (err) {
      opsError("records.import_failed", err, { tenant, workspace });
    }
  }
  const withDefault = routing.def === "files" && failed.length === 0;
  if (!seen.size && !withDefault) return;

  // 2. hold
  const budget = moveBudgetMs();
  const pairs = [...seen.values()].map((s) => ({ tenant: s.tenant, workspace: s.workspace }));
  const gen = await route(fence, async (t) => {
    // Acknowledgements wait for this hold to commit, so one in flight now
    // either landed before it (and is counted below, at the old generation)
    // or reads the new generation (and renews nothing): see ACK.
    await t.execute(sql`LOCK TABLE records_routing_pods IN SHARE MODE`);
    await t.execute(sql`
      UPDATE records_routing r SET state = 'moving', moving_until = now() + (${budget}::int * interval '1 millisecond'), changed_at = now()
      FROM jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb) AS v(tenant text, workspace text)
      WHERE r.tenant = v.tenant AND r.workspace = v.workspace AND r.state = 'files'`);
    if (withDefault) {
      await t.execute(sql`INSERT INTO records_routing (tenant, workspace, state, gen) VALUES ('*', '*', 'files', 0) ON CONFLICT DO NOTHING`);
      await t.execute(sql`UPDATE records_routing SET state = 'moving', moving_until = now() + (${budget}::int * interval '1 millisecond') WHERE tenant = '*' AND workspace = '*' AND state = 'files'`);
    }
  });
  const held = await readRouting();
  const moving = [...seen.values()].filter((s) => held.rows.get(k(s.tenant, s.workspace)) === "moving");
  const back = async (reason: string) => {
    await route(fence, async (t) => {
      await t.execute(sql`UPDATE records_routing SET state = 'files', moving_until = NULL, changed_at = now() WHERE state = 'moving'`);
    });
    opsLog("error", "records.move_abandoned", { count: moving.length, reason });
  };
  if (!(await barrier(gen))) {
    await back("not_acknowledged");
    return;
  }

  // 3. settle
  const done: { tenant: string; workspace: string }[] = [];
  const undone: { tenant: string; workspace: string }[] = [];
  for (const s of moving) {
    try {
      // Its folder went between the copy and the hold (a rename or a delete,
      // or one caught half way and put back): left on files, tried again.
      if (s.seen.hadFolder && !fs.existsSync(workspaceDir(s.tenant, s.workspace))) throw new Error("its folder is gone");
      await settleWorkspace(s.tenant, s.workspace, fence, s.seen, held.legacy.has(k(s.tenant, s.workspace)), counts);
      done.push({ tenant: s.tenant, workspace: s.workspace });
    } catch (err) {
      opsError("records.import_failed", err, { tenant: s.tenant, workspace: s.workspace });
      undone.push({ tenant: s.tenant, workspace: s.workspace });
    }
  }
  // The default: every workspace with no row of its own was made during this
  // move (the rest got rows above) and is held too; each is settled whole, or
  // keeps its files under a row of its own.
  const lonely: { tenant: string; workspace: string }[] = [];
  let defaultOk = held.def === "moving";
  if (defaultOk) {
    const again = enumerate();
    if (again.failed.length) defaultOk = false;
    for (const w of again.all) {
      if (held.rows.has(k(w.tenant, w.workspace))) continue;
      try {
        await settleWorkspace(w.tenant, w.workspace, fence, null, false, counts);
      } catch (err) {
        opsError("records.import_failed", err, { tenant: w.tenant, workspace: w.workspace });
        lonely.push(w);
      }
    }
  }

  // 4. flip — only within the budget, on the database's clock as it reads
  // when each row is flipped (not the transaction's start): past it the
  // processes have begun treating the hold as given up, and the files stand.
  await route(
    fence,
    async (t) => {
      if (lonely.length) {
        await t.execute(sql`
          INSERT INTO records_routing (tenant, workspace, state)
          SELECT v.tenant, v.workspace, 'files' FROM jsonb_to_recordset(${JSON.stringify(lonely)}::jsonb) AS v(tenant text, workspace text)
          ON CONFLICT (tenant, workspace) DO NOTHING`);
      }
      // What could not be settled goes back to its files.
      await t.execute(sql`
        UPDATE records_routing r SET state = 'files', moving_until = NULL, changed_at = now()
        FROM jsonb_to_recordset(${JSON.stringify(undone)}::jsonb) AS v(tenant text, workspace text)
        WHERE r.tenant = v.tenant AND r.workspace = v.workspace AND r.state = 'moving'`);
      if (!defaultOk) await t.execute(sql`UPDATE records_routing SET state = 'files', moving_until = NULL WHERE tenant = '*' AND workspace = '*' AND state = 'moving'`);
    },
    async (t) => {
      // The flip itself, last: each row (and the default) to the database if
      // its deadline has not passed by the database's clock as it reads now
      // (not the transaction's start), else back to its files.
      const flip = [...done, ...(defaultOk ? [{ tenant: DEFAULT, workspace: DEFAULT }] : [])];
      await t.execute(sql`
        UPDATE records_routing r SET state = CASE WHEN r.moving_until > clock_timestamp() THEN 'database' ELSE 'files' END, moving_until = NULL, changed_at = now()
        FROM jsonb_to_recordset(${JSON.stringify(flip)}::jsonb) AS v(tenant text, workspace text)
        WHERE r.tenant = v.tenant AND r.workspace = v.workspace AND r.state = 'moving'`);
    },
  );
}

/**
 * Move every account's run files, trigger logs and storage indexes into the
 * database, behind the barrier above. A workspace that cannot be moved does
 * NOT stop the boot: it stays on its files for every process, an ops event
 * names it, and the next boot tries again.
 */
export async function importRecordsFiles(): Promise<ImportResult> {
  const counts: ImportCounts = { runs: 0, runsSkipped: 0, triggerEvents: 0, storageFiles: 0, strays: 0 };
  try {
    // Never a move before the first contact is done: a move would mark the
    // routing begun, and a workspace only the database had would then be
    // settled as one on files — its rows deleted for having no file.
    await seedRouting();
    await withFencedLock(
      "records-import",
      async (fence) => {
        await moveAll(fence, counts);
        // 5. set aside, in every workspace now in the database.
        const routing = await readRouting();
        for (const w of enumerate().all) {
          if ((routing.rows.get(k(w.tenant, w.workspace)) ?? routing.def) !== "database") continue;
          try {
            await setAsideWorkspace(w.tenant, w.workspace, counts);
          } catch (err) {
            opsError("records.set_aside_failed", err, { tenant: w.tenant, workspace: w.workspace }, "warn");
          }
        }
      },
      Math.max(5 * 60_000, moveBudgetMs() + 60_000),
    );
  } catch (err) {
    // The lock itself could not be had (another pod holds it past the wait, the
    // database is unreachable), or the routing could not be changed.
    opsError("records.import_failed", err, {});
  }
  // From the routing every process reads, whoever moved what.
  const onFiles: ImportResult["onFiles"] = [];
  let routing: Routing | null = null;
  try {
    routing = await readRouting();
  } catch {
    // unreachable: every workspace is reported below
  }
  for (const tenant of listTenants()) {
    let names: string[] = [];
    try {
      names = workspaceNames(tenant);
    } catch {
      onFiles.push({ tenant, workspace: "*" });
      continue;
    }
    for (const name of names) {
      if (!routing || (routing.rows.get(k(tenant, name)) ?? routing.def) !== "database") onFiles.push({ tenant, workspace: name });
    }
  }  const moved = counts.runs || counts.runsSkipped || counts.triggerEvents || counts.storageFiles || counts.strays;
  return { counts: moved ? counts : null, onFiles };
}
