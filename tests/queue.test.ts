// The run queue: a job is a file, claiming it is renaming it.
//
// These tests never call a model. The park path is exercised through a flow
// whose first step needs approval — the gate fires before any step runs, so
// driveRun returns without touching the SDK.
//
//   node --test tests/queue.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fairOrder,
  enqueueFlowRun,
  enqueueResume,
  claimNext,
  recoverQueue,
  rerunFrom,
  startFlowFromStep,
  stopRun,
  holdsWorkerLease,
  peekWorkerLease,
  queueStats,
  parkedNotBefore,
} from "../src/queue.ts";
import { driveRun } from "../../foldrun-core/src/runner.ts";
import { readLedger } from "../src/ledger.ts";
import { settleRun } from "../src/settle.ts";
import { deleteRun, flowHasLiveRun, listFlows, readRun, writeRun, runDisplayStatus, runMeter, type RunRecord } from "../../foldrun-core/src/store.ts";

/** A tenant/workspace on disk, and core pointed at it. */
function withWorkspace(body: () => void | Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-queue-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "agents/writer"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    fs.writeFileSync(
      path.join(ws, "agents/writer/agent.md"),
      "---\nname: writer\ndescription: writes\n---\n\nWrite.\n",
    );
    const out = body();
    if (out && typeof (out as Promise<void>).then === "function") {
      return (out as Promise<void>).finally(() => cleanup(root, previous));
    }
    cleanup(root, previous);
  } catch (err) {
    cleanup(root, previous);
    throw err;
  }
}

function cleanup(root: string, previous: string | undefined) {
  if (previous === undefined) delete process.env.FOLDRUN_DATA;
  else process.env.FOLDRUN_DATA = previous;
  fs.rmSync(root, { recursive: true, force: true });
}

const STEP = { agent: "writer", instruction: "draft it", group: 1, optional: false };

const pendingDir = () => path.join(process.env.FOLDRUN_DATA!, "queue/pending");
const claimedDir = () => path.join(process.env.FOLDRUN_DATA!, "queue/claimed");
const pendingJobs = () =>
  fs.existsSync(pendingDir()) ? fs.readdirSync(pendingDir()).filter((f) => f.endsWith(".json")) : [];

test("enqueueing writes a queued record and one pending job", async () => {
  await withWorkspace(async () => {
    const run = await enqueueFlowRun("acme", "desk", [STEP], "publish");
    assert.equal(run.status, "queued");
    assert.equal(readRun("acme", "desk", run.id)!.status, "queued");
    assert.equal(pendingJobs().length, 1);
    assert.ok(pendingJobs()[0].endsWith(`-${run.id}.json`));
  });
});

test("claiming is first-in-first-out and moves the job, not copies it", async () => {
  await withWorkspace(async () => {
    const first = await enqueueFlowRun("acme", "desk", [STEP], "one");
    const second = await enqueueFlowRun("acme", "desk", [STEP], "two");

    const a = await claimNext();
    assert.equal(a!.job.runId, first.id);
    const b = await claimNext();
    assert.equal(b!.job.runId, second.id);
    assert.equal(await claimNext(), null);

    assert.equal(pendingJobs().length, 0);
    assert.equal(fs.readdirSync(claimedDir()).length, 2);
  });
});

test("re-enqueueing a run that is already pending does not duplicate it", async () => {
  await withWorkspace(async () => {
    const run = await enqueueFlowRun("acme", "desk", [STEP], "publish");
    await enqueueResume("acme", "desk", run.id);
    await enqueueResume("acme", "desk", run.id);
    assert.equal(pendingJobs().length, 1);
  });
});

test("recovery returns claimed jobs to pending", async () => {
  await withWorkspace(async () => {
    const run = await enqueueFlowRun("acme", "desk", [STEP], "publish");
    await claimNext(); // a worker took it, then the process died
    assert.equal(pendingJobs().length, 0);

    const { requeued } = await recoverQueue();
    assert.equal(requeued.length, 1);
    assert.equal(pendingJobs().length, 1);
    assert.equal((await claimNext())!.job.runId, run.id);
  });
});

test("recovery re-creates the job for a queued run whose file was lost", async () => {
  await withWorkspace(async () => {
    const run = await enqueueFlowRun("acme", "desk", [STEP], "publish");
    fs.rmSync(pendingDir(), { recursive: true, force: true });

    const { requeued } = await recoverQueue();
    assert.ok(requeued.includes(run.id));
    assert.equal((await claimNext())!.job.runId, run.id);
  });
});

test("recovery drops a pending job whose run already finished", async () => {
  await withWorkspace(async () => {
    const run = await enqueueFlowRun("acme", "desk", [STEP], "publish");
    const record = readRun("acme", "desk", run.id)!;
    record.status = "completed";
    record.finishedAt = new Date().toISOString();
    writeRun("acme", "desk", record);

    const { dropped } = await recoverQueue();
    assert.equal(dropped.length, 1);
    assert.equal(pendingJobs().length, 0);
  });
});

test("a worker-driven run parks at an approval gate instead of blocking", async () =>
  await withWorkspace(async () => {
    const run = await enqueueFlowRun(
      "acme",
      "desk",
      [{ ...STEP, approve: true }],
      "sign-off",
    );
    const claim = (await claimNext())!;

    // What the worker does with a claim — and it must come back promptly,
    // not in 24 hours.
    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!, null, [], {
      parkOnApproval: true,
    });

    const parked = readRun("acme", "desk", run.id)!;
    assert.equal(parked.status, "awaiting-approval");
    assert.ok(parked.parkedAt, "a parked run carries the marker the approval API keys on");
    assert.equal(parked.steps[0].status, "awaiting-approval");
    assert.equal(parked.finishedAt, null, "parked is paused, not finished");
    await claim.release(); // the job is finished with, whichever store held it
  }));

