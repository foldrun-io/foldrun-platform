// The daily security rescan (FOL-58): every workspace's security findings,
// offline and online, once a day — and an alert only when one is NEW.
//
// Shaped by a Codex design debate (18 Oct 2026):
//   · A source (the offline checks, OSV, each remote MCP server) is
//     baselined silently the first time it is checked successfully; after
//     that a finding it has not reported before is news. What was already
//     there is on the Checks page; an alert for it on day one is the alert
//     people filter.
//   · A source that could not be checked keeps what it last found: an
//     unreachable OSV never "resolves" a vulnerability.
//   · Identity is the occurrence (rule + file + what), not its evidence: a
//     new advisory on the same pin is not a second alert. A finding that
//     goes away and comes back is news again.
//   · Delivery: a fresh finding stays pending until the notification is
//     accepted, or the workspace has chosen not to hear it (no notify:, or
//     events that leave out failed and security) — a send that failed is
//     tried again on the next pass, not marked as told.
//   · Off the scheduler's tick, at most PASS_WORKSPACES due workspaces and
//     PASS_DEADLINE_MS a pass, resuming where the last pass stopped, and
//     stopping the moment this pod is no longer the scheduler.

import { listTenants, listWorkspaces, workspaceDir } from "../../foldrun-core/src/store.ts";
import { checkTree, checkWorkspace } from "../../foldrun-core/src/workspace-check.ts";
import { TreeTooLarge } from "../../foldrun-core/src/deploy.ts";
import { onlineFindings, ONLINE_MAX_BYTES, type SourceResult } from "../../foldrun-core/src/online-checks.ts";
import { scanRule, type ScanFinding } from "../../foldrun-core/src/scan.ts";
import { notifyConfig, sendPlainNotificationOutcome } from "../../foldrun-core/src/notify.ts";
import { platform } from "../../foldrun-core/src/platform.ts";
import { getNotice, setNotice } from "./notices.ts";

export const RESCAN_EVERY_MS = 24 * 3600_000;
/** A pass that ran out of time comes back for the rest this soon. */
const UNFINISHED_EVERY_MS = 3600_000;
const PASS_WORKSPACES = 5;
const PASS_DEADLINE_MS = 120_000;
const SECURITY = new Set(["secret", "content", "security", "supply-chain"]);

export interface StoredFinding {
  rule: string;
  file: string;
  line?: number;
  message: string;
  fingerprint: string;
  source: string;
  /** The count of what a rule did not list in this file (scan.ts). */
  truncated?: true;
}

export interface SecurityNotice {
  checkedAt: number;
  /** Sources checked successfully at least once: their findings are news. */
  baselined: string[];
  /** What each source last found, kept when it could not be checked. */
  findings: StoredFinding[];
  /** Fresh findings not yet delivered. */
  pending: StoredFinding[];
  /** What could not be checked on the last pass. */
  problems: string[];
  sources: SourceResult[];
  /** When each source was last tried (checked or failed, not skipped for
   *  time) — the least recently tried go first, so a failing prefix cannot
   *  starve the rest (Codex review). */
  sourceAt?: Record<string, number>;
  /** A source was skipped for time: due again within the hour, not the day. */
  unfinished?: boolean;
}

/** Which source a finding came from: an online one says so; the rest are the offline checks. */
export function sourceOf(f: ScanFinding & { source?: string }): string {
  return typeof f.source === "string" && f.source ? f.source : "checks";
}

const stored = (f: ScanFinding): StoredFinding => ({ rule: f.rule, file: f.file, ...(f.line ? { line: f.line } : {}), message: f.message, fingerprint: f.fingerprint, source: sourceOf(f), ...(f.truncated ? { truncated: true as const } : {}) });

/**
 * Fold one pass into the last notice: what each source now holds, which are
 * fresh, what is still waiting to be told. Pure, for the tests.
 */
