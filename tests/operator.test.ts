// A person in the loop, end to end over the real egress proxy: core's
// httpChannel (what the pod runs) against the proxy's /ask and /inbox, with
// the web side's store calls standing in for the person.
import { test } from "node:test";
import assert from "node:assert/strict";
import { egressHooks, parseOperatorPath, startEgressProxy, stopEgressProxy } from "../src/egress-proxy.ts";
import { answerQuestion, getQuestion, openQuestions, postMessage, pendingMessages, resetOperatorMemory } from "../src/operator-store.ts";
import { httpChannel } from "../../foldrun-core/src/operator.ts";

const T = "t".repeat(24);

test("the operator paths carry the lease, and a question id", () => {
  assert.deepEqual(parseOperatorPath(`/ask/${T}`), { kind: "ask", token: T });
  assert.deepEqual(parseOperatorPath(`/ask/${T}/q_abc?wait=5000`), { kind: "answer", token: T, id: "q_abc", wait: 5000 });
  assert.deepEqual(parseOperatorPath(`/inbox/${T}`), { kind: "inbox", token: T });
  assert.deepEqual(parseOperatorPath(`/peers/${T}`), { kind: "peers", token: T });
  assert.deepEqual(parseOperatorPath(`/peers/${T}/message`), { kind: "tell", token: T });
  assert.equal(parseOperatorPath("/ask/short"), null);
  assert.equal(parseOperatorPath(`/e/${T}/https://x.com`), null);
});

async function withProxy<R>(fn: (url: string) => Promise<R>): Promise<R> {
  resetOperatorMemory();
  const proxy = await startEgressProxy(0);
  const prev = process.env.FOLDRUN_EGRESS_URL;
  process.env.FOLDRUN_EGRESS_URL = `http://127.0.0.1:${proxy.port}`;
  try {
    return await fn(process.env.FOLDRUN_EGRESS_URL);
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_EGRESS_URL;
    else process.env.FOLDRUN_EGRESS_URL = prev;
    await stopEgressProxy();
  }
}

test("ask, then a person answers while the step is long-polling: the answer comes back", async () => {
  await withProxy(async () => {
    const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-ask", grant: { secrets: {} } }))!;
    const ch = httpChannel(lease.url)!;
    const { id } = await ch.ask("Publish at 9 or 10?", ["9", "10"]);
    const open = await openQuestions("acme");
    assert.equal(open.length, 1);
    assert.deepEqual(open[0].options, ["9", "10"]);
    assert.equal(open[0].runId, "run-ask");
    // Nothing yet: a short poll comes back empty.
    assert.equal(await ch.poll(id, 200), null);
    // The person answers a moment into a long poll.
    const waiting = ch.poll(id, 10_000);
    setTimeout(() => void answerQuestion("acme", "run-ask", id, "10", "dev@example.com"), 300);
    assert.deepEqual(await waiting, { answer: "10", by: "dev@example.com" });
    assert.deepEqual(await openQuestions("acme"), [], "answered is no longer open");
    // A second answer does not replace the first.
    const again = await answerQuestion("acme", "run-ask", id, "9", "someone@else");
    assert.equal(again?.already, true);
    assert.equal(again?.question.answer, "10");
    await lease.release();
  });
});

test("a message sent in reaches its own run's step once; other runs never see it", async () => {
  await withProxy(async () => {
    const mine = (await egressHooks.lease({ tenant: "acme", runId: "run-a", grant: { secrets: {} } }))!;
    const other = (await egressHooks.lease({ tenant: "acme", runId: "run-b", grant: { secrets: {} } }))!;
    await postMessage("acme", "run-a", "use the 2025 figures", "dev@example.com");
    assert.equal((await pendingMessages("acme", "run-a")).length, 1);
    assert.deepEqual(await httpChannel(other.url)!.inbox(), [], "run-b reads nothing of run-a's");
    const got = await httpChannel(mine.url)!.inbox();
    assert.equal(got.length, 1);
    assert.equal(got[0].text, "use the 2025 figures");
    assert.equal(got[0].by, "dev@example.com");
    assert.deepEqual(await httpChannel(mine.url)!.inbox(), [], "read once");
    await mine.release();
    await other.release();
  });
});

test("a lease reaches only its own run's questions; a dead or wrong lease is refused", async () => {
  await withProxy(async (base) => {
    const a = (await egressHooks.lease({ tenant: "acme", runId: "run-a", grant: { secrets: {} } }))!;
    const b = (await egressHooks.lease({ tenant: "acme", runId: "run-b", grant: { secrets: {} } }))!;
    const { id } = await httpChannel(a.url)!.ask("Which one?");
    await assert.rejects(httpChannel(b.url)!.poll(id, 100), /no such question/, "run-b cannot wait on run-a's question");
    const bogus = `${base}/e/${"z".repeat(24)}`;
    await assert.rejects(httpChannel(bogus)!.ask("hello"), /no such lease/);
    await assert.rejects(httpChannel(bogus)!.inbox(), /no such lease/);
    const tokenA = a.url.split("/e/")[1];
    assert.equal((await fetch(`${base}/ask/${tokenA}`)).status, 405, "GET on the ask path is refused");
    const empty = await fetch(`${base}/ask/${tokenA}`, { method: "POST", body: "{}" });
    assert.equal(empty.status, 400);
    await a.release();
    await b.release();
    await assert.rejects(httpChannel(a.url)!.inbox(), /no such lease/, "a released lease is over");
  });
});

