// Slim browsing, the web tool's half: on the slim image a browse call never
// falls back to a browser in the step; a pod it cannot reach is reconnected
// (the call tried again — unless it may already have written, when the pod
// is only probed), and a pod still gone is "lost" in the step's pod log,
// which the step's driver reads (foldrun-core browser-pod.ts).
//
// run.mjs runs for real here, beside a stand-in browse.mjs that plays out a
// script of outcomes; the pod's address is a local port we open and close.
//
//   node --test tests/slim-browsing.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { GALLERY } from "../src/gallery.ts";
import { BROWSE_WRITE_ACTIONS, podLossDecision } from "../../foldrun-core/src/browser-pod.ts";
import { executeStep, type QueryFn } from "../../foldrun-core/src/step-exec.ts";

const web = GALLERY.find((t) => t.name === "web")!;
const RUN = web.wrapper!.content;
const BROWSE = web.extra!.find((f) => f.file === "web/browse.mjs")!.content;

/** A browse.mjs that answers each go from a script: [{state, out, code}]. */
const STUB = `
import fs from "node:fs";
const plan = JSON.parse(fs.readFileSync(process.env.STUB_PLAN, "utf8"));
const n = Number(fs.existsSync(process.env.STUB_COUNT) ? fs.readFileSync(process.env.STUB_COUNT, "utf8") : "0");
fs.writeFileSync(process.env.STUB_COUNT, String(n + 1));
fs.appendFileSync(process.env.STUB_ARGS, JSON.stringify(process.argv.slice(2)) + "\\n");
const go = plan[Math.min(n, plan.length - 1)];
if (go.state) fs.writeFileSync(process.env.FOLDRUN_BROWSER_POD_CALL, JSON.stringify({ state: go.state, error: go.error ?? go.state }));
if (go.out) process.stdout.write(go.out);
process.stderr.write("stub go " + (n + 1) + "\\n");
process.exit(go.code ?? (go.state ? 1 : 0));
`;

function setup(plan: unknown[], extraEnv: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-slim-"));
  fs.mkdirSync(path.join(dir, "web"));
  fs.writeFileSync(path.join(dir, "web/run.mjs"), RUN);
  fs.writeFileSync(path.join(dir, "web/browse.mjs"), STUB);
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
  const env = {
    ...process.env,
    FOLDRUN_BROWSER_POD_ONLY: "1",
    FOLDRUN_BROWSER_POD_EVENTS: path.join(dir, "pod.jsonl"),
    FOLDRUN_BROWSER_RECONNECT_MS: "10,10,10",
    FOLDRUN_BROWSER_WS: "ws://127.0.0.1:1/",
    STUB_PLAN: path.join(dir, "plan.json"),
    STUB_COUNT: path.join(dir, "count"),
    STUB_ARGS: path.join(dir, "args.jsonl"),
    ...extraEnv,
  };
  // Each line carries `at`, when it happened; the rest is compared whole.
  const stamped = () => (fs.existsSync(env.FOLDRUN_BROWSER_POD_EVENTS) ? fs.readFileSync(env.FOLDRUN_BROWSER_POD_EVENTS, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const events = () => stamped().map(({ at, ...e }) => {
    assert.ok(typeof at === "string" && !Number.isNaN(Date.parse(at)), "every pod log line says when");
    return e;
  });
  const goes = () => Number(fs.readFileSync(env.STUB_COUNT, "utf8"));
  return { dir, env, events, stamped, goes };
}

function browse(env: NodeJS.ProcessEnv, dir: string, ...args: string[]) {
  return spawnSync(process.execPath, [path.join(dir, "web/run.mjs"), "--action", "browse", "--url", "https://example.com", ...args], { env, encoding: "utf8" });
}

/** Same, without blocking the event loop — for the test that serves the pod's port. */
function browseAsync(env: NodeJS.ProcessEnv, dir: string, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(dir, "web/run.mjs"), "--action", "browse", "--url", "https://example.com", ...args], { env });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("the tool's copy of the write actions is core's", () => {
  const m = RUN.match(/const BROWSE_WRITE_ACTIONS = (\[[\s\S]*?\]);/);
  assert.ok(m, "run.mjs carries the list");
  assert.deepEqual(JSON.parse(m![1].replace(/,\s*\]$/, "]")), [...BROWSE_WRITE_ACTIONS]);
});

