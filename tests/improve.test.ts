// Proposed fixes (improve.ts): failures that add up open a proposal, the
// assistant drafts it, a person applies or dismisses it.
//
//   node --test tests/improve.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-improve-"));
process.env.FOLDRUN_DATA = DATA;
process.env.FOLDRUN_HISTORY = "journal";
delete process.env.FOLDRUN_DATABASE_URL;
delete process.env.FOLDRUN_WORKSPACE;

const improve = await import("../src/improve.ts");
const jobs = await import("../src/assistant/jobs.ts");
const engine = await import("../src/assistant/engine.ts");
const docs = await import("../src/assistant/docs.ts");
const { recordGrade } = await import("../../foldrun-core/src/grades.ts");
const { listEvals, parseEval, writeEvalResult } = await import("../../foldrun-core/src/evals.ts");
import type { Grade } from "../../foldrun-core/src/grades.ts";

docs.registerDocsSource(() => ({ "agents.md": "# Agents\n\nThe prose is the system prompt.\n" }));

const AGENT = "---\nname: writer\n---\n\nWrite the digest.\n";
const GRADER = "---\nname: q\nflow: digest\ntrigger: runs\nsample: 100\nimprove: 2\n---\n\n## cites sources\nexpect:\n  - judge: names its sources\n";

function desk(tenant: string) {
  const ws = path.join(DATA, tenant, "workspaces", "desk");
  fs.mkdirSync(path.join(ws, "agents", "writer"), { recursive: true });
  fs.mkdirSync(path.join(ws, "evals"), { recursive: true });
  fs.mkdirSync(path.join(ws, "flows"), { recursive: true });
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
  fs.writeFileSync(path.join(ws, "agents", "writer", "agent.md"), AGENT);
  fs.writeFileSync(path.join(ws, "flows", "digest.md"), "---\nname: digest\n---\n\n1. [[writer]] — Write it.\n");
  fs.writeFileSync(path.join(ws, "evals", "q.md"), GRADER);
  return ws;
}

const failed = (tenant: string, runId: string, at = new Date().toISOString()) =>
  recordGrade(tenant, "desk", {
    eval: "q", runId, flow: "digest", at, status: "fail", costUsd: 0, model: "m", evalRevision: "e", runRevision: null, runFinishedAt: null, by: "sample",
    checks: [{ name: "cites sources", passed: false, assertions: [{ type: "judge", value: "names its sources", passed: false, detail: "no source is named ".repeat(40) }] }],
  } as Grade);

/** The assistant: proposes a change to the agent, and one to a tool (which must be dropped). */
function proposing(content = "---\nname: writer\n---\n\nWrite the digest. Name the source of every claim.\n") {
  const prompts: string[] = [];
  engine.setAssistantRunner(async ({ tools, prompt }) => {
    prompts.push(prompt);
    await tools.find((t) => t.name === "propose_file")!.run({ path: "agents/writer/agent.md", content });
    await tools.find((t) => t.name === "propose_file")!.run({ path: "tools/send/tool.md", content: "---\nname: send\ntransport: http\n---\n\nSend.\n" });
    return { text: "The agent was never told to cite sources.", costUsd: 0, supply: "mock" };
  });
  return prompts;
}

/** Run the job a proposal queued, as the assistant worker would. */
async function draft(tenant: string) {
  const job = await jobs.claimAssistantJob();
  assert.ok(job, "a job was queued");
  assert.equal(job!.tenant, tenant);
  await jobs.runAssistantJob(job!);
}

