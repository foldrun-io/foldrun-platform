// A load simulation of the box at its busiest minute (scale plan step 7,
// 17 Oct 2026): 100 accounts all firing at 08:00, against the real queue
// claim (queue-db.ts claimNextDb, Postgres) and the real room decision
// (pod-room.ts roomTaken/whyNoRoom), on a virtual clock — no pods, no model,
// no tokens.
//
//   docker run -d --rm -e POSTGRES_PASSWORD=test -e POSTGRES_USER=foldrun \
//     -e POSTGRES_DB=foldrun -p 55432:5432 postgres:16-alpine
//   FOLDRUN_TEST_DATABASE_URL=postgres://foldrun:test@localhost:55432/foldrun \
//     node scripts/load-sim.ts [--accounts 100] [--runs 3] [--seed 7]
//
// Two modes, the same workload:
//   now     what the box runs since 17 Oct: weighted fair share, 2 runs per
//           account, 8 slots, the room gate (22 GiB, 8 sandboxes an account)
//   before  what it ran until then: strict priority, no account cap, 4 slots,
//           every pod created at once — Pending past the node's memory, and
//           a step failed when its pod stayed Pending 180 s.
//
// The workload is drawn from the box's own week (11–17 Oct): steps p50 40 s,
// p95 ~430 s; 86% small (1 GiB), 13% large (6 GiB), 1% heavy (8 GiB); runs of
// one to three steps; a few fan-outs of twenty. Ten accounts are on a fast
// lane, ten on a slow one, the rest normal.

import { RUN_LABEL } from "../../foldrun-core/src/run-container.ts";
import { ACCOUNT_LABEL } from "../src/search-k8s.ts";
import { roomTaken, whyNoRoom, type PodLike } from "../src/pod-room.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
if (!url) {
  console.error("set FOLDRUN_TEST_DATABASE_URL (see the header)");
  process.exit(2);
}
const u = new URL(url);
process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
process.env.FOLDRUN_SECRET_KEY ??= "load-sim";

const arg = (name: string, d: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const ACCOUNTS = arg("accounts", 100);
const RUNS = arg("runs", 3);
const SEED = arg("seed", 7);

// ------------------------------------------------------------ the workload

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
let rand = rng(SEED);
/** Lognormal with the box's step times: median 40 s, p95 ≈ 430 s. */
const stepSecs = () => {
  const z = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  return Math.max(5, 40 * Math.exp(1.444 * z));
};
const size = () => {
  const r = rand();
  return r < 0.86 ? 1 : r < 0.99 ? 6 : 8;
};

interface Step { pods: { gib: number; secs: number }[] }
interface Run { id: string; tenant: string; lane: "high" | "normal" | "low"; steps: Step[] }

/** The same workload every call: the stream starts from the seed again. */
function workload(): Run[] {
  rand = rng(SEED);
  const runs: Run[] = [];
  for (let a = 0; a < ACCOUNTS; a++) {
    const tenant = `acct${String(a).padStart(3, "0")}`;
    const lane = a < ACCOUNTS / 10 ? "high" : a >= ACCOUNTS - ACCOUNTS / 10 ? "low" : "normal";
    for (let r = 0; r < RUNS; r++) {
      const fanout = r === 0 && a % 20 === 7; // five accounts in a hundred fan a run out
      const steps: Step[] = fanout
        ? [{ pods: Array.from({ length: 20 }, () => ({ gib: 1, secs: stepSecs() })) }]
        : Array.from({ length: 1 + Math.floor(rand() * 3) }, () => ({ pods: [{ gib: size(), secs: stepSecs() }] }));
      runs.push({ id: `${tenant}-run${r}`, tenant, lane, steps });
    }
  }
  return runs;
}

// ------------------------------------------------------------ one mode

interface Result {
  mode: string;
  drainedSecs: number;
  claimWait: number[];
  firstRunWait: Record<string, number>;
  roomWait: number[];
  failedPods: number;
  peakGiB: number;
}

const pct = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0;
};

