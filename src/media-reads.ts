// Images and PDFs in a gateway call, read into text by the worker (FOL-268; owner, 25 Nov 2026: "a job for the
// worker"). The gateway is the door to the internet: it may neither make the account's parser pod nor reach it
// (tool-pod.ts canMakeToolPods; the parser's policy admits web, the worker and the egress proxy). The worker can.
//
//   gateway ──INSERT media_reads (queued, the block's bytes) + notify──▶ worker
//                                                                         claims it (SKIP LOCKED)
//                                                                         extractFile (its parser, made if absent)
//   gateway ◀── row done (its text) | failed + notify ─────────────────────┘ the bytes dropped
//
// The gateway waits up to the block's deadline (gateway-media.ts MEDIA_BLOCK_MS); a caller that leaves cancels it.
// A row past its deadline is failed by the sweep, and rows go an hour after they end. Without a database (tests,
// one process) the rows live in this process. Switched on for a gateway by FOLDRUN_MEDIA_READ_VIA=worker, set only
// where a worker reads (the cluster's tools-on-demand component): elsewhere nothing would ever claim a row.

import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { opsError, opsLog } from "../../foldrun-core/src/ops-log.ts";
import { databaseEnabled, ormRequired } from "./db.ts";
import { listen } from "./pg-listen.ts";

export const READ_CHANNEL = "foldrun_media_read";
export const READ_DONE_CHANNEL = "foldrun_media_read_done";
/** Blocks waiting or being read at once, per account and in all: past them a block goes as it was. */
export const MEDIA_READS_PER_ACCOUNT = 8;
export const MEDIA_READS_TOTAL = 64;
/** At most this many blocks read at once by one worker copy. */
const PER_WORKER = 2;
/** The most text kept for a block: a little over what the gateway uses (gateway-media MEDIA_TEXT_BYTES), so it still
 *  sees that the text was cut, and never megabytes in a row (Codex). */
export const MEDIA_READ_TEXT_MAX = 200 * 1024 + 64;
/** How long the gateway waits on one database statement before it gives the block up (Codex). */
const DB_WAIT_MS = 5000;

type State = "queued" | "running" | "done" | "failed" | "cancelled";
const LIVE: State[] = ["queued", "running"];
interface Job {
  id: string;
  tenant: string;
  actor: string;
  name: string;
  data: string | null;
  state: State;
  text: string | null;
  error: string | null;
  deadline: number;
  createdAt: number;
}

/** The worker's way to read one file (extract.ts extractFile in the account's extraction slot, injectable for tests). */
export type ReadFn = (tenant: string, bytes: Buffer, opts: { name: string; signal: AbortSignal; actor: string }) => Promise<{ text: string }>;

/** A database answer, or a refusal after `ms`: a stalled statement never holds a gateway call past its limits. */
function within<T>(ms: number, p: Promise<T>): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<T>((_r, no) => (t = setTimeout(() => no(new Error("the database did not answer in time")), Math.max(1, ms))))]).finally(() => clearTimeout(t));
}

/** Whether this process sends its blocks to the worker. */
export function readsViaWorker(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FOLDRUN_MEDIA_READ_VIA === "worker";
}

const mem = new Map<string, Job>();
const memWaiters = new Set<() => void>();
const memWake = () => {
  for (const w of [...memWaiters]) w();
};
export function resetMediaReadsForTests(): void {
  mem.clear();
  memWaiters.clear();
  if (timer) clearInterval(timer);
  timer = null;
  again = false;
  gen++;
}

type Row = { id: string; tenant: string; actor: string; name: string; data: string | null; state: State; text: string | null; error: string | null; deadline: Date | string; created_at: Date | string };
const fromRow = (r: Row): Job => ({ id: r.id, tenant: r.tenant, actor: r.actor, name: r.name, data: r.data, state: r.state, text: r.text, error: r.error, deadline: new Date(r.deadline).getTime(), createdAt: new Date(r.created_at).getTime() });

