// "This run's record changed" across every copy of the platform (12 Nov
// 2026). The run upsert in records-pg.ts announces it on RUN_CHANNEL when it
// commits; a live run page (foldrun-web's stream route) registers a wake
// function here instead of asking Postgres for the run's stamp several times
// a second. One LISTEN per process (pg-listen.ts), fanned out here by run.
//
// The payload is md5(tenant/workspace/runId): fixed length, so no name can
// push a notification past Postgres's payload limit and fail the write.
//
// Only for runs whose records are in the database. While the listener is down
// (runNotifyLive() false), callers poll exactly as before. Every watcher is
// woken when the listener comes up (a change may have been missed before
// LISTEN took effect) and when it goes down (so it reschedules at the
// polling rate now, not at the end of a long trusting wait).

import crypto from "node:crypto";
import { listen, listening } from "./pg-listen.ts";

export const RUN_CHANNEL = "foldrun_run";

/** The SQL expression the upsert announces, over its RETURNING columns. */
export const RUN_NOTIFY_PAYLOAD_SQL = "md5(up.tenant || '/' || up.workspace || '/' || up.run_id)";
export const runNotifyKey = (tenant: string, workspace: string, runId: string) =>
  crypto.createHash("md5").update(`${tenant}/${workspace}/${runId}`).digest("hex");

const watchers = new Map<string, Set<() => void>>();
let started = false;

function wakeSet(set: Set<() => void> | undefined): void {
  if (!set) return;
  for (const fn of set) {
    try {
      fn();
    } catch {}
  }
}
const wakeEveryone = () => {
  for (const set of watchers.values()) wakeSet(set);
};

function start(): void {
  if (started) return;
  started = true;
  listen(RUN_CHANNEL, (payload) => wakeSet(watchers.get(payload)), { up: wakeEveryone, down: wakeEveryone });
}

/** Call `wake` whenever this run's record is written by any copy of the
 *  platform. Returns the function that stops watching. */
export function watchRun(tenant: string, workspace: string, runId: string, wake: () => void): () => void {
  start();
  const k = runNotifyKey(tenant, workspace, runId);
  let set = watchers.get(k);
  if (!set) watchers.set(k, (set = new Set()));
  set.add(wake);
  return () => {
    const s = watchers.get(k);
    if (!s) return;
    s.delete(wake);
    if (s.size === 0) watchers.delete(k);
  };
}

/** Are notifications arriving for runs? False: poll as if they did not exist. */
export function runNotifyLive(): boolean {
  return listening(RUN_CHANNEL);
}

/** For tests: how many runs are being watched. */
export function watchedRunsForTests(): number {
  return watchers.size;
}
