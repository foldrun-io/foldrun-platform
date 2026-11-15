// The one-time copy of the small state that was files on the volume (FOL-126,
// M7): webhook generations and deliveries, eval results and history, grades,
// grader cursors, the deployed commit, step state of open runs, and the
// platform's marks (unsettled charges among them). On Postgres with the
// platform wired. Every check reads back through core's OWN readers with the
// files gone, so a drift between this copy and what the readers look at fails
// here.
//
//   FOLDRUN_TEST_DATABASE_URL=postgres://… node --test tests/state-backfill-pg.test.ts

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { takeTurnsOnLiveDb } from "./live-db-lock.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
takeTurnsOnLiveDb(url);
const live = { skip: url ? false : "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" };
if (url) {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-statebf-"));
  process.env.FOLDRUN_SECRET_KEY ??= "test-install-key";
  after(async () => {
    const { closePgSync } = await import("../src/pg-sync.ts");
    await closePgSync();
    const { db } = await import("../src/db.ts");
    await db()?.end();
  });
}

const j = (v: unknown) => JSON.stringify(v);
const wr = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

async function setup(prefix: string) {
  const { migrate } = await import("../src/db.ts");
  await migrate();
  const { installPlatform } = await import("../src/index.ts");
  installPlatform();
  const { pgSyncOne } = await import("../src/pg-sync.ts");
  const { workspaceDir } = await import("../../foldrun-core/src/store.ts");
  const T = `${prefix}${Date.now().toString(36)}`;
  const W = "desk";
  pgSyncOne("INSERT INTO records_routing (tenant, workspace, state) VALUES ($1, $2, 'database') ON CONFLICT DO NOTHING", [T, W]);
  const { resetRoutingForTest } = await import("../src/records-routing.ts");
  resetRoutingForTest(); // the routing just written is read now, not at the next lease
  const root = workspaceDir(T, W);
  wr(path.join(root, "AGENTS.md"), "---\nname: desk\n---\n");
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  return { T, W, root, pgSyncOne };
}

