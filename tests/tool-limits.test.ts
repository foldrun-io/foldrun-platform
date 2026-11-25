import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { withToolLimits, toolLimits, toolLimitsNow, toolLimitsHeld, resetToolLimitsForTests, type ToolLimits } from "../src/tool-limits.ts";
import { withToolCache, resetToolCacheForTests, type ToolCacheStore } from "../src/tool-cache.ts";
import type { ToolRunners } from "../src/server-tools.ts";

beforeEach(() => {
  resetToolLimitsForTests();
  resetToolCacheForTests();
});

/** A rung whose calls stay open until released, counting how many run. */
function gated() {
  let open = 0;
  let peak = 0;
  let calls = 0;
  const waiting: (() => void)[] = [];
  const hold = async () => {
    calls++;
    open++;
    peak = Math.max(peak, open);
    await new Promise<void>((r) => waiting.push(r));
    open--;
  };
  const r: ToolRunners = {
    search: async () => {
      await hold();
      return { results: [{ url: "https://example.org/", title: "t", snippet: "s" }], via: "rung" } as never;
    },
    fetchPage: async () => {
      await hold();
      return { page: { url: "https://example.org/", title: "t", text: "x", mediaType: "text/plain", retrievedAt: "" }, via: "rung" } as never;
    },
  };
  return {
    r,
    releaseOne: () => waiting.shift()?.(),
    releaseAll: () => {
      while (waiting.length) waiting.shift()!();
    },
    stats: () => ({ open, peak, calls, waiting: waiting.length }),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));
const L = (o: Partial<ToolLimits> = {}): ToolLimits => ({ perAccount: 2, perProcess: 3, waitMs: 1000, maxWaiting: 100, ...o });
const fetchOpts = { maxChars: 1000, allow: () => true };

test("toolLimits reads the environment, with defaults and ceilings", () => {
  assert.deepEqual(toolLimits({}), { perAccount: 16, perProcess: 128, waitMs: 10_000, maxWaiting: 256 });
  assert.deepEqual(toolLimits({ FOLDRUN_TOOL_PER_ACCOUNT: "4", FOLDRUN_TOOL_PER_PROCESS: "40", FOLDRUN_TOOL_WAIT_MS: "500", FOLDRUN_TOOL_MAX_WAITING: "7" }), { perAccount: 4, perProcess: 40, waitMs: 500, maxWaiting: 7 });
  assert.deepEqual(toolLimits({ FOLDRUN_TOOL_PER_ACCOUNT: "0", FOLDRUN_TOOL_PER_PROCESS: "-3", FOLDRUN_TOOL_WAIT_MS: "x" }), { perAccount: 16, perProcess: 128, waitMs: 10_000, maxWaiting: 256 });
  assert.equal(toolLimits({ FOLDRUN_TOOL_WAIT_MS: "99999999" }).waitMs, 120_000);
});

test("one account never runs more than its cap at once; the rest wait their turn", async () => {
  const g = gated();
  const c = withToolLimits("acme", g.r, { limits: L() });
  const all = [1, 2, 3, 4].map(() => c.search({ query: "q" }, {}));
  await tick();
  assert.equal(g.stats().open, 2);
  assert.equal(toolLimitsNow().waiting, 2);
  g.releaseAll();
  await tick();
  g.releaseAll();
  const got = await Promise.all(all);
  assert.ok(got.every((x) => "results" in x));
  assert.equal(g.stats().peak, 2);
  assert.deepEqual(toolLimitsNow(), { total: 0, waiting: 0, accounts: {} });
});

test("the process cap holds across accounts; one account at its cap does not block another", async () => {
  const g = gated();
  const lim = L({ perAccount: 2, perProcess: 3 });
  const a = withToolLimits("a", g.r, { limits: lim });
  const b = withToolLimits("b", g.r, { limits: lim });
  const calls = [a.search({ query: "1" }, {}), a.search({ query: "2" }, {}), a.search({ query: "3" }, {}), b.fetchPage("https://x.test/", fetchOpts), b.fetchPage("https://y.test/", fetchOpts)];
  await tick();
  // a:2 (its cap), b:1 (process cap 3 reached); a's third and b's second wait.
  assert.deepEqual(toolLimitsNow().accounts, { a: 2, b: 1 });
  g.releaseOne(); // one of a's ends: a's waiter is first in line and fits again
  await tick();
  assert.equal(toolLimitsNow().total, 3);
  g.releaseAll();
  await tick();
  g.releaseAll();
  await tick();
  g.releaseAll();
  await Promise.all(calls);
  assert.ok(g.stats().peak <= 3);
});

