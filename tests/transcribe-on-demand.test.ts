// Speech to text on demand (14 Nov 2026, tool-pod.ts slice 3): no fixed
// Whisper, the account on the list — each model is the account's own pod,
// its lease held while it is used, Persian only when asked for or heard; a
// file's speech goes to the same pods. Whisper, the parser and the pods'
// /health are faked through their seams. On Postgres (the leases are rows);
// skipped without a database.
//
//   FOLDRUN_TEST_DATABASE_URL=postgres://foldrun:test@localhost:55432/foldrun \
//     node --test tests/transcribe-on-demand.test.ts

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
process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-stt-od-"));
delete process.env.FOLDRUN_REDIS_URL;
for (const k of ["FOLDRUN_EXTRACT_URL", "FOLDRUN_TRANSCRIBE_URL", "FOLDRUN_TRANSCRIBE_FA_URL"]) delete process.env[k];
const ACME = `sttacme${Date.now().toString(36)}`;
Object.assign(process.env, {
  FOLDRUN_TOOLS_ON_DEMAND: "1",
  FOLDRUN_TOOLS_ON_DEMAND_ACCOUNTS: ACME,
  FOLDRUN_EXTRACT_RATE_PER_MIN: "1000",
  FOLDRUN_RUN_ISOLATION: "k8s",
  FOLDRUN_RUNNER_RUNTIME: "gvisor",
  FOLDRUN_EXTRACT_IMAGE: "ecr.example/ghcr/foldrun-io/extract@sha256:abc",
  FOLDRUN_TRANSCRIBE_IMAGE: "ecr.example/ghcr/foldrun-io/transcribe@sha256:def",
});

before(async () => {
  if (!dbUrl) return;
  const { migrate } = await import("../src/db.ts");
  await migrate();
});

const t = await import("../src/transcribe.ts");
const x = await import("../src/extract.ts");
const tp = await import("../src/tool-pod.ts");

const GEN = `http://foldrun-stt-gen-${ACME}.foldrun-runs.svc.cluster.local:8080`;
const FA = `http://foldrun-stt-fa-${ACME}.foldrun-runs.svc.cluster.local:8080`;

function wav(seconds: number): Buffer {
  const data = Math.round(seconds * 16_000) * 2;
  const b = Buffer.alloc(44 + data);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + data, 4);
  b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16_000, 24);
  b.writeUInt32LE(32_000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(data, 40);
  for (let i = 0; i + 1 < data; i += 2) b.writeInt16LE(Math.round(Math.sin((i / 2) * 2 * Math.PI * 440 / 16_000) * 9000), 44 + i);
  return b;
}

/** The pods' /health: every one answers; which were asked is recorded. */
function pods(): string[] {
  const asked: string[] = [];
  tp.setToolFetchForTests((async (url: string) => (asked.push(url.replace(/\/health$/, "")), new Response("ok"))) as typeof fetch);
  return asked;
}

