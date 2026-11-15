// Copy the runs written before outputs and captured calls went to the object
// store (their files are only in the run folders on the shared volume) into
// the stores, once, before the volume goes (FOL-126). A DRY RUN unless --write.
// Idempotent: what a store already holds is left. Never deletes.
// --verify is read-only (not with --write): it also hashes every output on the
// volume and compares it with the store's copy, so the volume can be retired
// knowing the bytes match, not just the names.
//
//   node --experimental-strip-types foldrun-platform/scripts/backfill-run-files.ts            # counts only
//   node --experimental-strip-types foldrun-platform/scripts/backfill-run-files.ts --write [--tenant a,b]
//   node --experimental-strip-types foldrun-platform/scripts/backfill-run-files.ts --verify [--tenant a,b]
//
// Run in the worker pod (its database, object store and data volume).
// Exit: 0 ok, 1 something failed or did not match (named), 64 usage.

import { installPlatform } from "../src/index.ts";
import { backfillRunFiles } from "../src/run-files-backfill.ts";

const argv = process.argv.slice(2);
const i = argv.indexOf("--tenant");
const tenants = i >= 0 ? argv[i + 1]?.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
if (!process.env.FOLDRUN_DATABASE_URL) {
  console.error("this needs the database: FOLDRUN_DATABASE_URL is not set");
  process.exit(64);
}
if (argv.includes("--write") && argv.includes("--verify")) {
  console.error("--verify only reads: do not combine it with --write");
  process.exit(64);
}
installPlatform();
const write = argv.includes("--write");
const r = await backfillRunFiles({ write, verify: argv.includes("--verify"), tenants });
console.log(`${write ? "copied" : "would copy"}: runs ${r.runs} · avatars ${r.avatars} · outputs ${r.outputs.copied} (already stored ${r.outputs.present}, failed ${r.outputs.failed}, files refused ${r.outputs.refused}) · calls ${r.calls.copied} (already stored ${r.calls.present}, failed ${r.calls.failed})`);
// Passed over, never copied: say so, so a "clean" pass is not taken for a complete one.
console.log(`skipped: run folders ${r.skipped.runs} · agent folders ${r.skipped.agents} · call files ${r.skipped.calls}`);
for (const n of r.skipped.names.slice(0, 20)) console.log(`  skipped: ${n}`);
if (r.skipped.names.length > 20) console.log(`  … and ${r.skipped.names.length - 20} more skipped (the counts above are complete)`);
if (r.verify) {
  const v = r.verify;
  console.log(`verify: ${v.checked} files checked · ${v.ok} match · ${v.mismatched} differ · ${v.missing} not in the store · ${v.blobMissing} blob missing`);
  for (const p of v.problems.slice(0, 50)) console.log(`  verify: ${p}`);
  if (v.problems.length > 50) console.log(`  … and ${v.problems.length - 50} more (see the counts)`);
}
for (const f of r.failures.slice(0, 50)) console.log(`  failed: ${f}`);
if (r.failures.length > 50) console.log(`  … and ${r.failures.length - 50} more failures`);
process.exit(r.outputs.failed || r.calls.failed ? 1 : 0);
