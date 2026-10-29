// Assistant replies as queued work, run by the worker tier — not by the web.
//
// A reply is a model loop that can take two minutes and holds a `claude`
// process of a few hundred MB while it does. On the web pod that competed
// with every page of the dashboard and scaled with nothing; here it is a
// job: the web enqueues it and streams its events, a worker claims it, runs
// it, writes its events and its conversation, and lets it go.
//
// Why a worker process and not a pod per reply: nothing a reply does runs
// code — its tools are ours, read-only, scoped to the asking account on the
// server side (engine.ts) — so the gVisor pod a run step gets for safety
// buys nothing here, and would cost every chat message a pod start and a
// copy of the workspace. A warm pool behind a queue is what scales a chat.
//
// The queue: Postgres when the install has one (claimed with SKIP LOCKED,
// at most accountCap() replies of one account running at once across every
// worker, so one account cannot take the pool), files under the data root
// otherwise. Delivery is at most once: a job whose worker dies mid-reply is
// not run again — it may already have spent, and a second run would charge
// twice — it ends with an error event, and the person asks again.
//
// Events go to `<account>/assistant/jobs/<id>.jsonl` on the shared data
// volume, the same volume run records stream from; the web tails the file.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { accountDir } from "../../../foldrun-core/src/store.ts";
import { dataRoot } from "../../../foldrun-core/src/paths.ts";
import { databaseEnabled, orm, tx } from "../db.ts";
import { cache, cacheConnected } from "../cache.ts";
import { askAssistant, type AssistantEvent, type AssistantRequest, type AssistantResult } from "./engine.ts";
import { saveConversation, type StoredMessage } from "./conversations.ts";
import { settingText } from "../settings.ts";

export interface AssistantJob {
  id: string;
  tenant: string;
  workspace: string;
  /** `<kind>:<id>` of who asked — the conversation is theirs. */
  owner: string;
  /** The conversation this reply belongs to; null starts one. */
  conversation: string | null;
  request: AssistantRequest;
}

/** One line of a job's event file. `done` carries the result and the conversation id. */
export type JobEvent =
  | { type: "queued" }
  | { type: "started" }
  | { type: "status"; text: string }
  | { type: "text"; text: string }
  | { type: "done"; result: AssistantResult; conversation: string }
  | { type: "error"; error: string; status: number };

/** Replies of one account running at once, across every worker. */
/** Read each pass, not at boot: an operator setting (settings.ts), so a
 *  change lands within a poll without restarting the assistant pods. */
export const accountCap = (): number => Number(settingText("FOLDRUN_ASSISTANT_ACCOUNT_CAP") ?? 3) || 3;
/** Replies one worker process runs at once: each holds a `claude` process. */
export const WORKER_CONCURRENCY = Number(process.env.FOLDRUN_ASSISTANT_CONCURRENCY ?? 4) || 4;
/** A claim not heard from in this long belongs to a worker that died. The
 *  heartbeat is every 20 s; this is long enough that a stalled event loop
 *  (a GC pause, a starved CPU) is not mistaken for a dead one. A worker that
 *  is reaped and then finishes anyway is charged once (the ledger line is
 *  the job's) and its conversation is kept; its follower has already been
 *  told the reply stopped. */
const STALE_SECONDS = 150;
/** Event files are kept this long — enough to reconnect and read the end. */
const EVENTS_KEEP_MS = 6 * 3600_000;

// Kebab-case: the id names the reply's ledger line (`assistant-<id>`), and a
// run id is kebab-case or it is refused.
export const newJobId = () => `j-${Date.now().toString(36)}${crypto.randomBytes(6).toString("hex")}`;
const JOB_ID = /^j-[a-z0-9]{10,40}$/;
export const isJobId = (id: string) => JOB_ID.test(id);

// ---------------------------------------------------------------- events

// A reply's events — queued, started, what it reads, its words, the end —
// are a log any web pod can follow with a cursor. Redis Streams when the
// install has Redis (an ordered append-only log with ids to resume from,
// trimmed and expired with the reply: what Redis here is for, state that
// can be lost without loss); otherwise a JSONL file on the shared data
// volume, appended and closed per event and reopened per read, which is
// what close-to-open consistency on NFS/EFS guarantees a reader sees.