test("an approved parked run drives to the end of what it can do without a model", async () =>
  await withWorkspace(async () => {
    // Park it.
    const run = await enqueueFlowRun("acme", "desk", [{ ...STEP, approve: true }], "sign-off");
    await claimNext();
    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!, null, [], {
      parkOnApproval: true,
    });

    // Reject it — the decision path that needs no SDK call to complete.
    const parked = readRun("acme", "desk", run.id)!;
    parked.steps[0].status = "failed";
    parked.steps[0].events.push({
      t: new Date().toISOString(),
      type: "error",
      text: "rejected by a human",
    });
    writeRun("acme", "desk", parked);

    // Resume as the worker would.
    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!, null, [], {
      parkOnApproval: true,
    });

    const done = readRun("acme", "desk", run.id)!;
    assert.equal(done.status, "failed", "a rejected required step fails the run");
    assert.ok(done.finishedAt, "a resumed run that ends gets an end");
    assert.equal(done.parkedAt, null, "resuming clears the parked marker");
  }));

// --------------------------------------------------------- the run meter

test("the meter counts steps that ran, not steps that were written", async () => {
  const run = {
    id: "run-a",
    flow: "f",
    status: "completed",
    startedAt: "2026-08-26T00:00:00.000Z",
    finishedAt: "2026-08-26T00:10:00.000Z",
    steps: [
      { status: "completed", costUsd: 0.01, computeSecs: 12.5 },
      { status: "failed", costUsd: 0.02, computeSecs: 3.5 },
      { status: "skipped", costUsd: null, computeSecs: 99 }, // `when` said no
      { status: "pending", costUsd: null, computeSecs: 99 }, // never reached
      { status: "completed", costUsd: null, computeSecs: null }, // in-process
    ],
  } as unknown as RunRecord;

  assert.deepEqual(runMeter(run), { tokenCostUsd: 0.03, steps: 3, computeSecs: 16, smallSecs: 0, netBytes: 0 });
});

// ------------------------------------------------------------ re-running

test("a re-run carries the finished steps and resets the rest", async () =>
  await withWorkspace(async () => {
    const source = {
      id: "run-src",
      flow: "extract-and-send",
      status: "completed",
      startedAt: "2026-08-26T00:00:00.000Z",
      finishedAt: "2026-08-26T00:10:00.000Z",
      steps: [
        {
          agent: "extractor", instruction: "extract", group: 1, optional: false,
          status: "completed", events: [], result: "100 firms extracted",
          costUsd: 0.5, computeSecs: 120, startupSecs: 2,
        },
        {
          agent: "emailer", instruction: "send", group: 2, optional: false,
          status: "completed", events: [], result: "found nothing to send",
          costUsd: 0.02, computeSecs: 15, startupSecs: 2,
          approvedAt: "2026-08-26T00:05:00.000Z",
          loop: 3, until: "SENT", loopRemaining: 0,
          sandbox: { kind: "k8s", ref: "foldrun-run-src-abcd", consumed: 12, since: "2026-08-26T00:04:00.000Z" },
        },
      ],
    } as unknown as RunRecord;
    writeRun("acme", "desk", source);

    const rerun = await rerunFrom("acme", "desk", "run-src", { agent: "emailer" });
    assert.notEqual(rerun.id, "run-src");
    assert.deepEqual(rerun.rerunOf, { run: "run-src", step: 2 }, "a re-run says where it came from (FOL-72)");
    // An edited instruction reaches that step only, this once (FOL-72 step 6).
    const edited = await rerunFrom("acme", "desk", "run-src", { step: 2 }, null, { instruction: "  send only to the first ten  " });
    assert.equal(edited.steps[1]!.instruction, "send only to the first ten");
    assert.equal(edited.steps[0]!.instruction, "extract", "the carried step keeps its own");
    assert.deepEqual(edited.rerunOf, { run: "run-src", step: 2, instruction: "send only to the first ten" });
    assert.equal(rerun.status, "queued");

    const [carried, fresh] = rerun.steps;
    // The extraction is context, not work: result kept, billing zeroed,
    // provenance stamped.
    assert.equal(carried.status, "completed");
    assert.equal(carried.result, "100 firms extracted");
    assert.equal(carried.carriedFrom, "run-src");
    assert.equal(carried.costUsd, null);
    // The emailer runs again from scratch — including asking for approval
    // again, because the question changed with the fresh upstream result.
    assert.equal(fresh.status, "pending");
    assert.equal(fresh.result, null);
    assert.equal(fresh.approvedAt, undefined);
    // A critic loop starts over with its full budget — an unset value reads
    // as zero and exhausted the loop on its first cycle.
    assert.equal(fresh.loopRemaining, 3);
    // And never the source run's sandbox — that pod is gone, and a carried
    // ref makes the runner try to resume it instead of starting one.
    assert.equal(fresh.sandbox, null);

    // The original record is history, untouched.
    const untouched = readRun("acme", "desk", "run-src")!;
    assert.equal(untouched.steps[0].costUsd, 0.5);
    assert.equal(untouched.status, "completed");

    // And the meter never bills the carried step again.
    assert.deepEqual(
      runMeter({
        ...rerun,
        steps: [
          { ...carried },
          { ...fresh, status: "completed", costUsd: 0.03, computeSecs: 10 },
        ],
      } as RunRecord),
      { tokenCostUsd: 0.03, steps: 1, computeSecs: 10, smallSecs: 0, netBytes: 0 },
    );
  }));

