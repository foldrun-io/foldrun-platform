// A2A tasks — the durable map between an outside agent's request and the run
// that serves it (1 Nov 2026; foldrun-web server/a2a-service.ts is the
// protocol side).
//
// A task is written BEFORE its run is enqueued. Its key — account,
// workspace, flow, the caller's principal, the caller's messageId — is
// unique, so a retried SendMessage finds the task it already made and starts
// nothing; the fingerprint of what was sent tells a true retry from a
// different message that reused the id (an error, never a second run).
//
// The run record carries only a correlation (`trigger: "a2a"`, the task id):
// contexts, ownership and the message live here, outside the customer's
// tree. One row per task in `a2a_tasks` with a database; without one,
// data/.a2a-tasks/<account>.json, written whole under a per-account queue in
// this process (an install without a database is one process).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { and, count, desc, eq, gt, gte, inArray, isNull, lt, notInArray, or, type SQL } from "drizzle-orm";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { assertSafeName, listRunSummaries, readRun, workspaceDir, type RunRecord } from "../../foldrun-core/src/store.ts";
import { databaseEnabled, ormRequired } from "./db.ts";
import { a2aTasks } from "./schema.ts";

/** A2A 1.0's TaskState names (ProtoJSON: the enum's own names). */
export const TASK_STATES = [
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_REJECTED",
  "TASK_STATE_AUTH_REQUIRED",
] as const;
export type A2aTaskState = (typeof TASK_STATES)[number];

/** What a row says: a protocol state, or "admitting" while its start is in
 *  flight (claimed, the run not yet lined up). */
export type StoredTaskState = A2aTaskState | "admitting";

/** The states a task never leaves. */
export const TERMINAL_STATES: ReadonlySet<StoredTaskState> = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
]);

export interface A2aTask {
  /** Opaque, server-minted (a UUID). */
  id: string;
  tenant: string;
  workspace: string;
  flow: string;
  runId: string | null;
  contextId: string;
  /** The A2A key's principal (the first id of its rotation chain). */
  callerKeyId: string;
  messageId: string;
  fingerprint: string;
  state: StoredTaskState;
  createdAt: string;
  updatedAt: string;
  /** The caller's message as received (already bounded by the request limits). */
  lastMessage: unknown;
}

export type NewA2aTask = Pick<A2aTask, "tenant" | "workspace" | "flow" | "contextId" | "callerKeyId" | "messageId" | "fingerprint" | "lastMessage">;

export interface A2aTaskQuery {
  tenant: string;
  workspace: string;
  flow?: string;
  callerKeyId?: string;
  contextId?: string;
  state?: StoredTaskState;
  /**
   * Tasks that SHOW this state, as A2A sees them (1 Nov 2026, Codex review):
   * a claim still "admitting" with no run shows SUBMITTED while it is fresh
   * and FAILED once it is older than `staleBefore` (a start that died) — so
   * a filter on SUBMITTED or FAILED includes those claims, and a filter on
   * any other state is the stored state. The row itself is not changed: a
   * dead claim stays retakeable.
   */
  shown?: { state: A2aTaskState; staleBefore: string };
  /** Only tasks whose state changed after this instant (ISO). */
  updatedAfter?: string;
  /** The page after this one: the last task of the previous page. */
  after?: { updatedAt: string; id: string };
  limit: number;
}

// ----------------------------------------------------------------- the file

interface FileShape {
  v: 1;
  tasks: A2aTask[];
}

/** Terminal tasks older than this leave the file on the next write. */
const FILE_KEEP_MS = 90 * 86_400_000;

const fileOf = (tenant: string) => {
  assertSafeName(tenant, "tenant");
  return path.join(dataRoot(), ".a2a-tasks", `${tenant}.json`);
};

/** The account's tasks. Empty only when the file does not exist yet: a file
 *  that will not read or parse throws (Codex, 1 Nov 2026) — answering "no
 *  tasks" let the next claim overwrite every record and a retried message
 *  start a second billable run, so admission fails closed instead. */
