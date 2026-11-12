// Files to text on Postgres (12 Nov 2026): extract_artifacts (one immutable
// row per account, hash and options; never another account's) and
// extract_jobs (the per-account cap counted under an advisory lock, a lease
// that runs out failed on read, the outcome written once). The file-store
// twin of each is in extract.test.ts. Skipped without a database.
//
//   FOLDRUN_TEST_DATABASE_URL=postgres://foldrun:test@localhost:55432/foldrun \
//     node --test tests/extract-db.test.ts

import { test, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
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
  process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-extract-db-"));
  process.env.FOLDRUN_EXTRACT_URL = "http://extract:8090";
  process.env.FOLDRUN_EXTRACT_RATE_PER_MIN = "1000";
}

const T = `xdb${Date.now().toString(36)}`;
const unique = (label: string) => Buffer.from(`${label}-${crypto.randomBytes(8).toString("hex")}`);
const image = (text: string) => ({ kind: "image", format: "png", text, engine: "tesseract:fas+eng", needs_speech: false, truncated: false, warnings: [] });

before(async () => {
  if (!url) return;
  const { migrate } = await import("../src/db.ts");
  await migrate();
});

test("Postgres artifacts: kept once per account, a hit is cached, another account's is not", opts, async () => {
  const x = await import("../src/extract.ts");
  const { orm } = await import("../src/db.ts");
  const { sql } = await import("drizzle-orm");
  let asked = 0;
  x.setExtractFetchForTests(async () => {
    asked++;
    return Response.json(image("سلام"), { headers: { server: "foldrun-extract/0.1.0" } });
  });
  try {
    const bytes = unique("db");
    assert.equal((await x.extractFile(T, bytes)).cached, false);
    const hit = await x.extractFile(T, bytes);
    assert.equal(hit.cached, true);
    assert.equal(hit.text, "سلام");
    assert.equal(asked, 1);
    assert.equal((await x.extractFile(`${T}b`, bytes)).cached, false, "never across accounts");
    assert.equal(asked, 2);
    const { rows } = await orm()!.execute<{ engine_spec: string; n: number }>(sql`SELECT engine_spec, count(*) OVER ()::int AS n FROM extract_artifacts WHERE tenant = ${T}`);
    assert.equal(rows[0]?.n, 1);
    assert.match(rows[0]!.engine_spec, /foldrun-extract\/0\.1\.0/, "pinned with the service that made it");
  } finally {
    x.setExtractFetchForTests(null);
  }
});

test("Postgres jobs: done and read back, the account cap, a lapsed lease failed on read, deleted with the account", opts, async () => {
  const x = await import("../src/extract.ts");
  const { orm } = await import("../src/db.ts");
  const { sql } = await import("drizzle-orm");
  process.env.FOLDRUN_EXTRACT_ACCOUNT_CAP = "1";
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  x.setExtractFetchForTests(async () => {
    await gate;
    return Response.json(image("done"));
  });
  try {
    const job = await x.startExtractJob({ tenant: T, actor: "key:k1", bytes: unique("job") });
    assert.equal((await x.getJob(T, job.id))?.status, "running");
    await assert.rejects(x.startExtractJob({ tenant: T, actor: "key:k2", bytes: unique("job") }), (e: InstanceType<typeof x.ExtractError>) => e.status === 429 && e.code === "too_many_running");
    release();
    const done = await x.waitForJob(T, job.id, 10);
    assert.equal(done?.status, "done");
    assert.equal(done?.result?.text, "done");
    assert.ok(done?.finishedAt);
    assert.equal(await x.getJob(`${T}b`, job.id), null, "another account's id is nothing");

    // A running row whose lease ran out: its process stopped.
    const id = x.newExtractJobId();
    await orm()!.execute(sql`INSERT INTO extract_jobs (id, tenant, actor, status, options, lease_until) VALUES (${id}, ${T}, 'key:k1', 'running', '{"lang":"auto","ocr":"auto"}'::jsonb, now() - interval '1 minute')`);
    const reaped = await x.getJob(T, id);
    assert.equal(reaped?.status, "failed");
    assert.equal(reaped?.error?.code, "worker_stopped");

    await x.deleteTenantExtracts(T);
    const { rows } = await orm()!.execute<{ n: number }>(sql`SELECT (SELECT count(*) FROM extract_jobs WHERE tenant = ${T}) + (SELECT count(*) FROM extract_artifacts WHERE tenant = ${T}) AS n`);
    assert.equal(Number(rows[0]?.n), 0);
  } finally {
    release?.();
    x.setExtractFetchForTests(null);
    delete process.env.FOLDRUN_EXTRACT_ACCOUNT_CAP;
  }
});
