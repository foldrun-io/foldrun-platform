// A cloud browser call with no run behind it (FOL-313): web_browse on
// /v1/messages, and the laptop's cloud browser (FOL-304). The design and the
// rules Codex added are foldrun-infra docs/web-browse-backend-plan.md; in
// short:
//
//   gateway ──INSERT browse_jobs (queued) + notify──▶ worker
//                                                      claims it (SKIP LOCKED)
//                                                      a browse-job egress lease (no run, no secrets, ends at the deadline)
//                                                      one single-use browse pod
//                                                      state → sent, then ONE POST /call (never sent again)
//   gateway ◀── row done | failed | unknown + notify ──┘ pod deleted, lease released
//
// One deadline from admission to answer. A caller that leaves sets
// cancel_requested; the worker checks it at claim, before the call and every
// two seconds during it (aborting the call kills the pod's process group).
// A row past its deadline is settled by the sweep: a sent one is `unknown`
// (the page may have been acted on), never retried.
//
// The input is typed (BrowseInput) and turned into browse.mjs's argv here:
// no caller argv, env or files. At most five flat steps of a fixed list —
// no `if`, no `eval`, no uploads, downloads, cookies, mocks or captchas.
// Without a database (tests, one process) the rows live in this process.

import crypto from "node:crypto";
import http from "node:http";
import { sql } from "drizzle-orm";
import { opsError, opsLog } from "../../foldrun-core/src/ops-log.ts";
import { databaseEnabled, ormRequired } from "./db.ts";
import { listen } from "./pg-listen.ts";

export const JOB_CHANNEL = "foldrun_browse_job";
export const DONE_CHANNEL = "foldrun_browse_done";

// ---------------------------------------------------------------- the input

export type BrowseMode = "markdown" | "text" | "screenshot";
export type BrowseStep = Record<string, unknown>;
export interface BrowseInput {
  url: string;
  steps?: BrowseStep[];
  mode?: BrowseMode;
  /** The tool's domain rule, held by the job's egress lease on every
   *  connection the browser makes (redirects and subresources too). */
  allowedDomains?: string[];
  blockedDomains?: string[];
}

export interface BrowseResult {
  url: string;
  /** The page as markdown or text (mode markdown | text). */
  text?: string;
  /** mode screenshot: the page as a PNG, base64. */
  screenshot?: { media_type: "image/png"; data: string };
}

export type BrowseErrorCode = "invalid_tool_input" | "url_not_accessible" | "too_many_requests" | "unavailable" | "timeout" | "outcome_unknown" | "screenshot_too_large" | "duplicate";

export const LIMITS = {
  /** Live jobs across every account at once (Codex: the shared queue is capped). */
  liveJobsTotal: Number(process.env.FOLDRUN_BROWSE_JOBS_MAX) > 0 ? Number(process.env.FOLDRUN_BROWSE_JOBS_MAX) : 20,
  steps: 5,
  stepTextChars: 2000,
  urlChars: 2048,
  screenshotBytes: 1024 * 1024,
  textChars: 200_000,
  /** One deadline, admission to answer. */
  deadlineMs: 45_000,
  liveJobsPerKey: 1,
  liveJobsPerAccount: 2,
};

/** The steps a call may take: read and act on the page, nothing that runs
 *  code, reaches the account's files or secrets, or branches. */
const STEP_KINDS = new Set(["click", "dblclick", "hover", "fill", "type", "press", "select", "check", "uncheck", "wait", "scroll", "goto", "back", "forward", "reload", "focus", "clear"]);
/** The keys each kind may carry beside its own. */
const STEP_KEYS = new Set([...STEP_KINDS, "text", "value", "key", "gone", "matches"]);

function httpUrl(u: unknown): string | null {
  if (typeof u !== "string" || !u || u.length > LIMITS.urlChars) return null;
  try {
    const p = new URL(u);
    if (p.protocol !== "http:" && p.protocol !== "https:") return null;
    if (p.username || p.password) return null;
    if (p.port && p.port !== "80" && p.port !== "443") return null;
    return p.toString();
  } catch {
    return null;
  }
}

const domains = (v: unknown): string[] | undefined | null => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 100 || !v.every((d) => typeof d === "string" && /^[a-z0-9.*-]{1,253}$/i.test(d))) return null;
  return v as string[];
};

