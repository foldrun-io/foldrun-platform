// A2A tasks on the file store (1 Nov 2026): the claim is the dedupe, a
// terminal state is never left, a dead start can be taken over once, and a
// listing is one caller's, newest change first, page by page.
// (The table's statements are the same calls on Postgres; postgres-live
// covers the migration.)
//
//   node --test tests/a2a-tasks.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-a2a-tasks-"));
process.env.FOLDRUN_DATA = DATA;
delete process.env.FOLDRUN_DATABASE_URL;

const T = await import("../src/a2a-tasks.ts");

const base = { tenant: "acme", workspace: "desk", flow: "leads", contextId: "ctx-1", callerKeyId: "key-a", fingerprint: "fp-1", lastMessage: { messageId: "m1" } };

test("the same message claims once: the second claim finds the first task", async () => {
  const a = await T.claimA2aTask({ ...base, messageId: "m1" });
  assert.equal(a.created, true);
  assert.equal(a.task.state, "admitting");
  assert.equal(a.task.runId, null);
  assert.match(a.task.id, /^[0-9a-f-]{36}$/, "an opaque UUID");
  const b = await T.claimA2aTask({ ...base, messageId: "m1", fingerprint: "fp-other" });
  assert.equal(b.created, false);
  assert.equal(b.task.id, a.task.id);
  assert.equal(b.task.fingerprint, "fp-1", "the first message's fingerprint, for the caller to compare");
  // The same messageId from another caller, or to another flow, is its own task.
  assert.equal((await T.claimA2aTask({ ...base, messageId: "m1", callerKeyId: "key-b" })).created, true);
  assert.equal((await T.claimA2aTask({ ...base, messageId: "m1", flow: "other" })).created, true);
  // Two claims at once: exactly one is created.
  const both = await Promise.all([T.claimA2aTask({ ...base, messageId: "race" }), T.claimA2aTask({ ...base, messageId: "race" })]);
  assert.deepEqual(both.map((x) => x.created).sort(), [false, true]);
  assert.equal(both[0].task.id, both[1].task.id);
});

test("bound, moved, ended — and an end is never left", async () => {
  const { task } = await T.claimA2aTask({ ...base, messageId: "life" });
  await T.bindA2aTaskRun("acme", task.id, "run-1", "TASK_STATE_SUBMITTED", new Date("2026-11-01T00:00:01Z"));
  let got = (await T.getA2aTask("acme", task.id))!;
  assert.equal(got.runId, "run-1");
  assert.equal(got.state, "TASK_STATE_SUBMITTED");
  await T.noteA2aTaskState("acme", task.id, "TASK_STATE_WORKING", new Date("2026-11-01T00:00:02Z"));
  await T.noteA2aTaskState("acme", task.id, "TASK_STATE_CANCELED", new Date("2026-11-01T00:00:03Z"));
  await T.noteA2aTaskState("acme", task.id, "TASK_STATE_WORKING", new Date("2026-11-01T00:00:04Z"));
  got = (await T.getA2aTask("acme", task.id))!;
  assert.equal(got.state, "TASK_STATE_CANCELED");
  assert.equal(got.updatedAt, "2026-11-01T00:00:03.000Z", "updatedAt is when the state last changed");
  // Another account never sees it.
  assert.equal(await T.getA2aTask("other", task.id), null);
  // A bound task is not dropped (only a claim with no run is).
  await T.dropA2aTask("acme", task.id);
  assert.ok(await T.getA2aTask("acme", task.id));
});

test("a refused start hands its claim back; a dead one is taken over once", async () => {
  const { task } = await T.claimA2aTask({ ...base, messageId: "refused" });
  await T.dropA2aTask("acme", task.id);
  assert.equal(await T.getA2aTask("acme", task.id), null);
  assert.equal((await T.claimA2aTask({ ...base, messageId: "refused" })).created, true, "the same message may be sent again");

  const old = await T.claimA2aTask({ ...base, messageId: "dead" }, new Date(Date.now() - 120_000));
  const staleBefore = new Date(Date.now() - 60_000);
  const takes = await Promise.all([T.retakeA2aTask("acme", old.task.id, staleBefore), T.retakeA2aTask("acme", old.task.id, staleBefore)]);
  assert.deepEqual(takes.sort(), [false, true], "one taker");
  const fresh = await T.claimA2aTask({ ...base, messageId: "fresh" });
  assert.equal(await T.retakeA2aTask("acme", fresh.task.id, staleBefore), false, "a claim in flight is not taken");
});

