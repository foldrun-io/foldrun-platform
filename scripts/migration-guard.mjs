#!/usr/bin/env node
// migration-guard: every migration must work with the release before it.
//
// Migrations are forward-only SQL in drizzle/, applied at boot by
// src/db.ts migrate(). A rollback (foldrun-infra box-deploy.yml, `version:`)
// redeploys older code and leaves the database on the newer schema, so the
// code of the previous release has to keep working against every migration
// added since. That is expand/contract: add the new thing, move the code to
// it, and only remove the old thing in a later release, once no deployed
// version still reads it.
//
// This refuses, in the migrations added since a base commit, the statements
// that break the previous release's code:
//
//   DROP <anything>                        old code still reads it
//   ALTER TABLE … DROP COLUMN / CONSTRAINT  same; a dropped unique key also
//                                           breaks old ON CONFLICT targets
//   RENAME (table, column, constraint, type, …) and SET SCHEMA
//   ALTER COLUMN … TYPE / SET DATA TYPE
//   ALTER COLUMN … SET NOT NULL             unless the same migration gives
//                                           the column a DEFAULT
//   ALTER COLUMN … DROP DEFAULT             old inserts relied on it
//   ALTER CONSTRAINT
//   ADD COLUMN … NOT NULL with no DEFAULT   old inserts do not name it
//   TRUNCATE, DELETE with no WHERE
//   DO blocks                               cannot be read, so cannot be passed
//   editing, renaming or deleting a migration the base already had
//
// Tables created in the migrations being checked are exempt — no released
// code knows them — as are DROP / TYPE / RENAME of a column added in them.
//
// A deliberate contract step says so on the comment line(s) directly above
// the statement, with a reason, and is reported rather than refused:
//
//   -- migration-guard: contract drop api_keys.legacy_hash, unread since v2026.09.30.1
//   ALTER TABLE "api_keys" DROP COLUMN "legacy_hash";
//
// The base: --base <ref>, else $MIGRATION_GUARD_BASE, else the platform
// commit recorded in the newest box version tag of ../foldrun-infra (what is
// deployed), else origin/main (its merge base with HEAD, or origin/main~1
// when HEAD is origin/main). Uncommitted and untracked migrations count as
// added. `--all` checks every migration instead (the existing ones are
// grandfathered by the base, not by passing); file arguments check exactly
// those files.
//
//   node scripts/migration-guard.mjs [--base <ref>] [--all] [--dir drizzle] [--tag-key platform] [file.sql …]
//
// foldrun-admin's hosted migrations (30 Oct 2026) are checked the same way,
// from that repository: `--dir platform/drizzle-hosted --tag-key admin` (the
// deployed base is then the admin commit in the version tag).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MIGRATION_RE = /^\d{4}_.*\.sql$/;
const OPT_OUT_RE = /^--\s*migration-guard:\s*contract\b(.*)$/i;

// ------------------------------------------------------------------ scanning

/**
 * Split SQL into statements, with comments and string bodies blanked out.
 *
 * Returns each statement's cleaned text (comments → spaces, '…' and $$…$$
 * bodies emptied, "quoted identifiers" kept) and the 1-based line it starts
 * on. Boundaries are `;` outside strings and comments, and drizzle's
 * `--> statement-breakpoint` marker.
 */
