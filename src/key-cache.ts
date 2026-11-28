// API keys, looked up once per pod and not once per call (FOL-476, plan:
// foldrun-infra docs/database-scaling-plan.md §3). The gateway had this since
// 10 Nov 2026; the dashboard's funnel now takes the same one, so a key the pod
// knows costs no statement.
//
// A revocation, expiry, grant or require-customer change anywhere drops that
// key here at once (api-keys-db.ts announces it on API_KEY_CHANNEL, 12 Nov
// 2026); KEY_CACHE_MS stays as the safety net for a missed notice, and an
// expiry is checked by the caller on every call against the cached record.
// An unknown hash is cached too, so a flood of bad keys cannot reach the
// database. "Last used" is written in batches, one statement for every key
// that authenticated since the last one.

import { opsError } from "../../foldrun-core/src/ops-log.ts";
import { API_KEY_CHANNEL, findApiKeyByHashDb, touchApiKeysDb } from "./api-keys-db.ts";
import { listen } from "./pg-listen.ts";

type Lookup = (hash: string) => Promise<Awaited<ReturnType<typeof findApiKeyByHashDb>>>;
type KeyRecord = Awaited<ReturnType<typeof findApiKeyByHashDb>>;

const KEY_CACHE_MS = 10_000;
const KEY_CACHE_MAX = 10_000;
/** While Postgres is not answering, a key read in the last KEY_STALE_MS is
 *  still honoured (10 Nov 2026: a minute's outage on dev turned every call
 *  into a 500). A revocation cannot be read while the database is down
 *  anyway; one made before the outage is in any record read after it, so
 *  the window is a key left unused since then — at most KEY_STALE_MS. */
const KEY_STALE_MS = 120_000;

/** Postgres is not answering — refused, reset or ended connections, a
 *  server starting up, shutting down or out of connections — as opposed to
 *  a query that is wrong. Drizzle wraps the driver's error in `cause`. */
export function databaseDown(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== "object" || depth > 4) return false;
  const e = err as { code?: unknown; message?: unknown; cause?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "EPIPE", "57P01", "57P02", "57P03", "53300", "08000", "08001", "08003", "08006"].includes(code)) return true;
  const m = typeof e.message === "string" ? e.message : "";
  if (/Connection terminated|connection timeout|timeout exceeded when trying to connect|the database system is (starting up|shutting down)|Client has encountered a connection error|terminating connection due to administrator command/i.test(m)) return true;
  return databaseDown(e.cause, depth + 1);
}

const keyCache = new Map<string, { at: number; record: KeyRecord }>();
// Each time LISTEN comes into effect (the first time too) everything cached
// is dropped: what changed before then went unheard. `keyGen` moves on every
// drop, so a lookup that was already reading when a drop happened does not
// put its older answer back (a read sees the database as of its start).
let keyListen = false;
let keyGen = 0;
function listenForKeyChanges(): void {
  if (keyListen) return;
  keyListen = true;
  listen(
    API_KEY_CHANNEL,
    (id) => {
      keyGen++;
      for (const [hash, v] of keyCache) if (v.record?.id === id) keyCache.delete(hash);
    },
    {
      up: () => {
        keyGen++;
        keyCache.clear();
      },
    },
  );
}

let lookup: Lookup = (h) => findApiKeyByHashDb(h);
let lookupReplaced = false;

/** The key with this hash — revoked or not; the caller says which. From this
 *  pod's memory when it was read in the last KEY_CACHE_MS and no change was
 *  announced since. */
export async function cachedKeyByHash(hash: string, now = Date.now()): Promise<KeyRecord> {
  if (!lookupReplaced) listenForKeyChanges();
  const hit = keyCache.get(hash);
  if (hit && now - hit.at < KEY_CACHE_MS) return hit.record;
  let record: KeyRecord;
  let gen = keyGen;
  try {
    record = await lookup(hash);
    // A change was announced while we read: read again, from after it.
    if (keyGen !== gen) {
      gen = keyGen;
      record = await lookup(hash);
    }
  } catch (err) {
    // The last record read, while the database is down and it is recent.
    if (hit && now - hit.at < KEY_STALE_MS && databaseDown(err)) return hit.record;
    throw err;
  }
  // Still racing a stream of changes: answer, but do not keep it.
  if (keyGen !== gen) return record;
  if (keyCache.size >= KEY_CACHE_MAX) keyCache.clear();
  keyCache.set(hash, { at: now, record });
  return record;
}

/** For tests: forget every cached key. */
export function resetKeyCacheForTests(): void {
  keyCache.clear();
}

/** True while a test has put its own lookup in place of the table. */
export const keyLookupReplaced = (): boolean => lookupReplaced;

/** For tests: where a key is looked up (null: the table). */
export function setKeyLookupForTests(fn: Lookup | null): void {
  lookup = fn ?? ((h) => findApiKeyByHashDb(h));
  lookupReplaced = fn !== null;
  keyCache.clear();
}

// ------------------------------------------------------------ last used

/** "Last used" is written at most once a minute per key, and the writes of
 *  every key in a window go out as one statement. The address is the
 *  caller's: the gateway sits behind Cloudflare and nginx and passes the one
 *  already on the record. */
const TOUCH_EVERY_MS = 60_000;
export const TOUCH_FLUSH_MS = 10_000;
const touched = new Map<string, number>();
const queued = new Map<string, { at: Date; ip: string | null }>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let touchWrite: (rows: { id: string; at: Date; ip: string | null }[]) => Promise<void> = (rows) => touchApiKeysDb(rows);

/** Write what is queued, in one statement. Best-effort: a failed write must
 *  never fail the request it was describing, and costs only a "last used". */
export async function flushKeyTouches(): Promise<number> {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (!queued.size) return 0;
  const rows = [...queued].map(([id, v]) => ({ id, ...v }));
  queued.clear();
  try {
    await touchWrite(rows);
    return rows.length;
  } catch (err) {
    opsError("keys.last_use_not_recorded", err);
    return 0;
  }
}

/** Note that a key authenticated: queued, and written with the others. */
export function noteKeyTouch(record: { id: string; lastUsedAt?: string | null; lastIp?: string | null }, ip: string | null, now = Date.now()): void {
  const last = touched.get(record.id) ?? (record.lastUsedAt ? Date.parse(record.lastUsedAt) : 0);
  if (now - last < TOUCH_EVERY_MS) return;
  touched.set(record.id, now);
  if (touched.size > 10_000) touched.clear();
  queued.set(record.id, { at: new Date(now), ip: ip ?? record.lastIp ?? null });
  if (!flushTimer) {
    flushTimer = setTimeout(() => void flushKeyTouches(), TOUCH_FLUSH_MS);
    flushTimer.unref?.();
  }
}

/** For tests: where the batch is written (null: the table), and forget the
 *  once-a-minute memory and anything queued. */
export function setKeyTouchForTests(fn: typeof touchWrite | null): void {
  touchWrite = fn ?? ((rows) => touchApiKeysDb(rows));
  touched.clear();
  queued.clear();
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
}