test("a healthy pod: one go, its answer passed through, nothing in the pod log", () => {
  const { dir, env, events, goes } = setup([{ out: "page text\n" }]);
  const r = browse(env, dir);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "page text\n");
  assert.equal(goes(), 1);
  assert.deepEqual(events(), []);
});

test("unreachable, then back: reconnected, the call tried again, its answer is the answer", () => {
  const { dir, env, events, goes } = setup([{ state: "unreachable", error: "ECONNREFUSED", out: "never shown" }, { out: "page text\n" }]);
  const r = browse(env, dir);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "page text\n", "the failed go's output is held back");
  assert.equal(goes(), 2);
  assert.deepEqual(events(), [{ kind: "reconnect", attempt: 1, of: 3, ok: true }]);
  assert.match(r.stderr, /came back on try 1 of 3/);
});

test("unreachable on every try: three reconnects, then lost — and the step is told it never ran", () => {
  const { dir, env, events, goes } = setup([{ state: "unreachable", error: "ECONNREFUSED" }]);
  const r = browse(env, dir, "--actions", JSON.stringify([{ click: "#buy" }]));
  assert.equal(r.status, 1);
  assert.equal(goes(), 4, "the first go and three reconnects");
  const ev = events();
  assert.deepEqual(ev.map((e) => [e.kind, e.ok]), [["reconnect", false], ["reconnect", false], ["reconnect", false], ["lost", undefined]]);
  assert.equal(ev[3].ran, false, "nothing reached a page, so even a click changed nothing");
  assert.match(r.stderr, /browser pod is gone \(ECONNREFUSED\), after 3 reconnect tries/);
});

/** A port that answers, standing in for the pod's address while it serves. */
async function openPort() {
  const server = net.createServer((sock) => sock.end());
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { server, ws: `ws://127.0.0.1:${(server.address() as net.AddressInfo).port}/` };
}

const CLOSED = "page.waitForTimeout: Target page, context or browser has been closed";

test("dropped mid-call on a read-only call: the pod is probed, answers, and the call runs once more", async () => {
  const { server, ws } = await openPort();
  try {
    const { dir, env, events, goes } = setup([{ state: "dropped", error: CLOSED }, { out: "ok\n" }], { FOLDRUN_BROWSER_WS: ws });
    const r = browse(env, dir, "--actions", JSON.stringify([{ scroll: "down" }, { screenshot: "a.png" }]));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "ok\n", "the retry's answer is the answer");
    assert.equal(goes(), 2);
    assert.deepEqual(events(), [{ kind: "reconnect", attempt: 1, of: 3, ok: true }]);
    assert.match(r.stderr, /dropped mid-call \(page\.waitForTimeout: Target page, context or browser has been closed\) and came back on try 1 of 3; the call only read, so it ran once more/);
  } finally {
    server.close();
  }
});

