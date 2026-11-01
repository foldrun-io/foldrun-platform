// One admission for every start (1 Nov 2026): `overlap: skip` read and the
// run lined up under one lock, so of two starts at once exactly one runs;
// the refusal leaves nothing behind; an A2A start carries its correlation on
// the record from the first write. No worker runs (nothing is driven).
//
//   node --test tests/flow-admission.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-admission-"));
process.env.FOLDRUN_DATA = DATA;
delete process.env.FOLDRUN_DATABASE_URL;
process.env.FOLDRUN_DISABLE_WORKER = "1";

const ws = path.join(DATA, "acme/workspaces/desk");
fs.mkdirSync(path.join(ws, "agents/writer"), { recursive: true });
fs.mkdirSync(path.join(ws, "flows"), { recursive: true });
fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
fs.writeFileSync(path.join(ws, "agents/writer/agent.md"), "---\nname: writer\ndescription: writes\n---\n\nWrite.\n");
fs.writeFileSync(path.join(ws, "flows/once.md"), "---\nname: once\noverlap: skip\n---\n\n1. [[writer]] — write\n");
fs.writeFileSync(path.join(ws, "flows/many.md"), "---\nname: many\n---\n\n1. [[writer]] — write\n2. [[writer]] — again\n");

const { admitFlowRun, AdmissionRefused, liveRunOf } = await import("../src/flow-admission.ts");
const Tasks = await import("../src/a2a-tasks.ts");
const { loadFlow } = await import("../../foldrun-core/src/runner.ts");
const { listRunSummaries, readRun } = await import("../../foldrun-core/src/store.ts");