test("a re-run takes its instructions from the flow as it reads now", async () =>
  await withWorkspace(async () => {
    // The iterate loop this exists for: the first run failed because the
    // instruction pointed at the wrong path, the author fixed the flow, and
    // the re-run must carry the fix — replaying the recorded text re-fails
    // for the exact reason that was just corrected.
    const ws = path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "flows"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, "flows/send.md"),
      "---\nname: send\n---\n\n1. [[writer]] — write it\n2. [[writer]] — email files/summary.md\n",
    );
    const source = {
      id: "run-stale", flow: "send", status: "completed",
      startedAt: "2026-08-26T00:00:00.000Z", finishedAt: "2026-08-26T00:10:00.000Z",
      steps: [
        { agent: "writer", instruction: "write it", group: 1, optional: false,
          status: "completed", events: [], result: "done", costUsd: 0.1 },
        { agent: "writer", instruction: "email outputs/summary.md", group: 2, optional: false,
          status: "failed", events: [], result: null, costUsd: 0.01 },
      ],
    } as unknown as RunRecord;
    writeRun("acme", "desk", source);

    const rerun = await rerunFrom("acme", "desk", "run-stale", { step: 2 });
    // The reset step reads the corrected flow; the carried one keeps the
    // history of what actually ran.
    assert.equal(rerun.steps[1].instruction, "email files/summary.md");
    assert.equal(rerun.steps[0].instruction, "write it");
    assert.equal(rerun.steps[0].carriedFrom, "run-stale");
  }));

test("a re-run takes the step's options from the flow too, not just its words", async () =>
  await withWorkspace(async () => {
    // medium-desk run-mv76fk77-ok5d, 2026-10-14: the verifier failed, the
    // author added `on-fail:` and changed its check, and the re-run from
    // step 7 still had neither, because only the instruction was refreshed.
    const ws = path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "flows"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, "flows/send.md"),
      "---\nname: send\n---\n\n1. [[writer]] — write it\n   retry: 2\n2. [[checker]] — check it\n   on-fail: [[fixer]]\n   verify: contains: GOOD\n",
    );
    const source = {
      id: "run-opts", flow: "send", status: "failed",
      startedAt: "2026-08-26T00:00:00.000Z", finishedAt: "2026-08-26T00:10:00.000Z",
      steps: [
        { agent: "writer", instruction: "write it", group: 1, optional: false,
          status: "completed", events: [], result: "done", costUsd: 0.1 },
        { agent: "checker", instruction: "check it", group: 2, optional: false,
          verify: "test -s old.md", timeout: 60,
          status: "failed", events: [], result: "BAD", costUsd: 0.01 },
      ],
    } as unknown as RunRecord;
    writeRun("acme", "desk", source);

    const rerun = await rerunFrom("acme", "desk", "run-opts", { step: 2 });
    assert.equal(rerun.steps[1].onFail, "fixer");
    assert.notEqual(rerun.steps[1].verify, "test -s old.md");
    assert.ok(rerun.steps[1].verify, "the flow's verify reaches the re-run");
    // An option the flow no longer has is gone, not inherited.
    assert.equal(rerun.steps[1].timeout, undefined);
    // The carried step is history: its recorded options stay as they ran.
    assert.equal(rerun.steps[0].retry, undefined);
  }));

test("a reshaped flow falls back to the recorded instructions", async () =>
  await withWorkspace(async () => {
    const ws = path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "flows"), { recursive: true });
    // The flow gained a step since the run: positions no longer mean the
    // same thing, so guessing would rewrite the wrong step's orders.
    fs.writeFileSync(
      path.join(ws, "flows/send.md"),
      "---\nname: send\n---\n\n1. [[writer]] — research\n2. [[writer]] — write it\n3. [[writer]] — email it\n",
    );
    const source = {
      id: "run-shaped", flow: "send", status: "failed",
      startedAt: "2026-08-26T00:00:00.000Z", finishedAt: "2026-08-26T00:10:00.000Z",
      steps: [
        { agent: "writer", instruction: "write it", group: 1, optional: false,
          status: "completed", events: [], result: "done", costUsd: 0.1 },
        { agent: "writer", instruction: "email outputs/summary.md", group: 2, optional: false,
          status: "failed", events: [], result: null, costUsd: null },
      ],
    } as unknown as RunRecord;
    writeRun("acme", "desk", source);
    const rerun = await rerunFrom("acme", "desk", "run-shaped", { step: 2 });
    assert.equal(rerun.steps[1].instruction, "email outputs/summary.md");
  }));

test("a live run cannot be re-run from, and a missing agent is refused", async () =>
  await withWorkspace(async () => {
    const live = {
      id: "run-live", flow: "f", status: "running",
      startedAt: "2026-08-26T00:00:00.000Z", finishedAt: null,
      steps: [{ agent: "a", instruction: "", group: 1, optional: false,
        status: "running", events: [], result: null, costUsd: null }],
    } as unknown as RunRecord;
    writeRun("acme", "desk", live);
    await assert.rejects(async () => await rerunFrom("acme", "desk", "run-live", { agent: "a" }), /only a finished run/);

    live.status = "failed";
    live.steps[0].status = "failed";
    writeRun("acme", "desk", live);
    await assert.rejects(async () => await rerunFrom("acme", "desk", "run-live", { agent: "nope" }), /no step in run/);
  }));

