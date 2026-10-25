// The platform's cursor on each customer flow.
//
// A flow is a file in the workspace and stays one — this is the folder
// platform. What the platform has to REMEMBER about a flow is not the
// customer's and does not belong in their tree: when its cron last fired
// (a restart must not replay it), what its watched URL last hashed to, when
// a trigger last started a run (the throttle's floor), the burst a debounce
// is holding, and when disable_after switched it off.
//
// On one box those lived in two files, data/schedule.json and
// data/triggers.json, rewritten whole on every change. Every web pod writes
// the trigger state (a webhook is a write), so on a fleet two hooks at once
// were a lost update: one pod's rename landed over the other's. With a
// database each flow is a row, and a change to one flow touches one row.
//
// Without a database the two files remain, exactly as they were: a laptop
// has one process and the file is a fine record store for it.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { databaseEnabled, ormRequired } from "./db.ts";
import { flowState } from "./schema.ts";

// ------------------------------------------------------------------ keys

/** `tenant/workspace/flow` — the flow part may itself contain `/` or `@at`. */
export const keyOf = (tenant: string, workspace: string, flow: string) => `${tenant}/${workspace}/${flow}`;

export function splitKey(key: string): { tenant: string; workspace: string; flow: string } | null {
  const [tenant, workspace, ...rest] = key.split("/");
  if (!tenant || !workspace || rest.length === 0) return null;
  return { tenant, workspace, flow: rest.join("/") };
}

// ------------------------------------------------------- the schedule side

/** What the scheduler's tick reads and writes back: the shape schedule.json
 *  always had, so findDueFlows and its tests are untouched. */
export interface ScheduleState {
  /** key → ISO timestamp of the last fire (or first sighting). */
  lastFired: Record<string, string>;
  /** `trigger: watch` — when each URL was last read and what it hashed to. */
  watches?: Record<string, { checkedAt: string; hash: string }>;
}

const scheduleFile = () => path.join(dataRoot(), "schedule.json");

function readScheduleFile(): ScheduleState {
  if (!fs.existsSync(scheduleFile())) return { lastFired: {} };
  try {
    return JSON.parse(fs.readFileSync(scheduleFile(), "utf8"));
  } catch {
    return { lastFired: {} };
  }
}

function writeScheduleFile(state: ScheduleState) {
  fs.mkdirSync(path.dirname(scheduleFile()), { recursive: true });
  fs.writeFileSync(scheduleFile(), JSON.stringify(state, null, 2));
}

/** The whole schedule state. On the database this is every row's fire and
 *  watch columns — one query a tick, which is what the file cost too. */
export async function loadScheduleState(): Promise<ScheduleState> {
  if (!databaseEnabled()) return readScheduleFile();
  const rows = await ormRequired()
    .select({
      tenant: flowState.tenant,
      workspace: flowState.workspace,
      flow: flowState.flow,
      lastFiredAt: flowState.lastFiredAt,
      watchCheckedAt: flowState.watchCheckedAt,
      watchHash: flowState.watchHash,
    })
    .from(flowState)
    .where(sql`${flowState.lastFiredAt} IS NOT NULL OR ${flowState.watchHash} IS NOT NULL`);
  const state: ScheduleState = { lastFired: {}, watches: {} };
  for (const r of rows) {
    const key = keyOf(r.tenant, r.workspace, r.flow);
    if (r.lastFiredAt) state.lastFired[key] = r.lastFiredAt.toISOString();
    if (r.watchCheckedAt && r.watchHash) state.watches![key] = { checkedAt: r.watchCheckedAt.toISOString(), hash: r.watchHash };
  }
  return state;
}

/** Write back what changed since `before`. Only the touched rows are
 *  upserted, so a tick that fired two flows writes two rows, not the
 *  history of every flow on the install. */
export async function saveScheduleState(before: ScheduleState, after: ScheduleState): Promise<void> {
  if (!databaseEnabled()) {
    if (JSON.stringify(before) !== JSON.stringify(after)) writeScheduleFile(after);
    return;
  }
  const patches = new Map<string, { lastFiredAt?: Date; watchCheckedAt?: Date; watchHash?: string }>();
  for (const [key, at] of Object.entries(after.lastFired)) {
    if (before.lastFired[key] !== at) patches.set(key, { ...patches.get(key), lastFiredAt: new Date(at) });
  }
  for (const [key, w] of Object.entries(after.watches ?? {})) {
    const prev = before.watches?.[key];
    if (!prev || prev.hash !== w.hash || prev.checkedAt !== w.checkedAt) {
      patches.set(key, { ...patches.get(key), watchCheckedAt: new Date(w.checkedAt), watchHash: w.hash });
    }
  }
  for (const [key, patch] of patches) {
    const k = splitKey(key);
    if (!k) continue;
    await upsertFlowRow(k, patch);
  }
}

