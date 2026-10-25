// FOL-18: the worker's probe is answered from its own thread, so a main
// thread held by synchronous work still answers — busy is reported, and
// only a loop held past FOLDRUN_WORKER_BLOCKED_MS is a 503.
//
//   node --test tests/worker-health.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { healthVerdict, startHealth, withDeadline, type HealthSnapshot } from "../src/worker-health.ts";

const limits = { staleMs: 180_000, blockedMs: 600_000 };
const now = 10_000_000;
const fresh: HealthSnapshot = { ready: true, loopBeatAt: now - 500, tickAt: now - 1_000, database: true, redis: null, checkedAt: now - 2_000 };

test("the verdict: ready and fresh is ok; before boot is not", () => {
  const v = healthVerdict(fresh, now, limits);
  assert.equal(v.ok, true);
  assert.equal(v.blocked, false);
  assert.equal(v.stale, false);
  assert.equal(v.checkedAgeMs, 2_000);
  assert.equal(healthVerdict({ ...fresh, ready: false }, now, limits).ok, false);
});

test("a busy loop is reported, not failed: its stale tick is not counted until it is blocked", () => {
  const busy = { ...fresh, loopBeatAt: now - 240_000, tickAt: now - 241_000 };
  const v = healthVerdict(busy, now, limits);
  assert.equal(v.ok, true, "four minutes of synchronous work is busy, not dead");
  assert.equal(v.loopLagMs, 240_000);
  assert.equal(v.stale, false);
  const stuck = healthVerdict({ ...busy, loopBeatAt: now - 601_000 }, now, limits);
  assert.equal(stuck.ok, false);
  assert.equal(stuck.blocked, true);
});

test("a loop that runs but whose ticks stopped is stale, as before", () => {
  const v = healthVerdict({ ...fresh, tickAt: now - 181_000 }, now, limits);
  assert.equal(v.stale, true);
  assert.equal(v.ok, false);
});

test("a database or Redis that did not answer is not ok; one not configured is fine", () => {
  assert.equal(healthVerdict({ ...fresh, database: false }, now, limits).ok, false);
  assert.equal(healthVerdict({ ...fresh, redis: false }, now, limits).ok, false);
  assert.equal(healthVerdict({ ...fresh, database: null, redis: null }, now, limits).ok, true);
});

test("checks that stop answering are not read as fine", async () => {
  assert.equal(healthVerdict({ ...fresh, checkedAt: 0 }, now, limits).ok, false, "no check yet");
  assert.equal(healthVerdict({ ...fresh, checkedAt: now - 61_000 }, now, limits).ok, false, "checks stopped while the loop runs");
  assert.equal(
    healthVerdict({ ...fresh, loopBeatAt: now - 120_000, tickAt: now - 121_000, checkedAt: now - 121_000 }, now, limits).ok,
    true,
    "a held loop cannot check; that is the busy case, not a dead database",
  );
  assert.equal(await withDeadline(new Promise<boolean>(() => {}), 50), false, "a check that hangs is down");
  assert.equal(await withDeadline(Promise.reject(new Error("refused")), 50), false);
  assert.equal(await withDeadline(Promise.resolve(true), 50), true);
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

/** Fetch the probe from a child process after `delayMs`, while THIS thread
 *  is held in spawnSync — the shape of the 6 Oct freeze. */
function probeWhileBlocked(port: number, delayMs: number): { status: number; body: Record<string, unknown> } {
  const script = `setTimeout(async () => { const r = await fetch("http://127.0.0.1:${port}/api/healthz"); console.log(JSON.stringify({ status: r.status, body: await r.json() })); }, ${delayMs});`;
  const out = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20_000 });
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout.trim());
}

test("the thread answers while the main thread is blocked, and says 503 once it has been held too long", async () => {
  const prev = process.env.FOLDRUN_WORKER_BLOCKED_MS;
  process.env.FOLDRUN_WORKER_BLOCKED_MS = "3000";
  const port = await freePort();
  const h = startHealth({ port, version: "vtest", tickAge: () => 0, checks: async () => ({ database: null, redis: null }) });
  try {
    let first: Response | null = null;
    for (let i = 0; i < 50 && !first; i++) {
      first = await fetch(`http://127.0.0.1:${port}/api/healthz`).catch(() => null);
      if (!first) await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(first?.status, 503, "not ready before boot says so");
    h.setReady();
    const ok = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as Record<string, unknown>;
    assert.equal(body.role, "worker");
    assert.equal(body.version, "vtest");

    // How long this thread is held includes the child's own start-up,
    // which is 0.1 s on a laptop and was 14 s under emulation — so the
    // answer is checked against the lag it reports, not a guessed one.
    const busy = probeWhileBlocked(port, 1_500);
    const lag = Number(busy.body.loopLagMs);
    assert.ok(lag >= 1_000, `answered while held, with the lag: ${JSON.stringify(busy.body)}`);
    assert.equal(busy.status, lag > 3_000 ? 503 : 200, `busy until the limit, blocked past it: ${JSON.stringify(busy.body)}`);
    assert.equal(busy.body.blocked, lag > 3_000);

    const stuck = probeWhileBlocked(port, 4_500);
    assert.equal(stuck.status, 503, `held past the limit: ${JSON.stringify(stuck.body)}`);
    assert.equal(stuck.body.blocked, true);

    await new Promise((r) => setTimeout(r, 1_200));
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/healthz`)).status, 200, "back to ok once the loop runs again");
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/other`)).status, 404);
  } finally {
    await h.close();
    if (prev === undefined) delete process.env.FOLDRUN_WORKER_BLOCKED_MS;
    else process.env.FOLDRUN_WORKER_BLOCKED_MS = prev;
  }
});
