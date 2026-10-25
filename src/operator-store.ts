// Questions an agent asked a person mid-step, and messages a person sent
// into a running step (foldrun-core operator.ts). The pod reaches them only
// through the egress proxy with its step's lease, so every key is under the
// lease's own account and run; the web routes reach them as the person
// answering. Redis when the install has one — a question posted to one
// worker is answered from the web process and read by any worker — memory
// otherwise (a laptop, a single process).
//
// Nothing here is authoritative for history: the step's trace carries every
// question, answer and delivered message, and the runner writes them onto
// the run record. These live for OPERATOR_TTL_SEC and are the live line.

import crypto from "node:crypto";
import { cache } from "./cache.ts";

export const OPERATOR_TTL_SEC = 3 * 24 * 3600;
export const QUESTION_MAX = 2_000;
export const ANSWER_MAX = 4_000;
export const MESSAGE_MAX = 4_000;
export const INBOX_MAX = 50;

export interface OpenQuestion {
  id: string;
  tenant: string;
  runId: string;
  /** The asking step's index in run.steps, when its lease said. */
  step?: number;
  question: string;
  options?: string[];
  askedAt: string;
  /** The step stopped waiting (its ask timed out): no answer is taken. */
  closed?: boolean;
  answer?: string;
  answeredAt?: string;
  by?: string | null;
}

