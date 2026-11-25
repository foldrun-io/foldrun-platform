// FOL-321: web_search's short cache (src/tool-cache.ts).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { withToolCache, ttlSetting, searchKey, redisStore, roomInRedis, resetToolCacheForTests, type ToolCacheStore } from "../src/tool-cache.ts";
import type { SearchResult, ToolRunners } from "../src/server-tools.ts";

function mapStore() {
  const m = new Map<string, { v: string; ttl: number }>();
  let sets = 0;
  const store: ToolCacheStore = {
    async get(k) { return m.get(k)?.v ?? null; },
    // ttl: the seconds from now the write was given, rounded.
    async set(k, v, at) { sets++; m.set(k, { v, ttl: Math.round((at - Date.now()) / 1000) }); },
  };
  return { m, store, sets: () => sets };
}
const flush = () => new Promise((r) => setImmediate(r));
const env = {} as NodeJS.ProcessEnv;
const result = (over: Partial<SearchResult> = {}): SearchResult => ({ url: "https://a.example/", title: "t", snippet: "s", page_age: null, ...over });

/** A search rung that counts its calls; `answer` decides what it returns. */
function rung(answer: () => Awaited<ReturnType<ToolRunners["search"]>> = () => ({ results: [result()], via: "serpapi" }), delayMs = 0) {
  const calls = { search: 0, fetch: 0 };
  const r: ToolRunners = {
    async search() {
      calls.search++;
      if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
      return answer();
    },
    async fetchPage(url) {
      calls.fetch++;
      return { page: { url, title: "T", text: "body", mediaType: "text/html", retrievedAt: "z" }, via: "direct" };
    },
  };
  return { r, calls };
}

beforeEach(() => resetToolCacheForTests());

test("a search asked twice is answered once upstream; the second says via: cache", async () => {
  const { store, m } = mapStore();
  const { r, calls } = rung();
  const c = withToolCache("acme", r, { store, env });
  const a = await c.search({ query: "redis ttl" }, {});
  await flush();
  const b = await c.search({ query: "redis ttl" }, {});
  assert.equal(calls.search, 1);
  assert.ok(!("error" in a) && a.via === "serpapi");
  assert.ok(!("error" in b) && b.via === "cache");
  assert.deepEqual((b as { results: unknown }).results, (a as { results: unknown }).results);
  assert.equal([...m.values()][0]!.ttl, 600, "default TTL");
});

test("one account's answer never answers another account", async () => {
  const { store } = mapStore();
  const { r, calls } = rung();
  await withToolCache("acme", r, { store, env }).search({ query: "q" }, {});
  await flush();
  const other = await withToolCache("globex", r, { store, env }).search({ query: "q" }, {});
  assert.equal(calls.search, 2);
  assert.ok(!("error" in other) && other.via === "serpapi");
  assert.notEqual(searchKey("acme", { query: "q" }), searchKey("globex", { query: "q" }));
});

test("an error is never stored", async () => {
  const { store, m } = mapStore();
  const { r, calls } = rung(() => ({ error: "unavailable" }));
  const c = withToolCache("acme", r, { store, env });
  await c.search({ query: "q" }, {});
  await flush();
  await c.search({ query: "q" }, {});
  assert.equal(calls.search, 2);
  assert.equal(m.size, 0);
});

test("the key holds what changes the rung or its question", () => {
  const base = searchKey("acme", { query: "q" });
  assert.notEqual(base, searchKey("acme", { query: "q", allowed_domains: ["a.com"] }));
  assert.notEqual(base, searchKey("acme", { query: "q", blocked_domains: ["a.com"] }));
  assert.notEqual(base, searchKey("acme", { query: "q", user_location: { country: "AU" } }));
  // Any location skips the account's own engine, country or not.
  assert.notEqual(base, searchKey("acme", { query: "q", user_location: { city: "Sydney" } }));
  // SerpApi is sent the first eight as written: a different order is a different search.
  const nine = ["a1.com", "a2.com", "a3.com", "a4.com", "a5.com", "a6.com", "a7.com", "a8.com", "a9.com"];
  const swapped = ["a9.com", ...nine.slice(1, 8), "a1.com"];
  assert.notEqual(searchKey("acme", { query: "q", allowed_domains: nine }), searchKey("acme", { query: "q", allowed_domains: swapped }));
});

