// The live view: a step's browser posts frames to /live/<lease> on the
// egress proxy; the run page reads the newest one. The lease is the only
// credential, so a frame lands on its own run and nowhere else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { egressHooks, startEgressProxy, stopEgressProxy } from "../src/egress-proxy.ts";
import { getLiveFrame, liveAgents, liveMeta, parseLivePath } from "../src/live-view.ts";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

// A lease-shaped placeholder: long enough to parse, and plainly not a key
// (gitleaks reads a random-looking one as a leaked credential).
const LEASE = "x".repeat(24);

test("the live path carries the lease and nothing else", () => {
  assert.deepEqual(parseLivePath(`/live/${LEASE}`), { token: LEASE });
  assert.equal(parseLivePath("/live/short"), null);
  assert.equal(parseLivePath(`/e/${LEASE}/https://x.com`), null);
});

test("end to end: a step's frame lands on its own run; junk and dead leases are refused", async () => {
  const proxy = await startEgressProxy(0);
  const prevUrl = process.env.FOLDRUN_EGRESS_URL;
  process.env.FOLDRUN_EGRESS_URL = `http://127.0.0.1:${proxy.port}`;
  try {
    const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-live", grant: { secrets: {} } }))!;
    const liveUrl = lease.url.replace("/e/", "/live/");
    const post = (body: Buffer | string, headers: Record<string, string> = {}) =>
      fetch(liveUrl, { method: "POST", body, headers: { "content-type": "image/jpeg", "x-foldrun-agent": "reader", ...headers } });

    assert.equal((await post(JPEG, { "x-foldrun-page": encodeURIComponent("https://example.com/ä"), "x-foldrun-engine": "chromium" })).status, 204);
    const got = await getLiveFrame("acme", "run-live", "reader");
    assert.ok(got);
    assert.deepEqual(got!.jpeg, JPEG);
    assert.equal(got!.meta.url, "https://example.com/ä");
    assert.equal(got!.meta.ended, false);
    assert.deepEqual(Object.keys(await liveAgents("acme", "run-live")), ["reader"]);
    assert.equal(await getLiveFrame("other", "run-live", "reader"), null, "another account's run sees nothing");

    assert.equal((await post("not a jpeg")).status, 415);
    assert.equal((await fetch(liveUrl)).status, 405);
    assert.equal((await post(Buffer.alloc(0), { "x-foldrun-live": "end" })).status, 204);
    assert.equal((await liveMeta("acme", "run-live", "reader"))!.ended, true);
    assert.ok(await getLiveFrame("acme", "run-live", "reader"), "the last frame stays to show");

    await lease.release();
    assert.equal((await post(JPEG)).status, 401, "a finished step cannot paint");
  } finally {
    if (prevUrl === undefined) delete process.env.FOLDRUN_EGRESS_URL;
    else process.env.FOLDRUN_EGRESS_URL = prevUrl;
    await stopEgressProxy();
  }
});
