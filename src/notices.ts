// "Already said this."
//
// The watchdog's memory of what it has warned about, so an alarm fires once
// per occurrence rather than once per tick: which budget mark a workspace
// was told about this window, which runs were reported past their sla:,
// what each account's provider check found and which failures were
// announced. Platform bookkeeping about a customer, kept for them, never
// theirs to edit — so not in their tree.
//
// One row per (account, kind, scope) in the database; data/watchdog.json,
// unchanged, on an install without one.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { databaseEnabled, ormRequired, tx } from "./db.ts";
import { notices } from "./schema.ts";

export type NoticeKind = "budget" | "sla" | "provider" | "security" | "rescan-attempt" | "issue" | "alert" | "hosts" | "otel" | "eval-run" | "eval-compare" | "proposal" | "inbox";

interface WatchdogFile {
  budget?: Record<string, { month: string; mark: number }>;
  sla?: Record<string, number>;
  providers?: Record<string, unknown>;
  /** The daily security rescan, `${tenant}/${workspace}` (FOL-58). */
  security?: Record<string, unknown>;
  /** When the rescan last started on `${tenant}/${workspace}`, so one that
   *  never finished (the process died) is not retried at once. */
  "rescan-attempt"?: Record<string, unknown>;
  /** What people did to each issue, `${tenant}/${issueId}` (FOL-54). */
  issue?: Record<string, unknown>;
  /** When each `alerts:` rule last told notify:, `${tenant}/${ws}/${key}` (FOL-72). */
  alert?: Record<string, unknown>;
  /** The sites each agent has reached, `${tenant}/${ws}/${agent}` (alerts: new_host). */
  hosts?: Record<string, unknown>;
  /** Runs whose trace has gone to the collector, `${tenant}/${ws}/${runId}` (telemetry:). */
  otel?: Record<string, unknown>;
  /** An async eval run's claim and beat, `${tenant}/${ws}/${eval}` (foldrun-web server/eval-runs.ts). */
  "eval-run"?: Record<string, unknown>;
  /** A model comparison's claim and beat, `${tenant}/${ws}/${eval}` (the same file, another lane). */
  "eval-compare"?: Record<string, unknown>;
  /** A proposed fix and what became of it, `${tenant}/${ws}/${id}` (improve.ts). */
  proposal?: Record<string, unknown>;
  /** What one person has read or set aside in their inbox, `${tenant}/${person}` (foldrun-web server/inbox.ts). */
  inbox?: Record<string, unknown>;
}

const file = () => path.join(dataRoot(), "watchdog.json");

function readFile(): WatchdogFile {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8")) as WatchdogFile;
  } catch {
    return {};
  }
}