export function foldRescan(
  last: SecurityNotice | null,
  now: number,
  current: ScanFinding[],
  sources: SourceResult[],
  problems: string[],
  /** Files the checks left unread (over their limits): what they held last
   *  time is kept, as for a source that could not be checked. */
  unread: string[] = [],
): { notice: SecurityNotice; fresh: StoredFinding[] } {
  const checked = new Set(sources.filter((s) => s.checked).map((s) => s.source));
  // Read in part (a cap, a paged answer): what it read is real and counts,
  // but it does not resolve what it did not reach (Codex review).
  const partial = new Set(sources.filter((s) => !s.checked && s.partial).map((s) => s.source));
  // Still configured, checked or not. A source no longer declared (an MCP
  // server taken out) loses its findings; one that could not be checked
  // keeps them (Codex review).
  const configured = new Set(sources.map((s) => s.source));
  const notRead = new Set(unread);
  // A rule that said too much in a file listed only part of it (scan.ts
  // PER_FILE_RULE): what it did not list there is not resolved either.
  const truncated = new Set(current.filter((f) => f.truncated).map((f) => `${f.rule}\0${f.file}`));
  const kept = (last?.findings ?? []).filter(
    // The findings it did not list, not its old count: this scan's replaces that.
    (f) => (!checked.has(f.source) && configured.has(f.source)) || notRead.has(f.file) || (!f.truncated && truncated.has(`${f.rule}\0${f.file}`)),
  );
  const now_ = current.filter((f) => f.level !== "info" && SECURITY.has(scanRule(f.rule)?.category ?? "")).map(stored);
  const read = now_.filter((f) => checked.has(f.source) || partial.has(f.source));
  const findings = [...new Map([...kept, ...read].map((f) => [f.fingerprint, f])).values()];
  const before = new Set((last?.findings ?? []).map((f) => f.fingerprint));
  const baselinedBefore = new Set(last?.baselined ?? []);
  const fresh = read.filter((f) => baselinedBefore.has(f.source) && !before.has(f.fingerprint));
  const pending = [...new Map([...(last?.pending ?? []), ...fresh].map((f) => [f.fingerprint, f])).values()]
    // Still present: one that has since gone away is not worth telling.
    .filter((p) => findings.some((f) => f.fingerprint === p.fingerprint));
  const sourceAt = { ...(last?.sourceAt ?? {}) };
  for (const s of sources) if (!s.skipped) sourceAt[s.source] = now;
  for (const k of Object.keys(sourceAt)) if (!configured.has(k)) delete sourceAt[k];
  return {
    notice: { checkedAt: now, baselined: [...new Set([...baselinedBefore, ...checked])], findings, pending, problems, sources, sourceAt, unfinished: sources.some((s) => s.skipped) },
    fresh,
  };
}

/** Does this workspace want to hear about it? No channel, or events that
 *  leave out failed and security, is a choice — not a failed delivery. */
function wantsSecurity(tenant: string, workspace: string): boolean {
  const config = notifyConfig(tenant, workspace);
  return Boolean(config && (config.events.includes("security") || config.events.includes("failed")));
}

/** Tell the pending findings, if the workspace wants them; true when they
 *  were told or dropped by its own choice, false when the send failed. */
async function deliver(tenant: string, workspace: string, notice: SecurityNotice): Promise<void> {
  if (!notice.pending.length) return;
  if (!wantsSecurity(tenant, workspace)) {
    notice.pending = []; // suppressed by the workspace's own choice
    return;
  }
  const n = notice.pending.length;
  // A webhook whose first attempt failed is held by the delivery log, which
  // retries it itself (`retrying`) — retrying here would start a second
  // chain. Only a send that arrived or is genuinely queued clears it; one
  // that never reached the log stays pending (Codex review).
  const outcome = await sendPlainNotificationOutcome(tenant, workspace, {
    event: "security",
    headline: `🔒 ${n} new security ${n === 1 ? "finding" : "findings"} in ${workspace}`,
    detail: notice.pending.slice(0, 10).map((f) => `${f.file}${f.line ? `:${f.line}` : ""} — ${f.message} [${f.rule}]`).join(" · ") + (n > 10 ? ` · and ${n - 10} more on the Checks page` : ""),
  }).catch(() => ({ ok: false, retrying: false }));
  if (outcome.ok || outcome.retrying) notice.pending = [];
}

/** A pass that is not due a rescan still retries what it failed to tell. */
export async function retryPending(tenant: string, workspace: string, now = Date.now()): Promise<SecurityNotice | null> {
  const last = await lastRescan(tenant, workspace);
  if (!last?.pending.length) return last;
  await deliver(tenant, workspace, last);
  await setNotice(tenant, "security", workspace, last, now);
  return last;
}

