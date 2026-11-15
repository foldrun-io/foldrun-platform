// A pod's copy of the workspaces, kept current by notification (15 Nov 2026).
//
// Every pod that mirrors the workspaces (web, worker, the assistant) asked
// Postgres for every workspace's heads every 3 s. Now the database tells it:
// drizzle/0063 makes a trigger on workspace_heads announce "tenant/workspace"
// and one on tenant_keys announce "tenant" on HEADS_CHANNEL when the write
// commits, whoever wrote it. This module listens (pg-listen.ts) and syncs just
// what was named. The loop in boot.ts keeps running as the safety net, every
// FOLDRUN_MIRROR_SAFETY_MS (60 s) while this is live, at its old pace when not.
//
// A notification is a hint (pg-listen.ts): it can be missed while the
// connection is down or before LISTEN took effect. So when the listener comes
// up, and when it goes down, the loop is woken for a full pass now.
//
// Bursts (a deploy touches many heads): one sync per name at a time; a
// notification that lands while that name's sync runs asks for exactly one
// more after it — the running one may have read the heads before the change.

import { listen, listening } from "./pg-listen.ts";

export const HEADS_CHANNEL = "foldrun_heads";

/** What a payload names: one workspace, or an account (no workspace). */
export type HeadsChange = { tenant: string; workspace: string } | { tenant: string; workspace: null };

const NAME = /^[A-Za-z0-9@][A-Za-z0-9_.@-]{0,127}$/;

/** "tenant/workspace" or "tenant"; null for anything else (never acted on). */
export function parseHeadsPayload(payload: string): HeadsChange | null {
  const i = payload.indexOf("/");
  const tenant = i < 0 ? payload : payload.slice(0, i);
  const workspace = i < 0 ? null : payload.slice(i + 1);
  if (!NAME.test(tenant)) return null;
  if (workspace !== null && !NAME.test(workspace)) return null;
  return { tenant, workspace };
}

/** Run `work(key)` for each key asked for, one at a time per key; asking again
 *  while it runs means one more run after it, however many times it was asked. */
export function coalescer(work: (key: string) => Promise<unknown>): { ask(key: string): void; idle(): Promise<void> } {
  const running = new Map<string, Promise<void>>();
  const again = new Set<string>();
  const run = (key: string): void => {
    const p = (async () => {
      do {
        again.delete(key);
        try {
          await work(key);
        } catch {
          // work reports its own failures; one key's fault is not the next's
        }
      } while (again.has(key));
    })().finally(() => running.delete(key));
    running.set(key, p);
  };
  return {
    ask(key) {
      if (running.has(key)) again.add(key);
      else run(key);
    },
    async idle() {
      while (running.size) await Promise.all([...running.values()]);
    },
  };
}

export interface MirrorNotifyHooks {
  /** Bring this workspace's copy to its heads (syncFromHeads). */
  workspace(tenant: string, workspace: string): Promise<unknown>;
  /** An account came or went: its folder here (syncAccountFolders). */
  account(tenant: string): Promise<unknown>;
  /** A full pass now: the listener came up or went down. */
  wake(): void;
}

let stop: (() => void) | null = null;
let queue: ReturnType<typeof coalescer> | null = null;

/** Start listening (once per process). Returns the function that stops it. */
export function startMirrorNotify(hooks: MirrorNotifyHooks): () => void {
  if (stop) return stop;
  const q = coalescer((key) => {
    const c = parseHeadsPayload(key);
    if (!c) return Promise.resolve();
    return c.workspace === null ? hooks.account(c.tenant) : hooks.workspace(c.tenant, c.workspace);
  });
  queue = q;
  const off = listen(
    HEADS_CHANNEL,
    (payload) => {
      if (parseHeadsPayload(payload)) q.ask(payload);
    },
    { up: hooks.wake, down: hooks.wake },
  );
  stop = () => {
    off();
    stop = null;
    queue = null;
  };
  return stop;
}

/** Are heads changes arriving by notification? False: poll at the old pace. */
export function mirrorNotifyLive(): boolean {
  return stop !== null && listening(HEADS_CHANNEL);
}

/** For tests: wait until every sync asked for so far has finished. */
export async function mirrorNotifyIdleForTests(): Promise<void> {
  await queue?.idle();
}
