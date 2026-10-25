// Outbound notify: webhooks as recorded deliveries: the first attempt at
// once, retries on the backoff from the scheduler's sweep, every attempt
// written down, redelivery with the same id, and an endpoint switched off
// after days of failures with one mail to the owner. File stores here;
// postgres-live.test.ts runs the same rows against Postgres.
//
//   node --test tests/webhook-deliveries.test.ts

import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-webhooks-"));
process.env.FOLDRUN_DATA = root;
process.env.FOLDRUN_SECRET_KEY ??= "webhook-test-key";
process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE = "1";
process.env.FOLDRUN_RESEND_API_KEY = "re_platform";
delete process.env.FOLDRUN_DATABASE_URL;

await import("../src/index.ts");
const wd = await import("../src/webhook-deliveries.ts");
const { sendRunNotification } = await import("../../foldrun-core/src/notify.ts");

// The receiver: answers whatever `answer` says, records every request.
let answer = 500;
const seen: { headers: http.IncomingHttpHeaders; body: string; url?: string }[] = [];
// Called on each request before it is answered, when a test sets it; a
// promise it returns holds the answer until it settles.
let onRequest: ((url: string) => void | Promise<unknown>) | null = null;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ headers: req.headers, body, url: req.url });
    void Promise.resolve(onRequest?.(req.url ?? "")).then(() => res.writeHead(answer).end(answer >= 400 ? "receiver is down" : "ok"));
  });
});
let port = 0;

// Resend, for the switched-off mail.
const mails: { to: unknown; subject: string; text: string }[] = [];
const realFetch = globalThis.fetch;

before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("api.resend.com")) {
      mails.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    }
    return realFetch(url as string, init);
  }) as typeof fetch;
  for (const ws of ["desk", "other", "dead"]) {
    fs.mkdirSync(path.join(root, "acme/workspaces", ws), { recursive: true });
    fs.writeFileSync(path.join(root, "acme/workspaces", ws, "AGENTS.md"), `---\nnotify:\n  url: http://127.0.0.1:${port}/hook/${ws}\n  events: [failed]\n---\n`);
  }
  fs.writeFileSync(path.join(root, "users.json"), JSON.stringify([{ id: "u1", email: "owner@example.test", tenant: "acme", salt: "", hash: "", createdAt: "2026-01-01T00:00:00Z", owner: true }]));
});

after(() => {
  server.close();
  globalThis.fetch = realFetch;
});

const failedRun = () => ({
  id: `run-${Math.random().toString(36).slice(2, 8)}`,
  flow: "publish",
  status: "failed" as const,
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  steps: [{ agent: "writer", instruction: "x", group: 1, optional: false, attempts: 1, status: "failed" as const, events: [], result: null, costUsd: 0 }],
});

test("a failed first attempt is recorded and lined up for one minute later", async () => {
  answer = 500;
  seen.length = 0;
  const before = Date.now();
  assert.equal(await sendRunNotification("acme", "desk", failedRun()), false);
  const { deliveries, total } = await wd.listDeliveries("acme", "desk");
  assert.equal(total, 1);
  const d = deliveries[0];
  assert.equal(d.status, "pending");
  assert.equal(d.event, "failed");
  assert.equal(d.attempts, 1);
  assert.equal(d.attemptLog.length, 1);
  assert.equal(d.attemptLog[0].statusCode, 500);
  assert.equal(d.attemptLog[0].response, "receiver is down");
  assert.equal(d.attemptLog[0].error, "HTTP 500");
  assert.equal(d.lastStatusCode, 500);
  const wait = Date.parse(d.nextAttemptAt!) - before;
  assert.ok(wait >= 60_000 && wait < 65_000, `next attempt ~1m away, got ${wait}ms`);
  assert.equal(seen[0].headers["x-foldrun-delivery"], d.id);
  assert.equal(seen[0].headers["x-foldrun-attempt"], "1");
});