function writeFile(state: WatchdogFile) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = `${file()}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file());
}

/** The file keys each kind used: budget `${tenant}/${workspace}` (or
 *  `${tenant}/` for the account), sla `${tenant}/${workspace}/${runId}`,
 *  providers `${tenant}`. `scope` is the part after the tenant. */
function fileKey(tenant: string, kind: NoticeKind, scope: string): string {
  return kind === "provider" ? tenant : `${tenant}/${scope}`;
}
const section = (kind: NoticeKind) => (kind === "provider" ? "providers" : kind);

export async function getNotice<T>(tenant: string, kind: NoticeKind, scope: string): Promise<{ payload: T; at: number } | null> {
  if (!databaseEnabled()) {
    const s = readFile();
    const v = (s[section(kind)] as Record<string, unknown> | undefined)?.[fileKey(tenant, kind, scope)];
    if (v === undefined) return null;
    // The file kept the sla as a bare timestamp and the rest as objects.
    return kind === "sla" ? { payload: v as T, at: v as number } : { payload: v as T, at: 0 };
  }
  const [r] = await ormRequired()
    .select({ payload: notices.payload, at: notices.at })
    .from(notices)
    .where(and(eq(notices.tenant, tenant), eq(notices.kind, kind), eq(notices.scope, scope)));
  return r ? { payload: r.payload as T, at: r.at.getTime() } : null;
}

export async function setNotice(tenant: string, kind: NoticeKind, scope: string, payload: unknown, at = Date.now()): Promise<void> {
  if (!databaseEnabled()) {
    const s = readFile();
    const sec = ((s as Record<string, unknown>)[section(kind)] ??= {}) as Record<string, unknown>;
    sec[fileKey(tenant, kind, scope)] = payload;
    writeFile(s);
    return;
  }
  await ormRequired()
    .insert(notices)
    .values({ tenant, kind, scope, payload: payload as object, at: new Date(at) })
    .onConflictDoUpdate({ target: [notices.tenant, notices.kind, notices.scope], set: { payload: payload as object, at: new Date(at) } });
}

const fileLocks = new Map<string, Promise<unknown>>();

/**
 * Read, change and write one notice as one step: two callers changing the
 * same notice at once are applied one after the other, never one over the
 * other (an advisory lock on the row's key with a database, which holds
 * across pods; a per-key queue on the file, which is one process's).
 * `fn` may throw to refuse; nothing is written then.
 */
export async function updateNotice<T>(tenant: string, kind: NoticeKind, scope: string, fn: (prev: T | null) => T, at = Date.now()): Promise<T> {
  if (!databaseEnabled()) {
    const key = `${kind}\u0000${tenant}\u0000${scope}`;
    const run = (fileLocks.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const next = fn((await getNotice<T>(tenant, kind, scope))?.payload ?? null);
      await setNotice(tenant, kind, scope, next, at);
      return next;
    });
    fileLocks.set(key, run);
    try {
      return await run;
    } finally {
      if (fileLocks.get(key) === run) fileLocks.delete(key);
    }
  }
  return tx(async (t) => {
    // JSON for the key: Postgres text cannot hold a NUL (Codex review).
    await t.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${JSON.stringify(["notice", tenant, kind, scope])}))`);
    const [r] = await t
      .select({ payload: notices.payload })
      .from(notices)
      .where(and(eq(notices.tenant, tenant), eq(notices.kind, kind), eq(notices.scope, scope)));
    const next = fn(r ? (r.payload as T) : null);
    await t
      .insert(notices)
      .values({ tenant, kind, scope, payload: next as object, at: new Date(at) })
      .onConflictDoUpdate({ target: [notices.tenant, notices.kind, notices.scope], set: { payload: next as object, at: new Date(at) } });
    return next;
  });
}

/** Every notice of one kind in one account, with its scope. */
export async function listNotices<T>(tenant: string, kind: NoticeKind): Promise<{ scope: string; payload: T; at: number }[]> {
  if (!databaseEnabled()) {
    const sec = (readFile()[section(kind) as keyof WatchdogFile] ?? {}) as Record<string, unknown>;
    if (kind === "provider") return sec[tenant] === undefined ? [] : [{ scope: "", payload: sec[tenant] as T, at: 0 }];
    const prefix = `${tenant}/`;
    return Object.entries(sec)
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, v]) => ({ scope: k.slice(prefix.length), payload: v as T, at: typeof v === "number" ? v : 0 }));
  }
  const rows = await ormRequired()
    .select({ scope: notices.scope, payload: notices.payload, at: notices.at })
    .from(notices)
    .where(and(eq(notices.tenant, tenant), eq(notices.kind, kind)));
  return rows.map((r) => ({ scope: r.scope, payload: r.payload as T, at: r.at.getTime() }));
}

/** Forget notices of one kind older than `before` — the sla list must not
 *  grow with every slow run there has ever been. */
