// A run, written for the assistant to read when someone asks why it failed
// (FOL-22, the run doctor). Bounded, and data only: the run's own events
// were redacted when they were written (runner.ts), and what comes back
// here is quoted to the model as data, never as instructions.

import type { RunRecord, RunSummary, StepRecord } from "../../../foldrun-core/src/store.ts";

/** Ceilings, so a long run cannot fill the model's context. */
export const DIGEST_LIMITS = {
  /** The overview of a whole run. */
  overview: 14_000,
  /** One step in detail. */
  step: 14_000,
  /** Error lines per step in the overview. */
  errorsPerStep: 3,
  /** Events in a step's detail, the latest kept. */
  events: 60,
  line: 400,
  result: 3_000,
  instruction: 1_500,
  /** Runs listed when no id is given. */
  runs: 12,
};

const cut = (s: string | null | undefined, n: number) => {
  const t = (s ?? "").replace(/\s+$/g, "");
  return t.length > n ? `${t.slice(0, n)}… (cut)` : t;
};
const oneLine = (s: string | null | undefined, n: number) => cut((s ?? "").replace(/\s*\n\s*/g, " ⏎ "), n);

function stepHead(s: StepRecord, i: number): string {
  const opts = [
    s.optional ? "optional" : null,
    s.approve ? "approval" : null,
    s.when ? `when: ${s.when}` : null,
    s.retry ? `retry: ${s.retry}` : null,
    s.attempts && s.attempts > 1 ? `${s.attempts} attempts` : null,
    s.onFail ? `on-fail: ${s.onFail}` : null,
    s.carriedFrom ? `carried from ${s.carriedFrom}` : null,
  ].filter(Boolean);
  return `#${i} [group ${s.group}] ${s.agent} — ${s.status}${opts.length ? ` (${opts.join(", ")})` : ""}`;
}

function stepBlock(s: StepRecord, i: number): string {
  const lines = [stepHead(s, i)];
  if (s.verify) lines.push(`   verify: ${oneLine(s.verify, 300)}`);
  if (s.skipReason) lines.push(`   skipped: ${oneLine(s.skipReason, 300)}`);
  const errors = s.events.filter((e) => e.type === "error").slice(-DIGEST_LIMITS.errorsPerStep);
  for (const e of errors) lines.push(`   error: ${oneLine(e.text, DIGEST_LIMITS.line)}`);
  if (s.result) lines.push(`   result: ${oneLine(s.result, 300)}`);
  return lines.join("\n");
}

/**
 * The run in one view: what it is, and every step with its errors and result.
 * Over the budget, the failed and unfinished steps are kept whole and the
 * rest go to one line each, then to a count — a failure near the end of a
 * long flow is never cut off (Codex review).
 */
export function runOverview(run: RunRecord): string {
  const head = [
    `run ${run.id} · flow ${run.flow} · ${run.status}${run.verdict ? ` · verdict ${run.verdict}` : ""}${run.test ? " · test run" : ""}`,
    `started ${run.startedAt}${run.finishedAt ? ` · finished ${run.finishedAt}` : ""}`,
    run.summary ? `summary: ${oneLine(run.summary, DIGEST_LIMITS.line)}` : null,
    "",
    `steps 0–${run.steps.length - 1} (read_run with step: N for one in full):`,
  ].filter((l): l is string => l !== null).join("\n");
  const full = [head, ...run.steps.map(stepBlock)].join("\n");
  if (full.length <= DIGEST_LIMITS.overview) return full;
  const important = (s: StepRecord) => s.status !== "completed" && s.status !== "skipped";
  const lines = run.steps.map((s, i) => (important(s) ? stepBlock(s, i) : stepHead(s, i)));
  let text = [head, ...lines].join("\n");
  if (text.length > DIGEST_LIMITS.overview) {
    const kept = run.steps.map((s, i) => (important(s) ? stepBlock(s, i) : null)).filter((l): l is string => l !== null);
    const others = run.steps.length - kept.length;
    text = [head, `(${others} completed or skipped steps not listed — read_run with step: N)`, ...kept].join("\n");
  }
  return cut(text, DIGEST_LIMITS.overview);
}

/** One step in full: what it was asked, how it was checked, what it did last. */
export function stepDetail(run: RunRecord, index: number): string | null {
  const s = run.steps[index];
  if (!s) return null;
  const top = [
    `run ${run.id} · flow ${run.flow} · step ${stepHead(s, index)}`,
    `instruction: ${cut(s.instruction, DIGEST_LIMITS.instruction)}`,
    s.verify ? `verify: ${cut(s.verify, 1_500)}` : null,
    s.credential ? `model credential: ${cut(s.credential, 200)}` : null,
    s.costUsd !== null && s.costUsd !== undefined ? `cost: $${s.costUsd.toFixed(4)}` : null,
  ].filter((l): l is string => l !== null);
  const tail = [s.conclusion ? `conclusion: ${cut(s.conclusion, 600)}` : null, `result: ${s.result ? cut(s.result, DIGEST_LIMITS.result) : "(none)"}`].filter(
    (l): l is string => l !== null,
  );
  // The newest events are the evidence, and the result and conclusion are
  // reserved for: the events fill what is left, newest first (Codex review).
  let room = DIGEST_LIMITS.step - [...top, ...tail].join("\n").length - 80;
  const events: string[] = [];
  for (const e of s.events.slice(-DIGEST_LIMITS.events).reverse()) {
    const line = `  ${e.t.slice(11, 19)} ${e.type}: ${oneLine(e.text, DIGEST_LIMITS.line)}`;
    if (line.length + 1 > room) break;
    room -= line.length + 1;
    events.unshift(line);
  }
  const shown = `events (the last ${events.length} of ${s.events.length}):`;
  // Every part is bounded above, so this cut is a last guard, not the plan.
  return cut([...top, shown, ...events, ...tail].join("\n"), DIGEST_LIMITS.step);
}

/** The latest runs, failed ones marked, for when no id is named. */
export function recentRuns(runs: RunSummary[]): string {
  if (!runs.length) return "This workspace has no runs yet.";
  return runs
    .slice(0, DIGEST_LIMITS.runs)
    .map((r) => `${r.id} · ${r.flow} · ${r.status} · ${r.startedAt}${r.summary ? ` · ${oneLine(r.summary, 160)}` : ""}`)
    .join("\n");
}
