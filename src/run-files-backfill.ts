// The runs written before outputs and captured calls went to the object store
// (FOL-126): their files are only in the run folders on the shared volume, so
// they are copied into the stores once, before the volume goes. Read-only on
// the folders; idempotent (an output or a call already in its store is left);
// a dry run unless asked to write. `verify` is a dry run that also compares
// every output's bytes on the volume with what the store holds (never writes).

import fs from "node:fs";
import path from "node:path";
import { listTenants, listWorkspaces, workspaceDir } from "../../foldrun-core/src/store.ts";
import { listRunOutputs, publishRunOutputs, runOutputsBackend, storedBlobIntact, storedRunOutputs } from "../../foldrun-core/src/run-outputs.ts";
import { listRunOutputsOnVolume, runOutputPathOnVolume } from "../../foldrun-core/src/store.ts";
import { fileSource, hashRange } from "../../foldrun-core/src/blob-store.ts";
import { backfillCall } from "../../foldrun-core/src/captured-calls.ts";
import { importAvatarFiles } from "./avatars.ts";
import type { CapturedCall } from "../../foldrun-core/src/store.ts";

export interface BackfillReport {
  runs: number;
  avatars: number;
  /** `refused`: files a publish would not keep (name, case, count, cap): each fails on every retry. */
  outputs: { copied: number; present: number; failed: number; refused: number };
  calls: { copied: number; present: number; failed: number };
  /** What was passed over without being looked at: run folders and agent
   *  folders whose names are not plain, other entries in runs/, files in
   *  calls/ that are not .json. `names` is capped. */
  skipped: { runs: number; agents: number; calls: number; names: string[] };
  /** Only in verify mode. */
  verify?: { checked: number; ok: number; mismatched: number; missing: number; blobMissing: number; problems: string[] };
  failures: string[];
}

const SAFE = /^[A-Za-z0-9_.-]{1,128}$/;

/** A folder's entries; null when it is not there. Any other error is thrown:
 *  a folder that cannot be read is never taken for an empty one (Codex review). */
