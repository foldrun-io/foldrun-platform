// Proposed fixes: failures that add up become a change a person reviews
// (feature 4, 24 Oct 2026).
//
// The pieces were already here — a grader finds the runs that fall short
// (core grades.ts), the assistant reads a workspace and proposes files
// without writing them (assistant/engine.ts), and a person saves a file —
// but nothing joined them, so a recurring failure sat on a card until
// someone thought to ask. Now:
//
//   · A grader with `improve: true` (or `improve: <n>`, default 5) opens a
//     PROPOSAL once it has n failed grades nobody has looked at, or its
//     oldest such failure is seven days old — at most one automatic
//     proposal per grader a day, and never while one is open (drafting or
//     ready). A person can ask for one at any time, for a grader or for an
//     eval whose last result has failed cases.
//   · The proposal is an assistant job (the queue and engine the dashboard's
//     Ask AI uses) given a bounded digest of the failures: at most ten, each
//     line cut short, never whole run records. The assistant reads the
//     workspace's files itself and proposes the smallest change.
//   · Only agents/<a>/agent.md, flows/<f>.md and skills/<s>/… may be
//     proposed — enforced here, not only asked for: a proposal touching a
//     tool, an eval or anything else has those files dropped, and says so.
//   · The result is copied into the proposal (a notice, kind "proposal"),
//     so it outlives the job's six-hour event file. Nothing is written to
//     the workspace until a person applies it.
//   · Apply checks that every file still reads what the proposal was drawn
//     against (sha256), and that every one can be written, before writing
//     any; then writes them all with nothing in between. A file changed
//     since is a 409 — propose again. A write that fails part-way is
//     recorded as `partial`, naming what was written.
//   · Coverage: a failure is "looked at" once a proposal that covers it is
//     drafting, ready, applied, partial or dismissed. A draft that failed
//     releases its failures, so they count again.
//
// Settled in a Codex debate (24 Oct 2026).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { listGraders, readGrades, GRADE_KEEP_MS, type Grade } from "../../foldrun-core/src/grades.ts";
import { listEvals, readEvalResult, type EvalInfo, type EvalResult } from "../../foldrun-core/src/evals.ts";
import { workspaceDir, writeWorkspaceFile, assertEditablePath } from "../../foldrun-core/src/store.ts";
import { MAX_EDITABLE_FILE } from "../../foldrun-core/src/paths.ts";
import matter from "../../foldrun-core/src/matter.ts";
import { getNotice, listNotices, updateNotice } from "./notices.ts";
import { enqueueAssistantJob, newJobId, readJobEnd, runInline, type AssistantJob } from "./assistant/jobs.ts";
import type { DraftFile, DraftIssue } from "./assistant/shared.ts";
import { checkProposals } from "./assistant/engine.ts";

/** Failures carried into one proposal, and how much of each. */
export const DIGEST_FAILURES = 10;
const DETAIL_CHARS = 300;
const TASK_CHARS = 240;
/** How old the oldest unreviewed failure may get before a proposal opens. */
export const STALE_FAILURE_MS = 7 * 86400_000;
/** At most one automatic proposal per grader in this long. */
export const AUTO_EVERY_MS = 24 * 3600_000;
/** How long a claim on an eval stands without its proposal record. */
const CLAIM_GRACE_MS = 60_000;
/** A draft that has not finished in this long has failed. */
export const DRAFT_TIMEOUT_MS = 30 * 60_000;
/** Decided proposals kept per workspace. */
const KEEP_DECIDED = 50;

export type ProposalStatus = "drafting" | "ready" | "failed" | "applying" | "applied" | "partial" | "dismissed";

export interface ProposalFailure {
  /** The run that failed — absent for an eval case, which names its case. */
  runId?: string;
  case?: string;
  check: string;
  detail: string;
  at: string;
}

