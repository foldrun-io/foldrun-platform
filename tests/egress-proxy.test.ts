// The egress proxy: a step's credentials at the boundary, not in the
// sandbox. The pure rules on their own, then a real lease driven end to
// end against a fake upstream that records what reached it.
//
//   node --test tests/egress-proxy.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { egressHooks, fillForHost, liveLeases, parseEgressPath, startEgressProxy, stopEgressProxy, testModeVerdict } from "../src/egress-proxy.ts";
import { proxyModelEnv, unsubstitute, type EgressGrant } from "../../foldrun-core/src/egress.ts";
import { REFUSAL_MARK } from "../../foldrun-core/src/refusal.ts";

// The fake upstreams here listen on 127.0.0.1, which the proxy refuses to
// reach by default (ssrf.ts); tests/ssrf.test.ts covers that refusal.
process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE = "1";

test("the path carries the lease and the whole target, query included", () => {
  const p = parseEgressPath("/e/abcdefghijklmnopqrstuvwx/https://api.resend.com/emails?x=1&y=%20z")!;
  assert.equal(p.token, "abcdefghijklmnopqrstuvwx");
  assert.equal(p.target, "https://api.resend.com/emails?x=1&y=%20z");
  assert.equal(parseEgressPath("/e/short/https://x"), null, "a token too short is not a lease");
  assert.equal(parseEgressPath("/e/abcdefghijklmnopqrstuvwx/ftp://x"), null, "http(s) only");
  assert.equal(parseEgressPath("/other"), null);
});

test("a placeholder is filled only for a host its secret was granted to", () => {
  const grant: EgressGrant = {
    secrets: {
      RESEND_API_KEY: { value: "re_live", hosts: ["api.resend.com"] },
      STRIPE_API_KEY: { value: "sk_live", hosts: ["api.stripe.com"] },
    },
  };
  const secrets = { RESEND_API_KEY: "re_live", STRIPE_API_KEY: "sk_live" };
  const ok = fillForHost("Bearer ${RESEND_API_KEY}", "api.resend.com", secrets, grant);
  assert.equal(ok.text, "Bearer re_live");
  assert.deepEqual(ok.used, ["RESEND_API_KEY"]);
  // The other secret, sent to this host, stays a literal placeholder: the
  // provider will reject it, loudly, instead of a key leaking sideways.
  const wrong = fillForHost("Bearer ${STRIPE_API_KEY}", "api.resend.com", secrets, grant);
  assert.equal(wrong.text, "Bearer ${STRIPE_API_KEY}");
  assert.deepEqual(wrong.used, []);
  // Unknown names are left alone too.
  assert.equal(fillForHost("${NOPE}", "api.resend.com", secrets, grant).text, "${NOPE}");
});

test("a model env is rewritten to go through the lease with its key as a placeholder", () => {
  const grant: EgressGrant = { secrets: {} };
  const out = proxyModelEnv(
    { ANTHROPIC_API_KEY: "sk-ant-real", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_CUSTOM_HEADERS: "X-Title: foldrun\nHTTP-Referer: https://x" },
    "http://worker:8090/e/tok",
    grant,
  );
  assert.equal(out.ANTHROPIC_BASE_URL, "http://worker:8090/e/tok/https://api.anthropic.com", "the default base, via the lease");
  assert.equal(out.ANTHROPIC_API_KEY, "${FOLDRUN_MODEL_KEY}");
  assert.equal(out.ANTHROPIC_AUTH_TOKEN, "", "an empty credential stays empty");
  assert.deepEqual(grant.secrets.FOLDRUN_MODEL_KEY, { value: "sk-ant-real", hosts: ["api.anthropic.com"] });
  // A provider block's own base and a bearer token, with a header that
  // carried a secret's value: the value goes back to being its name.
  const g2: EgressGrant = { secrets: {} };
  const out2 = proxyModelEnv(
    { ANTHROPIC_BASE_URL: "https://openrouter.ai/api", ANTHROPIC_AUTH_TOKEN: "sk-or-v1-abcdefgh", ANTHROPIC_CUSTOM_HEADERS: "x-extra: sk-or-v1-abcdefgh" },
    "http://w/e/t",
    g2,
    { OPENROUTER_API_KEY: "sk-or-v1-abcdefgh" },
    "FOLDRUN_MODEL_KEY_FALLBACK",
  );
  assert.equal(out2.ANTHROPIC_BASE_URL, "http://w/e/t/https://openrouter.ai/api");
  assert.equal(out2.ANTHROPIC_AUTH_TOKEN, "${FOLDRUN_MODEL_KEY_FALLBACK}");
  assert.equal(out2.ANTHROPIC_CUSTOM_HEADERS, "x-extra: ${OPENROUTER_API_KEY}");
  assert.deepEqual(Object.keys(g2.secrets).sort(), ["FOLDRUN_MODEL_KEY_FALLBACK", "OPENROUTER_API_KEY"]);
  assert.deepEqual(g2.secrets.OPENROUTER_API_KEY.hosts, ["openrouter.ai"]);
});