/** The caller's input, checked: the typed input, or why not. */
export function checkBrowseInput(raw: unknown): { input: BrowseInput } | { error: "invalid_tool_input"; message: string } {
  const bad = (message: string) => ({ error: "invalid_tool_input" as const, message });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("the input is an object with url");
  const r = raw as Record<string, unknown>;
  const url = httpUrl(r.url);
  if (!url) return bad("url is an http(s) address on port 80 or 443, without a login in it");
  const mode = r.mode ?? "markdown";
  if (mode !== "markdown" && mode !== "text" && mode !== "screenshot") return bad("mode is markdown, text or screenshot");
  let steps: BrowseStep[] | undefined;
  if (r.steps !== undefined) {
    if (!Array.isArray(r.steps) || r.steps.length > LIMITS.steps) return bad(`steps is a list of at most ${LIMITS.steps}`);
    steps = [];
    for (const s of r.steps) {
      if (!s || typeof s !== "object" || Array.isArray(s)) return bad("each step is an object");
      const keys = Object.keys(s);
      const kinds = keys.filter((k) => STEP_KINDS.has(k));
      if (kinds.length !== 1) return bad(`each step is one of ${[...STEP_KINDS].join(", ")}`);
      if (keys.some((k) => !STEP_KEYS.has(k))) return bad(`a ${kinds[0]} step carries only its own fields`);
      for (const k of keys) {
        const v = (s as Record<string, unknown>)[k];
        if (typeof v === "string" ? v.length > LIMITS.stepTextChars : !(typeof v === "number" || typeof v === "boolean")) return bad(`a step's ${k} is a short string, a number or true/false`);
      }
      const st = s as Record<string, unknown>;
      if (st.wait === "fn") return bad("a wait step cannot run code");
      if (typeof st.wait === "number" && !(st.wait >= 0 && st.wait <= 5000)) return bad("a wait is at most 5000 ms");
      if (st.goto !== undefined && !httpUrl(st.goto)) return bad("goto is an http(s) address on port 80 or 443");
      steps.push({ ...st });
    }
  }
  const allowed = domains(r.allowed_domains ?? r.allowedDomains);
  const blocked = domains(r.blocked_domains ?? r.blockedDomains);
  if (allowed === null || blocked === null) return bad("allowed_domains and blocked_domains are lists of host names");
  return { input: { url, mode, ...(steps?.length ? { steps } : {}), ...(allowed ? { allowedDomains: allowed } : {}), ...(blocked ? { blockedDomains: blocked } : {}) } };
}

/** The browse job's egress grant: the open web, or only the allowed
 *  sites; the blocked ones refused on every connection; nothing else. */
export function leaseGrantOf(input: BrowseInput, expiresAt: number) {
  // A domain covers its sub-domains, as the tool's domain lists do elsewhere.
  const wide = (raw: string) => {
    // The same spelling the proxy compares against (core network.ts normalHost).
    const d = raw.trim().toLowerCase().replace(/\.$/, "");
    return d.startsWith("*.") ? d : `*.${d}`;
  };
  const allowed = input.allowedDomains?.map(wide);
  const blocked = input.blockedDomains?.map(wide);
  return {
    secrets: {},
    network: allowed?.length
      ? { level: "none" as const, hosts: allowed, ...(blocked?.length ? { deny: blocked } : {}) }
      : { level: "open" as const, hosts: [], ...(blocked?.length ? { deny: blocked } : {}) },
    enforce: true,
    purpose: "browse-job" as const,
    expiresAt,
  };
}

/** browse.mjs's argv and settings for a checked input — the only argv a
 *  browse job ever sends. */
export function programCall(input: BrowseInput): { argv: string[]; env: Record<string, string> } {
  const argv = ["--url", input.url, "--mode", input.mode ?? "markdown"];
  if (input.steps?.length) argv.push("--actions", JSON.stringify(input.steps));
  // The domain rules are the lease's (leaseGrantOf), never a browser setting.
  return { argv, env: { FOLDRUN_BROWSER_HEADLESS: "true" } };
}

/** The pod's NDJSON answer read into a result: stdout is the page; a
 *  screenshot comes back as the file browse.mjs wrote. */
