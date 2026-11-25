// Browse jobs (FOL-313): a cloud browser call with no run — the input rules,
// the pod's answer read, and the worker's one-call-never-twice path, on fake
// cluster calls and the in-process store.
//
//   node --test tests/browse-jobs.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-browse-jobs-"));
delete process.env.FOLDRUN_DATABASE_URL;

const bj = await import("../src/browse-jobs.ts");

const line = (o: object) => JSON.stringify(o);
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
const OK_LINES = [line({ t: "start" }), line({ t: "out", d: b64("# Example\n\nHello.") }), line({ t: "exit", code: 0 })];

test("input: a url, up to five flat steps of the fixed list, a mode — nothing that runs code, reaches files or branches", () => {
  const ok = bj.checkBrowseInput({ url: "https://example.com/a", steps: [{ click: "text=More" }, { fill: "#q", text: "x" }, { press: "", key: "Enter" }, { wait: 1500 }], mode: "text", allowed_domains: ["example.com"] });
  assert.ok("input" in ok, JSON.stringify(ok));
  assert.deepEqual(ok.input, { url: "https://example.com/a", mode: "text", steps: [{ click: "text=More" }, { fill: "#q", text: "x" }, { press: "", key: "Enter" }, { wait: 1500 }], allowedDomains: ["example.com"] });
  assert.equal((bj.checkBrowseInput({ url: "https://example.com" }) as { input: { mode: string } }).input.mode, "markdown");
  const refused = [
    {},
    { url: "file:///etc/passwd" },
    { url: "https://example.com:8443/" },
    { url: "https://user:pw@example.com/" },
    { url: "https://example.com", mode: "pdf" },
    { url: "https://example.com", steps: Array(6).fill({ click: "a" }) },
    { url: "https://example.com", steps: [{ eval: "document.cookie" }] },
    { url: "https://example.com", steps: [{ if: { expect: "a" }, then: [] }] },
    { url: "https://example.com", steps: [{ upload: "#f", file: "outputs/x" }] },
    { url: "https://example.com", steps: [{ download: "a", to: "outputs/x" }] },
    { url: "https://example.com", steps: [{ cookie: "s", value: "v" }] },
    { url: "https://example.com", steps: [{ wait: "fn", js: "1" }] },
    { url: "https://example.com", steps: [{ wait: 60_000 }] },
    { url: "https://example.com", steps: [{ goto: "http://169.254.169.254:8080/" }] },
    { url: "https://example.com", steps: [{ click: "a", fill: "b" }] },
    { url: "https://example.com", steps: [{ click: { nested: true } }] },
    { url: "https://example.com", allowed_domains: ["bad domain"] },
  ];
  for (const r of refused) assert.ok("error" in bj.checkBrowseInput(r), JSON.stringify(r));
});

test("argv: built from the typed input alone", () => {
  const { input } = bj.checkBrowseInput({ url: "https://example.com", steps: [{ click: "a" }], blocked_domains: ["ads.example"] }) as { input: import("../src/browse-jobs.ts").BrowseInput };
  assert.deepEqual(bj.programCall(input), {
    argv: ["--url", "https://example.com/", "--mode", "markdown", "--actions", '[{"click":"a"}]'],
    env: { FOLDRUN_BROWSER_HEADLESS: "true" },
  });
  // The domain rules are the lease's, on every connection, never a browser setting.
  assert.deepEqual(bj.leaseGrantOf(input, 5).network, { level: "open", hosts: [], deny: ["*.ads.example"] });
  const { input: only } = bj.checkBrowseInput({ url: "https://a.example", allowed_domains: ["a.example"] }) as { input: import("../src/browse-jobs.ts").BrowseInput };
  assert.deepEqual(bj.leaseGrantOf(only, 5).network, { level: "none", hosts: ["*.a.example"] });
  assert.equal(bj.leaseGrantOf(only, 5).purpose, "browse-job");
});

