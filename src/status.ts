// The status page: is the platform up, and what is the operator saying.
//
// Two halves with two cadences. The SAMPLER runs inside the scheduler's tick
// (so on whichever worker holds the scheduler lease, never on a laptop job),
// every five minutes: it probes each component and writes one row per
// component per five-minute bucket, kept ninety days. Those rows are the
// 90-day bars. The READ — what GET /api/status answers — must be cheap,
// because it is an open route anyone can call: it takes the few checks that
// cost a lease peek or a SELECT live, and the network probes from the latest
// sample. It never reads run files or calls a provider on a request.
//
// Every component's status is derived from a signal the platform already
// had: healthz's database and lease checks, the queue's oldest job, the
// scheduler's own tick (a sample is written only from inside it, so a stale
// sample IS a stalled scheduler), step errors in the run records, and plain
// reachability of the model and mail APIs. Nothing here instruments anything
// new, and nothing here is a number we cannot point at.
//
// Incidents and maintenance are records too: the super admin writes them
// (web /api/admin/incidents), customers read them. Without a database both
// halves fall back to files under <data>/status/, as every platform record
// does on a laptop.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { listTenants, listWorkspaces, workspaceDir, type RunRecord } from "../../foldrun-core/src/store.ts";
import { databaseEnabled, databaseReady, ormRequired } from "./db.ts";
import { statusIncidents, statusSamples } from "./schema.ts";
import { peekWorkerLease, queueStats } from "./queue.ts";

// ------------------------------------------------------------------ model

export type ComponentId = "web" | "workers" | "scheduler" | "providers" | "email" | "storage";
export type Level = "operational" | "degraded" | "outage" | "maintenance" | "unknown";

export const COMPONENTS: { id: ComponentId; name: string; describes: string }[] = [
  { id: "web", name: "Dashboard and API", describes: "the dashboard, the HTTP API and sign-in" },
  { id: "workers", name: "Run workers", describes: "the processes that drive runs, and the queue they claim from" },
  { id: "scheduler", name: "Scheduler", describes: "scheduled, watched and debounced flows firing on time" },
  { id: "providers", name: "Model providers", describes: "reaching the model API, and step errors that came from it" },
  { id: "email", name: "Email", describes: "the platform's own mail: invites, resets, notices" },
  { id: "storage", name: "Storage", describes: "the database and the workspace volume" },
];
const IDS = new Set<string>(COMPONENTS.map((c) => c.id));

export interface Probe {
  status: Level;
  detail: string;
}

export const SAMPLE_MS = () => Number(process.env.FOLDRUN_STATUS_SAMPLE_MS) || 5 * 60_000;
/** A sample older than this is not "the current state". Three missed
 *  samples: one late tick is not an outage, fifteen silent minutes is. */
const FRESH_MS = () => SAMPLE_MS() * 3;
export const KEEP_DAYS = 90;
const DAY = 86_400_000;

const RANK: Record<Level, number> = { unknown: 0, operational: 0, maintenance: 1, degraded: 2, outage: 3 };
const worse = (a: Level, b: Level): Level => (RANK[b] > RANK[a] ? b : a);

// ------------------------------------------------------------------ probes

const TIMEOUT_MS = 5000;

/** Any HTTP answer below 500 means the host is there and serving; a 5xx is
 *  the host saying it is not well; no answer at all is down. Unauthenticated
 *  on purpose: this asks "can we reach it", and spends no credential. */
async function reach(url: string, label: string): Promise<Probe> {
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "manual" });
    if (res.status >= 500) return { status: "degraded", detail: `${label} answered HTTP ${res.status}` };
    return { status: "operational", detail: `${label} reachable` };
  } catch (err) {
    return { status: "outage", detail: `${label} did not answer (${err instanceof Error ? err.message : String(err)})` };
  }
}

/** Errors that came from the model provider rather than from the agent's
 *  own work: the API's error types, its rate and overload answers, and a
 *  credential it refused. A tool failing or a verify not holding is not
 *  the provider and must not count. */
export const PROVIDER_ERROR =
  /overloaded|rate[_ ]?limit(ed)?_?error|authentication_error|permission_error|api_error|invalid x-api-key|oauth token (has )?expired|API Error: (401|403|429|5\d\d)|\b529\b/i;