test("a listing is one caller's, newest change first, page by page, with filters", async () => {
  const ws = "listing";
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const { task } = await T.claimA2aTask({ ...base, workspace: ws, messageId: `l${i}`, contextId: i % 2 ? "odd" : "even" });
    await T.bindA2aTaskRun("acme", task.id, `run-l${i}`, "TASK_STATE_WORKING", new Date(Date.UTC(2026, 10, 1, 0, 0, i)));
    ids.push(task.id);
  }
  await T.claimA2aTask({ ...base, workspace: ws, messageId: "theirs", callerKeyId: "key-z" });
  const q = { tenant: "acme", workspace: ws, flow: "leads", callerKeyId: "key-a" };
  const first = await T.listA2aTasks({ ...q, limit: 2 });
  assert.equal(first.total, 5, "the other caller's task is not counted");
  assert.deepEqual(first.tasks.map((t) => t.id), [ids[4], ids[3]]);
  const last = first.tasks[1]!;
  const second = await T.listA2aTasks({ ...q, limit: 2, after: { updatedAt: last.updatedAt, id: last.id } });
  assert.deepEqual(second.tasks.map((t) => t.id), [ids[2], ids[1]]);
  assert.deepEqual((await T.listA2aTasks({ ...q, limit: 10, contextId: "odd" })).tasks.map((t) => t.id), [ids[3], ids[1]]);
  assert.equal((await T.listA2aTasks({ ...q, limit: 10, state: "TASK_STATE_COMPLETED" })).total, 0);
  assert.equal((await T.listA2aTasks({ ...q, limit: 10, updatedAfter: "2026-11-01T00:00:02.000Z" })).total, 2);
  assert.equal((await T.openA2aTasks("acme", ws, "key-a")).length, 5);
  assert.deepEqual((await T.a2aTasksOfRuns("acme", ["run-l0"])).map((t) => t.id), [ids[0]]);
});

test("an account's tasks go with the account", async () => {
  const { task } = await T.claimA2aTask({ ...base, tenant: "gone", messageId: "x" });
  await T.deleteTenantA2aTasks("gone");
  assert.equal(await T.getA2aTask("gone", task.id), null);
  assert.ok(!fs.existsSync(path.join(DATA, ".a2a-tasks", "gone.json")));
});

test("the housekeeping prune drops ended tasks older than 90 days, never an open one", async () => {
  const p = { ...base, tenant: "prune" };
  const ended = (await T.claimA2aTask({ ...p, messageId: "old-done" })).task;
  await T.bindA2aTaskRun("prune", ended.id, "run-d", "TASK_STATE_SUBMITTED");
  await T.noteA2aTaskState("prune", ended.id, "TASK_STATE_COMPLETED", new Date());
  const open = (await T.claimA2aTask({ ...p, messageId: "old-open" })).task;
  await T.bindA2aTaskRun("prune", open.id, "run-o", "TASK_STATE_WORKING");
  // Not yet 90 days: neither goes. (Judged by this tenant's own tasks: the
  // tests above stamp theirs with fixed 2026 dates, which a store-wide count
  // would see as older than 90 days from the day after — it failed every
  // deploy from 2 Nov 2026.)
  await T.pruneA2aTasks(new Date(Date.now() + 89 * 86_400_000));
  assert.ok(await T.getA2aTask("prune", ended.id));
  assert.ok(await T.getA2aTask("prune", open.id));
  // Past 90 days: the ended task goes, the open one stays, however old.
  // The store is shared with the tests above, whose ended tasks are pruned too.
  assert.ok((await T.pruneA2aTasks(new Date(Date.now() + 91 * 86_400_000))) >= 1);
  assert.equal(await T.getA2aTask("prune", ended.id), null);
  assert.ok(await T.getA2aTask("prune", open.id));
  assert.equal(T.A2A_TASK_KEEP_DAYS, 90);
});

