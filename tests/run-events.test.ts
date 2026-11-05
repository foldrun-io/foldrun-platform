// FOL-122: the run's wide event in Postgres — written at the first enqueue
// (with the job, in one transaction), the first claim and the end; the SLIs
// computed from the rows and served as fixed-label gauges; and the ops
// trace sent once, under a lease, to OUR collector only when one is named.
// Without a database: nothing written, nothing sent, nothing breaks.
//
//   node --test tests/run-events.test.ts
//   FOLDRUN_TEST_DATABASE_URL=postgres://foldrun:test@localhost:55432/foldrun \
//     node --test tests/run-events.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { takeTurnsOnLiveDb } from "./live-db-lock.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
const live = { skip: url ? false : "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" };
takeTurnsOnLiveDb(url);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-run-events-"));
process.env.FOLDRUN_DATA = root;
process.env.FOLDRUN_DISABLE_WORKER = "1";
if (url) {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  process.env.FOLDRUN_SECRET_KEY ??= "test-install-key";
}

const T0 = Date.now() - 30 * 60_000;
const at = (secs: number) => new Date(T0 + secs * 1000).toISOString();

function record(id: string, p: Record<string, unknown> = {}, step: Record<string, unknown> = {}) {
  return {
    id,
    flow: "daily",
    tags: [],
    status: "completed",
    startedAt: at(0),
    finishedAt: at(60),
    drivenAt: at(4),
    steps: [
      {
        agent: "writer", instruction: "SECRET-PROMPT", group: 1, optional: false, status: "completed", events: [], result: "SECRET-REPLY", costUsd: 0.25,
        startedAt: at(5), startupAt: at(5), startup: { ready: 3, files: 4, go: 4.2, tools: 6, model: 9 }, startupSecs: 3, computeSecs: 40,
        size: "large", image: { variant: "slim" }, reserved: { cpus: 2, memGiB: 4, diskGiB: 20 }, attempts: 1,
        ...step,
      },
    ],
    ...p,
  };
}

test("without a database: nothing written, no SLIs, no gauges, no trace — and nothing throws", async () => {
  if (url) return; // this file's DB half runs with one; the file-mode half without
  const ev = await import("../src/run-events.ts");
  await ev.recordRunEnded("acme", "desk", record("run-nodb") as never);
  await ev.recordClaimed("acme", "desk", "run-nodb");
  assert.equal(await ev.runSlis(24), null);
  assert.deepEqual(await ev.runEventMetricsText(), []);
  assert.equal(await ev.exportOpsTrace("acme", "desk", "run-nodb"), "skipped");
  assert.deepEqual(await ev.sweepRunEvents(), { finished: 0, traced: 0 });
});

test("the ops trace is off unless a collector is named, and only http(s)", async () => {
  const { opsTraceUrl } = await import("../src/run-events.ts");
  assert.equal(opsTraceUrl({}), null);
  assert.equal(opsTraceUrl({ FOLDRUN_OPS_OTLP_URL: " " }), null);
  assert.equal(opsTraceUrl({ FOLDRUN_OPS_OTLP_URL: "file:///etc/passwd" }), null);
  assert.equal(opsTraceUrl({ FOLDRUN_OPS_OTLP_URL: "not a url" }), null);
  assert.equal(opsTraceUrl({ FOLDRUN_OPS_OTLP_URL: "http://alloy.observability.svc.cluster.local:4318/v1/traces" }), "http://alloy.observability.svc.cluster.local:4318/v1/traces");
});

