// The assistant's queue, conversations and event log on the real stores:
// Postgres (SKIP LOCKED claims, the per-account cap in the claim SQL, the
// stale-claim reaper, the conversation table and its search) and Redis
// Streams (ordered events with a cursor). Skipped without both.
//
//   FOLDRUN_TEST_DATABASE_URL=postgres://foldrun:test@localhost:55432/foldrun \
//   FOLDRUN_TEST_REDIS_URL=redis://localhost:56379 \
//     node --test tests/assistant-db.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
const redis = process.env.FOLDRUN_TEST_REDIS_URL;
const opts = { skip: url && redis ? false : "set FOLDRUN_TEST_DATABASE_URL and FOLDRUN_TEST_REDIS_URL to run against Postgres and Redis" };

if (url && redis) {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  process.env.FOLDRUN_REDIS_URL = redis;
  process.env.FOLDRUN_SECRET_KEY ??= "test-install-key";
  process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-assistant-db-"));
}

const T = `acme${Date.now().toString(36)}`;

test("Postgres queue: oldest first, never twice, the account cap, and a dead claim ends in an error", opts, async () => {
  const { migrate, orm } = await import("../src/db.ts");
  await migrate();
  const { sql } = await import("drizzle-orm");
  const jobs = await import("../src/assistant/jobs.ts");
  await orm()!.execute(sql`DELETE FROM assistant_jobs`);
  const job = (tenant = T) => ({ id: jobs.newJobId(), tenant, workspace: "desk", owner: "user:u1", conversation: null, request: { messages: [{ role: "user" as const, content: "hi" }] } });

  const first = job();
  await jobs.enqueueAssistantJob(first);
  const rest = [];
  for (let i = 0; i < jobs.ACCOUNT_CAP + 1; i++) {
    const j = job();
    await jobs.enqueueAssistantJob(j);
    rest.push(j);
  }
  const other = job(`${T}other`);
  await jobs.enqueueAssistantJob(other);

  // One worker claims one at a time: the account's cap holds exactly, and
  // the other account is not held behind it.
  const got: string[] = [];
  for (let i = 0; i < jobs.ACCOUNT_CAP + 2; i++) {
    const j = await jobs.claimAssistantJob();
    if (j) got.push(j.id);
  }
  assert.equal(got[0], first.id, "oldest first");
  assert.ok(got.includes(other.id), "another account is not held behind this one");
  assert.equal(got.filter((id) => id !== other.id).length, jobs.ACCOUNT_CAP, "exactly the account's cap");

  // Many workers at the same instant: no row claimed twice, and — the
  // per-account advisory lock — one account never past its cap, however the
  // claims interleave.
  await orm()!.execute(sql`DELETE FROM assistant_jobs`);
  const one = Array.from({ length: 8 }, () => job(`${T}one`));
  const burst = Array.from({ length: 6 }, () => job(`${T}burst${Math.random().toString(36).slice(2, 6)}`));
  for (const j of [...one, ...burst]) await jobs.enqueueAssistantJob(j);
  const simultaneous = await Promise.all(Array.from({ length: 12 }, () => jobs.claimAssistantJob()));
  const held = simultaneous.filter(Boolean).map((j) => j!);
  assert.equal(new Set(held.map((j) => j.id)).size, held.length, "no job claimed twice");
  assert.ok(held.filter((j) => j.tenant === `${T}one`).length <= jobs.ACCOUNT_CAP, "one account never past its cap, even at the same instant");
  // Rounds until nothing more may be claimed: every other job, once.
  const ids = held.map((j) => j.id);
  for (let round = 0; round < 6; round++) {
    const more = await Promise.all(Array.from({ length: 8 }, () => jobs.claimAssistantJob()));
    ids.push(...more.filter(Boolean).map((j) => j!.id));
  }
  assert.equal(new Set(ids).size, ids.length, "still no job claimed twice");
  assert.ok(burst.every((j) => ids.includes(j.id)), "every other account's job claimed");
  assert.equal(ids.filter((id) => one.some((j) => j.id === id)).length, jobs.ACCOUNT_CAP, "the capped account: exactly its cap running");

  // A claim whose heartbeat stopped long ago belongs to a dead worker.
  const dead = burst[0];
  await orm()!.execute(sql`UPDATE assistant_jobs SET heartbeat_at = now() - interval '10 minutes' WHERE id = ${dead.id}`);
  assert.equal(await jobs.reapStaleAssistantJobs(), 1);
  const { events } = await jobs.readJobEvents(dead.tenant, dead.id);
  assert.equal(events[events.length - 1].type, "error");
  const left = await orm()!.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM assistant_jobs WHERE id = ${dead.id}`);
  assert.equal(left.rows[0].n, 0, "not put back in line");
});

test("Redis Streams: events in order, read on from a cursor", opts, async () => {
  const jobs = await import("../src/assistant/jobs.ts");
  const id = jobs.newJobId();
  await Promise.all([
    jobs.appendJobEvent(T, id, { type: "queued" }),
    jobs.appendJobEvent(T, id, { type: "started" }),
    jobs.appendJobEvent(T, id, { type: "text", text: "a" }),
  ]);
  const first = await jobs.readJobEvents(T, id);
  assert.deepEqual(first.events.map((e) => e.type), ["queued", "started", "text"], "in the order written");
  await jobs.appendJobEvent(T, id, { type: "text", text: "b" });
  const next = await jobs.readJobEvents(T, id, first.cursor);
  assert.deepEqual(next.events, [{ type: "text", text: "b" }], "only what came after the cursor");
  assert.equal(fs.existsSync(jobs.eventsFile(T, id)), false, "nothing on the shared volume");
});

test("Redis: many followers share one blocking read, and each sees its own reply to the end", opts, async () => {
  const jobs = await import("../src/assistant/jobs.ts");
  const ids = Array.from({ length: 5 }, () => jobs.newJobId());
  const seen = new Map<string, string[]>(ids.map((i) => [i, []]));
  const follows = ids.map((i) => jobs.followJob(T, i, (e) => seen.get(i)!.push(e.type), { timeoutMs: 20_000 }));
  await new Promise((r) => setTimeout(r, 200));
  for (const i of ids) {
    await jobs.appendJobEvent(T, i, { type: "started" });
    await jobs.appendJobEvent(T, i, { type: "text", text: i });
  }
  for (const i of ids) await jobs.appendJobEvent(T, i, { type: "done", result: { reply: i, files: [], issues: [], sources: [], supply: "mock", workspace: null, usage: null, chargedUsd: null }, conversation: "" });
  const ends = await Promise.all(follows);
  assert.ok(ends.every((e) => e?.type === "done"));
  for (const i of ids) assert.equal(seen.get(i)!.filter((t) => t === "done").length, 1, "the end once, not twice (log and end file)");
});

test("Redis: two followers of one reply each read every event once", opts, async () => {
  const jobs = await import("../src/assistant/jobs.ts");
  const id = jobs.newJobId();
  const a: string[] = [];
  const b: string[] = [];
  const first = jobs.followJob(T, id, (e) => a.push(e.type === "text" ? e.text : e.type), { timeoutMs: 20_000 });
  await jobs.appendJobEvent(T, id, { type: "text", text: "one" });
  await new Promise((r) => setTimeout(r, 1_300));
  // A second tab joins late: it still reads from the start, and the first is not disturbed.
  const second = jobs.followJob(T, id, (e) => b.push(e.type === "text" ? e.text : e.type), { timeoutMs: 20_000 });
  await jobs.appendJobEvent(T, id, { type: "text", text: "two" });
  await jobs.appendJobEvent(T, id, { type: "done", result: { reply: "x", files: [], issues: [], sources: [], supply: "mock", workspace: null, usage: null, chargedUsd: null }, conversation: "" });
  await Promise.all([first, second]);
  assert.deepEqual(a, ["one", "two", "done"]);
  assert.deepEqual(b, ["one", "two", "done"]);
  assert.equal(jobs.streamIdBefore("0", "1-0"), true);
  assert.equal(jobs.streamIdBefore("5-2", "5-10"), true, "compared as numbers");
  assert.equal(jobs.streamIdBefore("6-0", "5-10"), false);
});

test("Postgres conversations: owner-only, newest first, searched in the text", opts, async () => {
  const c = await import("../src/assistant/conversations.ts");
  const a = await c.saveConversation(T, { workspace: "desk", owner: "user:u1", messages: [{ role: "user", content: "weekly flow please" }], files: [] });
  const b = await c.saveConversation(T, { workspace: "desk", owner: "user:u1", messages: [{ role: "user", content: "a skill" }, { role: "assistant", content: "Proposed skills/tone/SKILL.md 100%_done" }], files: [] });
  await c.saveConversation(T, { id: a, workspace: "desk", owner: "user:u2", messages: [{ role: "user", content: "hijack" }], files: [] });
  const mine = await c.listConversations(T, "user:u1");
  assert.deepEqual(mine.map((x) => x.id).slice(0, 2), [b, a]);
  assert.equal((await c.getConversation(T, "user:u1", a))?.messages[0].content, "weekly flow please", "another owner's save did not take it over");
  assert.deepEqual((await c.listConversations(T, "user:u1", { q: "skills/tone" })).map((x) => x.id), [b], "the text is searched");
  assert.deepEqual((await c.listConversations(T, "user:u1", { q: "100%_" })).map((x) => x.id), [b], "% and _ are literal");
  assert.equal(await c.deleteConversation(T, "user:u2", b), false);
  assert.equal(await c.deleteConversation(T, "user:u1", b), true);
  const { closeDatabase } = await import("../src/db.ts").catch(() => ({ closeDatabase: undefined }));
  if (typeof closeDatabase === "function") await closeDatabase();
});

test.after(async () => {
  if (!(url && redis)) return;
  const { cache } = await import("../src/cache.ts");
  cache()?.disconnect();
  const db = (await import("../src/db.ts")) as { closeDatabase?: () => Promise<void> };
  await db.closeDatabase?.();
});