export function readCallStream(lines: string[], input: BrowseInput): { result: BrowseResult } | { error: BrowseErrorCode; message: string } {
  let started = false;
  let refused = false;
  let exit: number | null = null;
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let png: Buffer | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let o: { t?: string; d?: string; path?: string; code?: number };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.t === "start") started = true;
    else if (o.t === "refused") refused = true;
    else if (o.t === "out" && o.d) out.push(Buffer.from(o.d, "base64"));
    else if (o.t === "err" && o.d) err.push(Buffer.from(o.d, "base64"));
    else if (o.t === "file" && o.d && typeof o.path === "string" && o.path.endsWith("outputs/page.png")) png = Buffer.from(o.d, "base64");
    else if (o.t === "exit") exit = typeof o.code === "number" ? o.code : 1;
  }
  // Only a pod's own refusal (or no connection at all) is known not to have
  // run; a call whose answer was lost before its start may have (Codex).
  if (!started) return refused ? { error: "unavailable", message: "the browser call did not start" } : { error: "outcome_unknown", message: "the browser call's answer was lost; what it did is not known" };
  // Cut off after it started: it may have acted (a form sent), so it is
  // never sent again and never called a success.
  if (exit === null) return { error: "outcome_unknown", message: "the browser call was cut off; what it did is not known" };
  const lastErr = Buffer.concat(err).toString("utf8").trim().split("\n").filter(Boolean).pop() ?? "";
  // A failure after steps ran may follow one that acted (a click that sent a
  // form): never an ordinary failure a caller would retry (Codex).
  if (exit !== 0 && input.steps?.length) return { error: "outcome_unknown", message: `${lastErr.slice(0, 300) || "a step failed"} — earlier steps may have acted` };
  if (exit !== 0) return { error: "url_not_accessible", message: lastErr.slice(0, 300) || "the page could not be read" };
  // After steps ran, any failure may follow an action: unknown, the detail kept.
  const after = (e: BrowseErrorCode, message: string) => (input.steps?.length ? { error: "outcome_unknown" as const, message: `${message} — the steps before it may have acted` } : { error: e, message });
  if (input.mode === "screenshot") {
    if (!png) return after("url_not_accessible", "no screenshot came back");
    if (png.length > LIMITS.screenshotBytes) return after("screenshot_too_large", `the page's screenshot is ${png.length} bytes, over ${LIMITS.screenshotBytes}`);
    return { result: { url: input.url, screenshot: { media_type: "image/png", data: png.toString("base64") } } };
  }
  let text = Buffer.concat(out).toString("utf8");
  if (text.length > LIMITS.textChars) text = text.slice(0, LIMITS.textChars);
  return { result: { url: input.url, text } };
}

// ---------------------------------------------------------------- the rows

export type JobState = "queued" | "running" | "sent" | "done" | "failed" | "unknown" | "cancelled";
const LIVE: JobState[] = ["queued", "running", "sent"];
export const isFinal = (s: JobState) => !LIVE.includes(s);

export interface BrowseJob {
  id: string;
  tenant: string;
  keyId: string | null;
  /** The caller's Idempotency-Key, when it sent one. */
  invocation: string | null;
  input: BrowseInput;
  state: JobState;
  cancelRequested: boolean;
  worker: string | null;
  podName: string | null;
  result: BrowseResult | null;
  error: string | null;
  deadline: number;
  createdAt: number;
}

/** What a finished job answers: its result, or an error code and message. */
export type JobAnswer = { ok: true; result: BrowseResult; replayed?: true } | { ok: false; error: BrowseErrorCode; message: string };

const mem = new Map<string, BrowseJob>();
const memWaiters = new Set<() => void>();
const memWake = () => {
  for (const w of [...memWaiters]) w();
};
export function resetBrowseJobsForTests(): void {
  mem.clear();
  memWaiters.clear();
}

const newJobId = () => `bj-${Date.now().toString(36)}${crypto.randomBytes(8).toString("hex")}`;

type Row = { id: string; tenant: string; key_id: string | null; invocation: string | null; input: BrowseInput; state: JobState; cancel_requested: boolean; worker: string | null; pod_name: string | null; result: BrowseResult | null; error: string | null; deadline: Date | string; created_at: Date | string };
const fromRow = (r: Row): BrowseJob => ({
  id: r.id, tenant: r.tenant, keyId: r.key_id, invocation: r.invocation ?? null, input: r.input, state: r.state, cancelRequested: r.cancel_requested, worker: r.worker, podName: r.pod_name,
  result: r.result, error: r.error, deadline: new Date(r.deadline).getTime(), createdAt: new Date(r.created_at).getTime(),
});

export async function getBrowseJob(id: string): Promise<BrowseJob | null> {
  if (!databaseEnabled()) {
    const j = mem.get(id);
    return j ? { ...j } : null;
  }
  const r = await ormRequired().execute(sql`SELECT * FROM browse_jobs WHERE id = ${id}`);
  const row = (r.rows as Row[])[0];
  return row ? fromRow(row) : null;
}

/** The job a caller's Idempotency-Key already made, if any. */
export async function findBrowseJob(tenant: string, invocation: string): Promise<BrowseJob | null> {
  if (!databaseEnabled()) return [...mem.values()].find((j) => j.tenant === tenant && j.invocation === invocation) ?? null;
  const r = await ormRequired().execute(sql`SELECT * FROM browse_jobs WHERE tenant = ${tenant} AND invocation = ${invocation}`);
  const row = (r.rows as Row[])[0];
  return row ? fromRow(row) : null;
}

