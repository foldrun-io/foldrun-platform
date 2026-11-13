// Postgres, asked synchronously (FOL-126 phase 2).
//
// Core reads and writes a run, a trigger log line or a storage index row from
// code that is synchronous all the way up (readRun is called from 68 places).
// Moving those records to Postgres must not turn every caller async in one
// change, so this is the bridge: a thread of its own owns a small pool and
// runs the statements; the calling thread waits for the answer with
// Atomics.wait and reads it with receiveMessageOnPort. The caller blocks for
// the round trip — a millisecond or two in the same zone — which is what a
// synchronous file read on a healthy disk cost, and not what one on a hung
// NFS mount cost (the whole reason the records leave the volume). Phase 3
// moves the hot callers to async one at a time; this keeps the rest working
// while that happens.
//
// One statement, or one transaction of several (`batch`), per call. The
// server-side work of a call is bounded as a WHOLE by `timeoutMs`, counted
// from the moment the caller sent it: the wait for a connection, every
// statement of a batch and the COMMIT all come out of that one budget
// (FOL-152 — statement_timeout alone is per statement and starts only once a
// connection is in hand, so a slow connect plus a long write, or a batch of
// several, could run past the caller's limit and commit after it gave up).
// No statement and no COMMIT is started after the deadline; what is running
// then is cancelled on the server (pg_cancel_backend, sent from a short-lived
// thread of its own), and that connection is never handed to another call.
// The caller waits GRACE_MS longer, so the answer says what happened: the
// result, or a RecordsTimeout that is `outcome: "not-applied"` (nothing of
// the call committed) — or `"unknown"` when a COMMIT, or a single statement
// that commits by itself, was still unanswered at the end. statement_timeout
// stays as the server's own backstop, and every connection carries
// client_connection_check_interval so the server also stops a statement
// whose client went away. If the thread does not answer at all, the caller
// terminates it (an open transaction dies with its connection) and cancels
// the statement it was running itself. Every write here is an upsert or a
// delete, safe to repeat; a late answer to a call given up on is dropped by id.
// `fence` (see fenced-lock.ts): the batch runs only if that lock's newest token
// is still the holder's, checked inside the same transaction.