test("dropped mid-call on a read-only call, and the pod's address stops answering: three probes, lost — no blind re-sends", () => {
  // Live, 2026-10-01 10:12:19: the pod deleted, the Service refusing.
  const { dir, env, events, goes } = setup([{ state: "dropped", error: CLOSED }]);
  const r = browse(env, dir, "--actions", JSON.stringify([{ wait: 8000 }]));
  assert.equal(r.status, 1);
  assert.equal(goes(), 1, "the call is not re-sent at a pod that does not answer");
  const ev = events();
  assert.deepEqual(ev.map((e) => [e.kind, e.ok]), [["reconnect", false], ["reconnect", false], ["reconnect", false], ["lost", undefined]]);
  assert.equal(ev[3].ran, true);
  assert.match(ev[3].error, /Target page, context or browser has been closed; then the pod's address did not answer/);
});

test("a read retried once after a reconnect, and dropped again: lost, not tried a third time", async () => {
  const { server, ws } = await openPort();
  try {
    const { dir, env, events, goes } = setup([{ state: "dropped", error: CLOSED }, { state: "dropped", error: "browser.newContext: Browser closed" }, { out: "never\n" }], { FOLDRUN_BROWSER_WS: ws });
    const r = browse(env, dir, "--actions", JSON.stringify([{ wait: 8000 }]));
    assert.equal(r.status, 1);
    assert.equal(goes(), 2, "the call and its one retry");
    const ev = events();
    assert.deepEqual(ev.map((e) => [e.kind, e.ok]), [["reconnect", true], ["lost", undefined]]);
    assert.equal(ev[1].error, "browser.newContext: Browser closed");
    assert.match(r.stderr, /dropped the call again after it reconnected/);
  } finally {
    server.close();
  }
});

test("the reconnect backoff waits for real, and each pod log line says when it happened", () => {
  // Live, 2026-10-01 10:15:22: three reconnect lines on the run, one second.
  // The run stamps them when the driver reads the log, after the call; the
  // tries themselves are apart by the backoff, which `at` now shows.
  const { dir, env, stamped } = setup([{ state: "unreachable", error: "ECONNREFUSED" }], { FOLDRUN_BROWSER_RECONNECT_MS: "200,300,400" });
  const t0 = Date.now();
  browse(env, dir);
  assert.ok(Date.now() - t0 >= 900, "200 + 300 + 400 ms of waiting");
  const at = stamped().map((e) => Date.parse(e.at));
  assert.equal(at.length, 4);
  assert.ok(at[1] - at[0] >= 250, `try 2 came ${at[1] - at[0]} ms after try 1`);
  assert.ok(at[2] - at[1] >= 350, `try 3 came ${at[2] - at[1]} ms after try 2`);
});

// The tool reads a step's action from the step's own keys and an if's
// then/else, as core does. A key inside an option's value is data: an
// extract whose fields name a "type" column only read. And a click under
// many ifs is still a click — the old walk stopped looking at depth 8.
test("dropped mid-call on a read whose option value holds a write-sounding key: still a read, run once more", async () => {
  const { server, ws } = await openPort();
  try {
    const { dir, env, goes } = setup([{ state: "dropped", error: CLOSED }, { out: "ok\n" }], { FOLDRUN_BROWSER_WS: ws });
    const r = browse(env, dir, "--actions", JSON.stringify([{ extract: { fields: { type: "td.kind", select: "td.choice" } } }]));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(goes(), 2, "a read is retried after the reconnect");
  } finally {
    server.close();
  }
});

test("dropped mid-call with a click nested under many ifs: a write, not repeated", async () => {
  const { server, ws } = await openPort();
  try {
    const { dir, env, goes } = setup([{ state: "dropped", error: CLOSED, out: "half\n" }], { FOLDRUN_BROWSER_WS: ws });
    let steps: unknown = [{ click: "#buy" }];
    for (let n = 0; n < 6; n++) steps = [{ if: { visible: "#x" }, then: steps }];
    const r = await browseAsync(env, dir, "--actions", JSON.stringify(steps));
    assert.equal(r.status, 1);
    assert.equal(goes(), 1, "a call that may have clicked is never sent twice");
  } finally {
    server.close();
  }
});

test("dropped mid-call after a click: not repeated; the pod is probed, and back means the call fails saying it may have acted", async () => {
  const server = net.createServer((s) => s.end());
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as net.AddressInfo).port;
  try {
    const { dir, env, events, goes } = setup([{ state: "dropped", error: "closed", out: "half\n" }], { FOLDRUN_BROWSER_WS: `ws://127.0.0.1:${port}/` });
    const r = await browseAsync(env, dir, "--actions", JSON.stringify([{ fill: "#email", value: "a@b" }, { click: "submit" }]));
    assert.equal(r.status, 1);
    assert.equal(goes(), 1, "a call that may have submitted is never sent twice");
    assert.deepEqual(events(), [{ kind: "reconnect", attempt: 1, of: 3, ok: true }]);
    assert.match(r.stderr, /may have acted before it dropped — look at the page before doing it again/);
  } finally {
    server.close();
  }
});

