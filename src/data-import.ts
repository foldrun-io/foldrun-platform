// The data importer on Postgres (FOL-126 phase 8). The folder reading,
// publishing and verifying are foldrun-core's (src/data-import.ts); this file
// supplies the destination: the pg revision store, the blob store in force
// and the blob pins, and one named lock so two importers never run at once.
//
// It moves workspace content only (authored files and state/, as heads).
// Runs, the trigger log and the storage index were moved by the records
// import (records-import.ts, FOL-152) and are not read here.

import {
  planImport, renderPlan, runImport, scanSource, verifyImport, renderVerify, writeVerifyReport,
  type ImportReport, type PlanWorkspace, type SourceScan, type VerifyReport,
} from "../../foldrun-core/src/data-import.ts";
import { blobStore } from "../../foldrun-core/src/blob-store.ts";
import type { Deps } from "../../foldrun-core/src/publish.ts";
import { withNamedLock } from "./db.ts";
import { pgRevisionStore } from "./revision-store-pg.ts";
import { pgBlobPins } from "./blob-pins.ts";

/** The destination this install is configured for. */
export function pgImportDeps(): Deps {
  return { blobs: blobStore(), revisions: pgRevisionStore(), pins: pgBlobPins() };
}

export interface DataImportRun {
  source: string;
  tenants?: string[];
  workspaces?: string[];
  /** Write. Without it this is a dry run. */
  doImport?: boolean;
  verify?: boolean;
  /** Dry run only: read the destination's heads to say what is already there. */
  compare?: boolean;
  out?: string;
  mirror?: boolean;
  force?: boolean;
  deep?: boolean;
  allowExtra?: boolean;
  /** Tests pass their own; the script uses the configured ones. */
  deps?: Deps;
}
export interface DataImportOutcome {
  scan: SourceScan;
  plan?: PlanWorkspace[];
  planText?: string;
  imported?: ImportReport;
  verified?: VerifyReport;
  reportFiles?: { json: string; txt: string };
  /** 0 ok; 1 a workspace failed to import; 2 verification failed. */
  exitCode: 0 | 1 | 2;
}

export async function dataImport(run: DataImportRun): Promise<DataImportOutcome> {
  const scan = await scanSource({ source: run.source, tenants: run.tenants, workspaces: run.workspaces });
  const out: DataImportOutcome = { scan, exitCode: 0 };
  if (!run.doImport && !run.verify) {
    out.plan = await planImport(scan, run.compare ? (run.deps ?? pgImportDeps()) : undefined);
    out.planText = renderPlan(scan, out.plan);
    return out;
  }
  const deps = run.deps ?? pgImportDeps();
  if (run.doImport) {
    // A head moves by compare-and-set, so a second importer could not corrupt
    // anything; the lock only keeps two from doing the same work at once.
    out.imported = await withNamedLock("data-import", () => runImport(scan, { deps, mirror: run.mirror, force: run.force }), 5 * 60_000);
    if (out.imported.results.some((r) => r.status === "failed")) out.exitCode = 1;
  }
  if (run.verify) {
    out.verified = await verifyImport(scan, { deps, deep: run.deep, allowExtra: run.allowExtra });
    if (!out.verified.pass) out.exitCode = 2;
    if (run.out) out.reportFiles = writeVerifyReport(run.out, run.source, out.verified);
  }
  return out;
}

export { renderVerify };