/** How long a reply's events are kept: enough to reconnect and read the end. */
const EVENTS_TTL_SECONDS = 6 * 3600;
const STREAM_MAX = 5000;

export const eventsFile = (tenant: string, id: string) => path.join(accountDir(tenant), "assistant", "jobs", `${id}.jsonl`);
/** A reply's last event — `done` or `error` — also kept here, on the shared
 *  volume, whatever the log is: the one event a follower cannot do without
 *  survives Redis being down when it is written. */
export const endFile = (tenant: string, id: string) => path.join(accountDir(tenant), "assistant", "jobs", `${id}.end.json`);
const streamKey = (id: string) => `assistant:events:${id}`;

/** The order events are written in: one chain per job, so a slow write can
 *  never let a later event overtake an earlier one. */
const chains = new Map<string, Promise<void>>();

async function writeEvent(tenant: string, id: string, event: JobEvent): Promise<void> {
  const r = cache();
  if (r) {
    // The client queues nothing while it connects (cache.ts): the first
    // event of a fresh process must wait for the connection, not fail.
    if (!(await cacheConnected(5_000))) throw new Error("redis is not connected");
    await r.xadd(streamKey(id), "MAXLEN", "~", String(STREAM_MAX), "*", "e", JSON.stringify(event));
    await r.expire(streamKey(id), EVENTS_TTL_SECONDS);
    return;
  }
  const file = eventsFile(tenant, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

/** Write it, trying three times: a lost `done` leaves a follower waiting. */
async function writeWithRetry(tenant: string, id: string, event: JobEvent): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await writeEvent(tenant, id, event);
      return;
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }
}