test("the pod's answer: the page, a screenshot within its cap, a refusal, never started, cut off", () => {
  const input = { url: "https://example.com/", mode: "markdown" as const };
  assert.deepEqual(bj.readCallStream(OK_LINES, input), { result: { url: "https://example.com/", text: "# Example\n\nHello." } });
  const shot = { url: "https://example.com/", mode: "screenshot" as const };
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  assert.deepEqual(bj.readCallStream([line({ t: "start" }), line({ t: "file", path: "agents/browse/outputs/page.png", d: b64(png) }), line({ t: "exit", code: 0 })], shot), { result: { url: "https://example.com/", screenshot: { media_type: "image/png", data: b64(png) } } });
  const big = Buffer.alloc(bj.LIMITS.screenshotBytes + 1);
  assert.equal((bj.readCallStream([line({ t: "start" }), line({ t: "file", path: "agents/browse/outputs/page.png", d: b64(big) }), line({ t: "exit", code: 0 })], shot) as { error: string }).error, "screenshot_too_large");
  assert.equal((bj.readCallStream([line({ t: "start" }), line({ t: "err", d: b64("net::ERR_NAME_NOT_RESOLVED\n") }), line({ t: "exit", code: 1 })], input) as { error: string; message: string }).error, "url_not_accessible");
  assert.equal((bj.readCallStream([line({ t: "refused" })], input) as { error: string }).error, "unavailable", "refused by the pod: never started");
  assert.equal((bj.readCallStream([], input) as { error: string }).error, "outcome_unknown", "answer lost after it was sent");
  const stepped = { url: "https://example.com/", mode: "markdown" as const, steps: [{ click: "a" }] };
  assert.equal((bj.readCallStream([line({ t: "start" }), line({ t: "exit", code: 1 })], stepped) as { error: string }).error, "outcome_unknown", "a step failed after others may have acted");
  assert.equal((bj.readCallStream([line({ t: "start" }), line({ t: "out", d: b64("half") })], input) as { error: string }).error, "outcome_unknown", "cut off after it started");
});

function fakeDeps(o: { call?: (body: unknown, signal: AbortSignal) => Promise<string[]>; podError?: boolean } = {}) {
  const seen = { leases: [] as { tenant: string; jobId: string; expiresAt: number }[], released: 0, pods: [] as string[], deleted: [] as string[], calls: [] as unknown[] };
  const deps: import("../src/browse-jobs.ts").BrowseJobDeps = {
    async lease(l) {
      seen.leases.push(l);
      return { token: `tok-${l.jobId}`, release: async () => void seen.released++ };
    },
    async ensurePod(p) {
      if (o.podError) return { error: "no room" };
      seen.pods.push(p.job);
      return { pod: `pod-${p.job}` };
    },
    async deletePod(pod) {
      seen.deleted.push(pod);
      return 3;
    },
    async call({ body, signal }) {
      seen.calls.push(body);
      return o.call ? o.call(body, signal) : OK_LINES;
    },
    programSha: () => "sha-of-browse",
  };
  return { deps, seen };
}

const input = (url = "https://example.com/") => (bj.checkBrowseInput({ url }) as { input: import("../src/browse-jobs.ts").BrowseInput }).input;

test("a job end to end: claimed, one lease ending at its deadline, one pod, one call with the server's argv and sha, the answer; pod and lease gone", async () => {
  bj.resetBrowseJobsForTests();
  const { deps, seen } = fakeDeps();
  const job = await bj.queueBrowseJob({ tenant: "acme", keyId: "k1", input: input() });
  await bj.drainBrowseJobs(deps);
  const answer = await bj.waitBrowseJob(job.id);
  assert.deepEqual(answer, { ok: true, result: { url: "https://example.com/", text: "# Example\n\nHello." } });
  assert.equal(seen.leases.length, 1);
  assert.equal(seen.leases[0]!.expiresAt, job.deadline, "the lease ends at the job's deadline");
  assert.deepEqual(seen.calls, [{ argv: ["--url", "https://example.com/", "--mode", "markdown"], env: { FOLDRUN_BROWSER_HEADLESS: "true" }, cwd: "agents/browse", sha: "sha-of-browse", files: [] }]);
  // The answer is written first; the pod and the lease go right after.
  for (let i = 0; i < 20 && seen.released === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen.deleted, [`pod-${job.id}`]);
  assert.equal(seen.released, 1);
});

