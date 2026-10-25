// The platform never sends a request inward on a tenant's behalf: not from
// the egress proxy, not from a webhook, not from an OAuth token exchange.
import { test } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import http from "node:http";
import { fetch as undiciFetch } from "undici";
import { isPrivateAddress, refuseInternalUrl, fetchPublic, guardedLookup, PrivateAddressError, publicOnlyDispatcher, hop_ } from "../src/ssrf.ts";
import { egressHooks, startEgressProxy, stopEgressProxy } from "../src/egress-proxy.ts";

delete process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE;

test("every internal range is private, public addresses are not", () => {
  for (const ip of [
    "10.0.0.1", "10.40.3.4", "172.16.0.1", "172.31.255.255", "192.168.1.1", "127.0.0.1", "127.9.9.9",
    "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:a9fe:a9fe", "64:ff9b::a9fe:a9fe", "[::1]",
  ]) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ["1.1.1.1", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("a URL naming an internal host is refused before any connection", () => {
  for (const url of [
    "http://127.0.0.1:6379/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://[::ffff:10.0.0.1]/",
    "http://localhost/", "http://foldrun-redis:6379/", "http://foldrun-postgres/", "http://kubernetes.default.svc/api",
    "http://searxng.foldrun.svc.cluster.local:8080/", "http://metadata.google.internal/", "http://printer.local/",
    "http://2130706433/", "http://0x7f.1/",
  ]) assert.ok(refuseInternalUrl(url), url);
  for (const url of ["https://api.github.com/x", "https://hooks.slack.com/services/a"]) assert.equal(refuseInternalUrl(url), null, url);
});

test("a public name that resolves inward is refused at connect time (DNS rebinding)", async () => {
  const real = dns.lookup;
  (dns as { lookup: unknown }).lookup = (_h: string, _o: unknown, cb: (e: null, a: dns.LookupAddress[]) => void) =>
    cb(null, [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }]);
  try {
    const err = await new Promise<Error | null>((resolve) => guardedLookup("rebind.example.com", {}, (e) => resolve(e)));
    assert.ok(err instanceof PrivateAddressError, "any private answer in the set refuses the name");
    assert.match(err!.message, /10\.0\.0\.5/);
  } finally {
    (dns as { lookup: unknown }).lookup = real;
  }
});

test("fetchPublic refuses a live local server, and the switch lets a single-tenant install through", async () => {
  const server = http.createServer((_q, r) => r.end("inside")).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  try {
    await assert.rejects(fetchPublic(url), PrivateAddressError);
    process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE = "1";
    assert.equal(await (await fetchPublic(url)).text(), "inside");
  } finally {
    delete process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE;
    server.close();
  }
});

test("the egress proxy will not carry a tenant's secret to an internal host it granted", async () => {
  let reached = false;
  const inside = http.createServer((_q, r) => { reached = true; r.end("secret store"); }).listen(0, "127.0.0.1");
  await new Promise((r) => inside.once("listening", r));
  const host = `127.0.0.1:${(inside.address() as { port: number }).port}`;
  const proxy = await startEgressProxy(0);
  const prevUrl = process.env.FOLDRUN_EGRESS_URL;
  process.env.FOLDRUN_EGRESS_URL = `http://127.0.0.1:${proxy.port}`;
  const grant = { secrets: { K: { value: "v", hosts: [host] } } } as import("../../foldrun-core/src/egress.ts").EgressGrant;
  const lease = (await egressHooks.lease({ tenant: "attacker", runId: "run-ssrf", grant }))!;
  try {
    const res = await fetch(`${lease.url}/http://${host}/`);
    assert.equal(res.status, 403);
    assert.match(await res.text(), /private or internal/);
    assert.equal(reached, false, "the internal server never saw a request");
  } finally {
    await lease.release();
    await stopEgressProxy();
    if (prevUrl === undefined) delete process.env.FOLDRUN_EGRESS_URL; else process.env.FOLDRUN_EGRESS_URL = prevUrl;
    inside.close();
  }
});

// Redirects. The first hop has to look public to get past the up-front
// check, so these stand a "public" name in front of a loopback server via
// the one-hop seam; every later hop goes through fetchPublic's own checks.
// The suite runs under node --test (package.json), where undici's
// dispatcher is honoured; bun ignores a dispatcher, which is why the
// up-front check on every hop matters and is what these assert.
async function behindPublicName(handler: http.RequestListener) {
  const server = http.createServer(handler).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as { port: number }).port;
  const seen: { url: string; headers: Headers; method: string; body: unknown }[] = [];
  const real = hop_.fetch;
  hop_.fetch = async (url, init) => {
    seen.push({ url, headers: new Headers(init.headers), method: String(init.method), body: init.body });
    const u = new URL(url);
    if (u.hostname !== "public.example" && u.hostname !== "other.example") return real(url, init);
    return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, { ...init, redirect: "manual" });
  };
  return { port, seen, done: () => { hop_.fetch = real; server.close(); } };
}