function entries(dir: string): string[] | null {
  try {
    return fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
const isDir = (p: string) => fs.statSync(p).isDirectory();
const NAMES_CAP = 200;
const PROBLEMS_CAP = 200;
/** A call file is read whole to be parsed: past this it is reported, not loaded. */
const CALL_FILE_MAX_BYTES = 64 * 1024 * 1024;

export async function backfillRunFiles(opts: { write: boolean; verify?: boolean; tenants?: string[] }): Promise<BackfillReport> {
  if (opts.write && opts.verify) throw new Error("verify only reads: it cannot be combined with write");
  const r: BackfillReport = {
    runs: 0,
    avatars: 0,
    outputs: { copied: 0, present: 0, failed: 0, refused: 0 },
    calls: { copied: 0, present: 0, failed: 0 },
    skipped: { runs: 0, agents: 0, calls: 0, names: [] },
    failures: [],
  };
  if (opts.verify) r.verify = { checked: 0, ok: 0, mismatched: 0, missing: 0, blobMissing: 0, problems: [] };
  const skip = (kind: "runs" | "agents" | "calls", what: string) => {
    r.skipped[kind]++;
    if (r.skipped.names.length < NAMES_CAP) r.skipped.names.push(what);
  };
  // Old runs' outputs are kept whole: today's size limits are for new runs,
  // and a refused file here would be lost with the volume (Codex review).
  const base = runOutputsBackend();
  if (opts.write && !base) throw new Error("the run outputs store is not set up here: nothing would be copied");
  const outputsBackend = base ? { ...base, fileMaxBytes: () => 0, runMaxBytes: () => 0 } : null;
  for (const tenant of opts.tenants ?? listTenants()) {
    // The account's avatars (people, workspaces, the account): files until now.
    if (opts.write) {
      try {
        r.avatars += importAvatarFiles(tenant);
      } catch (err) {
        r.failures.push(`${tenant} avatars: ${(err as Error).message}`);
        r.outputs.failed++;
      }
    }
    for (const ws of listWorkspaces(tenant)) {
      const runsDir = path.join(workspaceDir(tenant, ws.name), "runs");
      let ids: string[] = [];
      try {
        ids = (entries(runsDir) ?? []).filter((n) => {
          const ok = SAFE.test(n) && isDir(path.join(runsDir, n));
          if (!ok) skip("runs", `${tenant}/${ws.name}/runs/${n}`);
          return ok;
        });
      } catch (err) {
        r.failures.push(`${tenant}/${ws.name}/runs: unreadable (${(err as Error).message})`);
        r.outputs.failed++;
        continue;
      }
      for (const runId of ids) {
        r.runs++;
        const where = `${tenant}/${ws.name}/${runId}`;
        // Archived outputs: runs/<id>/outputs/<agent>/**
        const outDir = path.join(runsDir, runId, "outputs");
        let agents: string[] = [];
        try {
          agents = (entries(outDir) ?? []).filter((a) => {
            const ok = SAFE.test(a) && isDir(path.join(outDir, a));
            if (!ok) skip("agents", `${where}/outputs/${a}`);
            return ok;
          });
        } catch (err) {
          r.outputs.failed++;
          r.failures.push(`${where} outputs: unreadable (${(err as Error).message})`);
        }
        if (agents.length) {
          try {
          // An agent counts as copied only when the store holds EVERY file the
          // folder has for it — a record over part of them (a pass that had
          // refusals) is copied again, never taken for done (Codex review).
          const stored = new Set(outputsBackend ? (await listRunOutputs(tenant, ws.name, runId)).map((f) => `${f.agent}/${f.path}`) : []);
          const onVolume = listRunOutputsOnVolume(tenant, ws.name, runId);
          const complete = (agent: string) => {
            const mine = onVolume.filter((f) => f.agent === agent);
            return mine.every((f) => stored.has(`${f.agent}/${f.path}`));
          };
          if (r.verify) await verifyAgents(r, tenant, ws.name, runId, agents);
          const recorded = new Set(outputsBackend ? (await outputsBackend.store.list(tenant, ws.name, runId)).map((x) => x.agent) : []);
          for (const agent of agents) {
            if (recorded.has(agent) && complete(agent)) {
              r.outputs.present++;
              continue;
            }
            if (!opts.write || !outputsBackend) {
              r.outputs.copied++;
              continue;
            }
            try {
              const out = await publishRunOutputs(outputsBackend, tenant, ws.name, runId, agent, path.join(outDir, agent));
              if (out.refused.length) {
                r.outputs.failed++;
                r.outputs.refused += out.refused.length;
                r.failures.push(`${where} outputs/${agent}: ${out.refused.length} file(s) refused (${out.refused.slice(0, 3).map((f) => `${f.path}: ${f.reason}`).join("; ")})`);
              } else r.outputs.copied++;
            } catch (err) {
              r.outputs.failed++;
              r.failures.push(`${where} outputs/${agent}: ${(err as Error).message}`);
            }
          }
          } catch (err) {
            // A folder that cannot be read ends this run's outputs, not the pass.
            r.outputs.failed++;
            r.failures.push(`${where} outputs: unreadable (${(err as Error).message})`);
          }
        }
        // Captured calls: runs/<id>/calls/<call>.json
        const callsDir = path.join(runsDir, runId, "calls");
        let calls: string[] = [];
        try {
          calls = (entries(callsDir) ?? []).filter((n) => {
            if (!n.endsWith(".json")) skip("calls", `${where}/calls/${n}`);
            return n.endsWith(".json");
          });
        } catch (err) {
          r.calls.failed++;
          r.failures.push(`${where} calls: unreadable (${(err as Error).message})`);
        }
        for (const name of calls) {
          let call: CapturedCall;
          try {
            const size = fs.statSync(path.join(callsDir, name)).size;
            if (size > CALL_FILE_MAX_BYTES) throw new Error(`${size} bytes is too large to copy`);
            call = JSON.parse(fs.readFileSync(path.join(callsDir, name), "utf8")) as CapturedCall;
          } catch (err) {
            r.calls.failed++;
            r.failures.push(`${where} calls/${name}: unreadable (${(err as Error).message})`);
            continue;
          }
          try {
            const got = await backfillCall(tenant, ws.name, runId, call, { dryRun: !opts.write });
            if (got === "stored") r.calls.copied++;
            else if (got === "present") r.calls.present++;
            else {
              r.calls.failed++;
              r.failures.push(`${where} calls/${name}: the call store is not set up for this workspace`);
            }
          } catch (err) {
            r.calls.failed++;
            r.failures.push(`${where} calls/${name}: ${(err as Error).message}`);
          }
        }
      }
    }
  }
  return r;
}

/** Verify: every file the volume holds for these agents is in the store with
 *  the same bytes (sha256, streamed) and its blob is there at that size. Reads
 *  only; each problem is named, capped (the counts are not). */
async function verifyAgents(r: BackfillReport, tenant: string, workspace: string, runId: string, agents: string[]): Promise<void> {
  const v = r.verify!;
  const problem = (kind: "mismatched" | "missing" | "blobMissing", text: string) => {
    v[kind]++;
    r.outputs.failed++;
    if (v.problems.length < PROBLEMS_CAP) v.problems.push(text);
  };
  const stored = new Map((await storedRunOutputs(tenant, workspace, runId)).map((f) => [`${f.agent}/${f.path}`, f]));
  for (const f of listRunOutputsOnVolume(tenant, workspace, runId)) {
    if (!agents.includes(f.agent)) continue;
    v.checked++;
    const label = `${tenant}/${workspace}/${runId}/${f.agent}/${f.path}`;
    const have = stored.get(`${f.agent}/${f.path.normalize("NFC")}`);
    if (!have) {
      problem("missing", `${label}: not in the store`);
      continue;
    }
    const abs = runOutputPathOnVolume(tenant, workspace, runId, f.agent, f.path);
    if (!abs) {
      problem("missing", `${label}: cannot be read from the volume`);
      continue;
    }
    try {
      const src = fileSource(abs);
      const sha = (await hashRange(src, 0, src.size)).sha256;
      if (sha !== have.sha || src.size !== have.size) {
        problem("mismatched", `${label}: the volume's bytes differ from the store's`);
        continue;
      }
      if (!(await storedBlobIntact(tenant, have.sha, have.size))) {
        problem("blobMissing", `${label}: the store's blob is missing or the wrong size`);
        continue;
      }
      v.ok++;
    } catch (err) {
      problem("mismatched", `${label}: could not be compared (${(err as Error).message})`);
    }
  }
}
