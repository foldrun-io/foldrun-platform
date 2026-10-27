// The money ledger. Append-only, one line per event, one file per account:
//
//   data/<tenant>/ledger.jsonl
//
// A balance is the sum of the lines — there is no stored balance to drift
// out of agreement with its own history, which for money is the failure
// mode that matters. Run costs are recorded once per run (idempotent by
// run id), so re-driving a resumed run cannot bill it twice.
//
// Enforcement is opt-in per install: FOLDRUN_BILLING=1 makes an empty tank
// refuse new runs. Self-hosters who never set it get the ledger as pure
// observability — the "Spent" tile with a paper trail — and the CLI never
// sets it, so local runs are never refused. The hosted platform sets it.

import fs from "node:fs";
import crypto from "node:crypto";
import { databaseEnabled } from "./db.ts";
import { appendDb, readLedgerDb, backfillLedger, runChargedDb } from "./ledger-db.ts";
import path from "node:path";
import { accountDir, assertSafeName, registerRunDeletionListener } from "../../foldrun-core/src/store.ts";
import { billing, freeBilling } from "./billing.ts";

// The books hear about deletions without store.ts importing money.
registerRunDeletionListener((tenant, workspace, runId) => noteRunDeleted(tenant, workspace, runId));

export interface LedgerEntry {
  t: string;
  /** topup: money that arrived. run: a charge. adjustment: money decided —
   *  a refund, a correction, a daily accrual. grant: a plan's bundled
   *  credits for one cycle (or the trial), which expire. expire: the unused
   *  part of a grant, removed when its cycle ends. */
  kind: "topup" | "run" | "adjustment" | "grant" | "expire";
  /** Positive credits the account, negative spends it. For a run this is
   *  the *charge* — what the customer's credits paid, margin included. */
  usd: number;
  /** What the run cost the platform at the provider, before margin. Kept on
   *  the same line so every charge carries its own audit: the margin earned
   *  on any entry is `-usd - cost`, derivable forever, stored nowhere.
   *  Absent on entries written before margin existed (charge == cost then).
   *  Zero on a BYOK run — the tokens were bought on the customer's own
   *  account and never passed through ours. */
  cost?: number;
  /** The non-token units this run was billed on. Recorded because a line
   *  that says only "$0.03" cannot be argued with; one that says "4 steps,
   *  71.2 sandbox seconds" can be checked against the run it came from.
   *  Absent on entries written before run/step/compute pricing existed. */
  meter?: { steps: number; computeSecs: number; netBytes?: number };
  /** The charge, split the way a customer thinks about it: what the models
   *  cost and what the platform cost. Two different things — a customer on
   *  their own key pays no model leg at all, and one whose bill jumped
   *  needs to know which half moved. The parts sum to `-usd`. Absent on
   *  entries written before the split existed. */
  split?: { modelUsd: number; computeUsd: number; networkUsd: number };
  /** On a `grant`: how much of it is last cycle's unused credit rolling
   *  over, rather than the plan's own bundle. Shown apart, because "you
   *  have 54,000 credits" and "your plan is 29,000 and you carried 25,000"
   *  are answers to different questions. */
  carriedUsd?: number;
  /** On a `run`: the legs of the charge this account does not pay, and so
   *  the reason a figure is lower than the meter implies. A zero with no
   *  explanation on a statement reads as a bug; this is the explanation. */
  waived?: ("models" | "compute" | "network")[];
  workspace?: string;
  runId?: string;
  /** The flow this run was, kept on the line so "what does this desk cost"
   *  survives the run record being pruned. Absent on entries written before
   *  attribution existed, and on charges that are not a run. */
  flow?: string;
  /** This run's charge split across the agents that did the work, in
   *  proportion to what each of them actually consumed. The shares sum to
   *  the charge, so a column of them can be added up without apology. */
  agents?: Record<string, number>;
  note?: string;
  /** The once-only handle: what makes two writes of the same fact one
   *  line. `run:<id>` for a charge, `accrual:base-fee:<day>`,
   *  `pod:<kind>:<name>:<from>`, `grant:<marker>`. The database refuses a
   *  second row with the same key (ledger-db.ts); the file store checks
   *  it with a marker. Absent on lines from before keys existed. */
  key?: string;
  /** Why this line exists, finer than `kind`: a refund and an operator's
   *  goodwill credit are both adjustments, and a report that cannot tell
   *  them apart counts a refund as spend. Absent on lines from before it
   *  existed — `entryReason` derives those from the key and the note. */
  reason?: LedgerReason;
}