async function get(id: string): Promise<Job | null> {
  if (!databaseEnabled()) {
    const j = mem.get(id);
    return j ? { ...j } : null;
  }
  const r = await ormRequired().execute(sql`SELECT id, tenant, actor, name, NULL AS data, state, text, error, deadline, created_at FROM media_reads WHERE id = ${id}`);
  const row = (r.rows as Row[])[0];
  return row ? fromRow(row) : null;
}

export class MediaReadRefused extends Error {}

/** Queue one block, inside the per-account and total limits. */
async function queue(o: { id: string; tenant: string; actor: string; name: string; bytes: Buffer; deadlineMs: number }, now = Date.now()): Promise<string> {
  const id = o.id;
  const deadline = now + o.deadlineMs;
  if (!databaseEnabled()) {
    const live = [...mem.values()].filter((j) => LIVE.includes(j.state) && j.deadline > now);
    if (live.length >= MEDIA_READS_TOTAL || live.filter((j) => j.tenant === o.tenant).length >= MEDIA_READS_PER_ACCOUNT) throw new MediaReadRefused("too many files being read now");
    mem.set(id, { id, tenant: o.tenant, actor: o.actor, name: o.name, data: o.bytes.toString("base64"), state: "queued", text: null, error: null, deadline, createdAt: now });
    memWake();
    return id;
  }
  await ormRequired().transaction(async (t) => {
    await t.execute(sql`SET LOCAL lock_timeout = '3s'`);
    await t.execute(sql`SET LOCAL statement_timeout = '5s'`);
    await t.execute(sql`SELECT pg_advisory_xact_lock(hashtext('media-reads'))`);
    const c = await t.execute(sql`
      SELECT count(*)::int AS total, count(*) FILTER (WHERE tenant = ${o.tenant})::int AS account FROM media_reads
      WHERE state IN ('queued', 'running') AND deadline > now()`);
    const n = (c.rows as { total: number; account: number }[])[0] ?? { total: 0, account: 0 };
    if (n.total >= MEDIA_READS_TOTAL || n.account >= MEDIA_READS_PER_ACCOUNT) throw new MediaReadRefused("too many files being read now");
    await t.execute(sql`
      INSERT INTO media_reads (id, tenant, actor, name, data, state, deadline, created_at)
      VALUES (${id}, ${o.tenant}, ${o.actor}, ${o.name}, ${o.bytes.toString("base64")}, 'queued', ${new Date(deadline).toISOString()}, ${new Date(now).toISOString()})`);
    await t.execute(sql`SELECT pg_notify(${READ_CHANNEL}, ${id})`);
  });
  return id;
}

async function cancel(id: string): Promise<void> {
  if (!databaseEnabled()) {
    const j = mem.get(id);
    if (j && LIVE.includes(j.state)) Object.assign(j, { state: "cancelled", data: null });
    memWake();
    return;
  }
  await ormRequired().execute(sql`UPDATE media_reads SET state = 'cancelled', data = NULL, finished_at = now() WHERE id = ${id} AND state IN ('queued', 'running')`);
}

/**
 * The gateway's side: one block read by the worker, waited for until its deadline. Throws when it was not read
 * (refused, failed, past its deadline, the caller gone): the caller sends that block as it was.
 */