test("overlap: skip — two starts at once, one run; the other is refused with its id", async () => {
  const flow = loadFlow("acme", "desk", "once")!;
  const results = await Promise.allSettled([admitFlowRun({ tenant: "acme", workspace: "desk", flow }), admitFlowRun({ tenant: "acme", workspace: "desk", flow })]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  assert.equal(ok.length, 1, "exactly one admitted");
  assert.equal(refused.length, 1);
  const err = refused[0]!.reason as InstanceType<typeof AdmissionRefused>;
  assert.ok(err instanceof AdmissionRefused);
  assert.equal(err.status, 409);
  assert.equal(err.code, "overlap");
  assert.equal(err.runId, (ok[0] as PromiseFulfilledResult<{ id: string }>).value.id);
  assert.equal(listRunSummaries("acme", "desk").filter((r) => r.flow === "once").length, 1, "the refusal created no run");
  assert.equal(liveRunOf("acme", "desk", "once"), err.runId);
});

test("without overlap: skip both go; a bad from and an empty flow are refused before anything", async () => {
  const flow = loadFlow("acme", "desk", "many")!;
  const two = await Promise.all([admitFlowRun({ tenant: "acme", workspace: "desk", flow }), admitFlowRun({ tenant: "acme", workspace: "desk", flow })]);
  assert.notEqual(two[0].id, two[1].id);
  await assert.rejects(admitFlowRun({ tenant: "acme", workspace: "desk", flow, from: 9 }), (e: unknown) => e instanceof AdmissionRefused && e.code === "bad-from" && e.status === 400);
  await assert.rejects(admitFlowRun({ tenant: "acme", workspace: "desk", flow: { ...flow, steps: [] } }), (e: unknown) => e instanceof AdmissionRefused && e.code === "no-steps");
  const fromTwo = await admitFlowRun({ tenant: "acme", workspace: "desk", flow, from: 2 });
  assert.equal(fromTwo.steps[0]!.status, "skipped");
});

test("an A2A start: trigger and task on the record, the steps as given, no person", async () => {
  const flow = loadFlow("acme", "desk", "many")!;
  const steps = flow.steps.map((s, i) => (i === 0 ? { ...s, instruction: `${s.instruction}\n\n<a2a_request>\nhi\n</a2a_request>` } : s));
  const run = await admitFlowRun({ tenant: "acme", workspace: "desk", flow, steps, a2a: { task: "task-1", key: "key-1" } });
  const saved = readRun("acme", "desk", run.id)!;
  assert.equal(saved.trigger, "a2a");
  assert.deepEqual(saved.a2a, { task: "task-1", key: "key-1" });
  assert.equal(saved.startedBy, undefined);
  assert.match(saved.steps[0]!.instruction, /<a2a_request>\nhi\n<\/a2a_request>$/);
  const row = listRunSummaries("acme", "desk").find((r) => r.id === run.id)!;
  assert.equal(row.trigger, "a2a");
  assert.deepEqual(row.a2a, { task: "task-1", key: "key-1" });
});

// The crash window (Codex review, 1 Nov 2026): the run is created — its
// record carries a2a.task from the first write — and the process dies (or
// the bind fails) before the task row records the run id. A null run_id is
// not "no run": the takeover after the stale window must find that run and
// bind it, and a second admission for the same task must return it.
test("a start that died after creating its run: the takeover binds that run and starts nothing", async () => {
  const flow = loadFlow("acme", "desk", "many")!;
  const old = new Date(Date.now() - 5 * 60_000);
  const { task } = await Tasks.claimA2aTask({ tenant: "acme", workspace: "desk", flow: "many", contextId: "c", callerKeyId: "k", messageId: "crash-1", fingerprint: "f", lastMessage: null }, old);
  // The first start: admitted, run created — then nothing (no bind).
  const first = await admitFlowRun({ tenant: "acme", workspace: "desk", flow, a2a: { task: task.id, key: "k" } });
  const runsOf = () => listRunSummaries("acme", "desk").filter((r) => r.a2a?.task === task.id).map((r) => r.id);
  assert.deepEqual(runsOf(), [first.id]);
  assert.equal((await Tasks.getA2aTask("acme", task.id))!.runId, null, "the row never learned its run");

  // The retry, after the stale window: no takeover — the run is found and bound.
  assert.equal(await Tasks.retakeA2aTask("acme", task.id, new Date(Date.now() - 60_000)), false);
  const after = (await Tasks.getA2aTask("acme", task.id))!;
  assert.equal(after.runId, first.id);
  assert.equal(after.state, "TASK_STATE_SUBMITTED");
  assert.equal(Tasks.runOfA2aTask("acme", "desk", task.id)!.id, first.id);

  // And admission is idempotent on the task: the same task id never gets a second run.
  const again = await admitFlowRun({ tenant: "acme", workspace: "desk", flow, a2a: { task: task.id, key: "k" } });
  assert.equal(again.id, first.id);
  const both = await Promise.all([1, 2].map(() => admitFlowRun({ tenant: "acme", workspace: "desk", flow, a2a: { task: "race-task", key: "k" } })));
  assert.equal(both[0].id, both[1].id, "two starts of one task at once: one run");
  assert.deepEqual(runsOf(), [first.id]);

  // A claim that truly died before any run: still taken over, once.
  const dead = await Tasks.claimA2aTask({ tenant: "acme", workspace: "desk", flow: "many", contextId: "c", callerKeyId: "k", messageId: "crash-2", fingerprint: "f", lastMessage: null }, old);
  assert.equal(await Tasks.retakeA2aTask("acme", dead.task.id, new Date(Date.now() - 60_000)), true);
  assert.equal(Tasks.runOfA2aTask("acme", "desk", dead.task.id), null);
});

test("two recoveries of one unbound task at once, after it ended: neither puts it back to SUBMITTED", async () => {
  const flow = loadFlow("acme", "desk", "many")!;
  const { task } = await Tasks.claimA2aTask({ tenant: "acme", workspace: "desk", flow: "many", contextId: "c", callerKeyId: "k", messageId: "recover-race", fingerprint: "f", lastMessage: null }, new Date(Date.now() - 5 * 60_000));
  const run = await admitFlowRun({ tenant: "acme", workspace: "desk", flow, a2a: { task: task.id, key: "k" } });
  // Each caller read the row while it was still unbound.
  const stale = { ...task };
  const [a, b] = await Promise.all([Tasks.recoverA2aTaskRun(stale), Tasks.recoverA2aTaskRun(stale)]);
  assert.equal(a.runId, run.id);
  assert.equal(b.runId, run.id);
  await Tasks.noteA2aTaskState("acme", task.id, "TASK_STATE_COMPLETED", new Date());
  // A third, from a copy read before any of this, and the original start's late bind.
  const late = await Tasks.recoverA2aTaskRun(stale);
  assert.equal(late.state, "TASK_STATE_COMPLETED");
  await Tasks.bindA2aTaskRun("acme", task.id, run.id, "TASK_STATE_SUBMITTED");
  assert.equal((await Tasks.getA2aTask("acme", task.id))!.state, "TASK_STATE_COMPLETED");
});

// An unreadable run is not an absent one (Codex review, 1 Nov 2026): a read
// that fails must stop a takeover and an admission, never start a second,
// billable run. A record that is genuinely gone is still "no run".
test("a correlated run that cannot be read fails the takeover and the admission closed", async () => {
  const flow = loadFlow("acme", "desk", "many")!;
  const { task } = await Tasks.claimA2aTask({ tenant: "acme", workspace: "desk", flow: "many", contextId: "c", callerKeyId: "k", messageId: "unreadable-1", fingerprint: "f", lastMessage: null }, new Date(Date.now() - 5 * 60_000));
  const first = await admitFlowRun({ tenant: "acme", workspace: "desk", flow, a2a: { task: task.id, key: "k" } });
  const runsOf = () => listRunSummaries("acme", "desk").filter((r) => r.a2a?.task === task.id).length;
  assert.equal(runsOf(), 1, "indexed, with its correlation");
  // A torn read (what an ESTALE past readRun's retries amounts to here): the
  // listing keeps its row, the record cannot be parsed.
  const file = path.join(ws, "runs", `${first.id}.json`);
  const good = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, "{");
  assert.throws(() => Tasks.runOfA2aTask("acme", "desk", task.id));
  await assert.rejects(Tasks.retakeA2aTask("acme", task.id, new Date(Date.now() - 60_000)), "no takeover on an unreadable run");
  await assert.rejects(admitFlowRun({ tenant: "acme", workspace: "desk", flow, a2a: { task: task.id, key: "k" } }), "no admission either");
  assert.equal((await Tasks.getA2aTask("acme", task.id))!.state, "admitting", "the claim is not taken");
  assert.equal(runsOf(), 1, "and no second run");
  // Readable again: found and bound.
  fs.writeFileSync(file, good);
  assert.equal(Tasks.runOfA2aTask("acme", "desk", task.id)!.id, first.id);
  // Gone for real: no run.
  fs.rmSync(file);
  assert.equal(Tasks.runOfA2aTask("acme", "desk", task.id), null);
});

