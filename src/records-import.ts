// The files that held runs, the trigger log and the storage index, moved into
// their tables once (FOL-126 phase 2) — the same pattern as the share links,
// the notices and the flow cursors: read the old file, insert what it says
// into the table, keep a row that is already there, then set the file aside as
// `<name>.imported-<date>`.
//
//   runs/<id>.json        → run_records   (the whole record + its list row)
//   runs/.index.json      → set aside (the table's rows are the index)
//   trigger-log.jsonl     → trigger_events (the newest 500)
//   storage/<ws>/index.json → workspace_files
//
// Safe to run on every boot and on two pods at once: one fenced lock names
// the whole job, a second pod waits and finds nothing left; every insert
// keeps a row that is already there (a row written after the cutover is newer
// than the file), and a file is renamed only once its rows are committed. A
// run file that cannot be read is renamed `.unreadable-<date>` and counted, not guessed at.
// Run output folders (runs/<id>/) stay where they are: bytes, phase 5.

import fs from "node:fs";
import path from "node:path";
import { opsLog, opsError } from "../../foldrun-core/src/ops-log.ts";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { listTenants, listWorkspaces, workspaceDir, summarizeRun, STORAGE_DIR, type RunRecord } from "../../foldrun-core/src/store.ts";
import type { FileRecord } from "../../foldrun-core/src/storage.ts";
import type { TriggerEvent } from "../../foldrun-core/src/trigger-log.ts";
import { sql } from "drizzle-orm";
import { tx } from "./db.ts";
import { runRecords, workspaceFiles } from "./schema.ts";
import { withFencedLock, assertFence, type Fence } from "./fenced-lock.ts";

const CHUNK = 100;
const KEEP_TRIGGER_EVENTS = 500;
const LIVE = new Set(["queued", "running", "awaiting-approval"]);

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

export interface ImportCounts {
  runs: number;
  runsSkipped: number;
  triggerEvents: number;
  storageFiles: number;
}

async function importWorkspace(tenant: string, workspace: string, fence: Fence, counts: ImportCounts): Promise<void> {
  const root = workspaceDir(tenant, workspace);
  // Files are set aside only after EVERY table of this workspace has its rows:
  // a failure before that leaves all the files where they were, so the
  // workspace can be served from them whole (records-import's "on files").
  const aside: { file: string; kind: "run" | "other" }[] = [];

  // ---- runs
  const runsDir = path.join(root, "runs");
  let names: string[] = [];
  try {
    names = fs.readdirSync(runsDir).filter((f) => f.endsWith(".json") && !f.startsWith("."));
  } catch {
    // no runs directory: nothing to move
  }
  let moved = 0;
  let skipped = 0;
  for (let i = 0; i < names.length; i += CHUNK) {
    const rows: (typeof runRecords.$inferInsert)[] = [];
    const files: string[] = [];
    for (const f of names.slice(i, i + CHUNK)) {
      const file = path.join(runsDir, f);
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
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // another pod got it
        // Torn or foreign: kept for a person to look at under another name, so
        // it is neither read as a run again nor counted on every boot.
        if (setAside(file, "unreadable")) skipped++;
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
      files.push(file);
    }
    if (!rows.length) continue;
    await tx(async (t) => {
      await assertFence(t, fence);
      // A row already there is kept unless the file is NEWER than it: a
      // workspace served from its files after a failed import went on writing
      // them, and its first attempt may have left older rows behind.
      await t
        .insert(runRecords)
        .values(rows)
        .onConflictDoUpdate({
          target: [runRecords.tenant, runRecords.workspace, runRecords.runId],
          set: {
            flow: sql`excluded.flow`, status: sql`excluded.status`, live: sql`excluded.live`, startedAt: sql`excluded.started_at`,
            finishedAt: sql`excluded.finished_at`, summary: sql`excluded.summary`, record: sql`excluded.record`, updatedAt: sql`excluded.updated_at`,
          },
          setWhere: sql`${runRecords.updatedAt} < excluded.updated_at`,
        });
    });
    for (const file of files) aside.push({ file, kind: "run" });
    moved += files.length;
  }
  counts.runsSkipped += skipped;
  // The old index is rebuilt from the rows: nothing to carry over.
  aside.push({ file: path.join(runsDir, ".index.json"), kind: "other" });
  if (skipped) opsLog("warn", "records.import_skipped", { tenant, workspace, kind: "runs", count: skipped, reason: "unreadable" });

  // ---- the trigger log
  const logFile = path.join(root, "trigger-log.jsonl");
  if (fs.existsSync(logFile)) {
    const events: TriggerEvent[] = [];
    for (const line of fs.readFileSync(logFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as TriggerEvent;
        if (e && typeof e.t === "string" && typeof e.flow === "string" && typeof e.trigger === "string" && typeof e.outcome === "string") events.push(e);
      } catch {
        // a torn line loses that line, as it always did
      }
    }
    const keep = events.slice(-KEEP_TRIGGER_EVENTS);
    // Oldest first, so the identity column orders them as the file did. The
    // table has no natural key, so an event is skipped when one with the same
    // instant, flow, trigger, outcome and run is already there: a boot that
    // crashed after this commit and before the rename below reads the same
    // file again and adds nothing (the fence covers concurrent pods, this
    // covers the crash between a commit and a rename).
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
    aside.push({ file: logFile, kind: "other" });
    counts.triggerEvents += keep.length;
    opsLog("info", "records.imported", { tenant, workspace, kind: "trigger_log", count: keep.length });
  }

  // ---- the storage file index (the blobs stay where they are)
  const indexFile = path.join(dataRoot(), tenant, STORAGE_DIR, workspace, "index.json");
  if (fs.existsSync(indexFile)) {
    let files: FileRecord[] = [];
    try {
      const raw = JSON.parse(fs.readFileSync(indexFile, "utf8")) as { files?: FileRecord[] };
      files = (raw.files ?? []).filter((f) => f && typeof f.path === "string" && typeof f.sha === "string" && Number.isFinite(f.size));
    } catch {
      opsLog("warn", "records.import_skipped", { tenant, workspace, kind: "storage_index", reason: "unreadable" });
      return;
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
            setWhere: sql`${workspaceFiles.updatedAt} < excluded.updated_at`,
          });
      });
    }
    aside.push({ file: indexFile, kind: "other" });
    counts.storageFiles += files.length;
    opsLog("info", "records.imported", { tenant, workspace, kind: "storage_index", count: files.length });
  }

  // Every row is in. A rename that fails now (a read-only folder) is a
  // warning, not a failure: the rows are complete, the file is imported again
  // next boot (a row already there is kept) and meanwhile the workspace reads
  // from its files, which are whole too.
  let renamed = 0;
  for (const a of aside) {
    try {
      if (setAside(a.file) && a.kind === "run") renamed++;
    } catch (err) {
      opsError("records.set_aside_failed", err, { tenant, workspace }, "warn");
    }
  }
  counts.runs += renamed;
  if (moved || skipped) opsLog("info", "records.imported", { tenant, workspace, kind: "runs", count: renamed });
}