// Binding is once (Codex review, 1 Nov 2026): two recoveries at once, or the
// original start's late bind after a recovery, must not put a task that has
// moved on — or ended — back to SUBMITTED.
test("a run is bound to a task once; a later bind leaves the row as it stands and returns it", async () => {
  const { task } = await T.claimA2aTask({ ...base, messageId: "bind-once" });
  const both = await Promise.all([
    T.bindA2aTaskRun("acme", task.id, "run-b", "TASK_STATE_SUBMITTED", new Date("2026-11-01T00:00:01Z")),
    T.bindA2aTaskRun("acme", task.id, "run-b", "TASK_STATE_SUBMITTED", new Date("2026-11-01T00:00:02Z")),
  ]);
  assert.deepEqual(both.map((t) => t!.updatedAt), ["2026-11-01T00:00:01.000Z", "2026-11-01T00:00:01.000Z"], "the first bind stands; the second reads it");
  await T.noteA2aTaskState("acme", task.id, "TASK_STATE_COMPLETED", new Date("2026-11-01T00:01:00Z"));
  const late = await T.bindA2aTaskRun("acme", task.id, "run-b", "TASK_STATE_SUBMITTED", new Date("2026-11-01T00:02:00Z"));
  assert.equal(late!.state, "TASK_STATE_COMPLETED", "the late bind returns the stored task");
  const stored = (await T.getA2aTask("acme", task.id))!;
  assert.equal(stored.state, "TASK_STATE_COMPLETED");
  assert.equal(stored.updatedAt, "2026-11-01T00:01:00.000Z");
  assert.equal(await T.bindA2aTaskRun("acme", "no-such-task", "run-x", "TASK_STATE_SUBMITTED"), null);
});

// A status filter reads the state a task SHOWS (Codex review, 1 Nov 2026):
// a claim still starting shows SUBMITTED, a dead one FAILED — and the row
// stays "admitting", so the dead one can still be taken over.
test("listing by shown state: a fresh claim is SUBMITTED, a dead one FAILED, the rows untouched", async () => {
  const q = { tenant: "acme", workspace: "shown", flow: "leads", callerKeyId: "key-a", limit: 10 };
  const fresh = (await T.claimA2aTask({ ...base, workspace: "shown", messageId: "s-fresh" })).task;
  const dead = (await T.claimA2aTask({ ...base, workspace: "shown", messageId: "s-dead" }, new Date(Date.now() - 10 * 60_000))).task;
  const bound = (await T.claimA2aTask({ ...base, workspace: "shown", messageId: "s-bound" })).task;
  await T.bindA2aTaskRun("acme", bound.id, "run-s", "TASK_STATE_SUBMITTED");
  const staleBefore = new Date(Date.now() - 60_000).toISOString();
  const ids = async (state: "TASK_STATE_SUBMITTED" | "TASK_STATE_FAILED" | "TASK_STATE_WORKING") => (await T.listA2aTasks({ ...q, shown: { state, staleBefore } })).tasks.map((t) => t.id).sort();
  assert.deepEqual(await ids("TASK_STATE_SUBMITTED"), [bound.id, fresh.id].sort());
  assert.deepEqual(await ids("TASK_STATE_FAILED"), [dead.id]);
  assert.deepEqual(await ids("TASK_STATE_WORKING"), []);
  assert.equal((await T.listA2aTasks({ ...q, shown: { state: "TASK_STATE_SUBMITTED", staleBefore } })).total, 2);
  assert.equal(T.shownState(dead, staleBefore), "TASK_STATE_FAILED");
  assert.equal((await T.getA2aTask("acme", dead.id))!.state, "admitting", "the row is not changed by being listed");
  assert.equal(await T.retakeA2aTask("acme", dead.id, new Date(staleBefore)), true, "and stays retakeable");
});

