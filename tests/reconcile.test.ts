// Closing out runs abandoned by a process that is gone.
//
// Runs execute in the server process and nothing writes a terminal status when
// that process goes away, so a deploy or a crash mid-run left `running` on
// disk forever. Those entries are not stale, they are false: the dashboard
// renders them as live and nothing distinguishes them from a step that is
// genuinely still thinking.
//
//   node --test tests/reconcile.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reconcileRuns, reconcileAllRuns, drivingRuns } from "../../foldrun-core/src/runner.ts";
import { listTenants } from "../../foldrun-core/src/store.ts";

const HOUR = 60 * 60 * 1000;

/** A workspace with one run on disk, and core pointed at it. */
function withRun(run: unknown, body: (now: number) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-reconcile-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    fs.writeFileSync(
      path.join(ws, "runs", `${(run as { id: string }).id}.json`),
      JSON.stringify(run, null, 2),
    );
    body(Date.now());
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const read = (id: string) => {
  const f = path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk/runs", `${id}.json`);
  return JSON.parse(fs.readFileSync(f, "utf8"));
};

const step = (agent: string, status: string, at?: number) => ({
  agent,
  instruction: "do the thing",
  group: 1,
  optional: false,
  status,
  events: at ? [{ t: new Date(at).toISOString(), type: "text", text: "working" }] : [],
  result: null,
  costUsd: null,
});

test("an abandoned run is closed, and says why", () => {
  const started = Date.now() - 3 * HOUR;
  withRun(
    {
      id: "r1",
      flow: "publish",
      status: "running",
      startedAt: new Date(started).toISOString(),
      finishedAt: null,
      steps: [step("writer", "completed", started), step("checker", "running", started)],
    },
    (now) => {
      const closed = reconcileRuns("acme", now);
      assert.equal(closed.length, 1);
      assert.deepEqual(closed[0].interrupted, ["checker"]);

      const run = read("r1");
      assert.equal(run.status, "failed");
      assert.ok(run.finishedAt, "a closed run must have an end");
      assert.equal(run.steps[0].status, "completed", "finished work is not rewritten");
      assert.equal(run.steps[1].status, "failed");
      assert.match(
        run.steps[1].events.at(-1).text,
        /went away before it finished/,
        "the trace must say what happened, not just that it failed",
      );
    },
  );
});

test("steps that never started are skipped, not failed", () => {
  // They did not fail — nothing ran them. Saying "failed" would send someone
  // looking for a defect in an agent that was never invoked.
  const started = Date.now() - 3 * HOUR;
  withRun(
    {
      id: "r2",
      flow: "publish",
      status: "running",
      startedAt: new Date(started).toISOString(),
      finishedAt: null,
      steps: [step("writer", "running", started), step("checker", "pending")],
    },
    (now) => {
      reconcileRuns("acme", now);
      const run = read("r2");
      assert.equal(run.steps[1].status, "skipped");
      assert.match(run.steps[1].skipReason, /interrupted before this step started/);
    },
  );
});

test("a run with recent activity is left alone", () => {
  // The protection is an idle window, not a lock, so this has to be safe to
  // call while real runs are in flight — a slow model call is not a dead one.
  const started = Date.now() - 3 * HOUR;
  withRun(
    {
      id: "r3",
      flow: "publish",
      status: "running",
      startedAt: new Date(started).toISOString(),
      finishedAt: null,
      steps: [step("writer", "running", Date.now() - 60_000)], // a minute ago
    },
    (now) => {
      assert.deepEqual(reconcileRuns("acme", now), []);
      assert.equal(read("r3").status, "running");
    },
  );
});

test("awaiting-approval survives a restart untouched", () => {
  // Waiting for a person legitimately outlives any process. This is the one
  // status that must not be reconciled away.
  const started = Date.now() - 5 * HOUR;
  withRun(
    {
      id: "r4",
      flow: "sign-off",
      status: "awaiting-approval",
      startedAt: new Date(started).toISOString(),
      finishedAt: null,
      steps: [step("publisher", "awaiting-approval", started)],
    },
    (now) => {
      assert.deepEqual(reconcileRuns("acme", now), []);
      const run = read("r4");
      assert.equal(run.status, "awaiting-approval");
      assert.equal(run.steps[0].status, "awaiting-approval");
    },
  );
});

test("finished runs are never touched", () => {
  const started = Date.now() - 5 * HOUR;
  for (const status of ["completed", "failed"]) {
    withRun(
      {
        id: `r-${status}`,
        flow: "publish",
        status,
        startedAt: new Date(started).toISOString(),
        finishedAt: new Date(started + 1000).toISOString(),
        steps: [step("writer", status === "completed" ? "completed" : "failed", started)],
      },
      (now) => {
        assert.deepEqual(reconcileRuns("acme", now), []);
        assert.equal(read(`r-${status}`).status, status);
      },
    );
  }
});

// The bug this pair of tests exists for: the server reconciled the account it
// was named after, and every other account's interrupted runs stayed `running`
// on disk forever — the exact false state the whole mechanism exists to
// prevent, restored for everyone but the first customer.
test("every account is reconciled, not just one", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-tenants-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  const started = Date.now() - 3 * HOUR;
  try {
    for (const tenant of ["acme", "globex"]) {
      const ws = path.join(root, tenant, "workspaces/desk");
      fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
      fs.writeFileSync(
        path.join(ws, "runs", "r1.json"),
        JSON.stringify({
          id: "r1",
          flow: "publish",
          status: "running",
          startedAt: new Date(started).toISOString(),
          finishedAt: null,
          steps: [step("writer", "running", started)],
        }),
      );
    }
    // Things that live beside accounts but are not accounts.
    fs.mkdirSync(path.join(root, ".runtimes"), { recursive: true });
    fs.writeFileSync(path.join(root, "keys.json"), "{}\n");

    const closed = reconcileAllRuns(Date.now());
    assert.deepEqual(
      closed.map((c) => `${c.tenant}/${c.workspace}/${c.runId}`).sort(),
      ["acme/desk/r1", "globex/desk/r1"],
      "a second account's interrupted run was left running",
    );
    for (const tenant of ["acme", "globex"]) {
      const f = path.join(root, tenant, "workspaces/desk/runs/r1.json");
      assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).status, "failed");
    }
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Enumerating accounts means reading the data root, which holds more than
// accounts. Counting `.runtimes/` as one would send reconciliation walking a
// cache directory, and `assertSafeName` would throw on the dot before it got
// anywhere useful.
test("only directories that hold workspaces count as accounts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-tenants-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    fs.mkdirSync(path.join(root, "acme/workspaces/desk"), { recursive: true });
    fs.mkdirSync(path.join(root, "legacy/projects/desk"), { recursive: true }); // pre-rename
    fs.mkdirSync(path.join(root, "half-set-up"), { recursive: true }); // no workspaces yet
    fs.mkdirSync(path.join(root, ".runtimes"), { recursive: true });
    fs.writeFileSync(path.join(root, "schedule.json"), "{}\n");

    assert.deepEqual(listTenants(), ["acme", "legacy"]);
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Reconciliation used to happen only when the server booted, which assumed the
// only way to abandon a run was for the process to die. A run was found five
// hours idle and still rendering as live in a server that had never restarted:
// the step stopped emitting, the process carried on serving pages, and nothing
// was ever going to close it. So the scheduler sweeps too.
test("the scheduler closes abandoned runs without a restart", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-sweep-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  const started = Date.now() - 3 * HOUR;
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, "runs", "r1.json"),
      JSON.stringify({
        id: "r1",
        flow: "publish",
        status: "running",
        startedAt: new Date(started).toISOString(),
        finishedAt: null,
        steps: [step("writer", "running", started)],
      }),
    );

    const { tick, resetCatalogue, RECONCILE_EVERY } = await import("../src/scheduler.ts");
    resetCatalogue(); // this test's disk, not an earlier test's catalogue
    const status = () =>
      JSON.parse(fs.readFileSync(path.join(ws, "runs/r1.json"), "utf8")).status;

    // The sweep is deliberately slower than the tick — it reads every run file
    // — so the first ticks must leave the run alone. The tick is async now
    // (the catalogue may pop dirty marks from Redis), so each is awaited.
    await tick(new Date());
    assert.equal(status(), "running", "a sweep on every tick would read every run file every 30s");

    for (let i = 1; i < RECONCILE_EVERY; i++) await tick(new Date());
    assert.equal(status(), "failed", "the sweep never fired");
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Approved, then abandoned — the state with no way out.
//
// Approval only writes to the run record; the loop that acts on it polls in
// memory, inside the process that started the run. Lose that process between
// the click and the next poll and the decision sits on disk with nobody to
// read it. The run then holds `awaiting-approval` with no step awaiting
// approval, so the dashboard cannot offer the button again — and this status
// is deliberately exempt from being closed, so nothing rescued it either.
// Observed live: a run stuck four minutes after a person clicked Approve.
test("a run whose approval was granted, then abandoned, is picked back up", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-resume-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  const started = Date.now() - 3 * HOUR;
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
    const approved = step("publisher", "pending", started);
    // The shape the approval API leaves behind: no longer asking, and a record
    // that someone answered.
    (approved as Record<string, unknown>).approve = true;
    (approved as Record<string, unknown>).approvedAt = new Date(started).toISOString();
    fs.writeFileSync(
      path.join(ws, "runs", "r1.json"),
      JSON.stringify({
        id: "r1",
        flow: "publish",
        status: "awaiting-approval",
        startedAt: new Date(started).toISOString(),
        finishedAt: null,
        steps: [step("writer", "completed", started), approved],
      }),
    );

    const out = reconcileAllRuns(Date.now());
    assert.deepEqual(
      out.map((c) => c.action),
      ["resumed"],
      "an answered run was not resumed",
    );

    // Resuming means the loop was re-entered, and the loop reaches a verdict:
    // this workspace has no `publisher` agent on disk, so it must say so and
    // finish rather than sit in a status nobody can act on.
    const read1 = () => JSON.parse(fs.readFileSync(path.join(ws, "runs/r1.json"), "utf8"));
    for (let i = 0; i < 100 && read1().status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const run = read1();
    assert.notEqual(run.status, "awaiting-approval", "the run went back to being stuck");
    assert.equal(run.status, "failed");
    assert.match(
      run.steps[1].events.at(-1).text,
      /not found in workspace/,
      "the resumed run should reach a real verdict, not another dead end",
    );
    assert.equal(run.steps[0].status, "completed", "finished work must survive a resume");
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The half of it that a behaviour test cannot reach: on resume, an already
// approved step must not be asked about again. `pending` is also what a step
// looks like before anyone was asked, so the gate has to read the decision
// itself — otherwise resuming a run means re-interrupting the same person.
test("the approval gate skips a step a person already approved", () => {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, "..", "..", "foldrun-core", "src", "runner.ts"),
    "utf8",
  );
  const gate = src.match(/const needsApproval = freshGroup\.filter\(([\s\S]*?)\);/);
  assert.ok(gate, "the approval gate should still be a filter over the group");
  assert.match(gate[1], /!s\.approvedAt/, "the gate must exclude steps already approved");
});

// And the code that writes it — shared by the dashboard route and the
// emailed link. Status alone cannot carry the decision: approving flips the
// step to `pending`, which is indistinguishable from never having been asked.
test("approving records that it happened, not just its effect", () => {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, "..", "..", "foldrun-core", "src", "approvals.ts"),
    "utf8",
  );
  assert.match(src, /s\.approvedAt = /, "approving must stamp approvedAt");
});