test("TTL 0 turns it off; bad settings are the default", async () => {
  const { store, m } = mapStore();
  const { r, calls } = rung();
  const c = withToolCache("acme", r, { store, env: { FOLDRUN_TOOL_CACHE_SEARCH_S: "0" } as NodeJS.ProcessEnv });
  await c.search({ query: "q" }, {});
  await flush();
  await c.search({ query: "q" }, {});
  assert.equal(calls.search, 2);
  assert.equal(m.size, 0);
  for (const bad of [undefined, "", "-1", "1.5", "abc", "999999"]) assert.equal(ttlSetting(bad, 600), 600, String(bad));
  assert.equal(ttlSetting("30", 600), 30);
});

test("a store that throws or answers junk is a miss, never a failed call", async () => {
  const broken: ToolCacheStore = { get: async () => { throw new Error("down"); }, set: async () => { throw new Error("down"); } };
  const junk: ToolCacheStore = { get: async () => "{not json", set: async () => {} };
  for (const store of [broken, junk]) {
    const { r } = rung();
    const got = await withToolCache("acme", r, { store, env }).search({ query: "q" }, {});
    assert.ok(!("error" in got) && got.via === "serpapi");
  }
});

test("a stored record of the wrong shape is a miss, not a crash", async () => {
  for (const bad of [{ results: [null], storedAt: Date.now() }, { results: [{ url: 1 }], storedAt: Date.now() }, { results: [] }]) {
    const store: ToolCacheStore = { get: async () => JSON.stringify(bad), set: async () => {} };
    const { r, calls } = rung();
    const got = await withToolCache("acme", r, { store, env }).search({ query: "q" }, {});
    assert.ok(!("error" in got) && got.via === "serpapi", JSON.stringify(bad));
    assert.equal(calls.search, 1);
  }
});

test("a burst of identical searches makes one upstream call and one write; waiters say via: cache", async () => {
  const { store, sets } = mapStore();
  const { r, calls } = rung(undefined, 20);
  const c = withToolCache("acme", r, { store, env });
  const all = await Promise.all(Array.from({ length: 5 }, () => c.search({ query: "burst" }, {})));
  await flush();
  assert.equal(calls.search, 1);
  assert.equal(sets(), 1);
  assert.deepEqual(all.map((g) => ("error" in g ? "error" : g.via)).sort(), ["cache", "cache", "cache", "cache", "serpapi"]);
});

test("a joiner whose caller leaves stops waiting and is not retried", async () => {
  const { store } = mapStore();
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  let n = 0;
  const r: ToolRunners = { search: async () => { n++; await gate; return { error: "unavailable" }; }, fetchPage: async () => ({ error: "unavailable" }) };
  const c = withToolCache("acme", r, { store, env });
  const leader = c.search({ query: "slow" }, {});
  await flush();
  const ac = new AbortController();
  const joiner = c.search({ query: "slow" }, { signal: ac.signal });
  await flush();
  ac.abort();
  // The joiner answers while the leader is still held.
  assert.deepEqual(await joiner, { error: "unavailable" });
  release();
  await leader;
  assert.equal(n, 1, "no call was made for the caller that left");
});

test("a caller that leaves while the cache is read gets no hit", async () => {
  const ac = new AbortController();
  const stored = JSON.stringify({ results: [], via: "serpapi", storedAt: Date.now() });
  const store: ToolCacheStore = { get: async () => { ac.abort(); return stored; }, set: async () => {} };
  const { r, calls } = rung();
  assert.deepEqual(await withToolCache("acme", r, { store, env }).search({ query: "q" }, { signal: ac.signal }), { error: "unavailable" });
  assert.equal(calls.search, 0);
});

test("a rate limit or timeout is shared with the waiters; a leader's own abort is not", async () => {
  {
    const { store, m } = mapStore();
    const { r, calls } = rung(() => ({ error: "too_many_requests" }), 20);
    const c = withToolCache("acme", r, { store, env });
    const all = await Promise.all(Array.from({ length: 5 }, () => c.search({ query: "q" }, {})));
    assert.equal(calls.search, 1);
    assert.ok(all.every((g) => "error" in g && g.error === "too_many_requests" && !("share" in g)));
    assert.equal(m.size, 0);
  }
  {
    const { store } = mapStore();
    const ac = new AbortController();
    let n = 0;
    const r: ToolRunners = { search: async () => { n++; await new Promise((res) => setTimeout(res, 20)); return n === 1 ? { error: "unavailable" } : { results: [result()], via: "serpapi" }; }, fetchPage: async () => ({ error: "unavailable" }) };
    const c = withToolCache("acme", r, { store, env });
    const leader = c.search({ query: "q" }, { signal: ac.signal });
    await flush();
    const joiner = c.search({ query: "q" }, {});
    ac.abort();
    await leader;
    const got = await joiner;
    assert.ok(!("error" in got), "the waiter asked on its own");
    assert.equal(n, 2);
  }
});