test("unsubstitute puts names back longest-first and never touches short values", () => {
  const grant: EgressGrant = { secrets: {} };
  const text = unsubstitute("a=LONGSECRETVALUE b=LONGSECRET c=ab", { A: "LONGSECRETVALUE", B: "LONGSECRET", C: "ab" }, "h", grant);
  assert.equal(text, "a=${A} b=${B} c=ab");
  assert.deepEqual(Object.keys(grant.secrets).sort(), ["A", "B"]);
});

function fakeUpstream() {
  const seen: { method: string; path: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body });
      res.writeHead(201, { "content-type": "application/json", "x-upstream": "yes" });
      res.end(JSON.stringify({ ok: true, got: req.headers.authorization ?? null }));
    });
  });
  return new Promise<{ host: string; seen: typeof seen; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ host: `127.0.0.1:${port}`, seen, close: () => server.close() });
    });
  });
}

test("end to end: the pod sends a placeholder through the lease, the upstream receives the value, and nothing else gets through", async () => {
  const up = await fakeUpstream();
  const proxy = await startEgressProxy(0);
  const prevUrl = process.env.FOLDRUN_EGRESS_URL;
  process.env.FOLDRUN_EGRESS_URL = `http://127.0.0.1:${proxy.port}`;
  try {
    const grant = { secrets: { RESEND_API_KEY: { value: "re_live_123456", hosts: [up.host] } } } as import("../../foldrun-core/src/egress.ts").EgressGrant;
    const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-1", grant }))!;
    assert.ok(lease, "a lease when the url is set");
    assert.match(lease.url, new RegExp(`^http://127\\.0\\.0\\.1:${proxy.port}/e/[A-Za-z0-9_-]{32}$`));
    assert.equal(await liveLeases(), 1);

    // What the pod does: the header still says ${RESEND_API_KEY}.
    const res = await fetch(`${lease.url}/http://${up.host}/emails?dry=1`, {
      method: "POST",
      headers: { authorization: "Bearer ${RESEND_API_KEY}", "content-type": "application/json", "x-passthrough": "kept" },
      body: JSON.stringify({ to: "a@b" }),
    });
    assert.equal(res.status, 201, "the upstream's status crosses back");
    assert.equal(res.headers.get("x-upstream"), "yes", "and its headers");
    const body = (await res.json()) as { got: string };
    assert.equal(body.got, "Bearer re_live_123456", "the upstream saw the value");
    assert.equal(up.seen[0].method, "POST");
    assert.equal(up.seen[0].path, "/emails?dry=1", "path and query intact");
    assert.equal(up.seen[0].headers["x-passthrough"], "kept");
    assert.equal(up.seen[0].body, '{"to":"a@b"}', "the body streamed through");
    assert.equal(up.seen[0].headers.host, up.host, "host is the upstream's, not the proxy's");

    // A grant added AFTER the lease exists is honoured — the runner adds the
    // model key's host once it has the lease URL to point the SDK at.
    const late = await fetch(`${lease.url}/https://api.example.net/x`, { headers: { authorization: "Bearer ${LATE}" } });
    assert.equal(late.status, 403, "not granted yet");
    grant.secrets.LATE = { value: "late-value-123", hosts: ["api.example.net"] };
    // commit() is what publishes an addition: a no-op for the memory store,
    // which shares the grant by reference, and the write for Redis.
    await lease.commit();
    // (api.example.net does not answer, so 502 — the point is it was not refused as a host)
    const after = await fetch(`${lease.url}/https://api.example.net/x`, { headers: { authorization: "Bearer ${LATE}" } });
    assert.notEqual(after.status, 403, "granted now");

    // A host the lease does not name: refused, and said in the log.
    const other = await fetch(`${lease.url}/https://api.stripe.com/v1/charges`, { headers: { authorization: "Bearer ${RESEND_API_KEY}" } });
    assert.equal(other.status, 403);
    assert.equal(up.seen.length, 1, "nothing was sent");

    const log = await lease.drainLog();
    // Refusals first, as they happened; then the calls that went through,
    // grouped by method, host, path and status.
    assert.ok(log.some((l) => /api\.example\.net refused/.test(l)), "the not-yet-granted host was refused once");
    assert.ok(log.some((l) => /api\.stripe\.com refused/.test(l)));
    assert.ok(log.some((l) => /^egress: POST 127\.0\.0\.1:\d+\/emails → 201 \(\d+ms\) \[RESEND_API_KEY\]$/.test(l)));

    // After release the token is dead, and the values are gone with it.
    await lease.release();
    assert.equal(await liveLeases(), 0);
    const dead = await fetch(`${lease.url}/http://${up.host}/emails`, { headers: { authorization: "Bearer ${RESEND_API_KEY}" } });
    assert.equal(dead.status, 401);
    assert.equal(up.seen.length, 1);

    // No url configured → no lease → the runner materialises as before.
    delete process.env.FOLDRUN_EGRESS_URL;
    assert.equal(await egressHooks.lease({ tenant: "acme", runId: "r", grant: { secrets: {} } }), null);
  } finally {
    if (prevUrl === undefined) delete process.env.FOLDRUN_EGRESS_URL;
    else process.env.FOLDRUN_EGRESS_URL = prevUrl;
    await stopEgressProxy();
    up.close();
  }
});