export function splitStatements(sql) {
  const out = [];
  let clean = "";
  let start = 0;
  const cut = () => {
    const text = clean.slice(start);
    const lead = text.search(/\S/);
    if (lead >= 0) {
      const at = start + lead;
      out.push({ text: text.trim(), line: lineOf(sql, at) });
    }
    clean += " ";
    start = clean.length;
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if (c === "-" && n === "-") {
      let j = sql.indexOf("\n", i);
      if (j < 0) j = sql.length;
      const body = sql.slice(i + 2, j).trim();
      clean += " ".repeat(j - i);
      i = j;
      if (body === "> statement-breakpoint") {
        clean = clean.slice(0, -1); // keep offsets: cut() appends one space
        cut();
      }
      continue;
    }
    if (c === "/" && n === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") { depth++; j += 2; }
        else if (sql[j] === "*" && sql[j + 1] === "/") { depth--; j += 2; }
        else j++;
      }
      clean += blank(sql.slice(i, j));
      i = j;
      continue;
    }
    if (c === "'") {
      // '…' with '' as an escaped quote; E'…' also takes backslash escapes.
      const escapes = /[eE]/.test(sql[i - 1] ?? "") && !/\w/.test(sql[i - 2] ?? "");
      let j = i + 1;
      while (j < sql.length) {
        if (escapes && sql[j] === "\\") { j += 2; continue; }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j++;
      }
      j = Math.min(j + 1, sql.length);
      clean += "'" + blank(sql.slice(i + 1, j - 1)) + (j - i >= 2 ? "'" : "");
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') { j += 2; continue; }
          break;
        }
        j++;
      }
      j = Math.min(j + 1, sql.length);
      clean += sql.slice(i, j);
      i = j;
      continue;
    }
    if (c === "$" && !/[\w$]/.test(sql[i - 1] ?? "")) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const j = end < 0 ? sql.length : end + tag.length;
        clean += tag + blank(sql.slice(i + tag.length, Math.max(i + tag.length, j - tag.length))) + (end < 0 ? "" : tag);
        i = j;
        continue;
      }
    }
    if (c === ";") {
      cut();
      i++;
      continue;
    }
    clean += c;
    i++;
  }
  cut();
  return out;
}

function blank(s) {
  return s.replace(/[^\n]/g, " ");
}

function lineOf(s, at) {
  let line = 1;
  for (let k = 0; k < at && k < s.length; k++) if (s[k] === "\n") line++;
  return line;
}

/** "Foo Bar" → foo_bar, public.x → x, collapsed whitespace: what the rules match on. */
function normalise(text) {
  return text
    .replace(/"((?:[^"]|"")*)"/g, (_, id) => id.replace(/""/g, '"').toLowerCase().replace(/\W+/g, "_"))
    .replace(/\s+/g, " ")
    .trim();
}

function unqualify(name) {
  return name.replace(/^.*\./, "").toLowerCase();
}

/** Text at paren depth 0 only: `numeric(14, 6) NOT NULL` → `numeric() NOT NULL`. */
function topLevel(s) {
  let depth = 0;
  let out = "";
  for (const ch of s) {
    if (ch === "(") { if (depth === 0) out += "("; depth++; continue; }
    if (ch === ")") { depth = Math.max(0, depth - 1); if (depth === 0) out += ")"; continue; }
    if (depth === 0) out += ch;
  }
  return out;
}

