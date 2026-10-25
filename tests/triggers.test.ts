// The triggers beyond a person, a clock and a bare POST: another flow
// finishing, a file landing in storage, an inbound email, a signed webhook,
// a single instant, a watched URL.
//
//   node --test tests/triggers.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { parseFlow, listRuns, type RunRecord } from "../../foldrun-core/src/store.ts";
import {
  chainedFlows,
  fireChainedFlows,
  fireStorageTriggers,
  underPrefix,
  verifyWebhookSignature,
  normaliseInboundEmail,
  emailTask,
  withTask,
} from "../../foldrun-core/src/triggers.ts";
import "../src/index.ts"; // the platform installed: chained flows go to the queue, not inline
import { findDueFlows, checkWatches, scheduleSpreadMs } from "../src/scheduler.ts";
import { setSecret } from "../../foldrun-core/src/secrets.ts";

function workspace(flows: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-triggers-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  const ws = path.join(root, "acme/workspaces/desk");
  fs.mkdirSync(path.join(ws, "flows"), { recursive: true });
  fs.mkdirSync(path.join(ws, "agents", "a"), { recursive: true });
  fs.writeFileSync(path.join(ws, "agents", "a", "agent.md"), "---\nname: a\n---\n\nA.\n");
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
  for (const [name, body] of Object.entries(flows)) fs.writeFileSync(path.join(ws, "flows", `${name}.md`), body);
  return {
    root,
    ws,
    done() {
      if (prev === undefined) delete process.env.FOLDRUN_DATA;
      else process.env.FOLDRUN_DATA = prev;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const finished = (flow: string, status: "completed" | "failed" = "completed"): RunRecord => ({
  id: "run-x",
  flow,
  status,
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  summary: "Three leads found.",
  steps: [{ agent: "a", instruction: "x", group: 1, optional: false, status, events: [], result: "Three leads found.\nDetails…", costUsd: 0 }],
});

// ------------------------------------------------------------- parsing

test("the new trigger keys parse, and a bad instant is null", () => {
  const f = parseFlow(
    "f.md",
    "---\nname: f\ntrigger: flow\nafter: [[flow:publish]]\non: failed\nat: 2026-09-05T09:00:00+10:00\nurl: https://x.test/feed\nevery: 10m\nsignature: github\nsigning_secret: ${GH_SECRET}\npath: leads/\n---\n1. [[a]] — x\n",
  );
  assert.equal(f.after, "publish");
  assert.equal(f.on, "failed");
  assert.equal(f.at, "2026-09-04T23:00:00.000Z");
  assert.equal(f.url, "https://x.test/feed");
  assert.equal(f.every, 600);
  assert.equal(f.signature, "github");
  assert.equal(f.signingSecret, "GH_SECRET");
  assert.equal(f.path, "leads/");
  assert.equal(parseFlow("g.md", "---\ntrigger: once\nat: next tuesday\n---\n1. [[a]] — x\n").at, null);
  assert.equal(parseFlow("g.md", "1. [[a]] — x\n").on, "completed");
});

test("withTask staples a tagged block onto the first step only", () => {
  const steps = withTask([{ agent: "a", instruction: "one", group: 1, optional: false }, { agent: "b", instruction: "two", group: 2, optional: false }], "email", "hello");
  assert.match(steps[0].instruction, /<email>\nhello\n<\/email>/);
  assert.equal(steps[1].instruction, "two");
});

// -------------------------------------------------------- trigger: flow

test("a flow chained on another starts when it settles the right way, with its conclusion as the task", async () => {
  const w = workspace({
    publish: "---\nname: publish\n---\n1. [[a]] — write\n",
    followup: "---\nname: followup\ntrigger: flow\nafter: publish\n---\n1. [[a]] — follow up\n",
    onfail: "---\nname: onfail\ntrigger: flow\nafter: publish\non: failed\n---\n1. [[a]] — repair\n",
    selfloop: "---\nname: selfloop\ntrigger: flow\nafter: selfloop\n---\n1. [[a]] — never\n",
  });
  try {
    assert.deepEqual(chainedFlows("acme", "desk", finished("publish")).map((f) => f.name), ["followup"]);
    assert.deepEqual(chainedFlows("acme", "desk", finished("publish", "failed")).map((f) => f.name), ["onfail"]);
    assert.deepEqual(chainedFlows("acme", "desk", finished("selfloop")), []);
    assert.deepEqual(chainedFlows("acme", "desk", finished("adhoc:a")), []);

    const started = await fireChainedFlows("acme", "desk", finished("publish"));
    assert.equal(started.length, 1);
    const run = listRuns("acme", "desk").find((r) => r.id === started[0])!;
    assert.equal(run.flow, "followup");
    assert.equal(run.status, "queued");
    assert.match(run.steps[0].instruction, /<previous_run>[\s\S]*flow: publish[\s\S]*summary: Three leads found\./);
    assert.deepEqual(run.tags, ["after:publish"]);
  } finally {
    w.done();
  }
});

// ----------------------------------------------------- trigger: storage

test("underPrefix: folders, files, and the empty prefix", () => {
  assert.equal(underPrefix("leads/a.csv", "leads/"), true);
  assert.equal(underPrefix("leads/a.csv", "leads"), true);
  assert.equal(underPrefix("leadsx/a.csv", "leads"), false);
  assert.equal(underPrefix("leads/a.csv", "leads/a.csv"), true);
  assert.equal(underPrefix("anything", null), true);
  assert.equal(underPrefix("anything", ""), true);
});

test("a file landing under a watched prefix starts the flow — unless its own run wrote it", async () => {
  const w = workspace({
    ingest: "---\nname: ingest\ntrigger: storage\npath: inbox/\n---\n1. [[a]] — ingest\n",
  });
  try {
    const started = await fireStorageTriggers("acme", "desk", ["inbox/new.csv", "other/x.txt"], "user:matt");
    assert.equal(started.length, 1);
    const run = listRuns("acme", "desk").find((r) => r.id === started[0])!;
    assert.match(run.steps[0].instruction, /<storage_event>[\s\S]*- storage\/inbox\/new\.csv/);
    assert.ok(!/other\/x\.txt/.test(run.steps[0].instruction));
    assert.deepEqual(await fireStorageTriggers("acme", "desk", ["elsewhere/x"], "user:matt"), []);
    // The ingest flow's own copy-back must not restart it.
    fs.writeFileSync(
      path.join(w.ws, "runs", "run-self.json"),
      JSON.stringify({ ...finished("ingest"), id: "run-self" }),
    );
    assert.deepEqual(await fireStorageTriggers("acme", "desk", ["inbox/out.csv"], "run:run-self"), []);
  } finally {
    w.done();
  }
});

// ------------------------------------------------------ signed webhooks

test("github, stripe, slack and plain hmac signatures verify against a vault secret", () => {
  const w = workspace({});
  try {
    setSecret("acme", "HOOK_SECRET", "s3cret", "desk");
    const body = '{"hello":"world"}';
    const hmac = (data: string) => crypto.createHmac("sha256", "s3cret").update(data).digest("hex");
    const flow = (signature: string) =>
      parseFlow("f.md", `---\ntrigger: webhook\nsignature: ${signature}\nsigning_secret: \${HOOK_SECRET}\n---\n1. [[a]] — x\n`);
    const now = 1_800_000_000_000;
    const ts = Math.floor(now / 1000);

    assert.equal(verifyWebhookSignature("acme", "desk", flow("github"), body, (n) => (n === "x-hub-signature-256" ? `sha256=${hmac(body)}` : null), now).ok, true);
    assert.equal(verifyWebhookSignature("acme", "desk", flow("github"), body, () => "sha256=deadbeef", now).ok, false);

    const stripeHeader = `t=${ts},v1=${hmac(`${ts}.${body}`)}`;
    assert.equal(verifyWebhookSignature("acme", "desk", flow("stripe"), body, (n) => (n === "stripe-signature" ? stripeHeader : null), now).ok, true);
    const stale = `t=${ts - 3600},v1=${hmac(`${ts - 3600}.${body}`)}`;
    assert.match(verifyWebhookSignature("acme", "desk", flow("stripe"), body, (n) => (n === "stripe-signature" ? stale : null), now).reason, /window/);

    const slackHeaders: Record<string, string> = { "x-slack-request-timestamp": String(ts), "x-slack-signature": `v0=${hmac(`v0:${ts}:${body}`)}` };
    assert.equal(verifyWebhookSignature("acme", "desk", flow("slack"), body, (n) => slackHeaders[n] ?? null, now).ok, true);
    const challenge = verifyWebhookSignature("acme", "desk", flow("slack"), '{"type":"url_verification","challenge":"abc"}', () => null, now);
    assert.equal(challenge.challenge, "abc");

    assert.equal(verifyWebhookSignature("acme", "desk", flow("hmac"), body, (n) => (n === "x-signature" ? hmac(body) : null), now).ok, true);

    // No signature declared: nothing to check. Declared but unset: refused, naming the secret.
    assert.equal(verifyWebhookSignature("acme", "desk", parseFlow("f.md", "---\ntrigger: webhook\n---\n1. [[a]] — x\n"), body, () => null).ok, true);
    const unset = parseFlow("f.md", "---\ntrigger: webhook\nsignature: hmac\nsigning_secret: ${NOPE}\n---\n1. [[a]] — x\n");
    assert.match(verifyWebhookSignature("acme", "desk", unset, body, () => null).reason, /NOPE/);
  } finally {
    w.done();
  }
});

// ------------------------------------------------------- trigger: email

test("inbound email: JSON, Resend's data wrapper, Mailgun form fields, HTML-only bodies", () => {
  const json = normaliseInboundEmail("application/json", JSON.stringify({ from: "a@x.test", to: "desk@y.test", subject: "Quote", text: "Yes please" }));
  assert.deepEqual(json, { from: "a@x.test", to: "desk@y.test", subject: "Quote", text: "Yes please" });
  const resend = normaliseInboundEmail("application/json", JSON.stringify({ type: "email.received", data: { from: "b@x.test", to: ["desk@y.test"], subject: "Hi", html: "<p>Hello <b>there</b></p>" } }));
  assert.equal(resend?.from, "b@x.test");
  assert.equal(resend?.text, "Hello there");
  const mailgun = normaliseInboundEmail("application/x-www-form-urlencoded", new URLSearchParams({ sender: "c@x.test", recipient: "desk@y.test", subject: "S", "body-plain": "plain body" }).toString());
  assert.equal(mailgun?.from, "c@x.test");
  assert.equal(mailgun?.text, "plain body");
  assert.equal(normaliseInboundEmail("application/json", "{}"), null);
  assert.equal(normaliseInboundEmail("text/plain", "hello"), null);
  assert.match(emailTask(json!), /^from: a@x\.test\nto: desk@y\.test\nsubject: Quote\n\nYes please$/);
});

// ------------------------------------------------ trigger: once + watch

test("once: fires at its instant exactly once; a long-past instant is recorded, not fired", () => {
  const w = workspace({
    soon: "---\nname: soon\ntrigger: once\nat: 2026-09-05T09:00:00Z\n---\n1. [[a]] — x\n",
    stale: "---\nname: stale\ntrigger: once\nat: 2026-01-01T00:00:00Z\n---\n1. [[a]] — x\n",
  });
  try {
    const state = { lastFired: {} as Record<string, string> };
    assert.deepEqual(findDueFlows(new Date("2026-09-05T08:59:00Z"), state, ["acme"]), []);
    const due = findDueFlows(new Date("2026-09-05T09:00:30Z"), state, ["acme"]);
    assert.deepEqual(due.map((d) => d.flow.name), ["soon"]);
    assert.deepEqual(findDueFlows(new Date("2026-09-05T09:01:00Z"), state, ["acme"]), []);
    assert.ok(Object.keys(state.lastFired).some((k) => k.startsWith("acme/desk/stale@")), "stale is recorded so it never fires");
  } finally {
    w.done();
  }
});

test("watch: first sight records, a change fires with the new content, unchanged is quiet", async () => {
  const w = workspace({
    feed: "---\nname: feed\ntrigger: watch\nurl: https://x.test/feed\nevery: 1m\n---\n1. [[a]] — x\n",
  });
  try {
    const state = { lastFired: {} as Record<string, string> };
    let body = "v1";
    const read = async () => body;
    const t0 = new Date("2026-09-05T09:00:00Z");
    assert.deepEqual(await checkWatches(t0, state, ["acme"], read), []);
    body = "v2";
    assert.deepEqual(await checkWatches(new Date(t0.getTime() + 30_000), state, ["acme"], read), [], "not due yet");
    const fired = await checkWatches(new Date(t0.getTime() + 61_000), state, ["acme"], read);
    assert.equal(fired.length, 1);
    assert.equal(fired[0].body, "v2");
    assert.deepEqual(await checkWatches(new Date(t0.getTime() + 122_000), state, ["acme"], read), [], "unchanged");
  } finally {
    w.done();
  }
});

test("watch: several are read at once, and what changed comes back in the order found", async () => {
  const w = workspace({
    a: "---\nname: a\ntrigger: watch\nurl: https://x.test/a\nevery: 1m\n---\n1. [[a]] — x\n",
    b: "---\nname: b\ntrigger: watch\nurl: https://x.test/b\nevery: 1m\n---\n1. [[a]] — x\n",
    c: "---\nname: c\ntrigger: watch\nurl: https://x.test/c\nevery: 1m\n---\n1. [[a]] — x\n",
  });
  try {
    const state = { lastFired: {} as Record<string, string> };
    let version = 1;
    let inFlight = 0;
    let most = 0;
    // a slow first site: answered last, still listed first
    const read = async (url: string) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, url.endsWith("/a") ? 40 : 5));
      inFlight -= 1;
      return `${url} v${version}`;
    };
    const t0 = new Date("2026-09-05T09:00:00Z");
    await checkWatches(t0, state, ["acme"], read);
    version = 2;
    const fired = await checkWatches(new Date(t0.getTime() + 61_000), state, ["acme"], read);
    assert.deepEqual(fired.map((f) => f.flow.name), ["a", "b", "c"]);
    assert.ok(most > 1, "read at once, not one after another");
  } finally {
    w.done();
  }
});