/** What the boot import left: counts of what moved, and the workspaces that are
 *  still on FILES (their records could not all be moved) — served from those
 *  files by this process and tried again at the next boot. */
export interface ImportResult {
  counts: ImportCounts | null;
  onFiles: { tenant: string; workspace: string }[];
}

/** Does this workspace still hold record files an import would move? */
function hasRecordFiles(tenant: string, workspace: string): boolean {
  const root = workspaceDir(tenant, workspace);
  try {
    if (fs.readdirSync(path.join(root, "runs")).some((f) => f.endsWith(".json") && !f.startsWith("."))) return true;
  } catch {
    // no runs folder
  }
  return fs.existsSync(path.join(root, "trigger-log.jsonl")) || fs.existsSync(path.join(dataRoot(), tenant, STORAGE_DIR, workspace, "index.json"));
}

/**
 * Move every account's run files, trigger logs and storage indexes into the
 * database. A workspace that cannot be moved does NOT stop the boot: its files
 * are left whole (nothing of a workspace is set aside until all its rows are
 * in), this process serves it from them (`onFiles`), the queue keeps its jobs,
 * an ops event names it, and the next boot tries again. The answer for a
 * workspace is decided from the disk afterwards — "it still has record files" —
 * so every pod reaches the same one.
 */
export async function importRecordsFiles(): Promise<ImportResult> {
  const counts: ImportCounts = { runs: 0, runsSkipped: 0, triggerEvents: 0, storageFiles: 0 };
  const failedTenants = new Set<string>();
  const failedWs = new Map<string, unknown>();
  try {
    await withFencedLock(
      "records-import",
      async (fence) => {
        for (const tenant of listTenants()) {
          let workspaces: { name: string }[];
          try {
            workspaces = listWorkspaces(tenant);
          } catch (err) {
            opsError("records.import_failed", err, { tenant });
            failedTenants.add(tenant);
            continue;
          }
          for (const ws of workspaces) {
            try {
              await importWorkspace(tenant, ws.name, fence, counts);
            } catch (err) {
              opsError("records.import_failed", err, { tenant, workspace: ws.name });
              failedWs.set(`${tenant}\0${ws.name}`, err);
            }
          }
        }
      },
      5 * 60_000,
    );
  } catch (err) {
    // The lock itself could not be had (another pod holds it past the wait, the
    // database is unreachable): nothing was moved by this process.
    opsError("records.import_failed", err, {});
  }
  // From the disk, whoever imported: a workspace is on files while it still has files.
  const onFiles: ImportResult["onFiles"] = [];
  for (const tenant of listTenants()) {
    let workspaces: { name: string }[] = [];
    try {
      workspaces = listWorkspaces(tenant);
    } catch {
      onFiles.push({ tenant, workspace: "*" });
      continue;
    }
    for (const ws of workspaces) {
      if (hasRecordFiles(tenant, ws.name)) onFiles.push({ tenant, workspace: ws.name });
    }
  }
  return { counts: counts.runs || counts.runsSkipped || counts.triggerEvents || counts.storageFiles ? counts : null, onFiles };
}