test("the sweep walks the backoff — 5m, 30m, 2h, 6h — and gives up after the sixth", async () => {
  answer = 503;
  const [d] = (await wd.listDeliveries("acme", "desk")).deliveries;
  assert.equal(await wd.sweepWebhookDeliveries(Date.now()), 0, "nothing is due yet");
  const gaps: number[] = [];
  for (let i = 0; i < 5; i++) {
    const n = await wd.sweepWebhookDeliveries(Date.now() + 7 * 3600_000);
    assert.equal(n, 1, `sweep ${i + 1} attempts it`);
    const r = (await wd.getDelivery("acme", "desk", d.id))!;
    if (r.nextAttemptAt) gaps.push(Math.round((Date.parse(r.nextAttemptAt) - Date.parse(r.attemptLog[r.attemptLog.length - 1].at)) / 60_000));
  }
  assert.deepEqual(gaps, [5, 30, 120, 360]);
  const r = (await wd.getDelivery("acme", "desk", d.id))!;
  assert.equal(r.status, "failed");
  assert.equal(r.attempts, 6);
  assert.equal(r.nextAttemptAt, null);
  assert.deepEqual(r.attemptLog.map((a) => a.n), [1, 2, 3, 4, 5, 6]);
  assert.equal(await wd.sweepWebhookDeliveries(Date.now() + 30 * 3600_000), 0, "a given-up delivery is not swept again");
  const ids = new Set(seen.filter((s) => s.headers["x-foldrun-delivery"] === d.id).map((s) => s.headers["x-foldrun-delivery"]));
  assert.equal(ids.size, 1, "one id across every attempt");
});

test("redeliver sends the same id and body again, records the attempt, and lands it", async () => {
  answer = 200;
  seen.length = 0;
  const [d] = (await wd.listDeliveries("acme", "desk", { status: "failed" })).deliveries;
  const r = (await wd.redeliver("acme", "desk", d.id))!;
  assert.equal(r.status, "delivered");
  assert.equal(r.attempts, 7);
  const last = r.attemptLog[r.attemptLog.length - 1];
  assert.equal(last.manual, true);
  assert.equal(last.statusCode, 200);
  assert.equal(seen[0].headers["x-foldrun-delivery"], d.id);
  assert.equal(seen[0].body, d.body, "the same bytes");
  assert.equal(await wd.redeliver("acme", "desk", "dlv_nope"), null);
  assert.equal(await wd.redeliver("acme", "other", d.id), null, "another workspace's delivery is not found from here");
});

test("listing narrows by status and event and pages", async () => {
  answer = 200;
  for (let i = 0; i < 3; i++) await sendRunNotification("acme", "other", failedRun());
  const all = await wd.listDeliveries("acme", "other", { limit: 2 });
  assert.equal(all.total, 3);
  assert.equal(all.deliveries.length, 2);
  const rest = await wd.listDeliveries("acme", "other", { limit: 2, offset: 2 });
  assert.equal(rest.deliveries.length, 1);
  assert.equal((await wd.listDeliveries("acme", "other", { status: "delivered" })).total, 3);
  assert.equal((await wd.listDeliveries("acme", "other", { status: "failed" })).total, 0);
  assert.equal((await wd.listDeliveries("acme", "other", { event: "completed" })).total, 0);
});

test("days of failures switch the endpoint off, mail the owner once, and skip new deliveries; an accepted redelivery turns it back on", async () => {
  mails.length = 0;
  const t0 = Date.now() - 4 * 86400_000;
  assert.equal(await wd.noteEndpointResult("acme", "dead", false, t0), null, "the first failure starts the run");
  assert.equal(await wd.noteEndpointResult("acme", "dead", false, t0 + 2 * 86400_000), null, "two days is not three");
  assert.equal(await wd.noteEndpointResult("acme", "dead", false, t0 + 3 * 86400_000, true), null, "a manual failure does not count");
  assert.equal(await wd.noteEndpointResult("acme", "dead", false, t0 + 3 * 86400_000 + 1), "disabled");
  assert.equal(await wd.noteEndpointResult("acme", "dead", false, t0 + 4 * 86400_000), null, "switched off once");
  assert.equal(mails.length, 1, "one mail");
  assert.equal(mails[0].to, "owner@example.test");
  assert.match(mails[0].subject, /switched off dead's notification webhook/);
  assert.match(mails[0].text, /3 days running/);
  assert.ok(await wd.endpointDisabled("acme", "dead"));

  answer = 200;
  seen.length = 0;
  await sendRunNotification("acme", "dead", failedRun());
  const [skipped] = (await wd.listDeliveries("acme", "dead")).deliveries;
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.attempts, 0);
  assert.match(skipped.lastError!, /switched off/);
  assert.equal(seen.length, 0, "nothing was sent");

  const r = (await wd.redeliver("acme", "dead", skipped.id))!;
  assert.equal(r.status, "delivered");
  assert.equal(await wd.endpointDisabled("acme", "dead"), null, "back on");
  assert.equal((await wd.endpointState("acme", "dead"))!.failingSince, null);
});

