// Send a finished run to the account's OpenTelemetry collector, when its
// AGENTS.md (the workspace's, else the account's) has a `telemetry:` block.
// The body is core otel.ts's; this is the delivery: secrets filled from the
// vault, the collector reached the way a notify: webhook is (fetchPublic —
// no private address, no cloud metadata), and a failure logged, never
// thrown: a run is settled before its trace leaves.

import { readAgentsMd } from "../../foldrun-core/src/runner.ts";
import { accountDir, workspaceDir, listAgents, type RunRecord } from "../../foldrun-core/src/store.ts";
import { parseTelemetry, runToOtlp, telemetryHeaders, type TelemetryConfig } from "../../foldrun-core/src/otel.ts";
import { getSecret } from "../../foldrun-core/src/secrets.ts";
import { fetchPublic } from "./ssrf.ts";
import { updateNotice, pruneNotices } from "./notices.ts";

/** How long a collector may take to answer. */
const TIMEOUT_MS = 10_000;

/** The `telemetry:` block that applies: the workspace's, else the account's. */
export function telemetryConfig(tenant: string, workspace: string | null): TelemetryConfig | null {
  const ws = workspace ? readAgentsMd(workspaceDir(tenant, workspace))?.data : undefined;
  const raw = ws?.telemetry !== undefined ? ws.telemetry : readAgentsMd(accountDir(tenant))?.data?.telemetry;
  return parseTelemetry(raw).config;
}

export interface TraceDelivery {
  ok: boolean;
  status?: number;
  error?: string;
  spans?: number;
}

/** POST one run's trace to a collector. `workspace` null: the account's
 *  own test — its secrets from the account's vault alone. */
export async function sendTrace(tenant: string, workspace: string | null, run: RunRecord, cfg: TelemetryConfig): Promise<TraceDelivery> {
  const { headers, missing } = telemetryHeaders(cfg, (name) => getSecret(tenant, name, workspace ?? undefined)?.value ?? null);
  if (missing.length) return { ok: false, error: `telemetry: the vault has no ${missing.join(", ")} — foldrun secrets set ${missing[0]}` };
  let owners: Record<string, string | null> = {};
  try {
    if (workspace) owners = Object.fromEntries(listAgents(tenant, workspace).map((a) => [a.name, a.owner]));
  } catch {
    /* no agents to read: the trace goes without owners */
  }
  const body = runToOtlp(run, { tenant, workspace: workspace ?? "(account)", owners, ...(process.env.FOLDRUN_VERSION ? { version: process.env.FOLDRUN_VERSION } : {}) });
  const spans = body.resourceSpans[0]?.scopeSpans[0]?.spans.length ?? 0;
  try {
    const res = await fetchPublic(cfg.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      // A redirect would carry the headers — a collector's token in any of
      // them — to wherever it points: refused, not followed (Codex review).
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, status: res.status, error: `the collector answered ${res.status}`, spans };
    }
    // OTLP answers 200 with partialSuccess when it dropped some spans.
    const answer = (await res.json().catch(() => null)) as { partialSuccess?: { rejectedSpans?: string | number; errorMessage?: string } } | null;
    const rejected = Number(answer?.partialSuccess?.rejectedSpans ?? 0);
    if (rejected > 0) {
      return { ok: false, status: res.status, error: `the collector rejected ${rejected} of ${spans} spans${answer?.partialSuccess?.errorMessage ? ` — ${answer.partialSuccess.errorMessage}` : ""}`, spans };
    }
    return { ok: true, status: res.status, spans };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), spans };
  }
}

/** A finished run's trace, at most once: claimed before it is sent, so the
 *  worker that finished it and the sweep that catches the rest (a run
 *  stopped while parked, one reconciliation finished) never send it twice.
 *  A send that fails is logged, not retried. Never throws. */
export async function exportRunTrace(tenant: string, workspace: string, run: RunRecord): Promise<TraceDelivery | null> {
  try {
    if (run.test || (run.status !== "completed" && run.status !== "failed")) return null;
    const cfg = telemetryConfig(tenant, workspace);
    if (!cfg) return null;
    let mine = false;
    await updateNotice<{ at: number }>(tenant, "otel", `${workspace}/${run.id}`, (prev) => {
      if (prev) return prev;
      mine = true;
      return { at: Date.now() };
    });
    if (!mine) return null;
    const out = await sendTrace(tenant, workspace, run, cfg);
    if (!out.ok) console.error(`[foldrun] telemetry: ${tenant}/${workspace}/${run.id} not sent — ${out.error}`);
    return out;
  } catch (err) {
    console.error(`[foldrun] telemetry: ${tenant}/${workspace}/${run.id} failed:`, err);
    return null;
  }
}

/** How far back the sweep looks for a finished run whose trace never left. */
const SWEEP_MS = 6 * 3_600_000;
/** The most traces one sweep of one workspace sends; the rest wait for the next. */
const SWEEP_MAX = 20;
/** Workspaces with a sweep still sending: a slow collector gets one at a time. */
const sweeping = new Set<string>();

/** The watchdog's pass: every run of this workspace that finished in the
 *  last six hours and was not sent — whatever path finished it. */
export async function sweepRunTraces(tenant: string, workspace: string, finished: { id: string; finishedAt: string | null; test?: boolean }[], read: (id: string) => RunRecord | null, now = Date.now()): Promise<number> {
  const key = `${tenant}/${workspace}`;
  if (sweeping.has(key) || !telemetryConfig(tenant, workspace)) return 0;
  sweeping.add(key);
  let sent = 0;
  let tried = 0;
  try {
    for (const r of finished) {
      if (tried >= SWEEP_MAX) break;
      if (r.test || !r.finishedAt || now - Date.parse(r.finishedAt) > SWEEP_MS) continue;
      const run = read(r.id);
      if (!run) continue;
      const out = await exportRunTrace(tenant, workspace, run);
      if (out) tried++;
      if (out?.ok) sent++;
    }
  } finally {
    sweeping.delete(key);
  }
  return sent;
}

/** Forget sends older than two days: the sweep never looks that far back. */
export async function pruneTraceClaims(now = Date.now()): Promise<void> {
  await pruneNotices("otel", now - 2 * 86_400_000);
}