function splitTopLevel(s, sep = ",") {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) { parts.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** Each DELETE FROM in the statement (a CTE's too) that has no WHERE at its own depth. */
function deletesWithoutWhere(s) {
  const found = [];
  const re = /\bDELETE\s+FROM\b/gi;
  let m;
  while ((m = re.exec(s))) {
    let depth = 0;
    let own = "";
    for (let k = m.index; k < s.length; k++) {
      const ch = s[k];
      if (ch === "(") depth++;
      else if (ch === ")") { if (depth === 0) break; depth--; continue; }
      if (depth === 0) own += ch;
    }
    if (!/\bWHERE\b/i.test(own)) found.push(m.index);
  }
  return found;
}

// --------------------------------------------------------------------- rules

const ALTER_TABLE_RE = /^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?([\w.]+)\s*\*?\s*(.*)$/i;

/** Tables and columns a set of migrations creates — no released code knows them. */
export function created(statements) {
  const tables = new Set();
  const columns = new Set();
  for (const st of statements) {
    const s = normalise(st.text);
    const t = /^CREATE (?:UNLOGGED |TEMP |TEMPORARY )?TABLE (?:IF NOT EXISTS )?([\w.]+)/i.exec(s);
    if (t) tables.add(unqualify(t[1]));
    const a = ALTER_TABLE_RE.exec(s);
    if (a) {
      for (const action of splitTopLevel(a[2])) {
        const c = /^ADD (?:COLUMN )?(?:IF NOT EXISTS )?(\w+)/i.exec(action);
        if (c && !/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)$/i.test(c[1])) {
          columns.add(`${unqualify(a[1])}.${c[1].toLowerCase()}`);
        }
      }
    }
  }
  return { tables, columns };
}

/**
 * The refusals in one statement, as strings. `defaults` is the table.column
 * pairs the same migration gives a DEFAULT; `fresh` is what the checked
 * migrations create (see created()).
 */
export function refusals(text, { defaults = new Set(), fresh = { tables: new Set(), columns: new Set() } } = {}) {
  const s = normalise(text);
  const out = [];

  if (/^DO\b/i.test(s)) out.push("DO block: its body cannot be checked — write plain statements, or mark it a contract step");
  if (/^TRUNCATE\b/i.test(s)) out.push("TRUNCATE: deletes rows the previous release still reads");
  for (const _ of deletesWithoutWhere(s)) out.push("DELETE with no WHERE: deletes every row the previous release still reads");

  const drop = /^DROP (MATERIALIZED VIEW|FOREIGN TABLE|\w+)(?: CONCURRENTLY)?(?: IF EXISTS)? ([\w.]+)/i.exec(s);
  if (drop) {
    const kind = drop[1].toUpperCase();
    const names = /^DROP [A-Z ]+?(?: CONCURRENTLY)?(?: IF EXISTS)? (.*?)(?: CASCADE| RESTRICT)?$/i.exec(s)?.[1] ?? drop[2];
    const all = names.split(",").map((n) => unqualify(n.trim()));
    if (!(kind === "TABLE" && all.every((n) => fresh.tables.has(n)))) {
      out.push(`DROP ${kind} ${all.join(", ")}: the previous release still uses it — drop it a release after the code stops`);
    }
  }

  if (/^ALTER (TYPE|VIEW|MATERIALIZED VIEW|SCHEMA|SEQUENCE|DOMAIN)\b.*\bRENAME\b/i.test(s)) {
    out.push("RENAME: the previous release still uses the old name — add the new one beside it instead");
  }
  if (/^ALTER (TYPE|DOMAIN)\b.*\bDROP\b/i.test(s)) out.push("ALTER TYPE … DROP: the previous release may still write it");

  const alter = ALTER_TABLE_RE.exec(s);
  if (alter) {
    const table = unqualify(alter[1]);
    if (fresh.tables.has(table)) return out; // created in this release: nothing old reads it
    const rest = alter[2];
    const rename = /^RENAME (?:(COLUMN|CONSTRAINT) )?(?:(\w+) TO )?(?:TO )?(\w+)?/i.exec(rest);
    if (rename) {
      const isColumn = rename[1]?.toUpperCase() === "COLUMN" || (!rename[1] && rename[2]);
      if (!(isColumn && fresh.columns.has(`${table}.${(rename[2] ?? "").toLowerCase()}`))) {
        out.push(`RENAME on ${table}: the previous release still uses the old name — add the new one beside it instead`);
      }
      return out;
    }
    if (/^SET SCHEMA\b/i.test(rest)) {
      out.push(`SET SCHEMA on ${table}: moves the table out from under the previous release`);
      return out;
    }
    for (const action of splitTopLevel(rest)) {
      let m;
      if ((m = /^DROP CONSTRAINT (?:IF EXISTS )?(\w+)/i.exec(action))) {
        out.push(`DROP CONSTRAINT ${m[1]} on ${table}: the previous release may rely on it (ON CONFLICT targets, the rows it guarantees)`);
      } else if ((m = /^DROP (?:COLUMN )?(?:IF EXISTS )?(\w+)/i.exec(action))) {
        if (!fresh.columns.has(`${table}.${m[1].toLowerCase()}`)) {
          out.push(`DROP COLUMN ${table}.${m[1]}: the previous release still reads it — drop it a release after the code stops`);
        }
      } else if (/^ALTER CONSTRAINT\b/i.test(action)) {
        out.push(`ALTER CONSTRAINT on ${table}: the previous release may rely on how it behaves`);
      } else if ((m = /^ALTER (?:COLUMN )?(\w+) (.*)$/i.exec(action))) {
        const col = m[1].toLowerCase();
        const what = m[2];
        const key = `${table}.${col}`;
        if (/^(SET DATA )?TYPE\b/i.test(what)) {
          if (!fresh.columns.has(key)) out.push(`ALTER COLUMN ${key} TYPE: the previous release reads and writes the old type — add a new column instead`);
        } else if (/^SET NOT NULL\b/i.test(what)) {
          if (!defaults.has(key)) out.push(`SET NOT NULL on ${key} with no DEFAULT: the previous release inserts rows without it — SET DEFAULT in the same migration`);
        } else if (/^DROP DEFAULT\b/i.test(what)) {
          out.push(`DROP DEFAULT on ${key}: the previous release inserts rows that rely on it`);
        }
      } else if ((m = /^ADD (?:COLUMN )?(?:IF NOT EXISTS )?(\w+) (.*)$/i.exec(action))) {
        if (/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)$/i.test(m[1])) continue;
        const def = topLevel(m[2]);
        const notNull = /\bNOT NULL\b/i.test(def) || /\bPRIMARY KEY\b/i.test(def);
        const filled = /\bDEFAULT\b/i.test(def) || /\bGENERATED\b/i.test(def) || /^(SMALL|BIG)?SERIAL\d?\b/i.test(def.trim());
        if (notNull && !filled) {
          out.push(`ADD COLUMN ${table}.${m[1]} NOT NULL with no DEFAULT: the previous release inserts rows without it`);
        }
      }
    }
  }
  return out;
}