export class BrowseRefusal extends Error {
  readonly code: BrowseErrorCode;
  constructor(code: BrowseErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Queue one job, inside the per-key and per-account limits. */
export async function queueBrowseJob(o: { tenant: string; keyId: string | null; input: BrowseInput; invocation?: string; id?: string }, now = Date.now()): Promise<BrowseJob> {
  const job: BrowseJob = { id: o.id ?? newJobId(), tenant: o.tenant, keyId: o.keyId, invocation: o.invocation ?? null, input: o.input, state: "queued", cancelRequested: false, worker: null, podName: null, result: null, error: null, deadline: now + LIMITS.deadlineMs, createdAt: now };
  const tooMany = (account: number, key: number, total: number) =>
    total >= LIMITS.liveJobsTotal || account >= LIMITS.liveJobsPerAccount || (o.keyId !== null && key >= LIMITS.liveJobsPerKey);
  const dup = () => new BrowseRefusal("duplicate", "this Idempotency-Key already made a browser call");
  if (!databaseEnabled()) {
    if (job.invocation && [...mem.values()].some((j) => j.tenant === o.tenant && j.invocation === job.invocation)) throw dup();
    const all = [...mem.values()].filter((j) => LIVE.includes(j.state) && j.deadline > now);
    const live = all.filter((j) => j.tenant === o.tenant);
    if (tooMany(live.length, live.filter((j) => j.keyId === o.keyId).length, all.length)) throw new BrowseRefusal("too_many_requests", "a browser call is already running for this key or account — wait for it");
    mem.set(job.id, { ...job });
    memWake();
    return job;
  }
  // The counts and the insert under one lock for the whole queue (short
  // transactions), so two calls at once cannot both fit the last slot.
  await ormRequired().transaction(async (t) => {
    await t.execute(sql`SELECT pg_advisory_xact_lock(hashtext('browse-jobs'))`);
    // A retry's job is found before any capacity is counted (Codex): it is
    // replayed, never refused as busy.
    if (job.invocation) {
      const had = await t.execute(sql`SELECT 1 FROM browse_jobs WHERE tenant = ${o.tenant} AND invocation = ${job.invocation}`);
      if (had.rows.length) throw dup();
    }
    const c = await t.execute(sql`
      SELECT count(*)::int AS total,
        count(*) FILTER (WHERE tenant = ${o.tenant})::int AS account,
        count(*) FILTER (WHERE tenant = ${o.tenant} AND key_id IS NOT DISTINCT FROM ${o.keyId})::int AS key FROM browse_jobs
      WHERE state IN ('queued', 'running', 'sent') AND deadline > now()`);
    const row = (c.rows as { account: number; key: number; total: number }[])[0] ?? { account: 0, key: 0, total: 0 };
    if (tooMany(row.account, row.key, row.total)) throw new BrowseRefusal("too_many_requests", "a browser call is already running for this key or account, or the browsers are all busy — wait for it");
    const ins = await t.execute(sql`
      INSERT INTO browse_jobs (id, tenant, key_id, invocation, input, state, deadline, created_at)
      VALUES (${job.id}, ${job.tenant}, ${job.keyId}, ${job.invocation}, ${JSON.stringify(job.input)}::jsonb, 'queued', ${new Date(job.deadline).toISOString()}, ${new Date(now).toISOString()})
      ON CONFLICT DO NOTHING`);
    if ((ins.rowCount ?? 0) !== 1) throw dup();
    await t.execute(sql`SELECT pg_notify(${JOB_CHANNEL}, ${job.id})`);
  });
  return job;
}

/** The caller left: stop the job wherever it is (a sent call is aborted by
 *  its worker; one not claimed yet never starts). */
export async function cancelBrowseJob(id: string): Promise<void> {
  if (!databaseEnabled()) {
    const j = mem.get(id);
    if (!j) return;
    j.cancelRequested = true;
    if (j.state === "queued") j.state = "cancelled";
    memWake();
    return;
  }
  await ormRequired().execute(sql`
    UPDATE browse_jobs SET cancel_requested = true,
      state = CASE WHEN state = 'queued' THEN 'cancelled' ELSE state END,
      finished_at = CASE WHEN state = 'queued' THEN now() ELSE finished_at END
    WHERE id = ${id} AND state IN ('queued', 'running', 'sent')`);
}

/** A finished job's answer, read once its row is final. */
export function answerOf(j: BrowseJob): JobAnswer {
  if (j.state === "done" && j.result) return { ok: true, result: j.result };
  if (j.state === "unknown") return { ok: false, error: "outcome_unknown", message: j.error ?? "the browser call was cut off; what it did is not known" };
  if (j.state === "cancelled") return { ok: false, error: "unavailable", message: "the call was cancelled" };
  const [code, ...rest] = (j.error ?? "unavailable").split(": ");
  const known: BrowseErrorCode[] = ["invalid_tool_input", "url_not_accessible", "too_many_requests", "unavailable", "timeout", "outcome_unknown", "screenshot_too_large", "duplicate"];
  return known.includes(code as BrowseErrorCode) ? { ok: false, error: code as BrowseErrorCode, message: rest.join(": ") || code! } : { ok: false, error: "unavailable", message: j.error ?? "the browser call failed" };
}

/** Wait for a job's answer: woken by the worker's notify, re-read every
 *  second as the backstop (a notify may come before we listen), until a
 *  little past its deadline. The signal cancels it. */
export async function waitBrowseJob(id: string, signal?: AbortSignal, opts: { detach?: boolean } = {}): Promise<JobAnswer> {
  const first = await getBrowseJob(id);
  if (!first) return { ok: false, error: "unavailable", message: "the browser call was lost" };
  const until = first.deadline + 5_000;
  let wake: () => void = () => {};
  const memWaiter = () => wake();
  const stop = databaseEnabled() ? listen(DONE_CHANNEL, (p) => p === id && wake()) : (memWaiters.add(memWaiter), () => void memWaiters.delete(memWaiter));
  // A replay's waiter leaves without cancelling the job another caller owns.
  const onAbort = () => {
    if (!opts.detach) void cancelBrowseJob(id).catch((err) => opsError("browse_job.cancel_failed", err, { tenant: first.tenant }));
    wake();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  // Gone before the listener was in place: cancelled all the same (Codex).
  if (signal?.aborted) onAbort();
  try {
    for (;;) {
      const j = await getBrowseJob(id);
      if (j && isFinal(j.state)) return answerOf(j);
      // A caller gone after the call was sent is told what it is: unknown.
      if (signal?.aborted) return j?.state === "sent" ? { ok: false, error: "outcome_unknown", message: "the caller went away while the browser was working" } : { ok: false, error: "unavailable", message: "the caller went away" };
      if (Date.now() > until) {
        if (!opts.detach) void cancelBrowseJob(id).catch(() => undefined);
        return j?.state === "sent" ? { ok: false, error: "outcome_unknown", message: "the browser call ran past its deadline after it was sent; what it did is not known" } : { ok: false, error: "timeout", message: "the browser call ran past its deadline" };
      }
      await new Promise<void>((r) => {
        const t = setTimeout(r, 1000);
        wake = () => {
          clearTimeout(t);
          r();
        };
      });
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    stop();
  }
}

/** Queue and wait: what the server tool and the laptop route call. With an
 *  invocation (the caller's idempotency key, bound to its key and customer
 *  by the caller), a retry gets the first call's answer, marked replayed —
 *  never a second browser, and never charged twice. */
export async function runBrowse(o: { tenant: string; keyId: string | null; input: BrowseInput; invocation?: string; signal?: AbortSignal }): Promise<JobAnswer> {
  if (o.signal?.aborted) return { ok: false, error: "unavailable", message: "the caller went away" };
  // The id is chosen here, so a commit whose answer was lost can be looked
  // up rather than guessed at (Codex).
  const id = newJobId();
  let job: BrowseJob;
  try {
    job = await queueBrowseJob({ ...o, id });
  } catch (err) {
    if (err instanceof BrowseRefusal && err.code === "duplicate" && o.invocation) return (await replayBrowse(o.tenant, o.invocation, o.input, o.signal)) ?? { ok: false, error: "outcome_unknown", message: "this idempotency key's call could not be found" };
    if (err instanceof BrowseRefusal) return { ok: false, error: err.code, message: err.message };
    opsError("browse_job.queue_failed", err, { tenant: o.tenant });
    // A row seen: wait on it. None seen proves nothing — a COMMIT may still
    // land after another connection looked (Codex) — so unknown, never a
    // failure a caller would retry.
    const had = await getBrowseJob(id).catch(() => null);
    if (!had) return { ok: false, error: "outcome_unknown", message: "whether the browser call was queued is not known" };
    job = had;
  }
  // Queued: from here the worker may act, so a failure to read the answer
  // is unknown, never a failure a caller would retry (Codex).
  try {
    return await waitBrowseJob(job.id, o.signal);
  } catch (err) {
    opsError("browse_job.wait_failed", err, { tenant: o.tenant });
    return { ok: false, error: "outcome_unknown", message: "the browser call's answer could not be read; what it did is not known" };
  }
}

/** Keys sorted, arrays in order: the same input whatever order a JSONB
 *  round trip gave its members. */
const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v ?? null);

/** The first call's answer for an invocation, or null when there is none
 *  (the caller then makes the call). Marked replayed, never charged again. */
export async function replayBrowse(tenant: string, invocation: string, input: BrowseInput, signal?: AbortSignal): Promise<JobAnswer | null> {
  try {
    const had = await findBrowseJob(tenant, invocation);
    if (!had) return null;
    if (canonical(had.input) !== canonical(input)) return { ok: false, error: "invalid_tool_input", message: "this idempotency key was used for another browser call" };
    const answer = await waitBrowseJob(had.id, signal, { detach: true });
    return answer.ok ? { ...answer, replayed: true } : answer;
  } catch (err) {
    opsError("browse_job.wait_failed", err, { tenant });
    return { ok: false, error: "outcome_unknown", message: "the browser call's answer could not be read; what it did is not known" };
  }
}

// ---------------------------------------------------------------- the worker

/** What a worker needs from the cluster and the egress proxy (the real ones
 *  in browseJobDeps(); fakes in the tests). */
export interface BrowseJobDeps {
  /** A browse-job lease: its token, and how to end it. */
  lease(o: { tenant: string; jobId: string; expiresAt: number; input: BrowseInput }): Promise<{ token: string; release: () => Promise<void> } | null>;
  ensurePod(o: { token: string; tenant: string; job: string; deadlineSec: number; signal?: AbortSignal }): Promise<{ pod: string } | { error: string; reason?: string }>;
  deletePod(pod: string): Promise<number>;
  /** The one POST /call; its NDJSON lines. Aborting it kills the call. */
  call(o: { token: string; body: unknown; signal: AbortSignal }): Promise<string[]>;
  /** sha256 of the platform's browse.mjs (the pod refuses another). */
  programSha(): string;
}

const WORKER = `${process.env.HOSTNAME ?? "worker"}-${process.pid}`;

async function claim(now = Date.now()): Promise<BrowseJob | null> {
  if (!databaseEnabled()) {
    const j = [...mem.values()].filter((x) => x.state === "queued").sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!j) return null;
    if (j.deadline <= now || j.cancelRequested) {
      j.state = j.cancelRequested ? "cancelled" : "failed";
      j.error = "timeout: it waited past its deadline";
      memWake();
      return claim(now);
    }
    j.state = "running";
    j.worker = WORKER;
    return { ...j };
  }
  const r = await ormRequired().execute(sql`
    UPDATE browse_jobs SET state = 'running', worker = ${WORKER}, started_at = now()
    WHERE id = (
      SELECT id FROM browse_jobs WHERE state = 'queued' AND NOT cancel_requested AND deadline > now()
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING *`);
  const row = (r.rows as Row[])[0];
  return row ? fromRow(row) : null;
}

/** running → sent, only for the job still ours, not cancelled, in time:
 *  the conditional write before the one call. */
async function markSent(job: BrowseJob, pod: string): Promise<boolean> {
  if (!databaseEnabled()) {
    const j = mem.get(job.id);
    if (!j || j.state !== "running" || j.worker !== WORKER || j.cancelRequested || j.deadline <= Date.now()) return false;
    j.state = "sent";
    j.podName = pod;
    return true;
  }
  const r = await ormRequired().execute(sql`
    UPDATE browse_jobs SET state = 'sent', pod_name = ${pod}
    WHERE id = ${job.id} AND state = 'running' AND worker = ${WORKER} AND NOT cancel_requested AND deadline > now()`);
  return (r.rowCount ?? 0) === 1;
}

async function finish(job: BrowseJob, state: "done" | "failed" | "unknown" | "cancelled", out: { result?: BrowseResult; error?: string }): Promise<void> {
  if (!databaseEnabled()) {
    const j = mem.get(job.id);
    if (j && !isFinal(j.state)) {
      j.state = state;
      j.result = out.result ?? null;
      j.error = out.error ?? null;
    }
    memWake();
    return;
  }
  await ormRequired().execute(sql`
    WITH up AS (
      UPDATE browse_jobs SET state = ${state}, result = ${out.result ? JSON.stringify(out.result) : null}::jsonb, error = ${out.error ?? null}, finished_at = now()
      WHERE id = ${job.id} AND state IN ('queued', 'running', 'sent') RETURNING id)
    SELECT pg_notify(${DONE_CHANNEL}, id) FROM up`);
}

const cancelled = async (id: string) => (await getBrowseJob(id))?.cancelRequested === true;

/** Run one claimed job to its end. Never throws; never sends a call twice. */
export async function runBrowseJob(job: BrowseJob, deps: BrowseJobDeps): Promise<void> {
  try {
    await runBrowseJobInner(job, deps);
  } catch (err) {
    // A database write that failed outside the inner try: logged, never an
    // unhandled rejection that takes the worker's other jobs down (Codex).
    opsError("browse_job.finish_failed", err, { tenant: job.tenant });
  }
}

async function runBrowseJobInner(job: BrowseJob, deps: BrowseJobDeps): Promise<void> {
  const left = () => job.deadline - Date.now();
  if (left() <= 0) return finish(job, "failed", { error: "timeout: it waited past its deadline" });
  const lease = await deps.lease({ tenant: job.tenant, jobId: job.id, expiresAt: job.deadline, input: job.input }).catch(() => null);
  if (!lease) return finish(job, "failed", { error: "unavailable: no browser network for this call" });
  let pod: string | null = null;
  let sent = false;
  // Watched from the claim, not from the call (Codex): a caller gone while
  // the pod starts ends the job at the next step.
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), Math.max(0, left()));
  const watch = setInterval(() => {
    void cancelled(job.id).then((c) => c && abort.abort(), () => undefined);
  }, 2000);
  deadline.unref?.();
  watch.unref?.();
  try {
    const made = await deps.ensurePod({ token: lease.token, tenant: job.tenant, job: job.id, deadlineSec: Math.max(0, left() / 1000), signal: abort.signal });
    if ("error" in made) {
      // The reason as a short code: the sentence never fit the ops log and was dropped (dev, 25 Nov 2026).
      opsLog("warn", "browse_job.pod_failed", { tenant: job.tenant, reason: made.reason ?? "unknown" });
      return await finish(job, "failed", { error: "unavailable: the browser could not be started" });
    }
    pod = made.pod;
    if (abort.signal.aborted || (await cancelled(job.id))) return await finish(job, (await cancelled(job.id)) ? "cancelled" : "failed", { error: "timeout: the browser started too late" });
    if (!(await markSent(job, pod))) return await finish(job, (await cancelled(job.id)) ? "cancelled" : "failed", { error: "timeout: the browser started too late" });
    sent = true;
    const { argv, env } = programCall(job.input);
    let lines: string[];
    try {
      lines = await deps.call({ token: lease.token, body: { argv, env, cwd: "agents/browse", sha: deps.programSha(), files: [] }, signal: abort.signal });
    } catch {
      // Thrown after the request went out: what it did is not known.
      lines = [];
    }
    if (abort.signal.aborted && (await cancelled(job.id))) return await finish(job, "unknown", { error: "outcome_unknown: the caller left while the browser was working" });
    const read = readCallStream(lines, job.input);
    if ("result" in read) return await finish(job, "done", { result: read.result });
    // A call that never started did nothing; one cut off after it did, may have.
    return await finish(job, read.error === "outcome_unknown" ? "unknown" : "failed", { error: `${read.error}: ${read.message}` });
  } catch (err) {
    opsError("browse_job.failed", err, { tenant: job.tenant });
    await finish(job, sent ? "unknown" : "failed", { error: sent ? "outcome_unknown: the worker lost the call" : "unavailable: the browser call failed" }).catch(() => undefined);
  } finally {
    clearTimeout(deadline);
    clearInterval(watch);
    // The lease ends at once, apart from the pod's delete (Codex): a slow
    // cluster never keeps the network open.
    const released = lease.release().catch(() => undefined);
    if (pod) {
      const secs = await deps.deletePod(pod).catch(() => 0);
      // foldrun's own cost, never the account's compute: the call is priced per call.
      opsLog("info", "browse_job.pod_time", { tenant: job.tenant, count: Math.round(secs) });
    }
    await released;
  }
}