test("live: enqueue, claim and end each write their part; the end never touches the queue's", live, async () => {
  const { migrate, orm, tx } = await import("../src/db.ts");
  await migrate();
  await orm()!.execute("TRUNCATE run_events");
  await orm()!.execute("TRUNCATE queue");
  const ev = await import("../src/run-events.ts");
  const qdb = await import("../src/queue-db.ts");
  const { claimNext } = await import("../src/queue.ts");
  const { writeRun } = await import("../../foldrun-core/src/store.ts");
  fs.mkdirSync(path.join(root, "acme/workspaces/desk/runs"), { recursive: true });

  // The job and the row, one transaction — as enqueue({ first: true }).
  await tx(async (t) => {
    await qdb.lineUpDb({ tenant: "acme", workspace: "desk", runId: "run-e1" }, t);
    await ev.recordEnqueued(t, { tenant: "acme", workspace: "desk", runId: "run-e1" });
  });
  // A second enqueue (a resume) changes nothing.
  await tx((t) => ev.recordEnqueued(t, { tenant: "acme", workspace: "desk", runId: "run-e1", notBefore: new Date(Date.now() + 3600_000).toISOString() }));
  const claim = (await claimNext())!;
  assert.equal(claim.job.runId, "run-e1");
  const afterClaim = (await ev.readRunEvent("acme", "desk", "run-e1"))!;
  assert.ok(afterClaim.queuedAt && afterClaim.queueEligibleAt && afterClaim.claimedAt);
  assert.equal(afterClaim.queueEligibleAt!.getTime(), afterClaim.queuedAt!.getTime(), "the first enqueue had no not_before");
  await claim.release();

  const run = record("run-e1");
  writeRun("acme", "desk", run as never);
  await ev.recordRunEnded("acme", "desk", run as never);
  await ev.recordRunEnded("acme", "desk", run as never); // a repeat is the same row
  const row = (await ev.readRunEvent("acme", "desk", "run-e1"))!;
  assert.equal(row.queuedAt!.getTime(), afterClaim.queuedAt!.getTime(), "the end write kept the queue's facts");
  assert.equal(row.claimedAt!.getTime(), afterClaim.claimedAt!.getTime());
  assert.deepEqual(
    [row.status, row.slo, row.sloReason, row.image, row.size, row.flow, row.kind, row.origin, row.funnelStep],
    ["completed", "good", "completed", "slim", "large", "daily", "flow", "exact", 0],
  );
  assert.equal(row.submittedAt!.toISOString(), at(0));
  assert.equal(row.scheduledAt!.toISOString(), at(4));
  assert.equal(row.podReadyAt!.toISOString(), at(8));
  assert.equal(row.sandboxUpAt!.toISOString(), at(11));
  assert.equal(row.firstOutputAt!.toISOString(), at(14));
  assert.equal(row.finishedAt!.toISOString(), at(60));
  assert.equal(Number(row.costUsd), 0.25);
  assert.equal(row.traceState, null, "no collector named: no trace asked for");
  assert.ok(!/SECRET/.test(JSON.stringify(row)), "metadata only");

  // A run lined up before this existed: the end write makes its row, with no queue facts.
  const old = record("run-old");
  await ev.recordRunEnded("acme", "desk", old as never);
  const oldRow = (await ev.readRunEvent("acme", "desk", "run-old"))!;
  assert.deepEqual([oldRow.queuedAt, oldRow.queueEligibleAt, oldRow.claimedAt], [null, null, null]);
});

test("live: the sweep finishes a row whose run ended without its end write; the prune and the account's deletion remove rows", live, async () => {
  const { orm, tx } = await import("../src/db.ts");
  await orm()!.execute("TRUNCATE run_events");
  const ev = await import("../src/run-events.ts");
  const { writeRun } = await import("../../foldrun-core/src/store.ts");
  fs.mkdirSync(path.join(root, "acme/workspaces/desk/runs"), { recursive: true });
  await tx((t) => ev.recordEnqueued(t, { tenant: "acme", workspace: "desk", runId: "run-lost" }));
  await tx((t) => ev.recordEnqueued(t, { tenant: "acme", workspace: "desk", runId: "run-live" }));
  await orm()!.execute("UPDATE run_events SET created_at = now() - interval '1 hour', updated_at = now() - interval '1 hour'");
  writeRun("acme", "desk", record("run-lost", { status: "failed" }, { status: "failed", events: [{ t: at(50), type: "error", text: "pod never became ready in 300s" }] }) as never);
  writeRun("acme", "desk", record("run-live", { status: "running", finishedAt: null }) as never);
  assert.equal((await ev.sweepRunEvents()).finished, 1);
  const lost = (await ev.readRunEvent("acme", "desk", "run-lost"))!;
  assert.deepEqual([lost.status, lost.errorClass, lost.slo, lost.sloReason], ["failed", "platform_error", "bad", "platform"]);
  assert.equal((await ev.readRunEvent("acme", "desk", "run-live"))!.finishedAt, null, "a live run is left");
  assert.equal((await ev.sweepRunEvents()).finished, 0, "and, looked at, waits its turn: not read again at once");

  assert.equal(await ev.pruneRunEvents(Date.now() - 24 * 3600_000), 0, "nothing older than the window");
  assert.equal(await ev.pruneRunEvents(Date.now() + 1000), 2, "finished before the cutoff, and never finished but made before it");
  await tx((t) => ev.recordEnqueued(t, { tenant: "gone", workspace: "w", runId: "run-x" }));
  assert.equal(await ev.deleteTenantRunEvents("gone"), 1);
});