/** The `-- migration-guard: contract <reason>` above a statement, if any. */
function optOut(lines, startLine) {
  for (let k = startLine - 2; k >= 0; k--) {
    const line = lines[k].trim();
    if (!line.startsWith("--")) break;
    const m = OPT_OUT_RE.exec(line);
    if (m) return { reason: m[1].replace(/^[\s:—–-]+/, "").trim(), line: k + 1 };
  }
  return null;
}

/**
 * Check one migration's SQL. Returns { refused, contracts, warnings }, each a
 * list of { line, message } (contracts also carry `reason`).
 */
export function checkMigration(sql, { fresh } = {}) {
  const statements = splitStatements(sql);
  fresh ??= created(statements);
  const defaults = new Set();
  for (const st of statements) {
    const a = ALTER_TABLE_RE.exec(normalise(st.text));
    if (!a) continue;
    for (const action of splitTopLevel(a[2])) {
      const d = /^ALTER (?:COLUMN )?(\w+) SET DEFAULT\b/i.exec(action);
      if (d) defaults.add(`${unqualify(a[1])}.${d[1].toLowerCase()}`);
    }
  }
  const lines = sql.split("\n");
  const refused = [];
  const contracts = [];
  const warnings = [];
  const used = new Set();
  for (const st of statements) {
    const found = refusals(st.text, { defaults, fresh });
    const opt = optOut(lines, st.line);
    if (opt) used.add(opt.line);
    if (found.length === 0) continue;
    if (opt && opt.reason) {
      for (const message of found) contracts.push({ line: st.line, message, reason: opt.reason });
    } else if (opt) {
      for (const message of found) refused.push({ line: st.line, message: `${message} (the contract opt-out on line ${opt.line} needs a reason)` });
    } else {
      for (const message of found) refused.push({ line: st.line, message });
    }
  }
  lines.forEach((l, k) => {
    if (OPT_OUT_RE.test(l.trim()) && !used.has(k + 1)) {
      warnings.push({ line: k + 1, message: "migration-guard opt-out is not directly above a statement — it covers nothing" });
    }
  });
  for (const st of statements) {
    const opt = optOut(lines, st.line);
    if (opt && refusals(st.text, { defaults, fresh }).length === 0) {
      warnings.push({ line: opt.line, message: "migration-guard opt-out on a statement the guard does not refuse" });
    }
  }
  return { refused, contracts, warnings };
}