/** The provider refusing a CREDENTIAL, not being unwell. The credential may
 *  be the account's own (an agent's `provider:`, BYOK), and one customer's
 *  expired key is not an outage on the public page; the same refusal in two
 *  accounts within the hour is the platform's credential, and counts. */
export const CREDENTIAL_ERROR = /authentication_error|permission_error|invalid x-api-key|oauth token (has )?expired|API Error: (401|403)\b/i;

/** Run ids are `run-<base36 ms>-<rand>`, so the files worth opening can be
 *  chosen from a directory listing alone — the scan never reads a run that
 *  started before the window, which on a volume of 30k run files is the
 *  difference between a probe and a load. */
export function runStartedAt(file: string): number | null {
  const m = /^run-([0-9a-z]+)-/.exec(file);
  if (!m) return null;
  const t = parseInt(m[1], 36);
  return Number.isFinite(t) && t > 1_500_000_000_000 && t < 4_000_000_000_000 ? t : null;
}

/** Step attempts finished in the last hour, and how many failed with a
 *  provider error — a refused credential only when two accounts saw one. Runs that started within six hours are opened; older
 *  ones cannot have an attempt this recent unless a step ran for hours. */
export function providerErrors(now = Date.now()): { attempts: number; failed: number } {
  const since = now - 3600_000;
  let attempts = 0;
  let failed = 0;
  const refused = new Map<string, number>();
  for (const tenant of listTenants()) {
    let workspaces: { name: string }[];
    try {
      workspaces = listWorkspaces(tenant);
    } catch {
      continue;
    }
    for (const ws of workspaces) {
      const dir = path.join(workspaceDir(tenant, ws.name), "runs");
      let files: string[];
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        const t = runStartedAt(f);
        if (t === null || t < now - 6 * 3600_000 || !f.endsWith(".json")) continue;
        let run: RunRecord;
        try {
          run = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as RunRecord;
        } catch {
          continue;
        }
        for (const step of run.steps ?? []) {
          for (const a of step.tries ?? []) {
            if (!a.finishedAt || Date.parse(a.finishedAt) < since) continue;
            attempts++;
            if (a.status !== "failed" || !a.error || !PROVIDER_ERROR.test(a.error)) continue;
            if (CREDENTIAL_ERROR.test(a.error)) refused.set(tenant, (refused.get(tenant) ?? 0) + 1);
            else failed++;
          }
        }
      }
    }
  }
  if (refused.size >= 2) for (const n of refused.values()) failed += n;
  return { attempts, failed };
}

