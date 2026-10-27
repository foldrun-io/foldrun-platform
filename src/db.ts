// Postgres: the record store.
//
// The rule this file exists to hold (docs/paas-adr.md): markdown for what
// people author, Postgres for what the system accumulates. Workspaces, agents
// and flows stay files — they are the product. Runs, money, jobs, identity and
// audit are records: they need transactions, indexes and concurrent writers,
// and every symptom that pushed us here was one of those three missing.
//
// OPTIONAL BY DESIGN. With no FOLDRUN_DATABASE_URL the platform runs exactly
// as it did — files only. That is what a self-hoster on a laptop gets, and it
// is also the rollback: unset the variable and the file paths are still there.
// So every caller must handle `null` rather than assume a pool.
//
//   FOLDRUN_DATABASE_URL       postgres://user@host:5432/db
//   FOLDRUN_DATABASE_PASSWORD  kept separate so the URL can be a plain value
//                              in a manifest while the password comes from a
//                              secret — a URL with credentials inline leaks
//                              into every log line that prints its config.

import fs from "node:fs";
import path from "node:path";
import { Client, Pool, type ClientConfig } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import * as schema from "./schema.ts";

let pool: Pool | null = null;
let ormInstance: NodePgDatabase<typeof schema> | null = null;

/** A handle a query can run on: the database, or a transaction inside it.
 *  Every db module takes one of these as its optional last argument, so a
 *  caller that has opened a transaction can run the same function inside
 *  it and a caller that has not gets the pool. */
export type Db = NodePgDatabase<typeof schema> | Parameters<Parameters<NodePgDatabase<typeof schema>["transaction"]>[0]>[0];

export { schema };

export function databaseEnabled(): boolean {
  return Boolean(process.env.FOLDRUN_DATABASE_URL);
}

/** Where the database is, for the pool and for a connection of its own. */
function connectionConfig(): ClientConfig {
  const url = new URL(process.env.FOLDRUN_DATABASE_URL!);
  return {
    host: url.hostname,
    port: Number(url.port) || 5432,
    user: decodeURIComponent(url.username) || "foldrun",
    database: url.pathname.replace(/^\//, "") || "foldrun",
    password: process.env.FOLDRUN_DATABASE_PASSWORD || undefined,
    ssl: url.searchParams.get("sslmode") === "require" ? { rejectUnauthorized: false } : undefined,
  };
}

/**
 * Run `fn` while holding a named Postgres advisory lock, across every
 * process that uses the same name (28 Oct 2026). The lock lives on a
 * connection of its own, outside the pool, so `fn` uses the pool freely: a
 * lock held on a pooled connection while `fn` waits for another starves a
 * small pool (a pool of one deadlocks outright). If this process dies, its
 * connection closes and the lock goes with it. A holder that does not let
 * go within `waitMs` makes the next caller fail rather than hang.
 */
export async function withNamedLock<T>(name: string, fn: () => Promise<T>, waitMs = 60_000): Promise<T> {
  const client = new Client({ ...connectionConfig(), connectionTimeoutMillis: 5_000 });
  client.on("error", (err) => console.error(`[db] lock connection for ${name}: ${err.message}`));
  await client.connect();
  try {
    await client.query(`SET lock_timeout = ${Math.max(1, Math.round(waitMs))}`);
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [name]);
    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [name]).catch(() => {});
    }
  } finally {
    await client.end().catch(() => {});
  }
}