test("dropped mid-call after a click, and the pod stays gone: lost, and it ran", () => {
  const { dir, env, events, goes } = setup([{ state: "dropped", error: "closed" }]);
  const r = browse(env, dir, "--js", "document.forms[0].submit()");
  assert.equal(r.status, 1);
  assert.equal(goes(), 1);
  const ev = events();
  assert.deepEqual(ev.map((e) => [e.kind, e.ok]), [["reconnect", false], ["reconnect", false], ["reconnect", false], ["lost", undefined]]);
  assert.equal(ev[3].ran, true);
});

test("the tool's write arguments: page script (js=, init=), a captcha solver, a confirmation — every one core counts", () => {
  const m = RUN.match(/if \((\[[^\]]*\])\.some\(\(n\) => val\(n\)/);
  assert.ok(m, "run.mjs carries the list");
  const ours = JSON.parse(m![1]) as string[];
  assert.deepEqual(ours, ["js", "init", "captcha", "captcha_solver", "confirm"]);
  const core = fs.readFileSync(new URL("../../foldrun-core/src/browser-pod.ts", import.meta.url), "utf8").match(/const BROWSE_WRITE_ARGS = (\[[^\]]*\]);/);
  assert.ok(core, "core carries the list");
  for (const a of JSON.parse(core![1]) as string[]) assert.ok(ours.includes(a), `core counts ${a} as a write; the tool must too`);
});

for (const [why, args, extraEnv] of [
  ["an init= page script", ["--init", "workspace/scripts/consent.js"], {}],
  ["the agent's web.browse init scripts (FOLDRUN_BROWSER_INIT)", [], { FOLDRUN_BROWSER_INIT: "workspace/scripts/consent.js" }],
] as [string, string[], Record<string, string>][]) {
  test(`dropped mid-call with ${why}: not repeated — a page script may have acted`, async () => {
    const { server, ws } = await openPort();
    try {
      const { dir, env, goes } = setup([{ state: "dropped", error: CLOSED }, { out: "never\n" }], { FOLDRUN_BROWSER_WS: ws, ...extraEnv });
      const r = await browseAsync(env, dir, ...args);
      assert.equal(r.status, 1);
      assert.equal(goes(), 1, "a call that ran page script is never sent twice");
      assert.match(r.stderr, /may have acted before it dropped/);
    } finally {
      server.close();
    }
  });
}

test("a call that needs a browser in the step: said once, not retried", () => {
  const { dir, env, events, goes } = setup([{ state: "needs-full", error: "lightpanda runs inside the step" }]);
  const r = browse(env, dir, "--engine", "lightpanda");
  assert.equal(r.status, 1);
  assert.equal(goes(), 1);
  assert.deepEqual(events(), [{ kind: "needs-full", ran: false, why: "lightpanda runs inside the step" }]);
});

test("off the slim image nothing changes: one go, streamed, no pod log", () => {
  const { dir, env, events, goes } = setup([{ out: "x\n" }], { FOLDRUN_BROWSER_POD_ONLY: "" });
  const r = browse(env, dir);
  assert.equal(r.status, 0);
  assert.equal(goes(), 1);
  assert.deepEqual(events(), []);
});