export interface Proposal {
  id: string;
  workspace: string;
  eval: string;
  /** What opened it: `auto` (the grade pass) or a person. */
  by: string;
  createdAt: string;
  updatedAt: string;
  status: ProposalStatus;
  failures: ProposalFailure[];
  jobId: string | null;
  /** The assistant's explanation. */
  reply: string;
  files: DraftFile[];
  /** The deploy's checks on the proposed files, from the assistant. */
  issues: DraftIssue[];
  /** Why it failed, or what was dropped from it. */
  error?: string;
  notes?: string[];
  decidedBy?: string;
  decidedAt?: string;
  /** For `applied` and `partial`: the files written. */
  applied?: string[];
  /** Dismissed after its draft failed: set aside, but it never covered its
   *  failures, so they still count toward the next proposal. */
  draftFailed?: boolean;
  /** Failed only because its draft had not finished in DRAFT_TIMEOUT_MS —
   *  a busy queue, not an error. A draft that finishes later is still
   *  copied in, unless another proposal for the eval opened meanwhile. */
  timedOut?: boolean;
}

/** The only files a proposal may change. */
const PROPOSABLE = [
  /^agents\/[a-z0-9][a-z0-9-]{0,60}\/agent\.md$/,
  /^flows\/[a-z0-9][a-z0-9-]{0,60}\.md$/,
  /^skills\/[a-z0-9][a-z0-9-]{0,60}\/SKILL\.md$/,
  /^skills\/[a-z0-9][a-z0-9-]{0,60}\/(?:scripts|references|assets)\/[\w.-]{1,80}$/,
];
export const proposable = (p: string) => PROPOSABLE.some((re) => re.test(p));

const sha256 = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const cut = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
const newId = () => `prop_${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;
const ID = /^prop_[a-z0-9]{8,40}$/;
export const isProposalId = (id: string) => ID.test(id);

function refuse(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

// ---------------------------------------------------------------- reading

export async function listProposals(tenant: string, workspace?: string): Promise<Proposal[]> {
  const all = await listNotices<Proposal>(tenant, "proposal");
  return all
    // `<ws>/~open:<eval>` is the claim on an eval, not a proposal.
    .filter((n) => !n.scope.includes("/~"))
    .map((n) => n.payload)
    .filter((p): p is Proposal => !!p && typeof p.id === "string" && (!workspace || p.workspace === workspace))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getProposal(tenant: string, workspace: string, id: string): Promise<Proposal | null> {
  if (!isProposalId(id)) return null;
  const p = (await getNotice<Proposal>(tenant, "proposal", `${workspace}/${id}`))?.payload;
  // A pruned proposal is a tombstone ({ deleted: true }): no id, no proposal.
  return p && typeof p.id === "string" ? p : null;
}

const save = (tenant: string, p: Proposal, change: (prev: Proposal | null) => Proposal) =>
  updateNotice<Proposal>(tenant, "proposal", `${p.workspace}/${p.id}`, change);

/** Statuses that count a failure as looked at. */
const COVERS: ProposalStatus[] = ["drafting", "ready", "applying", "applied", "partial", "dismissed"];
const OPEN: ProposalStatus[] = ["drafting", "ready", "applying"];

// ---------------------------------------------------------------- failures

/** What a failed grade says, as one failure line per failed check. */
function gradeFailures(g: Grade): ProposalFailure[] {
  return g.checks
    .filter((c) => !c.passed && !c.error)
    .map((c) => {
      const a = c.assertions.find((x) => !x.passed);
      return { runId: g.runId, check: c.name, detail: cut(a ? `${a.type}: ${a.value} — ${a.detail}` : "failed", DETAIL_CHARS), at: g.at };
    });
}

/** A grader's failed grades that no proposal covers yet, newest first. */
export function unreviewedGrades(grades: Grade[], proposals: Proposal[], evalName: string): Grade[] {
  const covered = new Set(
    proposals
      .filter((p) => p.eval === evalName && COVERS.includes(p.status) && !p.draftFailed)
      .flatMap((p) => p.failures.map((f) => f.runId).filter(Boolean)),
  );
  return grades.filter((g) => g.status === "fail" && !covered.has(g.runId));
}

/** An eval's last result's failed cases, as failure lines. */
function caseFailures(result: EvalResult): ProposalFailure[] {
  return result.cases
    .filter((c) => !c.passed)
    .map((c) => {
      const a = c.assertions.find((x) => !x.passed);
      return {
        case: c.name,
        ...(c.runId ? { runId: c.runId } : {}),
        check: c.name,
        detail: cut(c.error ?? (a ? `${a.assertion.type}: ${a.assertion.value} — ${a.detail}` : "failed"), DETAIL_CHARS),
        at: result.finishedAt,
      };
    });
}

/** Should the pass open a proposal for this grader now? */
export function dueForProposal(info: EvalInfo, unreviewed: Grade[], proposals: Proposal[], now = Date.now()): boolean {
  if (!info.improve || unreviewed.length === 0) return false;
  const mine = proposals.filter((p) => p.eval === info.name);
  if (mine.some((p) => OPEN.includes(p.status))) return false;
  const lastAuto = mine.filter((p) => p.by === "auto").map((p) => Date.parse(p.createdAt)).sort((a, b) => b - a)[0];
  if (lastAuto && now - lastAuto < AUTO_EVERY_MS) return false;
  const oldest = Math.min(...unreviewed.map((g) => Date.parse(g.at)));
  return unreviewed.length >= info.improve || now - oldest >= STALE_FAILURE_MS;
}

// ---------------------------------------------------------------- the prompt

/** What the assistant is asked: bounded, whatever the failures were. */
export function improvePrompt(info: EvalInfo, failures: ProposalFailure[]): string {
  const target = info.flow ? `the flow \`${info.flow}\`` : `the agent \`${info.agent}\``;
  const kind = info.trigger === "runs" ? "grades real finished runs" : "runs test cases";
  const checks = info.cases
    .map((c) => `- ${cut(c.name, 80)}: ${c.expect.map((a) => `${a.type}: ${cut(a.value, 120)}`).join("; ")}`)
    .slice(0, 12)
    .join("\n");
  const lines = failures
    .slice(0, DIGEST_FAILURES)
    .map((f) => `- ${f.runId ? `run ${f.runId}` : `case "${cut(f.case ?? "", 80)}"`} · ${cut(f.check, 80)}: ${f.detail}`)
    .join("\n");
  const text =
    `The eval \`${info.name}\` (evals/${info.file}) ${kind} of ${target}, and these keep failing:\n\n${lines}\n\n` +
    `Its checks:\n${checks}\n\n` +
    `Read the files these runs used — the agent's agent.md, the flow, any skills they name — and the runs themselves where it helps ` +
    `(read_run on a run id). Find the cause, and propose the smallest change that fixes it. ` +
    `Propose only agents/<name>/agent.md, flows/<name>.md or skills/<name>/SKILL.md (and files under a skill). ` +
    `Do not change the eval itself, and do not loosen a check to make it pass: change what the agent does. ` +
    `If the fault is not in these files (a missing secret, an outage, a wrong check), say so and propose nothing.`;
  return text.slice(0, 7_500);
}

