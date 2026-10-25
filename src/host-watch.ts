// `alerts: new_host: true` — an agent reached a site it never reached before.
//
// After each run, the sites every step reached (from the egress lines on its
// trail) are compared with what that agent has reached before. A new one is
// told to `notify:` as event `alert`: an agent that starts talking to a host
// nobody has seen it use is the first visible sign of a prompt injection, a
// changed tool, or a dependency that moved. The first run of an agent only
// records what it reached — every site is new then, and none of it is news.
//
// The known sites live in notices (kind "hosts", one row per agent), not a
// table of their own: a short list per agent, read and written once a run.

import { readAgentsMd } from "../../foldrun-core/src/runner.ts";
import { accountDir, workspaceDir, type RunRecord } from "../../foldrun-core/src/store.ts";
import { parseAlerts } from "../../foldrun-core/src/alerts.ts";
import { hostsInTrail } from "../../foldrun-core/src/network.ts";
import { sendPlainNotificationOutcome } from "../../foldrun-core/src/notify.ts";
import { updateNotice } from "./notices.ts";

/** The most sites remembered per agent; past it the oldest are let go. */
const MAX_HOSTS = 500;

/** Did this workspace (else its account) ask for `alerts: new_host`? */
function wantsNewHost(tenant: string, workspace: string): boolean {
  const ws = readAgentsMd(workspaceDir(tenant, workspace))?.data;
  const block = ws?.alerts !== undefined ? ws.alerts : readAgentsMd(accountDir(tenant))?.data?.alerts;
  return parseAlerts(block).config?.newHost === true;
}

/** Note the sites this run's agents reached; tell notify: about new ones.
 *  Returns how many alerts it sent. Never throws: a run is settled already. */
export async function noteNewHosts(tenant: string, workspace: string, run: RunRecord): Promise<number> {
  try {
    if (run.test || !wantsNewHost(tenant, workspace)) return 0;
    const byAgent = new Map<string, Set<string>>();
    for (const step of run.steps) {
      if (!step.agent) continue;
      const hosts = hostsInTrail(step.events ?? []);
      // No sites at all means no egress proxy, not "reached nothing": on the
      // platform every step's model calls go through it. Recording an empty
      // list here would make the first proxied run a burst of false alarms.
      if (!hosts.length) continue;
      const set = byAgent.get(step.agent) ?? new Set<string>();
      for (const h of hosts) set.add(h);
      byAgent.set(step.agent, set);
    }
    let sent = 0;
    for (const [agent, reached] of byAgent) {
      const scope = `${workspace}/${agent}`;
      // One atomic step: the first run of an agent records what it reached
      // (two first runs finishing together leave one baseline); a later run
      // claims the sites new to it by adding them now, so a second run
      // finishing at the same moment does not tell the same news again.
      let baseline = false;
      let fresh: string[] = [];
      await updateNotice<{ hosts: string[] }>(tenant, "hosts", scope, (prev) => {
        if (!prev) {
          baseline = true;
          return { hosts: [...reached].slice(-MAX_HOSTS) };
        }
        fresh = [...reached].filter((h) => !prev.hosts.includes(h));
        return fresh.length ? { hosts: [...prev.hosts, ...fresh].slice(-MAX_HOSTS) } : prev;
      });
      if (baseline || !fresh.length) continue;
      const outcome = await sendPlainNotificationOutcome(tenant, workspace, {
        event: "alert",
        headline: `${workspace}: agent ${agent} reached ${fresh.length === 1 ? "a site" : `${fresh.length} sites`} it never reached before`,
        detail: `${fresh.join(", ")} — in run ${run.id} (${run.flow}). Expected after a change to its tools or instructions; if not, read what it did there on the run's page. alerts: new_host.`,
        flow: run.flow,
        runId: run.id,
      }).catch(() => ({ ok: false, retrying: false }));
      if (outcome.ok || outcome.retrying) {
        sent++;
        continue;
      }
      // Not told: give the claim back, so the agent's next run that reaches
      // them says so, rather than the sites being silently learned.
      const told = new Set(fresh);
      await updateNotice<{ hosts: string[] }>(tenant, "hosts", scope, (prev) => ({ hosts: (prev?.hosts ?? []).filter((h) => !told.has(h)) }));
    }
    return sent;
  } catch (err) {
    console.error(`[foldrun] new-host check for ${tenant}/${workspace}/${run.id} failed:`, err);
    return 0;
  }
}