export async function readViaWorker(tenant: string, bytes: Buffer, opts: { name: string; signal?: AbortSignal; actor?: string; deadlineMs: number }): Promise<{ text: string }> {
  if (opts.signal?.aborted) throw new Error("the caller went away");
  const until = Date.now() + opts.deadlineMs;
  // The id is chosen here, so a queueing that answered too late can still be taken back by it (Codex).
  const id = `mr-${Date.now().toString(36)}${crypto.randomBytes(8).toString("hex")}`;
  const queued = queue({ id, tenant, actor: opts.actor ?? "gateway", name: opts.name, bytes, deadlineMs: opts.deadlineMs });
  await within(Math.min(DB_WAIT_MS, opts.deadlineMs), queued).catch((err) => {
    // A row that goes in after we stopped waiting is cancelled as soon as it does: never read for nobody.
    void queued.then(() => cancel(id)).catch(() => undefined);
    throw err;
  });
  // The caller left while it was being queued: taken back now, before anything else (Codex).
  if (opts.signal?.aborted) {
    await cancel(id).catch(() => undefined);
    throw new Error("the caller went away");
  }
  let wake: () => void = () => {};
  const memWaiter = () => wake();
  const stop = databaseEnabled() ? listen(READ_DONE_CHANNEL, (p) => p === id && wake()) : (memWaiters.add(memWaiter), () => void memWaiters.delete(memWaiter));
  const onAbort = () => {
    void cancel(id).catch((err) => opsError("media_read.cancel_failed", err, { tenant }));
    wake();
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const j = await within(Math.min(DB_WAIT_MS, Math.max(1, until - Date.now())), get(id)).catch(async (err) => {
        void cancel(id).catch(() => undefined);
        throw err;
      });
      if (j?.state === "done") return { text: j.text ?? "" };
      if (!j || (j.state !== "queued" && j.state !== "running")) throw new Error(j?.error ?? "the file was not read");
      if (opts.signal?.aborted) throw new Error("the caller went away");
      if (Date.now() > until) {
        void cancel(id).catch(() => undefined);
        throw new Error("the file was not read in time");
      }
      // Woken by the worker's notify; read again every second as the backstop (a notify before we listened).
      await new Promise<void>((r) => {
        const t = setTimeout(r, 1000);
        wake = () => {
          clearTimeout(t);
          r();
        };
      });
    }
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    stop();
  }
}

// ---------------------------------------------------------------- the worker's side

const WORKER = `${process.env.HOSTNAME ?? "worker"}-${process.pid}`;

async function claim(): Promise<Job | null> {
  if (!databaseEnabled()) {
    const now = Date.now();
    const j = [...mem.values()].filter((x) => x.state === "queued" && x.deadline > now).sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!j) return null;
    const copy = { ...j, state: "running" as State };
    Object.assign(j, { state: "running", data: null });
    return copy;
  }
  // The bytes leave the row as they are claimed: a worker that dies leaves nothing to read in the table (Codex).
  const r = await ormRequired().execute(sql`
    WITH picked AS (
      SELECT id, data FROM media_reads WHERE state = 'queued' AND deadline > now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
    UPDATE media_reads m SET state = 'running', worker = ${WORKER}, started_at = now(), data = NULL
    FROM picked WHERE m.id = picked.id
    RETURNING m.id, m.tenant, m.actor, m.name, picked.data AS data, m.state, m.text, m.error, m.deadline, m.created_at`);
  const row = (r.rows as Row[])[0];
  return row ? fromRow(row) : null;
}

async function finish(job: Job, out: { text: string } | { error: string }): Promise<void> {
  const state: State = "text" in out ? "done" : "failed";
  const text = "text" in out ? Buffer.from(out.text, "utf8").subarray(0, MEDIA_READ_TEXT_MAX).toString("utf8").replace(/\uFFFD$/, "") : null;
  const error = "error" in out ? out.error : null;
  if (!databaseEnabled()) {
    const j = mem.get(job.id);
    if (j && j.state === "running") Object.assign(j, { state, text, error, data: null });
    memWake();
    return;
  }
  await ormRequired().execute(sql`
    WITH up AS (
      UPDATE media_reads SET state = ${state}, text = ${text}, error = ${error}, data = NULL, finished_at = now()
      WHERE id = ${job.id} AND state = 'running' RETURNING id)
    SELECT pg_notify(${READ_DONE_CHANNEL}, id) FROM up`);
}

