// Import an old-style /data folder's workspace content (authored files and
// state/, binaries and executable bits included) into revisions and blobs
// (FOL-126 phase 8). A DRY RUN unless you say --import. The source folder is
// only ever read; secrets are never opened. Runs, the trigger log and the
// storage index are not part of this: FOL-152 moved them.
//
//   node --experimental-strip-types foldrun-platform/scripts/import-data.ts --source /data
//   node --experimental-strip-types foldrun-platform/scripts/import-data.ts --source /data --import --verify --out /tmp/import-report
//
// Options
//   --source DIR        the old data folder (required)
//   --tenant a,b        only these accounts           --workspace acct/ws,…  only these workspaces
//   --import            write (default: dry run, writes nothing)
//   --verify            compare heads with the folder by path + sha256 + mode (read-only; with --import: after it)
//   --compare           dry run: also read the destination's heads (needs the database)
//   --out DIR           write import-verify.json and import-verify.txt here (outside the source)
//   --mirror            also delete head paths the folder lacks (default: never delete)
//   --force             import over a workspace that has revisions the importer did not make
//   --deep              verify streams every blob back and hashes it
//   --allow-extra       verify: paths in the head that the folder lacks are fine
//
// Run where the platform runs (the worker pod), with its environment: the
// database and the blob store (FOLDRUN_STORAGE_DRIVER / S3 settings). Run it
// BEFORE `revisions.journal` is turned on: after that the first reconcile
// makes the head and this skips the workspace unless --force.
// Exit: 0 ok, 1 a workspace failed to import, 2 verification failed, 64 usage.

import { dataImport, renderVerify } from "../src/data-import.ts";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const value = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const list = (n: string) => value(n)?.split(",").map((s) => s.trim()).filter(Boolean);
const usage = (msg: string): never => {
  console.error(`${msg}\nusage: import-data.ts --source DIR [--import] [--verify] [--out DIR] [--tenant a,b] [--workspace acct/ws,…] [--mirror] [--force] [--deep] [--allow-extra] [--compare]`);
  process.exit(64);
};

const source = value("source");
if (!source) usage("--source is required");
if (flag("dry-run") && flag("import")) usage("--dry-run and --import cannot be combined");

const doImport = flag("import");
const verify = flag("verify");
if ((doImport || verify || flag("compare")) && !process.env.FOLDRUN_DATABASE_URL) usage("this needs the database: FOLDRUN_DATABASE_URL is not set");

const out = await dataImport({
  source: source!, tenants: list("tenant"), workspaces: list("workspace"), doImport, verify, compare: flag("compare"), out: value("out"),
  mirror: flag("mirror"), force: flag("force"), deep: flag("deep"), allowExtra: flag("allow-extra"),
});

if (out.planText) process.stdout.write(out.planText + "\nNothing was written. To import: add --import (and --verify --out DIR).\n");
if (out.imported) {
  console.log(`Import ${out.imported.startedAt} → ${out.imported.finishedAt}`);
  for (const r of out.imported.results) {
    console.log(`  ${r.status.toUpperCase().padEnd(9)} ${r.tenant}/${r.workspace}: ${r.filesPublished} file(s) published (${r.filesStreamed} streamed), ${r.conflictsKept} conflict copy(ies)${r.reason ? ` — ${r.reason}` : ""}`);
  }
}
if (out.verified) {
  process.stdout.write("\n" + renderVerify(out.verified));
  if (out.reportFiles) console.log(`Report: ${out.reportFiles.json}\n        ${out.reportFiles.txt}`);
  else console.log("(pass --out DIR to write the JSON and text report)");
}
process.exit(out.exitCode);
