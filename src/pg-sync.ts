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
// One statement, or one transaction of several (`batch`), per call. A call
// that waits longer than `timeoutMs` throws; the server cancels a statement
// at `timeoutMs` (statement_timeout) so it cannot commit after the caller
// gave up, and a late answer is dropped by id. A write whose ANSWER is lost
// (a connection dropped after the commit) is the one ambiguity left: every
// write here is an upsert or a delete, safe to repeat.
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

/** The records database did not answer in time. */
export class RecordsTimeout extends Error {
  readonly code = "RECORDS_TIMEOUT";
  readonly ms: number;
  constructor(ms: number) {
    super(`the records database did not answer within ${ms} ms — this call was given up on (set FOLDRUN_RECORDS_TIMEOUT_MS to allow longer)`);
    this.name = "RecordsTimeout";
    this.ms = ms;
  }
}

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

const WORKER_SRC = `
const { parentPort, workerData } = require("node:worker_threads");
const { Pool } = require(workerData.pg);
const pool = new Pool({ ...workerData.config, max: workerData.max, idleTimeoutMillis: 30000 });
pool.on("error", () => {});
const { port, flag } = workerData;
const slot = new Int32Array(flag);
parentPort.on("message", async (m) => {
  if (m.wedgeMs) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, m.wedgeMs); // tests only: a thread that does not answer
    return;
  }
  let out;
  try {
    const c = await pool.connect();
    try {
      // The server gives up first: a statement the caller stopped waiting for
      // is cancelled (and rolled back) there, not left to commit later over a
      // retry's newer write. Set only when it changes, so a call costs no extra trip.
      if (c.__st !== m.timeoutMs) {
        await c.query("SET statement_timeout = " + Math.max(1, Math.floor(m.timeoutMs)));
        c.__st = m.timeoutMs;
      }
      if (m.stmts.length === 1 && !m.fence) {
        const r = await c.query(m.stmts[0].text, m.stmts[0].values || []);
        out = { id: m.id, ok: true, results: [{ rows: r.rows, rowCount: r.rowCount || 0 }] };
      } else {
        await c.query("BEGIN");
        try {
          if (m.fence) {
            const f = await c.query("SELECT token FROM lock_fences WHERE name = $1 FOR SHARE", [m.fence.name]);
            if (!f.rows[0] || Number(f.rows[0].token) !== m.fence.token) throw Object.assign(new Error("stale"), { stale: m.fence.name });
          }
          const results = [];
          for (const s of m.stmts) {
            const r = await c.query(s.text, s.values || []);
            results.push({ rows: r.rows, rowCount: r.rowCount || 0 });
          }
          await c.query("COMMIT");
          out = { id: m.id, ok: true, results };
        } catch (e) {
          await c.query("ROLLBACK").catch(() => {});
          throw e;
        }
      }
    } finally {
      c.release();
    }
  } catch (e) {
    out = { id: m.id, ok: false, stale: e && e.stale, code: e && e.code, message: String((e && e.message) || e) };
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
  const worker = new Worker(WORKER_SRC, {
    eval: true,
    workerData: {
      pg: resolvePg(),
      config: { ...connectionConfig(), connectionTimeoutMillis: Math.min(5_000, timeoutDefault()) },
      max: Number(process.env.FOLDRUN_RECORDS_POOL) || 2,
      port: channel.port2,
      flag,
    },
    transferList: [channel.port2],
  });
  worker.unref();
  channel.port1.unref();
  const b: Bridge = { worker, port: channel.port1, slot: new Int32Array(flag), dead: false };
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
  b.worker.postMessage({ id, stmts, fence: opts.fence, timeoutMs });
  // The caller waits a little longer than the server does, so a slow statement
  // is answered by the server's cancellation (an error, and nothing committed).
  const deadline = Date.now() + timeoutMs + GRACE_MS;
  for (;;) {
    // Reset BEFORE draining: the worker posts its answer and only then raises
    // the flag, so an answer that lands after this store raises it again (the
    // wait below returns at once), and one that landed before is in the port.
    Atomics.store(b.slot, 0, 0);
    for (let m = receiveMessageOnPort(b.port); m; m = receiveMessageOnPort(b.port)) {
      const r = m.message as { id: number; ok: boolean; results?: SyncResult[]; stale?: string; code?: string; message?: string };
      if (r.id !== id) continue; // a late answer to a call that timed out
      if (r.ok) return r.results!;
      if (r.stale) throw new StaleFence(r.stale);
      // The server cancelled it at the deadline: the same outcome, said the same way.
      if (r.code === "57014") throw timedOut(timeoutMs, stmts);
      throw Object.assign(new Error(r.message ?? "database error"), { code: r.code });
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      // Nothing came back at all: the thread is wedged or the network is gone.
      // Throw the thread away so the next call starts clean, not behind it.
      bridge = null;
      void b.worker.terminate();
      throw timedOut(timeoutMs, stmts);
    }
    Atomics.wait(b.slot, 0, 0, left);
  }
}

function timedOut(ms: number, stmts: Stmt[]): RecordsTimeout {
  const err = new RecordsTimeout(ms);
  // The first words of the statement name the table, never a value.
  opsError("db.records_timeout", err, { ms, op: (stmts[0]?.text.trim().split(/\s+/)[0] ?? "").toLowerCase().replace(/[^a-z]/g, "") || "query" });
  return err;
}

/** For tests: make the thread stop answering for `ms`. */
export function wedgeForTest(ms: number): void {
  (bridge ??= start()).worker.postMessage({ wedgeMs: ms });
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
