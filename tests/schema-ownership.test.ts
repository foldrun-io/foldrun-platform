// Who describes which table (30 Oct 2026). The public schema (src/schema.ts)
// describes exactly the tables the public product uses; the hosted ones —
// billing's and the operator console's — are described by foldrun-admin
// (schema-billing.ts, schema-console.ts) and changed by ITS migrations
// (drizzle-hosted/, applied after the public chain). The public chain still
// made them, and they stay on every database (0028, 0030 handed them over
// with no DROP), so their names are reserved here.
//
//   node --test tests/schema-ownership.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "../src/schema.ts";

const root = path.join(import.meta.dirname, "..");

/** The hosted tables: made by the public chain, described by foldrun-admin. */
export const HOSTED_TABLES = ["console_operators", "console_sessions", "console_settings", "support_views", "wallets", "stripe_events"];

const publicTables = () =>
  Object.values(schema)
    .filter((v) => is(v, PgTable))
    .map((t) => getTableName(t as PgTable))
    .sort();

/** The newest snapshot drizzle-kit wrote, by the journal. */
function newestSnapshot(): { tag: string; tables: string[] } {
  const journal = JSON.parse(fs.readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8")) as { dialect: string; entries: { idx: number; tag: string }[] };
  assert.equal(journal.dialect, "postgresql");
  const last = journal.entries[journal.entries.length - 1];
  assert.ok(fs.existsSync(path.join(root, "drizzle", `${last.tag}.sql`)), `${last.tag}.sql is in drizzle/`);
  const snap = JSON.parse(fs.readFileSync(path.join(root, "drizzle/meta", `${String(last.idx).padStart(4, "0")}_snapshot.json`), "utf8")) as { version: string; dialect: string; tables: Record<string, { name: string; schema: string }> };
  assert.equal(snap.version, "7", "a snapshot format this test reads");
  assert.equal(snap.dialect, "postgresql");
  return { tag: last.tag, tables: Object.values(snap.tables).map((t) => { assert.ok(t.schema === "" || t.schema === "public", `${t.name} in schema ${t.schema}`); return t.name; }).sort() };
}

test("the public schema describes no hosted table", () => {
  const mine = publicTables();
  assert.ok(mine.includes("ledger") && mine.includes("oauth_clients"), "the exported tables are read, keyedRecords ones included");
  for (const t of HOSTED_TABLES) assert.ok(!mine.includes(t), `${t} is foldrun-admin's (schema-billing.ts / schema-console.ts), not src/schema.ts's`);
});

test("the newest migration snapshot is exactly the public schema — db:generate has nothing to drop or add", () => {
  const snap = newestSnapshot();
  assert.deepEqual(snap.tables, publicTables(), `meta snapshot of ${snap.tag} vs src/schema.ts`);
  for (const t of HOSTED_TABLES) assert.ok(!snap.tables.includes(t), `${t} is still in the snapshot of ${snap.tag}`);
});

test("the hand-over migrations drop nothing", () => {
  for (const f of ["0028_console_tables_to_admin.sql", "0030_billing_tables_to_admin.sql"]) {
    const text = fs.readFileSync(path.join(root, "drizzle", f), "utf8");
    const code = text.split("\n").filter((l) => l.trim() && !l.trim().startsWith("--"));
    assert.deepEqual(code, [], `${f} is comments only`);
  }
});

test("hosted migrations: beside drizzle/, named in their own namespace, none when the directory is not there", async () => {
  const { hostedMigrationFiles, hostedMigrationsDir, migrationsDir, HOSTED_MIGRATION_PREFIX } = await import("../src/db.ts");
  const saved = process.env.FOLDRUN_HOSTED_MIGRATIONS_DIR;
  try {
    delete process.env.FOLDRUN_HOSTED_MIGRATIONS_DIR;
    assert.equal(hostedMigrationsDir(), path.join(path.dirname(migrationsDir()), "drizzle-hosted"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-hosted-mig-"));
    fs.writeFileSync(path.join(dir, "0001_b.sql"), "SELECT 2;");
    fs.writeFileSync(path.join(dir, "0000_a.sql"), "SELECT 1;");
    fs.writeFileSync(path.join(dir, "notes.md"), "not a migration");
    process.env.FOLDRUN_HOSTED_MIGRATIONS_DIR = dir;
    assert.deepEqual(hostedMigrationFiles().map((m) => m.name), [`${HOSTED_MIGRATION_PREFIX}0000_a`, `${HOSTED_MIGRATION_PREFIX}0001_b`]);
    process.env.FOLDRUN_HOSTED_MIGRATIONS_DIR = path.join(dir, "absent");
    assert.deepEqual(hostedMigrationFiles(), [], "a public install has none, and that is not an error");
  } finally {
    if (saved === undefined) delete process.env.FOLDRUN_HOSTED_MIGRATIONS_DIR;
    else process.env.FOLDRUN_HOSTED_MIGRATIONS_DIR = saved;
  }
});