/** The reasons a line can have. Stored as text; the list is the vocabulary
 *  every report, statement and burn figure reads through `entryReason`. */
export type LedgerReason =
  | "usage"          // a run's charge
  | "pod"            // an account pod's session — metered work, like a run
  | "fee"            // the daily base fee or storage accrual
  | "checkout"       // a top-up paid through Checkout
  | "auto-topup"     // a top-up charged to the saved card
  | "manual"         // a top-up written without a payment (a dev install, a script)
  | "operator"       // the super admin's credit or debit
  | "refund"         // money back to the card
  | "dispute"        // a chargeback opened
  | "dispute-won"    // a chargeback decided in our favour: the money is back
  | "plan"           // a plan cycle's grant
  | "trial"          // a new account's first credits
  | "grant-expired"  // the unused part of a cycle's grant, at its end
  | "credits-expired"; // bought credit past its shelf life

export const LEDGER_REASONS: readonly LedgerReason[] = [
  "usage", "pod", "fee", "checkout", "auto-topup", "manual", "operator", "refund", "dispute", "dispute-won", "plan", "trial", "grant-expired", "credits-expired",
];

/**
 * Why a line exists: its own `reason`, or — for a line written before the
 * field — what its key and note say. The derivation reads the markers the
 * writers have always used, so an old refund and a new one land in the same
 * column of every report.
 */
export function entryReason(e: LedgerEntry): LedgerReason {
  if (e.reason && LEDGER_REASONS.includes(e.reason)) return e.reason;
  const key = e.key ?? "";
  const note = e.note ?? "";
  switch (e.kind) {
    case "run":
      return "usage";
    case "topup":
      if (note.startsWith("stripe:evt_")) return "auto-topup";
      if (note.startsWith("stripe:")) return "checkout";
      return "manual";
    case "grant":
      return note.startsWith("trial") ? "trial" : "plan";
    case "expire":
      return note.startsWith("expired purchased") ? "credits-expired" : "grant-expired";
    case "adjustment":
      if (key.startsWith("refund:") || /^refund\b/.test(note)) return "refund";
      if (key.startsWith("dispute-won:")) return "dispute-won";
      if (key.startsWith("dispute:") || /^dispute\b/.test(note)) return "dispute";
      if (key.startsWith("accrual:") || /^(base fee|storage) /.test(note)) return "fee";
      if (key.startsWith("pod:")) return "pod";
      return "operator";
  }
  return "operator";
}

/** Metered work: what a customer can spend less of by running less. The
 *  one definition of "usage" every report and the admin console count. */
export function isUsage(e: LedgerEntry): boolean {
  const r = entryReason(e);
  return e.usd < 0 && (r === "usage" || r === "pod");
}

/** What the account burns: usage and the daily fees. Not an expiry (credit
 *  that lapsed was never spent), not a refund or a chargeback (money that
 *  went back), not an operator's correction. */
export function isBurn(e: LedgerEntry): boolean {
  const r = entryReason(e);
  return e.usd < 0 && (r === "usage" || r === "pod" || r === "fee");
}

/** A line as a statement names it — from its reason, never from guessing
 *  at the note. */
