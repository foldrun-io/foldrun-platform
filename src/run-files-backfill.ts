// The runs written before outputs and captured calls went to the object store
// (FOL-126): their files are only in the run folders on the shared volume, so
// they are copied into the stores once, before the volume goes. Read-only on
// the folders; idempotent (an output or a call already in its store is left);
// a dry run unless asked to write.

import fs from "node:fs";
import path from "node:path";
import { listTenants, listWorkspaces, workspaceDir } from "../../foldrun-core/src/store.ts";
import { listRunOutputs, publishRunOutputs, runOutputsBackend } from "../../foldrun-core/src/run-outputs.ts";
import { listRunOutputsOnVolume } from "../../foldrun-core/src/store.ts";
import { backfillCall } from "../../foldrun-core/src/captured-calls.ts";
import { importAvatarFiles } from "./avatars.ts";
import type { CapturedCall } from "../../foldrun-core/src/store.ts";

export interface BackfillReport {
  runs: number;
  avatars: number;
  outputs: { copied: number; present: number; failed: number };
  calls: { copied: number; present: number; failed: number };
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

export async function backfillRunFiles(opts: { write: boolean; tenants?: string[] }): Promise<BackfillReport> {
  const r: BackfillReport = { runs: 0, avatars: 0, outputs: { copied: 0, present: 0, failed: 0 }, calls: { copied: 0, present: 0, failed: 0 }, failures: [] };
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
        ids = (entries(runsDir) ?? []).filter((n) => SAFE.test(n) && isDir(path.join(runsDir, n)));
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
          agents = (entries(outDir) ?? []).filter((a) => SAFE.test(a) && isDir(path.join(outDir, a)));
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
          calls = (entries(callsDir) ?? []).filter((n) => n.endsWith(".json"));
        } catch (err) {
          r.calls.failed++;
          r.failures.push(`${where} calls: unreadable (${(err as Error).message})`);
        }
        for (const name of calls) {
          let call: CapturedCall;
          try {
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
