// Admission per customer at the door (FOL-477): permits per account and door,
// one install-wide cap, room that is never taken from answers and stops.
//
// Run with no Valkey, the cases run on one process's own count; given
// FOLDRUN_TEST_REDIS_URL they run against that Valkey, through the script every
// web pod shares (the cache client is one per process, so one mode per run):
//   FOLDRUN_TEST_REDIS_URL=redis://127.0.0.1:6379 node --test tests/admission.test.ts

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cache } from "../src/cache.ts";
import { admit, admitted, holding, reserved, resetLocalAdmission, Busy } from "../src/admission.ts";

const REDIS = process.env.FOLDRUN_TEST_REDIS_URL;
if (REDIS) process.env.FOLDRUN_REDIS_URL = REDIS;
else delete process.env.FOLDRUN_REDIS_URL;
const MODE = REDIS ? "in Valkey" : "in this process";

function limits(over: Record<string, string>) {
  const keys = ["FOLDRUN_ADMISSION", "FOLDRUN_ADMISSION_DEPLOY", "FOLDRUN_ADMISSION_RUN_START", "FOLDRUN_ADMISSION_UPLOAD", "FOLDRUN_ADMISSION_INSTALL_CAP", "FOLDRUN_ADMISSION_RETRY_AFTER", "FOLDRUN_ADMISSION_PERMIT_SECONDS"];
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, over);
  resetLocalAdmission();
}

// The cache client keeps its connection open; close it so the run ends.
after(() => {
  cache()?.disconnect();
});

const who = () => `acct-${Math.random().toString(36).slice(2)}`;

  test(`${MODE}: an account at its limit is told 429 with Retry-After, and nothing is taken`, async () => {
    limits({ FOLDRUN_ADMISSION_RUN_START: "2", FOLDRUN_ADMISSION_RETRY_AFTER: "7" });
    const a = who();
    const p1 = await admit("run_start", a);
    const p2 = await admit("run_start", a);
    await assert.rejects(admit("run_start", a), (e: Busy) => e instanceof Busy && e.status === 429 && e.code === "busy_account" && e.retryAfter === 7 && e.limit === 2);
    assert.equal(await holding("run_start", a), 2, "the refused one took no permit");
    await p1.release();
    const p3 = await admit("run_start", a);
    await p2.release();
    await p3.release();
    assert.equal(await holding("run_start", a), 0);
  });

  test(`${MODE}: one account's burst does not starve another`, async () => {
    limits({ FOLDRUN_ADMISSION_RUN_START: "2", FOLDRUN_ADMISSION_DEPLOY: "2" });
    const noisy = who();
    const quiet = who();
    const held = [await admit("run_start", noisy), await admit("run_start", noisy)];
    // Twenty more from the noisy account, all refused...
    const burst = await Promise.allSettled(Array.from({ length: 20 }, () => admit("run_start", noisy)));
    assert.equal(burst.filter((r) => r.status === "rejected").length, 20);
    // ...and the quiet account, same door and another door, still goes through.
    const q1 = await admit("run_start", quiet);
    const q2 = await admit("deploy", quiet);
    const n2 = await admit("deploy", noisy);
    for (const p of [...held, q1, q2, n2]) await p.release();
  });

  test(`${MODE}: the install's cap is a 503, shared by every door and account`, async () => {
    limits({ FOLDRUN_ADMISSION_INSTALL_CAP: "3", FOLDRUN_ADMISSION_RUN_START: "5", FOLDRUN_ADMISSION_DEPLOY: "5", FOLDRUN_ADMISSION_UPLOAD: "5" });
    const [a, b] = [who(), who()];
    const taken = [await admit("run_start", a), await admit("deploy", a), await admit("upload", b)];
    await assert.rejects(admit("deploy", b), (e: Busy) => e.status === 503 && e.code === "busy_install" && e.retryAfter >= 1);
    await taken[0].release();
    const again = await admit("deploy", b);
    for (const p of [...taken.slice(1), again]) await p.release();
  });

  test(`${MODE}: answers, approvals, stops and a worker's completion never wait behind a full house`, async () => {
    limits({ FOLDRUN_ADMISSION_INSTALL_CAP: "1", FOLDRUN_ADMISSION_RUN_START: "1" });
    const a = who();
    const full = await admit("run_start", a);
    await assert.rejects(admit("run_start", a), Busy);
    for (const kind of ["answer", "approve", "stop", "completion"] as const) assert.doesNotThrow(() => reserved(kind));
    assert.equal(await holding("run_start", a), 1, "reserved calls took no permit");
    await full.release();
  });

  test(`${MODE}: the permit goes back when the work throws, and twice is harmless`, async () => {
    limits({ FOLDRUN_ADMISSION_DEPLOY: "1" });
    const a = who();
    await assert.rejects(
      admitted("deploy", a, async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(await holding("deploy", a), 0);
    const p = await admit("deploy", a);
    await p.release();
    await p.release();
    const next = await admit("deploy", a);
    await assert.rejects(admit("deploy", a), Busy);
    await next.release();
  });

  test(`${MODE}: a permit never given back lapses at its expiry`, async () => {
    limits({ FOLDRUN_ADMISSION_UPLOAD: "1", FOLDRUN_ADMISSION_PERMIT_SECONDS: "5" });
    const a = who();
    // PERMIT_SECONDS has a floor of 5 in the settings; lower it through the
    // module's own clock instead of waiting the real seconds.
    const realNow = Date.now;
    await admit("upload", a);
    await assert.rejects(admit("upload", a), Busy);
    Date.now = () => realNow() + 6_000;
    try {
      const p = await admit("upload", a);
      await p.release();
    } finally {
      Date.now = realNow;
    }
  });

test(`${MODE}: fifty at the same moment against a limit of five admit exactly five`, async () => {
  limits({ FOLDRUN_ADMISSION_DEPLOY: "5" });
  const a = who();
  const results = await Promise.allSettled(Array.from({ length: 50 }, () => admit("deploy", a)));
  const got = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  assert.equal(got.length, 5);
  assert.equal(await holding("deploy", a), 5);
  for (const p of got) await p.release();
  assert.equal(await holding("deploy", a), 0);
});

test("a limit of 0 is no cap, and the switch off turns the door off", async () => {
  limits({ FOLDRUN_ADMISSION_DEPLOY: "0" });
  const a = who();
  const many = await Promise.all(Array.from({ length: 30 }, () => admit("deploy", a)));
  for (const p of many) await p.release();
  limits({ FOLDRUN_ADMISSION: "false", FOLDRUN_ADMISSION_RUN_START: "1" });
  const off = await Promise.all([admit("run_start", a), admit("run_start", a), admit("run_start", a)]);
  for (const p of off) await p.release();
});

test("the refusal reads as a sentence a person can act on, and carries the status the API answers with", () => {
  const acct = new Busy("run_start", "account", 2, 3);
  assert.equal(acct.status, 429);
  assert.match(acct.message, /2 starting runs in progress.*nothing was started.*3 s/);
  const inst = new Busy("upload", "install", 40, 5);
  assert.equal(inst.status, 503);
  assert.match(inst.message, /busy with uploads.*nothing was started/);
});
