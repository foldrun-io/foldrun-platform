// The live view: what a step's browser shows, while the step runs.
//
// web's browse action streams the page it drives as JPEG frames — the DevTools
// screencast on Chromium, a screenshot a second on Firefox and WebKit — to
// /live/<lease> on the egress proxy (egress-proxy.ts). The lease names the
// account and the run, so a frame cannot land on anyone else's run, and it
// dies with the step. Kept here: the latest frame per run and agent, with
// where the page was, for the dashboard's run page to show. Nothing is
// kept longer than LIVE_TTL_MS after the last frame; the recording, when
// the agent asks for one, is the durable copy (outputs/video/).
//
// Redis when the install has one, so a frame posted to one worker is read by
// the web process; in-process otherwise, which is enough for a single
// process (a laptop, a compose install).
import { cache } from "./cache.ts";

export const LIVE_TTL_MS = 5 * 60_000;
/** A frame larger than this is refused: a full-HD JPEG at the tool's quality
 *  is well under it, and the proxy should not hold what it was not asked to. */
export const LIVE_MAX_FRAME = 1_500_000;

export interface LiveMeta {
  agent: string;
  /** The page's address when the frame was taken. */
  url: string;
  engine: string;
  at: string;
  /** true once the call that streamed it has finished. */
  ended: boolean;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
const frameKey = (tenant: string, runId: string, agent: string) => `live:${safe(tenant)}:${safe(runId)}:${safe(agent)}:frame`;
const metaKey = (tenant: string, runId: string, agent: string) => `live:${safe(tenant)}:${safe(runId)}:${safe(agent)}:meta`;
const indexKey = (tenant: string, runId: string) => `live:${safe(tenant)}:${safe(runId)}:agents`;

const local = new Map<string, { value: Buffer | string; expires: number }>();
function localSet(key: string, value: Buffer | string) {
  local.set(key, { value, expires: Date.now() + LIVE_TTL_MS });
  if (local.size > 2_000) for (const [k, v] of local) if (v.expires < Date.now()) local.delete(k);
}
function localGet(key: string): Buffer | string | null {
  const v = local.get(key);
  if (!v) return null;
  if (v.expires < Date.now()) { local.delete(key); return null; }
  return v.value;
}

/** Store the newest frame for this run's agent. meta.ended marks the call's end. */
export async function putLiveFrame(tenant: string, runId: string, meta: LiveMeta, jpeg: Buffer | null): Promise<void> {
  const r = cache();
  const m = JSON.stringify(meta);
  if (r) {
    const tx = r.multi();
    if (jpeg) tx.set(frameKey(tenant, runId, meta.agent), jpeg, "PX", LIVE_TTL_MS);
    tx.set(metaKey(tenant, runId, meta.agent), m, "PX", LIVE_TTL_MS);
    tx.hset(indexKey(tenant, runId), meta.agent, meta.at);
    tx.pexpire(indexKey(tenant, runId), LIVE_TTL_MS);
    await tx.exec();
    return;
  }
  if (jpeg) localSet(frameKey(tenant, runId, meta.agent), jpeg);
  localSet(metaKey(tenant, runId, meta.agent), m);
  const idx = JSON.parse((localGet(indexKey(tenant, runId)) as string | null) ?? "{}");
  idx[meta.agent] = meta.at;
  localSet(indexKey(tenant, runId), JSON.stringify(idx));
}

/** Mark the stream ended without a new frame, keeping the last one to show. */
export async function endLiveFrame(tenant: string, runId: string, agent: string): Promise<void> {
  const meta = await liveMeta(tenant, runId, agent);
  if (!meta) return;
  await putLiveFrame(tenant, runId, { ...meta, ended: true, at: new Date().toISOString() }, null);
}

export async function liveMeta(tenant: string, runId: string, agent: string): Promise<LiveMeta | null> {
  const r = cache();
  const raw = r ? await r.get(metaKey(tenant, runId, agent)) : (localGet(metaKey(tenant, runId, agent)) as string | null);
  if (!raw) return null;
  try { return JSON.parse(raw) as LiveMeta; } catch { return null; }
}

/** The newest frame for one agent of a run, with its meta; null when none is held. */
export async function getLiveFrame(tenant: string, runId: string, agent: string): Promise<{ meta: LiveMeta; jpeg: Buffer } | null> {
  const r = cache();
  const meta = await liveMeta(tenant, runId, agent);
  if (!meta) return null;
  const jpeg = r ? await r.getBuffer(frameKey(tenant, runId, agent)) : (localGet(frameKey(tenant, runId, agent)) as Buffer | null);
  if (!jpeg) return null;
  return { meta, jpeg };
}

/** Which agents of a run have streamed, newest frame time each. */
export async function liveAgents(tenant: string, runId: string): Promise<Record<string, string>> {
  const r = cache();
  if (r) return (await r.hgetall(indexKey(tenant, runId))) ?? {};
  return JSON.parse((localGet(indexKey(tenant, runId)) as string | null) ?? "{}");
}

/** The egress path a frame arrives on: /live/<lease>. */
export function parseLivePath(rawUrl: string): { token: string } | null {
  const m = rawUrl.match(/^\/live\/([A-Za-z0-9_-]{16,})\/?(?:\?.*)?$/);
  return m ? { token: m[1] } : null;
}