test("a waiting account's line does not hold up another account that fits", async () => {
  const g = gated();
  const lim = L({ perAccount: 1, perProcess: 10 });
  const a = withToolLimits("a", g.r, { limits: lim });
  const b = withToolLimits("b", g.r, { limits: lim });
  const a1 = a.search({ query: "1" }, {});
  const a2 = a.search({ query: "2" }, {}); // waits: a is at its cap
  await tick();
  const b1 = b.search({ query: "3" }, {}); // fits now, despite a2 waiting
  await tick();
  assert.deepEqual(toolLimitsNow().accounts, { a: 1, b: 1 });
  g.releaseAll();
  await tick();
  g.releaseAll();
  await Promise.all([a1, a2, b1]);
});

test("past the wait, the call answers too_many_requests without running", async () => {
  const g = gated();
  const c = withToolLimits("acme", g.r, { limits: L({ perAccount: 1, waitMs: 30 }) });
  const first = c.search({ query: "q" }, {});
  const second = await c.fetchPage("https://x.test/", fetchOpts);
  assert.deepEqual(second, { error: "too_many_requests" });
  assert.equal(g.stats().calls, 1);
  assert.equal(toolLimitsNow().waiting, 0);
  g.releaseAll();
  await first;
  assert.equal(toolLimitsNow().total, 0);
});

test("a caller that leaves while waiting gives its place up and runs nothing", async () => {
  const g = gated();
  const c = withToolLimits("acme", g.r, { limits: L({ perAccount: 1 }) });
  const first = c.search({ query: "q" }, {});
  const ac = new AbortController();
  const second = c.search({ query: "q2" }, { signal: ac.signal });
  await tick();
  ac.abort();
  assert.deepEqual(await second, { error: "unavailable" });
  assert.equal(toolLimitsNow().waiting, 0);
  g.releaseAll();
  await first;
  assert.equal(g.stats().calls, 1);
  const pre = new AbortController();
  pre.abort();
  assert.deepEqual(await c.search({ query: "q3" }, { signal: pre.signal }), { error: "unavailable" });
  assert.equal(g.stats().calls, 1);
});

test("a rung that throws still gives its slot back", async () => {
  const r: ToolRunners = { search: async () => { throw new Error("boom"); }, fetchPage: async () => ({ error: "unavailable" }) };
  const c = withToolLimits("acme", r, { limits: L({ perAccount: 1 }) });
  await assert.rejects(c.search({ query: "q" }, {}), /boom/);
  assert.deepEqual(toolLimitsNow(), { total: 0, waiting: 0, accounts: {} });
});

test("browse goes straight through, and is absent when the rung has none", async () => {
  let n = 0;
  const g = gated();
  const r: ToolRunners = { ...g.r, browse: async () => { n++; return { error: "unavailable" as never }; } };
  const c = withToolLimits("acme", r, { limits: L({ perAccount: 1 }) });
  const s = c.search({ query: "q" }, {});
  await c.browse!({} as never, {}); // not held behind the search's slot
  assert.equal(n, 1);
  assert.equal(withToolLimits("acme", g.r).browse, undefined);
  g.releaseAll();
  await s;
});

