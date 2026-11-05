// The forward door's open connections, by the lease that opened them
// (FOL-110 phase 3, foldrun-docs/proposals/browse-egress.md).
//
// A CONNECT is checked once, when it opens: the lease is looked up and the
// site held to the step's `network:` list. A tunnel then carries bytes for
// as long as both ends keep it — and a browser keeps its connections, so a
// tunnel could outlive the step that opened it, carrying traffic under a
// lease that no longer exists. Every tunnel and intercepted connection is
// tracked here under its lease token, and a sweep closes the ones whose
// lease has ended. A store that cannot answer closes nothing: an outage of
// the lease store is not the end of a lease.

import type net from "node:net";

const open = new Map<string, Set<net.Socket>>();

/** Hold `socket` under the lease `token` until it closes. */
export function trackTunnel(token: string, socket: net.Socket): void {
  let set = open.get(token);
  if (!set) open.set(token, (set = new Set()));
  set.add(socket);
  socket.once("close", () => {
    const s = open.get(token);
    if (!s) return;
    s.delete(socket);
    if (!s.size) open.delete(token);
  });
}

/** How many connections are open under `token` (tests, and the sweep's count). */
export function tunnelsOpen(token?: string): number {
  if (token !== undefined) return open.get(token)?.size ?? 0;
  let n = 0;
  for (const s of open.values()) n += s.size;
  return n;
}

/**
 * Close every connection whose lease has ended. `alive` answers for one
 * token: true, false, or throws when the store cannot say — then that
 * lease's connections are left alone. Returns how many were closed.
 */
export async function closeEndedTunnels(alive: (token: string) => Promise<boolean>): Promise<number> {
  let closed = 0;
  for (const [token, set] of [...open]) {
    let live: boolean;
    try {
      live = await alive(token);
    } catch {
      continue;
    }
    if (live) continue;
    for (const s of [...set]) {
      s.destroy();
      closed++;
    }
    open.delete(token);
  }
  return closed;
}

/** Close every tracked connection: the proxy is stopping, or its drain ran
 *  out of time. An http server's closeAllConnections() does not reach a
 *  CONNECT socket — once upgraded it is no longer the server's — so these
 *  would otherwise outlive the process's own wish to stop. */
export function closeAllTunnels(): number {
  let closed = 0;
  for (const set of open.values()) {
    for (const s of set) {
      s.destroy();
      closed++;
    }
  }
  open.clear();
  return closed;
}

/** How often the sweep runs: FOLDRUN_EGRESS_TUNNEL_SWEEP_MS, 30 s by default. */
export const tunnelSweepMs = () => Number(process.env.FOLDRUN_EGRESS_TUNNEL_SWEEP_MS) || 30_000;