test("a lease is released even when a test aborts — nothing is left in the store", async () => {
  // Housekeeping for the Redis-backed run of this file: a lease leaked by an
  // earlier failing assertion would make liveLeases() lie to the next run.
  assert.equal(await liveLeases(), 0);
});

test("end to end: a bad path and a bad target are told apart", async () => {
  const proxy = await startEgressProxy(0);
  try {
    const base = `http://127.0.0.1:${proxy.port}`;
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/e/abcdefghijklmnopqrstuvwxyz012345/https://example.com/`)).status, 401, "a token nobody issued");
  } finally {
    await stopEgressProxy();
  }
});

// ------------------------------------------------------------ test mode
//
// The same lease, marked `test`: an outward write to a host that is not
// read-safe is answered 403 with the would-have body and reaches nothing; a
// Resend send is pointed at the sink; reads and model calls pass. The
// policy itself is unit-tested in core (tests/test-mode.test.ts); this is
// the proxy applying it, end to end, and the trace lines it leaves.
test("end to end: a test lease refuses a send, sinks an email, passes a read, and says so in the log", async () => {
  const up = await fakeUpstream();
  const proxy = await startEgressProxy(0);
  const prevUrl = process.env.FOLDRUN_EGRESS_URL;
  process.env.FOLDRUN_EGRESS_URL = `http://127.0.0.1:${proxy.port}`;
  try {
    // The fake upstream stands in for every host: the grant names it under
    // several names would need DNS, so the policy is exercised by path and
    // the refusal by a host the table does not know — the fake's own.
    const grant = { secrets: { TWILIO_AUTH_TOKEN: { value: "tw_secret_1234", hosts: [up.host] } } } as import("../../foldrun-core/src/egress.ts").EgressGrant;
    const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-t", grant, test: true }))!;

    // A read passes, value filled, exactly as on a live lease.
    const read = await fetch(`${lease.url}/http://${up.host}/2010-04-01/Accounts/AC1/Messages.json?PageSize=1`, {
      headers: { authorization: "Bearer ${TWILIO_AUTH_TOKEN}" },
    });
    assert.equal(read.status, 201);
    assert.equal(up.seen.length, 1);
    assert.equal(up.seen[0].headers.authorization, "Bearer tw_secret_1234");

    // A write to an unknown host is refused, and the upstream never hears of it.
    const send = await fetch(`${lease.url}/http://${up.host}/2010-04-01/Accounts/AC1/Messages.json`, {
      method: "POST",
      headers: { authorization: "Bearer ${TWILIO_AUTH_TOKEN}", "content-type": "application/x-www-form-urlencoded" },
      body: "To=%2B61400000000&From=%2B61400000001&Body=Your+inspection+is+booked",
    });
    assert.equal(send.status, 403);
    const refused = (await send.json()) as { test_mode: boolean; would_have: { method: string; to: string; body: string } };
    assert.equal(refused.test_mode, true);
    assert.equal(refused.would_have.method, "POST");
    assert.equal(refused.would_have.to, "+61400000000");
    assert.match(refused.would_have.body, /Your\+inspection/);
    assert.equal(up.seen.length, 1, "nothing was sent");

    const log = await lease.drainLog();
    const effects = log.filter((l): l is { text: string; effect: import("../../foldrun-core/src/test-mode.ts").TestEffect } => typeof l !== "string");
    assert.equal(effects.length, 1);
    assert.equal(effects[0].effect.kind, "refused");
    assert.equal(effects[0].effect.method, "POST");
    assert.equal(effects[0].effect.path, "/2010-04-01/Accounts/AC1/Messages.json");
    assert.match(effects[0].text, /^test: POST 127\.0\.0\.1:\d+\/2010-04-01\/Accounts\/AC1\/Messages\.json refused — would have sent To=/);
    assert.ok(log.some((l) => typeof l === "string" && /^egress: GET .* → 201/.test(l)), "the read is in the log as a call");
    await lease.release();

    // The same grant WITHOUT test: the write goes through. Test mode weakens
    // nothing for a live run because it does nothing for one. (A fresh grant
    // object: release() drops the values from the one it was given.)
    const liveGrant = { secrets: { TWILIO_AUTH_TOKEN: { value: "tw_secret_1234", hosts: [up.host] } } } as import("../../foldrun-core/src/egress.ts").EgressGrant;
    const live = (await egressHooks.lease({ tenant: "acme", runId: "run-l", grant: liveGrant }))!;
    const sent = await fetch(`${live.url}/http://${up.host}/2010-04-01/Accounts/AC1/Messages.json`, {
      method: "POST",
      headers: { authorization: "Bearer ${TWILIO_AUTH_TOKEN}" },
      body: "To=%2B61400000000",
    });
    assert.equal(sent.status, 201);
    assert.equal(up.seen.length, 2);
    await live.release();
  } finally {
    if (prevUrl === undefined) delete process.env.FOLDRUN_EGRESS_URL;
    else process.env.FOLDRUN_EGRESS_URL = prevUrl;
    await stopEgressProxy();
    up.close();
  }
});