// ----------------------------------------------------------------------- git

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryGit(args, cwd) {
  try { return git(args, cwd); } catch { return null; }
}

const isZero = (ref) => !ref || /^0+$/.test(ref);

/** The platform commit (or, with key "admin", foldrun-admin's — its hosted
 *  migrations, 30 Oct 2026) of the newest box version tag in ../foldrun-infra. */
export function deployedPlatformSha(infraDir, key = "platform") {
  if (!fs.existsSync(path.join(infraDir, ".git"))) return null;
  const tag = tryGit(["tag", "-l", "v*", "--sort=-creatordate"], infraDir)?.split("\n")[0];
  if (!tag) return null;
  const msg = tryGit(["tag", "-l", "--format=%(contents)", tag], infraDir) ?? "";
  const sha = new RegExp(`^${key}=([0-9a-f]{7,40})$`, "m").exec(msg)?.[1];
  return sha ? { sha, tag } : null;
}

export function resolveBase(repo, explicit, key = "platform") {
  const has = (ref) => tryGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repo) !== null;
  if (!isZero(explicit)) {
    if (!has(explicit)) throw new Error(`base ${explicit} (from --base) is not a commit here — fetch more history (fetch-depth: 0)`);
    return { ref: explicit, why: "--base" };
  }
  // CI passes the commit the push or pull request started from. After a
  // force push that commit may be gone; the fallbacks below still apply.
  const env = process.env.MIGRATION_GUARD_BASE;
  if (!isZero(env)) {
    if (has(env)) return { ref: env, why: "$MIGRATION_GUARD_BASE" };
    console.log(`migration-guard: $MIGRATION_GUARD_BASE ${env} is not a commit here; falling back`);
  }
  const deployed = deployedPlatformSha(path.join(repo, "..", "foldrun-infra"), key);
  if (deployed) {
    if (!has(deployed.sha)) tryGit(["fetch", "--quiet", "origin", deployed.sha], repo);
    if (has(deployed.sha)) return { ref: deployed.sha, why: `${key} at box version ${deployed.tag}` };
  }
  if (has("origin/main")) {
    const head = git(["rev-parse", "HEAD"], repo);
    const main = git(["rev-parse", "origin/main"], repo);
    if (head !== main) {
      const mb = tryGit(["merge-base", "HEAD", "origin/main"], repo);
      if (mb) return { ref: mb, why: "merge base with origin/main" };
    }
    if (has("origin/main~1")) return { ref: "origin/main~1", why: "origin/main~1" };
  }
  // The repository's first commit (foldrun-platform went public with fresh
  // history on 25 Oct 2026): nothing was released before it here. The box
  // deploy's guard still checks it against the LIVE release, which it fetches
  // from foldrun-platform-history.
  // Only a real root: a shallow clone hides parents that exist, and must
  // fetch them rather than pass unchecked.
  // Both answers must come from git: a failed query is not a root.
  const shallowOut = tryGit(["rev-parse", "--is-shallow-repository"], repo);
  const line = tryGit(["rev-list", "--parents", "-n", "1", "HEAD"], repo);
  if (shallowOut === "true") throw new Error("no base, and this clone is shallow: fetch its history (fetch-depth: 0) or pass --base <ref>");
  if (shallowOut === "false" && line && /^[0-9a-f]{40}$/.test(line.trim())) return { ref: null, why: "this repository's first commit" };
  throw new Error("no base: pass --base <ref> (no ../foldrun-infra tags and no origin/main here)");
}