// ---------------------------------------------------------------- opening

/**
 * Open a proposal: a drafting record, and an assistant job to draft it.
 * `failures` are the lines it covers; `by` who asked (`auto` for the pass).
 */
export async function openProposal(
  tenant: string,
  workspace: string,
  info: EvalInfo,
  failures: ProposalFailure[],
  by: string,
  now = Date.now(),
): Promise<Proposal> {
  if (failures.length === 0) throw refuse(`${info.name} has no failures to propose a fix for`, 409);
  // One open proposal per eval, across every replica: a claim record names
  // the proposal that holds the eval, taken by compare-and-set — two requests
  // at once cannot both open one (and both pay for a draft).
  const lockScope = `${workspace}/~open:${info.name}`;
  type Claim = { holder: string; at: number };
  const held = (await getNotice<Claim>(tenant, "proposal", lockScope))?.payload ?? null;
  if (held?.holder) {
    const holder = await getProposal(tenant, workspace, held.holder);
    // No record yet for a fresh claim: another request is creating it right
    // now — in progress, not free. A claim whose record never appeared is
    // taken back after CLAIM_GRACE_MS.
    if (!holder && now - (held.at ?? 0) < CLAIM_GRACE_MS) throw refuse(`a proposal for ${info.name} is being opened right now — wait a moment`, 409);
    const current = holder ? await settleProposal(tenant, holder, now) : null;
    if (current && OPEN.includes(current.status)) throw refuse(`a proposal for ${info.name} is already ${current.status} (${current.id}) — apply or dismiss it first`, 409);
  }
  const id = newId();
  const claimed = await updateNotice<Claim>(tenant, "proposal", lockScope, (prev) =>
    (prev?.holder ?? null) === (held?.holder ?? null) ? { holder: id, at: now } : prev!,
  );
  if (claimed?.holder !== id) throw refuse(`a proposal for ${info.name} was opened a moment ago — apply or dismiss it first`, 409);
  const at = new Date(now).toISOString();
  const job: AssistantJob = {
    id: newJobId(),
    tenant,
    workspace,
    owner: `improve:${workspace}`,
    conversation: null,
    request: { messages: [{ role: "user", content: improvePrompt(info, failures) }], files: [], page: "evals" },
  };
  const p: Proposal = {
    id,
    workspace,
    eval: info.name,
    by,
    createdAt: at,
    updatedAt: at,
    status: "drafting",
    failures: failures.slice(0, DIGEST_FAILURES),
    jobId: job.id,
    reply: "",
    files: [],
    issues: [],
  };
  await save(tenant, p, () => p);
  try {
    if (process.env.FOLDRUN_ASSISTANT_INLINE === "1") {
      // No worker tier: this process drafts it, and the pass picks the
      // result up on its next look, the same as from the queue.
      void runInline(job).catch((err) => console.error(`[foldrun] proposal ${p.id}: the draft failed —`, err instanceof Error ? err.message : err));
    } else {
      await enqueueAssistantJob(job);
    }
  } catch (err) {
    const error = `the draft could not be queued — ${err instanceof Error ? err.message : String(err)}`;
    return save(tenant, p, (prev) => ({ ...(prev ?? p), status: "failed", error, updatedAt: new Date().toISOString() }));
  }
  return p;
}

