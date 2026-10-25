// How each account meets the dated API: which versions answer its requests,
// and who in it still calls a route on its way out.
//
// A sunset is only safe when the people it would break have heard about it,
// and they can only be told if someone knows they call it. So every
// authenticated /api request is counted — per account, per UTC day, by the
// version that answered it — and a request to a deprecated route is also
// counted by the route and the credential that made it ("key "ci" (fr_ab12…)"),
// so the owner learns which key or script to move.
//
// A request must not wait on a database for a counter. Each web pod adds up
// in memory and writes the sums about once a minute (an upsert that adds to
// what other pods wrote); a read flushes this pod first. A pod that dies
// loses at most its last minute — this is a gauge, not the ledger.
//
// Postgres when the install has one; otherwise <data>/.api-usage.json, the
// same rows. Rows older than USAGE_KEEP_DAYS are dropped by the hourly pass.
//
// The warnings themselves are the web's (server/api-deprecations.ts): it owns
// the list of deprecated routes. This file keeps what it needs — who called a
// route lately, and which warning each account has had.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { databaseEnabled, ormRequired } from "./db.ts";
import { apiDeprecationNotices, apiUsage } from "./schema.ts";

/** How long the daily rows are kept. */
export const USAGE_KEEP_DAYS = 90;
/** How often a pod writes what it counted. */
export const USAGE_FLUSH_MS = 60_000;

export interface UsageRow {
  tenant: string;
  day: string;
  version: string;
  route: string;
  credential: string;
  requests: number;
  lastSeen: string;
}

export interface AccountUsage {
  days: number;
  /** Every version that answered this account's requests, most used first. */
  versions: { version: string; requests: number; lastSeen: string }[];
  /** Deprecated routes this account called, with who called them. */
  deprecated: { route: string; requests: number; lastSeen: string; callers: { credential: string; requests: number; lastSeen: string }[] }[];
}

const dayOf = (at: Date) => at.toISOString().slice(0, 10);
const keyOf = (r: Pick<UsageRow, "tenant" | "day" | "version" | "route" | "credential">) => JSON.stringify([r.tenant, r.day, r.version, r.route, r.credential]);

// ------------------------------------------------------------- counting

const pending = new Map<string, UsageRow>();
let timer: NodeJS.Timeout | null = null;

/**
 * Count one request. Never throws, never waits: the sums go out on the next
 * flush. `route` and `credential` only for a deprecated route.
 */
export function recordApiCall(call: { tenant: string; version: string; route?: string; credential?: string; at?: Date }): void {
  try {
    const at = call.at ?? new Date();
    const row = { tenant: call.tenant, day: dayOf(at), version: call.version, route: call.route ?? "", credential: call.route ? (call.credential ?? "") : "" };
    const k = keyOf(row);
    const have = pending.get(k);
    if (have) {
      have.requests++;
      if (at.toISOString() > have.lastSeen) have.lastSeen = at.toISOString();
    } else pending.set(k, { ...row, requests: 1, lastSeen: at.toISOString() });
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        void flushApiUsage().catch((err) => console.error("[api-usage] flush failed:", err));
      }, USAGE_FLUSH_MS);
      timer.unref?.();
    }
  } catch {
    // a counter never fails a request
  }
}

/** Write what this pod counted. Returns how many rows it added to. A failed
 *  write puts the sums back, so the next flush tries again. */