test("browse.mjs on the slim image never falls back to a browser in the step", () => {
  assert.match(BROWSE, /const POD_ONLY = process\.env\.FOLDRUN_BROWSER_POD_ONLY === "1";/);
  assert.match(BROWSE, /if \(POD_ONLY && !plan\.remote && !plan\.cdp\) \{\n  podCall\("needs-full", plan\.reason\);/, "an in-step-only call is named, not attempted");
  assert.match(BROWSE, /podCall\("unreachable", err\.message \?\? err\);[\s\S]{0,300}process\.exit\(1\);/, "an unreachable pod ends the call, no in-step launch");
  assert.match(BROWSE, /browser\.on\("disconnected", \(\) => \{ if \(!podWatch\.closing\) podWatch\.gone \?\?= /, "a mid-call drop is told from the call's own close");
  assert.match(BROWSE, /timeout: POD_ONLY \? 15_000 : 60_000/);
});

// ------------------------------------------- the whole chain, pod dying mid-step
//
// The real run.mjs (stand-in browse.mjs) writes the pod log; the real model
// loop (a scripted stand-in model) reads it after the tool result and stops
// the step; the decision says what the runner does next.

function model(calls: { id: string; name: string; input: Record<string, unknown>; during?: () => void }[]): QueryFn {
  return () => {
    const gen = (async function* () {
      for (const c of calls) {
        yield { type: "assistant", message: { id: `m-${c.id}`, content: [{ type: "tool_use", id: c.id, name: c.name, input: c.input }], usage: { input_tokens: 1, output_tokens: 1 } } };
        c.during?.();
        yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: c.id, content: "…" }] } };
      }
      yield { type: "result", subtype: "success", total_cost_usd: 0.001 };
    })();
    return Object.assign(gen, { interrupt: async () => {} });
  };
}

async function chain(plan: unknown[], before: { name: string; input: Record<string, unknown> }[], browseArgs: string[] = []) {
  const { dir, env } = setup(plan);
  const agentDir = path.join(dir, "agents/a");
  fs.mkdirSync(agentDir, { recursive: true });
  const calls = [
    ...before.map((c, i) => ({ id: `b${i}`, ...c })),
    { id: "web1", name: "mcp__foldrun_scripts__web", input: { action: "browse", url: "https://example.com" }, during: () => { browse(env, dir, ...browseArgs); } },
    { id: "after", name: "Write", input: { file_path: "/workspace/state/after.md" } },
  ];
  return executeStep({
    agentDir, workspaceRoot: dir, libraryRoot: dir, prompt: "p", model: "m", systemPrompt: "s",
    allowed: ["Read", "Write", "mcp__foldrun_scripts__web"], mcpNames: [], mcpServers: {}, env: {},
    browserPod: { events: env.FOLDRUN_BROWSER_POD_EVENTS! },
    emit: () => {},
  }, model(calls));
}

test("pod dies mid-step after reads: three reconnects, lost, step stopped — and the decision is a re-run on full", async () => {
  const out = await chain([{ state: "unreachable", error: "ECONNREFUSED" }], [
    { name: "Read", input: { file_path: "/workspace/knowledge/a.md" } },
    { name: "mcp__foldrun_scripts__web", input: { action: "search", query: "x" } },
  ]);
  assert.equal(out.status, "failed");
  assert.equal(out.browserPod?.reconnects, 3);
  assert.equal(out.browserPod?.reconnected, 0);
  assert.deepEqual(out.browserPod?.lost, { cause: "lost", detail: "ECONNREFUSED" });
  assert.deepEqual(out.browserPod?.writes, [], "the Write after the browse never ran");
  assert.equal(podLossDecision(out.browserPod!).rerun, true);
});

test("pod dies mid-step after a write: the decision is to fail, naming it", async () => {
  const out = await chain([{ state: "unreachable", error: "ECONNREFUSED" }], [
    { name: "Write", input: { file_path: "/workspace/state/leads.csv" } },
  ]);
  assert.equal(out.status, "failed");
  const d = podLossDecision(out.browserPod!);
  assert.equal(d.rerun, false);
  assert.match(!d.rerun ? d.message : "", /^browser pod died after the step had written state\/leads\.csv \(Write\)/);
});