/** Rows past their deadline (a worker that died, a notify lost): a sent
 *  one is `unknown`, any other `failed`. The job pods of rows that are not
 *  live go too (browse-service.ts sweepBrowseJobPods). */
export async function sweepBrowseJobs(now = Date.now()): Promise<number> {
  if (!databaseEnabled()) {
    let n = 0;
    for (const j of mem.values()) {
      if (!isFinal(j.state) && j.deadline + 10_000 < now) {
        j.state = j.state === "sent" ? "unknown" : "failed";
        j.error = j.state === "unknown" ? "outcome_unknown: its worker was lost after the call was sent" : "timeout: its worker was lost";
        n++;
      }
      if (isFinal(j.state) && j.createdAt + 3600_000 < now) mem.delete(j.id);
    }
    if (n) memWake();
    return n;
  }
  const r = await ormRequired().execute(sql`
    WITH up AS (
      UPDATE browse_jobs SET
        state = CASE WHEN state = 'sent' THEN 'unknown' ELSE 'failed' END,
        error = CASE WHEN state = 'sent' THEN 'outcome_unknown: its worker was lost after the call was sent' ELSE 'timeout: its worker was lost' END,
        finished_at = now()
      WHERE state IN ('queued', 'running', 'sent') AND deadline < now() - interval '10 seconds' RETURNING id)
    SELECT pg_notify(${DONE_CHANNEL}, id) FROM up`);
  await ormRequired().execute(sql`DELETE FROM browse_jobs WHERE created_at < now() - interval '1 hour' AND state NOT IN ('queued', 'running', 'sent')`);
  return r.rowCount ?? 0;
}