// Answers that may carry a credential: neither kept nor handed to a waiter.
const SECRETS: Array<[string, Partial<SearchResult>]> = [
  ["token in the link", { url: "https://files.example/doc?token=abc123" }],
  ["user part in the link", { url: "https://user:pw@x.example/" }],
  ["apostrophe user part in the link", { url: "https://o'brien:pw@x.example/" }],
  ["undecodable user part", { url: "https://%zz@x.example/" }],
  ["fragment token", { url: "https://app.example/cb#access_token=abc" }],
  ["encoded signed link in a parameter", { url: "https://a.example/r?u=" + encodeURIComponent("https://files.example/x?token=abc") }],
  ["double-encoded link", { snippet: "https://a.example/r?u=" + encodeURIComponent("https://b.example/r?u=" + encodeURIComponent("https://f.example/x?token=abc")) }],
  ["signature in a snippet", { snippet: "HTTPS://F.EXAMPLE/X?SIGNATURE=abc" }],
  ["token in a title", { title: "see https://f.example/x?token=abc" }],
  ["token in page_age", { page_age: "https://f.example/x?token=abc" }],
  ["refresh token", { snippet: "https://a.example/cb?refresh_token=abc" }],
  ["id token", { snippet: "https://a.example/x?id_token=z" }],
  ["OAuth callback", { snippet: "https://app.example/cb?code=abc&state=xyz" }],
  ["link cut short by a paren", { snippet: "see https://files.example/report(final)?token=abc" }],
  ["scheme-relative user part", { snippet: "see //alice:password@files.example/report" }],
  ["apostrophe user part in text", { snippet: "see https://o'brien:pw@x.example/" }],
  ["link inside a link", { snippet: "https://a.example/r?u=https://tok@b.example/" }],
  ["escaped percent name", { snippet: "https://f.example/a?%74oken=abc" }],
  ["backslash escapes", { snippet: "https:\\/\\/alice:pw@files.example\\/x" }],
  ["unicode escape", { snippet: "https://f.example/x?a=1\\u0026token=abc" }],
  ["jwt parameter", { url: "https://a.example/x?jwt=abc.def.ghi" }],
  // Key-shaped values are joined at runtime so the repo's secret scanner
  // does not read these made-up test values as real keys.
  ["bearer header", { snippet: ["curl -H 'Authorization:", "Bearer", "x".repeat(4) + "abcdef123456'"].join(" ") }],
  ["JWT-shaped string", { snippet: "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig" }],
  ["encoded bearer header", { snippet: "Authorization%3A%20Bearer%20abcdef1234567890" }],
  ["basic header", { snippet: "Authorization: Basic dXNlcjpwYXNzd29yZA==" }],
  ["JSON access_token field", { snippet: '{"access' + '_token": "' + "ya29." + "q".repeat(10) + '"}' }],
  ["env api key", { snippet: "OPENAI" + "_API_KEY=" + "q".repeat(12) }],
  ["PEM private key", { snippet: "-----BEGIN RSA PRIVATE KEY----- MIIEow" }],
  ["bare GitHub token", { snippet: "leaked ghp_abcdefghijklmnopqrstuvwxyz0123" }],
  ["bare AWS key id", { snippet: "AKIA" + "Q".repeat(16) + " in a gist" }],
  ["foldrun key", { snippet: "fr" + "_api_" + "a1b2c3d4".repeat(6) }],
  ["fine-grained GitHub token", { snippet: "github" + "_pat_" + "A1b2C3d4E5".repeat(6) }],
  ["Slack webhook", { snippet: "https://hooks.slack.com/services/" + "T0123ABCD/B0123ABCD/" + "a1B2c3D4e5F6g7H8i9J0k1L2" }],
  ["short quoted password", { snippet: '{"password": "1234"}' }],
];

