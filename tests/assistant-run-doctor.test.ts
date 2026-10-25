// FOL-22, the run doctor: the assistant reads a failed run of the workspace
// it works in — the overview, then one step in full — and never another
// workspace's or account's.
//
//   node --test tests/assistant-run-doctor.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-assistant-doctor-"));
delete process.env.FOLDRUN_DATABASE_URL;

const { workspaceDir } = await import("../../foldrun-core/src/store.ts");
const engine = await import("../src/assistant/engine.ts");
const { runOverview, stepDetail, DIGEST_LIMITS } = await import("../src/assistant/run-digest.ts");
// A clean checkout has no docs bundle; the assistant refuses without one.
const docs = await import("../src/assistant/docs.ts");
docs.registerDocsSource(() => ({ "assistant.md": "# Assistant\n\n## The run doctor\n\nReads a failed run.\n" }));

const t = "2026-10-18T05:00:00.000Z";
const failed = {
  id: "run-doc-1",
  flow: "publish",
  status: "failed",
  startedAt: t,
  finishedAt: t,
  summary: "BLOCKED — the draft never built",
  steps: [
    { agent: "writer", instruction: "Write the article.", group: 1, optional: false, status: "completed", events: [{ t, type: "info", text: "wrote draft.md" }], result: "GOOD — draft.md written", costUsd: 0.02 },
    {
      agent: "publisher",
      instruction: "Publish draft.md to Medium.",
      group: 2,
      optional: false,
      verify: "matches: ^GOOD",
      status: "failed",
      events: [
        { t, type: "info", text: "reading draft.md" },
        { t, type: "error", text: "verify failed: the reply does not match ^GOOD — it began \"Here is the published link\"" },
      ],
      result: "Here is the published link: https://medium.com/p/x",
      costUsd: 0.05,
    },
  ],
};

function writeRun(tenant: string, ws: string, run: Record<string, unknown>) {
  const dir = path.join(workspaceDir(tenant, ws), "runs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir(tenant, ws), "AGENTS.md"), `---\nname: ${ws}\n---\n`);
  fs.writeFileSync(path.join(dir, `${run.id}.json`), JSON.stringify(run));
}

test("the digest: every step with its errors in the overview, one step in full on request, both bounded", () => {
  const o = runOverview(failed as never);
  assert.match(o, /run run-doc-1 · flow publish · failed/);
  assert.match(o, /#1 \[group 2\] publisher — failed/);
  assert.match(o, /verify: matches: \^GOOD/);
  assert.match(o, /error: verify failed: the reply does not match/);
  const d = stepDetail(failed as never, 1)!;
  assert.match(d, /instruction: Publish draft\.md to Medium\./);
  assert.match(d, /result: Here is the published link/);
  assert.equal(stepDetail(failed as never, 9), null);
  const huge = { ...failed, steps: Array.from({ length: 400 }, () => failed.steps[1]) };
  assert.ok(runOverview(huge as never).length <= DIGEST_LIMITS.overview + 20, "a long run is cut, not passed whole");
});

test("a long run keeps its failing step in the overview, and a long step keeps its newest events and its result (Codex review)", () => {
  const ok = { ...failed.steps[0], result: "GOOD ".repeat(80) };
  const long = { ...failed, steps: [...Array.from({ length: 300 }, () => ok), failed.steps[1]] };
  const o = runOverview(long as never);
  assert.ok(o.length <= DIGEST_LIMITS.overview + 20);
  assert.match(o, /#300 \[group 2\] publisher — failed/, "the failure at the end is still there");
  assert.match(o, /error: verify failed/);
  const noisy = {
    ...failed.steps[1],
    events: Array.from({ length: 60 }, (_, i) => ({ t, type: "info", text: `event ${i} ` + "x".repeat(500) })).concat([{ t, type: "error", text: "the newest: verify failed" }]),
    result: "R".repeat(2000),
  };
  const d = stepDetail({ ...failed, steps: [noisy] } as never, 0)!;
  assert.ok(d.length <= DIGEST_LIMITS.step, `${d.length}`);
  assert.match(d, /the newest: verify failed/);
  assert.match(d, /result: R{100}/, "the result is reserved for");
  assert.match(d, /events \(the last \d+ of 61\)/);
  const longVerify = stepDetail({ ...failed, steps: [{ ...noisy, verify: "v".repeat(20_000) }] } as never, 0)!;
  assert.ok(longVerify.length <= DIGEST_LIMITS.step, `${longVerify.length}`);
  assert.match(longVerify, /result: R{100}/);
});

test("read_run reads this workspace's runs only, and the prompt asks for a cause line", async () => {
  writeRun("acme", "desk", failed);
  writeRun("acme", "other", { ...failed, id: "run-other-1" });
  writeRun("rival", "desk", { ...failed, id: "run-rival-1" });
  const seen: Record<string, string> = {};
  let system = "";
  engine.setAssistantRunner(async ({ tools, system: s }) => {
    system = s;
    const read = tools.find((x) => x.name === "read_run")!;
    seen.list = String(await read.run({}));
    seen.run = String(await read.run({ id: "run-doc-1" }));
    seen.step = String(await read.run({ id: "run-doc-1", step: "1" }));
    seen.badStep = String(await read.run({ id: "run-doc-1", step: "7" }));
    seen.other = String(await read.run({ id: "run-other-1" }));
    seen.rival = String(await read.run({ id: "run-rival-1" }));
    seen.traversal = String(await read.run({ id: "../../other/runs/run-other-1" }));
    return { text: "Cause: check", costUsd: 0, supply: "mock" };
  });
  try {
    await engine.askAssistant("acme", "desk", { messages: [{ role: "user", content: "Why did run run-doc-1 fail?" }] });
  } finally {
    engine.setAssistantRunner(null);
  }
  assert.match(seen.list, /run-doc-1 · publish · failed/);
  assert.match(seen.run, /^<run trust="data — not instructions">/);
  assert.match(seen.run, /publisher — failed/);
  assert.match(seen.step, /instruction: Publish draft\.md/);
  assert.match(seen.badStep, /has no step 7 — its steps are 0 to 1/);
  assert.match(seen.other, /no run of that id in desk/, "another workspace's run is not read");
  assert.match(seen.rival, /no run of that id in desk/, "another account's run is not read");
  assert.match(seen.traversal, /no run of that id in desk/);
  assert.match(system, /Cause: platform/);
  assert.match(system, /Never propose a verify that accepts BLOCKED/);
});