test("a scheduled flow's spread is the same every time, inside the window, and off when unset", () => {
  const env = { FOLDRUN_SCHEDULE_SPREAD_SEC: "60" } as NodeJS.ProcessEnv;
  const a = scheduleSpreadMs("acme/desk/morning", env);
  assert.equal(scheduleSpreadMs("acme/desk/morning", env), a);
  assert.ok(a >= 0 && a < 60_000);
  const spreads = new Set(["a", "b", "c", "d", "e", "f"].map((k) => scheduleSpreadMs(`acme/desk/${k}`, env)));
  assert.ok(spreads.size > 1, "different flows land at different moments");
  assert.equal(scheduleSpreadMs("acme/desk/morning", {} as NodeJS.ProcessEnv), 0);
  assert.equal(scheduleSpreadMs("acme/desk/morning", { FOLDRUN_SCHEDULE_SPREAD_SEC: "0.0001" } as NodeJS.ProcessEnv), 0, "a window under a millisecond is none, never NaN");
});

// ------------------------------------------------------------------ lint

test("foldrun check names a trigger that can never fire", async () => {
  const { lintFlow } = await import("../../foldrun-core/src/flow-lint.ts");
  const msgs = (src: string) => lintFlow(parseFlow("f.md", src)).map((w) => w.message);
  assert.ok(msgs("---\ntrigger: once\n---\n1. [[a]] — x\n").some((m) => /at:/.test(m)));
  assert.ok(msgs("---\ntrigger: watch\n---\n1. [[a]] — x\n").some((m) => /url:/.test(m)));
  assert.ok(msgs("---\nname: f\ntrigger: flow\nafter: f\n---\n1. [[a]] — x\n").some((m) => /itself/.test(m)));
  assert.ok(msgs("---\ntrigger: webhook\nsignature: github\n---\n1. [[a]] — x\n").some((m) => /signing_secret/.test(m)));
  assert.deepEqual(msgs("---\ntrigger: webhook\nsignature: github\nsigning_secret: ${X}\n---\n1. [[a]] — x\n").filter((m) => /signature|signing/.test(m)), []);
});