function writeEnd(tenant: string, id: string, event: JobEvent) {
  const file = endFile(tenant, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(event), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

/** The last event a follower will find, from the end file. */
export function readJobEnd(tenant: string, id: string): JobEvent | null {
  if (!isJobId(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(endFile(tenant, id), "utf8")) as JobEvent;
  } catch {
    return null;
  }
}

const isEnd = (e: JobEvent) => e.type === "done" || e.type === "error";

/**
 * Append one event. Ordered per job; resolves once it is written. The last
 * event is also written to the end file first, so it is never lost; a lost
 * event before it costs the follower a line of status or a few words, which
 * the `done` (carrying the whole reply) makes up.
 */
export function appendJobEvent(tenant: string, id: string, event: JobEvent): Promise<void> {
  const write = async () => {
    let ended = false;
    if (isEnd(event)) {
      try {
        writeEnd(tenant, id, event);
        ended = true;
      } catch (err) {
        console.error(`[foldrun] assistant: end file for ${id} not written: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try {
      await writeWithRetry(tenant, id, event);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      // The end in neither place: a follower would wait out its timeout. Say
      // so to the caller; any other event lost is a line of status or a few
      // words the `done` (carrying the whole reply) makes up.
      if (isEnd(event) && !ended) throw new Error(`the end of ${id} was written nowhere: ${why}`);
      console.error(`[foldrun] assistant: event for ${id} not written to the log${ended ? " (the end file has it)" : ""}: ${why}`);
    }
  };
  const next = (chains.get(id) ?? Promise.resolve()).then(write);
  // The chain itself never rejects, so one failure does not block the events after it.
  const chained = next.catch(() => undefined);
  chains.set(id, chained);
  void chained.finally(() => {
    if (chains.get(id) === chained) chains.delete(id);
  });
  return next;
}

/**
 * Events after `cursor` ("0" for the start), and the cursor to read from
 * next — a stream id on Redis, a byte offset in the file otherwise.
 */
export async function readJobEvents(tenant: string, id: string, cursor = "0"): Promise<{ events: JobEvent[]; cursor: string }> {
  if (!isJobId(id)) return { events: [], cursor };
  const r = cache();
  if (r) {
    // Not connected yet (or Redis is down): nothing new this poll; the
    // follower asks again.
    if (!(await cacheConnected(2_000))) return { events: [], cursor };
    const rows = await r.xrange(streamKey(id), cursor === "0" ? "-" : `(${cursor}`, "+", "COUNT", 500);
    const events: JobEvent[] = [];
    let last = cursor;
    for (const [entryId, fields] of rows) {
      last = entryId;
      const at = fields.indexOf("e");
      if (at < 0) continue;
      try {
        events.push(JSON.parse(fields[at + 1]) as JobEvent);
      } catch {
        // a malformed entry is skipped, never fatal
      }
    }
    return { events, cursor: last };
  }
  const offset = Number(cursor) || 0;
  let fd: number;
  try {
    fd = fs.openSync(eventsFile(tenant, id), "r");
  } catch {
    return { events: [], cursor };
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= offset) return { events: [], cursor };
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    const text = buf.toString("utf8");
    const end = text.lastIndexOf("\n");
    if (end < 0) return { events: [], cursor };
    const events: JobEvent[] = [];
    for (const line of text.slice(0, end).split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as JobEvent);
      } catch {
        // a torn line is skipped, never fatal
      }
    }
    return { events, cursor: String(offset + Buffer.byteLength(text.slice(0, end + 1), "utf8")) };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The words of a reply come as many small deltas; written one by one they
 * would be hundreds of writes a reply. Gathered here and written every
 * `everyMs`, and before any other event, so the order still holds.
 */
function textBatcher(tenant: string, id: string, everyMs = 100) {
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!pending) return;
    const text = pending;
    pending = "";
    void appendJobEvent(tenant, id, { type: "text", text });
  };
  return {
    text(delta: string) {
      pending += delta;
      timer ??= setTimeout(flush, everyMs);
    },
    flush,
  };
}

// ---------------------------------------------------------------- the queue

const fileQueue = (state: "pending" | "claimed") => path.join(dataRoot(), ".assistant-queue", state);

/** Put a reply in line. Its event file starts with `queued`. */
export async function enqueueAssistantJob(job: AssistantJob): Promise<void> {
  await appendJobEvent(job.tenant, job.id, { type: "queued" });
  const payload = { owner: job.owner, conversation: job.conversation, request: job.request };
  const q = databaseEnabled() ? orm() : null;
  if (q) {
    await q.execute(sql`INSERT INTO assistant_jobs (id, tenant, workspace, payload) VALUES (${job.id}, ${job.tenant}, ${job.workspace}, ${JSON.stringify(payload)}::jsonb)`);
    return;
  }
  const dir = fileQueue("pending");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now().toString().padStart(15, "0")}-${job.id}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(job), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

const OWNER = `${os.hostname()}:${process.pid}`;

type JobRow = { id: string; tenant: string; workspace: string; payload: { owner: string; conversation: string | null; request: AssistantRequest } };
const toJob = (r: JobRow): AssistantJob => ({ id: r.id, tenant: r.tenant, workspace: r.workspace, owner: r.payload.owner, conversation: r.payload.conversation, request: r.payload.request });

/**
 * The next reply this worker may run, or null.
 *
 * On Postgres, one short transaction: the oldest waiting jobs, and for each
 * account among them a transaction advisory lock taken with the TRY form,
 * that account's running replies counted, and the job claimed only under the
 * cap by an UPDATE conditional on it still being unclaimed (so no job is
 * ever claimed twice).
 * The advisory lock makes count-then-claim one step per account across every
 * worker, so the cap is exact however many pods run; the try form means a
 * worker never waits on another (and two can never deadlock across
 * accounts) — an account another worker is claiming for this instant is
 * simply skipped until the next tick.
 */
export async function claimAssistantJob(): Promise<AssistantJob | null> {
  if (databaseEnabled() && orm()) {
    return tx(async (t) => {
      // Read, not locked: locking the candidates made every other worker
      // skip them all and come back empty while this one took one. The
      // UPDATE below is the claim — conditional on claimed_at IS NULL, so a
      // job another worker took meanwhile is simply not ours.
      const { rows: candidates } = await t.execute<{ id: string; tenant: string }>(sql`
        SELECT id, tenant FROM assistant_jobs WHERE claimed_at IS NULL
         ORDER BY enqueued_at, id LIMIT 20`);
      const tried = new Set<string>();
      for (const c of candidates) {
        if (tried.has(c.tenant)) continue;
        tried.add(c.tenant);
        const { rows: lock } = await t.execute<{ ok: boolean }>(sql`SELECT pg_try_advisory_xact_lock(hashtext(${`assistant:${c.tenant}`})) AS ok`);
        if (!lock[0]?.ok) continue;
        const { rows: running } = await t.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM assistant_jobs WHERE tenant = ${c.tenant} AND claimed_at IS NOT NULL`);
        if ((running[0]?.n ?? 0) >= accountCap()) continue;
        const { rows } = await t.execute<JobRow>(sql`
          UPDATE assistant_jobs SET claimed_at = now(), heartbeat_at = now(), claimed_by = ${OWNER}
           WHERE id = ${c.id} AND claimed_at IS NULL
           RETURNING id, tenant, workspace, payload`);
        if (rows[0]) return toJob(rows[0]);
      }
      return null;
    });
  }
  const pending = fileQueue("pending");
  let names: string[] = [];
  try {
    names = fs.readdirSync(pending).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return null;
  }
  const claimed = fileQueue("claimed");
  fs.mkdirSync(claimed, { recursive: true });
  const running = new Map<string, number>();
  for (const n of fs.readdirSync(claimed)) {
    try {
      const t = (JSON.parse(fs.readFileSync(path.join(claimed, n), "utf8")) as AssistantJob).tenant;
      running.set(t, (running.get(t) ?? 0) + 1);
    } catch {
      // a half-written claim counts for nothing
    }
  }
  for (const name of names) {
    let job: AssistantJob;
    try {
      job = JSON.parse(fs.readFileSync(path.join(pending, name), "utf8")) as AssistantJob;
    } catch {
      continue;
    }
    if ((running.get(job.tenant) ?? 0) >= accountCap()) continue;
    try {
      // The rename is the claim: two workers cannot both win it.
      fs.renameSync(path.join(pending, name), path.join(claimed, `${job.id}.json`));
      return job;
    } catch {
      continue;
    }
  }
  return null;
}

async function heartbeat(ids: string[]) {
  if (!ids.length) return;
  const q = databaseEnabled() ? orm() : null;
  if (!q) {
    // The file queue's heartbeat is the claim file's time.
    const now = new Date();
    for (const id of ids) {
      try {
        fs.utimesSync(path.join(fileQueue("claimed"), `${id}.json`), now, now);
      } catch {
        // released meanwhile
      }
    }
    return;
  }
  await q.execute(sql`UPDATE assistant_jobs SET heartbeat_at = now() WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
}

async function release(job: AssistantJob) {
  const q = databaseEnabled() ? orm() : null;
  if (q) {
    await q.execute(sql`DELETE FROM assistant_jobs WHERE id = ${job.id}`);
    return;
  }
  fs.rmSync(path.join(fileQueue("claimed"), `${job.id}.json`), { force: true });
}

/**
 * Replies whose worker stopped: ended with an error, never run again (at
 * most once — the first run may have spent). On a database, a claim with no
 * heartbeat for STALE_SECONDS; on files, a claim file not touched for as long.
 */
export async function reapStaleAssistantJobs(): Promise<number> {
  const q = databaseEnabled() ? orm() : null;
  const dead: { id: string; tenant: string }[] = [];
  if (q) {
    const { rows } = await q.execute<{ id: string; tenant: string }>(sql`
      DELETE FROM assistant_jobs WHERE claimed_at IS NOT NULL AND heartbeat_at < now() - make_interval(secs => ${STALE_SECONDS})
      RETURNING id, tenant`);
    dead.push(...rows);
  } else {
    const claimed = fileQueue("claimed");
    let names: string[] = [];
    try {
      names = fs.readdirSync(claimed);
    } catch {
      names = [];
    }
    for (const n of names) {
      const file = path.join(claimed, n);
      try {
        if (Date.now() - fs.statSync(file).mtimeMs < STALE_SECONDS * 1000) continue;
        const job = JSON.parse(fs.readFileSync(file, "utf8")) as AssistantJob;
        fs.rmSync(file, { force: true });
        dead.push({ id: job.id, tenant: job.tenant });
      } catch {
        fs.rmSync(file, { force: true });
      }
    }
  }
  for (const d of dead) await appendJobEvent(d.tenant, d.id, { type: "error", error: "the reply stopped part-way — the worker running it went away. If it finished after all, it is in History; otherwise ask again.", status: 503 });
  return dead.length;
}

/** Event files older than EVENTS_KEEP_MS, for every account. */
export function sweepAssistantEvents(now = Date.now()): number {
  let removed = 0;
  let tenants: string[] = [];
  try {
    tenants = fs.readdirSync(dataRoot());
  } catch {
    return 0;
  }
  for (const t of tenants) {
    const dir = path.join(dataRoot(), t, "assistant", "jobs");
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      const file = path.join(dir, n);
      try {
        if (now - fs.statSync(file).mtimeMs > EVENTS_KEEP_MS) {
          fs.rmSync(file, { force: true });
          removed++;
        }
      } catch {
        // gone already
      }
    }
  }
  return removed;
}

// ---------------------------------------------------------------- running one

/**
 * Run one claimed reply to its end: events to the file as they happen, the
 * conversation saved, the claim let go. Never throws — a failure is the
 * job's `error` event.
 */
export async function runAssistantJob(job: AssistantJob): Promise<void> {
  const started = Date.now();
  let outcome = "failed";
  await appendJobEvent(job.tenant, job.id, { type: "started" });
  const words = textBatcher(job.tenant, job.id);
  try {
    const emit = (e: AssistantEvent) => {
      if (e.type === "text") words.text(e.text);
      else if (e.type === "status") {
        words.flush();
        void appendJobEvent(job.tenant, job.id, e);
      }
    };
    // The ledger line is named for the job: a reply is charged once, by its
    // id, whatever happens to the process that ran it (recordRunCost settles
    // a run id once).
    const result = await askAssistant(job.tenant, job.workspace, job.request, { emit, chargeId: `assistant-${job.id}` });
    words.flush();
    const messages: StoredMessage[] = [
      ...job.request.messages.map((m) => ({ role: m.role, content: m.content })),
      {
        role: "assistant",
        content: result.reply,
        meta: { sources: result.sources, workspace: result.workspace, usage: result.usage, chargedUsd: result.chargedUsd, supply: result.supply },
      },
    ];
    const conversation = await saveConversation(job.tenant, {
      id: job.conversation,
      workspace: job.workspace,
      owner: job.owner,
      messages,
      files: result.files,
    }).catch((err) => {
      console.error(`[foldrun] assistant: could not save the conversation for ${job.tenant}: ${err instanceof Error ? err.message : String(err)}`);
      return job.conversation ?? "";
    });
    await appendJobEvent(job.tenant, job.id, { type: "done", result, conversation });
    outcome = "done";
  } catch (err) {
    words.flush();
    const status = (err as { status?: number }).status ?? 500;
    await appendJobEvent(job.tenant, job.id, { type: "error", error: err instanceof Error ? err.message : String(err), status }).catch((again) =>
      // Neither the end nor the error could be written anywhere: say it here,
      // where an operator reads; the follower times out, the conversation
      // (saved before the end) still has the answer.
      console.error(`[foldrun] assistant: ${job.id} ended with no event written: ${again instanceof Error ? again.message : String(again)}`),
    );
  } finally {
    await release(job).catch((err) => console.error(`[foldrun] assistant: could not release ${job.id}: ${err instanceof Error ? err.message : String(err)}`));
    // One line a reply: which pod answered whom, and how long it took.
    console.log(`[foldrun] assistant: ${job.id} ${job.tenant}/${job.workspace} ${outcome} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
}

// ---------------------------------------------------------------- the loop

let loop: { stop: () => Promise<void> } | null = null;

/**
 * The worker's assistant loop: claim while there is room, heartbeat what it
 * holds, reap the dead, sweep old event files. One per process. On stop it
 * claims nothing more and waits (up to the wall clock) for what it holds —
 * a reply cut short is spent and uncharged.
 */
export function startAssistantWorker(opts: { concurrency?: number; pollMs?: number } = {}): { stop: () => Promise<void> } {
  if (loop) return loop;
  const concurrency = opts.concurrency ?? WORKER_CONCURRENCY;
  const pollMs = opts.pollMs ?? 300;
  const held = new Map<string, Promise<void>>();
  let stopping = false;
  let lastReap = 0;
  let lastSweep = 0;

  const tick = async () => {
    if (stopping) return;
    try {
      if (Date.now() - lastReap > 30_000) {
        lastReap = Date.now();
        const n = await reapStaleAssistantJobs();
        if (n) console.log(`[foldrun] assistant: ended ${n} reply(s) whose worker went away`);
        await heartbeat([...held.keys()]);
      }
      if (Date.now() - lastSweep > 600_000) {
        lastSweep = Date.now();
        sweepAssistantEvents();
      }
      while (!stopping && held.size < concurrency) {
        const job = await claimAssistantJob();
        if (!job) break;
        const p = runAssistantJob(job).finally(() => held.delete(job.id));
        held.set(job.id, p);
      }
    } catch (err) {
      console.error(`[foldrun] assistant worker: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const timer = setInterval(() => void tick(), pollMs);
  timer.unref?.();
  const beat = setInterval(() => void heartbeat([...held.keys()]).catch(() => undefined), 20_000);
  beat.unref?.();
  void tick();
  loop = {
    async stop() {
      stopping = true;
      clearInterval(timer);
      await Promise.allSettled([...held.values()]);
      clearInterval(beat);
      loop = null;
    },
  };
  return loop;
}

/** Run one reply here and now, without a worker — tests, and an install
 *  that says so (FOLDRUN_ASSISTANT_INLINE=1). */
export async function runInline(job: AssistantJob): Promise<void> {
  await appendJobEvent(job.tenant, job.id, { type: "queued" });
  await runAssistantJob(job);
}

// ---------------------------------------------------------------- following

/**
 * Every reply this process is following, read by ONE blocking XREAD over all
 * of their streams at once: a blocking read holds its connection, so one per
 * stream would be a connection per open chat, and polling each stream would
 * be a request per chat every few hundred ms. A new stream joins at the next
 * read (at most BLOCK_MS later); its cursor makes that lose nothing.
 */
const BLOCK_MS = 1_000;

/** Each follower has its own cursor: two tabs on one reply, or a reconnect
 *  overlapping the stream it replaces, each read every event once. */
interface Watch {
  id: string;
  cursor: string;
  push: (events: JobEvent[]) => void;
}

/** Stream ids are `<ms>-<seq>`; "0" is before all. */
export function streamIdBefore(a: string, b: string): boolean {
  const [am, as = "0"] = a.split("-");
  const [bm, bs = "0"] = b.split("-");
  return BigInt(am) < BigInt(bm) || (BigInt(am) === BigInt(bm) && BigInt(as) < BigInt(bs));
}

let hub: { conn: import("ioredis").Redis; watches: Set<Watch>; running: boolean } | null = null;

function hubWatch(id: string, push: (events: JobEvent[]) => void): () => void {
  const r = cache()!;
  // Its own connection — the blocking read must not hold up every other
  // command this process sends — that queues while it connects.
  hub ??= { conn: r.duplicate({ enableOfflineQueue: true, lazyConnect: false }), watches: new Set(), running: false };
  const h = hub;
  const watch: Watch = { id, cursor: "0", push };
  h.watches.add(watch);
  if (!h.running) {
    h.running = true;
    void (async () => {
      while (h.watches.size) {
        // One read per stream, from the earliest cursor among its followers;
        // each follower then takes what is after its own. Only the followers
        // there when the read began get its results: one that joins while a
        // read is blocked waits for the next, which starts from ITS cursor —
        // otherwise the read in flight would carry it past what it never saw.
        const round = [...h.watches];
        const from = new Map<string, string>();
        for (const w of round) {
          const c = from.get(w.id);
          if (c === undefined || streamIdBefore(w.cursor, c)) from.set(w.id, w.cursor);
        }
        const ids = [...from.keys()];
        try {
          const res = (await h.conn.xread("COUNT", 500, "BLOCK", BLOCK_MS, "STREAMS", ...ids.map(streamKey), ...ids.map((i) => from.get(i)!))) as [string, [string, string[]][]][] | null;
          for (const [key, rows] of res ?? []) {
            const jobId = key.slice("assistant:events:".length);
            for (const w of round.filter((x) => x.id === jobId && h.watches.has(x))) {
              const events: JobEvent[] = [];
              for (const [entryId, fields] of rows) {
                if (!streamIdBefore(w.cursor, entryId)) continue;
                w.cursor = entryId;
                const at = fields.indexOf("e");
                if (at < 0) continue;
                try {
                  events.push(JSON.parse(fields[at + 1]) as JobEvent);
                } catch {
                  // a malformed entry is skipped
                }
              }
              if (events.length) w.push(events);
            }
          }
        } catch {
          // Redis down or reconnecting: wait, and the cursors pick up where
          // they were. A follower meanwhile still finds the end file.
          await new Promise((r) => setTimeout(r, BLOCK_MS));
        }
      }
      // Nothing left to follow: let the connection go, rather than hold one
      // idle (and hold the process open); the next follower makes another.
      h.running = false;
      if (hub === h) hub = null;
      h.conn.disconnect();
    })();
  }
  return () => {
    h.watches.delete(watch);
  };
}

/**
 * Follow a job's events until it ends (`done` or `error`), the caller stops
 * listening, or `timeoutMs` passes; resolves with the last event, or null on
 * a stop. Any web pod can follow a reply any worker is running. On Redis the
 * events come from the shared blocking read; on files they are polled. Either
 * way the end file is checked too, so the end is found even if the log lost it.
 */
export async function followJob(
  tenant: string,
  id: string,
  onEvent: (e: JobEvent) => void,
  opts: { signal?: AbortSignal; timeoutMs?: number; pollMs?: number } = {},
): Promise<JobEvent | null> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15 * 60_000);
  const pollMs = opts.pollMs ?? 150;
  if (!isJobId(id)) return null;

  return new Promise<JobEvent | null>((resolve) => {
    let finished = false;
    let unwatch: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (e: JobEvent | null) => {
      if (finished) return;
      finished = true;
      unwatch?.();
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(e);
    };
    const deliver = (events: JobEvent[]) => {
      for (const e of events) {
        if (finished) return;
        onEvent(e);
        if (isEnd(e)) return finish(e);
      }
    };
    const onAbort = () => finish(null);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) return finish(null);

    const r = cache();
    if (r) unwatch = hubWatch(id, deliver);
    let cursor = "0";
    const tick = async () => {
      if (finished) return;
      try {
        if (!r) {
          const read = await readJobEvents(tenant, id, cursor);
          cursor = read.cursor;
          deliver(read.events);
        }
        // The end, from the end file, when the log has not brought it.
        if (!finished) {
          const end = readJobEnd(tenant, id);
          if (end) deliver([end]);
        }
      } catch {
        // a read that failed is retried next tick
      }
      if (finished) return;
      if (Date.now() > deadline) {
        const timedOut: JobEvent = { type: "error", error: "no answer in time — the assistant's workers may be busy or down. Ask again in a minute.", status: 504 };
        onEvent(timedOut);
        return finish(timedOut);
      }
      // On Redis the log is pushed; the end file is a backstop, read each second.
      timer = setTimeout(() => void tick(), r ? Math.max(pollMs, 1_000) : pollMs);
    };
    void tick();
  });
}

/** Who a conversation belongs to: `<kind>:<id>` of the actor. */
export const ownerOf = (actor: { kind: string; id: string }) => `${actor.kind}:${actor.id}`;