// -------------------------------------------------------- the trigger side

export interface Pending {
  /** When the quiet window ends and this becomes a run. */
  firesAt: number;
  /** The task text of the LAST event in the burst. */
  body: string;
  tag: string;
  /** How many events collapsed into this one. */
  count: number;
}

/** The gates' memory of one flow. `undefined` fields are "nothing recorded". */
export interface FlowCursor {
  /** When a trigger last started a run — the throttle measures from here. */
  lastRunAt?: number;
  /** The burst a debounce is holding. */
  pending?: Pending;
  /** When disable_after switched the flow off and the notice was sent. */
  quarantinedAt?: number;
}

/** A delivery id already handled — the file fallback for idempotency when
 *  there is no Redis. sha256 of tenant/workspace/flow/key, never the key. */
export interface Seen {
  h: string;
  at: number;
  t?: string;
  runId?: string;
}

/** The file's shape, kept so an install without a database changes nothing. */
export interface TriggerFile {
  lastRun?: Record<string, number>;
  pending?: Record<string, Pending>;
  seen?: Seen[];
  quarantined?: Record<string, number>;
}

const triggerFile = () => path.join(dataRoot(), "triggers.json");

export function readTriggerFile(): TriggerFile {
  try {
    return JSON.parse(fs.readFileSync(triggerFile(), "utf8")) as TriggerFile;
  } catch {
    return {};
  }
}

