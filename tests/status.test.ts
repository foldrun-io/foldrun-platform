// The status page's records: the sampler's five-minute rows, the 90-day
// history built from them, incidents and maintenance, and the read that
// combines them. File mode by default; against Postgres when one is offered
// (the same rows, through the Drizzle queries). Fetch is faked — nothing
// here reaches a real host.
//
//   node --test tests/status.test.ts
//   FOLDRUN_TEST_DATABASE_URL=postgres://foldrun:test@localhost:55432/foldrun node --test tests/status.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-status-"));
delete process.env.FOLDRUN_DATABASE_URL;
delete process.env.FOLDRUN_REDIS_URL;
const pg = process.env.FOLDRUN_TEST_DATABASE_URL;
if (pg) {
  const u = new URL(pg);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  await (await import("../src/db.ts")).migrate();
}
delete process.env.FOLDRUN_PUBLIC_URL;
process.env.FOLDRUN_ROLE = "all";
process.env.FOLDRUN_STATUS_CACHE_MS = "0";
process.env.FOLDRUN_STATUS_HISTORY_CACHE_MS = "0";

const status = await import("../src/status.ts");
const { writeRun } = await import("../../foldrun-core/src/store.ts");

const realFetch = globalThis.fetch;
function hosts(answers: Record<string, number | "down">) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    const host = new URL(url).host;
    const a = answers[host];
    if (a === undefined || a === "down") throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ ok: true }), { status: a });
  }) as typeof fetch;
  return calls;
}
test.afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.FOLDRUN_RESEND_API_KEY;
});

const T0 = Date.parse("2026-10-01T10:00:00Z");

test.after(async () => {
  if (pg) await (await import("../src/db.ts")).db()?.end();
});

test("a sample writes one row per component into its five-minute bucket, at most once per interval", async () => {
  await status.resetStatus();
  process.env.FOLDRUN_RESEND_API_KEY = "re_test";
  const calls = hosts({ "api.anthropic.com": 404, "api.resend.com": 200 });
  assert.equal(await status.maybeSampleStatus(T0 + 61_000), true);
  assert.equal(await status.maybeSampleStatus(T0 + 120_000), false, "throttled inside the interval");
  assert.ok(calls.some((u) => u.includes("api.anthropic.com")) && calls.some((u) => u.includes("api.resend.com")));
  const latest = await status.latestSamples(T0 - 1);
  assert.deepEqual(Object.keys(latest).sort(), ["email", "providers", "scheduler", "storage", "web", "workers"]);
  assert.equal(latest.providers!.status, "operational", "a 404 is a host that answered");
  assert.equal(latest.email!.status, "operational");
  assert.equal(latest.web!.status, "operational", "role all: the sampler is the web");
  assert.equal(latest.workers!.status, "outage", "no worker lease in this test");
  assert.equal(latest.scheduler!.status, "operational");
  assert.equal(latest.storage!.status, "operational");
  assert.equal(latest.web!.at, T0, "floored to the bucket");
});

test("an unreachable or failing provider is an outage or degraded; no mail key is unknown, not down", async () => {
  await status.resetStatus();
  hosts({ "api.anthropic.com": "down" });
  let p = await status.probeAll(T0);
  assert.equal(p.providers.status, "outage");
  assert.match(p.providers.detail, /did not answer/);
  assert.equal(p.email.status, "unknown");
  hosts({ "api.anthropic.com": 503 });
  p = await status.probeAll(T0);
  assert.equal(p.providers.status, "degraded");
});

test("web is probed through the public address's healthz when there is one", async () => {
  process.env.FOLDRUN_PUBLIC_URL = "https://box.example";
  try {
    const calls = hosts({ "api.anthropic.com": 404, "box.example": 500 });
    const p = await status.probeAll(T0);
    assert.ok(calls.includes("https://box.example/api/healthz"));
    assert.equal(p.web.status, "outage");
  } finally {
    delete process.env.FOLDRUN_PUBLIC_URL;
  }
});