test("parallel steps of one run each read only their own inbox; a run-level message still reaches one", async () => {
  await withProxy(async () => {
    const s0 = (await egressHooks.lease({ tenant: "acme", runId: "run-p", grant: { secrets: {} }, step: 0 } as never))!;
    const s1 = (await egressHooks.lease({ tenant: "acme", runId: "run-p", grant: { secrets: {} }, step: 1 } as never))!;
    await postMessage("acme", "run-p", "for the second step", "dev@example.com", 1);
    assert.equal((await pendingMessages("acme", "run-p", 1)).length, 1);
    assert.deepEqual(await httpChannel(s0.url)!.inbox(), [], "step 0 does not steal step 1's message");
    const got = await httpChannel(s1.url)!.inbox();
    assert.deepEqual(got.map((m) => m.text), ["for the second step"]);
    // The run-level inbox (no step) is still read — by whichever step reads first.
    await postMessage("acme", "run-p", "anyone", null);
    const either = [...(await httpChannel(s0.url)!.inbox()), ...(await httpChannel(s1.url)!.inbox())];
    assert.deepEqual(either.map((m) => m.text), ["anyone"]);
    await s0.release();
    await s1.release();
  });
});

test("a question carries its step; DELETE closes it: no longer open, and an answer is refused", async () => {
  await withProxy(async (base) => {
    const lease = (await egressHooks.lease({ tenant: "acme", runId: "run-c", grant: { secrets: {} }, step: 2 } as never))!;
    const ch = httpChannel(lease.url)!;
    const { id } = await ch.ask("Still there?");
    assert.equal((await getQuestion("acme", "run-c", id))?.step, 2);
    const openHere = async () => (await openQuestions("acme")).filter((q) => q.runId === "run-c");
    assert.equal((await openHere()).length, 1);
    await ch.close!(id);
    assert.deepEqual(await openHere(), [], "closed is no longer open");
    assert.equal((await getQuestion("acme", "run-c", id))?.closed, true);
    const late = await answerQuestion("acme", "run-c", id, "yes", "dev@example.com");
    assert.equal(late?.closed, true, "a closed question takes no answer");
    assert.equal((await getQuestion("acme", "run-c", id))?.answer, undefined);
    // Another run's lease cannot close it.
    const other = (await egressHooks.lease({ tenant: "acme", runId: "run-x", grant: { secrets: {} } }))!;
    const tokenX = other.url.split("/e/")[1];
    assert.equal((await fetch(`${base}/ask/${tokenX}/${id}`, { method: "DELETE" })).status, 404);
    await lease.release();
    await other.release();
  });
});

test("tools: [peers] — a step reads its roster from the lease and messages a sibling's inbox, never a stranger's", async () => {
  await withProxy(async () => {
    const peers = [
      { agent: "writer", step: 1, instruction: "write the copy" },
      { agent: "image-maker", step: 2, instruction: "make the card" },
    ];
    const planner = (await egressHooks.lease({ tenant: "acme", runId: "run-g", grant: { secrets: {} }, step: 0, agent: "planner", peers }))!;
    const writer = (await egressHooks.lease({ tenant: "acme", runId: "run-g", grant: { secrets: {} }, step: 1, agent: "writer", peers: [{ agent: "planner", step: 0, instruction: "plan" }] }))!;
    const image = (await egressHooks.lease({ tenant: "acme", runId: "run-g", grant: { secrets: {} }, step: 2 }))!;
    const plain = (await egressHooks.lease({ tenant: "acme", runId: "run-g", grant: { secrets: {} }, step: 3 }))!;
    const ch = httpChannel(planner.url)!;
    assert.deepEqual(await ch.peers!(), peers, "the roster is what the runner put on the lease");
    assert.deepEqual(await ch.tell!("writer", "the date is 2026-10-20"), { to: ["writer#2"] });
    assert.deepEqual(await httpChannel(image.url)!.inbox(), [], "image-maker was not addressed");
    const got = await httpChannel(writer.url)!.inbox();
    assert.equal(got.length, 1);
    assert.equal(got[0].text, "the date is 2026-10-20");
    assert.equal(got[0].by, "peer:planner#1", "signed as a colleague, with its address");
    assert.deepEqual(await ch.tell!("all", "plan changed"), { to: ["writer#2", "image-maker#3"] });
    assert.equal((await httpChannel(image.url)!.inbox()).length, 1);
    assert.deepEqual(await ch.tell!("image-maker#3", "by address"), { to: ["image-maker#3"] });
    assert.equal((await httpChannel(image.url)!.inbox()).length, 1);
    // image-maker's lease goes between attempts: it is not over, so it stays.
    await image.release();
    assert.deepEqual(await ch.peers!(), peers, "a sibling between retries holds no lease and is still reachable");
    assert.deepEqual(await ch.tell!("image-maker", "queued for the retry"), { to: ["image-maker#3"] });
    // The runner says the step is over: off the roster, unreachable.
    await egressHooks.stepEnded!({ tenant: "acme", runId: "run-g", step: 2 });
    assert.deepEqual(await ch.peers!(), [peers[0]], "a finished sibling is off the roster");
    assert.deepEqual(await ch.tell!("image-maker", "too late"), { to: [] });
    await assert.rejects(ch.tell!("editor", "x"), /no colleague named "editor"/);
    await assert.rejects(httpChannel(plain.url)!.tell!("writer", "x"), /not granted tools: \[peers\]/, "a lease without the grant has no line to colleagues");
    assert.deepEqual(await httpChannel(plain.url)!.peers!(), []);
    for (const l of [planner, writer, plain]) await l.release();
  });
});
