// Files to text with the parser on demand (14 Nov 2026, tool-pod.ts): no
// fixed FOLDRUN_EXTRACT_URL, the account on the on-demand list — the file
// goes to the account's own pod, once it answers; a file already read asks
// no pod at all; an account not on the list is "not configured".
//
//   FOLDRUN_TEST_DATABASE_URL=postgres://foldrun:test@localhost:55432/foldrun \
//     node --test tests/extract-on-demand.test.ts
//
// On Postgres: tools on demand need one (the worker finds the work by the
// leases' rows). Skipped without a database.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { takeTurnsOnLiveDb } from "./live-db-lock.ts";

const dbUrl = process.env.FOLDRUN_TEST_DATABASE_URL;
const opts = { skip: dbUrl ? false : "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" };
takeTurnsOnLiveDb(dbUrl);
if (dbUrl) {
  const u = new URL(dbUrl);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  process.env.FOLDRUN_SECRET_KEY ??= "test-install-key";
}
process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-extract-od-"));
delete process.env.FOLDRUN_REDIS_URL;
delete process.env.FOLDRUN_EXTRACT_URL;
delete process.env.FOLDRUN_TRANSCRIBE_URL;
delete process.env.FOLDRUN_TRANSCRIBE_FA_URL;
const ACME = `odacme${Date.now().toString(36)}`;
Object.assign(process.env, {
  FOLDRUN_TOOLS_ON_DEMAND: "1",
  FOLDRUN_TOOLS_ON_DEMAND_ACCOUNTS: ACME,
  FOLDRUN_EXTRACT_RATE_PER_MIN: "1000",
  FOLDRUN_RUN_ISOLATION: "k8s",
  FOLDRUN_RUNNER_RUNTIME: "gvisor",
  FOLDRUN_EXTRACT_IMAGE: "ecr.example/ghcr/foldrun-io/extract@sha256:abc",
});

before(async () => {
  if (!dbUrl) return;
  const { migrate } = await import("../src/db.ts");
  await migrate();
});

const x = await import("../src/extract.ts");
const tp = await import("../src/tool-pod.ts");

const POD = `http://foldrun-extract-${ACME}.foldrun-runs.svc.cluster.local:8090`;
const unique = (label: string) => Buffer.from(`${label}-${crypto.randomBytes(8).toString("hex")}`);

test.afterEach(() => {
  x.setExtractFetchForTests(null);
  tp.setToolFetchForTests(null);
});

test("configured per account: on the list yes, off it no", opts, () => {
  assert.equal(x.extractConfigured(), false, "no fixed parser");
  assert.equal(x.extractConfiguredFor(ACME), true);
  assert.equal(x.extractConfiguredFor("beta"), false);
  assert.ok(x.platformExtractHooks().extractText, "run inputs' .txt is registered while tools are on demand");
});

test("the file goes to the account's own pod once it answers; a second read of it asks no pod", opts, async () => {
  let health = 0;
  tp.setToolFetchForTests((async (url: string) => {
    assert.equal(url, `${POD}/health`);
    health++;
    return health < 2 ? new Response("", { status: 503 }) : new Response("ok", { status: 200 });
  }) as typeof fetch);
  const asked: string[] = [];
  x.setExtractFetchForTests(async (input) => {
    asked.push(String(input));
    const body = { kind: "image", format: "png", text: "hello", confidence: 90, engine: "tesseract:fas+eng", ocr: true, needs_speech: false, truncated: false, warnings: [], ms: 5 };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  const bytes = unique("scan");
  const r = await x.extractFile(ACME, bytes, { name: "scan.png" });
  assert.equal(r.text, "hello");
  assert.equal(health, 2, "waited through one 'not yet'");
  assert.equal(asked.length, 1);
  assert.ok(asked[0].startsWith(`${POD}/extract?`), `the account's pod, not a shared parser: ${asked[0]}`);

  health = 0;
  const again = await x.extractFile(ACME, bytes, { name: "scan.png" });
  assert.equal(again.cached, true);
  assert.equal(health, 0, "a file already read costs no pod");
});

test("an account off the list is not configured, and no pod is waited for", opts, async () => {
  let health = 0;
  tp.setToolFetchForTests((async () => (health++, new Response("ok"))) as typeof fetch);
  await assert.rejects(x.extractFile("beta", unique("x")), (e: InstanceType<typeof x.ExtractError>) => e.status === 503 && e.code === "not_configured");
  assert.equal(health, 0);
});

test("a pod that never starts: 503 tool_starting with Retry-After, not a hang", opts, async () => {
  process.env.FOLDRUN_TOOL_POD_START_S = "0.3";
  try {
    tp.setToolFetchForTests((async () => new Response("", { status: 503 })) as typeof fetch);
    await assert.rejects(x.extractFile(ACME, unique("y")), (e: InstanceType<typeof x.ExtractError>) => e.status === 503 && e.code === "tool_starting" && e.retryAfter === 30);
  } finally {
    delete process.env.FOLDRUN_TOOL_POD_START_S;
  }
});