/** The pool, or null when this install has no database. */
export function db(): Pool | null {
  if (!databaseEnabled()) return null;
  if (!pool) {
    // Discrete fields, NOT connectionString + password. pg re-parses the
    // connection string inside the Client, and the password it finds there
    // (none — deliberately, so credentials never appear in a URL that gets
    // logged) overwrites the one passed beside it. The Pool's own options
    // still show the password, which is what makes this look like it works
    // right up until the SASL handshake says "client password must be a
    // string".
    pool = new Pool({
      ...connectionConfig(),
      // A web replica holds connections while it serves; Postgres counts them
      // against max_connections globally, so the cap is per-process and small
      // on purpose. N replicas × this is the number that matters.
      max: Number(process.env.FOLDRUN_DATABASE_POOL) || 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    // A pool that emits an unhandled 'error' takes the process down. Postgres
    // restarting under us is normal (a rollout, a node reboot) and must be a
    // logged reconnect, not an outage of the whole platform.
    pool.on("error", (err) => console.error("[db] idle client error:", err.message));
  }
  return pool;
}

/**
 * The ORM over the pool, or null when this install has no database.
 *
 * Drizzle, on the same pool: typed against src/schema.ts, so a query cannot
 * name a column that does not exist, and a row comes back with the shape
 * the schema says. The pool itself stays reachable through db() for the
 * one thing an ORM should not own — the migration runner's advisory lock.
 */
export function orm(): NodePgDatabase<typeof schema> | null {
  const p = db();
  if (!p) return null;
  if (!ormInstance) ormInstance = drizzle(p, { schema });
  return ormInstance;
}

/** The ORM, or a thrown error where a caller has already decided a
 *  database must exist. */
export function ormRequired(): NodePgDatabase<typeof schema> {
  const o = orm();
  if (!o) throw new Error("no database configured");
  return o;
}

/** Run inside a transaction, rolling back on any throw. */
export async function tx<T>(fn: (t: Db) => Promise<T>): Promise<T> {
  return ormRequired().transaction((t) => fn(t));
}

// ---------------------------------------------------------------- migrations
//
// Plain SQL in order, applied once, recorded by name. No migration library:
// the whole mechanism is a table and a loop, and a library here would be a
// dependency to upgrade forever in exchange for `up`/`down` we do not use —
// a down migration on a production database is a thing you write and never
// run, because by the time you want it the data has moved on.
//
// Every migration must work with the previous release's code. A rollback
// (foldrun-infra box-deploy.yml, `version:`) redeploys older code and leaves
// the database on the newer schema, so a migration only expands: add a table,
// a nullable column, a column with a DEFAULT, an index. Removing or reshaping
// what released code uses — DROP, RENAME, a column TYPE change, SET NOT NULL
// with no default, a NOT NULL column with no DEFAULT, dropping a constraint
// or a default, TRUNCATE, DELETE with no WHERE — is the contract half, and
// ships a release after the code has stopped using it. A released migration
// is never edited. scripts/migration-guard.mjs refuses the rest in CI and in
// the pre-push hook; a deliberate contract step says so on the line above the
// statement, with a reason: `-- migration-guard: contract <reason>`.

interface Migration {
  name: string;
  sql: string;
}

/**
 * The migration files, in name order.
 *
 * `drizzle/*.sql`: 0000_baseline.sql is the eight migrations the platform
 * shipped with, folded into one idempotent file; every later one is what
 * `drizzle-kit generate` wrote from a change to src/schema.ts. The runner
 * applies them in name order and records each by file name, which is also
 * how it knows a database that ran 0001…0008 under their old names needs
 * nothing from the baseline — the baseline is IF NOT EXISTS throughout, so
 * applying it there is a no-op that gets recorded and never repeats.
 */
/**
 * Where the files are. The same rule the docs use (foldrun-docs/index.ts):
 * the web server runs from foldrun-web/ and the platform is its sibling,
 * so cwd/../foldrun-platform/drizzle — never import.meta.dirname, which a
 * bundler rewrites to wherever it put the chunk. FOLDRUN_MIGRATIONS_DIR
 * overrides for a layout that differs.
 */
export function migrationsDir(): string {
  if (process.env.FOLDRUN_MIGRATIONS_DIR) return process.env.FOLDRUN_MIGRATIONS_DIR;
  // Each role runs from its own package: the web from foldrun-web/ (the
  // platform is its sibling), the worker from foldrun-platform/ (the files
  // are right here). A process started one level up, from the folder that
  // holds both, is the third layout. The first that exists wins; the last
  // is the answer when none does, so the error names a real path.
  const candidates = [
    path.join(process.cwd(), "drizzle"),
    path.join(process.cwd(), "..", "foldrun-platform", "drizzle"),
    path.join(process.cwd(), "foldrun-platform", "drizzle"),
  ];
  return candidates.find((d) => fs.existsSync(d)) ?? candidates[0];
}

export function migrationFiles(dir = migrationsDir()): Migration[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()
    .map((f) => ({ name: f.replace(/\.sql$/, ""), sql: fs.readFileSync(path.join(dir, f), "utf8") }));
}

/**
 * Apply anything unapplied. Safe to call on every boot and from every replica:
 * the advisory lock means the second one waits rather than racing, and each
 * migration is recorded by name so it runs exactly once across the fleet.
 */
export async function migrate(): Promise<string[]> {
  const p = db();
  if (!p) return [];
  const applied: string[] = [];

  await p.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const client = await p.connect();
  try {
    // One arbitrary constant, held for the whole run: two replicas booting
    // together must not both apply 0001.
    await client.query("SELECT pg_advisory_lock($1)", [727_314_159]);
    const { rows } = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const done = new Set(rows.map((r) => r.name));
    const files = migrationFiles();
    // Loud, not quiet. A runner that finds no files and applies nothing
    // would let a fresh install boot with no tables and fail on the first
    // query instead — from somewhere that has no idea why.
    if (files.length === 0) {
      throw new Error(`no migration files at ${migrationsDir()} — set FOLDRUN_MIGRATIONS_DIR to the platform's drizzle/ directory`);
    }
    for (const m of files) {
      if (done.has(m.name)) continue;
      await client.query("BEGIN");
      try {
        await client.query(m.sql.replace(/^--> statement-breakpoint$/gm, ""));
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [m.name]);
        await client.query("COMMIT");
        applied.push(m.name);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${m.name} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [727_314_159]).catch(() => {});
    client.release();
  }
  return applied;
}

/** True when the database answers. Used by healthz, never to gate a request. */
export async function databaseReady(): Promise<boolean> {
  const p = db();
  if (!p) return false;
  try {
    await p.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