test("the proxy's verdict on a test lease: a Resend send is rewritten to the sink, a form post elsewhere is refused with its would-have, a read passes", async () => {
  const email = JSON.stringify({ from: "d@x.io", to: ["customer@example.com"], cc: "boss@example.com", subject: "Report", text: "hi" });
  const sent = await testModeVerdict(true, "POST", "api.resend.com", "https://api.resend.com/emails", async () => Buffer.from(email));
  assert.equal(sent.kind, "forward");
  if (sent.kind === "forward") {
    const body = JSON.parse(sent.body.toString("utf8"));
    assert.deepEqual(body.to, ["delivered@resend.dev"]);
    assert.equal(body.cc, undefined);
    assert.equal(body.subject, "[TEST] Report");
    assert.equal(sent.effect.kind, "redirected");
    assert.match(sent.text, /redirected to delivered@resend\.dev — would have gone to customer@example\.com, boss@example\.com/);
  }
  const sms = await testModeVerdict(true, "POST", "api.twilio.com", "https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json", async () => Buffer.from("To=%2B61400000000&Body=hi"));
  assert.equal(sms.kind, "refuse");
  if (sms.kind === "refuse") {
    assert.equal(sms.status, 403);
    assert.equal(JSON.parse(sms.body).would_have.to, "+61400000000");
    assert.equal(sms.effect.kind, "refused");
  }
  // A send whose body cannot be redirected is refused rather than sent as-is.
  const odd = await testModeVerdict(true, "POST", "api.resend.com", "https://api.resend.com/emails", async () => Buffer.from("not json"));
  assert.equal(odd.kind, "refuse");
  // Reads pass without the body being read at all; a live lease never gets here.
  let read = false;
  assert.deepEqual(await testModeVerdict(true, "GET", "api.twilio.com", "https://api.twilio.com/x", async () => { read = true; return Buffer.alloc(0); }), { kind: "pass" });
  assert.equal(read, false);
  assert.deepEqual(await testModeVerdict(false, "POST", "api.twilio.com", "https://api.twilio.com/x", async () => { read = true; return Buffer.alloc(0); }), { kind: "pass" });
  assert.equal(read, false);
});