test("provider errors in recent step attempts are counted; old runs are not opened", async () => {
  await status.resetStatus();
  const ws = path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk");
  fs.mkdirSync(path.join(ws, "flows"), { recursive: true });
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
  const now = Date.now();
  const attempt = (status: "completed" | "failed", error?: string) => ({ n: 1, status, costUsd: 0, tokens: null, computeSecs: null, startedAt: new Date(now - 60_000).toISOString(), finishedAt: new Date(now - 30_000).toISOString(), ...(error ? { error } : {}) });
  const step = (tries: unknown[]) => ({ agent: "a", instruction: "x", group: 1, optional: false, status: "failed", events: [], result: null, costUsd: 0, tries });
  writeRun("acme", "desk", {
    id: `run-${(now - 120_000).toString(36)}-aaaa`,
    flow: "daily",
    status: "failed",
    startedAt: new Date(now - 120_000).toISOString(),
    finishedAt: new Date(now).toISOString(),
    steps: [
      step([attempt("failed", 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}'), attempt("failed", "API Error: 401 authentication_error")]),
      step([attempt("failed", "verify failed: grep exited 1"), attempt("completed")]),
    ],
  } as never);
  // A run from last week with a provider error: outside the window, never read.
  writeRun("acme", "desk", {
    id: `run-${(now - 7 * 86_400_000).toString(36)}-bbbb`,
    flow: "daily",
    status: "failed",
    startedAt: new Date(now - 7 * 86_400_000).toISOString(),
    finishedAt: null,
    steps: [step([attempt("failed", "overloaded_error"), attempt("failed", "overloaded_error"), attempt("failed", "overloaded_error")])],
  } as never);
  const scan = status.providerErrors(now);
  assert.deepEqual(scan, { attempts: 4, failed: 1 }, "the overload; one account's 401 is its own credential");
  hosts({ "api.anthropic.com": 404 });
  const p = await status.probeAll(now);
  assert.equal(p.providers.status, "operational");
  assert.match(p.providers.detail, /1 provider error\(s\) in 4 attempt/);
  fs.rmSync(path.join(process.env.FOLDRUN_DATA!, "acme"), { recursive: true, force: true });
});

test("run ids carry their start time", () => {
  assert.equal(status.runStartedAt("run-mu4sdg8z-1otr.json"), Date.parse("2026-09-17T00:23:21.731Z"));
  assert.equal(status.runStartedAt("notes.json"), null);
});

test("history: daily uptime per component over the window; unknown samples do not count; ninety days kept", async () => {
  await status.resetStatus();
  const day = 86_400_000;
  const now = Date.parse("2026-10-01T12:00:00Z");
  const rows: Parameters<typeof status.writeSamples>[0] = [];
  // Yesterday: 3 operational, 1 outage for workers. Today: 2 operational.
  for (let i = 0; i < 3; i++) rows.push({ component: "workers", at: now - day + i * 300_000, status: "operational", detail: "" });
  rows.push({ component: "workers", at: now - day + 3 * 300_000, status: "outage", detail: "no lease" });
  rows.push({ component: "workers", at: now, status: "operational", detail: "" }, { component: "workers", at: now + 300_000, status: "operational", detail: "" });
  rows.push({ component: "email", at: now, status: "unknown", detail: "no key" });
  // 100 days ago: pruned.
  rows.push({ component: "workers", at: now - 100 * day, status: "outage", detail: "" });
  await status.writeSamples(rows);
  await status.pruneSamples(now);
  const h = await status.statusHistory(90, now);
  assert.equal(h.days, 90);
  const workers = h.components.find((c) => c.id === "workers")!;
  assert.equal(workers.days.length, 90);
  assert.equal(workers.days.at(-1)!.date, "2026-10-01");
  assert.equal(workers.days.at(-2)!.uptime, 0.75);
  assert.equal(workers.days.at(-1)!.uptime, 1);
  assert.equal(workers.days[0].uptime, null, "no samples: no figure, not 100%");
  assert.equal(workers.uptime, 5 / 6);
  const email = h.components.find((c) => c.id === "email")!;
  assert.equal(email.days.at(-1)!.uptime, null);
  assert.equal(email.days.at(-1)!.samples, 1);
  if (!pg) {
    const files = fs.readdirSync(path.join(process.env.FOLDRUN_DATA!, "status"));
    assert.ok(!files.some((f) => f.includes("2026-06-23")), "the 100-day-old file is gone");
  }
  assert.equal(Object.keys(await status.latestSamples(now - 101 * day)).length, 2, "workers and email; the pruned row is gone");
  assert.equal((await status.statusHistory(7, now)).components[0].days.length, 7);
  assert.equal((await status.statusHistory(999, now)).days, 90, "clamped");
});

test("history is memoised per window for a short while, one query shared by concurrent callers, a failure not kept", async () => {
  await status.resetStatus();
  process.env.FOLDRUN_STATUS_HISTORY_CACHE_MS = "60000";
  try {
    const now = Date.parse("2026-10-01T12:00:00Z");
    await status.writeSamples([{ component: "workers", at: now - 600_000, status: "operational", detail: "" }]);
    const [a, b] = await Promise.all([status.statusHistory(7, now), status.statusHistory(7, now)]);
    assert.equal(a, b, "two concurrent misses share one computation");
    await status.writeSamples([{ component: "workers", at: now - 300_000, status: "outage", detail: "" }]);
    assert.equal(await status.statusHistory(7, now + 1000), a, "within the window: the cached answer, no new query");
    assert.notEqual(await status.statusHistory(30, now + 1000), a, "each window is its own entry");
    const later = await status.statusHistory(7, now + 61_000);
    assert.notEqual(later, a, "past the window: computed again");
    assert.equal(later.components.find((c) => c.id === "workers")!.days.at(-1)!.outage, 1);
    status.resetStatusSampler();
    assert.notEqual(await status.statusHistory(7, now + 62_000), later, "tests can drop the cache");
    if (!pg) {
      // A day file that cannot be read makes the query fail; the failure is
      // not served from the cache once the cause is gone.
      status.resetStatusSampler();
      const bad = path.join(process.env.FOLDRUN_DATA!, "status", "samples-2026-09-30.jsonl");
      fs.mkdirSync(bad, { recursive: true });
      await assert.rejects(status.statusHistory(7, now));
      fs.rmSync(bad, { recursive: true });
      assert.equal((await status.statusHistory(7, now + 1000)).days, 7, "a rejected query is dropped, not cached");
    }
  } finally {
    process.env.FOLDRUN_STATUS_HISTORY_CACHE_MS = "0";
    status.resetStatusSampler();
  }
});

test("incidents: post, update, resolve; maintenance windows; validation", async () => {
  await status.resetStatus();
  const now = Date.parse("2026-10-01T12:00:00Z");
  await assert.rejects(status.createIncident({ title: "x" }, "boss@x"), /body is required/);
  await assert.rejects(status.createIncident({ title: "x", body: "y", components: ["nope"] }, "boss@x"), /unknown component/);
  await assert.rejects(status.createIncident({ kind: "maintenance", title: "x", body: "y" }, "boss@x"), /endsAt/);
  await assert.rejects(status.createIncident({ title: "x", body: "y", status: "completed" }, "boss@x"), /investigating/);
  const inc = await status.createIncident({ title: "Runs are slow", body: "Looking into it.", impact: "major", components: ["workers"] }, "boss@x", now);
  assert.equal(inc.status, "investigating");
  assert.ok(status.isActive(inc, now));
  const upd = await status.updateIncident(inc.id, { status: "identified", body: "A stuck node." }, "boss@x", now + 60_000);
  assert.equal(upd!.updates.length, 2);
  await assert.rejects(status.updateIncident(inc.id, {}, "boss@x"), /nothing to change/);
  const done = await status.updateIncident(inc.id, { status: "resolved", body: "Fixed." }, "boss@x", now + 120_000);
  assert.ok(done!.resolvedAt);
  assert.ok(!status.isActive(done!, now + 200_000));
  const m = await status.createIncident({ kind: "maintenance", title: "Database upgrade", body: "Ten minutes.", components: ["storage"], startsAt: new Date(now + 3600_000).toISOString(), endsAt: new Date(now + 4200_000).toISOString() }, "boss@x", now);
  assert.equal(m.impact, "maintenance");
  assert.ok(status.isUpcoming(m, now) && !status.isActive(m, now));
  assert.ok(status.isActive(m, now + 3700_000));
  assert.ok(!status.isActive(m, now + 5000_000), "the window closed");
  assert.equal(status.publicIncident(inc).updates[0].body, "Looking into it.");
  assert.equal(JSON.stringify(status.publicIncident(inc)).includes("boss@x"), false, "no author address in the public view");
  assert.equal((await status.listIncidents()).length, 2);
  assert.equal(await status.deleteIncident(m.id), true);
  assert.equal(await status.deleteIncident(m.id), false);
});

test("the read: live checks, fresh samples, a stalled scheduler, and incidents raising components", async () => {
  await status.resetStatus();
  const now = Date.now();
  let r = await status.currentStatus(now);
  assert.equal(r.components.find((c) => c.id === "scheduler")!.status, "unknown", "no sample yet");
  assert.equal(r.components.find((c) => c.id === "web")!.status, "operational");
  await status.writeSamples(status.COMPONENTS.map((c) => ({ component: c.id, at: now - 60_000, status: "operational" as const, detail: "ok" })));
  r = await status.currentStatus(now);
  assert.equal(r.components.find((c) => c.id === "providers")!.status, "operational");
  assert.equal(r.components.find((c) => c.id === "scheduler")!.status, "operational");
  // Twenty minutes with no sample: the scheduler stopped.
  r = await status.currentStatus(now + 20 * 60_000);
  assert.equal(r.components.find((c) => c.id === "scheduler")!.status, "outage");
  assert.equal(r.components.find((c) => c.id === "providers")!.status, "unknown", "a stale probe is not reported as current");
  assert.equal(r.status, "outage");
  // A fresh sample, and a minor incident on email.
  await status.writeSamples(status.COMPONENTS.map((c) => ({ component: c.id, at: now, status: "operational" as const, detail: "ok" })));
  await status.createIncident({ title: "Mail delayed", body: "Resend is slow.", components: ["email"] }, "boss@x", now);
  r = await status.currentStatus(now + 1000);
  assert.equal(r.components.find((c) => c.id === "email")!.status, "degraded");
  assert.equal(r.incidents.length, 1);
  assert.ok(["degraded", "outage"].includes(r.status));
  assert.deepEqual(Object.keys(r).sort(), ["components", "description", "incidents", "maintenance", "status", "updatedAt"]);
});

test("the read is cached briefly and concurrent misses share one computation", async () => {
  await status.resetStatus();
  process.env.FOLDRUN_STATUS_CACHE_MS = "15000";
  try {
    const now = Date.now();
    const [a, b] = await Promise.all([status.currentStatus(now), status.currentStatus(now)]);
    assert.equal(a, b, "two concurrent misses share one computation");
    assert.equal(await status.currentStatus(now + 1000), a, "within the window: cached");
    assert.notEqual(await status.currentStatus(now + 16_000), a, "past the window: computed again");
  } finally {
    process.env.FOLDRUN_STATUS_CACHE_MS = "0";
    status.resetStatusSampler();
  }
});

test("a scheduler silent for more than a day is an outage, not \"no sample yet\"", async () => {
  await status.resetStatus();
  const now = Date.now();
  await status.writeSamples(status.COMPONENTS.map((c) => ({ component: c.id, at: now - 30 * 3600_000, status: "operational" as const, detail: "ok" })));
  const r = await status.currentStatus(now);
  const scheduler = r.components.find((c) => c.id === "scheduler")!;
  assert.equal(scheduler.status, "outage", scheduler.detail);
  assert.match(scheduler.detail, /has not ticked for 1800 min/);
  assert.equal(r.status, "outage");
});

test("one account's refused credential — its own key, BYOK — is not a provider outage; two accounts' is", async () => {
  await status.resetStatus();
  const now = Date.now();
  const attempt = (error: string) => ({ n: 1, status: "failed", costUsd: 0, tokens: null, computeSecs: null, startedAt: new Date(now - 60_000).toISOString(), finishedAt: new Date(now - 30_000).toISOString(), error });
  const put = (tenant: string, tag: string) => {
    const ws = path.join(process.env.FOLDRUN_DATA!, `${tenant}/workspaces/desk`);
    fs.mkdirSync(path.join(ws, "flows"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    writeRun(tenant, "desk", {
      id: `run-${(now - 120_000).toString(36)}-${tag}`,
      flow: "daily",
      status: "failed",
      startedAt: new Date(now - 120_000).toISOString(),
      finishedAt: new Date(now).toISOString(),
      steps: [{ agent: "a", instruction: "x", group: 1, optional: false, status: "failed", events: [], result: null, costUsd: 0, tries: [attempt("API Error: 401 authentication_error"), attempt("invalid x-api-key"), attempt("OAuth token has expired")] }],
    } as never);
  };
  put("byok", "cccc");
  hosts({ "api.anthropic.com": 404 });
  assert.deepEqual(status.providerErrors(now), { attempts: 3, failed: 0 });
  assert.equal((await status.probeAll(now)).providers.status, "operational", "one customer's expired key is that customer's");
  put("second", "dddd");
  assert.deepEqual(status.providerErrors(now), { attempts: 6, failed: 6 });
  assert.equal((await status.probeAll(now)).providers.status, "outage", "the same refusal across accounts is the platform's credential");
  for (const t of ["byok", "second"]) fs.rmSync(path.join(process.env.FOLDRUN_DATA!, t), { recursive: true, force: true });
});