test("a pending retry is skipped, not attempted, once its endpoint is off", async () => {
  answer = 500;
  // Failing for five days already; this delivery's first attempt fails
  // too, then another delivery gives up and switches the endpoint off —
  // and this one's retry is then never made.
  await wd.noteEndpointResult("acme", "other", false, Date.now() - 5 * 86400_000);
  await sendRunNotification("acme", "other", failedRun());
  const [d] = (await wd.listDeliveries("acme", "other", { status: "pending" })).deliveries;
  assert.ok(d, "attempted once, a retry lined up");
  assert.equal(await wd.endpointDisabled("acme", "other"), null, "a first attempt does not switch it off");
  assert.equal(await wd.noteEndpointResult("acme", "other", false, Date.now()), "disabled", "a delivery that gave up does");
  seen.length = 0;
  await wd.sweepWebhookDeliveries(Date.now() + 3600_000);
  const r = (await wd.getDelivery("acme", "other", d.id))!;
  assert.equal(r.status, "skipped");
  assert.equal(seen.length, 0);
});

test("changing the URL starts the endpoint fresh", async () => {
  assert.ok(await wd.endpointDisabled("acme", "other"));
  fs.writeFileSync(path.join(root, "acme/workspaces/other/AGENTS.md"), `---\nnotify:\n  url: http://127.0.0.1:${port}/hook/new\n---\n`);
  assert.equal(await wd.endpointDisabled("acme", "other"), null);
});

test("a gate's approve and reject links reach the receiver but are not listed back — a viewer's key would decide with them", async () => {
  answer = 200;
  seen.length = 0;
  const prev = process.env.FOLDRUN_PUBLIC_URL;
  process.env.FOLDRUN_PUBLIC_URL = "https://foldrun.example.test";
  try {
    fs.mkdirSync(path.join(root, "acme/workspaces/gate"), { recursive: true });
    fs.writeFileSync(path.join(root, "acme/workspaces/gate/AGENTS.md"), `---\nnotify:\n  url: http://127.0.0.1:${port}/hook/gate\n  events: [awaiting-approval]\n---\n`);
    const run = {
      ...failedRun(),
      status: "awaiting-approval" as const,
      finishedAt: null,
      steps: [{ agent: "publisher", instruction: "x", group: 1, optional: false, attempts: 0, status: "awaiting-approval" as const, events: [], result: null, costUsd: 0 }],
    };
    await sendRunNotification("acme", "gate", run as never);
    assert.equal(seen.length, 1);
    assert.match(seen[0].body, /\/api\/approve\/acme\/gate\/.*token=/, "the receiver gets the links");
    const [d] = (await wd.listDeliveries("acme", "gate")).deliveries;
    assert.doesNotMatch(d.body, /token=/, "the listed body carries no live link");
    const listed = JSON.parse(d.body);
    assert.equal(listed.approveUrl, "[redacted]");
    assert.equal(listed.links[0].rejectUrl, "[redacted]");
    assert.equal(listed.runId, run.id, "the rest of the body is as sent");
    const r = (await wd.redeliver("acme", "gate", d.id))!;
    assert.match(seen[1].body, /token=/, "a redelivery still sends the links");
    assert.doesNotMatch(r.body, /token=/, "and does not hand them back");
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_PUBLIC_URL;
    else process.env.FOLDRUN_PUBLIC_URL = prev;
  }
});

test("one failed first attempt days after an earlier failure does not switch the endpoint off — its retries get their chance", async () => {
  fs.mkdirSync(path.join(root, "acme/workspaces/quiet"), { recursive: true });
  fs.writeFileSync(path.join(root, "acme/workspaces/quiet/AGENTS.md"), `---\nnotify:\n  url: http://127.0.0.1:${port}/hook/quiet\n  events: [failed]\n---\n`);
  // A delivery four days ago gave up; nothing was sent since. Today's
  // receiver blips once.
  await wd.noteEndpointResult("acme", "quiet", false, Date.now() - 4 * 86400_000);
  answer = 500;
  await sendRunNotification("acme", "quiet", failedRun());
  assert.equal(await wd.endpointDisabled("acme", "quiet"), null, "not switched off on a first attempt");
  const [d] = (await wd.listDeliveries("acme", "quiet")).deliveries;
  assert.equal(d.status, "pending");
  answer = 200;
  await wd.sweepWebhookDeliveries(Date.now() + 120_000);
  assert.equal((await wd.getDelivery("acme", "quiet", d.id))!.status, "delivered");
  assert.equal((await wd.endpointState("acme", "quiet"))!.failingSince, null);
});