test("an answer that may carry a credential is neither kept nor handed to a waiter", async () => {
  for (const [name, over] of SECRETS) {
    resetToolCacheForTests();
    const { store, m } = mapStore();
    const { r, calls } = rung(() => ({ results: [result(over)], via: "serpapi" }), 10);
    const c = withToolCache("acme", r, { store, env });
    const all = await Promise.all([1, 2, 3].map(() => c.search({ query: "q" }, {})));
    await flush();
    assert.equal(m.size, 0, `${name}: not kept`);
    assert.equal(calls.search, 3, `${name}: each caller asked on its own`);
    assert.ok(all.every((g) => !("error" in g) && g.results.length === 1), `${name}: still answered`);
  }
});

test("an ordinary answer is kept: an e-mail address, a link with plain parameters", async () => {
  const { store, m } = mapStore();
  const { r } = rung(() => ({ results: [result({ snippet: "mail bob@example.com, see https://docs.example/a?page=2" })], via: "serpapi" }));
  await withToolCache("acme", r, { store, env }).search({ query: "q" }, {});
  await flush();
  assert.equal(m.size, 1);
});

test("the scan is linear on long text", async () => {
  const { store } = mapStore();
  const { r } = rung(() => ({ results: [result({ snippet: "a://".repeat(25_000) + "x".repeat(100_000) })], via: "serpapi" }));
  const t0 = Date.now();
  await withToolCache("acme", r, { store, env }).search({ query: "q" }, {});
  assert.ok(Date.now() - t0 < 200, `took ${Date.now() - t0} ms`);
});

test("an answer too big to keep is answered, not stored and not shared", async () => {
  const { store, m } = mapStore();
  // 100 000 three-byte characters: under the limit in characters, over it in bytes.
  const { r, calls } = rung(() => ({ results: [result({ snippet: "€".repeat(100_000) })], via: "serpapi" }), 10);
  const c = withToolCache("acme", r, { store, env });
  await Promise.all([1, 2].map(() => c.search({ query: "q" }, {})));
  await flush();
  assert.equal(m.size, 0);
  assert.equal(calls.search, 2);
});

test("a lowered TTL applies to what is already stored", async () => {
  const old = JSON.stringify({ results: [], via: "serpapi", storedAt: Date.now() - 60_000 });
  const store: ToolCacheStore = { get: async () => old, set: async () => {} };
  const { r, calls } = rung();
  const got = await withToolCache("acme", r, { store, env: { FOLDRUN_TOOL_CACHE_SEARCH_S: "10" } as NodeJS.ProcessEnv }).search({ query: "q" }, {});
  assert.ok(!("error" in got) && got.via === "serpapi", "a minute-old record under a 10 s TTL is a miss");
  assert.equal(calls.search, 1);
});

test("the write's deadline is absolute, fixed when the answer came back; one already past is skipped", async () => {
  let at = 0;
  const store: ToolCacheStore = { get: async () => null, set: async (_k, _v, x) => { at = x; } };
  const t0 = Date.now();
  await withToolCache("acme", rung().r, { store, env }).search({ query: "q" }, {});
  await flush();
  assert.ok(at >= t0 + 600_000 && at <= Date.now() + 600_000, "epoch ms");
  const { store: s2, m } = mapStore();
  const realNow = Date.now;
  let calls = 0;
  const r: ToolRunners = {
    search: async () => {
      // From here the clock reads the answer's arrival first, then 20 s later.
      const base = realNow();
      Date.now = () => (calls++ === 0 ? base : base + 20_000);
      return { results: [result()], via: "serpapi" };
    },
    fetchPage: async () => ({ error: "unavailable" }),
  };
  try {
    await withToolCache("acme", r, { store: s2, env: { FOLDRUN_TOOL_CACHE_SEARCH_S: "10" } as NodeJS.ProcessEnv }).search({ query: "q" }, {});
  } finally {
    Date.now = realNow;
  }
  await flush();
  assert.equal(m.size, 0);
});

test("the cache writes only within its share of the room Redis has left", () => {
  const MB = 1024 * 1024;
  assert.equal(roomInRedis(`used_memory:0\r\nmaxmemory:${256 * MB}\r\n`, env), 8 * MB, "capped at the window");
  assert.equal(roomInRedis(`used_memory:${120 * MB}\r\nmaxmemory:${256 * MB}\r\n`, env), Math.floor((8 * MB) / 16), "a sixteenth of what is left under half");
  assert.equal(roomInRedis(`used_memory:${130 * MB}\r\nmaxmemory:${256 * MB}\r\n`, env), 0, "past half");
  assert.equal(roomInRedis(`used_memory:${130 * MB}\r\nmaxmemory:${256 * MB}\r\n`, { FOLDRUN_TOOL_CACHE_REDIS_SHARE: "1" } as NodeJS.ProcessEnv), 0, "a share past 0.9 is the default");
  assert.equal(roomInRedis(`used_memory:${200 * MB}\r\nmaxmemory:0\r\n`, env), 0, "no maxmemory: 128 MB");
  assert.equal(roomInRedis("garbage", env), 0, "unreadable: no writes");
});

