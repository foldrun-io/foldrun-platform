// Short named locks with stale-worker fencing (FOL-126, phase 2).
//
// db.ts withNamedLock is the right exclusion: a session advisory lock on a
// connection of its own, freed if the process dies. What it cannot do is stop a
// holder that STALLED — a worker paused for a minute, whose database connection
// the server then dropped, wakes up believing it still holds the lock and
// writes. A fence is the cure: acquiring the lock also takes the next number
// from lock_fences; every write the lock guards checks, inside its own
// transaction, that its number is still the newest. The stale worker's number
// is not, and its write is refused.
//
//   await withFencedLock("tenant-x/backfill", async (fence) => {
//     await tx(async (t) => {
//       await assertFence(t, fence);       // throws StaleLock if a newer holder exists
//       …guarded writes…
//     });
//   });
//
// Where a write is already a compare-and-set on its own row (the revision
// head, a run record), the CAS is the fence and this is not needed; this is for
// the few multi-step jobs that are not (an import, a sweep).

import { sql } from "drizzle-orm";
import { withNamedLock, ormRequired, type Db } from "./db.ts";

export interface Fence {
  name: string;
  token: number;
}

export class StaleLock extends Error {
  readonly lock: string;
  constructor(name: string) {
    super(`the lock ${name} was taken over while this holder was stalled — its write is refused`);
    this.name = "StaleLock";
    this.lock = name;
  }
}

export async function withFencedLock<T>(name: string, fn: (fence: Fence) => Promise<T>, waitMs = 60_000): Promise<T> {
  return withNamedLock(
    `fence:${name}`,
    async () => {
      const r = await ormRequired().execute<{ token: string }>(
        sql`INSERT INTO lock_fences (name, token) VALUES (${name}, 1)
            ON CONFLICT (name) DO UPDATE SET token = lock_fences.token + 1, updated_at = now()
            RETURNING token`,
      );
      return fn({ name, token: Number(r.rows[0].token) });
    },
    waitMs,
  );
}

/** Inside the guarded write's transaction: refuse if a newer holder exists.
 *  FOR SHARE keeps a newer acquisition from landing until this transaction
 *  ends, so check-then-write cannot interleave with a takeover. */
export async function assertFence(t: Db, fence: Fence): Promise<void> {
  const r = await t.execute<{ token: string }>(sql`SELECT token FROM lock_fences WHERE name = ${fence.name} FOR SHARE`);
  if (!r.rows[0] || Number(r.rows[0].token) !== fence.token) throw new StaleLock(fence.name);
}