// ------------------------------------------- orphaned steps never skipped

test("a step orphaned mid-run is re-run, not stepped over", async () =>
  await withWorkspace(async () => {
    // The deploy-mid-run shape: the driver died while step 1 was running,
    // recovery re-queued the job, and the next drive must not treat the
    // half-done step as finished work.
    const run = {
      id: "run-orphan", flow: "f", status: "running",
      startedAt: "2026-08-26T00:00:00.000Z", finishedAt: null,
      steps: [{
        agent: "missing-agent", instruction: "x", group: 1, optional: false,
        status: "running", events: [], result: null, costUsd: null,
      }],
    } as unknown as RunRecord;
    writeRun("acme", "desk", run);

    // The agent doesn't exist, so the re-run fails fast — the point is that
    // the step was picked up at all instead of skipped as already-running.
    await driveRun("acme", "desk", run, null, [], { parkOnApproval: true });
    const after = readRun("acme", "desk", "run-orphan")!;
    assert.equal(after.status, "failed");
    assert.ok(
      after.steps[0].events.some((e) => e.text.includes("interrupted mid-step")),
      "the orphan was noticed and restarted rather than stepped over",
    );
  }));

// ------------------------------------------------------- stop and delete

test("stopping a run drops its job, skips the rest, and says who did it", async () =>
  await withWorkspace(async () => {
    const run = await enqueueFlowRun("acme", "desk", [
      { agent: "writer", instruction: "one", group: 1, optional: false },
      { agent: "writer", instruction: "two", group: 2, optional: false },
    ], "twostep");
    // Mid-flight: step one finished, step two is running.
    const live = readRun("acme", "desk", run.id)!;
    live.status = "running";
    live.steps[0].status = "completed";
    live.steps[0].result = "did one";
    live.steps[0].costUsd = 0.4;
    live.steps[1].status = "running";
    writeRun("acme", "desk", live);

    const stopped = stopRun("acme", "desk", run.id);
    assert.equal(stopped.status, "failed");
    assert.equal(stopped.stopRequested, true);
    // What ran is kept — it ran, and the ledger already knows.
    assert.equal(stopped.steps[0].status, "completed");
    assert.equal(stopped.steps[0].costUsd, 0.4);
    // What hadn't finished is skipped with a reason, not silently dropped.
    assert.equal(stopped.steps[1].status, "skipped");
    assert.equal(stopped.steps[1].skipReason, "run stopped");
    // And nothing is left for a worker to pick up.
    assert.equal(await claimNext(), null);
    // Its worker settles it when the drive sees the stop; the stop does not,
    // or the killed step's cost would land after the run's one line closed.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await readLedger("acme")).filter((e) => e.kind === "run").length, 0);
  }));

test("stopping a parked run bills the steps it already finished", async () =>
  await withWorkspace(async () => {
    process.env.FOLDRUN_MARGIN = "1";
    try {
      const run = await enqueueFlowRun("acme", "desk", [
        { agent: "writer", instruction: "one", group: 1, optional: false },
        { agent: "writer", instruction: "two", group: 2, optional: false, approve: true },
      ], "gated");
      // Parked at the gate: step one ran and cost something, the worker gave
      // its slot back, and no job is left for anyone to settle it from.
      const parked = readRun("acme", "desk", run.id)!;
      parked.status = "awaiting-approval";
      parked.parkedAt = new Date().toISOString();
      parked.steps[0].status = "completed";
      parked.steps[0].costUsd = 0.4;
      parked.steps[1].status = "awaiting-approval";
      writeRun("acme", "desk", parked);
      fs.rmSync(pendingDir(), { recursive: true, force: true });

      stopRun("acme", "desk", run.id);
      let lines: Awaited<ReturnType<typeof readLedger>> = [];
      for (let i = 0; i < 50 && !lines.some((e) => e.kind === "run"); i++) {
        await new Promise((r) => setTimeout(r, 10));
        lines = await readLedger("acme");
      }
      const charged = lines.filter((e) => e.kind === "run");
      assert.equal(charged.length, 1, "the finished step is billed");
      assert.equal(charged[0].runId, run.id);
      assert.equal(charged[0].usd, -0.4);
      // And again is nothing: settling is once per run.
      assert.equal(await settleRun("acme", "desk", run.id), null);
      assert.equal((await readLedger("acme")).filter((e) => e.kind === "run").length, 1);
    } finally {
      delete process.env.FOLDRUN_MARGIN;
    }
  }));

// The flow loop holds the run in memory for as long as a group takes, while
// stopRun writes the stop to the record from another process. The loop's save
// used to overwrite `stopRequested`, and its between-groups check then read
// back the value it had just erased — so a run stopped mid-group ran on to the
// end of the flow. On 2026-09-03 that published to five live Google Business
// Profiles 73 minutes after the stop had been accepted.
test("a stop survives a save by the loop that is still running", async () =>
  await withWorkspace(async () => {
    const run = await enqueueFlowRun("acme", "desk", [
      { agent: "writer", instruction: "x", group: 1, optional: false },
    ], "one");

    // What the loop is holding: a copy taken before the stop existed.
    const inMemory = readRun("acme", "desk", run.id)!;
    inMemory.status = "running";

    stopRun("acme", "desk", run.id);

    // The loop reaches the end of its group and saves its own copy. That copy
    // knows nothing about the stop, so a plain write would erase it.
    const save = () => {
      if (!inMemory.stopRequested && readRun("acme", "desk", run.id)?.stopRequested) {
        inMemory.stopRequested = true;
      }
      writeRun("acme", "desk", inMemory);
    };
    save();

    assert.equal(
      readRun("acme", "desk", run.id)!.stopRequested,
      true,
      "the loop's own save must not erase a stop that arrived mid-group",
    );
  }));