async function simulate(mode: "now" | "before"): Promise<Result> {
  const q = await import("../src/queue-db.ts");
  const { orm } = await import("../src/db.ts");
  const db = orm()!;
  await db.execute("TRUNCATE queue");
  const runs = workload();
  const byId = new Map(runs.map((r) => [r.id, r]));
  const now = mode === "now";
  const SLOTS = now ? 8 : 4;
  const CAP = now ? 2 : 0;
  const limits = now ? { budgetGiB: 22, accountPods: 8 } : { budgetGiB: 0, accountPods: 0 };
  const NODE_GIB = 23; // what the node has for runs once the platform's pods are counted out
  const weight = { high: 3, normal: 2, low: 1 } as const;
  const prio = { high: 10, normal: 0, low: -10 } as const;
  for (const r of runs) {
    await q.enqueueDb({ tenant: r.tenant, workspace: "desk", runId: r.id, priority: prio[r.lane], ...(now ? { accountWeight: weight[r.lane] } : {}) });
  }

  // What used to pick the next job: priority first, outright.
  const claimBefore = async () => {
    const { rows } = await db.execute<{ run_id: string }>(`
      UPDATE queue SET claimed_at = now(), claimed_by = 'sim'
       WHERE id = (SELECT id FROM queue WHERE claimed_at IS NULL ORDER BY priority DESC, seq, enqueued_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING run_id`);
    return rows[0]?.run_id ?? null;
  };
  const claim = async () => (now ? (await q.claimNextDb("sim", CAP))?.runId ?? null : await claimBefore());

  let t = 0;
  let free = SLOTS;
  let peakGiB = 0;
  let failedPods = 0;
  const claimWait: number[] = [];
  const firstRunWait: Record<string, number> = {};
  const roomWait: number[] = [];
  type Live = { run: Run; step: number; left: number };
  const live = new Map<string, Live>();
  // pods on the node: running ones end at `end`; in `before`, Pending ones wait for memory
  let pods: { run: string; tenant: string; gib: number; end: number; started: boolean; since: number; secs: number }[] = [];
  const waiting: { run: string; tenant: string; gib: number; secs: number; since: number }[] = [];
  const asPods = (): PodLike[] =>
    pods.filter((p) => p.started).map((p) => ({
      metadata: { labels: { [RUN_LABEL]: p.run, [ACCOUNT_LABEL]: p.tenant } },
      status: { phase: "Running" },
      spec: { containers: [{ resources: { limits: { memory: `${p.gib}Gi` } } }] },
    }));
  const usedGiB = () => pods.filter((p) => p.started).reduce((s, p) => s + p.gib, 0);

  const place = (run: string, tenant: string, gib: number, secs: number, since: number) => {
    if (now) {
      if (whyNoRoom(roomTaken(asPods(), tenant), gib, limits)) {
        waiting.push({ run, tenant, gib, secs, since });
        return;
      }
      roomWait.push(t - since);
      pods.push({ run, tenant, gib, end: t + secs, started: true, since, secs });
    } else {
      // Created at once; the scheduler starts it when memory frees, and the
      // step fails if that takes past 180 s.
      const fits = usedGiB() + gib <= NODE_GIB;
      pods.push({ run, tenant, gib, end: fits ? t + secs : Infinity, started: fits, since, secs });
    }
    peakGiB = Math.max(peakGiB, usedGiB());
  };
  const startStep = (l: Live) => {
    const step = l.run.steps[l.step];
    l.left = step.pods.length;
    for (const p of step.pods) place(l.run.id, l.run.tenant, p.gib, p.secs, t);
  };
  const fillSlots = async () => {
    while (free > 0) {
      const id = await claim();
      if (!id) break;
      const run = byId.get(id)!;
      claimWait.push(t);
      if (!(run.tenant in firstRunWait)) firstRunWait[run.tenant] = t;
      free--;
      const l: Live = { run, step: 0, left: 0 };
      live.set(id, l);
      startStep(l);
    }
  };
  const podDone = async (runId: string) => {
    const l = live.get(runId)!;
    if (--l.left > 0) return;
    if (++l.step < l.run.steps.length) return startStep(l);
    live.delete(runId);
    await q.releaseDb(runId, "sim");
    free++;
  };

  await fillSlots();
  while (live.size || waiting.length) {
    // `before`: Pending pods start as memory frees, or fail at 180 s
    if (!now) {
      for (const p of pods.filter((x) => !x.started)) {
        if (usedGiB() + p.gib <= NODE_GIB) {
          p.started = true;
          p.end = t + p.secs;
        } else if (t - p.since >= 180) {
          failedPods++;
          p.started = true; // gone: the step failed
          p.end = t;
          p.gib = 0;
        }
      }
    }
    const nextEnd = Math.min(...pods.filter((p) => p.started).map((p) => p.end));
    const nextFail = now ? Infinity : Math.min(...pods.filter((p) => !p.started).map((p) => p.since + 180));
    const next = Math.min(nextEnd, nextFail);
    if (!Number.isFinite(next)) break;
    t = next;
    const done = pods.filter((p) => p.started && p.end <= t);
    pods = pods.filter((p) => !(p.started && p.end <= t));
    for (const p of done) await podDone(p.run);
    // `now`: steps waiting for room take it in arrival order as it frees
    for (let i = 0; i < waiting.length; ) {
      const w = waiting[i];
      if (t - w.since > 1800) {
        failedPods++;
        waiting.splice(i, 1);
        await podDone(w.run);
        continue;
      }
      if (!whyNoRoom(roomTaken(asPods(), w.tenant), w.gib, limits)) {
        waiting.splice(i, 1);
        roomWait.push(t - w.since);
        pods.push({ run: w.run, tenant: w.tenant, gib: w.gib, end: t + w.secs, started: true, since: w.since, secs: w.secs });
        peakGiB = Math.max(peakGiB, usedGiB());
      } else i++;
    }
    await fillSlots();
  }
  return { mode, drainedSecs: t, claimWait, firstRunWait, roomWait, failedPods, peakGiB };
}

