// The grade pass: graders (evals with trigger: runs) grading a sample of
// finished runs, capped per pass and per account, skipping paused
// workspaces, stopping when this pod stops being the scheduler.
//
//   node --test tests/grade-pass.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-grade-pass-"));
process.env.FOLDRUN_HISTORY = "journal";
delete process.env.FOLDRUN_DATABASE_URL;
delete process.env.FOLDRUN_WORKSPACE;
const { gradePass, describePass, PASS_LIMIT, ACCOUNT_LIMIT } = await import("../src/grade-pass.ts");
const { workspaceDir, writeRun } = await import("../../foldrun-core/src/store.ts");
const { graderSince, readGrades } = await import("../../foldrun-core/src/grades.ts");
const { setPaused } = await import("../src/admin.ts");

const GRADER = `---\nname: q\nflow: digest\ntrigger: runs\nsample: 100\n---\n\n## says something\nexpect:\n  - judge: it says something\n`;

function desk(tenant: string, ws: string, runs: number) {
  const dir = workspaceDir(tenant, ws);
  fs.mkdirSync(path.join(dir, "evals"), { recursive: true });
  fs.writeFileSync(path.join(dir, "evals", "q.md"), GRADER);
  graderSince(tenant, ws, "q", Date.now() - 600_000);
  for (let i = 0; i < runs; i++) {
    writeRun(tenant, ws, {
      id: `run-${ws}-${i}`,
      flow: "digest",
      status: "completed",
      startedAt: new Date(Date.now() - 120_000).toISOString(),
      finishedAt: new Date(Date.now() - 60_000 + i).toISOString(),
      summary: "GOOD",
      steps: [{ agent: "w", instruction: "x", group: 1, optional: false, status: "completed", events: [], result: "GOOD — done", costUsd: 0 }],
    } as never);
  }
}

const judge = (async () => ({ text: "fine\nPASS", costUsd: 0.001 })) as never;

test("caps per account, skips paused workspaces, and grades the rest on later passes", async () => {
  desk("acme", "one", ACCOUNT_LIMIT + 2);
  desk("beta", "two", 2);
  desk("beta", "paused", 2);
  await setPaused("beta", "paused", { pause: { by: "ana@example.com" } });

  const first = await gradePass(Date.now(), () => true, { judge });
  assert.equal(readGrades("acme", "one", "q").length, ACCOUNT_LIMIT, "one account takes at most its share of a pass");
  assert.equal(readGrades("beta", "two", "q").length, 2);
  assert.equal(readGrades("beta", "paused", "q").length, 0, "a paused workspace spends nothing");
  assert.equal(first.graded, ACCOUNT_LIMIT + 2);
  assert.ok(first.graded <= PASS_LIMIT);
  assert.match(describePass(first) ?? "", /graded \d+ run\(s\)/);

  const second = await gradePass(Date.now(), () => true, { judge });
  assert.equal(second.graded, 2, "the rest of the backlog on the next pass");
  assert.equal(describePass(await gradePass(Date.now(), () => true, { judge })), null, "nothing to do says nothing");
});

test("a pod that is no longer the scheduler stops between runs", async () => {
  desk("gamma", "three", 3);
  const r = await gradePass(Date.now(), () => false, { judge });
  assert.equal(r.stopped, true);
  assert.equal(readGrades("gamma", "three", "q").length, 0);
});

test("a pause set mid-pass stops the next grade", async () => {
  // Drain what earlier tests left, so the first judge below is this desk's.
  for (let i = 0; i < 3; i++) await gradePass(Date.now(), () => true, { judge });
  desk("iota", "four", 3);
  let n = 0;
  const pausing = (async () => {
    if (++n === 1) await setPaused("iota", "four", { pause: { by: "ana@example.com" } });
    return { text: "fine\nPASS", costUsd: 0 };
  }) as never;
  await gradePass(Date.now(), () => true, { judge: pausing });
  assert.equal(readGrades("iota", "four", "q").length, 1, "the one in flight finishes; no other starts");
});