// The listing leaves out a record it cannot parse and never indexed, so a
// lookup through it alone would say "no run" for what may be this task's run
// (Codex review, 1 Nov 2026). Such a record makes the lookup fail closed.
test("a run record with no index entry that cannot be read: no takeover, no admission, until it reads or goes", async () => {
  const flow = loadFlow("acme", "desk", "many")!;
  const { task } = await Tasks.claimA2aTask({ tenant: "acme", workspace: "desk", flow: "many", contextId: "c", callerKeyId: "k", messageId: "unindexed-1", fingerprint: "f", lastMessage: null }, new Date(Date.now() - 5 * 60_000));
  // A record written for this task that the index never took in, and now
  // cannot be parsed (torn, or an ESTALE read): whose run it is cannot be told.
  const id = "run-unindexed-zz";
  const file = path.join(ws, "runs", `${id}.json`);
  fs.writeFileSync(file, "{\"id\":\"run-unindexed-zz\",\"a2a\":{\"task\":");
  assert.ok(!listRunSummaries("acme", "desk").some((r) => r.id === id), "the listing has no row for it");
  assert.throws(() => Tasks.runOfA2aTask("acme", "desk", task.id), /cannot be read/);
  await assert.rejects(Tasks.retakeA2aTask("acme", task.id, new Date(Date.now() - 60_000)), "no takeover");
  await assert.rejects(admitFlowRun({ tenant: "acme", workspace: "desk", flow, a2a: { task: task.id, key: "k" } }), "no admission");
  assert.equal((await Tasks.getA2aTask("acme", task.id))!.state, "admitting");
  assert.equal(listRunSummaries("acme", "desk").filter((r) => r.a2a?.task === task.id).length, 0, "nothing started");

  // It reads after all, and is this task's run: found, though it was never in the listing's index.
  const whole = JSON.stringify({ id, flow: "many", status: "queued", startedAt: new Date().toISOString(), finishedAt: null, steps: [], a2a: { task: task.id, key: "k" } });
  fs.writeFileSync(file, whole);
  assert.equal(Tasks.runOfA2aTask("acme", "desk", task.id)!.id, id);
  // Gone: no run, and the claim may be taken over.
  fs.rmSync(file);
  assert.equal(Tasks.runOfA2aTask("acme", "desk", task.id), null);
  assert.equal(await Tasks.retakeA2aTask("acme", task.id, new Date(Date.now() - 60_000)), true);
});