import { Worker, MessageChannel, receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { connectionConfig } from "./db.ts";
import { opsError } from "../../foldrun-core/src/ops-log.ts";

/** The most one call may take, in ms. Short on purpose: the caller is frozen
 *  while it waits, so a slow database must cost seconds, never a hung process.
 *  FOLDRUN_RECORDS_TIMEOUT_MS raises it (a very large run record on a slow link). */
export const DEFAULT_TIMEOUT_MS = 3_000;
const GRACE_MS = 1_500;

/** The records database did not answer in time. `outcome`: "not-applied"
 *  when nothing of the call can have committed, "unknown" when a COMMIT (or a
 *  statement that commits by itself) was in flight when the time ran out. */
export class RecordsTimeout extends Error {
  readonly code = "RECORDS_TIMEOUT";
  readonly ms: number;
  readonly outcome: "not-applied" | "unknown";
  constructor(ms: number, outcome: "not-applied" | "unknown" = "not-applied") {
    super(
      `the records database did not answer within ${ms} ms — this call was given up on${outcome === "unknown" ? " (it was committing: it may or may not have been applied)" : ""} (set FOLDRUN_RECORDS_TIMEOUT_MS to allow longer)`,
    );
    this.name = "RecordsTimeout";
    this.ms = ms;
    this.outcome = outcome;
  }
}

/** Now, in ms, on a clock both threads read the same way and that does not
 *  jump with the wall clock: each thread's origin plus its monotonic time. */
const clock = () => performance.timeOrigin + performance.now();

export const timeoutDefault = () => Number(process.env.FOLDRUN_RECORDS_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

export interface Stmt {
  text: string;
  values?: unknown[];
}
export interface SyncResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}
export interface Fenced {
  name: string;
  token: number;
}

/** The fence was not the newest when the batch ran: a newer holder exists. */
export class StaleFence extends Error {
  readonly lock: string;
  constructor(name: string) {
    super(`the lock ${name} was taken over while this holder was stalled — its write is refused`);
    this.name = "StaleLock";
    this.lock = name;
  }
}

/** A thread of its own that asks the server to cancel one backend's
 *  statement, then exits. Its own thread so that neither a records thread
 *  stuck in a call nor a main thread about to block in Atomics.wait holds it
 *  up. The backend is named by pid AND start time, so a pid the server has
 *  since given to another session is never cancelled. */
const CANCEL_SRC = `
const { workerData } = require("node:worker_threads");
const { Client } = require(workerData.pg);
const c = new Client({ ...workerData.config, connectionTimeoutMillis: 5000 });
c.on("error", () => {});
c.connect()
  .then(() => c.query("SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE pid = $1 AND (extract(epoch from backend_start) * 1000000)::bigint = $2::bigint", [workerData.pid, String(workerData.start)]))
  .catch(() => {})
  .finally(() => c.end().catch(() => {}));
`;

const WORKER_SRC = `
const { parentPort, workerData, Worker } = require("node:worker_threads");
const { Pool } = require(workerData.pg);
const pool = new Pool({ ...workerData.config, max: workerData.max, idleTimeoutMillis: 30000 });
pool.on("error", () => {});
const { port, flag, live } = workerData;
const slot = new Int32Array(flag);
// The backend running this thread's current call: [pid, backend start in µs], 0 when none.
// The calling thread reads it to cancel the statement itself if this thread stops answering.
const inflight = new Float64Array(live);
const clock = () => performance.timeOrigin + performance.now();
let slowConnectMs = 0; // tests only: the next connect takes this long
const cancel = (pid, start) => {
  try {
    const w = new Worker(workerData.cancelSrc, { eval: true, workerData: { pg: workerData.pg, config: workerData.config, pid, start } });
    w.on("error", () => {});
    w.unref();
  } catch {}
};
const late = () => Object.assign(new Error("deadline"), { deadline: true });
// Once per connection: the server notices a client that went away (PG 14+;
// an older server refuses the setting and cancel alone stops the statement),
// and which backend it is, so a cancel can name it.
async function ready(c) {
  if (c.__pid) return;
  try {
    await c.query("SET client_connection_check_interval = 250");
  } catch {}
  const r = await c.query("SELECT pg_backend_pid() AS pid, (extract(epoch from backend_start) * 1000000)::bigint AS start FROM pg_stat_activity WHERE pid = pg_backend_pid()");
  c.__start = Number(r.rows[0] ? r.rows[0].start : 0);
  c.__pid = r.rows[0] ? r.rows[0].pid : -1;
}
parentPort.on("message", async (m) => {
  if (m.wedgeMs) {
    // tests only: a thread that does not answer, now or a moment from now
    const wedge = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, m.wedgeMs);
    if (m.afterMs) setTimeout(wedge, m.afterMs);
    else wedge();
    return;
  }
  if (m.slowConnectMs) {
    slowConnectMs = m.slowConnectMs;
    return;
  }
  let out;
  let c = null;
  let gone = false; // the connection was thrown away: never released again
  let expired = false; // the deadline passed: nothing more is sent, and the connection is never reused
  let committing = false; // a COMMIT, or a statement that commits by itself, is in flight
  const timers = [];
  try {
    // The connection comes out of the caller's budget too. One that arrives
    // after the deadline was never used: it goes straight back to the pool.
    const delay = slowConnectMs;
    slowConnectMs = 0;
    const connecting = (delay ? new Promise((r) => setTimeout(r, delay)) : Promise.resolve()).then(() => pool.connect());
    c = await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        connecting.then((x) => x.release(), () => {});
        reject(late());
      }, Math.max(0, m.deadline - clock()));
      connecting.then((x) => { clearTimeout(t); resolve(x); }, (e) => { clearTimeout(t); reject(e); });
    });
    const left = m.deadline - clock();
    if (left <= 0) throw late();
    // At the deadline: nothing more is sent, and what is running is cancelled
    // on the server. Its own answer (done, or cancelled) is still awaited for
    // part of the caller's grace, so the caller learns what happened; only
    // then is the connection thrown away and the outcome left unknown.
    timers.push(setTimeout(() => {
      expired = true;
      if (c.__pid > 0) cancel(c.__pid, c.__start);
    }, left));
    timers.push(setTimeout(() => {
      expired = true;
      gone = true;
      c.release(late());
    }, left + m.graceMs / 2));
    // Nothing starts after the deadline: not a statement, not a COMMIT.
    // commits: this statement commits when it ends (a COMMIT, or a single
    // statement outside a transaction).
    const q = (text, values, commits) => {
      if (expired || clock() >= m.deadline) throw late();
      committing = Boolean(commits);
      return c.query(text, values || []);
    };
    await ready(c);
    // statement_timeout stays as the server's own backstop. Set only when it
    // changes, so a call costs no extra trip.
    if (c.__st !== m.timeoutMs) {
      await q("SET statement_timeout = " + Math.max(1, Math.floor(m.timeoutMs)));
      c.__st = m.timeoutMs;
    }
    inflight[0] = c.__pid > 0 ? c.__pid : 0;
    inflight[1] = c.__start || 0;
    if (m.stmts.length === 1 && !m.fence) {
      const r = await q(m.stmts[0].text, m.stmts[0].values, true);
      committing = false;
      out = { id: m.id, ok: true, results: [{ rows: r.rows, rowCount: r.rowCount || 0 }] };
    } else {
      await q("BEGIN");
      try {
        if (m.fence) {
          const f = await q("SELECT token FROM lock_fences WHERE name = $1 FOR SHARE", [m.fence.name]);
          if (!f.rows[0] || Number(f.rows[0].token) !== m.fence.token) throw Object.assign(new Error("stale"), { stale: m.fence.name });
        }
        const results = [];
        for (const s of m.stmts) {
          const r = await q(s.text, s.values);
          results.push({ rows: r.rows, rowCount: r.rowCount || 0 });
        }
        await q("COMMIT", [], true);
        committing = false;
        out = { id: m.id, ok: true, results };
      } catch (e) {
        // Past the deadline the connection is thrown away below, which rolls
        // the transaction back without waiting for one more round trip.
        if (!expired && !committing) await c.query("ROLLBACK").catch(() => {});
        throw e;
      }
    }
  } catch (e) {
    if (gone) out = { id: m.id, ok: false, code: "57014", outcome: committing ? "unknown" : "not-applied" };
    else if ((e && e.deadline) || (e && e.code === "57014")) out = { id: m.id, ok: false, code: "57014", outcome: "not-applied" };
    else out = { id: m.id, ok: false, stale: e && e.stale, code: e && e.code, message: String((e && e.message) || e) };
  } finally {
    for (const t of timers) clearTimeout(t);
    inflight[0] = 0;
    inflight[1] = 0;
    // A connection whose call ran past its deadline may still have a cancel
    // on its way: it is never handed to another call.
    if (c && !gone) c.release(expired ? late() : undefined);
  }
  port.postMessage(out);
  Atomics.store(slot, 0, 1);
  Atomics.notify(slot, 0);
});
`;

interface Bridge {
  worker: Worker;
  port: MessagePort;
  slot: Int32Array;
  /** What the thread is running now: [backend pid, backend start µs]. */
  inflight: Float64Array;
  dead: boolean;
}

let bridge: Bridge | null = null;
let nextId = 1;

/** Where `pg` is on disk, for the thread (it cannot import by bare name from
 *  an eval'd script). The dashboard bundles this file, so the module's own
 *  location is not always beside the platform's node_modules: try it, then the
 *  working directory and the platform checkout beside it, then FOLDRUN_PG_MODULE. */
export function resolvePg(): string {
  if (process.env.FOLDRUN_PG_MODULE) return process.env.FOLDRUN_PG_MODULE;
  const bases = [import.meta.url, `${process.cwd()}/`, `${process.cwd()}/../foldrun-platform/`, "/app/foldrun-platform/"];
  let last: unknown;
  for (const base of bases) {
    try {
      return createRequire(base.startsWith("file:") ? base : pathToFileURL(base).href).resolve("pg");
    } catch (err) {
      last = err;
    }
  }
  throw new Error(`cannot find the pg package for the records thread (${last instanceof Error ? last.message : String(last)}) — set FOLDRUN_PG_MODULE`);
}

function start(): Bridge {
  const channel = new MessageChannel();
  const flag = new SharedArrayBuffer(4);
  const live = new SharedArrayBuffer(16);
  const worker = new Worker(WORKER_SRC, {
    eval: true,
    workerData: {
      pg: resolvePg(),
      config: { ...connectionConfig(), connectionTimeoutMillis: Math.min(5_000, timeoutDefault()) },
      max: Number(process.env.FOLDRUN_RECORDS_POOL) || 2,
      port: channel.port2,
      flag,
      live,
      cancelSrc: CANCEL_SRC,
    },
    transferList: [channel.port2],
  });
  worker.unref();
  channel.port1.unref();
  const b: Bridge = { worker, port: channel.port1, slot: new Int32Array(flag), inflight: new Float64Array(live), dead: false };
  const gone = () => {
    b.dead = true;
    if (bridge === b) bridge = null;
  };
  worker.on("error", gone);
  worker.on("exit", gone);
  return b;
}

/** Run `stmts` — one transaction when there is more than one, or a fence —
 *  and wait for the answer. */
export function pgSync(stmts: Stmt[], opts: { fence?: Fenced; timeoutMs?: number } = {}): SyncResult[] {
  const b = (bridge ??= start());
  const id = nextId++;
  const timeoutMs = opts.timeoutMs ?? timeoutDefault();
  // The whole call's budget starts now, at the send: the thread counts its
  // wait for a connection and every statement against this same instant.
  const sent = clock();
  b.worker.postMessage({ id, stmts, fence: opts.fence, timeoutMs, deadline: sent + timeoutMs, graceMs: GRACE_MS });
  // The caller waits a little longer than the thread does, so a slow
  // statement is answered by the thread's cancellation (an error, and nothing
  // committed) rather than by silence.
  const deadline = sent + timeoutMs + GRACE_MS;
  for (;;) {
    // Reset BEFORE draining: the worker posts its answer and only then raises
    // the flag, so an answer that lands after this store raises it again (the
    // wait below returns at once), and one that landed before is in the port.
    Atomics.store(b.slot, 0, 0);
    for (let m = receiveMessageOnPort(b.port); m; m = receiveMessageOnPort(b.port)) {
      const r = m.message as { id: number; ok: boolean; results?: SyncResult[]; stale?: string; code?: string; message?: string; outcome?: "not-applied" | "unknown" };
      if (r.id !== id) continue; // a late answer to a call that timed out
      if (r.ok) return r.results!;
      if (r.stale) throw new StaleFence(r.stale);
      // The deadline (the thread's or the server's): the same outcome, said the same way.
      if (r.code === "57014") throw timedOut(timeoutMs, stmts, r.outcome ?? "not-applied");
      // Marked as the database's (`database: true`): its message is the
      // server's — a constraint and the values it refused, or a host and port
      // when the connection failed — and it must never be an answer. Without
      // the mark it reached a caller as a 400 with that text (Kousha's
      // review, 14 Nov 2026): it carries no `severity`, so it did not look
      // like a driver error.
      throw Object.assign(new Error(r.message ?? "database error"), { code: r.code, database: true });
    }
    const left = deadline - clock();
    if (left <= 0) {
      // Nothing came back at all: the thread is wedged or the network is gone.
      // Throw the thread away so the next call starts clean, not behind it —
      // and cancel what it was running, since a terminated thread sends no
      // cancel of its own (its socket closing is noticed by a server with
      // client_connection_check_interval, not by every server).
      const pid = b.inflight[0];
      const began = b.inflight[1];
      bridge = null;
      void b.worker.terminate();
      if (pid > 0) cancelBackend(pid, began);
      throw timedOut(timeoutMs, stmts, "unknown");
    }
    Atomics.wait(b.slot, 0, 0, left);
  }
}

/** Ask the server to cancel one backend's statement, from a thread of its own. */
function cancelBackend(pid: number, began: number): void {
  try {
    const w = new Worker(CANCEL_SRC, { eval: true, workerData: { pg: resolvePg(), config: connectionConfig(), pid, start: began } });
    w.on("error", () => {});
    w.unref();
  } catch {
    // best effort: the statement_timeout backstop still ends it
  }
}

function timedOut(ms: number, stmts: Stmt[], outcome: "not-applied" | "unknown"): RecordsTimeout {
  const err = new RecordsTimeout(ms, outcome);
  // The first words of the statement name the table, never a value.
  opsError("db.records_timeout", err, { ms, op: (stmts[0]?.text.trim().split(/\s+/)[0] ?? "").toLowerCase().replace(/[^a-z]/g, "") || "query" });
  return err;
}

/** For tests: make the thread stop answering for `ms` (from `afterMs` on). */
export function wedgeForTest(ms: number, afterMs = 0): void {
  (bridge ??= start()).worker.postMessage({ wedgeMs: ms, afterMs });
}

/** For tests: make the thread's next connect take `ms` (a pool slow to hand
 *  one out, or a slow network), to show it comes out of the call's budget. */
export function slowConnectForTest(ms: number): void {
  (bridge ??= start()).worker.postMessage({ slowConnectMs: ms });
}

/** One statement. */
export function pgSyncOne(text: string, values: unknown[] = [], opts?: { fence?: Fenced; timeoutMs?: number }): SyncResult {
  return pgSync([{ text, values }], opts)[0];
}

/** Stop the thread (tests, shutdown). */
export async function closePgSync(): Promise<void> {
  const b = bridge;
  bridge = null;
  if (b) await b.worker.terminate();
}