export async function flushApiUsage(): Promise<number> {
  if (!pending.size) return 0;
  const rows = [...pending.values()];
  pending.clear();
  try {
    if (databaseEnabled()) {
      const db = ormRequired();
      for (const r of rows) {
        await db
          .insert(apiUsage)
          .values({ ...r, lastSeen: new Date(r.lastSeen) })
          .onConflictDoUpdate({
            target: [apiUsage.tenant, apiUsage.day, apiUsage.version, apiUsage.route, apiUsage.credential],
            set: { requests: sql`${apiUsage.requests} + ${r.requests}`, lastSeen: sql`GREATEST(${apiUsage.lastSeen}, ${new Date(r.lastSeen)})` },
          });
      }
    } else {
      const all = new Map(readFileRows().map((r) => [keyOf(r), r]));
      for (const r of rows) {
        const have = all.get(keyOf(r));
        if (have) {
          have.requests += r.requests;
          if (r.lastSeen > have.lastSeen) have.lastSeen = r.lastSeen;
        } else all.set(keyOf(r), { ...r });
      }
      writeFileRows([...all.values()]);
    }
    return rows.length;
  } catch (err) {
    for (const r of rows) {
      const have = pending.get(keyOf(r));
      if (have) have.requests += r.requests;
      else pending.set(keyOf(r), r);
    }
    throw err;
  }
}

// ------------------------------------------------------------- reading

/** The rows since `days` ago (UTC days, today included), this pod's unwritten
 *  counts written first. One account, or every account. */
async function rowsSince(days: number, filter: { tenant?: string; route?: string } = {}, now = new Date()): Promise<UsageRow[]> {
  await flushApiUsage().catch((err) => console.error("[api-usage] flush failed:", err));
  const from = dayOf(new Date(now.getTime() - (days - 1) * 86_400_000));
  if (databaseEnabled()) {
    const conds = [gte(apiUsage.day, from)];
    if (filter.tenant) conds.push(eq(apiUsage.tenant, filter.tenant));
    if (filter.route) conds.push(eq(apiUsage.route, filter.route));
    const rows = await ormRequired().select().from(apiUsage).where(and(...conds));
    return rows.map((r) => ({ ...r, lastSeen: r.lastSeen.toISOString() }));
  }
  return readFileRows().filter((r) => r.day >= from && (!filter.tenant || r.tenant === filter.tenant) && (!filter.route || r.route === filter.route));
}

const newest = (a: string, b: string) => (a > b ? a : b);

/** What Settings → API, GET /api/account/api and `foldrun api version` show. */
export async function apiUsageFor(tenant: string, days = 30, now = new Date()): Promise<AccountUsage> {
  const rows = await rowsSince(days, { tenant }, now);
  const versions = new Map<string, { version: string; requests: number; lastSeen: string }>();
  const routes = new Map<string, AccountUsage["deprecated"][number]>();
  for (const r of rows) {
    const v = versions.get(r.version) ?? { version: r.version, requests: 0, lastSeen: r.lastSeen };
    v.requests += r.requests;
    v.lastSeen = newest(v.lastSeen, r.lastSeen);
    versions.set(r.version, v);
    if (!r.route) continue;
    const d = routes.get(r.route) ?? { route: r.route, requests: 0, lastSeen: r.lastSeen, callers: [] };
    d.requests += r.requests;
    d.lastSeen = newest(d.lastSeen, r.lastSeen);
    const c = d.callers.find((x) => x.credential === r.credential);
    if (c) {
      c.requests += r.requests;
      c.lastSeen = newest(c.lastSeen, r.lastSeen);
    } else d.callers.push({ credential: r.credential, requests: r.requests, lastSeen: r.lastSeen });
    routes.set(r.route, d);
  }
  const byUse = <T extends { requests: number }>(a: T, b: T) => b.requests - a.requests;
  return {
    days,
    versions: [...versions.values()].sort(byUse),
    deprecated: [...routes.values()].sort(byUse).map((d) => ({ ...d, callers: d.callers.sort(byUse) })),
  };
}