test("a finished run cannot be stopped", async () =>
  await withWorkspace(async () => {
    const run = await enqueueFlowRun("acme", "desk", [
      { agent: "writer", instruction: "x", group: 1, optional: false },
    ], "one");
    const done = readRun("acme", "desk", run.id)!;
    done.status = "completed";
    writeRun("acme", "desk", done);
    assert.throws(() => stopRun("acme", "desk", run.id), /already completed/);
  }));

test("deleting a run erases its record and its archived outputs", async () =>
  await withWorkspace(async () => {
    const run = await enqueueFlowRun("acme", "desk", [
      { agent: "writer", instruction: "x", group: 1, optional: false },
    ], "one");
    const archive = path.join(
      process.env.FOLDRUN_DATA!, "acme/workspaces/desk/runs", run.id, "outputs/writer",
    );
    fs.mkdirSync(archive, { recursive: true });
    fs.writeFileSync(path.join(archive, "draft.md"), "kept nowhere else");

    assert.equal(deleteRun("acme", "desk", run.id), true);
    assert.equal(readRun("acme", "desk", run.id), null);
    assert.equal(fs.existsSync(archive), false);
    // Deleting what is already gone is not an error worth throwing over.
    assert.equal(deleteRun("acme", "desk", run.id), false);
  }));

test("a stopped run displays as stopped, a broken one as failed", async () =>
  await withWorkspace(async () => {
    const base = {
      id: "run-x", flow: "f", startedAt: "2026-08-26T00:00:00.000Z", finishedAt: null, steps: [],
    };
    assert.equal(runDisplayStatus({ ...base, status: "failed", stopRequested: true } as RunRecord), "stopped");
    assert.equal(runDisplayStatus({ ...base, status: "failed" } as RunRecord), "failed");
    assert.equal(runDisplayStatus({ ...base, status: "completed", stopRequested: true } as RunRecord), "completed");
  }));

test("startFlowFromStep skips the earlier groups, whole groups at a time", async () =>
  await withWorkspace(async () => {
    // Group numbers, not array indices: step 2 is two parallel agents, and
    // starting "from step 2" must keep both of them.
    fs.mkdirSync(path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk/flows"), { recursive: true });
    fs.writeFileSync(
      path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk/flows/pipeline.md"),
      "---\nname: pipeline\n---\n\n1. [[writer]] — fetch\n2. [[writer]] — clean\n2. [[writer]] — dedupe\n3. [[writer]] — send\n",
    );
    const run = await startFlowFromStep("acme", "desk", "pipeline", 2);
    assert.equal(run.status, "queued");
    assert.deepEqual(
      run.steps.map((s) => s.status),
      ["skipped", "pending", "pending", "pending"],
    );
    assert.equal(run.steps[0].skipReason, "started from step 2");
    // The job is real: a worker can claim it.
    assert.equal(pendingJobs().length, 1);
    await assert.rejects(async () => await startFlowFromStep("acme", "desk", "pipeline", 9), /has no step 9/);
  }));

test("overlap: is parsed from flow frontmatter, and only its two words count", async () =>
  await withWorkspace(async () => {
    const flowsDir = path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk/flows");
    fs.mkdirSync(flowsDir, { recursive: true });
    fs.writeFileSync(path.join(flowsDir, "a.md"), "---\nname: a\noverlap: skip\n---\n\n1. [[writer]] — go\n");
    fs.writeFileSync(path.join(flowsDir, "b.md"), "---\nname: b\noverlap: sideways\n---\n\n1. [[writer]] — go\n");
    const flows = listFlows("acme", "desk");
    assert.equal(flows.find((f) => f.name === "a")!.overlap, "skip");
    assert.equal(flows.find((f) => f.name === "b")!.overlap, null);
  }));

test("flowHasLiveRun sees queued, running and parked runs — not finished ones", async () =>
  await withWorkspace(async () => {
    const run = await enqueueFlowRun("acme", "desk", [STEP], "pipeline", null);
    assert.equal(flowHasLiveRun("acme", "desk", "pipeline"), true);
    assert.equal(flowHasLiveRun("acme", "desk", "other"), false);
    const record = readRun("acme", "desk", run.id)!;
    record.status = "completed";
    writeRun("acme", "desk", record);
    assert.equal(flowHasLiveRun("acme", "desk", "pipeline"), false);
  }));

test("a wait: parks the run in the queue with a deadline, and the queue honours it", async () =>
  await withWorkspace(async () => {
    // A flow whose FIRST step waits — parks before any model could be
    // needed, which is what makes this testable without one.
    const run = await enqueueFlowRun(
      "acme",
      "desk",
      [{ ...STEP, waitSecs: 3600 }],
      "drip",
      null,
    );
    const claim = (await claimNext())!;
    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!, null, [], { parkOnApproval: true });

    const parked = readRun("acme", "desk", run.id)!;
    assert.equal(parked.status, "queued", "waiting is queued, not failed");
    assert.ok(parked.parkedAt, "the slot was handed back");
    assert.ok(parked.steps[0].waitUntil, "the deadline is stamped on the record");
    const until = new Date(parked.steps[0].waitUntil!).getTime();
    assert.ok(until > Date.now() + 3500 * 1000, "roughly an hour out");

    // Re-enqueue with the deadline, the way the worker does.
    await claim.release(); // the job is finished with, whichever store held it
    await enqueueResume("acme", "desk", run.id);
    const pending = pendingDir();
    const jobFile = fs.readdirSync(pending).find((f) => f.includes(run.id))!;
    const job = JSON.parse(fs.readFileSync(path.join(pending, jobFile), "utf8"));
    fs.writeFileSync(
      path.join(pending, jobFile),
      JSON.stringify({ ...job, notBefore: parked.steps[0].waitUntil }),
    );
    assert.equal(await claimNext(), null, "an unexpired notBefore is not claimable");

    // The deadline passing makes it claimable again.
    fs.writeFileSync(
      path.join(pending, jobFile),
      JSON.stringify({ ...job, notBefore: new Date(Date.now() - 1000).toISOString() }),
    );
    const reclaimed = await claimNext();
    assert.ok(reclaimed, "an expired notBefore claims normally");
    await reclaimed!.release();
  }));

