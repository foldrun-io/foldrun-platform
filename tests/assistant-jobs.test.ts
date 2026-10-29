// Assistant replies as queued work: a job is claimed once, at most
// accountCap() of one account run at once, a job whose worker went away is
// ended with an error rather than run again (it may already have spent),
// and a follower sees queued → started → … → done. File queue here; the
// Postgres queue is the same API with SKIP LOCKED.
//
//   node --test tests/assistant-jobs.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-assistant-jobs-"));
process.env.FOLDRUN_DATA = DATA;
delete process.env.FOLDRUN_DATABASE_URL;

const jobs = await import("../src/assistant/jobs.ts");
const engine = await import("../src/assistant/engine.ts");
const conversations = await import("../src/assistant/conversations.ts");
const docs = await import("../src/assistant/docs.ts");

docs.registerDocsSource(() => ({ "flows.md": "# Flows\n\n## Routing\n\n`when: rows of <path>` runs a step only if the CSV has a data row.\n" }));

const T = "acme";
const ws = path.join(DATA, T, "workspaces", "desk");
fs.mkdirSync(path.join(ws, "agents/writer"), { recursive: true });
fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
fs.writeFileSync(path.join(ws, "agents/writer/agent.md"), "---\nname: writer\n---\n\nWrite.\n");

const job = (over: Partial<import("../src/assistant/jobs.ts").AssistantJob> = {}) => ({
  id: jobs.newJobId(),
  tenant: T,
  workspace: "desk",
  owner: "user:u1",
  conversation: null,
  request: { messages: [{ role: "user" as const, content: "how do I skip a step?" }] },
  ...over,
});

test("claimed once, oldest first, and no more than the account's cap at a time", async () => {
  const a = job();
  const b = job();
  await jobs.enqueueAssistantJob(a);
  await new Promise((r) => setTimeout(r, 2));
  await jobs.enqueueAssistantJob(b);
  const first = await jobs.claimAssistantJob();
  assert.equal(first?.id, a.id, "oldest first");
  const second = await jobs.claimAssistantJob();
  assert.equal(second?.id, b.id);
  assert.equal(await jobs.claimAssistantJob(), null, "nothing claimed twice");

  // Fill the account to its cap; the next of ITS jobs waits, another account's does not.
  const extra = [];
  for (let i = 2; i < jobs.accountCap() + 1; i++) {
    const j = job();
    await jobs.enqueueAssistantJob(j);
    extra.push(await jobs.claimAssistantJob());
  }
  const waiting = job();
  await jobs.enqueueAssistantJob(waiting);
  const otherAccount = job({ tenant: "other" });
  await jobs.enqueueAssistantJob(otherAccount);
  const next = await jobs.claimAssistantJob();
  assert.equal(next?.id, otherAccount.id, "the capped account is stepped over");
});

test("a reply runs to done, writes its events and keeps the conversation", async () => {
  engine.setAssistantRunner(async ({ tools, onText }) => {
    await tools.find((t) => t.name === "search_docs")!.run({ query: "when rows of" });
    onText("Use ");
    onText("`when: rows of`.");
    return { text: "Use `when: rows of`.", costUsd: 0, supply: "mock" };
  });
  const j = job({ tenant: "solo" });
  fs.mkdirSync(path.join(DATA, "solo", "workspaces", "desk"), { recursive: true });
  fs.writeFileSync(path.join(DATA, "solo", "workspaces", "desk", "AGENTS.md"), "---\nname: desk\n---\n");
  await jobs.enqueueAssistantJob(j);
  const seen: string[] = [];
  const following = jobs.followJob("solo", j.id, (e) => seen.push(e.type), { pollMs: 10, timeoutMs: 10_000 });
  const claimed = await jobs.claimAssistantJob();
  assert.equal(claimed?.id, j.id);
  await jobs.runAssistantJob(claimed!);
  const end = await following;
  assert.equal(end?.type, "done");
  assert.deepEqual(seen.filter((t, i) => seen.indexOf(t) === i), ["queued", "started", "status", "text", "done"]);
  const conv = (end as { conversation: string }).conversation;
  const kept = await conversations.getConversation("solo", "user:u1", conv);
  assert.equal(kept?.messages.length, 2);
  assert.equal(kept?.messages[1].content, "Use `when: rows of`.");
  assert.equal(await jobs.claimAssistantJob(), null, "released when done");
  engine.setAssistantRunner(null);
});

test("a job whose worker went away ends with an error and is never run again", async () => {
  const j = job({ tenant: "crash" });
  await jobs.enqueueAssistantJob(j);
  const claimed = await jobs.claimAssistantJob();
  assert.equal(claimed?.id, j.id);
  // The worker died holding it: age the claim past the file store's limit.
  const claimFile = path.join(DATA, ".assistant-queue", "claimed", `${j.id}.json`);
  const old = new Date(Date.now() - 3_600_000);
  fs.utimesSync(claimFile, old, old);
  assert.equal(await jobs.reapStaleAssistantJobs(), 1);
  const { events } = await jobs.readJobEvents("crash", j.id);
  const last = events[events.length - 1];
  assert.equal(last.type, "error");
  assert.match((last as { error: string }).error, /went away/);
  assert.equal(await jobs.claimAssistantJob(), null, "not put back in line");
});

test("a follower that times out gets an error, and a stop ends it quietly", async () => {
  const j = job({ tenant: "slow" });
  await jobs.enqueueAssistantJob(j);
  const timedOut = await jobs.followJob("slow", j.id, () => undefined, { pollMs: 5, timeoutMs: 30 });
  assert.equal(timedOut?.type, "error");
  const stop = new AbortController();
  const following = jobs.followJob("slow", j.id, () => undefined, { pollMs: 5, signal: stop.signal });
  stop.abort();
  assert.equal(await following, null);
  assert.equal((await jobs.readJobEvents("slow", "../../etc/passwd")).events.length, 0, "an id is a shape, not a path");
});

test("the end is found from the end file even when the log never got it", async () => {
  const id = jobs.newJobId();
  await jobs.appendJobEvent("lossy", id, { type: "queued" });
  // As if the log write of the end failed: only the end file has it.
  fs.mkdirSync(path.dirname(jobs.endFile("lossy", id)), { recursive: true });
  fs.writeFileSync(jobs.endFile("lossy", id), JSON.stringify({ type: "error", error: "x", status: 500 }));
  const end = await jobs.followJob("lossy", id, () => undefined, { pollMs: 5, timeoutMs: 5_000 });
  assert.equal(end?.type, "error");
  // And appendJobEvent writes the end file for every last event.
  const id2 = jobs.newJobId();
  await jobs.appendJobEvent("lossy", id2, { type: "error", error: "y", status: 503 });
  assert.equal(jobs.readJobEnd("lossy", id2)?.type, "error");
});