/** Read one claimed block. Never throws. */
export async function runMediaRead(job: Job, read: ReadFn): Promise<void> {
  try {
    const left = job.deadline - Date.now();
    if (left <= 0 || !job.data) return await finish(job, { error: "it waited past its deadline" });
    // A block its caller gave up on stops being read: the row is looked at every two seconds (Codex).
    const stop = new AbortController();
    const watch = setInterval(() => {
      void get(job.id)
        .then((j) => {
          if (!j || j.state !== "running") stop.abort();
        })
        .catch(() => undefined);
    }, 2000);
    watch.unref?.();
    try {
      const r = await read(job.tenant, Buffer.from(job.data, "base64"), { name: job.name, actor: job.actor, signal: AbortSignal.any([stop.signal, AbortSignal.timeout(left)]) });
      await finish(job, { text: String(r.text ?? "") });
    } finally {
      clearInterval(watch);
    }
  } catch (err) {
    await finish(job, { error: err instanceof Error ? err.message.slice(0, 300) : "the file could not be read" }).catch((e) => opsError("media_read.finish_failed", e, { tenant: job.tenant }));
  }
}

let timer: NodeJS.Timeout | null = null;
let draining: Promise<void> | null = null;
let again = false;
let inFlight = 0;
/** Moved on by a reset (tests): a loop of an earlier start claims nothing more. */
let gen = 0;

export function drainMediaReads(read: ReadFn, mine = gen): Promise<void> {
  if (mine !== gen) return Promise.resolve();
  if (draining) {
    again = true;
    return draining;
  }
  draining = (async () => {
    while (inFlight < PER_WORKER && mine === gen) {
      const job = await claim();
      if (!job) break;
      inFlight++;
      void runMediaRead(job, read).finally(() => {
        inFlight--;
        void drainMediaReads(read, mine);
      });
    }
  })()
    .catch((err) => opsError("media_read.claim_failed", err))
    .finally(() => {
      draining = null;
      if (again) {
        again = false;
        void drainMediaReads(read, mine);
      }
    });
  return draining;
}

/** Started with the worker's loops (boot.ts) where it can read files: on a notify, and every two seconds. */
export function startMediaReads(read: ReadFn): void {
  if (timer) return;
  const mine = gen;
  const kick = () => void drainMediaReads(read, mine);
  if (databaseEnabled()) listen(READ_CHANNEL, kick, { up: kick, down: kick });
  else memWaiters.add(kick);
  timer = setInterval(kick, 2000);
  timer.unref?.();
  kick();
  opsLog("info", "media_read.started", {});
}

/** Rows past their deadline (a worker that died) failed; ended rows gone after an hour. The scheduler's sweep. */
export async function sweepMediaReads(now = Date.now()): Promise<number> {
  if (!databaseEnabled()) {
    let n = 0;
    for (const j of mem.values()) {
      if (LIVE.includes(j.state) && j.deadline + 10_000 < now) {
        Object.assign(j, { state: "failed", error: "its worker was lost", data: null });
        n++;
      }
      if (!LIVE.includes(j.state) && j.createdAt + 3600_000 < now) mem.delete(j.id);
    }
    if (n) memWake();
    return n;
  }
  const r = await ormRequired().execute(sql`
    WITH up AS (
      UPDATE media_reads SET state = 'failed', error = 'its worker was lost', data = NULL, finished_at = now()
      WHERE state IN ('queued', 'running') AND deadline < now() - interval '10 seconds' RETURNING id)
    SELECT pg_notify(${READ_DONE_CHANNEL}, id) FROM up`);
  await ormRequired().execute(sql`DELETE FROM media_reads WHERE created_at < now() - interval '1 hour' AND state NOT IN ('queued', 'running')`);
  return r.rowCount ?? 0;
}

/** An account deleted: its blocks go, read or waiting (tenant-delete.ts). */
export async function deleteTenantMediaReads(tenant: string): Promise<void> {
  if (!databaseEnabled()) {
    for (const [id, j] of mem) if (j.tenant === tenant) mem.delete(id);
    return;
  }
  await ormRequired().execute(sql`DELETE FROM media_reads WHERE tenant = ${tenant}`);
}