export async function pruneNotices(kind: NoticeKind, before: number): Promise<void> {
  if (!databaseEnabled()) {
    const s = readFile();
    const sec = s[section(kind)] as Record<string, unknown> | undefined;
    if (!sec) return;
    for (const [k, v] of Object.entries(sec)) {
      // A bare time (sla), or a payload that carries one (alert: { at }).
      const at = typeof v === "number" ? v : typeof (v as { at?: unknown })?.at === "number" ? (v as { at: number }).at : 0;
      if (at && at < before) delete sec[k];
    }
    writeFile(s);
    return;
  }
  await ormRequired().delete(notices).where(and(eq(notices.kind, kind), lt(notices.at, new Date(before))));
}

/** For tests: nothing remembered. */
export async function resetNotices(): Promise<void> {
  try {
    fs.rmSync(file(), { force: true });
  } catch {
    /* nothing to clear */
  }
  if (databaseEnabled()) await ormRequired().delete(notices);
}

/** watchdog.json into rows, once. Rows already there are kept. */
export async function importWatchdogFile(): Promise<number> {
  if (!databaseEnabled() || !fs.existsSync(file())) return 0;
  const s = readFile();
  let n = 0;
  const put = async (tenant: string, kind: NoticeKind, scope: string, payload: unknown, at: number) => {
    await ormRequired().insert(notices).values({ tenant, kind, scope, payload: payload as object, at: new Date(at) }).onConflictDoNothing();
    n++;
  };
  for (const [key, v] of Object.entries(s.budget ?? {})) {
    const i = key.indexOf("/");
    if (i < 0) continue;
    await put(key.slice(0, i), "budget", key.slice(i + 1), v, Date.now());
  }
  for (const [key, at] of Object.entries(s.sla ?? {})) {
    const i = key.indexOf("/");
    if (i < 0) continue;
    await put(key.slice(0, i), "sla", key.slice(i + 1), at, at);
  }
  for (const [tenant, v] of Object.entries(s.providers ?? {})) {
    const at = (v as { checkedAt?: number }).checkedAt ?? Date.now();
    await put(tenant, "provider", "", v, at);
  }
  for (const [key, v] of Object.entries(s.security ?? {})) {
    const i = key.indexOf("/");
    if (i < 0) continue;
    await put(key.slice(0, i), "security", key.slice(i + 1), v, (v as { checkedAt?: number }).checkedAt ?? Date.now());
  }
  for (const [key, v] of Object.entries(s.issue ?? {})) {
    const i = key.indexOf("/");
    if (i < 0) continue;
    await put(key.slice(0, i), "issue", key.slice(i + 1), v, Date.now());
  }
  // The sites each agent has reached (alerts: new_host): lost, every agent's
  // next run would quietly become a new baseline (Codex review).
  for (const [key, v] of Object.entries(s.hosts ?? {})) {
    const i = key.indexOf("/");
    if (i < 0) continue;
    await put(key.slice(0, i), "hosts", key.slice(i + 1), v, Date.now());
  }
  // Runs whose trace already went out: lost, the sweep would send them again.
  for (const [key, v] of Object.entries(s.otel ?? {})) {
    const i = key.indexOf("/");
    if (i < 0) continue;
    await put(key.slice(0, i), "otel", key.slice(i + 1), v, (v as { at?: number }).at ?? Date.now());
  }
  // Proposed fixes (and the failures they covered) and each person's inbox
  // marks: lost, old failures would be proposed for again and every inbox
  // would come back unread. Leases (eval-run, eval-compare) are not kept —
  // a running eval does not survive the restart a migration is.
  for (const kind of ["proposal", "inbox"] as const) {
    for (const [key, v] of Object.entries((s[kind] ?? {}) as Record<string, unknown>)) {
      const i = key.indexOf("/");
      if (i < 0 || v === null) continue;
      await put(key.slice(0, i), kind, key.slice(i + 1), v, Date.now());
    }
  }
  fs.renameSync(file(), `${file()}.imported-${new Date().toISOString().slice(0, 10)}`);
  return n;
}

export async function deleteNotices(tenant: string): Promise<number> {
  if (!databaseEnabled()) return 0;
  return (await ormRequired().delete(notices).where(eq(notices.tenant, tenant)).returning({ kind: notices.kind })).length;
}