export interface InboxMessage {
  text: string;
  by: string | null;
  at: string;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
const qKey = (t: string, r: string, id: string) => `op:q:${safe(t)}:${safe(r)}:${safe(id)}`;
const openKey = (t: string) => `op:open:${safe(t)}`;
/** One inbox per step (`step` = its index in run.steps), so parallel steps
 *  of one group never read each other's messages. Without a step: the
 *  run-level inbox, which any step of the run reads — the shape from before
 *  steps were told apart, still read so nothing already queued is lost. */
const inboxKey = (t: string, r: string, step?: number) =>
  `op:inbox:${safe(t)}:${safe(r)}${typeof step === "number" ? `:s${step}` : ""}`;

/** The steps of a run that are over (tools: [peers]): a colleague's message
 *  to one would never be read. */
const endedKey = (t: string, r: string) => `op:ended:${safe(t)}:${safe(r)}`;

// Memory: the same shapes, with expiry checked on read.
const mem = new Map<string, { value: unknown; expires: number }>();
function memGet<T>(key: string): T | null {
  const v = mem.get(key);
  if (!v) return null;
  if (v.expires < Date.now()) {
    mem.delete(key);
    return null;
  }
  return v.value as T;
}
function memSet(key: string, value: unknown) {
  mem.set(key, { value, expires: Date.now() + OPERATOR_TTL_SEC * 1000 });
}

/** A step of this run is over, every attempt: off its siblings' rosters. */
export async function markStepEnded(tenant: string, runId: string, step: number): Promise<void> {
  const key = endedKey(tenant, runId);
  const r = cache();
  if (r) await r.multi().sadd(key, String(step)).expire(key, OPERATOR_TTL_SEC).exec();
  else memSet(key, [...new Set([...(memGet<number[]>(key) ?? []), step])]);
}

/** The steps of this run that are over. */
export async function endedSteps(tenant: string, runId: string): Promise<Set<number>> {
  const r = cache();
  const raw: (string | number)[] = r ? await r.smembers(endedKey(tenant, runId)) : (memGet<number[]>(endedKey(tenant, runId)) ?? []);
  return new Set(raw.map(Number).filter(Number.isInteger));
}

/** For tests: forget everything held in memory. */
export function resetOperatorMemory(): void {
  mem.clear();
}

export async function postQuestion(tenant: string, runId: string, q: { question: string; options?: string[]; step?: number }): Promise<OpenQuestion> {
  const rec: OpenQuestion = {
    id: `q_${crypto.randomBytes(6).toString("hex")}`,
    tenant,
    runId,
    ...(typeof q.step === "number" ? { step: q.step } : {}),
    question: q.question.slice(0, QUESTION_MAX),
    ...(q.options?.length ? { options: q.options } : {}),
    askedAt: new Date().toISOString(),
  };
  const r = cache();
  if (r) {
    await r
      .multi()
      .set(qKey(tenant, runId, rec.id), JSON.stringify(rec), "EX", OPERATOR_TTL_SEC)
      .hset(openKey(tenant), `${runId}|${rec.id}`, rec.askedAt)
      .expire(openKey(tenant), OPERATOR_TTL_SEC)
      .exec();
  } else {
    memSet(qKey(tenant, runId, rec.id), rec);
    const open = memGet<Record<string, string>>(openKey(tenant)) ?? {};
    open[`${runId}|${rec.id}`] = rec.askedAt;
    memSet(openKey(tenant), open);
  }
  return rec;
}

export async function getQuestion(tenant: string, runId: string, id: string): Promise<OpenQuestion | null> {
  const r = cache();
  if (r) {
    const raw = await r.get(qKey(tenant, runId, id));
    return raw ? (JSON.parse(raw) as OpenQuestion) : null;
  }
  return memGet<OpenQuestion>(qKey(tenant, runId, id));
}

/** Answer an open question. `null` when there is no such question of this
 *  run; `already` when someone answered first (their answer stands);
 *  `closed` when the step stopped waiting for one. */
export async function answerQuestion(
  tenant: string,
  runId: string,
  id: string,
  answer: string,
  by: string | null,
): Promise<{ question: OpenQuestion; already: boolean; closed?: boolean } | null> {
  const q = await getQuestion(tenant, runId, id);
  if (!q) return null;
  if (q.answer !== undefined) return { question: q, already: true };
  if (q.closed) return { question: q, already: false, closed: true };
  const done: OpenQuestion = { ...q, answer: answer.slice(0, ANSWER_MAX), answeredAt: new Date().toISOString(), by };
  const r = cache();
  if (r) {
    // First answer wins, atomically: one script reads, checks, writes. The
    // process shares one connection, so WATCH/MULTI would interleave with
    // everyone else's commands.
    const res = (await r.eval(
      `local cur = redis.call('GET', KEYS[1])
       if not cur then return 'GONE' end
       local rec = cjson.decode(cur)
       if rec.answer ~= nil or rec.closed then return cur end
       redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
       redis.call('HDEL', KEYS[2], ARGV[3])
       return 'OK'`,
      2,
      qKey(tenant, runId, id),
      openKey(tenant),
      JSON.stringify(done),
      String(OPERATOR_TTL_SEC),
      `${runId}|${id}`,
    )) as string;
    if (res === "GONE") return null;
    if (res !== "OK") {
      const cur = JSON.parse(res) as OpenQuestion;
      return cur.answer === undefined && cur.closed ? { question: cur, already: false, closed: true } : { question: cur, already: true };
    }
  } else {
    memSet(qKey(tenant, runId, id), done);
    const open = memGet<Record<string, string>>(openKey(tenant)) ?? {};
    delete open[`${runId}|${id}`];
    memSet(openKey(tenant), open);
  }
  return { question: done, already: false };
}

/** Close a question nobody will answer now (its step stopped waiting):
 *  off the open list, and marked so a late answer is refused. An answered
 *  question keeps its answer. */
export async function closeQuestion(tenant: string, runId: string, id: string): Promise<void> {
  const r = cache();
  if (r) {
    await r.eval(
      `local cur = redis.call('GET', KEYS[1])
       if cur then
         local rec = cjson.decode(cur)
         if rec.answer == nil and not rec.closed then
           rec.closed = true
           redis.call('SET', KEYS[1], cjson.encode(rec), 'KEEPTTL')
         end
       end
       redis.call('HDEL', KEYS[2], ARGV[1])
       return 'OK'`,
      2,
      qKey(tenant, runId, id),
      openKey(tenant),
      `${runId}|${id}`,
    );
  } else {
    const q = memGet<OpenQuestion>(qKey(tenant, runId, id));
    if (q && q.answer === undefined && !q.closed) memSet(qKey(tenant, runId, id), { ...q, closed: true });
    const open = memGet<Record<string, string>>(openKey(tenant)) ?? {};
    delete open[`${runId}|${id}`];
    memSet(openKey(tenant), open);
  }
}

async function dropOpen(tenant: string, runId: string, id: string): Promise<void> {
  const r = cache();
  if (r) await r.hdel(openKey(tenant), `${runId}|${id}`);
  else {
    const open = memGet<Record<string, string>>(openKey(tenant)) ?? {};
    delete open[`${runId}|${id}`];
    memSet(openKey(tenant), open);
  }
}

/** Every unanswered question in the account, oldest first. */
export async function openQuestions(tenant: string): Promise<OpenQuestion[]> {
  const r = cache();
  const entries = r ? await r.hgetall(openKey(tenant)) : (memGet<Record<string, string>>(openKey(tenant)) ?? {});
  const out: OpenQuestion[] = [];
  for (const field of Object.keys(entries)) {
    const [runId, id] = field.split("|");
    const q = await getQuestion(tenant, runId, id);
    if (q && q.answer === undefined && !q.closed) out.push(q);
    else await dropOpen(tenant, runId, id);
  }
  return out.sort((a, b) => a.askedAt.localeCompare(b.askedAt));
}

/** Leave a message for a step (`step` = its index in run.steps), or, with
 *  no step, for whichever step of the run reads first. */
export async function postMessage(tenant: string, runId: string, text: string, by: string | null, step?: number): Promise<InboxMessage> {
  const msg: InboxMessage = { text: text.slice(0, MESSAGE_MAX), by, at: new Date().toISOString() };
  const key = inboxKey(tenant, runId, step);
  const r = cache();
  if (r) {
    await r.multi().rpush(key, JSON.stringify(msg)).ltrim(key, -INBOX_MAX, -1).expire(key, OPERATOR_TTL_SEC).exec();
  } else {
    const list = memGet<InboxMessage[]>(key) ?? [];
    list.push(msg);
    memSet(key, list.slice(-INBOX_MAX));
  }
  return msg;
}

/** Take every waiting message for this step, once: the reader owns them.
 *  A step's own inbox and the run-level one, oldest first. A lease that
 *  names no step reads only the run-level inbox. */
export async function drainInbox(tenant: string, runId: string, step?: number): Promise<InboxMessage[]> {
  const keys = typeof step === "number" ? [inboxKey(tenant, runId), inboxKey(tenant, runId, step)] : [inboxKey(tenant, runId)];
  const r = cache();
  const out: InboxMessage[] = [];
  for (const key of keys) {
    if (r) {
      const res = await r.multi().lrange(key, 0, -1).del(key).exec();
      const raw = (res?.[0]?.[1] as string[] | undefined) ?? [];
      out.push(...raw.map((x) => JSON.parse(x) as InboxMessage));
    } else {
      out.push(...(memGet<InboxMessage[]>(key) ?? []));
      mem.delete(key);
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** Messages sent to this step (or, with no step, to the run) but not yet read. */
export async function pendingMessages(tenant: string, runId: string, step?: number): Promise<InboxMessage[]> {
  const r = cache();
  const key = inboxKey(tenant, runId, step);
  if (r) return ((await r.lrange(key, 0, -1)) ?? []).map((x) => JSON.parse(x) as InboxMessage);
  return memGet<InboxMessage[]>(key) ?? [];
}

// ---------------------------------------------------------------- delegate
//
// `sandbox: own` sub-agents (foldrun-core delegate-tools.ts). A step's pod
// posts a job through the proxy's delegate door; the worker driving that
// step claims it from the step's own queue, runs it as a step of its own
// and settles it here; the door answers the pod's long-poll from the
// record. Keyed under the lease's own account, run and step, like an
// inbox: a pod can only post to, or wait on, its own step's jobs.

export const JOB_MAX = 20_000;
export const REPLY_MAX = 40_000;
/** A job's files on its record: core's COPY_BACK_MAX_BYTES (4 MiB) of
 *  decoded bytes — counted decoded, as the runner counts them, since each
 *  file's base64 pads on its own (Codex review). */
const COPY_BACK_MAX_BYTES = 4 * 1024 * 1024;
const COPY_BACK_MAX_FILES = 100;

export type DelegationStatus = "queued" | "running" | "completed" | "failed" | "skipped";

export interface DelegationRec {
  id: string;
  tenant: string;
  runId: string;
  step: number;
  agent: string;
  job: string;
  postedAt: string;
  status: DelegationStatus;
  /** The delegating step stopped waiting: a queued job is not started. */
  cancelled?: boolean;
  result?: string;
  wrote?: string[];
  /** Its files, for the delegating step's sandbox (core delegate-tools.ts
   *  copyBackFiles); capped there at COPY_BACK_MAX_BYTES before base64. */
  files?: { path: string; base64: string }[];
  filesOmitted?: string[];
  endedAt?: string;
}

const dgKey = (t: string, r: string, id: string) => `op:dg:${safe(t)}:${safe(r)}:${safe(id)}`;
const dgQueueKey = (t: string, r: string, step: number) => `op:dgq:${safe(t)}:${safe(r)}:s${step}`;
/** A cancel is its own key, never a rewrite of the record: the record is
 *  written only by the worker serving the step — queued, running, settled,
 *  in that order — so a cancel cannot race a settle and undo it. */
const dgCancelKey = (t: string, r: string, id: string) => `op:dgc:${safe(t)}:${safe(r)}:${safe(id)}`;

async function putDelegation(rec: DelegationRec): Promise<void> {
  const r = cache();
  if (r) await r.set(dgKey(rec.tenant, rec.runId, rec.id), JSON.stringify(rec), "EX", OPERATOR_TTL_SEC);
  else memSet(dgKey(rec.tenant, rec.runId, rec.id), rec);
}

export async function postDelegation(tenant: string, runId: string, d: { step: number; agent: string; job: string }): Promise<DelegationRec> {
  const rec: DelegationRec = {
    id: `d_${crypto.randomBytes(6).toString("hex")}`,
    tenant,
    runId,
    step: d.step,
    agent: d.agent,
    job: d.job.slice(0, JOB_MAX),
    postedAt: new Date().toISOString(),
    status: "queued",
  };
  await putDelegation(rec);
  const q = dgQueueKey(tenant, runId, d.step);
  const r = cache();
  if (r) await r.multi().rpush(q, rec.id).expire(q, OPERATOR_TTL_SEC).exec();
  else memSet(q, [...(memGet<string[]>(q) ?? []), rec.id]);
  return rec;
}

export async function getDelegation(tenant: string, runId: string, id: string): Promise<DelegationRec | null> {
  const r = cache();
  let rec: DelegationRec | null;
  if (r) {
    const [raw, cancelled] = await Promise.all([r.get(dgKey(tenant, runId, id)), r.get(dgCancelKey(tenant, runId, id))]);
    rec = raw ? (JSON.parse(raw) as DelegationRec) : null;
    if (rec && cancelled) rec.cancelled = true;
  } else {
    const m = memGet<DelegationRec>(dgKey(tenant, runId, id));
    rec = m ? { ...m, ...(memGet<boolean>(dgCancelKey(tenant, runId, id)) ? { cancelled: true } : {}) } : null;
  }
  return rec;
}

/** Jobs popped off a step's queue but not yet marked running: where a claim
 *  that the cache failed half-way through is found again. */
const dgClaimingKey = (t: string, r: string, step: number) => `op:dgp:${safe(t)}:${safe(r)}:s${step}`;
/** Jobs of a step that a worker has started and not settled: what a worker
 *  taking the step over must settle, since the one that started them is gone. */
const dgRunningKey = (t: string, r: string, step: number) => `op:dgr:${safe(t)}:${safe(r)}:s${step}`;

async function markRunning(tenant: string, runId: string, step: number, id: string, on: boolean): Promise<void> {
  const key = dgRunningKey(tenant, runId, step);
  const r = cache();
  if (r) {
    if (on) await r.multi().sadd(key, id).expire(key, OPERATOR_TTL_SEC).exec();
    else await r.srem(key, id);
  } else {
    const set = new Set(memGet<string[]>(key) ?? []);
    if (on) set.add(id);
    else set.delete(id);
    memSet(key, [...set]);
  }
}

/** Take a settled job off the running set — what a settle that died half-way
 *  through left behind. */
export async function clearRunning(tenant: string, runId: string, step: number, id: string): Promise<void> {
  await markRunning(tenant, runId, step, id, false);
}

/** The ids of this step's jobs some worker started and nobody settled. */
export async function runningDelegations(tenant: string, runId: string, step: number): Promise<string[]> {
  const key = dgRunningKey(tenant, runId, step);
  const r = cache();
  return r ? await r.smembers(key) : (memGet<string[]>(key) ?? []);
}

/** The next queued job of this step, marked running — or null.
 *
 *  A job moves queue → claiming list (one atomic LMOVE), is marked running,
 *  then leaves the claiming list. A cache failure between those leaves its
 *  id on the claiming list with the record still queued, and the next claim
 *  takes it from there: nothing popped is lost. Only the worker serving this
 *  step claims from it, so whatever is there is its own. No blocking pop:
 *  the cache connection is shared. */
export async function claimDelegation(
  tenant: string,
  runId: string,
  step: number,
  /** Has the calling worker already started this job? A record on the
   *  claiming list already marked running, that it has NOT started, is a
   *  claim whose write landed but whose answer was lost: its own, unstarted. */
  started: (id: string) => boolean = () => false,
): Promise<DelegationRec | null> {
  const q = dgQueueKey(tenant, runId, step);
  const claiming = dgClaimingKey(tenant, runId, step);
  const r = cache();
  const take = async (id: string): Promise<DelegationRec | null> => {
    const rec = await getDelegation(tenant, runId, id);
    if (rec?.status === "running" && !started(id)) {
      if (r) await r.lrem(claiming, 0, id).catch(() => undefined);
      return rec;
    }
    if (rec?.status === "queued") {
      if (rec.cancelled) {
        await settleDelegation(tenant, runId, id, { status: "skipped", result: "cancelled before it started" });
      } else {
        rec.status = "running";
        const { cancelled: _, ...stored } = rec;
        await markRunning(tenant, runId, rec.step, id, true);
        await putDelegation(stored);
        if (r) await r.lrem(claiming, 0, id).catch(() => undefined);
        return rec;
      }
    }
    if (r) await r.lrem(claiming, 0, id).catch(() => undefined);
    return null;
  };
  if (!r) {
    for (;;) {
      const list = memGet<string[]>(q) ?? [];
      const id = list.shift();
      memSet(q, list);
      if (!id) return null;
      const rec = await take(id);
      if (rec) return rec;
    }
  }
  // Left over from a claim the cache cut short.
  for (const id of await r.lrange(claiming, 0, -1)) {
    const rec = await take(id);
    if (rec) return rec;
  }
  for (;;) {
    const id = await r.lmove(q, claiming, "LEFT", "RIGHT");
    if (!id) return null;
    await r.expire(claiming, OPERATOR_TTL_SEC).catch(() => undefined);
    const rec = await take(id);
    if (rec) return rec;
  }
}

export async function settleDelegation(
  tenant: string,
  runId: string,
  id: string,
  out: {
    status: "completed" | "failed" | "skipped";
    result: string;
    wrote?: string[];
    files?: { path: string; base64: string }[];
    filesOmitted?: string[];
  },
): Promise<void> {
  const rec = await getDelegation(tenant, runId, id);
  if (!rec) return;
  rec.status = out.status;
  rec.result = out.result.slice(0, REPLY_MAX);
  rec.wrote = (out.wrote ?? []).slice(0, 500);
  // The runner already capped them; held to the same bound here, so a
  // record never grows past what one job may send back.
  const files: { path: string; base64: string }[] = [];
  const omitted = [...(out.filesOmitted ?? [])];
  let size = 0;
  for (const f of out.files ?? []) {
    const bytes = Buffer.byteLength(f.base64, "base64");
    if (files.length < COPY_BACK_MAX_FILES && size + bytes <= COPY_BACK_MAX_BYTES) {
      files.push(f);
      size += bytes;
    } else omitted.push(f.path);
  }
  rec.files = files;
  rec.filesOmitted = omitted.slice(0, 500);
  rec.endedAt = new Date().toISOString();
  const { cancelled: _, ...stored } = rec;
  await putDelegation(stored);
  await markRunning(tenant, runId, rec.step, id, false);
}

/** The delegating step stopped waiting for this job. */
export async function cancelDelegation(tenant: string, runId: string, id: string): Promise<boolean> {
  const rec = await getDelegation(tenant, runId, id);
  if (!rec) return false;
  const r = cache();
  if (r) await r.set(dgCancelKey(tenant, runId, id), "1", "EX", OPERATOR_TTL_SEC);
  else memSet(dgCancelKey(tenant, runId, id), true);
  return true;
}