test("the call goes to the pod's own address when its start knew it — no DNS name to race (dev, 25 Nov 2026)", async () => {
  bj.resetBrowseJobsForTests();
  const { deps } = fakeDeps();
  const ips: (string | undefined)[] = [];
  const withIp: typeof deps = { ...deps, ensurePod: async (p) => ({ pod: `pod-${p.job}`, ip: "10.40.1.7" }), call: async (c) => (ips.push(c.ip), deps.call(c)) };
  const job = await bj.queueBrowseJob({ tenant: "acme", keyId: "k1", input: input() });
  await bj.drainBrowseJobs(withIp);
  assert.equal((await bj.waitBrowseJob(job.id)).ok, true);
  assert.deepEqual(ips, ["10.40.1.7"]);
  // Without one: no address passed, the name is used (browseJobDeps).
  bj.resetBrowseJobsForTests();
  const plain: (string | undefined)[] = [];
  const job2 = await bj.queueBrowseJob({ tenant: "acme", keyId: "k1", input: input() });
  await bj.drainBrowseJobs({ ...deps, call: async (c) => (plain.push(c.ip), deps.call(c)) });
  assert.equal((await bj.waitBrowseJob(job2.id)).ok, true);
  assert.deepEqual(plain, [undefined]);
});

test("limits: one live job per key, two per account", async () => {
  bj.resetBrowseJobsForTests();
  await bj.queueBrowseJob({ tenant: "acme", keyId: "k1", input: input() });
  await assert.rejects(bj.queueBrowseJob({ tenant: "acme", keyId: "k1", input: input() }), (e: unknown) => (e as { code?: string }).code === "too_many_requests");
  await bj.queueBrowseJob({ tenant: "acme", keyId: "k2", input: input() });
  await assert.rejects(bj.queueBrowseJob({ tenant: "acme", keyId: "k3", input: input() }), (e: unknown) => (e as { code?: string }).code === "too_many_requests");
  await bj.queueBrowseJob({ tenant: "other", keyId: "k9", input: input() });
  const refused = await bj.runBrowse({ tenant: "acme", keyId: "k4", input: input() });
  assert.deepEqual(refused.ok ? null : refused.error, "too_many_requests");
});

test("a caller that leaves before the claim: cancelled, no pod made, no call sent", async () => {
  bj.resetBrowseJobsForTests();
  const { deps, seen } = fakeDeps();
  const job = await bj.queueBrowseJob({ tenant: "acme", keyId: "k1", input: input() });
  await bj.cancelBrowseJob(job.id);
  await bj.drainBrowseJobs(deps);
  assert.equal((await bj.getBrowseJob(job.id))!.state, "cancelled");
  assert.equal(seen.pods.length + seen.calls.length + seen.leases.length, 0);
});

test("a caller that leaves during the call: the call is aborted and the job is unknown — never sent again", async () => {
  bj.resetBrowseJobsForTests();
  let aborted = false;
  const { deps, seen } = fakeDeps({
    call: (_b, signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve([line({ t: "start" })]);
        });
      }),
  });
  const ac = new AbortController();
  const job = await bj.queueBrowseJob({ tenant: "acme", keyId: "k1", input: input() });
  const waiting = bj.waitBrowseJob(job.id, ac.signal);
  await bj.drainBrowseJobs(deps);
  await new Promise((r) => setTimeout(r, 50));
  ac.abort();
  const answer = await waiting;
  assert.equal(answer.ok, false);
  // The worker notices within its two-second watch, aborts, and settles it.
  for (let i = 0; i < 40 && (await bj.getBrowseJob(job.id))!.state !== "unknown"; i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(aborted, "the call was aborted");
  assert.equal((await bj.getBrowseJob(job.id))!.state, "unknown");
  assert.equal(seen.calls.length, 1);
  assert.equal(seen.deleted.length, 1);
});

