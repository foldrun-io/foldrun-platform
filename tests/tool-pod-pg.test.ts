// Tools on demand on Postgres (14 Nov 2026, tool-pod.ts): an extraction in
// flight is what makes an account's parser pod — the `running` row with a
// live lease — and taking the slot notifies the worker on commit. Skipped
// without a database.
//
//   FOLDRUN_TEST_DATABASE_URL=postgres://foldrun:test@localhost:55432/foldrun \
//     node --test tests/tool-pod-pg.test.ts

import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { takeTurnsOnLiveDb } from "./live-db-lock.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
const opts = { skip: url ? false : "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" };
takeTurnsOnLiveDb(url);

if (url) {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  process.env.FOLDRUN_SECRET_KEY ??= "test-install-key";
  process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-toolpod-pg-"));
  delete process.env.FOLDRUN_EXTRACT_URL;
  Object.assign(process.env, {
    FOLDRUN_EXTRACT_RATE_PER_MIN: "1000",
    FOLDRUN_TOOLS_ON_DEMAND: "1",
    FOLDRUN_RUN_ISOLATION: "k8s",
    FOLDRUN_RUNNER_RUNTIME: "gvisor",
    FOLDRUN_EXTRACT_IMAGE: "ecr.example/ghcr/foldrun-io/extract@sha256:abc",
  });
}

const T = `tpg${Date.now().toString(36)}`;

before(async () => {
  if (!url) return;
  const { migrate } = await import("../src/db.ts");
  await migrate();
});

test("a slot in use is a live extraction; it notifies on commit; finished or past its lease it is not", opts, async () => {
  const x = await import("../src/extract.ts");
  const tp = await import("../src/tool-pod.ts");
  const { listen, stopListening } = await import("../src/pg-listen.ts");
  const { orm } = await import("../src/db.ts");
  const { sql } = await import("drizzle-orm");

  const heard: string[] = [];
  let up!: () => void;
  const ready = new Promise<void>((r) => (up = r));
  const stop = listen(tp.TOOL_CHANNEL, (p) => heard.push(p), { up: () => up() });
  await ready;
  try {
    let during: Set<string> | null = null;
    await x.withExtractSlot(T, "test", async () => {
      during = await tp.accountsWithLiveExtractions();
      // the notification arrives on commit, before fn ran
      for (let i = 0; i < 50 && !heard.includes(T); i++) await new Promise((r) => setTimeout(r, 20));
    });
    assert.ok(during!.has(T), "while the slot is held the account is wanted");
    assert.ok(heard.includes(T), "taking the slot told the worker");
    assert.equal((await tp.accountsWithLiveExtractions())!.has(T), false, "finished: not wanted any more");

    // A running row whose lease ran out (its process died) is not wanted either.
    await orm()!.execute(sql`INSERT INTO extract_jobs (id, tenant, actor, status, options, lease_until) VALUES (${`xj-${Date.now().toString(36)}deadbeefcafe0000`}, ${T}, 'test', 'running', '{}'::jsonb, now() - interval '1 minute')`);
    assert.equal((await tp.accountsWithLiveExtractions())!.has(T), false);
  } finally {
    stop();
    await stopListening();
    await orm()!.execute(sql`DELETE FROM extract_jobs WHERE tenant = ${T}`);
  }
});

test("the reaper checks the account's leases again under the slot's lock before it deletes", opts, async () => {
  const tp = await import("../src/tool-pod.ts");
  const { orm } = await import("../src/db.ts");
  const { sql } = await import("drizzle-orm");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-toolpod-kc-"));
  const log = path.join(dir, "calls.log");
  const bin = path.join(dir, "kubectl");
  fs.writeFileSync(bin, `#!/bin/sh\necho "$*" >> "${log}"\ncat > /dev/null\nexit 0\n`, { mode: 0o755 });
  const prev = process.env.FOLDRUN_KUBECTL;
  process.env.FOLDRUN_KUBECTL = bin;
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
  const pod = { name: `foldrun-extract-${T}`, seg: T, createdAt: "2026-11-14T08:00:00Z", lastUsed: "2026-11-14T08:00:00Z" };
  try {
    // An extraction admitted after the pass's first look: still running here.
    await orm()!.execute(sql`INSERT INTO extract_jobs (id, tenant, actor, status, options, lease_until) VALUES (${`xj-${Date.now().toString(36)}live00000000000`}, ${T}, 'test', 'running', '{}'::jsonb, now() + interval '2 minutes')`);
    assert.equal(await tp.reapIfStillIdle(pod, T), false, "kept: its account has an extraction in flight");
    assert.equal(calls().filter((c) => c.startsWith("delete")).length, 0);
    await orm()!.execute(sql`UPDATE extract_jobs SET status = 'done', finished_at = now() WHERE tenant = ${T}`);
    assert.equal(await tp.reapIfStillIdle(pod, T), true, "nothing in flight: gone");
    assert.ok(calls().some((c) => c.startsWith(`delete pod foldrun-extract-${T}`)));
    assert.ok(calls().some((c) => c.startsWith(`delete service,networkpolicy foldrun-extract-${T}`)));
  } finally {
    prev === undefined ? delete process.env.FOLDRUN_KUBECTL : (process.env.FOLDRUN_KUBECTL = prev);
    await orm()!.execute(sql`DELETE FROM extract_jobs WHERE tenant = ${T}`);
  }
});

test("a Whisper lease: wanted while held, told at once, ended at release, and the reaper keeps its pod while held", opts, async () => {
  const tp = await import("../src/tool-pod.ts");
  const { orm } = await import("../src/db.ts");
  const { sql } = await import("drizzle-orm");
  const lease = await tp.holdToolLease(tp.STT_FA, T);
  try {
    const inUse = await tp.toolsInUse();
    assert.ok(inUse!.get("stt-fa")!.has(T));
    assert.equal(inUse!.get("stt-gen")!.has(T), false, "only the model asked for");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-toolpod-kc2-"));
    const bin = path.join(dir, "kubectl");
    fs.writeFileSync(bin, `#!/bin/sh\necho "$*" >> "${dir}/calls.log"\ncat > /dev/null\nexit 0\n`, { mode: 0o755 });
    const prev = process.env.FOLDRUN_KUBECTL;
    process.env.FOLDRUN_KUBECTL = bin;
    try {
      const pod = { name: `foldrun-stt-fa-${T}`, seg: T, createdAt: "2026-11-14T08:00:00Z", lastUsed: "2026-11-14T08:00:00Z", tool: "stt-fa" };
      assert.equal(await tp.reapIfStillIdle(pod, T), false, "held: kept");
      await lease.release();
      assert.equal((await tp.toolsInUse())!.get("stt-fa")!.has(T), false, "released: not wanted");
      const { rows } = await orm()!.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM tool_leases WHERE tenant = ${T}`);
      assert.equal(rows[0].n, 1, "kept, ended — so the reaper still knows whose pod it is");
      assert.equal(await tp.reapIfStillIdle(pod, T), true, "nothing held: gone");
      assert.ok(fs.readFileSync(`${dir}/calls.log`, "utf8").includes(`delete pod foldrun-stt-fa-${T}`));
    } finally {
      prev === undefined ? delete process.env.FOLDRUN_KUBECTL : (process.env.FOLDRUN_KUBECTL = prev);
    }
  } finally {
    await lease.release();
    await orm()!.execute(sql`DELETE FROM tool_leases WHERE tenant = ${T}`);
  }
});