test("a redirect to an internal IP literal is refused, and the internal server never sees a request", async () => {
  let reached = false;
  const inside = http.createServer((_q, r) => { reached = true; r.end("metadata"); }).listen(0, "127.0.0.1");
  await new Promise((r) => inside.once("listening", r));
  const insidePort = (inside.address() as { port: number }).port;
  const s = await behindPublicName((_q, r) => { r.writeHead(302, { location: `http://127.0.0.1:${insidePort}/latest/meta-data/` }); r.end(); });
  try {
    await assert.rejects(fetchPublic("http://public.example/start"), (e: Error) => e instanceof PrivateAddressError && /redirected to 127\.0\.0\.1/.test(e.message));
    for (const target of ["http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://localhost/"]) {
      const t = await behindPublicName((_q, r) => { r.writeHead(307, { location: target }); r.end(); });
      try {
        await assert.rejects(fetchPublic("http://public.example/x"), PrivateAddressError, target);
      } finally {
        t.done();
      }
    }
    assert.equal(reached, false);
  } finally {
    s.done();
    inside.close();
  }
});

test("a public redirect is followed; another origin loses the credential headers", async () => {
  const s = await behindPublicName((q, r) => {
    if (q.url === "/a") { r.writeHead(302, { location: "/b" }); return r.end(); }
    if (q.url === "/b") { r.writeHead(301, { location: "http://other.example/c" }); return r.end(); }
    r.end(`landed ${q.url}`);
  });
  try {
    const res = await fetchPublic("http://public.example/a", { headers: { authorization: "Bearer t", cookie: "s=1", "x-keep": "1" } });
    assert.equal(await res.text(), "landed /c");
    assert.deepEqual(s.seen.map((h) => h.url), ["http://public.example/a", "http://public.example/b", "http://other.example/c"]);
    assert.equal(s.seen[1].headers.get("authorization"), "Bearer t", "same origin keeps it");
    assert.equal(s.seen[2].headers.get("authorization"), null, "another origin does not get it");
    assert.equal(s.seen[2].headers.get("cookie"), null);
    assert.equal(s.seen[2].headers.get("x-keep"), "1");
  } finally {
    s.done();
  }
});

test("a body is not resent to another origin; a 303 turns a POST into a GET; hops are capped", async () => {
  const s = await behindPublicName((q, r) => {
    if (q.url === "/307") { r.writeHead(307, { location: "http://other.example/steal" }); return r.end(); }
    if (q.url === "/303") { r.writeHead(303, { location: "/done" }); return r.end(); }
    if (q.url?.startsWith("/loop")) { r.writeHead(302, { location: "/loop" }); return r.end(); }
    r.end(`${q.method} ${q.url}`);
  });
  try {
    const kept = await fetchPublic("http://public.example/307", { method: "POST", body: "client_secret=s" });
    assert.equal(kept.status, 307, "the caller gets the redirect, not a resend of its body");
    assert.equal(s.seen.length, 1);
    assert.equal(await (await fetchPublic("http://public.example/303", { method: "POST", body: "x" })).text(), "GET /done");
    await assert.rejects(fetchPublic("http://public.example/loop"), /more than 5 redirects/);
  } finally {
    s.done();
  }
});

test("redirect: error refuses to follow, for a request that must reach the URL it names", async () => {
  const s = await behindPublicName((_q, r) => { r.writeHead(307, { location: "http://other.example/token" }); r.end(); });
  try {
    await assert.rejects(fetchPublic("http://public.example/token", { method: "POST", body: "a=b", redirect: "error" }), /does not follow redirects/);
    assert.equal(s.seen.length, 1);
  } finally {
    s.done();
  }
});

test("the dispatcher itself refuses an IP literal inward, whatever skipped the up-front check", async () => {
  let reached = false;
  const server = http.createServer((_q, r) => { reached = true; r.end("inside"); }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as { port: number }).port;
  try {
    for (const url of [`http://127.0.0.1:${port}/`, `http://[::ffff:127.0.0.1]:${port}/`]) {
      await assert.rejects(
        undiciFetch(url, { dispatcher: publicOnlyDispatcher() }),
        (e: { cause?: unknown }) => e.cause instanceof PrivateAddressError,
        url,
      );
    }
    assert.equal(reached, false);
  } finally {
    server.close();
  }
});

// ---- FOL-85: the answer's size, and the two callers that used to skip this ----