test("a call the pod never started is a failure that cost nothing; a pod that cannot be made fails before any call", async () => {
  bj.resetBrowseJobsForTests();
  const a = fakeDeps({ call: async () => [line({ t: "refused" })] });
  const j1 = await bj.queueBrowseJob({ tenant: "acme", keyId: "k1", input: input() });
  await bj.drainBrowseJobs(a.deps);
  assert.deepEqual(await bj.waitBrowseJob(j1.id), { ok: false, error: "unavailable", message: "the browser call did not start" });
  const b = fakeDeps({ podError: true });
  const j2 = await bj.queueBrowseJob({ tenant: "acme", keyId: "k2", input: input() });
  await bj.drainBrowseJobs(b.deps);
  const answer = await bj.waitBrowseJob(j2.id);
  assert.equal(answer.ok ? "" : answer.error, "unavailable");
  assert.equal(b.seen.calls.length, 0);
  for (let i = 0; i < 20 && b.seen.released === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(b.seen.released, 1, "the lease is released");
});

test("a worker lost after the call was sent: the sweep makes it unknown, and nothing sends it again", async () => {
  bj.resetBrowseJobsForTests();
  const { deps, seen } = fakeDeps({ call: () => new Promise(() => {}) });
  const job = await bj.queueBrowseJob({ tenant: "acme", keyId: "k1", input: input() }, Date.now() - bj.LIMITS.deadlineMs + 200);
  void bj.drainBrowseJobs(deps);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await bj.getBrowseJob(job.id))!.state, "sent");
  assert.equal(await bj.sweepBrowseJobs(Date.now() + 60_000), 1);
  assert.equal((await bj.getBrowseJob(job.id))!.state, "unknown");
  await bj.drainBrowseJobs(deps);
  assert.equal(seen.calls.length, 1, "sent once");
  assert.equal(bj.answerOf((await bj.getBrowseJob(job.id))!).ok, false);
});

test("an Idempotency-Key makes one job: a second queue with it is refused as duplicate and finds the first", async () => {
  bj.resetBrowseJobsForTests();
  const j = await bj.queueBrowseJob({ tenant: "acme", keyId: "k1", input: input(), invocation: "idem-1" });
  await assert.rejects(bj.queueBrowseJob({ tenant: "acme", keyId: "k2", input: input(), invocation: "idem-1" }), (e: unknown) => (e as { code?: string }).code === "duplicate");
  assert.equal((await bj.findBrowseJob("acme", "idem-1"))!.id, j.id);
  assert.equal(await bj.findBrowseJob("other", "idem-1"), null);
});

test("a caller already gone queues nothing; one gone right after queueing cancels the job before any pod", async () => {
  bj.resetBrowseJobsForTests();
  const ac = new AbortController();
  ac.abort();
  assert.deepEqual(await bj.runBrowse({ tenant: "acme", keyId: "k1", input: input(), signal: ac.signal }), { ok: false, error: "unavailable", message: "the caller went away" });
  assert.equal((await bj.liveBrowseJobIds()).size, 0);
  const j = await bj.queueBrowseJob({ tenant: "acme", keyId: "k1", input: input() });
  await bj.waitBrowseJob(j.id, ac.signal);
  assert.equal((await bj.getBrowseJob(j.id))!.state, "cancelled");
});

test("a waiter past the deadline of a sent call is told outcome_unknown, never timeout", async () => {
  bj.resetBrowseJobsForTests();
  const { deps } = fakeDeps({ call: () => new Promise(() => {}) });
  const live = await bj.queueBrowseJob({ tenant: "acme", keyId: "k1", input: input() }, Date.now() - bj.LIMITS.deadlineMs + 300);
  void bj.drainBrowseJobs(deps);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await bj.getBrowseJob(live.id))!.state, "sent");
  const answer = await bj.waitBrowseJob(live.id);
  assert.equal(answer.ok ? "" : answer.error, "outcome_unknown");
});