test("ask: parks like an approval and the answer rides the record", async () =>
  await withWorkspace(async () => {
    const run = await enqueueFlowRun(
      "acme",
      "desk",
      [{ ...STEP, ask: "Formal or friendly?" }],
      "drafting",
      null,
    );
    const claim = (await claimNext())!;
    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!, null, [], { parkOnApproval: true });
    await claim.release(); // the job is finished with, whichever store held it

    const parked = readRun("acme", "desk", run.id)!;
    assert.equal(parked.status, "awaiting-approval");
    assert.match(
      parked.steps[0].events.map((e) => e.text).join("\n"),
      /waiting for an answer: Formal or friendly\?/,
    );
  }));

test("the worker lease: one holder, stale takeover, and a peek that never writes", async () =>
  await withWorkspace(async () => {
    const lease = path.join(process.env.FOLDRUN_DATA!, ".worker-lease");

    assert.equal(await peekWorkerLease(), false, "peek before any lease exists");
    assert.ok(!fs.existsSync(lease), "and peeking wrote nothing");

    assert.equal(await holdsWorkerLease(), true, "an unclaimed lease is taken");
    assert.equal(await peekWorkerLease(), true, "and peek now sees our ownership");
    assert.equal(await holdsWorkerLease(), true, "the holder renews freely");

    // A fresh lease held by someone else blocks us from CLAIMING — but the
    // peek still reports a live worker, because that is the operational
    // question a probe asks (and module identity doesn't survive bundling).
    fs.writeFileSync(lease, JSON.stringify({ owner: "other-worker", renewedAt: Date.now() }));
    assert.equal(await holdsWorkerLease(), false, "a live foreign lease is respected");
    assert.equal(await peekWorkerLease(), true, "a live worker exists — whoever it is");
    assert.equal(await peekWorkerLease(Date.now() + 120_000), false, "a stale lease is no worker");

    // …until it goes stale, and then it's claimable.
    fs.writeFileSync(lease, JSON.stringify({ owner: "other-worker", renewedAt: Date.now() - 120_000 }));
    assert.equal(await holdsWorkerLease(), true, "a stale lease is taken over");
  }));

test("queueStats separates ready, scheduled-ahead and claimed", async () =>
  await withWorkspace(async () => {
    await enqueueFlowRun("acme", "desk", [STEP], "a", null);
    await enqueueFlowRun("acme", "desk", [STEP], "b", null);
    // Push one job's deadline into the future, the way a wait: does.
    const pending = pendingDir();
    const name = fs.readdirSync(pending).filter((f) => f.endsWith(".json"))[0];
    const job = JSON.parse(fs.readFileSync(path.join(pending, name), "utf8"));
    fs.writeFileSync(
      path.join(pending, name),
      JSON.stringify({ ...job, notBefore: new Date(Date.now() + 60_000).toISOString() }),
    );
    const claimed = await claimNext(); // claims the OTHER job (deadline is skipped)
    assert.ok(claimed);

    const stats = await queueStats();
    assert.equal(stats.pending, 0, "the ready job was claimed");
    assert.equal(stats.scheduledAhead, 1, "the deadline job is scheduled, not late");
    assert.equal(stats.claimed, 1);
    assert.equal(stats.oldestPendingSecs, null, "nothing ready means no age to report");
    await claimed!.release();
  }));

// ---------------------------------------------------------- fair scheduling
//
// A plain FIFO is correct for one account and wrong the moment there are two.
// The case that matters is the one a customer notices: someone else enqueued a
// backlog first, and now your single job is behind all of it.

test("one account's backlog does not put another account behind all of it", async () => {
  // 'bulk' enqueues 100 jobs, then 'small' enqueues 1. Under FIFO the small
  // account waits for 100 runs; under fair ordering it waits for one.
  const entries: { name: string; tenant: string }[] = [];
  for (let i = 0; i < 100; i++) {
    entries.push({ name: `${String(1000 + i).padStart(14, "0")}-run-bulk${i}.json`, tenant: "bulk" });
  }
  entries.push({ name: `${String(9999).padStart(14, "0")}-run-small.json`, tenant: "small" });

  const order = fairOrder(entries);
  const smallAt = order.findIndex((n) => n.includes("run-small"));
  assert.equal(order.length, 101, "every job is still scheduled, none dropped");
  assert.ok(
    smallAt <= 1,
    `the quiet account should be served in the first round, was position ${smallAt}`,
  );
});