test("under the cache, a hit takes no slot", async () => {
  const g = gated();
  const m = new Map<string, string>();
  const store: ToolCacheStore = { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
  const env = { FOLDRUN_TOOL_CACHE_SEARCH_S: "600" } as NodeJS.ProcessEnv;
  const c = withToolCache("acme", withToolLimits("acme", g.r, { limits: L({ perAccount: 1, waitMs: 30 }) }), { store, env });
  const miss = c.search({ query: "same" }, {});
  await tick();
  g.releaseAll();
  await miss;
  // Hold the one slot with another search, then ask the cached one again.
  const other = c.search({ query: "other" }, {});
  await tick();
  const hit = await c.search({ query: "same" }, {});
  assert.ok("results" in hit && hit.via === "cache");
  g.releaseAll();
  await other;
});

test("a freed slot goes to the first waiter that fits, past one whose account is at its cap", async () => {
  const g = gated();
  const lim = L({ perAccount: 1, perProcess: 2, waitMs: 1000 });
  const a = withToolLimits("a", g.r, { limits: lim });
  const b = withToolLimits("b", g.r, { limits: lim });
  const cc = withToolLimits("c", g.r, { limits: lim });
  const c1 = cc.search({ query: "c1" }, {}); // opened first, so released first
  const a1 = a.search({ query: "a1" }, {}); // the process is full: c1, a1
  await tick();
  const a2 = a.search({ query: "a2" }, {}); // first in line, but a stays at its cap
  const b1 = b.search({ query: "b1" }, {}); // second in line
  await tick();
  assert.equal(toolLimitsNow().waiting, 2);
  g.releaseOne(); // c1 ends
  await tick();
  // b1 runs now, past a2; it does not wait out the timeout.
  assert.deepEqual(toolLimitsNow().accounts, { a: 1, b: 1 });
  assert.equal(toolLimitsNow().waiting, 1);
  g.releaseAll();
  await tick();
  g.releaseAll();
  await Promise.all([a1, c1, a2, b1]);
});

test("the wait line is bounded: past it a call is refused at once", async () => {
  const g = gated();
  const c = withToolLimits("acme", g.r, { limits: L({ perAccount: 1, maxWaiting: 2, waitMs: 5000 }) });
  const running = c.search({ query: "r" }, {});
  const w1 = c.search({ query: "w1" }, {});
  const w2 = c.search({ query: "w2" }, {});
  await tick();
  const t0 = Date.now();
  assert.deepEqual(await c.search({ query: "w3" }, {}), { error: "too_many_requests" });
  assert.ok(Date.now() - t0 < 100);
  assert.equal(toolLimitsNow().waiting, 2);
  g.releaseAll();
  await tick();
  g.releaseAll();
  await tick();
  g.releaseAll();
  await Promise.all([running, w1, w2]);
});

test("a waiter past its deadline is refused at hand-off even when its timer is late", async () => {
  const g = gated();
  const c = withToolLimits("acme", g.r, { limits: L({ perAccount: 1, waitMs: 20 }) });
  const first = c.search({ query: "r" }, {});
  const late = c.search({ query: "late" }, {});
  await new Promise((r) => setImmediate(r));
  // Hold the event loop past the wait, then free the slot: the hand-off runs
  // (a microtask) before the overdue timer can.
  const end = Date.now() + 40;
  while (Date.now() < end) { /* busy */ }
  g.releaseOne();
  const got = await Promise.race([late, new Promise((r) => setTimeout(() => r("let in after its deadline"), 300))]);
  assert.equal(g.stats().calls, 1, "the overdue caller ran upstream");
  assert.deepEqual(got, { error: "too_many_requests" });
  await first;
  assert.deepEqual(toolLimitsNow(), { total: 0, waiting: 0, accounts: {} });
});

// The slot is given back when a runner returns, so an error answer's body is
// closed first, not left streaming on a connection past the cap (Codex).
import { serpApiSearch, directFetch } from "../src/server-tool-runners.ts";

function slowBody(status: number) {
  let cancelled = false;
  const body = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } });
  return { res: new Response(body, { status }), cancelled: () => cancelled };
}

for (const status of [429, 500]) {
  test(`a SerpApi ${status} closes its body before answering`, async () => {
    const b = slowBody(status);
    const got = await serpApiSearch({ query: "q" }, { key: "k", fetch: (async () => b.res) as typeof fetch });
    assert.deepEqual(got, { error: status === 429 ? "too_many_requests" : "unavailable" });
    assert.ok(b.cancelled());
  });
  test(`a fetched page's ${status} closes its body before answering`, async () => {
    const b = slowBody(status);
    const got = await directFetch("https://example.org/", { maxChars: 100 }, { fetchPublic: (async () => b.res) as never });
    assert.deepEqual(got, { error: status === 429 ? "too_many_requests" : "url_not_accessible" });
    assert.ok(b.cancelled());
  });
}