test("old workspace state and marks are copied once and read back through core's readers with the files gone", live, async () => {
  const { T, W, root } = await setup("sb");
  const res = path.join(root, "evals", ".results");
  const acct = path.join(path.dirname(path.dirname(root)));
  const { accountDir } = await import("../../foldrun-core/src/store.ts");
  assert.equal(accountDir(T), acct, "the account folder is two above the workspace");

  // What the files hold.
  wr(path.join(root, "hooks.json"), j({ intake: { gen: 3, rotatedAt: "2026-10-01T00:00:00.000Z" } }));
  const deliveries = [1, 2, 3].map((n) => ({ t: `2026-10-0${n}T00:00:00.000Z`, flow: "intake", outcome: "accepted", n }));
  wr(path.join(root, "hook-deliveries.jsonl"), deliveries.map(j).join("\n") + "\n");
  const result = { eval: "tone", startedAt: "2026-10-02T00:00:00.000Z", finishedAt: "2026-10-02T00:01:00.000Z", passed: 2, failed: 1, costUsd: 0.1, cases: [] };
  wr(path.join(res, "tone.json"), j(result));
  const hist = [1, 2].map((n) => ({ eval: "tone", at: `2026-10-0${n}T00:00:00.000Z`, commit: `c${n}`, passed: n, failed: 0, costUsd: 0 }));
  wr(path.join(res, "history.jsonl"), hist.map(j).join("\n") + "\n");
  const grades = [1, 2].map((n) => ({ eval: "tone", runId: `run-${n}`, flow: "f", at: `2026-10-0${n}T00:00:00.000Z`, status: "pass", checks: [], costUsd: 0, by: "sample" }));
  wr(path.join(res, "grades", "tone.jsonl"), grades.map(j).join("\n") + "\n");
  wr(path.join(res, "grades", "tone.state.json"), j({ since: "2026-09-01T00:00:00.000Z", lastServed: "2026-10-05T00:00:00.000Z" }));
  wr(path.join(root, "..", `.${W}.deployed`), j({ commit: "abc1234", at: "2026-10-03T00:00:00.000Z" }) + "\n");
  // Step state of an open run, and of a finished one.
  const { writeRun } = await import("../../foldrun-core/src/store.ts");
  const run = (id: string, status: string) => writeRun(T, W, { id, flow: "f", status, startedAt: new Date().toISOString(), steps: [] } as never);
  run("run-open", "running");
  run("run-done", "completed");
  wr(path.join(root, "runs", "run-open", "sandbox", "s1.json"), j({ "a.txt": "h1" }));
  wr(path.join(root, "runs", "run-open", "sandbox", "s1.base.json"), j({ workspace: "w1", state: null }));
  wr(path.join(root, "runs", "run-open", "storage-baseline.json"), j({ "x.csv": "h2" }));
  wr(path.join(root, "runs", "run-done", "storage-baseline.json"), j({ "y.csv": "h3" }));
  // Marks.
  const owed = { tenant: T, workspace: W, runId: "run-owed", at: "2026-10-04T00:00:00.000Z", error: "db down", attempts: 4 };
  wr(path.join(acct, "unsettled", "run-owed.json"), j(owed));
  wr(path.join(acct, "unsettled", "run-other.json"), j({ ...owed, tenant: "someone-else", runId: "run-other" }));
  wr(path.join(acct, ".accrued"), "2026-11-01");
  wr(path.join(acct, ".paused-notices.json"), j({ [`${W}/intake`]: "run-9" }));
  wr(path.join(acct, ".runtime-status.json"), j({ fp1: { state: "ready", error: null, log: [], at: "2026-10-04T00:00:00.000Z", workspace: W, agents: [] } }));

  const { backfillState } = await import("../src/state-backfill.ts");
  const { hookGeneration, readDeliveries } = await import("../../foldrun-core/src/webhook.ts");
  const { readEvalHistory, readEvalResult } = await import("../../foldrun-core/src/evals.ts");
  const { deployedCommit } = await import("../../foldrun-core/src/deploy.ts");
  const { readGrades, graderSince, graderLastServed } = await import("../../foldrun-core/src/grades.ts");
  const { getStepState } = await import("../../foldrun-core/src/step-state.ts");
  const { markGet } = await import("../src/marks.ts");
  const { listUnsettled } = await import("../src/settle.ts");

  const dry = await backfillState({ write: false, tenants: [T] });
  assert.equal(dry.kinds["docs:hook"].copied, 1, "a dry run counts");
  assert.equal(markGet(T, "unsettled", "run-owed"), undefined, "and writes nothing");

  const first = await backfillState({ write: true, tenants: [T] });
  assert.deepEqual(first.failures, []);
  const c = (k: string) => first.kinds[k]?.copied;
  assert.deepEqual([c("docs:hook"), c("docs:deployed"), c("docs:eval-result"), c("docs:grader"), c("logs:hook-delivery"), c("logs:eval-history"), c("logs:grades")], [1, 1, 1, 1, 3, 2, 2]);
  assert.deepEqual([c("steps:handed-in"), c("steps:base"), c("steps:storage"), c("marks:unsettled"), c("marks:accrued"), c("marks:pause-notice"), c("marks:runtime-status")], [1, 1, 1, 1, 1, 1, 1]);
  assert.ok(first.notes.some((n) => n.includes("run-other") && n.includes("another account")), "a marker naming another account is left, named");
  assert.ok(first.notes.some((n) => n.includes("run-done") || n.includes("finished")), "a finished run's step state is left, named");

  const again = await backfillState({ write: true, tenants: [T] });
  assert.equal(Object.values(again.kinds).reduce((n, t) => n + t.copied, 0), 0, "a second pass copies nothing");
  assert.equal(again.kinds["logs:hook-delivery"].present, 3);

  // The files go; core reads the rows.
  for (const p of [path.join(root, "hooks.json"), path.join(root, "hook-deliveries.jsonl"), res, path.join(root, "..", `.${W}.deployed`), path.join(root, "runs"), path.join(acct, "unsettled"), path.join(acct, ".accrued"), path.join(acct, ".paused-notices.json"), path.join(acct, ".runtime-status.json")]) {
    fs.rmSync(p, { recursive: true, force: true });
  }
  assert.equal(hookGeneration(T, W, "intake"), 3);
  assert.deepEqual(readDeliveries(T, W, 10).map((d) => (d as unknown as { n: number }).n), [3, 2, 1]);
  assert.equal(readEvalResult(T, W, "tone")?.passed, 2);
  assert.deepEqual(readEvalHistory(T, W).map((h) => h.commit), ["c1", "c2"]);
  assert.equal(deployedCommit(T, W)?.commit, "abc1234");
  assert.deepEqual(readGrades(T, W, "tone").map((g) => g.runId), ["run-2", "run-1"], "newest first, as from the file");
  assert.equal(graderSince(T, W, "tone", Date.now()), Date.parse("2026-09-01T00:00:00.000Z"));
  assert.equal(graderLastServed(T, W, "tone"), Date.parse("2026-10-05T00:00:00.000Z"));
  assert.deepEqual(await getStepState(T, W, "run-open", "handed-in", "s1"), { "a.txt": "h1" });
  assert.deepEqual(await getStepState(T, W, "run-open", "base", "s1"), { workspace: "w1", state: null });
  assert.deepEqual(await getStepState(T, W, "run-open", "storage", ""), { "x.csv": "h2" });
  assert.deepEqual(listUnsettled(T).map((u) => u.runId), ["run-owed"]);
  assert.deepEqual(markGet(T, "accrued", ""), { day: "2026-11-01" });
  assert.deepEqual(markGet(T, "pause-notice", `${W}/intake`), { runId: "run-9" });
  assert.equal((markGet(T, "runtime-status", "fp1") as { state: string }).state, "ready");
});