// A caller that asked for an immediate answer and never polled again: its
// task's stored state is brought up to its run's in housekeeping, before
// the retention cutoff (Codex review, 1 Nov 2026) — else the prune, which
// takes ended tasks only, kept the row and its message for ever.
test("housekeeping reconciles stored states from the runs, then prunes by the run's end", async () => {
  const { writeRun } = await import("../../foldrun-core/src/store.ts");
  const day = 86_400_000;
  const ended = new Date(Date.now() - day).toISOString();
  const run = (id: string, status: "completed" | "failed" | "running" | "queued", extra: Record<string, unknown> = {}) =>
    writeRun("recon", "desk", { id, flow: "leads", status, startedAt: ended, finishedAt: status === "completed" || status === "failed" ? ended : null, steps: [], ...extra } as never);
  const r = { ...base, tenant: "recon", workspace: "desk" };
  const done = (await T.claimA2aTask({ ...r, messageId: "r-done" })).task;
  const stopped = (await T.claimA2aTask({ ...r, messageId: "r-stopped" })).task;
  const live = (await T.claimA2aTask({ ...r, messageId: "r-live" })).task;
  run("run-r-done", "completed");
  run("run-r-stopped", "failed", { stopRequested: true });
  run("run-r-live", "running");
  await T.bindA2aTaskRun("recon", done.id, "run-r-done", "TASK_STATE_SUBMITTED");
  await T.bindA2aTaskRun("recon", stopped.id, "run-r-stopped", "TASK_STATE_SUBMITTED");
  await T.bindA2aTaskRun("recon", live.id, "run-r-live", "TASK_STATE_WORKING");
  // A claim whose run was created and never recorded, and one that died before any run.
  const unrecorded = (await T.claimA2aTask({ ...r, messageId: "r-unrecorded" })).task;
  run("run-r-unrecorded", "queued", { a2a: { task: unrecorded.id, key: "key-a" } });
  const dead = (await T.claimA2aTask({ ...r, messageId: "r-dead" }, new Date(Date.now() - 100 * day))).task;

  assert.ok((await T.reconcileA2aTasks()) >= 3);
  const doneNow = (await T.getA2aTask("recon", done.id))!;
  assert.equal(doneNow.state, "TASK_STATE_COMPLETED", "nobody polled, and it is ended anyway");
  assert.equal(doneNow.updatedAt, ended, "at the run's own end");
  assert.equal((await T.getA2aTask("recon", stopped.id))!.state, "TASK_STATE_CANCELED");
  assert.equal((await T.getA2aTask("recon", live.id))!.state, "TASK_STATE_WORKING", "a run under way is left alone");
  assert.equal((await T.getA2aTask("recon", unrecorded.id))!.runId, "run-r-unrecorded", "a claim's run, found and bound");
  assert.equal((await T.getA2aTask("recon", dead.id))!.state, "admitting", "a dead claim stays retakeable inside the window");
  assert.equal(T.runEndState(null), "TASK_STATE_FAILED", "a run that is gone ended");

  // 91 days on: the ended tasks and the long-dead claim go; the live one stays.
  await T.pruneA2aTasks(new Date(Date.now() + 91 * day));
  assert.equal(await T.getA2aTask("recon", done.id), null);
  assert.equal(await T.getA2aTask("recon", stopped.id), null);
  assert.equal(await T.getA2aTask("recon", dead.id), null);
  assert.ok(await T.getA2aTask("recon", live.id));
});

// Codex, 1 Nov 2026: a store file that would not read counted as "no tasks",
// so the next claim overwrote every record and a retried message ran twice.
test("a task store that will not parse refuses a claim instead of starting over; a missing one is empty", async () => {
  const file = path.join(DATA, ".a2a-tasks", "torn.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ not json");
  await assert.rejects(T.claimA2aTask({ ...base, tenant: "torn", messageId: "m-torn" }));
  assert.equal(fs.readFileSync(file, "utf8"), "{ not json", "the file is left exactly as it was");
  fs.writeFileSync(file, JSON.stringify({ v: 1, tasks: "nope" }));
  await assert.rejects(T.claimA2aTask({ ...base, tenant: "torn", messageId: "m-torn" }));
  // Housekeeping skips that one account rather than stopping.
  await T.reconcileA2aTasks();
  fs.rmSync(file);
  const fresh = await T.claimA2aTask({ ...base, tenant: "torn", messageId: "m-torn" });
  assert.ok(fresh.task.id, "no file yet: an empty store, and the claim goes through");
});
