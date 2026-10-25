// sandbox: own sub-agents, end to end over the real egress proxy: core's
// httpChannel (what the parent's pod runs) posts a job through the delegate
// door, the worker's serveDelegations runs it, and the long-poll answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { egressHooks, parseOperatorPath, serveDelegations, startEgressProxy, stopEgressProxy } from "../src/egress-proxy.ts";
import { getDelegation, postDelegation, resetOperatorMemory, settleDelegation } from "../src/operator-store.ts";
import { httpChannel } from "../../foldrun-core/src/operator.ts";

const T = "t".repeat(24);

async function withProxy<R>(fn: () => Promise<R>): Promise<R> {
  resetOperatorMemory();
  const proxy = await startEgressProxy(0);
  const prev = { url: process.env.FOLDRUN_EGRESS_URL, poll: process.env.FOLDRUN_DELEGATE_POLL_MS };
  process.env.FOLDRUN_EGRESS_URL = `http://127.0.0.1:${proxy.port}`;
  try {
    return await fn();
  } finally {
    if (prev.url === undefined) delete process.env.FOLDRUN_EGRESS_URL;
    else process.env.FOLDRUN_EGRESS_URL = prev.url;
    await stopEgressProxy();
  }
}

test("the delegate paths carry the lease, and a job id", () => {
  assert.deepEqual(parseOperatorPath(`/delegate/${T}`), { kind: "delegate", token: T });
  assert.deepEqual(parseOperatorPath(`/delegate/${T}/d_abc?wait=5000`), { kind: "delegation", token: T, id: "d_abc", wait: 5000 });
  assert.equal(parseOperatorPath("/delegate/short"), null);
});

test("a job posted by the pod is run by the worker serving that step, and the reply comes back", async () => {
  await withProxy(async () => {
    const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-d", grant: { secrets: {} }, step: 0, delegates: ["reader"] }))!;
    const ran: string[] = [];
    const serving = serveDelegations({ tenant: "acme", runId: "run-d", step: 0 }, async (j) => {
      ran.push(`${j.agent}:${j.job}`);
      await new Promise((r) => setTimeout(r, 200));
      return { status: "completed", result: "summary", wrote: ["storage/n.md"], files: [{ path: "storage/n.md", base64: Buffer.from("notes").toString("base64") }] };
    });
    const ch = httpChannel(lease.url)!;
    const { id } = await ch.delegate!("reader", "read three pages");
    assert.equal(await ch.delegation!(id, 0), null, "still running");
    // Its files come back with the reply, for the parent's sandbox (23 Oct 2026).
    assert.deepEqual(await ch.delegation!(id, 10_000), {
      status: "completed",
      result: "summary",
      wrote: ["storage/n.md"],
      files: [{ path: "storage/n.md", base64: Buffer.from("notes").toString("base64") }],
      filesOmitted: [],
    });
    assert.deepEqual(ran, ["reader:read three pages"]);
    await serving.close();
    await lease.release();
  });
});

test("the door takes only names the lease grants, and only this step's jobs", async () => {
  await withProxy(async () => {
    const mine = (await egressHooks.lease({ tenant: "acme", runId: "run-e", grant: { secrets: {} }, step: 0, delegates: ["reader"] }))!;
    const none = (await egressHooks.lease({ tenant: "acme", runId: "run-e", grant: { secrets: {} }, step: 1 }))!;
    const sibling = (await egressHooks.lease({ tenant: "acme", runId: "run-e", grant: { secrets: {} }, step: 2, delegates: ["reader"] }))!;
    await assert.rejects(httpChannel(mine.url)!.delegate!("writer", "x"), /not a sub-agent this step may hand a job to/);
    await assert.rejects(httpChannel(none.url)!.delegate!("reader", "x"), /no sub-agents of its own sandbox/);
    const { id } = await httpChannel(mine.url)!.delegate!("reader", "x");
    await assert.rejects(httpChannel(sibling.url)!.delegation!(id, 0), /no such job on this step/, "a sibling cannot read another step's job");
    for (const l of [mine, none, sibling]) await l.release();
  });
});