// ------------------------------------------------------- provider refusals
//
// The incident this covers: several desks failed with nothing in the record
// but `→ 401 × 4` and a fallback `→ 402`, and an hour on the box to find
// that the subscription had refused the burst with overage off for lack of
// credits. Anthropic said so in headers on that very response, and the
// proxy is the only party that sees them. It now writes one sentence per
// refusal into the step's trace — core owns the words and the allow-list
// (foldrun-core/src/refusal.ts); this is the proxy putting them there.

/** An upstream that answers with a chosen status and header set. */
function refusingUpstream(status: number, headers: Record<string, string>) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify({ error: "no" }));
    });
  });
  return new Promise<{ host: string; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ host: `127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

async function refusalLog(status: number, headers: Record<string, string>, timezone?: string): Promise<string[]> {
  const up = await refusingUpstream(status, headers);
  const proxy = await startEgressProxy(0);
  const prevUrl = process.env.FOLDRUN_EGRESS_URL;
  process.env.FOLDRUN_EGRESS_URL = `http://127.0.0.1:${proxy.port}`;
  try {
    const grant = {
      secrets: { FOLDRUN_MODEL_KEY: { value: "sk-ant-real-value", hosts: [up.host] } },
      ...(timezone ? { timezone } : {}),
    } as import("../../foldrun-core/src/egress.ts").EgressGrant;
    const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-refuse", grant }))!;
    const res = await fetch(`${lease.url}/http://${up.host}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer ${FOLDRUN_MODEL_KEY}", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, status, "the upstream's status crosses back unchanged");
    const log = (await lease.drainLog()).map((l) => (typeof l === "string" ? l : l.text));
    await lease.release();
    return log;
  } finally {
    if (prevUrl === undefined) delete process.env.FOLDRUN_EGRESS_URL;
    else process.env.FOLDRUN_EGRESS_URL = prevUrl;
    await stopEgressProxy();
    up.close();
  }
}

test("a refused burst is explained in the step's own words and its own zone", async () => {
  // 14:00 Sydney on a day this test does not care about: resetWhen prints
  // the date too when it is not today there, so the assertion is on the
  // clock and the zone, which is the part that cost the hour.
  const reset = Math.floor(Date.UTC(2026, 8, 16, 4, 0, 0) / 1000);
  const log = await refusalLog(429, {
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-5h-status": "allowed",
    "anthropic-ratelimit-unified-5h-utilization": "0.35",
    "anthropic-ratelimit-unified-5h-reset": String(reset),
    "anthropic-ratelimit-unified-overage-status": "rejected",
    "anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits",
  }, "Australia/Sydney");
  const said = log.find((l) => l.startsWith(REFUSAL_MARK));
  assert.ok(said, `a refusal line, got ${JSON.stringify(log)}`);
  assert.match(said!, /refused this burst — the 5-hour window is 35% used but overage is off \(out of credits\); it resets at 14:00 Sydney/);
  // No clause about a second supply: the proxy sees a response, not a flow.
  assert.doesNotMatch(said!, /second supply/);
  // And the call itself is still in the log, as it always was.
  assert.ok(log.some((l) => /→ 429 \(\d+ms\) \[FOLDRUN_MODEL_KEY\]/.test(l)));
});

test("a 401 with no rate-limit headers is named as the credential, not a spent window", async () => {
  const log = await refusalLog(401, { "x-request-id": "req_123" });
  const said = log.find((l) => l.startsWith(REFUSAL_MARK));
  assert.ok(said, `a refusal line, got ${JSON.stringify(log)}`);
  assert.match(said!, /the credential at 127\.0\.0\.1:\d+ was refused \(HTTP 401\) and the response carried no rate-limit headers, so this is the key itself/);
  assert.doesNotMatch(said!, /second supply/);
});

test("a refusal with no fallback configured still says so and fails cleanly", async () => {
  // The owner has dropped the OpenRouter fallback: a refusal with nowhere
  // else to go must still leave the sentence, not a silent end. The proxy
  // appends regardless of whether any second supply exists — it knows
  // nothing about one — and the runner adds that clause when it finalises.
  const log = await refusalLog(402, {});
  assert.ok(log.some((l) => l.startsWith(REFUSAL_MARK) && /out of credit \(HTTP 402\)/.test(l)), JSON.stringify(log));
});

test("a normal response says nothing, and no header outside core's allow-list ever reaches the store", async () => {
  const ok = await refusalLog(201, { "anthropic-ratelimit-unified-5h-utilization": "0.9" });
  assert.equal(ok.filter((l) => l.startsWith(REFUSAL_MARK)).length, 0, "a 2xx is not a refusal, whatever it carries");

  // Everything the provider could put beside the allow-listed headers: a
  // credential, an id, a cookie. None of it may appear in any line.
  const noisy = await refusalLog(429, {
    "anthropic-ratelimit-unified-5h-status": "rejected",
    "anthropic-ratelimit-unified-5h-utilization": "1",
    authorization: "Bearer sk-ant-real-value",
    "x-api-key": "sk-ant-real-value",
    "set-cookie": "session=deadbeef",
    "x-request-id": "req_secret_123",
    "anthropic-organization-id": "org_abc",
  });
  const joined = noisy.join("\n");
  for (const leak of ["sk-ant-real-value", "deadbeef", "req_secret_123", "org_abc", "Bearer"]) {
    assert.ok(!joined.includes(leak), `${leak} must not reach the trace — ${joined}`);
  }
  assert.ok(noisy.some((l) => l.startsWith(REFUSAL_MARK) && /the 5-hour window is 100% used/.test(l)), joined);
});

// A throwaway upstream and a lease granted to it, for the transport tests.
async function throughProxy(handler: http.RequestListener) {
  const up = http.createServer(handler).listen(0, "127.0.0.1");
  await new Promise((r) => up.once("listening", r));
  const host = `127.0.0.1:${(up.address() as { port: number }).port}`;
  const proxy = await startEgressProxy(0);
  const prevUrl = process.env.FOLDRUN_EGRESS_URL;
  process.env.FOLDRUN_EGRESS_URL = `http://127.0.0.1:${proxy.port}`;
  const grant = { secrets: { K: { value: "v", hosts: [host] } } } as EgressGrant;
  const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-transport", grant }))!;
  return {
    base: `${lease.url}/http://${host}`,
    done: async () => {
      await lease.release();
      if (prevUrl === undefined) delete process.env.FOLDRUN_EGRESS_URL;
      else process.env.FOLDRUN_EGRESS_URL = prevUrl;
      await stopEgressProxy();
      up.closeAllConnections();
      up.close();
    },
  };
}

test("every Set-Cookie the upstream sends reaches the pod as its own header", async () => {
  const t = await throughProxy((_q, r) => {
    r.setHeader("set-cookie", ["a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/", "b=2; HttpOnly"]);
    r.end("ok");
  });
  try {
    const res = await fetch(`${t.base}/login`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.headers.getSetCookie(), ["a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/", "b=2; HttpOnly"]);
  } finally {
    await t.done();
  }
});

test("a pod that hangs up ends the upstream transfer; an upstream that goes quiet is cut off", async () => {
  let upstreamClosed!: () => void;
  const closed = new Promise<void>((r) => (upstreamClosed = r));
  const t = await throughProxy((q, r) => {
    r.writeHead(200, { "content-type": "text/event-stream" });
    r.write("data: first\n\n");
    q.socket.on("close", () => upstreamClosed()); // never ends on its own
  });
  try {
    const ctrl = new AbortController();
    const res = await fetch(`${t.base}/stream`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    await reader.read();
    ctrl.abort();
    await closed; // resolves only once the proxy dropped its upstream socket
  } finally {
    await t.done();
  }

  process.env.FOLDRUN_EGRESS_UPSTREAM_IDLE_MS = "150";
  const q = await throughProxy(() => {}); // accepts, never answers
  try {
    const res = await fetch(`${q.base}/slow`);
    assert.equal(res.status, 502);
    assert.match(await res.text(), /no reply from 127\.0\.0\.1:\d+ for 0s/);
  } finally {
    delete process.env.FOLDRUN_EGRESS_UPSTREAM_IDLE_MS;
    await q.done();
  }
});