test("live: the SLIs and their gauges — fixed labels, NaN for nothing, customer failures excluded", live, async () => {
  const { orm } = await import("../src/db.ts");
  await orm()!.execute("TRUNCATE run_events");
  const ev = await import("../src/run-events.ts");
  ev.resetRunEventMetricsCache();
  const empty = (await ev.runSlis(1))!;
  assert.equal(empty.successRatio, null);
  let text = (await ev.runEventMetricsText()).join("\n");
  assert.match(text, /^foldrun_run_sli_success_ratio_window\{window="1h"\} NaN$/m);
  assert.match(text, /^foldrun_run_queue_wait_p95_seconds_window\{window="24h"\} NaN$/m);

  const now = Date.now();
  const iso = (ms: number) => new Date(now - ms).toISOString();
  const done = (id: string, waitSecs: number, outputSecs: number, p: Record<string, unknown> = {}, s: Record<string, unknown> = {}) =>
    record(id, { startedAt: iso(600_000), drivenAt: new Date(now - 600_000 + waitSecs * 1000).toISOString(), finishedAt: iso(60_000), ...p }, { startupAt: iso(500_000), startup: { ready: 2, tools: 3, model: 2 + outputSecs }, ...s });
  const failed = (text: string) => ({ status: "failed", events: [{ t: iso(60_000), type: "error", text }] });
  const runs = [
    done("r1", 1, 4), done("r2", 2, 5), done("r3", 3, 6),
    done("r4", 4, 7, { status: "failed" }, failed("pod never became ready in 300s")),
    done("r5", 5, 8, { status: "failed" }, failed("script fetch.py exited (code 1)")),
    done("r6", 6, 9, { test: true }),
  ];
  for (const r of runs) {
    const { tx } = await import("../src/db.ts");
    await tx((t) => ev.recordEnqueued(t, { tenant: "acme", workspace: "desk", runId: r.id }));
    // The queue facts as the enqueue would have them, at the run's start.
    await orm()!.execute(`UPDATE run_events SET queued_at = '${r.startedAt}', queue_eligible_at = '${r.startedAt}' WHERE run_id = '${r.id}'`);
    await ev.recordRunEnded("acme", "desk", r as never);
  }
  const s = (await ev.runSlis(24))!;
  assert.deepEqual([s.good, s.bad, s.excluded], [3, 1, 1], "the test run is left out; the script's failure is the customer's");
  assert.equal(s.successRatio, 0.75);
  assert.equal(s.queueWaitObserved, 5);
  assert.ok(Math.abs(s.queueWaitP95Secs! - 4.8) < 0.01, `queue wait p95 ${s.queueWaitP95Secs}`);
  assert.equal(s.readyToOutputObserved, 5);
  assert.ok(Math.abs(s.readyToOutputP95Secs! - 7.8) < 0.01, `ready→output p95 ${s.readyToOutputP95Secs}`);

  ev.resetRunEventMetricsCache();
  text = (await ev.runEventMetricsText()).join("\n");
  assert.match(text, /^foldrun_run_sli_success_ratio_window\{window="24h"\} 0\.75$/m);
  assert.match(text, /^foldrun_runs_finished_window\{window="24h",status="failed",slo="excluded",error_class="user_code_error"\} 1$/m);
  assert.ok(!/acme|desk|r[1-6]\b|daily/.test(text), "no account, workspace, flow or run in the scrape");
  for (const l of text.split("\n")) {
    if (l.startsWith("# ")) continue;
    assert.match(l, /^foldrun_[a-z0-9_]+(\{window="(1h|24h)"(,status="(completed|failed|unknown)",slo="(good|bad|excluded|unknown)",error_class="[a-z_]+")?\})? (-?\d+(\.\d+)?|NaN)$/, l);
  }
});