test("pod blips and comes back: the step carries on, the reconnect on its record", async () => {
  const out = await chain([{ state: "unreachable", error: "reset" }, { out: "page\n" }], []);
  assert.equal(out.status, "completed");
  assert.deepEqual(out.browserPod, { reconnects: 1, reconnected: 1 });
});

// ------------------------------------------- the live sequences, 2026-10-01
//
// web-tools-lab on dev.foldrun.io: the browser pod deleted under a step that
// browsed six times, each call a {"wait": 8000}. The pod's server closed its
// browsers on SIGTERM (Playwright's handler) and kept serving for its grace
// period, so: the call in flight met "Target page, context or browser has
// been closed"; the next two calls rendered on the terminating pod; then
// ECONNREFUSED. Before the fix the first of those reached the model as an
// ordinary error, with no reconnect.

/** Several browse calls in one step, each with its own `during`. */
function liveStep(env: NodeJS.ProcessEnv, dir: string, before: { name: string; input: Record<string, unknown> }[], browses: (() => void)[]) {
  const agentDir = path.join(dir, "agents/a");
  fs.mkdirSync(agentDir, { recursive: true });
  const wait = JSON.stringify([{ wait: 8000 }]);
  const calls = [
    ...before.map((c, i) => ({ id: `b${i}`, ...c })),
    ...browses.map((during, i) => ({ id: `web${i + 1}`, name: "mcp__foldrun_scripts__web", input: { action: "browse", url: "https://example.com", actions: wait }, during })),
  ];
  const lines: string[] = [];
  return executeStep({
    agentDir, workspaceRoot: dir, libraryRoot: dir, prompt: "p", model: "m", systemPrompt: "s",
    allowed: ["Read", "Write", "Bash", "mcp__foldrun_scripts__web"], mcpNames: [], mcpServers: {}, env: {},
    browserPod: { events: env.FOLDRUN_BROWSER_POD_EVENTS! },
    emit: (_t, text) => { lines.push(text); },
  }, model(calls)).then((out) => ({ out, lines }));
}

for (const [who, before, expectRerun] of [
  ["pod-reader (run-mupdjcjl-u2y9)", [], true],
  ["pod-writer (run-mupdngjl-slwh)", [{ name: "Bash", input: { command: "echo x > outputs/marker.txt" } }], false],
] as const) {
  test(`live sequence, ${who}: the closed browser mid-call is a pod drop, reconnected; the gone pod is lost`, async () => {
    const { server, ws } = await openPort();
    // go 1: call 1 fine; go 2: call 2 meets the closed browser; go 3: its
    // retry on the terminating pod; goes 4, 5: calls 3 and 4 on it; go 6:
    // call 5 meets the closed browser again, and the pod is gone.
    const { dir, env, events } = setup([
      { out: "page 1\n" },
      { state: "dropped", error: CLOSED },
      { out: "page 2 (retried)\n" },
      { out: "page 3\n" },
      { out: "page 4\n" },
      { state: "dropped", error: CLOSED },
    ], { FOLDRUN_BROWSER_WS: ws });
    const answers: ReturnType<typeof browse>[] = [];
    const call = () => { answers.push(browse(env, dir, "--actions", JSON.stringify([{ wait: 8000 }]))); };
    try {
      const { out, lines } = await liveStep(env, dir, [...before], [
        call,
        call,
        call,
        call,
        () => { server.close(); call(); },
        call,
      ]);
      assert.deepEqual(answers.map((a) => a.status), [0, 0, 0, 0, 1], "call 2 answered from its retry; call 5 lost; call 6 never made");
      assert.equal(answers[1].stdout, "page 2 (retried)\n");
      assert.deepEqual(events().map((e) => [e.kind, e.ok]), [
        ["reconnect", true],
        ["reconnect", false], ["reconnect", false], ["reconnect", false], ["lost", undefined],
      ]);
      assert.equal(out.status, "failed");
      assert.equal(out.browserPod?.reconnects, 4);
      assert.equal(out.browserPod?.reconnected, 1);
      assert.match(out.browserPod?.lost?.detail ?? "", /Target page, context or browser has been closed/);
      assert.ok(lines.some((l) => /^browser pod: reconnected \(try 1 of 3, at \d\d:\d\d:\d\dZ\)/.test(l)), lines.join("\n"));
      const d = podLossDecision(out.browserPod!);
      assert.equal(d.rerun, expectRerun);
      if (!d.rerun) assert.match(d.message, /^browser pod died after the step had written a shell command/);
    } finally {
      server.close();
    }
  });
}