test("within one account it is still first come, first served", async () => {
  const entries = [3, 1, 2].map((i) => ({
    name: `${String(i).padStart(14, "0")}-run-${i}.json`,
    tenant: "solo",
  }));
  const order = fairOrder(entries);
  assert.deepEqual(
    order.map((n) => n.split("-run-")[1]),
    ["1.json", "2.json", "3.json"],
    "one account keeps strict arrival order",
  );
});

test("accounts are taken in the order their oldest job arrived, not alphabetically", async () => {
  // 'zeta' was waiting first; fairness must not hand 'alpha' the front of the
  // queue for having an earlier name.
  const order = fairOrder([
    { name: "00000000000001-run-z1.json", tenant: "zeta" },
    { name: "00000000000002-run-a1.json", tenant: "alpha" },
  ]);
  assert.equal(order[0], "00000000000001-run-z1.json");
});

test("a single account is unchanged by fair ordering", async () => {
  const names = ["00000000000001-run-a.json", "00000000000002-run-b.json"];
  const order = fairOrder(names.map((name) => ({ name, tenant: "one" })));
  assert.deepEqual(order, names, "the common case is exactly FIFO");
});

test("a wait: hands the job back BEFORE the claim is released, and it survives that", async () =>
  await withWorkspace(async () => {
    // The worker's real order: park → hand back with the deadline → finally
    // releases the claim. The older test released first and then
    // re-enqueued, which is not the order the loop runs in — and on the
    // table store that order was the bug: enqueue's "already lined up" guard
    // saw the worker's own claim, did nothing, and release deleted the row.
    const run = await enqueueFlowRun("acme", "desk", [{ ...STEP, waitSecs: 3600 }], "drip", null);
    const claim = (await claimNext())!;
    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!, null, [], { parkOnApproval: true });
    const parked = readRun("acme", "desk", run.id)!;
    assert.equal(parked.status, "queued");

    await enqueueResume("acme", "desk", run.id); // hand back, claim still held
    await claim.release(); //                       then the finally lets go
    const pending = fs.readdirSync(pendingDir()).filter((f) => f.includes(run.id));
    assert.equal(pending.length, 1, "exactly one pending job remains after the release");
    const claimedDir = path.join(process.env.FOLDRUN_DATA!, "queue/claimed");
    const claimed = fs.existsSync(claimedDir) ? fs.readdirSync(claimedDir).filter((f) => f.includes(run.id)) : [];
    assert.equal(claimed.length, 0, "and no claimed one");
  }));


// ── a dead worker's claims come back at once ────────────────────────────────

test("a claim is dead when its host's lease is gone or held by someone else, never when it is ours", async () => {
  const { claimOwnerDead } = await import("../src/queue.ts");
  const me = "podA:11-abc";
  assert.equal(claimOwnerDead("podA:11-abc", "podA:11-abc", me), false, "our own claim");
  assert.equal(claimOwnerDead("podB:22-def", "podB:22-def", me), false, "a peer that still holds its lease");
  assert.equal(claimOwnerDead("podB:22-def", null, me), true, "lease gone: the pod is dead");
  assert.equal(claimOwnerDead("podB:22-def", "podB:33-xyz", me), true, "same hostname, new process: the old one is dead");
  assert.equal(claimOwnerDead("11-abc", null, me), false, "an old-shape owner with no hostname is left to the stale window");
  assert.equal(claimOwnerDead(null, null, me), false, "unclaimed");
  // A claim carries its own token after the worker's name; the worker is what lives or dies.
  assert.equal(claimOwnerDead(`${me}/7`, null, me), false, "our own claim, by its token");
  assert.equal(claimOwnerDead("podB:22-def/3", "podB:22-def", me), false, "a live peer's claim");
  assert.equal(claimOwnerDead("podB:22-def/3", null, me), true, "a dead peer's claim");
});

// A rerun copied every record after the chosen step, on-fail rescues
// included, as pending work: blog-desk run-mvho48lc-l1cd (21 Oct 2026)
// started with 77 fixers pending. The rescues also made the record's step
// count differ from the flow's, so the reset steps lost the flow's options.
for (const [label, marked] of [["marked with rescueOf", true], ["old-format, by its <rescue> block", false]] as const) {
  test(`a re-run drops on-fail rescues (${label}) and takes fresh options again`, async () =>
    await withWorkspace(async () => {
      const ws = path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk");
      fs.mkdirSync(path.join(ws, "flows"), { recursive: true });
      fs.writeFileSync(
        path.join(ws, "flows/send.md"),
        "---\nname: send\n---\n\n1. [[writer]] — write it\n2. [[writer]] — check it\n   verify: contains: OK\n   on-fail: [[writer]]\n3. [[writer]] — send it\n",
      );
      const rescue = (n: number) => ({
        agent: "writer", group: 2, optional: false, status: n === 0 ? "failed" : "pending", events: [], result: null, costUsd: 0,
        instruction: "check it\n\n<rescue>\nYou are taking this step over: [[writer]] attempted it and failed. Its failure:\nboom\n</rescue>",
        ...(marked ? { rescueOf: "writer" } : {}),
      });
      writeRun("acme", "desk", {
        id: "run-rescued", flow: "send", status: "failed",
        startedAt: "2026-10-21T00:00:00.000Z", finishedAt: "2026-10-21T00:10:00.000Z",
        steps: [
          { agent: "writer", instruction: "write it", group: 1, optional: false, status: "completed", events: [], result: "done", costUsd: 0.1 },
          { agent: "writer", instruction: "check it (old wording)", group: 2, optional: false, status: "failed", events: [], result: null, costUsd: 0.01 },
          rescue(0), rescue(1), rescue(2),
          { agent: "writer", instruction: "send it", group: 3, optional: false, status: "skipped", events: [], result: null, costUsd: 0 },
        ],
      } as unknown as RunRecord);

      const rerun = await rerunFrom("acme", "desk", "run-rescued", { step: 2 });
      assert.deepEqual(rerun.steps.map((s) => s.instruction), ["write it", "check it", "send it"], "no rescue copied, and the flow's words are back");
      assert.equal(rerun.steps.filter((s) => s.status === "pending").length, 2);
      assert.equal(rerun.steps[1].verify, "contains: OK", "the fresh options came from the flow");
      assert.equal(rerun.steps[1].onFail, "writer");
      // A rescue cannot be the step a re-run starts from.
      await assert.rejects(async () => await rerunFrom("acme", "desk", "run-rescued", { step: 3 }), /on-fail rescue/);
    }));
}