test("a run this process is driving is never abandoned, however quiet its step", () => {
  // A 40-minute script is work, not a fault. Reconcile asks who is driving,
  // not how long since the last event — the platform sets no clock on work.
  const started = Date.now() - 3 * HOUR;
  const id = "run-driving-1";
  drivingRuns.add(id);
  try {
    withRun(
      {
        id,
        flow: "publish",
        status: "running",
        startedAt: new Date(started).toISOString(),
        finishedAt: null,
        steps: [step("enricher", "running", started)], // silent for three hours
      },
      (now) => {
        assert.deepEqual(reconcileRuns("acme", now), []);
        assert.equal(read(id).status, "running");
      },
    );
  } finally {
    drivingRuns.delete(id);
  }
});

test("a run another worker pod holds is left alone, and one nobody holds is not", () => {
  // Two worker pods. This one boots, or its scheduler sweeps, beside a
  // neighbour driving a long quiet step. The neighbour's claim is renewed in
  // the queue; that set is what the sweep is handed, and what it must honour
  // — without it, every worker replica would close every other's long steps
  // two minutes in.
  const started = Date.now() - 3 * HOUR;
  withRun(
    {
      id: "run-elsewhere-1",
      flow: "publish",
      status: "running",
      startedAt: new Date(started).toISOString(),
      finishedAt: null,
      steps: [step("enricher", "running", started)],
    },
    (now) => {
      assert.deepEqual(reconcileRuns("acme", now, new Set(["run-elsewhere-1"])), [], "held elsewhere: not ours to close");
      assert.equal(read("run-elsewhere-1").status, "running");
      // The same run with no live claim anywhere is abandoned, as before.
      const closed = reconcileRuns("acme", now, new Set(["some-other-run"]));
      assert.equal(closed.length, 1);
      assert.equal(read("run-elsewhere-1").status, "failed");
    },
  );
});

test("a closed run is handed to onEnd once, so it is settled, told and chained", async () => {
  const seen: string[] = [];
  const started = Date.now() - 3 * HOUR;
  withRun(
    { id: "r-end", flow: "publish", status: "running", startedAt: new Date(started).toISOString(), finishedAt: null, steps: [step("writer", "running", started)] },
    (now) => {
      const onEnd = (t: string, w: string, id: string) => { seen.push(`${t}/${w}/${id}`); };
      reconcileRuns("acme", now, undefined, onEnd);
      reconcileRuns("acme", now, undefined, onEnd); // already closed: nothing again
    },
  );
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, ["acme/desk/r-end"]);
});
