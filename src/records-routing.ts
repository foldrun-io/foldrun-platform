// Where a workspace's records live — its files or its rows — decided in one
// place every process reads (FOL-152).
//
// FOL-126 moved runs, the trigger log and the storage index into Postgres
// with an import at boot that renamed the files once their rows were in.
// Which workspaces were "still on files" was then each process's own answer,
// worked out at its boot from which files it could see: a pod that failed an
// import kept serving (and recreating) files another pod had since imported,
// a rename that half failed sent a whole workspace back to files with its
// imported runs out of sight, and pods running FOLDRUN_RECORDS=files went on
// writing files the import had already archived. So the answer is now a row
// per workspace in `records_routing`, the same for every process, in every
// mode:
//
//   files     the files are the records; rows are only what an import is
//             building and may be thrown away
//   moving    an import is making the rows equal the files: no process may
//             touch either until it ends (a record call waits a moment, then
//             is refused as busy)
//   database  the rows are the records, for good: a workspace never leaves
//             it, so a process may keep that answer as long as it likes
//
// A workspace without a row of its own takes the row ('*', '*'): the
// install's default, `files` until an import has moved everything there was.
// That row also carries `gen`, bumped in the same transaction as every
// routing change.
//
// How an import knows no process is still writing a workspace's files: every
// process re-reads the routing on its event loop each second and then writes
// the generation it now routes by to `records_routing_pods`. A record call in
// core reads the routing (records() → onFiles) and does its file write in the
// same synchronous stretch, so by the time a process's event loop runs again
// to write that acknowledgement, no write that read the older routing can
// still be running in it. A record call that reads the routing again itself
// (its lease ran out while the event loop was busy) acknowledges it there and
// then, for the same reason — except a rename's or a delete's, which core
// asks after it may already have moved the folder: those never wait on a
// move nor acknowledge one (routeForLifecycle). The import waits for the
// acknowledgement of every process seen in the last ackWindowMs
// (records-import.ts); a process renews its lease only once its
// acknowledgement has landed. A process that
// cannot read the routing for routingLeaseMs refuses record calls rather than
// trust an old `files`, and that lease is shorter than the window, so a
// process the import stopped waiting for (cut off from the database, or
// stuck) cannot be writing files either. One write is not covered: a file
// write already inside the kernel when its process froze (a hung NFS mount),
// which lands after the import. It is found by the next import, set aside as
// `.stray-<date>` and named in the ops log, never merged in by guess.
//
// A process of an OLDER release reads none of this. That is why a cutover
// starts only once every process runs this release (see ROLLOUT in
// records-import.ts).

import os from "node:os";
import { randomBytes } from "node:crypto";
import { pgSyncOne, timeoutDefault } from "./pg-sync.ts";
import { db, databaseEnabled } from "./db.ts";
import { opsError } from "../../foldrun-core/src/ops-log.ts";

export type Route = "files" | "moving" | "database";

/** The key of the install's default row. */
export const DEFAULT = "*";

const env = (name: string, dflt: number) => Number(process.env[name]) || dflt;
/** How often a process re-reads the routing and acknowledges it. */
export const routingBeatMs = () => env("FOLDRUN_RECORDS_ROUTING_BEAT_MS", 1_000);
/** How long a `files` or `moving` answer may be relied on without a fresh read. */
export const routingLeaseMs = () => env("FOLDRUN_RECORDS_ROUTING_LEASE_MS", 10_000);
/** A process that has not acknowledged within this long is not waited for —
 *  safely, because its lease has run out well before: it refuses record calls. */
export const ackWindowMs = () => routingLeaseMs() + 20_000;
/** How long a record call waits for a moving workspace before it is refused. */
const movingWaitMs = () => env("FOLDRUN_RECORDS_MOVING_WAIT_MS", 5_000);
/** A `moving` row past its deadline (its import died) counts as `files` only
 *  this long after it, so a process's clock running ahead cannot end the
 *  move early: the import's own last step checks the deadline on the
 *  database's clock. */
const MOVING_SKEW_MS = 30_000;

/** The workspace's records are being moved right now; try again in a moment. */
export class RecordsBusy extends Error {
  readonly code = "RECORDS_BUSY";
  constructor(tenant: string, workspace: string) {
    super(`the records of ${tenant}/${workspace} are moving to the database right now — try again in a moment`);
    this.name = "RecordsBusy";
  }
}