test("close: queued jobs are skipped, running ones are told and waited for", async () => {
  await withProxy(async () => {
    let release!: () => void;
    let sawStop = false;
    const serving = serveDelegations({ tenant: "acme", runId: "run-f", step: 0 }, async (j) => {
      await new Promise<void>((r) => (release = r));
      sawStop = j.cancelled!();
      return { status: "completed", result: "late" };
    });
    const a = await postDelegation("acme", "run-f", { step: 0, agent: "reader", job: "first" });
    // Let the loop claim the first, then queue a second behind it.
    for (let i = 0; i < 30 && (await getDelegation("acme", "run-f", a.id))?.status === "queued"; i++) await new Promise((r) => setTimeout(r, 100));
    const closing = serving.close();
    const b = await postDelegation("acme", "run-f", { step: 0, agent: "reader", job: "second" });
    setTimeout(() => release(), 200);
    await closing;
    assert.equal(sawStop, true, "the running job heard that nobody waits for it");
    assert.equal((await getDelegation("acme", "run-f", a.id))?.status, "completed", "and it was waited for");
    const second = await getDelegation("acme", "run-f", b.id);
    assert.ok(second?.status === "queued" || second?.status === "skipped", "a job posted after close never runs");
  });
});

test("DELETE cancels a job that has not started", async () => {
  await withProxy(async () => {
    const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-g", grant: { secrets: {} }, step: 0, delegates: ["reader"] }))!;
    const ch = httpChannel(lease.url)!;
    const { id } = await ch.delegate!("reader", "x");
    await ch.cancelDelegation!(id);
    const ran: string[] = [];
    const serving = serveDelegations({ tenant: "acme", runId: "run-g", step: 0 }, async (j) => (ran.push(j.id), { status: "completed", result: "" }));
    const got = await ch.delegation!(id, 5_000);
    assert.equal(got?.status, "skipped");
    await serving.close();
    assert.deepEqual(ran, []);
    await lease.release();
  });
});

test("Redis: a job popped by a claim the cache cut short is claimed again, not lost", { skip: !process.env.FOLDRUN_REDIS_URL && "needs FOLDRUN_REDIS_URL" }, async () => {
  const { cache } = await import("../src/cache.ts");
  const { claimDelegation } = await import("../src/operator-store.ts");
  const d = await postDelegation("acme", "run-h", { step: 0, agent: "reader", job: "x" });
  // What a claim leaves when the cache fails after its LMOVE: the id on the
  // claiming list, the record still queued.
  await cache()!.lmove("op:dgq:acme:run-h:s0", "op:dgp:acme:run-h:s0", "LEFT", "RIGHT");
  const again = await claimDelegation("acme", "run-h", 0);
  assert.equal(again?.id, d.id);
  assert.equal((await getDelegation("acme", "run-h", d.id))?.status, "running");
  assert.equal(await cache()!.llen("op:dgp:acme:run-h:s0"), 0, "and it leaves the claiming list");
  assert.equal(await claimDelegation("acme", "run-h", 0), null);
});

test("a worker taking a step over settles the jobs the last one started as failed", async () => {
  await withProxy(async () => {
    const { claimDelegation } = await import("../src/operator-store.ts");
    const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-i", grant: { secrets: {} }, step: 0, delegates: ["reader"] }))!;
    const ch = httpChannel(lease.url)!;
    const { id } = await ch.delegate!("reader", "x");
    // The old worker claimed it, then died: no settle ever came.
    assert.equal((await claimDelegation("acme", "run-i", 0))?.id, id);
    const serving = serveDelegations({ tenant: "acme", runId: "run-i", step: 0 }, async () => ({ status: "completed", result: "never" }));
    const got = await ch.delegation!(id, 5_000);
    assert.equal(got?.status, "failed");
    assert.match(got!.result, /restarted/);
    await serving.close();
    await lease.release();
  });
});