/** The ids of live jobs, for the pod sweep. */
export async function liveBrowseJobIds(): Promise<Set<string>> {
  if (!databaseEnabled()) return new Set([...mem.values()].filter((j) => !isFinal(j.state)).map((j) => j.id));
  const r = await ormRequired().execute(sql`SELECT id FROM browse_jobs WHERE state IN ('queued', 'running', 'sent')`);
  return new Set((r.rows as { id: string }[]).map((x) => x.id));
}

let workerTimer: NodeJS.Timeout | null = null;
let draining: Promise<void> | null = null;
let again = false;
let inFlight = 0;
/** At most this many jobs at once per worker copy. */
const PER_WORKER = 4;

/** Claim and run what is queued, single-flight. */
export function drainBrowseJobs(deps: BrowseJobDeps): Promise<void> {
  if (draining) {
    again = true;
    return draining;
  }
  draining = (async () => {
    while (inFlight < PER_WORKER) {
      const job = await claim();
      if (!job) break;
      inFlight++;
      void runBrowseJob(job, deps).finally(() => {
        inFlight--;
        void drainBrowseJobs(deps);
      });
    }
  })()
    .catch((err) => opsError("browse_job.claim_failed", err))
    .finally(() => {
      draining = null;
      if (again) {
        again = false;
        void drainBrowseJobs(deps);
      }
    });
  return draining;
}

