// The vault's files against its rows, for every account (FOL-126 phase 6,
// retiring the file mirror). Run where the platform runs (the worker pod): it
// needs the database, the data volume and the keys.
//
//   node --experimental-strip-types scripts/vault-fleet.ts verify [--open] [--mirror-off] [--tenant a,b]
//   node --experimental-strip-types scripts/vault-fleet.ts import [--tenant a,b]
//   node --experimental-strip-types scripts/vault-fleet.ts export [--tenant a,b]
//
// verify   read-only. Counts, and `account/workspace` names of the scopes that
//          are only a file (never imported), only a row, or differ — never a
//          value. `--open` also tries every record with this process's keys
//          (in memory; nothing is printed) and counts those that do not open.
//          `--mirror-off`: files are expected to be stale (secrets.mirror is
//          off), so a scope that differs or has no file is fine.
//          Exit 0 clean, 1 not clean.
//          `--tenant a,b` limits any command to those accounts.
// import   copies each file-only scope into a row, exactly as it is stored,
//          under the file's lock. A row that exists is never replaced.
//          Safe to repeat and to run with secrets.store on. Exit 1 if one failed.
// export   the way back: writes every row into its file as stored. Do it
//          before turning secrets.mirror back on, and before secrets.store
//          off. Exit 1 if one failed.
// Exit 64: usage, or no database.

import { setVaultStore } from "../../foldrun-core/src/secrets.ts";
import { registerPlatform } from "../../foldrun-core/src/platform.ts";
import { loadTenantKeys, tenantKey } from "../src/tenant-keys.ts";
import { pgVaultStore } from "../src/vault-pg.ts";
import { verifyFleet, importFileOnly, exportFleet } from "../src/vault-fleet.ts";

const [cmd, ...args] = process.argv.slice(2);
const usage = (msg: string): never => {
  console.error(`${msg}\nusage: vault-fleet.ts verify [--open] [--mirror-off] [--tenant a,b] | import [--tenant a,b] | export [--tenant a,b]`);
  process.exit(64);
};
if (cmd !== "verify" && cmd !== "import" && cmd !== "export") usage("a command is required");
const flags: string[] = [];
let tenants: string[] | undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--tenant") {
    tenants = args[++i]?.split(",").map((t) => t.trim()).filter(Boolean);
    if (!tenants?.length) usage("--tenant needs account names");
  } else if (cmd === "verify" && (args[i] === "--open" || args[i] === "--mirror-off")) flags.push(args[i]);
  else usage(`unexpected ${args[i]}`);
}
if (!process.env.FOLDRUN_DATABASE_URL) usage("this needs the database: FOLDRUN_DATABASE_URL is not set");

await loadTenantKeys();
registerPlatform({ tenantKey });
// Read what the rows say, whatever the setting is: this tool is about both.
setVaultStore(pgVaultStore(() => true));

if (cmd === "verify") {
  const r = verifyFleet({ tenants, open: flags.includes("--open"), rowsAuthoritative: flags.includes("--mirror-off") });
  console.log(`scopes in rows ${r.scopes} · records ${r.records} · equal to their file ${r.equal} · only a file ${r.fileOnly.length} · only a row ${r.rowOnly.length} · differ ${r.differs.length}${flags.includes("--open") ? ` · do not open ${r.unreadable.length}` : ""}`);
  for (const [what, list] of [["only a file (import it)", r.fileOnly], ["only a row", r.rowOnly], ["differs from its file", r.differs], ["does not open", r.unreadable]] as const) for (const n of list) console.log(`  ${what.padEnd(24)} ${n}`);
  console.log(r.clean ? "clean" : "NOT clean");
  process.exit(r.clean ? 0 : 1);
}
if (cmd === "import") {
  const r = importFileOnly({ tenants });
  console.log(`imported ${r.imported.length}${r.failed.length ? ` · FAILED ${r.failed.length}` : ""}`);
  for (const n of r.failed) console.log(`  failed ${n}`);
  process.exit(r.failed.length ? 1 : 0);
}
const r = exportFleet({ tenants });
console.log(`files written ${r.written} · skipped (no workspace folder) ${r.skipped.length}${r.failed.length ? ` · FAILED ${r.failed.length}` : ""}`);
for (const n of r.skipped) console.log(`  skipped ${n}`);
for (const n of r.failed) console.log(`  failed  ${n}`);
process.exit(r.failed.length ? 1 : 0);
