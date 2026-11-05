// The flood simulation FOL-123 is judged by: one account floods the queue,
// three quiet accounts keep sending work at a steady rate, a fixed number of
// worker slots claim from the real queue — and every quiet account's wait
// is measured with the flood and without it. Shared by the file queue's
// test (fair-share.test.ts) and the Postgres one (postgres-live.test.ts).
//
// A virtual clock: each tick every free slot claims once, and a job holds
// its slot for `jobTicks` ticks. The queue's own clock does not move, so
// aging (queue-db.ts AGING_SECS_PER_TURN) is not what keeps anyone's wait
// down here — the turn order alone is.

export interface Claimer {
  enqueue(tenant: string, runId: string, tick: number): Promise<void>;
  claim(): Promise<{ tenant: string; runId: string; release: () => Promise<void> } | null>;
  reset(): Promise<void>;
}

export interface SimResult {
  /** Per quiet account: the longest any of its jobs waited, in ticks. */
  maxWait: Record<string, number>;
  /** How many of the flood's jobs ran. */
  floodRan: number;
  /** Ticks a slot sat idle while work was waiting. */
  idleWhileWaiting: number;
}

export async function simulate(q: Claimer, opts: { flood: number; slots?: number; ticks?: number; jobTicks?: number; quiet?: string[]; every?: number }): Promise<SimResult> {
  const slots = opts.slots ?? 4;
  const ticks = opts.ticks ?? 60;
  const jobTicks = opts.jobTicks ?? 2;
  const quiet = opts.quiet ?? ["quiet-a", "quiet-b", "quiet-c"];
  const every = opts.every ?? 3;
  await q.reset();
  const enqueuedAt = new Map<string, number>();
  let seq = 0;
  // The flood arrives first, all at once: the worst case for a quiet account.
  for (let i = 0; i < opts.flood; i++) {
    const id = `run-flood-${String(i).padStart(4, "0")}`;
    enqueuedAt.set(id, 0);
    await q.enqueue("flood", id, seq++);
  }
  const running: { until: number; release: () => Promise<void> }[] = [];
  const maxWait: Record<string, number> = Object.fromEntries(quiet.map((t) => [t, 0]));
  const claimedIds = new Set<string>();
  let floodRan = 0;
  let idleWhileWaiting = 0;
  let waiting = opts.flood;
  for (let tick = 0; tick < ticks; tick++) {
    // Quiet accounts: one job each every `every` ticks, staggered.
    for (const [i, t] of quiet.entries()) {
      if ((tick + i) % every === 0) {
        const id = `run-${t}-${tick}`;
        enqueuedAt.set(id, tick);
        await q.enqueue(t, id, seq++);
        waiting++;
      }
    }
    // Jobs that are done free their slots.
    for (let i = running.length - 1; i >= 0; i--) {
      if (running[i].until <= tick) {
        await running[i].release();
        running.splice(i, 1);
      }
    }
    // Every free slot claims once.
    while (running.length < slots) {
      const job = await q.claim();
      if (!job) {
        if (waiting > 0) idleWhileWaiting++;
        break;
      }
      waiting--;
      claimedIds.add(job.runId);
      const wait = tick - (enqueuedAt.get(job.runId) ?? tick);
      if (job.tenant === "flood") floodRan++;
      else maxWait[job.tenant] = Math.max(maxWait[job.tenant] ?? 0, wait);
      running.push({ until: tick + jobTicks, release: job.release });
    }
  }
  for (const r of running) await r.release();
  // A job still waiting at the end has waited until now — or a queue that
  // never served an account would read as no wait at all.
  for (const [id, at] of enqueuedAt) {
    if (claimedIds.has(id) || id.startsWith("run-flood-")) continue;
    const tenant = quiet.find((t) => id.startsWith(`run-${t}-`))!;
    maxWait[tenant] = Math.max(maxWait[tenant], ticks - at);
  }
  return { maxWait, floodRan, idleWhileWaiting };
}