test("a long sweep does not let its later deliveries' claims run out — a second pod would send them twice", async () => {
  fs.mkdirSync(path.join(root, "acme/workspaces/slow"), { recursive: true });
  fs.writeFileSync(path.join(root, "acme/workspaces/slow/AGENTS.md"), `---\nnotify:\n  url: http://127.0.0.1:${port}/hook/slow\n  events: [failed]\n---\n`);
  answer = 500;
  for (let i = 0; i < 4; i++) await sendRunNotification("acme", "slow", failedRun());
  seen.length = 0;
  // The first sweep's two attempts take a minute of (mocked) clock each;
  // at the second a second pod — a scheduler handover — sweeps too, and
  // the second attempt is not answered until that sweep is done (the
  // order a loaded machine produced). The clock is one clock: ticking it
  // for the other sweep's attempts as well charged them to the attempt
  // still held, which then "took" its whole two-minute claim and was sent
  // again — a fake-clock artefact, not a race (an attempt times out at 8s).
  mock.timers.enable({ apis: ["Date"], now: Date.now() + 70_000 });
  let other: Promise<number> | null = null;
  let slowSeen = 0;
  onRequest = (url) => {
    if (!url.endsWith("/hook/slow") || slowSeen >= 2) return;
    mock.timers.tick(60_000);
    if (++slowSeen !== 2) return;
    other = wd.sweepWebhookDeliveries(Date.now());
    return other;
  };
  try {
    await wd.sweepWebhookDeliveries(Date.now());
    await other;
  } finally {
    onRequest = null;
    mock.timers.reset();
  }
  const ids = seen.filter((r) => r.url?.endsWith("/hook/slow")).map((r) => String(r.headers["x-foldrun-delivery"]));
  assert.equal(ids.length, 4, "each of the four attempted");
  assert.equal(new Set(ids).size, 4, `none twice: ${ids.join(" ")}`);
});

test("a redelivery does not use up one of the scheduled attempts", async () => {
  fs.mkdirSync(path.join(root, "acme/workspaces/redo"), { recursive: true });
  fs.writeFileSync(path.join(root, "acme/workspaces/redo/AGENTS.md"), `---\nnotify:\n  url: http://127.0.0.1:${port}/hook/redo\n  events: [failed]\n---\n`);
  answer = 500;
  await sendRunNotification("acme", "redo", failedRun());
  const [d] = (await wd.listDeliveries("acme", "redo")).deliveries;
  await wd.redeliver("acme", "redo", d.id);
  const gaps: number[] = [];
  for (let i = 0; i < 8; i++) {
    await wd.sweepWebhookDeliveries(Date.now() + 7 * 3600_000);
    const r = (await wd.getDelivery("acme", "redo", d.id))!;
    if (r.status !== "pending") break;
    gaps.push(Math.round((Date.parse(r.nextAttemptAt!) - Date.parse(r.attemptLog[r.attemptLog.length - 1].at)) / 60_000));
  }
  const r = (await wd.getDelivery("acme", "redo", d.id))!;
  assert.equal(r.status, "failed");
  assert.equal(r.attemptLog.filter((a) => !a.manual).length, 6, "six scheduled attempts, as without the redelivery");
  assert.deepEqual(gaps, [5, 30, 120, 360]);
  assert.deepEqual(r.attemptLog.map((a) => a.n), [1, 2, 3, 4, 5, 6, 7], "the attempt number still counts every send");
});

test("a claim outlasts the attempt's own timeout when that is raised — a slow receiver is not sent the delivery twice", async () => {
  fs.mkdirSync(path.join(root, "acme/workspaces/patient"), { recursive: true });
  fs.writeFileSync(path.join(root, "acme/workspaces/patient/AGENTS.md"), `---\nnotify:\n  url: http://127.0.0.1:${port}/hook/patient\n  events: [failed]\n---\n`);
  answer = 500;
  const claims: number[] = [];
  // The sweep is run as if six minutes on; its claim is measured from then.
  let ahead = 0;
  onRequest = async (url) => {
    if (!url.endsWith("/hook/patient")) return;
    const [d] = (await wd.listDeliveries("acme", "patient")).deliveries;
    claims.push(Date.parse(d.nextAttemptAt!) - (Date.now() + ahead));
  };
  process.env.FOLDRUN_WEBHOOK_TIMEOUT_MS = String(5 * 60_000);
  try {
    await sendRunNotification("acme", "patient", failedRun());
    ahead = 6 * 60_000;
    await wd.sweepWebhookDeliveries(Date.now() + ahead);
  } finally {
    onRequest = null;
    delete process.env.FOLDRUN_WEBHOOK_TIMEOUT_MS;
  }
  assert.equal(claims.length, 2, "the first attempt and the sweep's");
  for (const c of claims) assert.ok(c > 5 * 60_000, `held ${Math.round(c / 1000)}s, past the 300s timeout`);
});
