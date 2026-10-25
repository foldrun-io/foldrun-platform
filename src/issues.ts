// What people did to issues (FOL-54 step 3): acknowledged, snoozed,
// resolved, reopened — one notice per issue, so two people acting on two
// issues never overwrite each other. The issues themselves are derived from
// the runs (core issues.ts); only this is stored.

import { applyIssueAction, type IssueAction, type IssueState } from "../../foldrun-core/src/issues.ts";
import { listNotices, updateNotice } from "./notices.ts";

/** Every issue's state in one account, keyed by issue id. */
export async function issueStates(tenant: string): Promise<Record<string, IssueState>> {
  const out: Record<string, IssueState> = {};
  for (const n of await listNotices<IssueState>(tenant, "issue")) {
    if (n.payload && Array.isArray(n.payload.history)) out[n.scope] = n.payload;
  }
  return out;
}

const ID = /^iss_[a-z0-9]{2,32}$/;

/** One act on one issue, appended to its history and stored. */
export async function actOnIssue(
  tenant: string,
  id: string,
  act: { action: IssueAction; by: string; until?: string; untilCount?: number; note?: string },
  now = Date.now(),
): Promise<IssueState> {
  if (!ID.test(id)) throw new Error(`not an issue id: ${id}`);
  // One read-modify-write: two people acting on one issue at once both land
  // in its history (Codex review).
  const ev = {
    at: new Date(now).toISOString(),
    by: act.by,
    action: act.action,
    ...(act.until ? { until: act.until } : {}),
    ...(act.untilCount ? { untilCount: act.untilCount } : {}),
    ...(act.note?.trim() ? { note: act.note.trim().slice(0, 500) } : {}),
  };
  return updateNotice<IssueState>(tenant, "issue", id, (last) => applyIssueAction(last, ev, now), now);
}