test("Redis: a claim whose running write landed but whose answer was lost is started, once", { skip: !process.env.FOLDRUN_REDIS_URL && "needs FOLDRUN_REDIS_URL" }, async () => {
  const { cache } = await import("../src/cache.ts");
  const { claimDelegation } = await import("../src/operator-store.ts");
  const d = await postDelegation("acme", "run-j", { step: 0, agent: "reader", job: "x" });
  // The write marking it running landed; the answer did not — so the id is
  // still on the claiming list and no worker started it.
  assert.equal((await claimDelegation("acme", "run-j", 0))?.id, d.id);
  await cache()!.rpush("op:dgp:acme:run-j:s0", d.id);
  assert.equal(await claimDelegation("acme", "run-j", 0, () => true), null, "a job this worker did start is not started twice");
  await cache()!.rpush("op:dgp:acme:run-j:s0", d.id);
  assert.equal((await claimDelegation("acme", "run-j", 0, () => false))?.id, d.id, "one it did not start is");
  assert.equal(await cache()!.llen("op:dgp:acme:run-j:s0"), 0);
});

test("takeover: a job settled before its worker died keeps its result; stale queued jobs are skipped", async () => {
  await withProxy(async () => {
    const { claimDelegation, settleDelegation, runningDelegations } = await import("../src/operator-store.ts");
    const done = await postDelegation("acme", "run-k", { step: 0, agent: "reader", job: "done one" });
    await claimDelegation("acme", "run-k", 0);
    await settleDelegation("acme", "run-k", done.id, { status: "completed", result: "the answer" });
    // The settle wrote the record but died before leaving the running set
    // (Redis only: the memory store has no half-done write to stage).
    const { cache } = await import("../src/cache.ts");
    if (cache()) await cache()!.sadd("op:dgr:acme:run-k:s0", done.id);
    const stale = await postDelegation("acme", "run-k", { step: 0, agent: "reader", job: "from the last attempt" });
    await new Promise((r) => setTimeout(r, 5)); // posted strictly before serving starts
    const ran: string[] = [];
    const serving = serveDelegations({ tenant: "acme", runId: "run-k", step: 0 }, async (j) => (ran.push(j.id), { status: "completed", result: "" }));
    for (let i = 0; i < 30 && (await getDelegation("acme", "run-k", stale.id))?.status === "queued"; i++) await new Promise((r) => setTimeout(r, 100));
    await serving.close();
    assert.equal((await getDelegation("acme", "run-k", done.id))?.result, "the answer", "not overwritten with a failure");
    assert.equal((await getDelegation("acme", "run-k", stale.id))?.status, "skipped");
    assert.deepEqual(ran, [], "the earlier attempt's job never ran");
    assert.deepEqual(await runningDelegations("acme", "run-k", 0), []);
  });
});

test("a step re-attaching to its surviving pod keeps what it queued before the restart", async () => {
  await withProxy(async () => {
    const queued = await postDelegation("acme", "run-l", { step: 0, agent: "reader", job: "still wanted" });
    await new Promise((r) => setTimeout(r, 5));
    const ran: string[] = [];
    const serving = serveDelegations({ tenant: "acme", runId: "run-l", step: 0, resuming: true }, async (j) => (ran.push(j.id), { status: "completed", result: "here" }));
    for (let i = 0; i < 40 && (await getDelegation("acme", "run-l", queued.id))?.status !== "completed"; i++) await new Promise((r) => setTimeout(r, 100));
    await serving.close();
    assert.deepEqual(ran, [queued.id]);
    assert.equal((await getDelegation("acme", "run-l", queued.id))?.result, "here");
  });
});

test("a settled job keeps its files only up to the copy-back cap; the rest are named as omitted", async () => {
  resetOperatorMemory();
  const d = await postDelegation("acme", "run-cap", { step: 0, agent: "reader", job: "x" });
  const big = Buffer.alloc(4 * 1024 * 1024 - 1).toString("base64"); // a byte under the cap, decoded
  await settleDelegation("acme", "run-cap", d.id, {
    status: "completed",
    result: "ok",
    wrote: ["storage/a", "storage/b"],
    // Three files that fit decoded, though their padded base64 is longer than
    // 4 MiB's: all but the one that would pass the cap are kept.
    files: [{ path: "storage/a", base64: big }, { path: "storage/one", base64: "QQ==" }, { path: "storage/b", base64: "QUE=" }],
    filesOmitted: ["storage/huge"],
  });
  const rec = (await getDelegation("acme", "run-cap", d.id))!;
  assert.deepEqual(rec.files!.map((f) => f.path), ["storage/a", "storage/one"]);
  assert.deepEqual(rec.filesOmitted, ["storage/huge", "storage/b"]);
});