/** A Whisper that hears `heard` (auto detection) and answers by model. */
function whisper(heard: string): { base: string; detect: boolean }[] {
  const calls: { base: string; detect: boolean }[] = [];
  t.setTranscribeFetchForTests(async (input, init) => {
    const form = init!.body as FormData;
    const base = String(input).replace(/\/inference$/, "");
    const detect = form.get("detect_language") === "true";
    calls.push({ base, detect });
    const body = detect ? { text: "", language: heard } : { text: base === FA ? "سلام" : "hello", language: heard };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  return calls;
}

async function leases(): Promise<{ tool: string; live: boolean }[]> {
  const { orm } = await import("../src/db.ts");
  const { sql } = await import("drizzle-orm");
  const { rows } = await orm()!.execute<{ tool: string; live: boolean }>(sql`SELECT tool, lease_until > now() AS live FROM tool_leases WHERE tenant = ${ACME} ORDER BY created_at`);
  return rows;
}
async function clearLeases(): Promise<void> {
  const { orm } = await import("../src/db.ts");
  const { sql } = await import("drizzle-orm");
  await orm()!.execute(sql`DELETE FROM tool_leases WHERE tenant = ${ACME}`);
}

test.afterEach(async () => {
  t.setTranscribeFetchForTests(null);
  tp.setToolFetchForTests(null);
  x.setExtractFetchForTests(null);
  if (dbUrl) await clearLeases();
});

test("configured per account, through the pods", opts, () => {
  assert.equal(t.speechConfiguredFor(ACME), true);
  assert.equal(t.speechConfiguredFor("beta"), false);
  assert.equal(t.speechConfiguredFor(undefined), false, "no account, no pods");
});

test("lang=fa: only the Persian pod is made and used; its lease ends with the call", opts, async () => {
  const asked = pods();
  const calls = whisper("persian");
  const r = await t.transcribe(wav(2), "fa", process.env, undefined, ACME);
  assert.equal(r.text, "سلام");
  assert.equal(r.language, "fa");
  assert.deepEqual(asked, [FA]);
  assert.deepEqual(calls.map((c) => c.base), [FA]);
  assert.deepEqual(await leases(), [{ tool: "stt-fa", live: false }]);
});

test("auto, Persian heard: detected on the general pod, transcribed on the Persian one", opts, async () => {
  const asked = pods();
  const calls = whisper("persian");
  const r = await t.transcribe(wav(2), "auto", process.env, undefined, ACME);
  assert.equal(r.language, "fa");
  assert.deepEqual(asked, [GEN, FA], "Persian is made only once it is heard");
  assert.deepEqual(calls, [{ base: GEN, detect: true }, { base: FA, detect: false }]);
  assert.deepEqual((await leases()).map((l) => l.tool), ["stt-gen", "stt-fa"]);
});

test("auto, English heard: the general pod alone; no Persian pod is ever made", opts, async () => {
  const asked = pods();
  const calls = whisper("english");
  const r = await t.transcribe(wav(2), "auto", process.env, undefined, ACME);
  assert.equal(r.text, "hello");
  assert.equal(r.language, "en");
  assert.deepEqual(asked, [GEN]);
  assert.ok(calls.every((c) => c.base === GEN));
  assert.deepEqual((await leases()).map((l) => l.tool), ["stt-gen"]);
});

test("a pod that never starts is a 503, the lease still ended", opts, async () => {
  process.env.FOLDRUN_TOOL_POD_START_S = "0.3";
  try {
    tp.setToolFetchForTests((async () => new Response("", { status: 503 })) as typeof fetch);
    await assert.rejects(t.transcribe(wav(2), "en", process.env, undefined, ACME), (e: InstanceType<typeof t.TranscribeError>) => e.status === 503 && /did not start/.test(e.message));
    assert.deepEqual(await leases(), [{ tool: "stt-gen", live: false }]);
  } finally {
    delete process.env.FOLDRUN_TOOL_POD_START_S;
  }
});

test("a file's speech: the parser cuts it on the account's parser pod, Whisper is the account's own pod", opts, async () => {
  const asked = pods();
  const calls = whisper("english");
  const parserHosts: string[] = [];
  x.setExtractFetchForTests(async (input) => {
    const url = new URL(String(input));
    parserHosts.push(url.host);
    if (url.pathname === "/audio") return new Response(new Uint8Array(wav(3)), { status: 200, headers: { "content-type": "audio/wav" } });
    const body = { kind: "audio", format: "wav", text: "", engine: "ffmpeg", needs_speech: true, seconds: 3, truncated: false, warnings: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  const r = await x.extractFile(ACME, Buffer.from(`talk-${crypto.randomBytes(8).toString("hex")}`), { name: "note.wav" });
  assert.match(r.text, /hello/);
  assert.ok(parserHosts.every((h) => h === `foldrun-extract-${ACME}.foldrun-runs.svc.cluster.local:8090`));
  assert.ok(asked.includes(GEN), "the account's Whisper pod");
  assert.ok(calls.every((c) => c.base === GEN));
});