/** A person asks for a proposal now: from a grader's unreviewed failures,
 *  or from an eval's last result's failed cases. */
export async function proposeNow(tenant: string, workspace: string, evalName: string, by: string): Promise<Proposal> {
  const info = listEvals(tenant, workspace).find((e) => e.name === evalName);
  if (!info) throw refuse(`eval ${evalName} not found`, 404);
  let failures: ProposalFailure[];
  if (info.trigger === "runs") {
    const proposals = await listProposals(tenant, workspace);
    failures = unreviewedGrades(readGrades(tenant, workspace, evalName), proposals, evalName).flatMap(gradeFailures);
    if (!failures.length) throw refuse(`${evalName} has no failed grades a proposal has not covered — nothing to fix`, 409);
  } else {
    const last = readEvalResult(tenant, workspace, evalName);
    failures = last ? caseFailures(last) : [];
    if (!failures.length) throw refuse(`${evalName}'s last result has no failed cases — run it first, or there is nothing to fix`, 409);
  }
  return openProposal(tenant, workspace, info, failures, by);
}

// ---------------------------------------------------------------- the draft

/**
 * Settle a drafting proposal from its job: ready (with its files, the ones
 * it may propose), failed (an error, nothing proposed, or never finished).
 * Returns the proposal as it now stands. Safe to call from any process at
 * any time; a settled proposal is returned unchanged.
 */