test("draining a long line of overdue waiters is one linear pass", async () => {
  const g = gated();
  const n = 20_000;
  const c = withToolLimits("acme", g.r, { limits: L({ perAccount: 1, perProcess: 10, waitMs: 50, maxWaiting: n }) });
  const first = c.search({ query: "r" }, {});
  const all = Array.from({ length: n }, (_, i) => c.search({ query: `w${i}` }, {}));
  await Promise.resolve(); // microtasks only: no expiry timer may run yet
  assert.equal(toolLimitsNow().waiting, n);
  const end = Date.now() + 80;
  while (Date.now() < end) { /* the loop falls behind past every deadline */ }
  const t0 = performance.now();
  g.releaseOne();
  await first;
  const got = await Promise.all(all);
  assert.ok(performance.now() - t0 < 1000, `took ${performance.now() - t0} ms`);
  assert.ok(got.every((x) => "error" in x && x.error === "too_many_requests"));
  assert.equal(g.stats().calls, 1);
  assert.deepEqual(toolLimitsNow(), { total: 0, waiting: 0, accounts: {} });
});

test("draining a long line of live waiters, one release at a time, stays linear", async () => {
  const g = gated();
  const n = 5_000;
  const c = withToolLimits("acme", g.r, { limits: L({ perAccount: n, perProcess: 1, waitMs: 60_000, maxWaiting: n }) });
  const first = c.search({ query: "r" }, {});
  const all = Array.from({ length: n }, (_, i) => c.search({ query: `w${i}` }, {}));
  await Promise.resolve();
  assert.equal(toolLimitsNow().waiting, n);
  const t0 = performance.now();
  for (let i = 0; i <= n; i++) {
    g.releaseOne();
    await new Promise((r) => setImmediate(r));
  }
  await first;
  await Promise.all(all);
  assert.equal(g.stats().calls, n + 1);
  assert.equal(g.stats().peak, 1);
  assert.ok(performance.now() - t0 < 5000, `took ${performance.now() - t0} ms`);
  assert.deepEqual(toolLimitsNow(), { total: 0, waiting: 0, accounts: {} });
});

test("a parked waiter is served first when its own account frees a slot", async () => {
  const g = gated();
  const lim = L({ perAccount: 1, perProcess: 2, waitMs: 5000 });
  const started: string[] = [];
  const r: ToolRunners = { ...g.r, search: async (q, ctx) => (started.push(q.query), g.r.search(q, ctx)) };
  const a_ = withToolLimits("a", r, { limits: lim });
  const b_ = withToolLimits("b", r, { limits: lim });
  const c_ = withToolLimits("c", r, { limits: lim });
  const a1 = a_.search({ query: "a1" }, {}); // released first
  const b1 = b_.search({ query: "b1" }, {}); // the process is full
  await tick();
  const b2 = b_.search({ query: "b2" }, {}); // b at its cap
  const a2 = a_.search({ query: "a2" }, {});
  await tick();
  g.releaseOne(); // a1 ends: the line parks b2 (b at its cap), a2 runs
  await tick();
  const c1 = c_.search({ query: "c1" }, {}); // newer, and c would fit
  await tick();
  g.releaseOne(); // b1 ends: b's parked b2 runs, not the newer c1
  await tick();
  assert.deepEqual(started, ["a1", "b1", "a2", "b2"]);
  assert.equal(toolLimitsNow().waiting, 1);
  g.releaseAll();
  await tick();
  g.releaseAll();
  await Promise.all([a1, b1, a2, b2, c1]);
  assert.deepEqual(toolLimitsNow(), { total: 0, waiting: 0, accounts: {} });
});

test("callers that leave while every slot stays busy are not kept in the queue", async () => {
  const g = gated();
  const c = withToolLimits("acme", g.r, { limits: L({ perAccount: 1, waitMs: 5, maxWaiting: 3 }) });
  const running = c.search({ query: "r" }, {});
  for (let round = 0; round < 50; round++) {
    await Promise.all([1, 2, 3].map((i) => c.search({ query: `w${round}-${i}` }, {})));
  }
  assert.equal(toolLimitsHeld(), 0);
  assert.equal(toolLimitsNow().waiting, 0);
  g.releaseAll();
  await running;
});