test("with no Redis configured the store answers nothing", async () => {
  const saved = process.env.FOLDRUN_REDIS_URL;
  delete process.env.FOLDRUN_REDIS_URL;
  try {
    assert.equal(await redisStore.get("tc:v1:s:x"), null);
    await redisStore.set("tc:v1:s:x", "{}", Date.now() + 10_000);
  } finally {
    if (saved !== undefined) process.env.FOLDRUN_REDIS_URL = saved;
  }
});

test("web_fetch is not cached: every fetch goes to the rung and nothing is kept", async () => {
  const { store, m } = mapStore();
  const { r, calls } = rung();
  const c = withToolCache("acme", r, { store, env });
  for (let i = 0; i < 2; i++) await c.fetchPage("https://x.example/", { maxChars: 10, allow: () => true });
  await flush();
  assert.equal(calls.fetch, 2);
  assert.equal(m.size, 0);
});

test("a search asked while the first answer's write is still settling is answered without another upstream call", async () => {
  let finish!: () => void;
  const slow = new Promise<void>((res) => { finish = res; });
  const store: ToolCacheStore = { get: async () => null, set: async () => { await slow; } };
  const { r, calls } = rung();
  const c = withToolCache("acme", r, { store, env });
  await c.search({ query: "q" }, {});
  const again = await c.search({ query: "q" }, {});
  assert.equal(calls.search, 1);
  assert.ok(!("error" in again) && again.via === "cache");
  finish();
});

test("the rung setting is part of the key; a caller arriving during the lookup joins it", async () => {
  assert.notEqual(searchKey("acme", { query: "q" }, "searxng:img"), searchKey("acme", { query: "q" }, "serpapi"));
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  const store: ToolCacheStore = { get: async () => { await gate; return null; }, set: async () => {} };
  const { r, calls } = rung();
  const c = withToolCache("acme", r, { store, env });
  const first = c.search({ query: "q" }, {});
  await flush();
  const second = c.search({ query: "q" }, {});
  release();
  await Promise.all([first, second]);
  assert.equal(calls.search, 1, "the second joined while the first read Redis");
});

test("after the leader leaves, the waiters elect one new leader instead of each asking", async () => {
  const { store } = mapStore();
  let n = 0;
  const r: ToolRunners = { search: async () => { n++; await new Promise((res) => setTimeout(res, 20)); return n === 1 ? { error: "unavailable" } : { results: [result()], via: "serpapi" }; }, fetchPage: async () => ({ error: "unavailable" }) };
  const c = withToolCache("acme", r, { store, env });
  const ac = new AbortController();
  const leader = c.search({ query: "q" }, { signal: ac.signal });
  await flush();
  const waiters = [1, 2, 3].map(() => c.search({ query: "q" }, {}));
  ac.abort();
  await leader;
  const got = await Promise.all(waiters);
  assert.ok(got.every((g) => !("error" in g)));
  assert.equal(n, 2, "one call for the leader that left, one for all the waiters");
});

test("web_browse passes straight through, and is absent when the rung has none", async () => {
  const { store } = mapStore();
  let n = 0;
  const r: ToolRunners = { ...rung().r, browse: async () => { n++; return { error: "unavailable" as never }; } };
  const c = withToolCache("acme", r, { store, env });
  assert.ok(c.browse);
  await c.browse!({} as never, {});
  await c.browse!({} as never, {});
  assert.equal(n, 2);
  assert.equal(withToolCache("acme", rung().r, { store, env }).browse, undefined);
});

test("a rung that throws is shared as unavailable, not retried by each waiter", async () => {
  const { store } = mapStore();
  let n = 0;
  const r: ToolRunners = { search: async () => { n++; await new Promise((res) => setTimeout(res, 20)); throw new TypeError("bad provider answer"); }, fetchPage: async () => ({ error: "unavailable" }) };
  const c = withToolCache("acme", r, { store, env });
  const all = await Promise.all([1, 2, 3].map(() => c.search({ query: "q" }, {})));
  assert.equal(n, 1);
  assert.ok(all.every((g) => "error" in g && g.error === "unavailable"));
});