test("live: the ops trace — sent once under a lease, retried after a refusal, abandoned after five tries, never with content", live, async () => {
  const { orm } = await import("../src/db.ts");
  await orm()!.execute("TRUNCATE run_events");
  const ev = await import("../src/run-events.ts");
  const bodies: string[] = [];
  let answer = 500;
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      bodies.push(b);
      res.writeHead(answer, { "content-type": "application/json" });
      res.end(answer === 200 ? "{}" : "SECRET-COLLECTOR-WORDS");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.FOLDRUN_OPS_OTLP_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces`;
  try {
    const run = record("run-t1", {}, { events: [{ t: at(1), type: "info", text: "SECRET-TRAIL" }] });
    await ev.recordRunEnded("acme", "desk", run as never); // pending, and a first try that is refused
    await new Promise((r) => setTimeout(r, 300));
    let row = (await ev.readRunEvent("acme", "desk", "run-t1"))!;
    assert.deepEqual([row.traceState, row.traceAttempts, row.traceClaim], ["pending", 1, null]);
    // Inside the lease nobody tries again.
    assert.equal(await ev.exportOpsTrace("acme", "desk", "run-t1"), "skipped");
    // The lease out, the collector back: sent, and only once.
    await orm()!.execute("UPDATE run_events SET trace_claimed_at = now() - interval '10 minutes'");
    answer = 200;
    assert.equal((await ev.sweepRunEvents()).traced, 1);
    row = (await ev.readRunEvent("acme", "desk", "run-t1"))!;
    assert.deepEqual([row.traceState, row.traceAttempts], ["sent", 2]);
    await ev.recordRunEnded("acme", "desk", run as never);
    assert.equal((await ev.readRunEvent("acme", "desk", "run-t1"))!.traceState, "sent", "a repeated end write keeps a sent trace sent");
    assert.equal(await ev.exportOpsTrace("acme", "desk", "run-t1"), "skipped");
    assert.equal(bodies.length, 2);
    const body = JSON.parse(bodies[1]!);
    const services = body.resourceSpans.map((r: { resource: { attributes: { value: { stringValue: string } }[] } }) => r.resource.attributes[0]!.value.stringValue);
    assert.deepEqual(services, ["foldrun-web", "foldrun-worker", "foldrun-runner"]);
    assert.ok(!/SECRET/.test(bodies.join("")), "no prompt, reply or trail in the trace");

    // Five refusals: given up on, said by state.
    answer = 503;
    await ev.recordRunEnded("acme", "desk", record("run-t2") as never);
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 100));
      await orm()!.execute("UPDATE run_events SET trace_claimed_at = now() - interval '10 minutes' WHERE run_id = 'run-t2'");
      await ev.exportOpsTrace("acme", "desk", "run-t2");
    }
    row = (await ev.readRunEvent("acme", "desk", "run-t2"))!;
    assert.deepEqual([row.traceState, row.traceAttempts], ["abandoned", 5]);
  } finally {
    delete process.env.FOLDRUN_OPS_OTLP_URL;
    server.close();
  }
});

test("live: enqueueFlowRun writes the row with its job; a claim marks it", live, async () => {
  const { orm } = await import("../src/db.ts");
  await orm()!.execute("TRUNCATE run_events");
  await orm()!.execute("TRUNCATE queue");
  const ws = path.join(root, "acme/workspaces/desk");
  fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
  const { enqueueFlowRun, claimNext } = await import("../src/queue.ts");
  const ev = await import("../src/run-events.ts");
  const run = await enqueueFlowRun("acme", "desk", [{ agent: "writer", instruction: "x", group: 1, optional: false }], "daily");
  const row = (await ev.readRunEvent("acme", "desk", run.id))!;
  assert.ok(row.queuedAt, "written with the job");
  assert.equal(row.claimedAt, null);
  const claim = (await claimNext())!;
  assert.equal(claim.job.runId, run.id);
  assert.ok((await ev.readRunEvent("acme", "desk", run.id))!.claimedAt);
  await claim.release();
});