// ------------------------------------------- the real thing, where Playwright is
//
// browse.mjs itself against a real `playwright run-server`, SIGTERMed while a
// call waits — what the pod's server does when the pod is deleted. Skipped
// unless FOLDRUN_TEST_PLAYWRIGHT names a folder whose node_modules holds
// playwright@1.63 with Chromium installed (the hooks do not have one).

const PW = process.env.FOLDRUN_TEST_PLAYWRIGHT;
test("real Playwright: a pod server told to stop mid-call is reported dropped, not an ordinary error", { skip: !PW && "set FOLDRUN_TEST_PLAYWRIGHT" }, async () => {
  const root = fs.mkdtempSync(path.join(PW!, "slim-real-"));
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# t\n");
  const agent = path.join(root, "agent");
  fs.mkdirSync(agent);
  fs.writeFileSync(path.join(root, "browse.mjs"), BROWSE);
  const http = await import("node:http"); // a page to open

  const pageServer = http.createServer((_q, res) => { res.setHeader("content-type", "text/html"); res.end("<h1>hello pod</h1>"); });
  await new Promise<void>((ok) => pageServer.listen(0, "127.0.0.1", ok));
  const pagePort = (pageServer.address() as net.AddressInfo).port;
  const port = await new Promise<number>((ok) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => ok(p)); }); });
  const srv = spawn(process.execPath, [path.join(PW!, "node_modules/playwright/cli.js"), "run-server", "--unsafe", "--host", "127.0.0.1", "--port", String(port)], { stdio: "ignore" });
  try {
    for (let i = 0; i < 50; i++) {
      if (await new Promise((ok) => { const c = net.connect(port, "127.0.0.1"); c.once("connect", () => { c.destroy(); ok(true); }); c.once("error", () => ok(false)); })) break;
      await new Promise((ok) => setTimeout(ok, 100));
    }
    const env = { ...process.env, FOLDRUN_BROWSER_POD_ONLY: "1", FOLDRUN_BROWSER_WS: `ws://127.0.0.1:${port}/`, FOLDRUN_BROWSER_POD_CALL: path.join(root, "call.json") };
    const run = (actions: unknown[]) => new Promise<{ code: number | null; err: string }>((ok) => {
      const c = spawn(process.execPath, [path.join(root, "browse.mjs"), "--url", `http://127.0.0.1:${pagePort}/`, "--actions", JSON.stringify(actions)], { cwd: agent, env });
      let err = "";
      c.stderr.on("data", (d) => (err += d));
      c.on("close", (code) => ok({ code, err }));
    });
    // The agent's own error that reads like the pod's, on a healthy pod: not a drop.
    const own = await run([{ eval: "(() => { throw new Error('Target page, context or browser has been closed') })()" }]);
    assert.equal(own.code, 1);
    assert.ok(!fs.existsSync(env.FOLDRUN_BROWSER_POD_CALL), "a pod that answers is not called dropped");
    // The pod told to stop while the call waits.
    const pending = run([{ wait: 8000 }]);
    await new Promise((ok) => setTimeout(ok, 4000));
    srv.kill("SIGTERM");
    const r = await pending;
    assert.equal(r.code, 1);
    const call = JSON.parse(fs.readFileSync(env.FOLDRUN_BROWSER_POD_CALL, "utf8"));
    assert.equal(call.state, "dropped", r.err);
    assert.match(call.error, /Target page, context or browser has been closed|Browser closed/);
  } finally {
    srv.kill("SIGKILL");
    pageServer.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