/** Accounts that called a deprecated route in the last `days`, with who. */
export async function callersOf(route: string, days = 30, now = new Date()): Promise<Map<string, AccountUsage["deprecated"][number]>> {
  const out = new Map<string, AccountUsage["deprecated"][number]>();
  for (const r of await rowsSince(days, { route }, now)) {
    const d = out.get(r.tenant) ?? { route, requests: 0, lastSeen: r.lastSeen, callers: [] };
    d.requests += r.requests;
    d.lastSeen = newest(d.lastSeen, r.lastSeen);
    const c = d.callers.find((x) => x.credential === r.credential);
    if (c) c.requests += r.requests;
    else d.callers.push({ credential: r.credential, requests: r.requests, lastSeen: r.lastSeen });
    out.set(r.tenant, d);
  }
  return out;
}

/** Drop the rows older than the window. Returns how many. */
export async function pruneApiUsage(now = new Date(), keepDays = USAGE_KEEP_DAYS): Promise<number> {
  const before = dayOf(new Date(now.getTime() - keepDays * 86_400_000));
  if (databaseEnabled()) {
    const gone = await ormRequired().delete(apiUsage).where(lt(apiUsage.day, before)).returning({ day: apiUsage.day });
    return gone.length;
  }
  const rows = readFileRows();
  const kept = rows.filter((r) => r.day >= before);
  if (kept.length !== rows.length) writeFileRows(kept);
  return rows.length - kept.length;
}

// ------------------------------------------------------------- warnings sent

/** The steps of one route's warning this account has had. */
export async function noticesSent(tenant: string, route: string): Promise<Set<string>> {
  if (databaseEnabled()) {
    const rows = await ormRequired()
      .select({ step: apiDeprecationNotices.step })
      .from(apiDeprecationNotices)
      .where(and(eq(apiDeprecationNotices.tenant, tenant), eq(apiDeprecationNotices.route, route)));
    return new Set(rows.map((r) => r.step));
  }
  return new Set(readNoticeRows().filter((n) => n.tenant === tenant && n.route === route).map((n) => n.step));
}

/** Record steps as sent — after the mail went out, so an outage retries. */
export async function markNoticesSent(tenant: string, route: string, steps: string[], at = new Date()): Promise<void> {
  if (!steps.length) return;
  if (databaseEnabled()) {
    await ormRequired()
      .insert(apiDeprecationNotices)
      .values(steps.map((step) => ({ tenant, route, step, sentAt: at })))
      .onConflictDoNothing();
    return;
  }
  const rows = readNoticeRows();
  for (const step of steps) if (!rows.some((n) => n.tenant === tenant && n.route === route && n.step === step)) rows.push({ tenant, route, step, sentAt: at.toISOString() });
  writeJson(noticeFile(), rows);
}

/** An account's rows, for deleting the account (tenant-delete.ts). */
export async function deleteApiUsageFor(tenant: string): Promise<void> {
  pending.forEach((r, k) => r.tenant === tenant && pending.delete(k));
  if (databaseEnabled()) {
    await ormRequired().delete(apiUsage).where(eq(apiUsage.tenant, tenant));
    await ormRequired().delete(apiDeprecationNotices).where(eq(apiDeprecationNotices.tenant, tenant));
    return;
  }
  writeFileRows(readFileRows().filter((r) => r.tenant !== tenant));
  writeJson(noticeFile(), readNoticeRows().filter((n) => n.tenant !== tenant));
}

// ------------------------------------------------------------- the file store

const usageFile = () => path.join(dataRoot(), ".api-usage.json");
const noticeFile = () => path.join(dataRoot(), ".api-deprecation-notices.json");

function readJson<T>(file: string): T[] {
  try {
    const rows = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}
function writeJson(file: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(rows) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const readFileRows = () => readJson<UsageRow>(usageFile());
const writeFileRows = (rows: UsageRow[]) => writeJson(usageFile(), rows);
const readNoticeRows = () => readJson<{ tenant: string; route: string; step: string; sentAt: string }>(noticeFile());

/** For tests: forget what this pod counted and has not written. */
export function resetApiUsageForTests(): void {
  pending.clear();
  if (timer) clearTimeout(timer);
  timer = null;
}