async function probeWeb(): Promise<Probe> {
  // Through the public address when there is one: the path a customer takes,
  // tunnel and all. On a single-process install the sampler IS the web.
  const base = process.env.FOLDRUN_STATUS_WEB_URL || process.env.FOLDRUN_PUBLIC_URL;
  if (!base) {
    return (process.env.FOLDRUN_ROLE ?? "all") === "all"
      ? { status: "operational", detail: "served by this process" }
      : { status: "unknown", detail: "no FOLDRUN_PUBLIC_URL to probe" };
  }
  try {
    const res = await fetch(new URL("/api/healthz", base), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { status: "outage", detail: `healthz answered HTTP ${res.status}` };
    const body = (await res.json().catch(() => ({}))) as { database?: boolean | null };
    if (body.database === false) return { status: "degraded", detail: "serving, but the database is not answering" };
    return { status: "operational", detail: "healthz ok" };
  } catch (err) {
    return { status: "outage", detail: `healthz did not answer (${err instanceof Error ? err.message : String(err)})` };
  }
}

async function probeWorkers(): Promise<Probe> {
  const [alive, q] = await Promise.all([peekWorkerLease(), queueStats()]);
  if (!alive) return { status: "outage", detail: "no worker holds the lease" };
  if (q.oldestPendingSecs !== null && q.oldestPendingSecs > 600) {
    return { status: "degraded", detail: `runs are waiting: the oldest queued job has waited ${Math.round(q.oldestPendingSecs / 60)} min` };
  }
  return { status: "operational", detail: `${q.pending} waiting, ${q.claimed} running` };
}

async function probeProviders(now: number): Promise<Probe> {
  const net = await reach("https://api.anthropic.com/", "api.anthropic.com");
  let scan = { attempts: 0, failed: 0 };
  try {
    scan = providerErrors(now);
  } catch {
    /* the reachability answer still stands */
  }
  let status = net.status;
  let detail = net.detail;
  if (scan.failed >= 3 && scan.failed * 2 >= scan.attempts) {
    status = worse(status, "outage");
    detail = `${scan.failed} of ${scan.attempts} step attempts in the last hour failed at the model provider`;
  } else if (scan.failed >= 2) {
    status = worse(status, "degraded");
    detail = `${scan.failed} of ${scan.attempts} step attempts in the last hour failed at the model provider`;
  } else if (status === "operational") {
    detail = `${net.detail}; ${scan.failed} provider error(s) in ${scan.attempts} attempt(s) this hour`;
  }
  return { status, detail };
}

async function probeEmail(): Promise<Probe> {
  if (!process.env.FOLDRUN_RESEND_API_KEY) return { status: "unknown", detail: "no platform mail credential on this install" };
  return reach("https://api.resend.com/", "api.resend.com");
}

async function probeStorage(): Promise<Probe> {
  const problems: string[] = [];
  let down = false;
  if (databaseEnabled()) {
    const ok = await databaseReady().catch(() => false);
    if (!ok) {
      down = true;
      problems.push("the database is not answering");
    }
  }
  try {
    fs.accessSync(dataRoot(), fs.constants.W_OK);
  } catch {
    down = true;
    problems.push("the workspace volume is not writable");
  }
  return down ? { status: "outage", detail: problems.join("; ") } : { status: "operational", detail: databaseEnabled() ? "database and volume answering" : "volume writable" };
}

/** Every component, probed now. The scheduler is operational by
 *  construction: this runs from inside its tick. */
export async function probeAll(now = Date.now()): Promise<Record<ComponentId, Probe>> {
  const safe = (p: Promise<Probe>) => p.catch((err): Probe => ({ status: "unknown", detail: `probe failed: ${err instanceof Error ? err.message : String(err)}` }));
  const [web, workers, providers, email, storage] = await Promise.all([
    safe(probeWeb()),
    safe(probeWorkers()),
    safe(probeProviders(now)),
    safe(probeEmail()),
    safe(probeStorage()),
  ]);
  return { web, workers, scheduler: { status: "operational", detail: "ticking" }, providers, email, storage };
}

// ------------------------------------------------------------------ samples

export interface Sample {
  component: ComponentId;
  at: number;
  status: Level;
  detail: string;
}

const statusDir = () => path.join(dataRoot(), "status");
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);
const sampleFile = (day: string) => path.join(statusDir(), `samples-${day}.jsonl`);
const bucket = (t: number) => t - (t % SAMPLE_MS());

export async function writeSamples(samples: Sample[]): Promise<void> {
  if (!samples.length) return;
  if (!databaseEnabled()) {
    fs.mkdirSync(statusDir(), { recursive: true });
    const byDay = new Map<string, string[]>();
    for (const s of samples) {
      const k = dayKey(s.at);
      byDay.set(k, [...(byDay.get(k) ?? []), JSON.stringify({ c: s.component, at: s.at, s: s.status, d: s.detail })]);
    }
    for (const [day, lines] of byDay) fs.appendFileSync(sampleFile(day), lines.join("\n") + "\n");
    return;
  }
  await ormRequired()
    .insert(statusSamples)
    .values(samples.map((s) => ({ component: s.component, at: new Date(s.at), status: s.status, detail: s.detail.slice(0, 500) })))
    .onConflictDoUpdate({ target: [statusSamples.component, statusSamples.at], set: { status: sql`excluded.status`, detail: sql`excluded.detail` } });
}

