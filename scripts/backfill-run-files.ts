// Copy the runs written before outputs and captured calls went to the object
// store (their files are only in the run folders on the shared volume) into
// the stores, once, before the volume goes (FOL-126). A DRY RUN unless --write.
// Idempotent: what a store already holds is left. Never deletes.
//
//   node --experimental-strip-types foldrun-platform/scripts/backfill-run-files.ts            # counts only
//   node --experimental-strip-types foldrun-platform/scripts/backfill-run-files.ts --write [--tenant a,b]
//
// Run in the worker pod (its database, object store and data volume).
// Exit: 0 ok, 1 something failed (named), 64 usage.

import { installPlatform } from "../src/index.ts";
import { backfillRunFiles } from "../src/run-files-backfill.ts";

const argv = process.argv.slice(2);
const i = argv.indexOf("--tenant");
const tenants = i >= 0 ? argv[i + 1]?.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
if (!process.env.FOLDRUN_DATABASE_URL) {
  console.error("this needs the database: FOLDRUN_DATABASE_URL is not set");
  process.exit(64);
}
installPlatform();
const r = await backfillRunFiles({ write: argv.includes("--write"), tenants });
console.log(`${argv.includes("--write") ? "copied" : "would copy"}: runs ${r.runs} · avatars ${r.avatars} · outputs ${r.outputs.copied} (already stored ${r.outputs.present}, failed ${r.outputs.failed}) · calls ${r.calls.copied} (already stored ${r.calls.present}, failed ${r.calls.failed})`);
for (const f of r.failures.slice(0, 50)) console.log(`  failed: ${f}`);
process.exit(r.outputs.failed || r.calls.failed ? 1 : 0);
