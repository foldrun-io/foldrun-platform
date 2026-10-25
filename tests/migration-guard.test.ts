// The migration guard: every migration must work with the release before it.
//
// A rollback runs the previous release's code on the newer schema, so a
// migration that drops, renames or tightens what that code uses breaks the
// rollback, not the deploy. scripts/migration-guard.mjs refuses those in the
// migrations added since a base, unless a statement is marked as a
// deliberate contract step with a reason.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
// @ts-expect-error — a plain .mjs script, no declarations
import { splitStatements, refusals, checkMigration, checkFiles, changedSince, resolveBase } from "../scripts/migration-guard.mjs";

const SCRIPT = path.resolve(import.meta.dirname, "../scripts/migration-guard.mjs");

const refused = (sql: string) => checkMigration(sql).refused.map((r: { message: string }) => r.message);

test("statements split on ; and drizzle's breakpoint, not inside comments, strings or $$ bodies", () => {
  const sql = [
    "-- a header; with a semicolon",
    'CREATE TABLE "a" ("x" text DEFAULT \'semi;colon -- not a comment\' NOT NULL);--> statement-breakpoint',
    "/* block; /* nested; */ still */ ALTER TABLE a ADD COLUMN y text;",
    "CREATE FUNCTION f() RETURNS void AS $body$ BEGIN DROP TABLE a; END $body$ LANGUAGE plpgsql;",
    "INSERT INTO a (x) VALUES (E'it\\'s; fine')",
  ].join("\n");
  const st = splitStatements(sql);
  assert.equal(st.length, 4);
  assert.deepEqual(st.map((s: { line: number }) => s.line), [2, 3, 4, 5]);
  assert.match(st[0].text, /^CREATE TABLE "a"/);
  assert.doesNotMatch(st[0].text, /semi;colon/, "string bodies are blanked");
  assert.match(st[1].text, /^ALTER TABLE a ADD COLUMN y text$/);
  assert.doesNotMatch(st[2].text, /DROP/, "a function body is not a statement to check");
  assert.deepEqual(refused(sql), [], "the DROP inside a function body and a string is not refused");
});

test("refuses DROP TABLE, DROP COLUMN, DROP INDEX and DROP CONSTRAINT", () => {
  assert.match(refused('DROP TABLE "api_keys";')[0], /DROP TABLE api_keys/);
  assert.match(refused("DROP TABLE IF EXISTS public.ledger CASCADE;")[0], /DROP TABLE ledger/);
  assert.match(refused('ALTER TABLE "api_keys" DROP COLUMN "last_ip";')[0], /DROP COLUMN api_keys.last_ip/);
  assert.match(refused("ALTER TABLE api_keys DROP last_ip;")[0], /DROP COLUMN api_keys.last_ip/);
  assert.match(refused("ALTER TABLE ONLY api_keys DROP COLUMN IF EXISTS last_ip CASCADE;")[0], /DROP COLUMN/);
  assert.match(refused('DROP INDEX "ledger_key_idx";')[0], /DROP INDEX/);
  assert.match(refused('ALTER TABLE "ledger" DROP CONSTRAINT IF EXISTS "ledger_kind_check";')[0], /DROP CONSTRAINT ledger_kind_check/);
  assert.match(refused("ALTER TABLE ledger ALTER CONSTRAINT ledger_fk DEFERRABLE;")[0], /ALTER CONSTRAINT/);
});

test("refuses renames: table, column, constraint, type value, and SET SCHEMA", () => {
  assert.match(refused('ALTER TABLE "api_keys" RENAME TO "keys";')[0], /RENAME on api_keys/);
  assert.match(refused('ALTER TABLE "api_keys" RENAME COLUMN "label" TO "name";')[0], /RENAME on api_keys/);
  assert.match(refused("ALTER TABLE api_keys RENAME label TO name;")[0], /RENAME/);
  assert.match(refused("ALTER TABLE api_keys RENAME CONSTRAINT a TO b;")[0], /RENAME/);
  assert.match(refused("ALTER TYPE kind RENAME VALUE 'run' TO 'job';")[0], /RENAME/);
  assert.match(refused("ALTER TABLE api_keys SET SCHEMA archive;")[0], /SET SCHEMA/);
});