export async function settleProposal(tenant: string, p: Proposal, now = Date.now()): Promise<Proposal> {
  if (p.status === "applying") return recoverApplying(tenant, p, now);
  if (p.status === "failed" && p.timedOut && p.jobId) return lateDraft(tenant, p, now);
  if (p.status !== "drafting" || !p.jobId) return p;
  const end = readJobEnd(tenant, p.jobId);
  const stamp = new Date(now).toISOString();
  if (!end) {
    if (now - Date.parse(p.createdAt) < DRAFT_TIMEOUT_MS) return p;
    return save(tenant, p, (prev) => (prev?.status === "drafting" ? { ...prev, status: "failed", timedOut: true, error: "the draft has not finished in half an hour — the assistant queue may be busy; it is copied in if it finishes, or propose again", updatedAt: stamp } : (prev ?? p)));
  }
  if (end.type === "error") {
    return save(tenant, p, (prev) => (prev?.status === "drafting" ? { ...prev, status: "failed", error: `the draft failed — ${end.error}`, updatedAt: stamp } : (prev ?? p)));
  }
  if (end.type !== "done") return p;
  const r = end.result;
  const kept = r.files.filter((f) => proposable(f.path));
  const dropped = r.files.filter((f) => !proposable(f.path)).map((f) => f.path);
  const notes = dropped.length ? [`left out — a proposal changes only agents, flows and skills: ${dropped.join(", ")}`] : [];
  // The assistant checked the tree with every file it proposed; with some
  // left out, what remains is checked again on its own — an agent naming a
  // tool that was dropped is then an error, and Apply refuses it.
  let issues: DraftIssue[] = r.issues;
  if (dropped.length && kept.length) {
    try {
      issues = checkProposals(tenant, p.workspace, kept.map((f) => ({ path: f.path, content: f.content })));
    } catch (err) {
      issues = [{ where: kept[0].path, level: "error", message: `could not be checked without the files left out — ${err instanceof Error ? err.message : String(err)}` }];
    }
  }
  return save(tenant, p, (prev) => {
    if (prev?.status !== "drafting") return prev ?? p;
    if (!kept.length) {
      return { ...prev, status: "failed", reply: r.reply, notes, error: "the assistant proposed no change to agents, flows or skills — its answer says why", updatedAt: stamp };
    }
    return { ...prev, status: "ready", reply: r.reply, files: kept, issues, notes, updatedAt: stamp };
  });
}

/** How long an apply may sit in `applying` before it is taken to have died. */
const APPLY_STALE_MS = 5 * 60_000;

/**
 * An apply whose process died, or whose last write of the record failed,
 * leaves the proposal `applying` — and an open proposal blocks the eval.
 * After APPLY_STALE_MS it is read off the files themselves: every file as
 * proposed is `applied`, some is `partial` (naming them), none is `ready`
 * again.
 */
async function recoverApplying(tenant: string, p: Proposal, now: number): Promise<Proposal> {
  if (now - Date.parse(p.updatedAt) < APPLY_STALE_MS) return p;
  // The writer saves `${content.trimEnd()}\n` — compared the same way.
  const written = p.files.filter((f) => currentSha(tenant, p.workspace, f.path) === sha256(`${f.content.trimEnd()}\n`)).map((f) => f.path);
  const stamp = new Date(now).toISOString();
  return save(tenant, p, (prev) => {
    if (prev?.status !== "applying") return prev ?? p;
    if (written.length === p.files.length) return { ...prev, status: "applied", applied: written, updatedAt: stamp, notes: [...(prev.notes ?? []), "the apply was interrupted after writing every file; recorded as applied"] };
    if (written.length) return { ...prev, status: "partial", applied: written, error: `the apply was interrupted after ${written.length} of ${p.files.length} files`, updatedAt: stamp };
    return { ...prev, status: "ready", updatedAt: stamp, notes: [...(prev.notes ?? []), "an apply was interrupted before writing anything; it can be applied again"] };
  });
}

/** A timed-out draft whose job finished after all: copied in — the work was
 *  paid for — unless another proposal for the eval is open, which then
 *  stands alone. */
async function lateDraft(tenant: string, p: Proposal, now: number): Promise<Proposal> {
  const end = readJobEnd(tenant, p.jobId!);
  if (!end || end.type !== "done") return p;
  const others = (await listProposals(tenant, p.workspace)).filter((x) => x.eval === p.eval && x.id !== p.id && OPEN.includes(x.status));
  if (others.length) return p;
  const revived = await save(tenant, p, (prev) => (prev?.status === "failed" && prev.timedOut ? { ...prev, status: "drafting", timedOut: false, error: undefined } : (prev ?? p)));
  return revived.status === "drafting" ? settleProposal(tenant, revived, now) : revived;
}

// ---------------------------------------------------------------- deciding