/** One workspace, now. Returns the notice it saved. */
export async function rescanWorkspace(tenant: string, workspace: string, now = Date.now(), deadline = Date.now() + PASS_DEADLINE_MS): Promise<SecurityNotice> {
  const last = (await getNotice<SecurityNotice>(tenant, "security", workspace))?.payload ?? null;
  const unread: { file: string; bytes: number }[] = [];
  let tree;
  try {
    tree = checkTree(workspaceDir(tenant, workspace), (file, bytes) => unread.push({ file, bytes }));
  } catch (err) {
    if (!(err instanceof TreeTooLarge)) throw err;
    // Not read at all: everything found before stands, and the Checks page says why.
    const notice: SecurityNotice = { ...(last ?? { baselined: [], findings: [], pending: [], sources: [] }), checkedAt: now, problems: [err.message], unfinished: false };
    await deliver(tenant, workspace, notice);
    await setNotice(tenant, "security", workspace, notice, now);
    return notice;
  }
  const offline = checkWorkspace(tenant, workspace, tree);
  const online = await onlineFindings(tree, {
    fetch: (u, i) => platform.fetchUntrusted(u, i, { maxBytes: ONLINE_MAX_BYTES }),
    osvFetch: (u, i) => platform.fetchUntrusted(u, i, { maxBytes: ONLINE_MAX_BYTES }),
    // The pass's budget reaches inside the workspace: one slow server cannot
    // hold the rescan past it, and the least recently checked go first, so
    // none is starved by a slow one ahead of it (Codex review).
    deadline,
    order: Object.entries(last?.sourceAt ?? {}).sort((a, b) => a[1] - b[1]).map(([k]) => k),
  });
  const problems = [...online.problems];
  if (unread.length) {
    const mib = unread.reduce((n, u) => n + u.bytes, 0) / 1048576;
    problems.push(`${unread.length} file${unread.length === 1 ? "" : "s"} in state/ or memory/ not read (${mib.toFixed(0)} MiB, over the checks' limits): ${unread.slice(0, 5).map((u) => u.file).join(", ")}${unread.length > 5 ? ", …" : ""}`);
  }
  const { notice } = foldRescan(last, now, [...offline, ...online.findings], [{ source: "checks", checked: true }, ...online.sources], problems, unread.map((u) => u.file));
  await deliver(tenant, workspace, notice);
  // checkedAt is the scan's, so a failed send does not make the workspace
  // look freshly scanned to anything but the scan clock; the next pass
  // retries the send on its own (retryPending).
  await setNotice(tenant, "security", workspace, notice, now);
  return notice;
}

/** The last rescan of a workspace, for the Checks page and the API. */
export async function lastRescan(tenant: string, workspace: string): Promise<SecurityNotice | null> {
  return (await getNotice<SecurityNotice>(tenant, "security", workspace))?.payload ?? null;
}

let cursor = 0;

/**
 * One pass: the due workspaces from where the last pass stopped, within the
 * budget. `stillLeader` is asked before each one; a pod that has lost the
 * scheduler lease stops, so two passes never overlap for long.
 */
export async function rescanPass(now = Date.now(), stillLeader: () => Promise<boolean> = async () => true): Promise<number> {
  const all: { tenant: string; workspace: string }[] = [];
  for (const tenant of listTenants()) {
    try {
      for (const w of listWorkspaces(tenant)) all.push({ tenant, workspace: w.name });
    } catch {
      // an account that cannot be listed is skipped this pass
    }
  }
  if (!all.length) return 0;
  const started = Date.now();
  // One origin for the whole pass, so nothing is skipped or visited twice
  // (Codex review); the next pass starts after the last one attempted.
  const origin = cursor % all.length;
  let done = 0;
  for (let k = 0; k < all.length && done < PASS_WORKSPACES; k++) {
    if (Date.now() - started > PASS_DEADLINE_MS) break;
    const i = (origin + k) % all.length;
    const { tenant, workspace } = all[i]!;
    const last = await lastRescan(tenant, workspace).catch(() => null);
    const due = !last || now - last.checkedAt >= RESCAN_EVERY_MS || (last.unfinished === true && now - last.checkedAt >= UNFINISHED_EVERY_MS);
    if (!due && !last?.pending.length) continue;
    // A scan that was started and never finished took its process down with
    // it (the cursor above is only in memory, so a restart comes straight
    // back here): skip that workspace for a day rather than crash-loop on it.
    // Best effort, not a lock: a scan that failed is held off a day too.
    const tried = await getNotice<{ at: number }>(tenant, "rescan-attempt", workspace).catch(() => null);
    const held = due && !!tried && tried.payload.at > (last?.checkedAt ?? 0) && now - tried.payload.at < RESCAN_EVERY_MS;
    if (held && !last?.pending.length) {
      console.error(`[rescan] ${tenant}/${workspace}: the scan started ${new Date(tried!.payload.at).toISOString()} did not finish — held off until a day after it`);
      cursor = (i + 1) % all.length;
      continue;
    }
    if (!(await stillLeader())) break;
    try {
      if (due && !held) {
        await setNotice(tenant, "rescan-attempt", workspace, { at: now }, now);
        await rescanWorkspace(tenant, workspace, now, started + PASS_DEADLINE_MS);
      } else await retryPending(tenant, workspace, now);
    } catch (err) {
      console.error(`[rescan] ${tenant}/${workspace}:`, err instanceof Error ? err.message : err);
    }
    done++;
    cursor = (i + 1) % all.length;
  }
  return done;
}
