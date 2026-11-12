// Postgres LISTEN/NOTIFY for this process (12 Nov 2026): one connection of
// its own, outside the pool, that every copy of the platform holds, so a
// change written by one copy reaches the others at once instead of at their
// next poll or cache expiry. The design rule comes from cloudhost (revoked
// keys and sessions reach every copy by LISTEN/NOTIFY).
//
// A notification is a hint, never the truth: it can be missed while the
// connection is down, or before LISTEN took effect. So every subscriber
// keeps its own slower safety net (a poll, a TTL), and gives two hooks:
//
//   up    runs each time LISTEN on its channel is in effect — the first time
//         too. Anything it cached before this moment may have changed
//         unannounced: drop it, or look again.
//   down  runs when the connection is lost: fall back to polling now, not at
//         the end of whatever long wait trusted notifications.
//
//   const stop = listen("foldrun_run", (payload) => wake(payload), { up: wakeAll, down: wakeAll });
//   if (listening("foldrun_run")) …trust notifications, poll slowly… else …poll as before…
//
// Senders call pg_notify(channel, payload) inside the write's own statement
// or transaction; Postgres delivers it on commit, and not at all on rollback
// (https://www.postgresql.org/docs/current/sql-notify.html). Payloads stay
// short — ids or hashes, never records (the limit is under 8000 bytes).
//
// LISTEN needs a real session: it does not work through PgBouncer in
// transaction pooling (https://www.pgbouncer.org/features.html). Behind such
// a pooler set FOLDRUN_PG_LISTEN=off, and every caller simply polls.

import { Client } from "pg";
import { connectionConfig, databaseEnabled } from "./db.ts";

type Handler = (payload: string) => void;
export interface ListenHooks {
  up?: () => void;
  down?: () => void;
}
interface Sub extends ListenHooks {
  fn: Handler;
}

const subs = new Map<string, Set<Sub>>();
/** Channels whose LISTEN is in effect on the current connection. */
const subscribed = new Set<string>();
let client: Client | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let pingTimer: ReturnType<typeof setInterval> | undefined;
let backoffMs = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** A connection that died without telling us (a dropped network path) is
 *  found by this ping, not left trusted forever. */
const PING_MS = 30_000;
const PING_TIMEOUT_MS = 5_000;

/** Channel names are identifiers we choose; refuse anything else so a name is
 *  never interpolated into SQL unchecked. */
const CHANNEL = /^[a-z_][a-z0-9_]{0,62}$/;

const enabled = () => databaseEnabled() && process.env.FOLDRUN_PG_LISTEN !== "off";

function call(fn: (() => void) | undefined): void {
  if (!fn) return;
  try {
    fn();
  } catch {
    // one subscriber's fault is not the others'
  }
}

/** Is LISTEN in effect (on `channel`, or at all)? While false, callers poll
 *  as if notifications did not exist. */
export function listening(channel?: string): boolean {
  return client !== null && (channel ? subscribed.has(channel) : subscribed.size > 0);
}

/** Call `fn` with each notification's payload on `channel`. Returns the
 *  function that stops it. Without a database (or with FOLDRUN_PG_LISTEN=off)
 *  nothing ever arrives and `up` never runs. */
export function listen(channel: string, fn: Handler, hooks: ListenHooks = {}): () => void {
  if (!CHANNEL.test(channel)) throw new Error(`pg-listen: bad channel name ${JSON.stringify(channel)}`);
  const sub: Sub = { fn, ...hooks };
  let set = subs.get(channel);
  if (!set) subs.set(channel, (set = new Set()));
  set.add(sub);
  if (enabled()) {
    if (client && subscribed.has(channel)) {
      // Already in effect: this subscriber's own "up" is now.
      call(sub.up);
    } else if (client && subscribed.size > 0) {
      // Connected, but not to this channel yet.
      const c = client;
      bounded(c, `LISTEN ${channel}`)
        .then(() => {
          if (client !== c) return;
          subscribed.add(channel);
          for (const s of subs.get(channel) ?? []) call(s.up);
        })
        .catch(() => lost(c));
    } else {
      ensure();
    }
  }
  return () => {
    const s = subs.get(channel);
    if (!s) return;
    s.delete(sub);
    if (s.size === 0) {
      subs.delete(channel);
      if (client && subscribed.delete(channel)) client.query(`UNLISTEN ${channel}`).catch(() => {});
    }
  };
}

function ensure(): void {
  if (client || retryTimer) return;
  const c = new Client({ ...connectionConfig(), connectionTimeoutMillis: 5_000, keepAlive: true });
  client = c;
  c.on("notification", (n) => {
    for (const s of subs.get(n.channel) ?? []) {
      try {
        s.fn(n.payload ?? "");
      } catch {}
    }
  });
  c.on("error", () => lost(c));
  c.on("end", () => lost(c));
  c.connect()
    .then(async () => {
      // Until none is left: a channel subscribed to while this loop runs is
      // taken too.
      for (let ch = [...subs.keys()].find((x) => !subscribed.has(x)); ch; ch = [...subs.keys()].find((x) => !subscribed.has(x))) {
        await bounded(c, `LISTEN ${ch}`);
        if (client !== c) return;
        subscribed.add(ch);
      }
      backoffMs = 1_000;
      pingTimer = setInterval(() => ping(c), PING_MS);
      pingTimer.unref?.();
      // LISTEN is in effect only now: whatever subscribers cached before
      // this moment may have changed unannounced.
      for (const ch of subscribed) for (const s of subs.get(ch) ?? []) call(s.up);
    })
    .catch(() => lost(c));
}

/** A query on the listener's connection that must answer within
 *  PING_TIMEOUT_MS: node-postgres gives a query no deadline of its own, and a
 *  LISTEN or ping that never answers would otherwise hold the connection
 *  (and block every reconnect) until the socket notices. */
function bounded(c: Client, text: string): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${text}: no answer in ${PING_TIMEOUT_MS} ms`)), PING_TIMEOUT_MS);
  });
  return Promise.race([c.query(text), timeout]).finally(() => clearTimeout(timer));
}

function ping(c: Client): void {
  bounded(c, "SELECT 1").catch(() => lost(c));
}

function lost(c: Client): void {
  if (client !== c) return;
  const wasUp = subscribed.size > 0;
  client = null;
  subscribed.clear();
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = undefined;
  c.removeAllListeners("notification");
  c.end().catch(() => {});
  if (wasUp) for (const set of subs.values()) for (const s of set) call(s.down);
  if (subs.size === 0) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    ensure();
  }, backoffMs);
  retryTimer.unref?.();
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
}

/** For tests: lose the connection as a network fault would (down hooks run,
 *  and it reconnects after the backoff). */
export function dropConnectionForTests(): void {
  if (client) lost(client);
}

/** For tests and shutdown: drop the connection and every subscriber. */
export async function stopListening(): Promise<void> {
  subs.clear();
  subscribed.clear();
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = undefined;
  const c = client;
  client = null;
  backoffMs = 1_000;
  if (c) await c.end().catch(() => {});
}