test("refuses a column type change, in either spelling", () => {
  assert.match(refused('ALTER TABLE "ledger" ALTER COLUMN "usd" SET DATA TYPE numeric(20, 6);')[0], /ledger.usd TYPE/);
  assert.match(refused("ALTER TABLE ledger ALTER usd TYPE text USING usd::text;")[0], /ledger.usd TYPE/);
});

test("SET NOT NULL needs a DEFAULT in the same migration", () => {
  assert.match(refused('ALTER TABLE "api_keys" ALTER COLUMN "label" SET NOT NULL;')[0], /SET NOT NULL on api_keys.label/);
  assert.deepEqual(
    refused('ALTER TABLE "api_keys" ALTER COLUMN "label" SET DEFAULT \'\';--> statement-breakpoint\nUPDATE api_keys SET label = \'\' WHERE label IS NULL;--> statement-breakpoint\nALTER TABLE "api_keys" ALTER COLUMN "label" SET NOT NULL;'),
    [],
  );
  assert.deepEqual(refused("ALTER TABLE api_keys ALTER COLUMN label SET DEFAULT 'x', ALTER COLUMN label SET NOT NULL;"), [], "the same statement counts too");
  assert.match(refused("ALTER TABLE api_keys ALTER COLUMN other SET DEFAULT 'x', ALTER COLUMN label SET NOT NULL;")[0], /api_keys.label/, "a default on another column does not");
  assert.match(refused('ALTER TABLE "api_keys" ALTER COLUMN "label" DROP DEFAULT;')[0], /DROP DEFAULT/);
});

test("ADD COLUMN NOT NULL needs a DEFAULT (or a generated value); nullable and defaulted columns pass", () => {
  assert.match(refused('ALTER TABLE "queue" ADD COLUMN "lane" text NOT NULL;')[0], /ADD COLUMN queue.lane NOT NULL/);
  assert.match(refused("ALTER TABLE queue ADD lane text CHECK (lane <> '') NOT NULL;")[0], /queue.lane/);
  assert.deepEqual(refused('ALTER TABLE "queue" ADD COLUMN "resume_requested" boolean DEFAULT false NOT NULL;'), []);
  assert.deepEqual(refused('ALTER TABLE "ledger" ADD COLUMN IF NOT EXISTS "carried_usd" numeric(14, 6);'), []);
  assert.deepEqual(refused("ALTER TABLE queue ADD COLUMN n bigint GENERATED ALWAYS AS IDENTITY NOT NULL;"), []);
  assert.deepEqual(refused("ALTER TABLE queue ADD COLUMN n bigserial NOT NULL;"), []);
  assert.deepEqual(refused("ALTER TABLE queue ADD COLUMN note text CHECK (note IS NOT NULL OR true);"), [], "NOT NULL inside a CHECK is not the column's");
  assert.deepEqual(refused('ALTER TABLE "ledger" ADD CONSTRAINT "ledger_kind_check" CHECK ("ledger"."kind" IN (\'topup\'));'), []);
});

test("refuses TRUNCATE, DELETE with no WHERE (a CTE's too), and DO blocks", () => {
  assert.match(refused("TRUNCATE queue;")[0], /TRUNCATE/);
  assert.match(refused("DELETE FROM queue;")[0], /DELETE with no WHERE/);
  assert.match(refused("WITH gone AS (DELETE FROM queue RETURNING id) SELECT count(*) FROM gone WHERE true;")[0], /DELETE with no WHERE/);
  assert.deepEqual(refused("DELETE FROM queue WHERE finished_at < now() - interval '30 days';"), []);
  assert.deepEqual(refused("WITH gone AS (DELETE FROM queue WHERE id IN (SELECT id FROM queue)) SELECT 1;"), []);
  assert.deepEqual(refused("DELETE FROM queue WHERE note = 'DELETE FROM x';"), []);
  assert.match(refused("DO $$ BEGIN EXECUTE 'DROP TABLE x'; END $$;")[0], /DO block/);
});

test("the expand steps every existing migration uses pass", () => {
  const dir = path.resolve(import.meta.dirname, "../drizzle");
  for (const f of fs.readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f) && f >= "0003")) {
    assert.deepEqual(refused(fs.readFileSync(path.join(dir, f), "utf8")), [], f);
  }
  assert.deepEqual(refused('CREATE UNIQUE INDEX "a_idx" ON "a" USING btree ("x");'), []);
  assert.deepEqual(refused("UPDATE ledger SET key = 'k' WHERE key IS NULL;"), []);
});