/** Started with the worker's loops (boot.ts) where it can make pods: on a
 *  notify, and every two seconds as the safety net. */
export function startBrowseJobs(deps: BrowseJobDeps): void {
  if (workerTimer) return;
  const kick = () => void drainBrowseJobs(deps);
  if (databaseEnabled()) listen(JOB_CHANNEL, kick, { up: kick, down: kick });
  else memWaiters.add(kick);
  workerTimer = setInterval(kick, 2000);
  workerTimer.unref?.();
  kick();
  opsLog("info", "browse_job.started", {});
}

export function stopBrowseJobsForTests(): void {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
}

// ---------------------------------------------------------------- the real deps

/** POST one call to a job's pod and read every NDJSON line. Cut off once
 *  the pod answered (an abort, a reset): the lines so far — a start with no
 *  exit reads as outcome_unknown. Refused by the pod or no connection: a
 *  refused line, the call never started; lost after it was sent: no lines,
 *  outcome_unknown. */
export function postCall(target: { host: string; port: number }, token: string, body: unknown, signal: AbortSignal): Promise<string[]> {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    let buf = "";
    let answered = false;
    const done = () => resolve(answered ? buf.split("\n") : []);
    const refused = JSON.stringify({ t: "refused" });
    const req = http.request({ host: target.host, port: target.port, method: "POST", path: "/call", headers: { "content-type": "application/json", "content-length": data.length, "x-foldrun-lease": token }, signal }, (res) => {
      // The pod's own refusal: it ran nothing.
      if (res.statusCode !== 200) {
        res.resume();
        return resolve([refused]);
      }
      answered = true;
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        buf += c;
        // Bounded: the pod caps its own output; this is the backstop.
        if (buf.length > 32 * 1024 * 1024) req.destroy(new Error("the browser's answer is too large"));
      });
      res.on("end", done);
      res.on("error", done);
      res.on("close", done);
    });
    // No connection at all: nothing was sent. Any other error once the
    // request may have gone out: no lines, read as outcome_unknown.
    req.on("error", (err: NodeJS.ErrnoException) => (!answered && (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND" || err.code === "EHOSTUNREACH") ? resolve([refused]) : done()));
    req.end(data);
  });
}