test("dueForProposal: enough unreviewed failures, or the oldest a week old; one open at a time; one automatic a day", () => {
  const info = parseEval("q.md", GRADER);
  const g = (id: string, at: string) => ({ runId: id, at, status: "fail" } as Grade);
  const now = Date.parse("2026-10-24T00:00:00Z");
  assert.equal(improve.dueForProposal(info, [g("a", "2026-10-23T00:00:00Z")], [], now), false, "one failure of two");
  assert.equal(improve.dueForProposal(info, [g("a", "2026-10-23T00:00:00Z"), g("b", "2026-10-23T01:00:00Z")], [], now), true);
  assert.equal(improve.dueForProposal(info, [g("a", "2026-10-16T00:00:00Z")], [], now), true, "a week old");
  const open = { eval: "q", status: "ready", by: "ana", createdAt: "2026-10-01T00:00:00Z", failures: [] } as never;
  assert.equal(improve.dueForProposal(info, [g("a", "2026-10-16T00:00:00Z")], [open], now), false, "one is open");
  const auto = { eval: "q", status: "dismissed", by: "auto", createdAt: "2026-10-23T12:00:00Z", failures: [] } as never;
  assert.equal(improve.dueForProposal(info, [g("a", "2026-10-16T00:00:00Z")], [auto], now), false, "one automatic a day");
  assert.equal(improve.dueForProposal(parseEval("q.md", GRADER.replace("improve: 2\n", "")), [g("a", "2026-10-16T00:00:00Z")], [], now), false, "not opted in");
});

test("the prompt is bounded and names the failures, never whole runs", () => {
  const info = parseEval("q.md", GRADER);
  const many = Array.from({ length: 30 }, (_, i) => ({ runId: `run-${i}`, check: "cites sources", detail: "x".repeat(300), at: "t" }));
  const p = improve.improvePrompt(info, many);
  assert.ok(p.length <= 7500);
  assert.match(p, /run-0 · cites sources/);
  assert.doesNotMatch(p, /run-10\b/, "at most ten failures");
  assert.match(p, /Do not change the eval itself/);
});

test("the pass opens a proposal, the draft keeps only agents/flows/skills, apply writes it with a revision", async () => {
  const ws = desk("acme");
  const prompts = proposing();
  failed("acme", "run-1");
  failed("acme", "run-2");
  const opened = await improve.improveWorkspace("acme", "desk", listEvals("acme", "desk").filter((e) => e.trigger === "runs"));
  assert.equal(opened.length, 1);
  assert.equal(opened[0].status, "drafting");
  assert.equal(opened[0].by, "auto");
  assert.equal((await improve.improveWorkspace("acme", "desk")).length, 0, "not twice while one is open");
  await draft("acme");
  assert.match(prompts[0], /run-1 · cites sources/);
  const settled = await improve.settleProposal("acme", (await improve.getProposal("acme", "desk", opened[0].id))!);
  assert.equal(settled.status, "ready");
  assert.deepEqual(settled.files.map((f) => f.path), ["agents/writer/agent.md"]);
  assert.match(settled.notes?.[0] ?? "", /left out.*tools\/send\/tool\.md/);
  assert.equal(settled.files[0].sha256, crypto.createHash("sha256").update(AGENT).digest("hex"));
  assert.match(settled.reply, /never told to cite/);

  const applied = await improve.applyProposal("acme", "desk", settled.id, "ana@example.com");
  assert.equal(applied.status, "applied");
  assert.deepEqual(applied.applied, ["agents/writer/agent.md"]);
  assert.match(fs.readFileSync(path.join(ws, "agents", "writer", "agent.md"), "utf8"), /Name the source of every claim/);
  assert.ok(!fs.existsSync(path.join(ws, "tools", "send")), "the dropped file was never written");
  await assert.rejects(improve.applyProposal("acme", "desk", settled.id, "ana@example.com"), /only a ready one/);

  // The failures it covered are looked at: no new proposal for them.
  const unreviewed = improve.unreviewedGrades((await import("../../foldrun-core/src/grades.ts")).readGrades("acme", "desk", "q"), await improve.listProposals("acme", "desk"), "q");
  assert.equal(unreviewed.length, 0);
  engine.setAssistantRunner(null);
});