import fs from "node:fs";
import path from "node:path";
import { registerPlatform, resetPlatform } from "../../foldrun-core/src/platform.ts";
import { ResponseTooLarge, MAX_BYTES } from "../../foldrun-core/src/untrusted-fetch.ts";
import { testTool } from "../../foldrun-core/src/tool-test.ts";
import { workspaceTools, workspaceDir } from "../../foldrun-core/src/store.ts";
import { startTranslator } from "../../foldrun-core/src/translator.ts";

test("fetchPublic reads an answer to 1 MiB: past it the body errors, never ends short; Infinity lifts it", async () => {
  const s = await behindPublicName((q, r) => {
    r.writeHead(200, { "content-type": "text/plain" });
    r.end("a".repeat(q.url === "/big" ? MAX_BYTES + 1 : MAX_BYTES));
  });
  try {
    await assert.rejects((await fetchPublic("http://public.example/big")).text(), ResponseTooLarge);
    assert.equal((await (await fetchPublic("http://public.example/fits")).text()).length, MAX_BYTES);
    assert.equal((await (await fetchPublic("http://public.example/big", {}, { maxBytes: Infinity })).text()).length, MAX_BYTES + 1);
    await assert.rejects((await fetchPublic("http://public.example/fits", {}, { maxBytes: 10 })).arrayBuffer(), /more than 10 bytes/);
  } finally {
    s.done();
  }
});

/** core's platform.fetchUntrusted bound to this guard, as index.ts binds it,
 *  and an "internal" server that must never be reached. */
async function withRealGuard(run: (insidePort: number, reached: () => boolean) => Promise<void>) {
  let hit = false;
  const inside = http.createServer((_q, r) => { hit = true; r.end("inside"); }).listen(0, "127.0.0.1");
  await new Promise((r) => inside.once("listening", r));
  registerPlatform({ fetchUntrusted: fetchPublic });
  try {
    await run((inside.address() as { port: number }).port, () => hit);
  } finally {
    resetPlatform();
    inside.close();
  }
}

function writeTool(base: string) {
  const file = path.join(workspaceDir("fol85", "desk"), "tools/api/tool.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\ntransport: http\nname: api\ndescription: t\nbase: ${base}\nmethods: [GET]\n---\n`);
  return workspaceTools("fol85", "desk").api;
}

test("the tool test goes through this guard: the cluster, loopback and the metadata endpoint are refused", () =>
  withRealGuard(async (port, reached) => {
    for (const base of [
      `http://127.0.0.1:${port}`,
      `http://[::ffff:7f00:1]:${port}`, // ::ffff:127.0.0.1, as URL writes it
      "http://10.43.0.1:443", // the kube API's Service address
      "http://169.254.169.254/latest/meta-data",
      "http://foldrun-postgres:5432",
    ]) {
      const result = await testTool("fol85", "desk", writeTool(base), { path: "/" });
      assert.equal(result.ok, false, base);
      assert.match(result.summary, /private or internal|internal name/, base);
      assert.equal(result.detail, "", `${base}: nothing from the far side`);
    }
    const mcp = await testTool("fol85", "desk", { kind: "mcp", name: "m", spec: { url: `http://127.0.0.1:${port}/mcp` } } as never);
    assert.equal(mcp.ok, false);
    assert.equal(reached(), false, "the internal server never saw a request");
  }));

test("the tool test still reaches a public base, and a redirect from it toward the metadata endpoint is not followed", () =>
  withRealGuard(async () => {
    const s = await behindPublicName((q, r) => {
      if (q.url === "/hop") { r.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }); return r.end(); }
      r.end("pong");
    });
    try {
      const ok = await testTool("fol85", "desk", writeTool("http://public.example"), { path: "/ping" });
      assert.equal(ok.ok, true, ok.summary);
      assert.equal(ok.detail, "pong");
      const hop = await testTool("fol85", "desk", writeTool("http://public.example"), { path: "/hop" });
      assert.equal(hop.ok, false);
      assert.deepEqual(s.seen.map((h) => h.url), ["http://public.example/ping", "http://public.example/hop"], "169.254.169.254 was never asked");
    } finally {
      s.done();
    }
  }));

test("the host-side model translator goes through this guard: a provider base_url inside the platform is refused", () =>
  withRealGuard(async (port, reached) => {
    const t = await startTranslator({ upstreamBase: `http://127.0.0.1:${port}/v1`, upstreamKey: "sk-x" });
    try {
      const res = await fetch(`${t.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": t.key },
        body: JSON.stringify({ model: "m", max_tokens: 5, messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(res.status, 502);
      assert.match(JSON.stringify(await res.json()), /private or internal address/);
      assert.equal(reached(), false);
    } finally {
      await t.close();
    }
  }));