const mins = (s: number) => `${(s / 60).toFixed(1)} min`;
const report = (r: Result, runs: Run[]) => {
  const lanes = ["high", "normal", "low"] as const;
  const firstBy = (lane: string) => runs.filter((x) => x.lane === lane && x.id.endsWith("-run0")).map((x) => r.firstRunWait[x.tenant] ?? r.drainedSecs);
  console.log(`\n${r.mode}`);
  console.log(`  queue drained in      ${mins(r.drainedSecs)}`);
  console.log(`  run start wait        p50 ${mins(pct(r.claimWait, 0.5))} · p95 ${mins(pct(r.claimWait, 0.95))}`);
  for (const lane of lanes) {
    const w = firstBy(lane);
    console.log(`  first run, ${lane.padEnd(6)}   p50 ${mins(pct(w, 0.5))} · p95 ${mins(pct(w, 0.95))} · worst ${mins(Math.max(...w))}`);
  }
  if (r.roomWait.length) console.log(`  waits for room        p50 ${pct(r.roomWait, 0.5).toFixed(0)} s · p95 ${pct(r.roomWait, 0.95).toFixed(0)} s · worst ${Math.max(...r.roomWait).toFixed(0)} s`);
  console.log(`  peak memory held      ${r.peakGiB} GiB`);
  console.log(`  steps that failed     ${r.failedPods}${r.mode === "before" ? " (Pending past 180 s)" : " (no room in 30 min)"}`);
};

await (await import("../src/db.ts")).migrate();
const runs = workload();
console.log(`${ACCOUNTS} accounts × ${RUNS} runs at one minute — ${runs.length} runs, ${runs.reduce((n, r) => n + r.steps.reduce((m, s) => m + s.pods.length, 0), 0)} pods (seed ${SEED})`);
const results = [];
for (const mode of ["before", "now"] as const) {
  results.push(await simulate(mode));
  report(results.at(-1)!, workload());
}
const json = process.argv.includes("--json");
if (json) console.log(JSON.stringify(results.map((r) => ({ ...r, claimWait: undefined, roomWait: undefined, firstRunWait: undefined, claimP95: pct(r.claimWait, 0.95) }))));
process.exit(0);