/** Where the records live could not be read, and the last answer is too old to trust. */
export class RoutingUnavailable extends Error {
  readonly code = "RECORDS_ROUTING_UNAVAILABLE";
  constructor(cause?: unknown) {
    super(`where this workspace's records live could not be read from the database${cause instanceof Error ? ` (${cause.message})` : ""}`);
    this.name = "RoutingUnavailable";
  }
}

interface Entry {
  state: Route;
  /** Epoch ms (database clock) a moving row is given up on, or null. */
  until: number | null;
}
interface Snapshot {
  gen: number;
  def: Entry;
  rows: Map<string, Entry>;
}

const key = (tenant: string, workspace: string) => `${tenant}\0${workspace}`;
const POD = `${os.hostname()}-${process.pid}-${randomBytes(4).toString("hex")}`;
/** This process, as records_routing_pods names it. */
export const routingPod = () => POD;

let snap: Snapshot | null = null;
/** performance.now() stamped BEFORE the read that last confirmed `snap`. */
let freshAt = -Infinity;
let failedAt = -Infinity;
/** Workspaces whose moving wait just ran out: refused at once until the routing changes. */
const busy = new Map<string, number>();

const LOAD = `SELECT tenant, workspace, state, gen, (extract(epoch from moving_until) * 1000)::float8 AS until FROM records_routing`;
const GEN = `SELECT gen FROM records_routing WHERE tenant = '*' AND workspace = '*'`;
/** The acknowledgement, answering the routing's generation as this very
 *  statement sees it. A hold locks the acknowledgements out until it commits
 *  (records-import.ts), so one that overlaps a hold sees the new generation
 *  and does not renew a lease on the old routing: a process just starting,
 *  whose first read came before the hold and whose first acknowledgement
 *  after the barrier counted, cannot write files on that read. */
const ACK = `INSERT INTO records_routing_pods (pod, gen, beat_at) VALUES ($1, $2, now())
  ON CONFLICT (pod) DO UPDATE SET gen = GREATEST(records_routing_pods.gen, EXCLUDED.gen), beat_at = now()
  RETURNING COALESCE((SELECT gen FROM records_routing WHERE tenant = '*' AND workspace = '*'), 0) AS current`;

function parse(rows: Record<string, unknown>[]): Snapshot {
  const next: Snapshot = { gen: 0, def: { state: "files", until: null }, rows: new Map() };
  for (const r of rows) {
    const e: Entry = { state: r.state as Route, until: r.until === null || r.until === undefined ? null : Number(r.until) };
    if (r.tenant === DEFAULT && r.workspace === DEFAULT) {
      next.def = e;
      next.gen = Number(r.gen);
    } else next.rows.set(key(r.tenant as string, r.workspace as string), e);
  }
  return next;
}

/** Take a read's answer: an older generation never replaces a newer one (a
 *  slow read must not undo a newer one). True when the read confirms the
 *  routing now in memory and came back within the lease of being asked — it
 *  may then renew the lease (renew), once acknowledged where that is owed. */
function adopt(next: Snapshot | null, stamp: number): boolean {
  if (next && (!snap || next.gen >= snap.gen)) {
    if (!snap || next.gen !== snap.gen) busy.clear();
    snap = next;
  }
  return Boolean(snap) && (!next || next.gen === snap!.gen) && performance.now() - stamp <= routingLeaseMs();
}

function renew(stamp: number): void {
  freshAt = Math.max(freshAt, stamp);
}

/** Read the routing now, through the synchronous bridge — and, in a process
 *  that takes part in the barrier, acknowledge it before the lease is
 *  renewed. A record call reads the routing before its write, and every
 *  earlier call of this synchronous stretch has finished, so the
 *  acknowledgement is as true here as from the event loop. Both halves
 *  matter: a process kept busy in record calls past the barrier's window
 *  would otherwise renew its lease without acknowledging, and one whose
 *  acknowledgements fail would be stopped waiting for while its lease still
 *  let it write files. */
export function loadRoutingSync(): void {
  const stamp = performance.now();
  const r = pgSyncOne(LOAD, [], { timeoutMs: Math.min(1_500, timeoutDefault()) });
  let fresh = adopt(parse(r.rows), stamp);
  if (timer && snap) {
    const a = pgSyncOne(ACK, [POD, snap.gen], { timeoutMs: Math.min(1_500, timeoutDefault()) });
    if (Number(a.rows[0]?.current ?? 0) !== snap.gen) fresh = false; // moved on meanwhile: read again
  }
  if (fresh) renew(stamp);
}