test("a table created in the checked migrations may be altered and dropped freely", () => {
  const sql = [
    'CREATE TABLE "scratch" ("id" text PRIMARY KEY NOT NULL, "v" text);--> statement-breakpoint',
    'ALTER TABLE "scratch" ADD COLUMN "w" text NOT NULL;--> statement-breakpoint',
    'ALTER TABLE "scratch" ALTER COLUMN "v" SET DATA TYPE integer;--> statement-breakpoint',
    'ALTER TABLE "scratch" RENAME COLUMN "v" TO "value";--> statement-breakpoint',
    'DROP TABLE "scratch";',
  ].join("\n");
  assert.deepEqual(refused(sql), []);
  // …and across files: what 0019 creates, 0020 may change.
  const files: Record<string, string> = {
    "0019_a.sql": 'CREATE TABLE "scratch" ("id" text);\nALTER TABLE "api_keys" ADD COLUMN "tmp" text;',
    "0020_b.sql": 'ALTER TABLE "scratch" ADD COLUMN "w" text NOT NULL;\nALTER TABLE "api_keys" DROP COLUMN "tmp";\nALTER TABLE "api_keys" DROP COLUMN "label";',
  };
  const results = checkFiles(Object.keys(files), { read: (f: string) => files[f] });
  assert.deepEqual(results[0].refused, []);
  assert.deepEqual(results[1].refused.map((r: { message: string }) => r.message), [
    "DROP COLUMN api_keys.label: the previous release still reads it — drop it a release after the code stops",
  ], "a column added in this release may go; an old one may not");
});

test("a new column still needs a DEFAULT before SET NOT NULL — old code inserts without it", () => {
  const sql = 'ALTER TABLE "api_keys" ADD COLUMN "scope" text;\nALTER TABLE "api_keys" ALTER COLUMN "scope" SET NOT NULL;';
  assert.match(refused(sql)[0], /SET NOT NULL on api_keys.scope/);
});

test("the contract opt-out passes the statement below it, with its reason, and only that one", () => {
  const sql = [
    "-- Contract step for the label → name move.",
    "-- migration-guard: contract label unread since v2026.09.30.1",
    'ALTER TABLE "api_keys" DROP COLUMN "label";--> statement-breakpoint',
    'ALTER TABLE "api_keys" DROP COLUMN "prefix";',
  ].join("\n");
  const r = checkMigration(sql);
  assert.equal(r.contracts.length, 1);
  assert.equal(r.contracts[0].line, 3);
  assert.equal(r.contracts[0].reason, "label unread since v2026.09.30.1");
  assert.match(r.contracts[0].message, /api_keys.label/);
  assert.equal(r.refused.length, 1);
  assert.match(r.refused[0].message, /api_keys.prefix/);
});

test("an opt-out with no reason is refused; one covering nothing is a warning", () => {
  const bare = checkMigration('-- migration-guard: contract\nDROP TABLE "a";');
  assert.equal(bare.contracts.length, 0);
  assert.match(bare.refused[0].message, /needs a reason/);
  const colon = checkMigration('-- migration-guard: contract:   \nDROP TABLE "a";');
  assert.match(colon.refused[0].message, /needs a reason/);

  const gap = checkMigration('-- migration-guard: contract reason here\n\nDROP TABLE "a";');
  assert.equal(gap.refused.length, 1, "a blank line breaks the link: the opt-out must be directly above");
  assert.match(gap.warnings[0].message, /covers nothing/);

  const pointless = checkMigration('-- migration-guard: contract because\nALTER TABLE "a" ADD COLUMN "b" text;');
  assert.deepEqual(pointless.refused, []);
  assert.match(pointless.warnings[0].message, /does not refuse/);
});

test("refusals report the line each statement starts on", () => {
  const r = checkMigration('CREATE TABLE "x" ("a" text);\n--> statement-breakpoint\n\nTRUNCATE "queue";');
  assert.deepEqual(r.refused.map((x: { line: number }) => x.line), [4]);
  assert.deepEqual(refusals("select 1"), []);
});

