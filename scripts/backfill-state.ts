// Copy the small state that was files on the shared volume (webhook
// generations and deliveries, eval results and history, grades, the deployed
// commit, step state of open runs, the platform's own marks — unsettled
// charges among them) into the database, once, before the volume goes
// (FOL-126, M7). A DRY RUN unless --write. Idempotent: what a row already
// says is left. Never deletes. Names what it left, and why.
//
//   node --experimental-strip-types foldrun-platform/scripts/backfill-state.ts            # counts only
//   node --experimental-strip-types foldrun-platform/scripts/backfill-state.ts --write [--tenant a,b]
//
// Run in the worker pod (its database and data volume), after
// backfill-run-files.ts. Exit: 0 ok, 1 something failed or was left (named), 64 usage.

import { installPlatform } from "../src/index.ts";
import { backfillState } from "../src/state-backfill.ts";

const argv = process.argv.slice(2);
const i = argv.indexOf("--tenant");
const tenants = i >= 0 ? argv[i + 1]?.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
if (!process.env.FOLDRUN_DATABASE_URL) {
  console.error("this needs the database: FOLDRUN_DATABASE_URL is not set");
  process.exit(64);
}
installPlatform();
const write = argv.includes("--write");
const r = await backfillState({ write, tenants });
console.log(write ? "copied:" : "would copy:");
for (const [k, t] of Object.entries(r.kinds).sort()) console.log(`  ${k.padEnd(24)} ${String(t.copied).padStart(6)} (already there ${t.present}, left ${t.skipped}, failed ${t.failed})`);
for (const n of r.notes) console.log(`  left: ${n}`);
if (r.notesDropped) console.log(`  … and ${r.notesDropped} more left`);
for (const f of r.failures) console.log(`  failed: ${f}`);
// Left-alone files stay on the volume: say so, so the volume is not retired on a green exit alone.
process.exit(r.failures.length || Object.values(r.kinds).some((t) => t.failed || t.skipped) ? 1 : 0);