test("a row that is newer is kept; an older one moves forward only; a log under newer rows is left, named", live, async () => {
  const { T, W, root, pgSyncOne } = await setup("sc");
  const res = path.join(root, "evals", ".results");
  const { backfillState } = await import("../src/state-backfill.ts");
  const { records } = await import("../../foldrun-core/src/records.ts");
  const docs = records(T, W)!.docs!;
  // The hook was rotated to 7 since the switch; the file still says 3: never lowered.
  docs.raise(T, W, "hook", "intake", "gen", 7, {});
  wr(path.join(root, "hooks.json"), j({ intake: { gen: 3, rotatedAt: "2026-10-01T00:00:00.000Z" }, other: { gen: 2, rotatedAt: "2026-10-01T00:00:00.000Z" } }));
  // An eval result newer in the row than in the file; one older in the row.
  docs.put(T, W, "eval-result", "new", { eval: "new", finishedAt: "2026-11-05T00:00:00.000Z", passed: 9 });
  wr(path.join(res, "new.json"), j({ eval: "new", finishedAt: "2026-10-05T00:00:00.000Z", passed: 1 }));
  docs.put(T, W, "eval-result", "old", { eval: "old", finishedAt: "2026-09-05T00:00:00.000Z", passed: 1 });
  wr(path.join(res, "old.json"), j({ eval: "old", finishedAt: "2026-10-05T00:00:00.000Z", passed: 5 }));
  // A log with a row written since the switch that the file does not have.
  docs.append(T, W, "hook-delivery", { t: "2026-11-09T00:00:00.000Z", flow: "intake", outcome: "accepted", n: 99 }, 500);
  wr(path.join(root, "hook-deliveries.jsonl"), j({ t: "2026-10-01T00:00:00.000Z", flow: "intake", outcome: "accepted", n: 1 }) + "\n");
  // A link and a huge-looking name never leave the folder.
  fs.mkdirSync(path.join(root, "outside"), { recursive: true });
  fs.writeFileSync(path.join(root, "outside", "secret.json"), j({ eval: "leak", finishedAt: "2026-10-05T00:00:00.000Z" }));
  fs.symlinkSync(path.join(root, "outside", "secret.json"), path.join(res, "leak.json"));
  // Another account's files are not touched by a pass over this one.
  const U = `${T}x`;
  pgSyncOne("INSERT INTO records_routing (tenant, workspace, state) VALUES ($1, $2, 'database') ON CONFLICT DO NOTHING", [U, W]);
  const { workspaceDir } = await import("../../foldrun-core/src/store.ts");
  wr(path.join(workspaceDir(U, W), "AGENTS.md"), "---\nname: desk\n---\n");
  wr(path.join(workspaceDir(U, W), "hooks.json"), j({ intake: { gen: 4, rotatedAt: "x" } }));

  const r = await backfillState({ write: true, tenants: [T] });
  assert.deepEqual(r.failures, []);
  assert.equal((docs.get(T, W, "hook", "intake") as { gen: number }).gen, 7, "a generation is never lowered");
  assert.equal((docs.get(T, W, "hook", "other") as { gen: number }).gen, 2, "a missing one is made");
  assert.equal((docs.get(T, W, "eval-result", "new") as { passed: number }).passed, 9, "a newer row is kept");
  assert.equal((docs.get(T, W, "eval-result", "old") as { passed: number }).passed, 5, "an older row moves forward");
  assert.equal(docs.get(T, W, "eval-result", "leak"), undefined, "a link is not followed");
  assert.ok(r.notes.some((n) => n.includes("leak.json") && n.includes("not a regular file")));
  assert.equal(docs.tail(T, W, "hook-delivery", 10).length, 1, "the log under newer rows is untouched");
  assert.ok(r.notes.some((n) => n.includes("hook-delivery") && n.includes("never copied under newer rows")));
  const other = pgSyncOne("SELECT count(*)::int AS n FROM workspace_docs WHERE tenant = $1", [U]);
  assert.equal(other.rows[0].n, 0, "another account's files stay where they are");
});