function readFile(tenant: string): FileShape {
  let raw: string;
  try {
    raw = fs.readFileSync(fileOf(tenant), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { v: 1, tasks: [] };
    throw err;
  }
  const parsed = JSON.parse(raw) as FileShape;
  if (!parsed || !Array.isArray(parsed.tasks)) throw new Error(`the A2A task store for ${tenant} is unreadable — refusing to overwrite it`);
  return parsed;
}

function writeFile(tenant: string, shape: FileShape, now = Date.now()) {
  const file = fileOf(tenant);
  shape.tasks = shape.tasks.filter((t) => !(TERMINAL_STATES.has(t.state) && now - Date.parse(t.updatedAt) > FILE_KEEP_MS));
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(shape), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const fileLocks = new Map<string, Promise<unknown>>();

/** Read, change and write one account's file as one step in this process. */
async function withFile<T>(tenant: string, fn: (shape: FileShape) => T): Promise<T> {
  const turn = (fileLocks.get(tenant) ?? Promise.resolve()).catch(() => undefined).then(() => {
    const shape = readFile(tenant);
    const before = JSON.stringify(shape.tasks);
    const out = fn(shape);
    if (JSON.stringify(shape.tasks) !== before) writeFile(tenant, shape);
    return out;
  });
  fileLocks.set(tenant, turn);
  try {
    return await turn;
  } finally {
    if (fileLocks.get(tenant) === turn) fileLocks.delete(tenant);
  }
}

// ------------------------------------------------------------- the database

const toTask = (r: typeof a2aTasks.$inferSelect): A2aTask => ({
  id: r.id,
  tenant: r.tenant,
  workspace: r.workspace,
  flow: r.flow,
  runId: r.runId ?? null,
  contextId: r.contextId,
  callerKeyId: r.callerKeyId,
  messageId: r.messageId,
  fingerprint: r.requestFingerprint,
  state: r.state as StoredTaskState,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  lastMessage: r.lastMessage ?? null,
});

const sameKey = (a: Pick<A2aTask, "tenant" | "workspace" | "flow" | "callerKeyId" | "messageId">, b: typeof a) =>
  a.tenant === b.tenant && a.workspace === b.workspace && a.flow === b.flow && a.callerKeyId === b.callerKeyId && a.messageId === b.messageId;

// ------------------------------------------------------------------ the API

/**
 * Claim the task for this message, or find the one it already made. Created:
 * a new row in state "admitting", no run yet — the caller starts the run and
 * binds it (bindA2aTaskRun), or drops the claim if the start is refused.
 * Not created: the existing task, whatever its state; the caller compares
 * fingerprints.
 */
export async function claimA2aTask(t: NewA2aTask, now = new Date()): Promise<{ task: A2aTask; created: boolean }> {
  const task: A2aTask = { ...t, id: crypto.randomUUID(), runId: null, state: "admitting", createdAt: now.toISOString(), updatedAt: now.toISOString() };
  if (!databaseEnabled()) {
    return withFile(t.tenant, (shape) => {
      const hit = shape.tasks.find((x) => sameKey(x, t));
      if (hit) return { task: hit, created: false };
      shape.tasks.push(task);
      return { task, created: true };
    });
  }
  const db = ormRequired();
  const inserted = await db
    .insert(a2aTasks)
    .values({
      id: task.id,
      tenant: t.tenant,
      workspace: t.workspace,
      flow: t.flow,
      runId: null,
      contextId: t.contextId,
      callerKeyId: t.callerKeyId,
      messageId: t.messageId,
      requestFingerprint: t.fingerprint,
      state: "admitting",
      createdAt: now,
      updatedAt: now,
      lastMessage: (t.lastMessage ?? null) as object | null,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return { task: toTask(inserted[0]), created: true };
  const [hit] = await db
    .select()
    .from(a2aTasks)
    .where(and(eq(a2aTasks.tenant, t.tenant), eq(a2aTasks.workspace, t.workspace), eq(a2aTasks.flow, t.flow), eq(a2aTasks.callerKeyId, t.callerKeyId), eq(a2aTasks.messageId, t.messageId)));
  if (!hit) throw new Error("a2a task claim lost its row"); // the unique index said it was there
  return { task: toTask(hit), created: false };
}

/** One task of this account, by id — the caller checks it is the asker's. */
export async function getA2aTask(tenant: string, id: string): Promise<A2aTask | null> {
  if (!databaseEnabled()) return readFile(tenant).tasks.find((t) => t.id === id) ?? null;
  const [r] = await ormRequired().select().from(a2aTasks).where(and(eq(a2aTasks.tenant, tenant), eq(a2aTasks.id, id)));
  return r ? toTask(r) : null;
}

/** The run that serves a claimed task, and its first state. */
export async function bindA2aTaskRun(tenant: string, id: string, runId: string, state: A2aTaskState, at = new Date()): Promise<A2aTask | null> {
  // Only a row still unbound is bound (1 Nov 2026, Codex review): two
  // recoveries at once, or the original start's late bind after a recovery,
  // must not put a task that has moved on — or ended — back to SUBMITTED.
  // Whoever loses gets the row as it stands.
  if (!databaseEnabled()) {
    return withFile(tenant, (shape) => {
      const t = shape.tasks.find((x) => x.id === id);
      if (t && t.runId === null) Object.assign(t, { runId, state, updatedAt: at.toISOString() });
      return t ? { ...t } : null;
    });
  }
  const [bound] = await ormRequired()
    .update(a2aTasks)
    .set({ runId, state, updatedAt: at })
    .where(and(eq(a2aTasks.tenant, tenant), eq(a2aTasks.id, id), isNull(a2aTasks.runId)))
    .returning();
  return bound ? toTask(bound) : getA2aTask(tenant, id);
}

/** Record a task's newest state — only when it changed, so `updatedAt` is
 *  the moment the state did (what ListTasks sorts by). A terminal state is
 *  never left. */
export async function noteA2aTaskState(tenant: string, id: string, state: StoredTaskState, at: Date): Promise<void> {
  if (!databaseEnabled()) {
    await withFile(tenant, (shape) => {
      const t = shape.tasks.find((x) => x.id === id);
      if (t && t.state !== state && !TERMINAL_STATES.has(t.state)) Object.assign(t, { state, updatedAt: at.toISOString() });
    });
    return;
  }
  await ormRequired()
    .update(a2aTasks)
    .set({ state, updatedAt: at })
    .where(and(eq(a2aTasks.tenant, tenant), eq(a2aTasks.id, id), notInArray(a2aTasks.state, [...TERMINAL_STATES, state])));
}

/** Give a claim back: its start was refused, so nothing serves it, and the
 *  caller may send the same message again once the reason has passed. Only
 *  a claim with no run. */
export async function dropA2aTask(tenant: string, id: string): Promise<void> {
  if (!databaseEnabled()) {
    await withFile(tenant, (shape) => {
      shape.tasks = shape.tasks.filter((t) => !(t.id === id && t.runId === null));
    });
    return;
  }
  await ormRequired().delete(a2aTasks).where(and(eq(a2aTasks.tenant, tenant), eq(a2aTasks.id, id), isNull(a2aTasks.runId)));
}

/**
 * The run that serves an A2A task, found by the correlation its record
 * carries from its first write (`a2a.task`) — or null when none was ever
 * created. The run record is the first durable thing a start writes, so this
 * is the answer even when the task row never learned its run id (the process
 * died, or the bind failed, after the run was created): a null run_id on the
 * task does not mean no run exists.
 */
export function runOfA2aTask(tenant: string, workspace: string, taskId: string): RunRecord | null {
  // No catch (Codex review, 1 Nov 2026): a run that cannot be READ (an EFS
  // ESTALE past readRun's retries, a listing that fails) is not an absent
  // one — the error goes to the caller, so a takeover or an admission fails
  // closed instead of starting a second, billable run. A record that is
  // genuinely not there is still null.
  const rows = listRunSummaries(tenant, workspace);
  const row = rows.find((r) => r.a2a?.task === taskId);
  if (row) return readRun(tenant, workspace, row.id);
  // Not in the listing is not "not there" (Codex review, 1 Nov 2026): the
  // listing silently leaves out a record it could not parse and had no row
  // for (index updates are best-effort), and that record may be this task's
  // run. Every run file the listing does not account for is read here; one
  // that cannot be read means whose run it is cannot be told — so this
  // throws rather than answer "no run" and let a second one start.
  const dir = path.join(workspaceDir(tenant, workspace), "runs");
  if (!fs.existsSync(dir)) return null;
  const known = new Set(rows.map((r) => r.id));
  for (const f of fs.readdirSync(dir)) {
    // The listing's own filter: run records only (not the index, not runs/<id>/).
    if (!f.endsWith(".json") || f.startsWith(".")) continue;
    const id = f.slice(0, -".json".length);
    if (known.has(id)) continue;
    let run: RunRecord | null;
    try {
      run = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as RunRecord | null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // removed since the listing
      throw Object.assign(new Error(`a2a: run record ${id} in ${workspace} cannot be read, so it cannot be told whether it serves task ${taskId} — not starting another`), { cause: err });
    }
    if (run?.a2a?.task === taskId) return run;
  }
  return null;
}

/**
 * A claim with no run id, made whole if its run exists after all: the run
 * found by its correlation is bound, and the task returned as it now stands.
 * Unchanged when there is no such run (or the task already has one).
 */
export async function recoverA2aTaskRun(task: A2aTask, now = new Date()): Promise<A2aTask> {
  if (task.runId !== null) return task;
  const run = runOfA2aTask(task.tenant, task.workspace, task.id);
  if (!run) return task;
  // Bound by this call or by another first: the row as it now stands.
  return (await bindA2aTaskRun(task.tenant, task.id, run.id, "TASK_STATE_SUBMITTED", now)) ?? task;
}

/** Take over a claim whose start never finished (the process died between
 *  claiming and binding): true for exactly one taker, and only for a claim
 *  still "admitting", with no run, untouched since `staleBefore`. A claim
 *  whose run DOES exist (it was created, then the bind never landed) is not
 *  taken over: its run is bound instead, and the answer is false — the
 *  caller answers the task, and nothing starts twice. */
export async function retakeA2aTask(tenant: string, id: string, staleBefore: Date, now = new Date()): Promise<boolean> {
  const before = await getA2aTask(tenant, id);
  if (before && before.runId === null && (await recoverA2aTaskRun(before, now)).runId !== null) return false;
  if (!databaseEnabled()) {
    return withFile(tenant, (shape) => {
      const t = shape.tasks.find((x) => x.id === id);
      if (!t || t.state !== "admitting" || t.runId !== null || Date.parse(t.updatedAt) >= staleBefore.getTime()) return false;
      t.updatedAt = now.toISOString();
      return true;
    });
  }
  const got = await ormRequired()
    .update(a2aTasks)
    .set({ updatedAt: now })
    .where(and(eq(a2aTasks.tenant, tenant), eq(a2aTasks.id, id), eq(a2aTasks.state, "admitting"), isNull(a2aTasks.runId), lt(a2aTasks.updatedAt, staleBefore)))
    .returning({ id: a2aTasks.id });
  return got.length === 1;
}

/** The state a stored row shows before its run is read: a claim with no run
 *  is SUBMITTED while fresh and FAILED once stale (as foldrun-web's
 *  projection reads it); every other row its stored state. */
export function shownState(t: Pick<A2aTask, "state" | "runId" | "updatedAt">, staleBefore: string): StoredTaskState {
  if (t.state === "admitting" && t.runId === null) return Date.parse(t.updatedAt) < Date.parse(staleBefore) ? "TASK_STATE_FAILED" : "TASK_STATE_SUBMITTED";
  return t.state;
}

/** Tasks matching the query, newest state change first (then id), one page,
 *  and how many match in all. */
export async function listA2aTasks(q: A2aTaskQuery): Promise<{ tasks: A2aTask[]; total: number }> {
  const limit = Math.max(1, Math.min(500, Math.floor(q.limit)));
  if (!databaseEnabled()) {
    const matching = readFile(q.tenant).tasks.filter(
      (t) =>
        t.workspace === q.workspace &&
        (q.flow === undefined || t.flow === q.flow) &&
        (q.callerKeyId === undefined || t.callerKeyId === q.callerKeyId) &&
        (q.contextId === undefined || t.contextId === q.contextId) &&
        (q.state === undefined || t.state === q.state) &&
        (q.shown === undefined || shownState(t, q.shown.staleBefore) === q.shown.state) &&
        (q.updatedAfter === undefined || Date.parse(t.updatedAt) > Date.parse(q.updatedAfter)),
    );
    matching.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const after = q.after;
    const page = after
      ? matching.filter((t) => Date.parse(t.updatedAt) < Date.parse(after.updatedAt) || (Date.parse(t.updatedAt) === Date.parse(after.updatedAt) && t.id < after.id))
      : matching;
    return { tasks: page.slice(0, limit), total: matching.length };
  }
  const where: SQL[] = [eq(a2aTasks.tenant, q.tenant), eq(a2aTasks.workspace, q.workspace)];
  if (q.flow !== undefined) where.push(eq(a2aTasks.flow, q.flow));
  if (q.callerKeyId !== undefined) where.push(eq(a2aTasks.callerKeyId, q.callerKeyId));
  if (q.contextId !== undefined) where.push(eq(a2aTasks.contextId, q.contextId));
  if (q.state !== undefined) where.push(eq(a2aTasks.state, q.state));
  if (q.shown !== undefined) {
    const claim = and(eq(a2aTasks.state, "admitting"), isNull(a2aTasks.runId));
    const stale = new Date(q.shown.staleBefore);
    if (q.shown.state === "TASK_STATE_SUBMITTED") where.push(or(eq(a2aTasks.state, q.shown.state), and(claim, gte(a2aTasks.updatedAt, stale)))!);
    else if (q.shown.state === "TASK_STATE_FAILED") where.push(or(eq(a2aTasks.state, q.shown.state), and(claim, lt(a2aTasks.updatedAt, stale)))!);
    else where.push(eq(a2aTasks.state, q.shown.state));
  }
  if (q.updatedAfter !== undefined) where.push(gt(a2aTasks.updatedAt, new Date(q.updatedAfter)));
  const db = ormRequired();
  const [{ n }] = await db.select({ n: count() }).from(a2aTasks).where(and(...where));
  const page = [...where];
  if (q.after) {
    const at = new Date(q.after.updatedAt);
    page.push(or(lt(a2aTasks.updatedAt, at), and(eq(a2aTasks.updatedAt, at), lt(a2aTasks.id, q.after.id)))!);
  }
  const rows = await db.select().from(a2aTasks).where(and(...page)).orderBy(desc(a2aTasks.updatedAt), desc(a2aTasks.id)).limit(limit);
  return { tasks: rows.map(toTask), total: Number(n) };
}

/** A caller's tasks in a workspace that have not ended — what its
 *  outstanding cap counts, and what is refreshed before a listing. */
export async function openA2aTasks(tenant: string, workspace: string, callerKeyId: string): Promise<A2aTask[]> {
  if (!databaseEnabled()) {
    return readFile(tenant).tasks.filter((t) => t.workspace === workspace && t.callerKeyId === callerKeyId && !TERMINAL_STATES.has(t.state));
  }
  const rows = await ormRequired()
    .select()
    .from(a2aTasks)
    .where(and(eq(a2aTasks.tenant, tenant), eq(a2aTasks.workspace, workspace), eq(a2aTasks.callerKeyId, callerKeyId), notInArray(a2aTasks.state, [...TERMINAL_STATES])));
  return rows.map(toTask);
}

/** The tasks of some runs, by run id — for the runs page and the API. */
export async function a2aTasksOfRuns(tenant: string, runIds: string[]): Promise<A2aTask[]> {
  if (!runIds.length) return [];
  if (!databaseEnabled()) return readFile(tenant).tasks.filter((t) => t.runId !== null && runIds.includes(t.runId));
  const rows = await ormRequired().select().from(a2aTasks).where(and(eq(a2aTasks.tenant, tenant), inArray(a2aTasks.runId, runIds)));
  return rows.map(toTask);
}

/** Ended tasks whose last change is older than this go (the housekeeping
 *  prune below; the file store also drops them on its next write). */
export const A2A_TASK_KEEP_DAYS = 90;

/**
 * The end a run has reached, as an A2A state — the same reading foldrun-web's
 * projection makes (server/a2a-protocol.ts runState): completed, failed, a
 * stop is canceled, and a run that is gone failed. Null while it is still
 * under way.
 */
export function runEndState(run: Pick<RunRecord, "status" | "stopRequested"> | null): A2aTaskState | null {
  if (!run) return "TASK_STATE_FAILED";
  if (run.status === "completed") return "TASK_STATE_COMPLETED";
  if (run.status === "failed") return run.stopRequested ? "TASK_STATE_CANCELED" : "TASK_STATE_FAILED";
  return null;
}

/**
 * Bring every open task's stored state up to its run's (1 Nov 2026, Codex
 * review). A task's state is otherwise recorded only when someone reads it
 * — and a caller that asked for an immediate answer and never polled again
 * left it SUBMITTED for ever after its run ended, so the prune (ended tasks
 * only) kept the row and its message for good. An ended run's task is
 * marked ended, at the run's own end; a claim whose run exists after all is
 * bound to it. Every account; returns how many rows moved.
 */
export async function reconcileA2aTasks(now = new Date()): Promise<number> {
  const open: A2aTask[] = [];
  if (!databaseEnabled()) {
    for (const tenant of fileTenants()) {
      // One account's unreadable store stops its own admissions, not every
      // account's housekeeping: logged, and read again next hour.
      try {
        open.push(...readFile(tenant).tasks.filter((t) => !TERMINAL_STATES.has(t.state)));
      } catch (err) {
        console.error(`[a2a] reconcile: ${tenant}'s task store did not read — skipped: ${(err as Error).message}`);
      }
    }
  } else {
    const rows = await ormRequired().select().from(a2aTasks).where(notInArray(a2aTasks.state, [...TERMINAL_STATES]));
    open.push(...rows.map(toTask));
  }
  let moved = 0;
  for (const t of open) {
    try {
      if (t.runId === null) {
        // A claim: bound if its run exists after all; otherwise left for
        // a retry to take over (the prune drops it once past the window).
        if ((await recoverA2aTaskRun(t, now)).runId !== null) moved++;
        continue;
      }
      // A read that fails is not a run that is gone: tried again next hour.
      const run = readRun(t.tenant, t.workspace, t.runId);
      const end = runEndState(run);
      if (!end) continue;
      const at = run?.finishedAt && !Number.isNaN(Date.parse(run.finishedAt)) ? new Date(run.finishedAt) : now;
      await noteA2aTaskState(t.tenant, t.id, end, at);
      moved++;
    } catch (err) {
      console.error(`[foldrun] a2a: reconciling task ${t.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return moved;
}

/** The accounts the file store holds tasks for. */
function fileTenants(): string[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(path.join(dataRoot(), ".a2a-tasks")).filter((n) => n.endsWith(".json"));
  } catch {
    return []; // no file store yet
  }
  return names
    .map((n) => n.slice(0, -".json".length))
    .filter((tenant) => {
      try {
        assertSafeName(tenant, "tenant");
        return true;
      } catch {
        return false; // not one of ours
      }
    });
}

/**
 * Drop ended tasks (completed, failed, canceled, rejected) older than the
 * keep window, every account: the hourly housekeeping calls it. Stored
 * states are first brought up to their runs' (reconcileA2aTasks), so a task
 * whose run ended is ended here too, however nobody asked. A task still
 * open is never touched, however old — except a claim that never got a run
 * and has been dead longer than the window. Returns how many went.
 */
export async function pruneA2aTasks(now = new Date(), keepDays = A2A_TASK_KEEP_DAYS): Promise<number> {
  const cutoff = new Date(now.getTime() - keepDays * 86_400_000);
  await reconcileA2aTasks(now).catch((err) => console.error("[foldrun] a2a: reconciling tasks:", err instanceof Error ? err.message : err));
  if (!databaseEnabled()) {
    const dir = path.join(dataRoot(), ".a2a-tasks");
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
    } catch {
      return 0; // no file store yet
    }
    let gone = 0;
    for (const name of names) {
      const tenant = name.slice(0, -".json".length);
      try {
        assertSafeName(tenant, "tenant");
      } catch {
        continue; // not one of ours
      }
      gone += await withFile(tenant, (shape) => {
        const before = shape.tasks.length;
        shape.tasks = shape.tasks.filter((t) => !((TERMINAL_STATES.has(t.state) || (t.state === "admitting" && t.runId === null)) && Date.parse(t.updatedAt) < cutoff.getTime()));
        return before - shape.tasks.length;
      });
    }
    return gone;
  }
  const rows = await ormRequired()
    .delete(a2aTasks)
    .where(and(lt(a2aTasks.updatedAt, cutoff), or(inArray(a2aTasks.state, [...TERMINAL_STATES]), and(eq(a2aTasks.state, "admitting"), isNull(a2aTasks.runId)))))
    .returning({ id: a2aTasks.id });
  return rows.length;
}

/** An account is deleted: its tasks go with it. */
export async function deleteTenantA2aTasks(tenant: string): Promise<void> {
  fs.rmSync(fileOf(tenant), { force: true });
  if (databaseEnabled()) await ormRequired().delete(a2aTasks).where(eq(a2aTasks.tenant, tenant));
}