export function ledgerLabel(e: LedgerEntry): string {
  const r = entryReason(e);
  switch (r) {
    case "usage":
      return `Run · ${e.workspace ?? ""}${e.flow ? ` · ${e.flow}` : ""}`;
    case "pod":
      return `Pod session${e.note ? ` · ${e.note.split(" ")[0]}` : ""}`;
    case "fee":
      return e.note?.startsWith("storage") ? "Storage" : "Base fee";
    case "checkout":
      return "Top-up";
    case "auto-topup":
      return "Auto top-up";
    case "manual":
      return "Credit added";
    case "operator":
      return `Adjustment${e.note ? ` · ${e.note}` : ""}`;
    case "refund":
      return "Refund";
    case "dispute":
      return "Chargeback";
    case "dispute-won":
      return "Chargeback reversed";
    case "plan":
      return "Plan credits";
    case "trial":
      return "Trial credits";
    case "grant-expired":
      return "Granted credits expired";
    case "credits-expired":
      return "Credits expired";
  }
}

/**
 * What a finished run consumed. `store.ts#runMeter` produces it; nothing
 * else should, because "which steps count" is a question with one answer.
 *
 * The token cost is zero for a BYOK run, and the run is still billable:
 * bringing your own key buys you out of token resale, not out of the pod,
 * the storage and the orchestration that ran your flow.
 */
export interface RunMeter {
  tokenCostUsd: number;
  steps: number;
  computeSecs: number;
  /** Seconds of computeSecs held at the small reservation; kept on the
   *  ledger line for the audit trail. Absent means all large. */
  smallSecs?: number;
  /** The hold+work meter: reserved core-seconds and GiB-seconds, burned
   *  CPU seconds, and the plain seconds of steps recorded before
   *  reservations were facts (priced by the flat fallback). */
  compute?: { coreSecs: number; gibSecs: number; diskGibSecs?: number; busyCpuSecs: number; flatSecs: number };
  /** Bytes on the wire, both directions, where the sandbox could read its
   *  counters. Absent/zero on older runs and unreadable sandboxes. */
  netBytes?: number;
}

/** A bare number is a token-only run — the CLI and self-host paths, which
 *  rent no metered sandbox and have no compute leg to report. */
export function asMeter(meter: RunMeter | number): RunMeter {
  return typeof meter === "number"
    ? { tokenCostUsd: meter, steps: 0, computeSecs: 0 }
    : meter;
}

export const micro = (n: number) => Math.round(n * 1e6) / 1e6;

function ledgerFile(tenant: string) {
  return path.join(accountDir(tenant), "ledger.jsonl");
}

/**
 * What the platform tells core's `edition()` hook. Hosted when billing is
 * enforced or a Stripe key is present — either means a customer is on the
 * other side of this install. A dev or laptop install runs this same code
 * and answers `self-hosted` because its operator set neither, which is how
 * one build serves both without a second image to drift.
 */
export function edition(): "self-hosted" | "hosted" {
  // FOLDRUN_EDITION=hosted says it outright. Inferring it from billing was
  // wrong on the one install that matters: foldrun's own box is the hosted
  // platform before billing is switched on, and reading "no billing" as
  // "community image" made the admin console a 404 there.
  // An install built without billing (freeBilling) is self-hosted, whatever
  // the environment says: the hosted pages it would link to are not there.
  if (billing() === freeBilling) return "self-hosted";
  if (process.env.FOLDRUN_EDITION === "hosted") return "hosted";
  if (process.env.FOLDRUN_EDITION === "self-hosted") return "self-hosted";
  return billing().enabled() || !!process.env.STRIPE_SECRET_KEY ? "hosted" : "self-hosted";
}

/**
 * Every entry for an account.
 *
 * Postgres when this install has one, the JSONL file otherwise. Async because
 * the first case is a query — and a balance read from two different places
 * depending on the caller is how a ledger stops agreeing with itself.
 */
export async function readLedger(tenant: string): Promise<LedgerEntry[]> {
  if (databaseEnabled()) return readLedgerDb(tenant);
  return readLedgerFile(tenant);
}

/** The file, which stays the fallback and the thing backups already carry. */
export function readLedgerFile(tenant: string): LedgerEntry[] {
  const file = ledgerFile(tenant);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as LedgerEntry;
      } catch {
        return null; // a torn tail line loses one entry, never the file
      }
    })
    .filter((e): e is LedgerEntry => e !== null);
}