// ------------------------------------------------------------ against git

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-guard-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  g("config", "commit.gpgsign", "false");
  fs.mkdirSync(path.join(dir, "drizzle"));
  fs.writeFileSync(path.join(dir, "drizzle/0000_baseline.sql"), 'CREATE TABLE "a" ("x" text);\n');
  fs.writeFileSync(path.join(dir, "drizzle/0001_old.sql"), 'ALTER TABLE "a" DROP COLUMN "gone";\n');
  g("add", "-A");
  g("commit", "-qm", "base");
  g("tag", "base");
  return dir;
}

function guard(cwd: string, ...args: string[]) {
  // The test may itself run under a git hook, which exports GIT_DIR: the
  // guard must find the throwaway repo from its working directory instead.
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  delete env.MIGRATION_GUARD_BASE;
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8", env });
  return { code: r.status, out: r.stdout + r.stderr };
}

test("only migrations added since the base are checked; what the base had is grandfathered", () => {
  const dir = repo();
  try {
    let r = guard(dir, "--base", "base");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /0 new migration/);

    fs.writeFileSync(path.join(dir, "drizzle/0002_new.sql"), 'ALTER TABLE "a" ADD COLUMN "y" text;\n');
    r = guard(dir, "--base", "base");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /ok {6}drizzle\/0002_new.sql/, "an untracked migration counts as added");

    fs.writeFileSync(path.join(dir, "drizzle/0003_bad.sql"), 'ALTER TABLE "a" RENAME COLUMN "x" TO "z";\n');
    r = guard(dir, "--base", "base");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /REFUSED drizzle\/0003_bad.sql:1: RENAME on a/);
    assert.doesNotMatch(r.out, /0001_old/, "the released DROP COLUMN is before the base");

    fs.writeFileSync(path.join(dir, "drizzle/0003_bad.sql"), "-- migration-guard: contract z replaces x since v1\nALTER TABLE \"a\" RENAME COLUMN \"x\" TO \"z\";\n");
    r = guard(dir, "--base", "base");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /contract drizzle\/0003_bad.sql:2: RENAME on a.*allowed: z replaces x since v1/);

    assert.equal(guard(dir, "--all").code, 1, "--all reads every file, the released ones too");
    assert.equal(guard(dir, "drizzle/0002_new.sql").code, 0, "file arguments check exactly those");
    assert.equal(guard(dir, "--base", "nope").code, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("editing or deleting a released migration is refused", () => {
  const dir = repo();
  try {
    fs.appendFileSync(path.join(dir, "drizzle/0000_baseline.sql"), 'ALTER TABLE "a" ADD COLUMN "y" text;\n');
    fs.rmSync(path.join(dir, "drizzle/0001_old.sql"));
    const { added, touched } = changedSince(dir, "base");
    assert.deepEqual(added, []);
    assert.deepEqual(touched, [
      { file: "drizzle/0000_baseline.sql", status: "edited" },
      { file: "drizzle/0001_old.sql", status: "deleted" },
    ]);
    const r = guard(dir, "--base", "base");
    assert.equal(r.code, 1);
    assert.match(r.out, /REFUSED drizzle\/0000_baseline.sql: edited after it was released/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a repository's first commit has no base here, and says so instead of failing", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-guard-root-"));
  const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  try {
    g("init", "-q");
    g("commit", "-q", "--allow-empty", "-m", "first");
    const prev = process.env.MIGRATION_GUARD_BASE;
    process.env.MIGRATION_GUARD_BASE = "0000000000000000000000000000000000000000";
    try {
      assert.deepEqual(resolveBase(repo, undefined), { ref: null, why: "this repository's first commit" });
      g("commit", "-q", "--allow-empty", "-m", "second");
      assert.throws(() => resolveBase(repo, undefined), /no base/, "a second commit with nothing to compare with is still an error");
      // A shallow clone of it hides the first commit: not a root, an error.
      const shallow = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-guard-shallow-"));
      try {
        execFileSync("git", ["clone", "-q", "--depth", "1", `file://${repo}`, shallow]);
        assert.throws(() => resolveBase(shallow, undefined), /shallow/, "a shallow clone must fetch history, not pass");
        assert.throws(() => resolveBase(os.tmpdir(), undefined), /no base/, "outside a checkout git answers nothing, and that is no root");
      } finally {
        fs.rmSync(shallow, { recursive: true, force: true });
      }
    } finally {
      if (prev === undefined) delete process.env.MIGRATION_GUARD_BASE;
      else process.env.MIGRATION_GUARD_BASE = prev;
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