function readFileSamples(sinceMs: number): Sample[] {
  let files: string[];
  try {
    files = fs.readdirSync(statusDir()).filter((f) => /^samples-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  } catch {
    return [];
  }
  const sinceDay = dayKey(sinceMs);
  const out: Sample[] = [];
  for (const f of files.sort()) {
    if (f.slice(8, 18) < sinceDay) continue;
    for (const line of fs.readFileSync(path.join(statusDir(), f), "utf8").split("\n")) {
      if (!line) continue;
      try {
        const r = JSON.parse(line) as { c: ComponentId; at: number; s: Level; d: string };
        if (r.at >= sinceMs) out.push({ component: r.c, at: r.at, status: r.s, detail: r.d });
      } catch {
        /* a torn last line */
      }
    }
  }
  return out;
}

/** The newest sample of each component, if one was taken since `sinceMs`. */
export async function latestSamples(sinceMs: number): Promise<Partial<Record<ComponentId, Sample>>> {
  const rows: Sample[] = databaseEnabled()
    ? (
        await ormRequired()
          .select()
          .from(statusSamples)
          .where(gte(statusSamples.at, new Date(sinceMs)))
          .orderBy(desc(statusSamples.at))
          .limit(COMPONENTS.length * 50)
      ).map((r) => ({ component: r.component as ComponentId, at: r.at.getTime(), status: r.status as Level, detail: r.detail ?? "" }))
    : readFileSamples(sinceMs).sort((a, b) => b.at - a.at);
  const out: Partial<Record<ComponentId, Sample>> = {};
  for (const r of rows) if (IDS.has(r.component) && !out[r.component]) out[r.component] = r;
  return out;
}

/** Forget samples older than ninety days. */
export async function pruneSamples(now = Date.now()): Promise<void> {
  const before = now - KEEP_DAYS * DAY;
  if (!databaseEnabled()) {
    const cut = dayKey(before);
    try {
      for (const f of fs.readdirSync(statusDir())) {
        const m = /^samples-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
        if (m && m[1] < cut) fs.rmSync(path.join(statusDir(), f), { force: true });
      }
    } catch {
      /* no directory, nothing to prune */
    }
    return;
  }
  await ormRequired().delete(statusSamples).where(lt(statusSamples.at, new Date(before)));
}

let lastSampleAt = 0;
let lastPruneDay = "";
let sampling = false;

/**
 * Called from every scheduler tick; samples at most once per SAMPLE_MS, into
 * the five-minute bucket the tick falls in. The caller holds the scheduler
 * lease, so one pod samples; the bucket key makes a second one harmless.
 */
export async function maybeSampleStatus(now = Date.now()): Promise<boolean> {
  if (sampling || now - lastSampleAt < SAMPLE_MS()) return false;
  sampling = true;
  try {
    lastSampleAt = now;
    const probes = await probeAll(now);
    const at = bucket(now);
    await writeSamples(COMPONENTS.map((c) => ({ component: c.id, at, status: probes[c.id].status, detail: probes[c.id].detail })));
    const today = dayKey(now);
    if (today !== lastPruneDay) {
      lastPruneDay = today;
      await pruneSamples(now);
    }
    return true;
  } finally {
    sampling = false;
  }
}

/** For tests: sample again on the next call, and drop the cached status and history. */
export function resetStatusSampler(): void {
  lastSampleAt = 0;
  lastPruneDay = "";
  sampling = false;
  current.clear();
  histories.clear();
}

// ------------------------------------------------------------------ incidents

export type IncidentKind = "incident" | "maintenance";
export type Impact = "minor" | "major" | "maintenance";
export const INCIDENT_STATUSES = ["investigating", "identified", "monitoring", "resolved"] as const;
export const MAINTENANCE_STATUSES = ["scheduled", "in_progress", "completed"] as const;

export interface IncidentUpdate {
  at: string;
  status: string;
  body: string;
  /** Who wrote it. Kept for the operator; stripped from the public view. */
  by?: string;
}

export interface Incident {
  id: string;
  kind: IncidentKind;
  title: string;
  impact: Impact;
  status: string;
  components: ComponentId[];
  updates: IncidentUpdate[];
  startsAt: string;
  endsAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  createdBy: string;
}

export class StatusInputError extends Error {}

const incidentsFile = () => path.join(statusDir(), "incidents.json");
function readIncidentFile(): Incident[] {
  try {
    return JSON.parse(fs.readFileSync(incidentsFile(), "utf8")) as Incident[];
  } catch {
    return [];
  }
}
function writeIncidentFile(all: Incident[]) {
  fs.mkdirSync(statusDir(), { recursive: true });
  const tmp = `${incidentsFile()}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, incidentsFile());
}

const toRow = (i: Incident) => ({
  id: i.id,
  kind: i.kind,
  title: i.title,
  impact: i.impact,
  status: i.status,
  components: i.components,
  updates: i.updates,
  startsAt: new Date(i.startsAt),
  endsAt: i.endsAt ? new Date(i.endsAt) : null,
  resolvedAt: i.resolvedAt ? new Date(i.resolvedAt) : null,
  createdAt: new Date(i.createdAt),
  createdBy: i.createdBy,
});
const fromRow = (r: typeof statusIncidents.$inferSelect): Incident => ({
  id: r.id,
  kind: r.kind as IncidentKind,
  title: r.title,
  impact: r.impact as Impact,
  status: r.status,
  components: (r.components as ComponentId[]) ?? [],
  updates: (r.updates as IncidentUpdate[]) ?? [],
  startsAt: r.startsAt.toISOString(),
  endsAt: r.endsAt?.toISOString() ?? null,
  resolvedAt: r.resolvedAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
  createdBy: r.createdBy,
});

/** Newest first. `sinceMs` keeps incidents that started, or were still
 *  open, after it. */
export async function listIncidents(sinceMs = 0): Promise<Incident[]> {
  const all = databaseEnabled()
    ? (await ormRequired().select().from(statusIncidents).orderBy(desc(statusIncidents.startsAt)).limit(500)).map(fromRow)
    : readIncidentFile().sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  return all.filter((i) => Date.parse(i.startsAt) >= sinceMs || !i.resolvedAt || Date.parse(i.resolvedAt) >= sinceMs);
}

export async function getIncident(id: string): Promise<Incident | null> {
  if (!databaseEnabled()) return readIncidentFile().find((i) => i.id === id) ?? null;
  const [r] = await ormRequired().select().from(statusIncidents).where(eq(statusIncidents.id, id));
  return r ? fromRow(r) : null;
}

async function saveIncident(i: Incident): Promise<void> {
  if (!databaseEnabled()) {
    const all = readIncidentFile().filter((x) => x.id !== i.id);
    writeIncidentFile([i, ...all]);
    return;
  }
  const row = toRow(i);
  await ormRequired().insert(statusIncidents).values(row).onConflictDoUpdate({ target: statusIncidents.id, set: row });
}

export async function deleteIncident(id: string): Promise<boolean> {
  if (!databaseEnabled()) {
    const all = readIncidentFile();
    const left = all.filter((i) => i.id !== id);
    if (left.length === all.length) return false;
    writeIncidentFile(left);
    return true;
  }
  return (await ormRequired().delete(statusIncidents).where(eq(statusIncidents.id, id)).returning({ id: statusIncidents.id })).length > 0;
}

function str(v: unknown, field: string, max: number, required = true): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (required) throw new StatusInputError(`${field} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new StatusInputError(`${field} must be a string`);
  const s = v.trim();
  if (required && !s) throw new StatusInputError(`${field} is required`);
  if (s.length > max) throw new StatusInputError(`${field} is longer than ${max} characters`);
  return s;
}
function when(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const t = typeof v === "string" || typeof v === "number" ? Date.parse(String(v)) : NaN;
  if (!Number.isFinite(t)) throw new StatusInputError(`${field} must be an ISO date-time`);
  return new Date(t).toISOString();
}
function components(v: unknown): ComponentId[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new StatusInputError("components must be a list");
  for (const c of v) if (typeof c !== "string" || !IDS.has(c)) throw new StatusInputError(`unknown component "${String(c)}" — one of ${[...IDS].join(", ")}`);
  return [...new Set(v as ComponentId[])];
}
function statusFor(kind: IncidentKind, v: unknown, fallback: string): string {
  const s = str(v, "status", 40, false) ?? fallback;
  const allowed: readonly string[] = kind === "incident" ? INCIDENT_STATUSES : MAINTENANCE_STATUSES;
  if (!allowed.includes(s)) throw new StatusInputError(`status for ${kind === "incident" ? "an incident" : "maintenance"} is one of ${allowed.join(", ")}`);
  return s;
}
const closing = (s: string) => s === "resolved" || s === "completed";

/** Post an incident (it starts now) or schedule maintenance (a window). */
export async function createIncident(input: Record<string, unknown>, by: string, now = Date.now()): Promise<Incident> {
  const kind = input.kind === "maintenance" ? "maintenance" : input.kind === undefined || input.kind === "incident" ? "incident" : null;
  if (!kind) throw new StatusInputError('kind is "incident" or "maintenance"');
  const title = str(input.title, "title", 200)!;
  const body = str(input.body ?? input.message, "body", 5000)!;
  let impact: Impact;
  if (kind === "maintenance") impact = "maintenance";
  else if (input.impact === undefined || input.impact === "minor" || input.impact === "major") impact = (input.impact as Impact) ?? "minor";
  else throw new StatusInputError('impact is "minor" or "major"');
  const status = statusFor(kind, input.status, kind === "incident" ? "investigating" : "scheduled");
  const startsAt = when(input.startsAt, "startsAt") ?? new Date(now).toISOString();
  const endsAt = when(input.endsAt, "endsAt") ?? null;
  if (kind === "maintenance" && !endsAt) throw new StatusInputError("maintenance needs endsAt — when the window closes");
  if (endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) throw new StatusInputError("endsAt must be after startsAt");
  const at = new Date(now).toISOString();
  const incident: Incident = {
    id: `inc-${now.toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
    kind,
    title,
    impact,
    status,
    components: components(input.components),
    updates: [{ at, status, body, by }],
    startsAt,
    endsAt,
    resolvedAt: closing(status) ? at : null,
    createdAt: at,
    createdBy: by,
  };
  await saveIncident(incident);
  return incident;
}

/** Add an update (status + what to say), and optionally correct the title,
 *  impact, components or window. Resolving or completing closes it. */
export async function updateIncident(id: string, input: Record<string, unknown>, by: string, now = Date.now()): Promise<Incident | null> {
  const cur = await getIncident(id);
  if (!cur) return null;
  const status = statusFor(cur.kind, input.status, cur.status);
  const body = str(input.body ?? input.message, "body", 5000, false);
  const next: Incident = { ...cur, status };
  const title = str(input.title, "title", 200, false);
  if (title) next.title = title;
  if (input.impact !== undefined) {
    if (cur.kind === "maintenance" || (input.impact !== "minor" && input.impact !== "major")) throw new StatusInputError('impact is "minor" or "major", and only for an incident');
    next.impact = input.impact;
  }
  if (input.components !== undefined) next.components = components(input.components);
  const startsAt = when(input.startsAt, "startsAt");
  if (startsAt) next.startsAt = startsAt;
  if (input.endsAt !== undefined) next.endsAt = when(input.endsAt, "endsAt") ?? null;
  if (next.endsAt && Date.parse(next.endsAt) <= Date.parse(next.startsAt)) throw new StatusInputError("endsAt must be after startsAt");
  const at = new Date(now).toISOString();
  if (!body && status === cur.status && !title && input.impact === undefined && input.components === undefined && !startsAt && input.endsAt === undefined) {
    throw new StatusInputError("nothing to change: give a body, a status, or a field to correct");
  }
  if (body || status !== cur.status) next.updates = [...cur.updates, { at, status, body: body ?? `Status changed to ${status.replace("_", " ")}.`, by }];
  next.resolvedAt = closing(status) ? (cur.resolvedAt ?? at) : null;
  await saveIncident(next);
  return next;
}

/** What a customer sees: no author addresses. */
export function publicIncident(i: Incident) {
  return {
    id: i.id,
    kind: i.kind,
    title: i.title,
    impact: i.impact,
    status: i.status,
    components: i.components,
    startsAt: i.startsAt,
    endsAt: i.endsAt,
    resolvedAt: i.resolvedAt,
    updates: i.updates.map((u) => ({ at: u.at, status: u.status, body: u.body })),
  };
}
export type PublicIncident = ReturnType<typeof publicIncident>;

/** Open incidents, and maintenance whose window is now. */
export function isActive(i: Incident, now = Date.now()): boolean {
  if (i.resolvedAt) return false;
  if (i.kind === "incident") return Date.parse(i.startsAt) <= now;
  return Date.parse(i.startsAt) <= now && (!i.endsAt || Date.parse(i.endsAt) > now);
}
/** Maintenance announced for later. */
export function isUpcoming(i: Incident, now = Date.now()): boolean {
  return !i.resolvedAt && Date.parse(i.startsAt) > now;
}

// ------------------------------------------------------------------ the read

export interface ComponentStatus {
  id: ComponentId;
  name: string;
  status: Level;
  detail: string;
  /** When this was last measured: now for the live checks, the sample's
   *  time for the probes the worker runs. */
  checkedAt: string | null;
}

export interface StatusReport {
  status: "operational" | "maintenance" | "degraded" | "outage";
  description: string;
  updatedAt: string;
  components: ComponentStatus[];
  incidents: PublicIncident[];
  maintenance: PublicIncident[];
}

const DESCRIBE: Record<StatusReport["status"], string> = {
  operational: "All systems operational",
  maintenance: "Scheduled maintenance in progress",
  degraded: "Some systems are degraded",
  outage: "Major outage",
};

const CACHE_MS = () => Number(process.env.FOLDRUN_STATUS_CACHE_MS ?? 15_000);
const HISTORY_CACHE_MS = () => Number(process.env.FOLDRUN_STATUS_HISTORY_CACHE_MS ?? 60_000);

interface Flight<T> {
  at: number;
  promise: Promise<T>;
}

/**
 * Memoise `compute` under `key` for `ttl` ms from when it started. The
 * promise is kept, not the value, so concurrent misses share one query
 * (single-flight); a rejected one is dropped so a failure is not served.
 */
function shared<T>(cache: Map<string, Flight<T>>, key: string, now: number, ttl: number, compute: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && now >= hit.at && now - hit.at < ttl) return hit.promise;
  const promise = compute();
  if (ttl > 0) {
    const entry = { at: now, promise };
    cache.set(key, entry);
    promise.catch(() => {
      if (cache.get(key) === entry) cache.delete(key);
    });
  }
  return promise;
}

const current = new Map<string, Flight<StatusReport>>();
const histories = new Map<string, Flight<StatusHistory>>();

/**
 * The platform's status now. Cached for fifteen seconds: this is an open
 * route, and a refresh storm during an outage must not become one; callers
 * that miss together share one computation.
 */
export function currentStatus(now = Date.now()): Promise<StatusReport> {
  return shared(current, "now", now, CACHE_MS(), () => computeStatus(now));
}

async function computeStatus(now: number): Promise<StatusReport> {
  const iso = new Date(now).toISOString();
  const fresh = await latestSamples(now - FRESH_MS()).catch(() => ({}) as Partial<Record<ComponentId, Sample>>);
  // No fresh sample: look back over everything kept, so a scheduler that
  // stopped days ago reads as an outage. Only an empty table is "no sample yet".
  const ever = Object.keys(fresh).length ? fresh : await latestSamples(now - KEEP_DAYS * DAY).catch(() => ({}) as Partial<Record<ComponentId, Sample>>);
  const newest = Math.max(0, ...Object.values(ever).map((s) => s!.at));

  const live: Partial<Record<ComponentId, Probe>> = {};
  // The answering process is the web tier; the database decides whether it
  // is whole.
  const db = databaseEnabled() ? await databaseReady().catch(() => false) : null;
  live.web = db === false ? { status: "degraded", detail: "serving, but the database is not answering" } : { status: "operational", detail: "answering" };
  live.workers = await probeWorkers().catch((err): Probe => ({ status: "unknown", detail: String(err) }));
  live.storage = await probeStorage().catch((err): Probe => ({ status: "unknown", detail: String(err) }));
  // The sampler runs inside the scheduler's tick: a stale sample is a
  // scheduler that stopped ticking.
  if (!newest) live.scheduler = { status: "unknown", detail: "no status sample has been taken yet" };
  else if (now - newest > FRESH_MS()) live.scheduler = { status: "outage", detail: `the scheduler has not ticked for ${Math.round((now - newest) / 60_000)} min` };
  else live.scheduler = { status: "operational", detail: "ticking" };

  const all = await listIncidents(now - 90 * DAY).catch(() => [] as Incident[]);
  const active = all.filter((i) => isActive(i, now));
  const upcoming = all.filter((i) => i.kind === "maintenance" && isUpcoming(i, now));

  const components: ComponentStatus[] = COMPONENTS.map((c) => {
    const l = live[c.id];
    const s = fresh[c.id];
    let p: Probe = l ?? (s ? { status: s.status, detail: s.detail } : { status: "unknown", detail: "not measured in the last 15 minutes" });
    const checkedAt = l ? iso : s ? new Date(s.at).toISOString() : null;
    for (const i of active) {
      if (!i.components.includes(c.id)) continue;
      const lvl: Level = i.kind === "maintenance" ? "maintenance" : i.impact === "major" ? "outage" : "degraded";
      if (RANK[lvl] > RANK[p.status]) p = { status: lvl, detail: i.title };
    }
    return { id: c.id, name: c.name, status: p.status, detail: p.detail, checkedAt };
  });

  let overall: Level = "operational";
  for (const c of components) overall = worse(overall, c.status);
  for (const i of active) overall = worse(overall, i.kind === "maintenance" ? "maintenance" : i.impact === "major" ? "outage" : "degraded");
  const status = (overall === "unknown" ? "operational" : overall) as StatusReport["status"];
  return {
    status,
    description: DESCRIBE[status],
    updatedAt: iso,
    components,
    incidents: active.filter((i) => i.kind === "incident").map(publicIncident),
    maintenance: [...active.filter((i) => i.kind === "maintenance"), ...upcoming].map(publicIncident),
  };
}

// ------------------------------------------------------------------ history

export interface DayUptime {
  date: string;
  samples: number;
  operational: number;
  degraded: number;
  outage: number;
  maintenance: number;
  /** Share of measured samples that were not an outage, 0..1; null on a
   *  day with no measured sample (before the sampler, or all unknown). */
  uptime: number | null;
}

export interface StatusHistory {
  days: number;
  sampleMinutes: number;
  components: { id: ComponentId; name: string; uptime: number | null; days: DayUptime[] }[];
  incidents: PublicIncident[];
}

/**
 * Daily uptime per component over the last `days` (1..90), oldest first.
 * Cached per window for a minute: it is an open, rate-limit-exempt route
 * over up to ninety days of samples, and a refresh storm during an incident
 * must not land each call on the database.
 */
export function statusHistory(days = KEEP_DAYS, now = Date.now()): Promise<StatusHistory> {
  const n = Math.max(1, Math.min(KEEP_DAYS, Math.floor(days) || KEEP_DAYS));
  return shared(histories, String(n), now, HISTORY_CACHE_MS(), () => computeHistory(n, now));
}

async function computeHistory(n: number, now: number): Promise<StatusHistory> {
  const firstDay = Date.parse(dayKey(now)) - (n - 1) * DAY;
  const counts = new Map<string, Record<Level, number>>(); // `${component}|${day}`
  const add = (component: string, day: string, status: string, k: number) => {
    const key = `${component}|${day}`;
    const c = counts.get(key) ?? { operational: 0, degraded: 0, outage: 0, maintenance: 0, unknown: 0 };
    if (status in c) c[status as Level] += k;
    counts.set(key, c);
  };
  if (databaseEnabled()) {
    const day = sql<string>`to_char(${statusSamples.at} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
    const rows = await ormRequired()
      .select({ component: statusSamples.component, day, status: statusSamples.status, n: sql<number>`count(*)::int` })
      .from(statusSamples)
      .where(and(gte(statusSamples.at, new Date(firstDay))))
      .groupBy(statusSamples.component, day, statusSamples.status);
    for (const r of rows) add(r.component, r.day, r.status, Number(r.n));
  } else {
    for (const s of readFileSamples(firstDay)) add(s.component, dayKey(s.at), s.status, 1);
  }
  const components = COMPONENTS.map((c) => {
    let measured = 0;
    let up = 0;
    const list: DayUptime[] = [];
    for (let i = 0; i < n; i++) {
      const date = dayKey(firstDay + i * DAY);
      const k = counts.get(`${c.id}|${date}`) ?? { operational: 0, degraded: 0, outage: 0, maintenance: 0, unknown: 0 };
      const m = k.operational + k.degraded + k.outage + k.maintenance;
      measured += m;
      up += m - k.outage;
      list.push({ date, samples: m + k.unknown, operational: k.operational, degraded: k.degraded, outage: k.outage, maintenance: k.maintenance, uptime: m ? (m - k.outage) / m : null });
    }
    return { id: c.id, name: c.name, uptime: measured ? up / measured : null, days: list };
  });
  const incidents = (await listIncidents(firstDay)).map(publicIncident);
  return { days: n, sampleMinutes: Math.round(SAMPLE_MS() / 60_000), components, incidents };
}

/** For tests: drop every sample and incident. */
export async function resetStatus(): Promise<void> {
  resetStatusSampler();
  fs.rmSync(statusDir(), { recursive: true, force: true });
  if (databaseEnabled()) {
    await ormRequired().delete(statusSamples);
    await ormRequired().delete(statusIncidents);
  }
}