test("a log copy that stopped half way is finished, in order, and a big log is not held in memory", live, async () => {
  const { T, W, root } = await setup("sd");
  const { backfillState } = await import("../src/state-backfill.ts");
  const { records } = await import("../../foldrun-core/src/records.ts");
  const docs = records(T, W)!.docs!;
  const lines = Array.from({ length: 1200 }, (_, n) => j({ t: `2026-10-01T00:00:${String(n % 60).padStart(2, "0")}.000Z`, flow: "f", outcome: "accepted", n }));
  wr(path.join(root, "hook-deliveries.jsonl"), lines.join("\n") + "\n" + "x".repeat(300_000) + "\n"); // one line past the limit
  // The first pass died after three lines.
  for (const l of lines.slice(700, 703)) docs.append(T, W, "hook-delivery", JSON.parse(l), 0);
  const r = await backfillState({ write: true, tenants: [T] });
  assert.deepEqual(r.failures, []);
  // Only the newest 500 are kept (the log's own bound): 700..1199, three already there.
  assert.equal(r.kinds["logs:hook-delivery"].copied, 497);
  assert.equal(r.kinds["logs:hook-delivery"].present, 3);
  // By id in SQL: DocsPort.tail sorts its text alias, not the number (flagged in the report).
  const { pgSyncOne } = await import("../src/pg-sync.ts");
  const ns = pgSyncOne("SELECT (data ->> 'n')::int AS n FROM workspace_logs WHERE tenant = $1 AND kind = 'hook-delivery' ORDER BY id", [T]).rows.map((x) => x.n as number);
  assert.deepEqual(ns, Array.from({ length: 500 }, (_, i) => 700 + i), "in file order");
  assert.ok(r.notes.some((n) => n.includes("over 256 KiB")), "the huge line is named");
});

test("a workspace whose records are still files is named and not written to", live, async () => {
  const { migrate } = await import("../src/db.ts");
  await migrate();
  const { installPlatform } = await import("../src/index.ts");
  installPlatform();
  const { workspaceDir } = await import("../../foldrun-core/src/store.ts");
  const { backfillState } = await import("../src/state-backfill.ts");
  const { pgSyncOne } = await import("../src/pg-sync.ts");
  const T = `se${Date.now().toString(36)}`;
  const root = workspaceDir(T, "desk");
  wr(path.join(root, "AGENTS.md"), "---\nname: desk\n---\n");
  pgSyncOne("INSERT INTO records_routing (tenant, workspace, state) VALUES ($1, $2, 'files') ON CONFLICT DO NOTHING", [T, "desk"]);
  (await import("../src/records-routing.ts")).resetRoutingForTest();
  wr(path.join(root, "hooks.json"), j({ intake: { gen: 3, rotatedAt: "x" } }));
  const r = await backfillState({ write: true, tenants: [T] });
  assert.ok(r.notes.some((n) => n.includes("still files")));
  assert.equal(pgSyncOne("SELECT count(*)::int AS n FROM workspace_docs WHERE tenant = $1", [T]).rows[0].n, 0);
});