/** Read the routing now, off the event loop's back (the import, after its
 *  own changes). It does not renew the lease: the beat and the synchronous
 *  read do, with their acknowledgement. */
export async function loadRouting(): Promise<void> {
  const p = db();
  if (!p) return;
  const stamp = performance.now();
  const r = await p.query(LOAD);
  const fresh = adopt(parse(r.rows), stamp);
  if (fresh && !timer) renew(stamp);
}

function lookup(tenant: string, workspace: string): Entry {
  return snap!.rows.get(key(tenant, workspace)) ?? snap!.def;
}

/** A moving row whose import is long past its deadline: the import gave up (or died), the files stand. */
const abandoned = (e: Entry) => e.state === "moving" && e.until !== null && Date.now() > e.until + MOVING_SKEW_MS;

/**
 * Where this workspace's records are, for a record call about to read or
 * write them. `database` is answered from memory for good; `files` only
 * while the last read is younger than the lease (else it is read again, and
 * refused if it cannot be); `moving` waits a moment for the move to end.
 */
export function routeOf(tenant: string, workspace: string): Route {
  if (!databaseEnabled()) return "files";
  if (snap && lookup(tenant, workspace).state === "database") return "database";
  if (!snap || performance.now() - freshAt > routingLeaseMs()) {
    // Fail fast for a second after a failed read: a database that is down
    // must not freeze every record call for the bridge's whole deadline.
    if (performance.now() - failedAt < 1_000) throw new RoutingUnavailable();
    try {
      loadRoutingSync();
    } catch (err) {
      failedAt = performance.now();
      throw new RoutingUnavailable(err);
    }
    if (performance.now() - freshAt > routingLeaseMs()) throw new RoutingUnavailable();
  }
  const e = lookup(tenant, workspace);
  if (e.state !== "moving" || abandoned(e)) return e.state === "moving" ? "files" : e.state;
  return waitWhileMoving(tenant, workspace);
}

/**
 * Where a workspace's records are, for a rename or a delete — which core
 * asks AFTER it may already have moved the folder (renameWorkspace renames
 * first, then calls workspaceMove). Such a call must never wait on a move
 * nor acknowledge one: an acknowledgement in the middle of a half-done
 * rename would let an import act on the folder under its passing name. So a
 * moving name is refused at once, and an old answer is read again without
 * acknowledging (nor renewing the lease the acknowledgement keeps).
 */
export function routeForLifecycle(tenant: string, workspace: string): Route {
  if (!databaseEnabled()) return "files";
  if (snap && lookup(tenant, workspace).state === "database") return "database";
  if (!snap || performance.now() - freshAt > routingLeaseMs()) {
    const stamp = performance.now();
    try {
      const r = pgSyncOne(LOAD, [], { timeoutMs: Math.min(1_500, timeoutDefault()) });
      adopt(parse(r.rows), stamp);
    } catch (err) {
      throw new RoutingUnavailable(err);
    }
    if (performance.now() - stamp > routingLeaseMs()) throw new RoutingUnavailable();
  }
  const e = lookup(tenant, workspace);
  if (e.state === "moving" && !abandoned(e)) throw new RecordsBusy(tenant, workspace);
  return e.state === "moving" ? "files" : e.state;
}

/** Block this thread a moment at a time (the caller is synchronous) until the
 *  move ends, re-reading the routing (and acknowledging it) each time. */
function waitWhileMoving(tenant: string, workspace: string): Route {
  const k = key(tenant, workspace);
  if (busy.get(k) === snap!.gen) throw new RecordsBusy(tenant, workspace);
  const until = performance.now() + movingWaitMs();
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    Atomics.wait(pause, 0, 0, 100);
    try {
      loadRoutingSync();
    } catch {
      // keep waiting; the deadline below still holds
    }
    const e = lookup(tenant, workspace);
    if (e.state !== "moving" || abandoned(e)) {
      if (e.state === "database") return "database";
      // Back to files (or given up on): only on a lease this process has
      // just renewed and acknowledged, like any other `files` answer.
      if (performance.now() - freshAt > routingLeaseMs()) throw new RoutingUnavailable();
      return "files";
    }
    if (performance.now() >= until) {
      // The next caller is refused at once instead of waiting again, until
      // the routing changes: callers must not stack up five-second waits.
      busy.set(k, snap!.gen);
      throw new RecordsBusy(tenant, workspace);
    }
  }
}

/** Is any workspace of this tenant (or the default) in the database? A list
 *  can then skip asking for counts it would not use. */