/** What a file is now, as the proposal compares it: its sha256, or null. */
function currentSha(tenant: string, workspace: string, rel: string): string | null {
  const abs = path.join(workspaceDir(tenant, workspace), rel);
  try {
    return sha256(fs.readFileSync(abs, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Apply a ready proposal: every file checked first (still what it was drawn
 * against, writable, its frontmatter readable), then all written with nothing
 * in between. 409 when one changed since, 422 when one could not be written
 * or the checks found an error the deploy would refuse.
 */
export async function applyProposal(tenant: string, workspace: string, id: string, by: string): Promise<Proposal> {
  const p = await getProposal(tenant, workspace, id);
  if (!p) throw refuse(`no proposal ${id} in ${workspace}`, 404);
  if (p.status !== "ready") throw refuse(`proposal ${id} is ${p.status} — only a ready one can be applied`, 409);
  if (p.issues.some((i) => i.level === "error")) {
    throw refuse(`proposal ${id} has a check error a deploy would refuse — ${p.issues.find((i) => i.level === "error")!.message}; dismiss it and propose again`, 422);
  }
  // Take it: only one apply at a time, across every replica.
  let mine = false;
  const taken = await save(tenant, p, (prev) => {
    if (prev?.status !== "ready") return prev ?? p;
    mine = true;
    return { ...prev, status: "applying", updatedAt: new Date().toISOString() };
  });
  if (!mine) throw refuse(`proposal ${id} is ${taken.status} — only a ready one can be applied`, 409);
  const release = (change: Partial<Proposal>) => save(tenant, taken, (prev) => ({ ...(prev ?? taken), ...change, updatedAt: new Date().toISOString() }));

  // Every file checked before any is written.
  for (const f of taken.files) {
    let problem: string | null = null;
    try {
      assertEditablePath(f.path);
      if (!proposable(f.path)) problem = `${f.path} is not a file a proposal may change`;
      else if (f.content.length > MAX_EDITABLE_FILE) problem = `${f.path} is too large`;
      // Every file, as the writer will: it parses frontmatter whatever the extension.
      else matter(f.content);
    } catch (err) {
      problem = `${f.path} cannot be written — ${err instanceof Error ? err.message : String(err)}`;
    }
    if (problem) {
      await release({ status: "ready" });
      throw refuse(problem, 422);
    }
    const now = currentSha(tenant, workspace, f.path);
    if (now !== f.sha256) {
      await release({ status: "ready" });
      throw refuse(`${f.path} changed since this proposal was drawn up — dismiss it and propose again`, 409);
    }
  }
  // And checked again against the workspace as it is now: a flow naming an
  // agent that was deleted since the draft is refused, not written.
  let now: DraftIssue[] = [];
  try {
    now = checkProposals(tenant, workspace, taken.files.map((f) => ({ path: f.path, content: f.content })));
  } catch (err) {
    now = [{ where: taken.files[0]?.path ?? "workspace", level: "error", message: `could not be checked — ${err instanceof Error ? err.message : String(err)}` }];
  }
  const broke = now.find((i) => i.level === "error");
  if (broke) {
    await release({ status: "ready", issues: now });
    throw refuse(`${broke.where}: ${broke.message} — the workspace changed since this was drawn up; dismiss it and propose again`, 422);
  }
  // Then written, one after another with nothing in between.
  const written: string[] = [];
  try {
    for (const f of taken.files) {
      writeWorkspaceFile(tenant, workspace, f.path, f.content, { by, message: `applied proposal ${id} (${taken.eval})` });
      written.push(f.path);
    }
  } catch (err) {
    // The writer saves the file before its revision and bundle steps, so a
    // throw can come after the bytes changed: what was written is read off
    // the files themselves, not off the loop.
    const landed = taken.files.filter((f) => currentSha(tenant, workspace, f.path) === sha256(`${f.content.trimEnd()}\n`)).map((f) => f.path);
    written.splice(0, written.length, ...landed);
    const error = `stopped after ${written.length} of ${taken.files.length} files — ${err instanceof Error ? err.message : String(err)}`;
    await release({ status: "partial", applied: written, error, decidedBy: by, decidedAt: new Date().toISOString() });
    throw refuse(`proposal ${id}: ${error}`, 500);
  }
  return release({ status: "applied", applied: written, decidedBy: by, decidedAt: new Date().toISOString() });
}

export async function dismissProposal(tenant: string, workspace: string, id: string, by: string): Promise<Proposal> {
  const p = await getProposal(tenant, workspace, id);
  if (!p) throw refuse(`no proposal ${id} in ${workspace}`, 404);
  const dismissible = (s: ProposalStatus | undefined) => s === "ready" || s === "failed" || s === "drafting";
  if (!dismissible(p.status)) throw refuse(`proposal ${id} is ${p.status} — it cannot be dismissed`, 409);
  // Decided inside the lock: an apply that took it a moment ago wins, and
  // this says so rather than overwriting "applying" or "applied".
  // A failed draft covers nothing; dismissing it only clears it from view.
  const after = await save(tenant, p, (prev) =>
    dismissible(prev?.status)
      ? { ...prev!, status: "dismissed", ...(prev!.status === "failed" ? { draftFailed: true } : {}), decidedBy: by, decidedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
      : (prev ?? p),
  );
  if (after.status !== "dismissed") throw refuse(`proposal ${id} is ${after.status} — it cannot be dismissed`, 409);
  return after;
}

// ---------------------------------------------------------------- the pass

/**
 * Settle every drafting or applying proposal in an account, graders or not:
 * a draft a person asked for on a case eval must be copied in before its
 * job's event files are swept (six hours), whoever looks at it, and an
 * apply that died must not hold its eval. Costs nothing — it reads files.
 */
export async function settleAccount(tenant: string, now = Date.now()): Promise<number> {
  let n = 0;
  for (const p of await listProposals(tenant)) {
    if (p.status !== "drafting" && p.status !== "applying" && !(p.status === "failed" && p.timedOut)) continue;
    const after = await settleProposal(tenant, p, now).catch(() => p);
    if (after.status !== p.status) n++;
  }
  return n;
}

/**
 * After the grade pass has graded a workspace: settle its drafting
 * proposals, then open one for each grader whose failures are due. Called
 * by grade-pass.ts (setAfterGrades); bounded by DIGEST_FAILURES per draft
 * and one draft per grader a day.
 */
export async function improveWorkspace(tenant: string, workspace: string, graders = listGraders(tenant, workspace), now = Date.now()): Promise<Proposal[]> {
  let proposals = await listProposals(tenant, workspace);
  for (const p of proposals.filter((x) => x.status === "drafting" || x.status === "applying")) await settleProposal(tenant, p, now);
  proposals = await listProposals(tenant, workspace);
  const opened: Proposal[] = [];
  for (const info of graders) {
    if (!info.improve) continue;
    const unreviewed = unreviewedGrades(readGrades(tenant, workspace, info.name), proposals, info.name);
    if (!dueForProposal(info, unreviewed, proposals, now)) continue;
    try {
      const p = await openProposal(tenant, workspace, info, unreviewed.flatMap(gradeFailures), "auto", now);
      opened.push(p);
      proposals = [p, ...proposals];
    } catch (err) {
      console.error(`[foldrun] improve ${tenant}/${workspace}/${info.name}:`, err instanceof Error ? err.message : err);
    }
  }
  await pruneProposals(tenant, workspace, proposals, now);
  return opened;
}

/**
 * Keep the newest decided proposals whole; past KEEP_DECIDED keep only what
 * says which failures they covered (the files and the reasoning go), so a
 * failure someone already looked at never counts again; drop a proposal
 * only once every grade it could cover has aged out (GRADE_KEEP_MS).
 */
async function pruneProposals(tenant: string, workspace: string, proposals: Proposal[], now = Date.now()): Promise<void> {
  const decided = proposals.filter((p) => !OPEN.includes(p.status));
  for (const old of decided.slice(KEEP_DECIDED)) {
    const gone = now - Date.parse(old.createdAt) > GRADE_KEEP_MS;
    if (!gone && !old.files.length && !old.reply) continue; // already slim
    // A notice has no delete of its own, and its payload column refuses
    // NULL: a pruned one becomes a tombstone without an id, which every
    // reader skips (listProposals, getProposal).
    await updateNotice<Proposal>(tenant, "proposal", `${workspace}/${old.id}`, (prev) =>
      gone || !prev
        ? ({ deleted: true } as unknown as Proposal)
        : { ...prev, files: [], reply: "", issues: [], notes: [...(prev.notes ?? []), "its files and reasoning were removed to keep the record short"] },
    ).catch((err) => console.error(`[foldrun] proposal ${workspace}/${old.id}: not pruned —`, err instanceof Error ? err.message : err));
  }
}

export type { Grade };