export function writeTriggerFile(state: TriggerFile): void {
  fs.mkdirSync(path.dirname(triggerFile()), { recursive: true });
  // pid AND a random suffix: containers give node the same pid in every
  // pod, and two pods sharing one temp path on the volume tear the file.
  const tmp = `${triggerFile()}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, triggerFile());
}

/** For tests: the file, emptied (and the table, when there is one). */
export async function resetFlowState(): Promise<void> {
  try {
    fs.rmSync(triggerFile(), { force: true });
    fs.rmSync(scheduleFile(), { force: true });
  } catch {
    /* nothing to clear */
  }
  if (databaseEnabled()) await ormRequired().delete(flowState);
}

export async function getCursor(tenant: string, workspace: string, flow: string): Promise<FlowCursor> {
  if (!databaseEnabled()) {
    const f = readTriggerFile();
    const key = keyOf(tenant, workspace, flow);
    const c: FlowCursor = {};
    if (f.lastRun?.[key]) c.lastRunAt = f.lastRun[key];
    if (f.pending?.[key]) c.pending = f.pending[key];
    if (f.quarantined?.[key]) c.quarantinedAt = f.quarantined[key];
    return c;
  }
  const [r] = await ormRequired()
    .select({ lastRunAt: flowState.lastRunAt, pending: flowState.pending, quarantinedAt: flowState.quarantinedAt })
    .from(flowState)
    .where(and(eq(flowState.tenant, tenant), eq(flowState.workspace, workspace), eq(flowState.flow, flow)));
  const c: FlowCursor = {};
  if (r?.lastRunAt) c.lastRunAt = r.lastRunAt.getTime();
  if (r?.pending) c.pending = r.pending as Pending;
  if (r?.quarantinedAt) c.quarantinedAt = r.quarantinedAt.getTime();
  return c;
}

/** Replace the gates' memory of one flow. A field left undefined is cleared. */
export async function setCursor(tenant: string, workspace: string, flow: string, c: FlowCursor): Promise<void> {
  if (!databaseEnabled()) {
    const f = readTriggerFile();
    const key = keyOf(tenant, workspace, flow);
    f.lastRun ??= {};
    f.pending ??= {};
    f.quarantined ??= {};
    if (c.lastRunAt) f.lastRun[key] = c.lastRunAt;
    else delete f.lastRun[key];
    if (c.pending) f.pending[key] = c.pending;
    else delete f.pending[key];
    if (c.quarantinedAt) f.quarantined[key] = c.quarantinedAt;
    else delete f.quarantined[key];
    writeTriggerFile(f);
    return;
  }
  await upsertFlowRow(
    { tenant, workspace, flow },
    {
      lastRunAt: c.lastRunAt ? new Date(c.lastRunAt) : null,
      pending: c.pending ?? null,
      quarantinedAt: c.quarantinedAt ? new Date(c.quarantinedAt) : null,
    },
  );
}

/** Every burst being held, for the tick that fires the ones whose window passed. */
export async function heldBursts(): Promise<{ tenant: string; workspace: string; flow: string; pending: Pending }[]> {
  if (!databaseEnabled()) {
    const f = readTriggerFile();
    const out: { tenant: string; workspace: string; flow: string; pending: Pending }[] = [];
    for (const [key, pending] of Object.entries(f.pending ?? {})) {
      const k = splitKey(key);
      if (k) out.push({ ...k, pending });
    }
    return out;
  }
  const rows = await ormRequired()
    .select({ tenant: flowState.tenant, workspace: flowState.workspace, flow: flowState.flow, pending: flowState.pending })
    .from(flowState)
    .where(isNotNull(flowState.pending));
  return rows.map((r) => ({ tenant: r.tenant, workspace: r.workspace, flow: r.flow, pending: r.pending as Pending }));
}

/** Every flow currently switched off, for the operator's health page. */
export async function quarantinedFlows(): Promise<{ tenant: string; workspace: string; flow: string; since: string }[]> {
  if (!databaseEnabled()) {
    const f = readTriggerFile();
    const out: { tenant: string; workspace: string; flow: string; since: string }[] = [];
    for (const [key, at] of Object.entries(f.quarantined ?? {})) {
      const k = splitKey(key);
      if (k) out.push({ ...k, since: new Date(at).toISOString() });
    }
    return out;
  }
  const rows = await ormRequired()
    .select({ tenant: flowState.tenant, workspace: flowState.workspace, flow: flowState.flow, at: flowState.quarantinedAt })
    .from(flowState)
    .where(isNotNull(flowState.quarantinedAt));
  return rows.map((r) => ({ tenant: r.tenant, workspace: r.workspace, flow: r.flow, since: r.at!.toISOString() }));
}

// ------------------------------------------------------------------ rows

type Patch = Partial<{
  lastFiredAt: Date | null;
  watchCheckedAt: Date | null;
  watchHash: string | null;
  lastRunAt: Date | null;
  pending: unknown;
  quarantinedAt: Date | null;
}>;

/** Insert or update one flow's row, touching only the columns given. */
async function upsertFlowRow(k: { tenant: string; workspace: string; flow: string }, patch: Patch): Promise<void> {
  const set = { ...patch, updatedAt: new Date() };
  await ormRequired()
    .insert(flowState)
    .values({ ...k, ...patch })
    .onConflictDoUpdate({ target: [flowState.tenant, flowState.workspace, flowState.flow], set });
}

/** The two files into rows, once. A row already there is kept: it is newer. */
export async function importFlowStateFiles(): Promise<number> {
  if (!databaseEnabled()) return 0;
  let n = 0;
  const day = new Date().toISOString().slice(0, 10);
  if (fs.existsSync(scheduleFile())) {
    const s = readScheduleFile();
    for (const key of new Set([...Object.keys(s.lastFired), ...Object.keys(s.watches ?? {})])) {
      const k = splitKey(key);
      if (!k) continue;
      const at = s.lastFired[key];
      const w = s.watches?.[key];
      await ormRequired()
        .insert(flowState)
        .values({ ...k, lastFiredAt: at ? new Date(at) : null, watchCheckedAt: w ? new Date(w.checkedAt) : null, watchHash: w?.hash ?? null })
        .onConflictDoNothing();
      n++;
    }
    fs.renameSync(scheduleFile(), `${scheduleFile()}.imported-${day}`);
  }
  if (fs.existsSync(triggerFile())) {
    const t = readTriggerFile();
    const keys = new Set([...Object.keys(t.lastRun ?? {}), ...Object.keys(t.pending ?? {}), ...Object.keys(t.quarantined ?? {})]);
    for (const key of keys) {
      const k = splitKey(key);
      if (!k) continue;
      const patch: Patch = {
        lastRunAt: t.lastRun?.[key] ? new Date(t.lastRun[key]) : null,
        pending: t.pending?.[key] ?? null,
        quarantinedAt: t.quarantined?.[key] ? new Date(t.quarantined[key]) : null,
      };
      // The gate columns are the only ones this file knows; a row the
      // schedule import just made keeps its fire columns.
      await ormRequired()
        .insert(flowState)
        .values({ ...k, ...patch })
        .onConflictDoUpdate({ target: [flowState.tenant, flowState.workspace, flowState.flow], set: patch });
      n++;
    }
    fs.renameSync(triggerFile(), `${triggerFile()}.imported-${day}`);
  }
  return n;
}

/** Everything the platform remembered about an account's flows. */
export async function deleteFlowState(tenant: string): Promise<number> {
  if (!databaseEnabled()) return 0;
  return (await ormRequired().delete(flowState).where(eq(flowState.tenant, tenant)).returning({ flow: flowState.flow })).length;
}