test("the shared queue is capped across accounts", async () => {
  bj.resetBrowseJobsForTests();
  for (let i = 0; i < bj.LIMITS.liveJobsTotal; i++) await bj.queueBrowseJob({ tenant: `t${i}`, keyId: `k${i}`, input: input() });
  await assert.rejects(bj.queueBrowseJob({ tenant: "fresh", keyId: "kf", input: input() }), (e: unknown) => (e as { code?: string }).code === "too_many_requests");
});

test("runBrowse with an invocation: a retry replays the first answer (marked replayed); another input under the same key is refused; a waiter that leaves a replay does not cancel the job", async () => {
  bj.resetBrowseJobsForTests();
  const { deps, seen } = fakeDeps();
  const first = bj.runBrowse({ tenant: "acme", keyId: "k1", input: input(), invocation: "k1||r1" });
  await new Promise((r) => setTimeout(r, 20));
  const ac = new AbortController();
  const replayLeaving = bj.runBrowse({ tenant: "acme", keyId: "k1", input: input(), invocation: "k1||r1", signal: ac.signal });
  await new Promise((r) => setTimeout(r, 20));
  ac.abort();
  await replayLeaving;
  await bj.drainBrowseJobs(deps);
  const a = await first;
  assert.equal(a.ok, true, JSON.stringify(a));
  const again = await bj.runBrowse({ tenant: "acme", keyId: "k1", input: input(), invocation: "k1||r1" });
  assert.deepEqual(again.ok && again.replayed, true);
  const other = await bj.runBrowse({ tenant: "acme", keyId: "k1", input: input("https://other.example/"), invocation: "k1||r1" });
  assert.equal(other.ok ? "" : other.error, "invalid_tool_input");
  assert.equal(seen.calls.length, 1);
});

test("after steps, a missing or oversized screenshot is unknown; a blocked domain with a trailing dot is still refused at the lease", () => {
  const shot = { url: "https://example.com/", mode: "screenshot" as const, steps: [{ click: "a" }] };
  assert.equal((bj.readCallStream([line({ t: "start" }), line({ t: "exit", code: 0 })], shot) as { error: string }).error, "outcome_unknown");
  const { input: dotted } = bj.checkBrowseInput({ url: "https://a.example", blocked_domains: ["Ads.Example."] }) as { input: import("../src/browse-jobs.ts").BrowseInput };
  assert.deepEqual(bj.leaseGrantOf(dotted, 5).network.deny, ["*.ads.example"]);
});

test("a replay matches the same input whatever order its members came back in", async () => {
  bj.resetBrowseJobsForTests();
  const a = (bj.checkBrowseInput({ url: "https://example.com/", steps: [{ fill: "#q", text: "x" }] }) as { input: import("../src/browse-jobs.ts").BrowseInput }).input;
  await bj.queueBrowseJob({ tenant: "acme", keyId: "k1", input: a, invocation: "inv-order" });
  const reordered = { ...a, steps: [{ text: "x", fill: "#q" }] };
  const ac = new AbortController();
  const p = bj.replayBrowse("acme", "inv-order", reordered, ac.signal);
  ac.abort();
  const r = await p;
  assert.notEqual(r && !r.ok ? r.error : "", "invalid_tool_input");
  assert.equal(await bj.replayBrowse("acme", "none-such", a), null);
});

test("a job pod's deadline is a whole number of seconds (Kubernetes refuses a fraction)", async () => {
  const { browsePodManifest } = await import("../src/browse-service.ts");
  const m = browsePodManifest({ token: "t".repeat(40), seg: "acme", job: "bj-1", configMap: "cm", deadlineSec: 43.725 }) as { spec: { activeDeadlineSeconds: number } };
  assert.equal(m.spec.activeDeadlineSeconds, 43);
});