// sandbox: own jobs sit at the end of the record. A re-run carries a carried
// step's jobs with it, and gives a reset step none of the source run's.
test("a re-run carries a carried step's jobs, and a reset step starts with no delegations", async () =>
  await withWorkspace(async () => {
    const ws = path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "flows"), { recursive: true });
    fs.writeFileSync(path.join(ws, "flows/two.md"), "---\nname: two\n---\n\n1. [[writer]] — draft\n2. [[editor]] — edit\n");
    const job = (id: string, of: string) => ({ agent: "reader", subagentOf: of, delegation: id, instruction: "read", group: 1, optional: true, status: "completed", events: [], result: "notes", costUsd: 0.02 });
    writeRun("acme", "desk", {
      id: "run-deleg", flow: "two", status: "failed",
      startedAt: "2026-10-22T00:00:00.000Z", finishedAt: "2026-10-22T00:10:00.000Z",
      steps: [
        { agent: "writer", instruction: "draft", group: 1, optional: false, status: "completed", events: [], result: "draft", costUsd: 0.1, delegations: [{ id: "d_w", agent: "reader", status: "completed" }] },
        { agent: "editor", instruction: "edit", group: 2, optional: false, status: "failed", events: [], result: null, costUsd: 0.1, delegations: [{ id: "d_e", agent: "reader", status: "completed" }] },
        job("d_w", "writer"),
        job("d_e", "editor"),
      ],
    } as unknown as RunRecord);
    const rerun = await rerunFrom("acme", "desk", "run-deleg", { step: 2 });
    assert.deepEqual(rerun.steps.map((s) => s.agent), ["writer", "editor", "reader"]);
    assert.equal(rerun.steps[2].delegation, "d_w", "the carried writer's job came with it");
    assert.equal(rerun.steps[2].carriedFrom, "run-deleg");
    assert.equal(rerun.steps[1].delegations, undefined, "the reset editor starts with none");
    assert.equal(rerun.steps[0].delegations?.[0].id, "d_w");
    await assert.rejects(async () => await rerunFrom("acme", "desk", "run-deleg", { step: 3 }), /a job writer handed to reader/);
  }));

test("a second stop says the run is already failed, even after the driver saved", async () =>
  await withWorkspace(async () => {
    const run = await enqueueFlowRun("acme", "desk", [
      { agent: "writer", instruction: "x", group: 1, optional: false },
      { agent: "writer", instruction: "y", group: 1, optional: false },
    ], "two");
    const inMemory = readRun("acme", "desk", run.id)!;
    inMemory.status = "running";
    inMemory.steps[0].status = "running";
    writeRun("acme", "desk", inMemory);
    stopRun("acme", "desk", run.id);
    assert.throws(() => stopRun("acme", "desk", run.id), /already failed/);
  }));

// 27 Oct 2026: a run parked for room goes back to the queue to look again
// after FOLDRUN_ROOM_RECHECK_SEC — or sooner, at an earlier wait: deadline.
test("a run parked for room is claimed again after the recheck, a wait: deadline wins when sooner", () => {
  const now = Date.parse("2026-10-27T00:00:00Z");
  const step = (extra: Record<string, unknown>) => ({ agent: "a", instruction: "", group: 1, optional: false, status: "pending", events: [], result: null, ...extra });
  const room = { roomWait: { since: "2026-10-26T23:00:00Z", why: "full", cpus: 1, memGiB: 1 } };
  const prev = process.env.FOLDRUN_ROOM_RECHECK_SEC;
  delete process.env.FOLDRUN_ROOM_RECHECK_SEC;
  try {
    const parked = { status: "queued", parkedAt: "2026-10-27T00:00:00Z", steps: [step(room)] } as unknown as RunRecord;
    assert.equal(parkedNotBefore(parked, now), "2026-10-27T00:00:20.000Z", "20 s by default");
    process.env.FOLDRUN_ROOM_RECHECK_SEC = "45";
    assert.equal(parkedNotBefore(parked, now), "2026-10-27T00:00:45.000Z");
    const both = { ...parked, steps: [step(room), step({ waitUntil: "2026-10-27T00:00:10Z" })] } as unknown as RunRecord;
    assert.equal(parkedNotBefore(both, now), "2026-10-27T00:00:10.000Z", "the sooner of the two");
    assert.equal(parkedNotBefore({ ...parked, parkedAt: null } as unknown as RunRecord, now), null, "not parked: none");
    assert.equal(parkedNotBefore({ ...parked, steps: [step({})] } as unknown as RunRecord, now), null, "parked on a gate: it waits for its answer");
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_ROOM_RECHECK_SEC;
    else process.env.FOLDRUN_ROOM_RECHECK_SEC = prev;
  }
});