/**
 * Write one entry. True when it landed; false when the database already
 * held a line for the same run or the same key, and nothing was written
 * anywhere.
 *
 * BOTH stores while a database is configured, DATABASE FIRST. The database
 * is where once-only is decided — a unique index is the only thing that
 * holds across worker pods — so it has to say yes before the file gets the
 * line, or the file would carry a charge the books refused. The file is
 * still what backups carry and what an install falls back to; a crash
 * between the two writes loses one file line, which the next backfill
 * cannot restore but also cannot double — the safe side.
 */
export async function append(tenant: string, entry: LedgerEntry): Promise<boolean> {
  if (databaseEnabled() && !(await appendDb(tenant, entry))) return false;
  const file = ledgerFile(tenant);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // O_APPEND: single-line writes land whole even if two land at once.
  fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  return true;
}

/**
 * The file store's once-only: a marker created with O_EXCL under the
 * account directory, atomic on one filesystem, so exactly one caller wins.
 * On the database path this is a fast path only — the second pod's disk
 * has no marker, and there the index decides. The key is hashed into the
 * filename because it is not a kebab-case name.
 */
export function claimOnce(tenant: string, key: string): boolean {
  const dir = path.join(accountDir(tenant), "once");
  fs.mkdirSync(dir, { recursive: true });
  const file = crypto.createHash("sha256").update(key).digest("hex");
  try {
    fs.writeFileSync(path.join(dir, file), key, { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/** Give a claim back: the write it guarded threw, so nothing was recorded
 *  and the next caller must be free to try. */
export function unclaimOnce(tenant: string, key: string): void {
  const file = crypto.createHash("sha256").update(key).digest("hex");
  fs.rmSync(path.join(accountDir(tenant), "once", file), { force: true });
}

/**
 * A run was deleted from history; say so where its charge lives. Written
 * only when the run had a charge — an unbilled run deleted leaves nothing
 * behind to explain. Zero-value: deletion never moves money, it only
 * completes the story of a line that now points at nothing.
 */
export async function noteRunDeleted(tenant: string, workspace: string, runId: string): Promise<void> {
  const charged = (await readLedger(tenant)).some((e) => e.kind === "run" && e.runId === runId);
  if (!charged) return;
  await append(tenant, {
    t: new Date().toISOString(),
    kind: "adjustment",
    usd: 0,
    workspace,
    runId,
    note: "run deleted from history — the charge stands",
  });
}

/**
 * Once-only for a keyed line on whichever store this install has: the
 * database's index decides when there is one (append returns false and
 * nothing else happens); the file marker decides otherwise.
 */
export async function claimKeyed(tenant: string, key: string): Promise<boolean> {
  if (databaseEnabled()) return true; // the insert itself is the claim
  return claimOnce(tenant, key);
}

/**
 * Append a line whose once-only marker was just claimed. An append that
 * THROWS gives the marker back and rethrows: a marker left behind a refused
 * write reads as "written already" to every retry, and the line is lost for
 * good. (A crash between the two still loses it rather than doubling it.)
 * No key, or the database path, has no file marker to give back.
 */
export async function appendClaimed(tenant: string, entry: LedgerEntry, key: string | undefined): Promise<boolean> {
  try {
    return await append(tenant, entry);
  } catch (err) {
    if (key && !databaseEnabled()) unclaimOnce(tenant, key);
    throw err;
  }
}

/**
 * The run's own marker. The ledger scan stays, first, because runs billed
 * before markers existed have a line but no marker — without the scan an
 * upgrade would re-bill history. Ordering the marker before the append
 * means a crash between the two loses one run's charge rather than ever
 * doubling one; between those failure modes, the one the customer can't be
 * hurt by is the right one. With a database the index is the guard and this
 * is only the fast path that spares the insert.
 *
 * A crash, not a throw: an append that THROWS gives the marker back
 * (recordRunCost), because a marker left behind a refused write reads as
 * "charged" to every retry — settle took that null as settled, and the run
 * was never billed and never marked unsettled either.
 */
function claimSettle(tenant: string, runId: string): boolean {
  assertSafeName(runId, "run id");
  // The marker as it was written before keys: billed/<runId>. Honoured, so
  // a run settled by the old code the moment before an upgrade is not
  // settled again by the new.
  if (fs.existsSync(path.join(accountDir(tenant), "billed", runId))) return false;
  return claimOnce(tenant, `run:${runId}`);
}

/**
 * An account's service pod — its search engine, its browser — from creation
 * to reaping, charged as what it is: seconds held plus the bytes it moved.
 * It is an adjustment, not a run — no run owns it, several may have used it
 * — and the note names the kind and the pod so the line can be checked
 * against the cluster's own record of it. Idempotent per pod name and start
 * time: a reaper that runs twice writes once. `small` marks the seconds as
 * held at the small reservation (search is a 100m/256Mi pod); the browser
 * pod is a default-size hold and is not.
 */
export async function recordAccountPodSession(
  tenant: string,
  session: { kind: string; podName: string; secs: number; netBytes: number; from: string; small?: boolean },
): Promise<LedgerEntry | null> {
  // Charging for an account pod's time is billing's (billing.ts); without
  // billing nothing is written.
  return billing().podSession(tenant, session);
}

/** The search pod's line, as it was before the browser joined it. */
export const recordSearchSession = (tenant: string, session: { podName: string; secs: number; netBytes: number; from: string }) =>
  recordAccountPodSession(tenant, { ...session, kind: "search", small: true });

/**
 * A run's charge, split across the agents that ran in it.
 *
 * In proportion to what each step actually consumed — its tokens at margin,
 * plus its sandbox seconds — normalised so the shares sum to the charge.
 * The fixed parts of a bill (the run fee, the floor) are spread the same
 * way, which is the ordinary treatment and the only one where the column
 * adds up to the invoice.
 *
 * A run whose steps all priced to nothing splits equally: the work happened,
 * somebody has to own it, and pretending it was free would hide a desk that
 * runs forty times a day.
 */
export function attributeToAgents(
  steps: { agent: string; costUsd?: number | null; computeSecs?: number | null; status?: string }[],
  charge: number,
): Record<string, number> {
  const ran = steps.filter((s) => s.status === "completed" || s.status === "failed");
  if (ran.length === 0 || !(charge > 0)) return {};
  const weights = new Map<string, number>();
  let total = 0;
  for (const s of ran) {
    const w = billing().stepWeight(s.costUsd ?? 0, s.computeSecs ?? 0);
    weights.set(s.agent, (weights.get(s.agent) ?? 0) + w);
    total += w;
  }
  if (total <= 0) {
    // Nothing priced: split by how many steps each agent ran, which is the
    // only signal left and is at least proportional to the work.
    const counts = new Map<string, number>();
    for (const s of ran) counts.set(s.agent, (counts.get(s.agent) ?? 0) + 1);
    const out: Record<string, number> = {};
    for (const [agent, n] of counts) out[agent] = micro((charge * n) / ran.length);
    return out;
  }
  const out: Record<string, number> = {};
  for (const [agent, w] of weights) out[agent] = micro((charge * w) / total);
  // Rounding each share on its own can leave the column a few micro-dollars
  // off the charge. The difference goes to the largest share, so the shares
  // sum to the charge exactly — which is the property the comment promises
  // and the Usage page adds up.
  const largest = [...weights.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (largest) {
    const sum = Object.values(out).reduce((n, v) => n + v, 0);
    out[largest] = micro(out[largest] + (micro(charge) - micro(sum)));
  }
  return out;
}

/**
 * Record what a finished run consumed. Idempotent: the worker calls this
 * after every drive, and a parked-then-resumed run is driven more than once.
 *
 * Returns null when there is nothing to charge — including the self-hoster
 * with no pricing configured, whose ledger stays empty rather than filling
 * with zero-dollar lines — and null when the run was charged already.
 *
 * Idempotence has to hold under *concurrency*, not just repetition: a parked
 * run is re-enqueued by the approval API while its previous drive may still
 * be settling, so two drivers can reach this function for one run at once,
 * and since 2026-09-07 those drivers can be on different pods. A
 * read-then-append check leaves a window where both see "not billed" and
 * both charge. On one pod the marker file closes it (O_EXCL is atomic on a
 * filesystem); across pods only the database's partial unique index on
 * (tenant, run_id) can, and `append` returns false when it refused.
 */
export async function recordRunCost(
  tenant: string,
  workspace: string,
  runId: string,
  meter: RunMeter | number,
  /** What the run was and who did it. Optional: the CLI and older callers
   *  charge without it, and an entry with no attribution is still a valid
   *  charge — it simply does not appear in the by-flow breakdown. */
  attribution?: { flow?: string; steps?: { agent: string; costUsd?: number | null; computeSecs?: number | null; status?: string }[] },
): Promise<LedgerEntry | null> {
  const m = asMeter(meter);
  const waive = await billing().waive(tenant);
  const price = billing().price(m, waive);
  const charge = price.totalUsd;
  // A charge of nothing normally writes nothing: a run our own gate refused
  // before its first step should leave no line. But an account whose
  // charges are WAIVED still did the work, and dropping its runs would take
  // them out of the by-flow history too — so the desk that costs the
  // platform the most would be the one it could see least about. Write the
  // line at zero, with the meter and the reason on it.
  if (!(charge > 0) && !(waive && (m.tokenCostUsd > 0 || m.steps > 0 || m.computeSecs > 0))) return null;
  // Charged already? One indexed read on the database; the file scan
  // otherwise. Then the marker, and — with a database — the insert itself,
  // which is the only check that holds across worker pods.
  if (databaseEnabled() ? await runChargedDb(tenant, runId) : (await readLedgerFile(tenant)).some((e) => e.kind === "run" && e.runId === runId)) return null;
  if (!claimSettle(tenant, runId)) return null;
  const steps = m.steps > 0 ? m.steps : 0;
  const computeSecs = m.computeSecs > 0 ? micro(m.computeSecs) : 0;
  const netBytes = Math.round(m.netBytes ?? 0);
  const entry: LedgerEntry = {
    t: new Date().toISOString(),
    kind: "run",
    usd: -charge,
    cost: m.tokenCostUsd > 0 ? micro(m.tokenCostUsd) : 0,
    ...(steps || computeSecs || netBytes
      ? { meter: { steps, computeSecs, ...(netBytes ? { netBytes } : {}) } }
      : {}),
    split: { modelUsd: price.modelUsd, computeUsd: price.computeUsd, networkUsd: price.networkUsd },
    ...(waive
      ? { waived: (["models", "compute", "network"] as const).filter((k) => waive[k]) }
      : {}),
    workspace,
    runId,
    key: `run:${runId}`,
    ...(attribution?.flow ? { flow: attribution.flow } : {}),
    ...(attribution?.steps?.length
      ? (() => {
          const agents = attributeToAgents(attribution.steps, charge);
          return Object.keys(agents).length ? { agents } : {};
        })()
      : {}),
  };
  let landed: boolean;
  try {
    landed = await append(tenant, entry);
  } catch (err) {
    // Nothing was recorded — or only the database line, which the check
    // above finds next time. Hand the marker back and let the caller's
    // retry, and after it the unsettled mark, do their jobs.
    unclaimOnce(tenant, `run:${runId}`);
    throw err;
  }
  return landed ? entry : null;
}

/**
 * Move an account's file history into the database, once.
 *
 * Called at boot on the worker. Without it an install that gains a database
 * would read a balance of zero for every account while the file sat there
 * full of entries — which for a ledger does not look like a migration, it
 * looks like everyone's money disappearing.
 */
export async function importLedgerToDatabase(tenant: string): Promise<number> {
  if (!databaseEnabled()) return 0;
  const { inserted } = await backfillLedger(tenant, readLedgerFile(tenant));
  return inserted;
}