/** Migrations added since base (and in the working tree), and released ones changed. */
export function changedSince(repo, base, dir = "drizzle") {
  const added = new Set();
  const touched = [];
  const out = git(["diff", "--name-status", "--no-renames", base, "--", dir], repo);
  for (const line of out.split("\n").filter(Boolean)) {
    const [status, file] = line.split("\t");
    if (!MIGRATION_RE.test(path.basename(file)) || path.dirname(file) !== dir) continue;
    if (status === "A") added.add(file);
    else touched.push({ file, status: status === "D" ? "deleted" : "edited" });
  }
  const untracked = git(["ls-files", "--others", "--exclude-standard", "--", dir], repo);
  for (const file of untracked.split("\n").filter(Boolean)) {
    if (MIGRATION_RE.test(path.basename(file)) && path.dirname(file) === dir) added.add(file);
  }
  return { added: [...added].sort(), touched };
}

// ----------------------------------------------------------------------- cli

/** Check a list of migration files together (what one create, another may alter). */
export function checkFiles(files, { together = true, read = (f) => fs.readFileSync(f, "utf8") } = {}) {
  const texts = files.map((f) => ({ file: f, sql: read(f) }));
  const fresh = together ? created(texts.flatMap((t) => splitStatements(t.sql))) : undefined;
  return texts.map((t) => ({ file: t.file, ...checkMigration(t.sql, { fresh }) }));
}

function main(argv) {
  const args = argv.slice(2);
  let base;
  let all = false;
  let dir = "drizzle";
  let key = "platform";
  const files = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "--base") base = args[++k];
    else if (a.startsWith("--base=")) base = a.slice(7);
    else if (a === "--all") all = true;
    else if (a === "--dir") dir = args[++k];
    else if (a === "--tag-key") key = args[++k];
    else if (a === "-h" || a === "--help") {
      console.log("usage: node scripts/migration-guard.mjs [--base <ref>] [--all] [--dir drizzle] [--tag-key platform|admin] [file.sql …]");
      return 0;
    } else files.push(a);
  }
  const repo = tryGit(["rev-parse", "--show-toplevel"], process.cwd()) ?? process.cwd();

  let targets = files;
  let touched = [];
  if (targets.length === 0 && all) {
    targets = fs.readdirSync(path.join(repo, dir)).filter((f) => MIGRATION_RE.test(f)).sort().map((f) => path.join(dir, f));
    console.log(`migration-guard: every migration in ${dir}/ (${targets.length})`);
  } else if (targets.length === 0) {
    if (!/^[a-z]+$/.test(key)) throw new Error(`--tag-key ${key}: a version tag's part name (platform, admin)`);
    const b = resolveBase(repo, base, key);
    if (b.ref === null) {
      console.log(`migration-guard: no base (${b.why}) — nothing was released before it in this repository; the deploy checks it against the live release`);
    } else {
      const c = changedSince(repo, b.ref, dir);
      targets = c.added;
      touched = c.touched;
      console.log(`migration-guard: base ${b.ref.slice(0, 12)} (${b.why}); ${targets.length} new migration(s)`);
    }
  }

  let failed = 0;
  for (const t of touched) {
    failed++;
    console.log(`REFUSED ${t.file}: ${t.status} after it was released — databases already ran it; write a new migration instead`);
  }
  // --all reads each file alone: together, the baseline's tables would count
  // as new and exempt everything after it.
  const results = checkFiles(targets.map((f) => (path.isAbsolute(f) ? f : path.join(repo, f))), { together: !all });
  for (const r of results) {
    const rel = path.relative(repo, r.file);
    for (const x of r.refused) { failed++; console.log(`REFUSED ${rel}:${x.line}: ${x.message}`); }
    for (const x of r.contracts) console.log(`contract ${rel}:${x.line}: ${x.message} — allowed: ${x.reason}`);
    for (const x of r.warnings) console.log(`warning ${rel}:${x.line}: ${x.message}`);
    if (r.refused.length === 0) console.log(`ok      ${rel}`);
  }
  if (failed) {
    console.log(
      `\n${failed} refusal(s). A rollback runs the previous release's code on this schema, so every migration must ` +
        "be backward compatible with it (expand/contract). Split the change across releases, or mark a deliberate " +
        "contract step with `-- migration-guard: contract <reason>` on the line above the statement.",
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  try {
    process.exitCode = main(process.argv);
  } catch (err) {
    console.error(`migration-guard: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 2;
  }
}