export function anyInDatabase(tenant: string): boolean {
  // An old answer could say "none" of a workspace moved since: read again
  // first, and when that cannot be done, ask for the counts anyway.
  if (!snap || performance.now() - freshAt > routingLeaseMs()) {
    try {
      loadRoutingSync();
    } catch {
      return true;
    }
  }
  if (!snap) return true;
  if (snap.def.state !== "files") return true;
  for (const [k, e] of snap.rows) if (e.state !== "files" && k.startsWith(`${tenant}\0`)) return true;
  return false;
}

/** Give this process the routing a change just committed, at once (the
 *  import, a rename): its own calls must not wait for the next beat. */
export function noteRoutingChanged(): void {
  try {
    loadRoutingSync();
  } catch {
    // the next beat, or the next call past the lease, reads it
  }
}

let timer: NodeJS.Timeout | null = null;
let beating = false;
let lastWarn = 0;

/** One beat: confirm (or re-read) the routing, then acknowledge it. The
 *  acknowledgement is written only after the routing is in memory, from the
 *  event loop — the moment that proves no record call that read an older
 *  routing is still running in this process. */
export async function routingBeat(): Promise<void> {
  const p = db();
  if (!p || beating) return;
  beating = true;
  try {
    const stamp = performance.now();
    const g = await p.query(GEN);
    const gen = g.rows[0] ? Number(g.rows[0].gen) : 0;
    let fresh: boolean;
    if (!snap || gen !== snap.gen) {
      const r = await p.query(LOAD);
      fresh = adopt(parse(r.rows), stamp);
    } else fresh = adopt(null, stamp);
    const a = await p.query(ACK, [POD, snap?.gen ?? 0]);
    // Only now, acknowledged — and only if the routing has not moved on
    // since it was read: a lease this process could renew without its
    // acknowledgement counting would outlive the barrier's wait for it.
    if (fresh && Number(a.rows[0]?.current ?? 0) === snap?.gen) renew(stamp);
  } catch (err) {
    if (Date.now() - lastWarn > 60_000) {
      lastWarn = Date.now();
      opsError("records.routing_beat_failed", err, {}, "warn");
    }
  } finally {
    beating = false;
  }
}

let reseed: (() => Promise<void>) | null = null;
let lastSeed = 0;
let seededSeen = false;

/** Follow the routing for as long as this process runs (boot.ts). `seed`:
 *  the routing's first contact (records-import.ts seedRouting), tried again
 *  every minute while the install's default row is missing — a boot whose
 *  seed failed must not leave the workspaces an earlier release moved
 *  reading as files for good. */
export function startRoutingWatch(seed?: () => Promise<void>): void {
  if (timer || !databaseEnabled()) return;
  reseed = seed ?? null;
  timer = setInterval(() => {
    void routingBeat();
    if (reseed && !seededSeen && Date.now() - lastSeed > 60_000) {
      lastSeed = Date.now();
      void db()
        ?.query("SELECT 1 FROM records_routing WHERE tenant = '*' AND workspace = '*'")
        .then(async (r) => {
          if (r.rows.length) seededSeen = true;
          else await reseed?.();
        })
        .catch((err) => opsError("records.routing_seed_failed", err, {}, "warn"));
    }
  }, routingBeatMs());
  timer.unref();
  void routingBeat();
}

/** Stop following it, and say so, so no import waits for this process (shutdown, tests). */
export async function stopRoutingWatch(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  reseed = null;
  await db()?.query("DELETE FROM records_routing_pods WHERE pod = $1", [POD]).catch(() => {});
}

/** Stop trusting what this process read: its next record call reads the
 *  routing again, or is refused (a change committed here that this process
 *  could not then read back). */
export function invalidateRouting(): void {
  freshAt = -Infinity;
}

/** For tests: may this process answer `files` without reading again? */
export function routingLeaseFreshForTest(): boolean {
  return performance.now() - freshAt <= routingLeaseMs();
}

/** For tests: forget what this process read. */
export function resetRoutingForTest(): void {
  snap = null;
  freshAt = -Infinity;
  failedAt = -Infinity;
  busy.clear();
}

/** The statement every routing change carries in its own transaction: the
 *  generation goes up (the default row is made, as `files`, if there is none). */
export const BUMP_GEN = `INSERT INTO records_routing (tenant, workspace, state, gen) VALUES ('*', '*', 'files', 1)
  ON CONFLICT (tenant, workspace) DO UPDATE SET gen = records_routing.gen + 1, changed_at = now() RETURNING gen`;