test("apply refuses a file changed since the draft, and leaves the proposal ready", async () => {
  const ws = desk("beta");
  proposing();
  failed("beta", "run-1");
  const p = await improve.proposeNow("beta", "desk", "q", "ana@example.com");
  assert.equal(p.by, "ana@example.com");
  await draft("beta");
  const ready = await improve.settleProposal("beta", p);
  fs.writeFileSync(path.join(ws, "agents", "writer", "agent.md"), AGENT + "\nSomeone else's edit.\n");
  await assert.rejects(improve.applyProposal("beta", "desk", ready.id, "ana@example.com"), (e: Error & { status?: number }) => e.status === 409 && /changed since/.test(e.message));
  assert.equal((await improve.getProposal("beta", "desk", ready.id))?.status, "ready");
  const dismissed = await improve.dismissProposal("beta", "desk", ready.id, "ana@example.com");
  assert.equal(dismissed.status, "dismissed");
  assert.match(fs.readFileSync(path.join(ws, "agents", "writer", "agent.md"), "utf8"), /Someone else's edit/, "nothing written");
  engine.setAssistantRunner(null);
});

test("a draft that fails releases its failures; one that never finishes fails after half an hour", async () => {
  desk("gamma");
  engine.setAssistantRunner(async () => {
    throw new Error("the model is down");
  });
  failed("gamma", "run-1");
  const p = await improve.proposeNow("gamma", "desk", "q", "ana@example.com");
  await draft("gamma");
  const settled = await improve.settleProposal("gamma", p);
  assert.equal(settled.status, "failed");
  assert.match(settled.error ?? "", /model is down/);
  const { readGrades } = await import("../../foldrun-core/src/grades.ts");
  assert.equal(improve.unreviewedGrades(readGrades("gamma", "desk", "q"), await improve.listProposals("gamma", "desk"), "q").length, 1, "counted again");
  await improve.dismissProposal("gamma", "desk", settled.id, "ana");
  assert.equal(improve.unreviewedGrades(readGrades("gamma", "desk", "q"), await improve.listProposals("gamma", "desk"), "q").length, 1, "dismissing a failed draft does not cover its failures");

  engine.setAssistantRunner(null);
  const stuck = await improve.proposeNow("gamma", "desk", "q", "ana@example.com");
  assert.equal((await improve.settleProposal("gamma", stuck, Date.now() + 10_000)).status, "drafting");
  assert.equal((await improve.settleProposal("gamma", stuck, Date.now() + 31 * 60_000)).status, "failed");
  await jobs.claimAssistantJob(); // the stuck one, so the next test's claim is its own
});

test("an eval's failed cases can be proposed for by hand; nothing to fix is a 409", async () => {
  const ws = desk("delta");
  fs.writeFileSync(path.join(ws, "evals", "w.md"), "---\nname: w\nagent: writer\n---\n\n## c\ntask: t\nexpect:\n  - contains: x\n");
  await assert.rejects(improve.proposeNow("delta", "desk", "w", "ana"), (e: Error & { status?: number }) => e.status === 409);
  writeEvalResult("delta", "desk", {
    eval: "w", startedAt: "t", finishedAt: new Date().toISOString(), passed: 0, failed: 1, costUsd: 0,
    cases: [{ name: "c", task: "t", runId: "run-9", passed: false, error: null, assertions: [{ assertion: { type: "contains", value: "x" }, passed: false, detail: '"x" not in the output' }], costUsd: 0 }],
  }, "c1");
  proposing();
  const p = await improve.proposeNow("delta", "desk", "w", "ana");
  assert.equal(p.failures[0].case, "c");
  assert.match(p.failures[0].detail, /not in the output/);
  await draft("delta");
  engine.setAssistantRunner(null);
});

test("two requests at once open one proposal; a dismiss after an apply is refused", async () => {
  desk("epsilon");
  proposing();
  failed("epsilon", "run-1");
  const both = await Promise.allSettled([improve.proposeNow("epsilon", "desk", "q", "ana"), improve.proposeNow("epsilon", "desk", "q", "bo")]);
  assert.equal(both.filter((r) => r.status === "fulfilled").length, 1, "one draft, one bill");
  assert.match(String((both.find((r) => r.status === "rejected") as PromiseRejectedResult).reason), /already|a moment ago/);
  await draft("epsilon");
  const [p] = await improve.listProposals("epsilon", "desk");
  const ready = await improve.settleProposal("epsilon", p);
  await improve.applyProposal("epsilon", "desk", ready.id, "ana");
  await assert.rejects(improve.dismissProposal("epsilon", "desk", ready.id, "bo"), /applied — it cannot be dismissed/);
  assert.equal((await improve.getProposal("epsilon", "desk", ready.id))?.status, "applied");
  // The claim is free again once the proposal is decided.
  failed("epsilon", "run-2");
  const next = await improve.proposeNow("epsilon", "desk", "q", "ana");
  assert.equal(next.status, "drafting");
  await draft("epsilon");
  engine.setAssistantRunner(null);
});

test("a fresh claim with no record yet is in progress; a stale one is taken back", async () => {
  desk("zeta");
  proposing();
  failed("zeta", "run-1");
  const { updateNotice } = await import("../src/notices.ts");
  await updateNotice("zeta", "proposal", "desk/~open:q", () => ({ holder: "prop_ghost00000000", at: Date.now() }));
  await assert.rejects(improve.proposeNow("zeta", "desk", "q", "ana"), /being opened right now/);
  await updateNotice("zeta", "proposal", "desk/~open:q", () => ({ holder: "prop_ghost00000000", at: Date.now() - 120_000 }));
  const p = await improve.proposeNow("zeta", "desk", "q", "ana");
  assert.equal(p.status, "drafting");
  await draft("zeta");
  engine.setAssistantRunner(null);
});

test("with a file left out, the kept ones are checked again on their own, and a check error blocks Apply", async () => {
  desk("eta");
  engine.setAssistantRunner(async ({ tools }) => {
    // An agent with no frontmatter (a check error), and a tool, which is left out.
    await tools.find((t) => t.name === "propose_file")!.run({ path: "agents/writer/agent.md", content: "Write, then send.\n" });
    await tools.find((t) => t.name === "propose_file")!.run({ path: "tools/send/tool.md", content: "---\nname: send\ntransport: http\nbase: https://api.example.com\n---\n\nSend.\n" });
    return { text: "Give the writer a send tool.", costUsd: 0, supply: "mock" };
  });
  failed("eta", "run-1");
  const p = await improve.proposeNow("eta", "desk", "q", "ana");
  await draft("eta");
  const ready = await improve.settleProposal("eta", p);
  assert.deepEqual(ready.files.map((f) => f.path), ["agents/writer/agent.md"]);
  assert.ok(ready.issues.every((i) => !i.where.startsWith("tools/")), "nothing about the file left out");
  assert.ok(ready.issues.some((i) => i.level === "error" && i.where.startsWith("agents/writer")), JSON.stringify(ready.issues));
  await assert.rejects(improve.applyProposal("eta", "desk", ready.id, "ana"), (e: Error & { status?: number }) => e.status === 422);
  engine.setAssistantRunner(null);
});

test("a proposal left applying by a dead process is read off the files after five minutes", async () => {
  const ws = desk("theta");
  proposing();
  failed("theta", "run-1");
  const p = await improve.proposeNow("theta", "desk", "q", "ana");
  await draft("theta");
  const ready = await improve.settleProposal("theta", p);
  const { updateNotice } = await import("../src/notices.ts");
  await updateNotice("theta", "proposal", `desk/${ready.id}`, (prev: any) => ({ ...prev, status: "applying", updatedAt: new Date().toISOString() }));
  const stuck = (await improve.getProposal("theta", "desk", ready.id))!;
  assert.equal((await improve.settleProposal("theta", stuck)).status, "applying", "not yet: it may still be applying");
  assert.equal((await improve.settleProposal("theta", stuck, Date.now() + 6 * 60_000)).status, "ready", "nothing written: ready again");
  fs.writeFileSync(path.join(ws, "agents", "writer", "agent.md"), ready.files[0].content);
  await updateNotice("theta", "proposal", `desk/${ready.id}`, (prev: any) => ({ ...prev, status: "applying", updatedAt: new Date().toISOString() }));
  const again = (await improve.getProposal("theta", "desk", ready.id))!;
  assert.equal((await improve.settleProposal("theta", again, Date.now() + 6 * 60_000)).status, "applied", "every file written: applied");
  engine.setAssistantRunner(null);
});

test("Apply checks against the workspace as it is now: an agent deleted since the draft refuses it", async () => {
  const ws = desk("kappa");
  fs.mkdirSync(path.join(ws, "agents", "editor"), { recursive: true });
  fs.writeFileSync(path.join(ws, "agents", "editor", "agent.md"), "---\nname: editor\n---\n\nEdit.\n");
  engine.setAssistantRunner(async ({ tools }) => {
    await tools.find((t) => t.name === "propose_file")!.run({ path: "flows/digest.md", content: "---\nname: digest\n---\n\n1. [[writer]] — Write it.\n2. [[editor]] — Edit it.\n" });
    return { text: "Add an editing step.", costUsd: 0, supply: "mock" };
  });
  failed("kappa", "run-1");
  const p = await improve.proposeNow("kappa", "desk", "q", "ana");
  await draft("kappa");
  const ready = await improve.settleProposal("kappa", p);
  assert.equal(ready.status, "ready", JSON.stringify(ready.issues));
  fs.rmSync(path.join(ws, "agents", "editor"), { recursive: true });
  await assert.rejects(improve.applyProposal("kappa", "desk", ready.id, "ana"), (e: Error & { status?: number }) => e.status === 422 && /editor/.test(e.message));
  assert.equal((await improve.getProposal("kappa", "desk", ready.id))?.status, "ready");
  assert.match(fs.readFileSync(path.join(ws, "flows", "digest.md"), "utf8"), /^---\nname: digest/, "the flow was not rewritten");
  assert.doesNotMatch(fs.readFileSync(path.join(ws, "flows", "digest.md"), "utf8"), /editor/);
  engine.setAssistantRunner(null);
});

test("settleAccount copies in a hand-asked draft on a case eval, with no graders anywhere", async () => {
  const ws = desk("lambda");
  fs.rmSync(path.join(ws, "evals", "q.md"));
  fs.writeFileSync(path.join(ws, "evals", "w.md"), "---\nname: w\nagent: writer\n---\n\n## c\ntask: t\nexpect:\n  - contains: x\n");
  writeEvalResult("lambda", "desk", { eval: "w", startedAt: "t", finishedAt: new Date().toISOString(), passed: 0, failed: 1, costUsd: 0, cases: [{ name: "c", task: "t", runId: "r", passed: false, error: null, assertions: [{ assertion: { type: "contains", value: "x" }, passed: false, detail: "no" }], costUsd: 0 }] }, "c1");
  proposing();
  const p = await improve.proposeNow("lambda", "desk", "w", "ana");
  await draft("lambda");
  assert.equal(await improve.settleAccount("lambda"), 1);
  assert.equal((await improve.getProposal("lambda", "desk", p.id))?.status, "ready");
  engine.setAssistantRunner(null);
});

test("a draft that outlived its half hour is copied in when it finishes after all", async () => {
  desk("mu");
  proposing();
  failed("mu", "run-1");
  const p = await improve.proposeNow("mu", "desk", "q", "ana");
  const late = await improve.settleProposal("mu", p, Date.now() + 31 * 60_000);
  assert.equal(late.status, "failed");
  assert.equal(late.timedOut, true);
  await draft("mu");
  const now = await improve.settleProposal("mu", (await improve.getProposal("mu", "desk", p.id))!);
  assert.equal(now.status, "ready", "the paid-for draft is not thrown away");
  engine.setAssistantRunner(null);
});