/** The real cluster and proxy, for the worker (boot.ts). */
export async function browseJobDeps(): Promise<BrowseJobDeps> {
  const { egressHooks } = await import("./egress-proxy.ts");
  const { ensureBrowseJobPod, deleteBrowseJobPod, galleryBrowseProgram } = await import("./browse-service.ts");
  const { browseTarget, leaseTokenOf } = await import("./browse-door.ts");
  const sha = crypto.createHash("sha256").update(galleryBrowseProgram()).digest("hex");
  return {
    async lease({ tenant, jobId, expiresAt, input }) {
      // A browse-job lease (egress-proxy.ts leaseOpensAt): no secrets, the
      // forward door only, ended at the deadline, never renewed; its sites
      // the input's (leaseGrantOf), on ports 80 and 443.
      const l = await egressHooks.lease({ tenant, runId: `browse:${jobId}`, grant: leaseGrantOf(input, expiresAt) });
      const token = l?.proxy ? decodeURIComponent(new URL(l.proxy).password) : l ? leaseTokenOf(l.url) : null;
      return l && token ? { token, release: () => l.release() } : null;
    },
    ensurePod: (o) => ensureBrowseJobPod(o),
    deletePod: (pod) => deleteBrowseJobPod(pod),
    call: ({ token, body, signal }) => postCall(browseTarget(token), token, body, signal),
    programSha: () => sha,
  };
}
