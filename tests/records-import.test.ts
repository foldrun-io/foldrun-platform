// Boot import of the old record files into their tables (src/records-import.ts). DB-gated.
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { takeTurnsOnLiveDb } from "./live-db-lock.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
takeTurnsOnLiveDb(url);

if (!url) {
  test("records import (set FOLDRUN_TEST_DATABASE_URL to run)", { skip: "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" }, () => {});
} else {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  const day = new Date().toISOString().slice(0, 10);
  let root: string;
  const T = "imp1";
  const ws = (name: string) => path.join(root, T, "workspaces", name);
  const run = (id: string, at: string, status = "completed") => ({
    id, flow: "publish", status, startedAt: at, finishedAt: status === "completed" ? at : undefined, summary: `${id} ran`,
    steps: [{ agent: "writer", instruction: "w", group: 1, optional: false, status, events: [{ t: at, type: "text", text: "hi" }], result: "r", conclusion: "c", costUsd: 0.1 }],
  });

  before(async () => {
    const { migrate } = await import("../src/db.ts");
    await migrate();
  });
  after(async () => {
    const { closePgSync } = await import("../src/pg-sync.ts");
    await closePgSync();
    const { db } = await import("../src/db.ts");
    await db()?.end();
  });
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-recimp-"));
    process.env.FOLDRUN_DATA = root;
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    for (const table of ["run_records", "trigger_events", "workspace_files"]) pgSyncOne(`DELETE FROM ${table} WHERE tenant = $1`, [T]);
    // A workspace with the files the old code left.
    const d = ws("desk");
    fs.mkdirSync(path.join(d, "runs", "run-a", "outputs", "writer"), { recursive: true });
    fs.writeFileSync(path.join(d, "AGENTS.md"), "---\nname: desk\n---\n");
    fs.writeFileSync(path.join(d, "runs", "run-a.json"), JSON.stringify(run("run-a", "2026-11-01T01:00:00.000Z")));
    fs.writeFileSync(path.join(d, "runs", "run-b.json"), JSON.stringify(run("run-b", "2026-11-01T02:00:00.000Z", "running")));
    fs.writeFileSync(path.join(d, "runs", "run-c.json"), JSON.stringify(run("run-c", "2026-11-01T03:00:00.000Z")));
    fs.writeFileSync(path.join(d, "runs", "run-torn.json"), '{"id": "run-torn", "steps": [');
    fs.writeFileSync(path.join(d, "runs", ".index.json"), JSON.stringify({ v: 1, runs: {} }));
    fs.writeFileSync(path.join(d, "runs", "run-a", "outputs", "writer", "out.txt"), "bytes stay");
    fs.writeFileSync(
      path.join(d, "trigger-log.jsonl"),
      ['{"t":"2026-11-01T01:00:00.000Z","flow":"f","trigger":"webhook","outcome":"started","runId":"run-a"}', '{"t":"2026-11-01T01:05:00.000Z","flow":"f","trigger":"webhook","outcome":"duplicate","detail":"seen"}', "{torn"].join("\n") + "\n",
    );
    const store = path.join(root, T, "storage", "desk");
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(path.join(store, "index.json"), JSON.stringify({ version: 1, files: [
      { path: "a.txt", sha: "a".repeat(64), size: 5, mime: "text/plain", updatedAt: "2026-11-01T01:00:00.000Z", by: "user:a" },
      { path: "docs/b.pdf", sha: "b".repeat(64), size: 9, mime: "application/pdf", updatedAt: "2026-11-01T02:00:00.000Z", by: "run:run-a:writer" },
    ] }));
  });
  afterEach(async () => {
    const { resetPlatform } = await import("../../foldrun-core/src/platform.ts");
    resetPlatform();
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.FOLDRUN_DATA;
  });

  const count = async (table: string) => {
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    return Number(pgSyncOne(`SELECT count(*) AS n FROM ${table} WHERE tenant = $1`, [T]).rows[0].n);
  };

  test("runs, trigger log and storage index move; the files are set aside; the unreadable one is set aside by name", async () => {
    const { importRecordsFiles } = await import("../src/records-import.ts");
    const c = (await importRecordsFiles()).counts;
    assert.deepEqual(c, { runs: 3, runsSkipped: 1, triggerEvents: 2, storageFiles: 2 });
    assert.equal(await count("run_records"), 3);
    assert.equal(await count("trigger_events"), 2);
    assert.equal(await count("workspace_files"), 2);
    const runs = path.join(ws("desk"), "runs");
    assert.deepEqual(fs.readdirSync(runs).filter((f) => f.endsWith(".json") && !f.startsWith(".")), [], "nothing is left that a list would read as a run");
    assert.ok(fs.existsSync(path.join(runs, `run-torn.json.unreadable-${day}`)), "the unreadable one is kept to look at, under another name");
    for (const id of ["a", "b", "c"]) assert.ok(fs.existsSync(path.join(runs, `run-${id}.json.imported-${day}`)));
    assert.ok(fs.existsSync(path.join(runs, `.index.json.imported-${day}`)));
    assert.ok(fs.existsSync(path.join(ws("desk"), `trigger-log.jsonl.imported-${day}`)));
    assert.ok(fs.existsSync(path.join(root, T, "storage", "desk", `index.json.imported-${day}`)));
    assert.equal(fs.readFileSync(path.join(runs, "run-a", "outputs", "writer", "out.txt"), "utf8"), "bytes stay", "output folders are not touched");
  });

  test("what moved reads back through core, in the order the file kept", async () => {
    const { importRecordsFiles } = await import("../src/records-import.ts");
    const { registerPlatform } = await import("../../foldrun-core/src/platform.ts");
    const { pgRecords } = await import("../src/records-pg.ts");
    await importRecordsFiles();
    registerPlatform({ records: pgRecords() });
    const { listRunSummaries, liveRuns, readRun } = await import("../../foldrun-core/src/store.ts");
    const { readTriggerEvents } = await import("../../foldrun-core/src/trigger-log.ts");
    const { listStorage } = await import("../../foldrun-core/src/storage.ts");
    assert.deepEqual(listRunSummaries(T, "desk").map((r) => r.id), ["run-c", "run-b", "run-a"]);
    assert.deepEqual(liveRuns(T, "desk").map((r) => r.id), ["run-b"]);
    assert.equal(readRun(T, "desk", "run-a")!.steps[0].events[0].text, "hi");
    assert.deepEqual(readTriggerEvents(T, "desk").map((e) => e.outcome), ["duplicate", "started"]);
    assert.equal(readTriggerEvents(T, "desk")[1].runId, "run-a");
    assert.deepEqual(listStorage(T, "desk").map((f) => f.path).sort(), ["a.txt", "docs/b.pdf"]);
  });

  test("a second boot finds nothing to do, and moves nothing twice", async () => {
    const { importRecordsFiles } = await import("../src/records-import.ts");
    await importRecordsFiles();
    assert.equal((await importRecordsFiles()).counts, null);
    assert.equal(await count("run_records"), 3);
    assert.equal(await count("trigger_events"), 2);
  });

  test("two pods booting at once move each file once", async () => {
    const { importRecordsFiles } = await import("../src/records-import.ts");
    const [a, b] = await Promise.all([importRecordsFiles(), importRecordsFiles()]);
    const moved = [a.counts, b.counts].filter(Boolean);
    assert.equal(moved.length, 1, "one of them did the work; the other found it done");
    assert.equal(await count("run_records"), 3);
    assert.equal(await count("trigger_events"), 2, "the trigger log has no natural key: it must not double");
    assert.equal(await count("workspace_files"), 2);
  });

  test("a row already in the table is kept: a record written after the cutover is newer than the file", async () => {
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    pgSyncOne(
      `INSERT INTO run_records (tenant, workspace, run_id, flow, status, live, started_at, summary, record, updated_at) VALUES ($1, 'desk', 'run-a', 'publish', 'failed', false, '2026-11-01T01:00:00.000Z', '{"id":"run-a","flow":"publish","status":"failed","summary":null,"startedAt":"2026-11-01T01:00:00.000Z","finishedAt":null,"awaitingApproval":false,"steps":[]}'::jsonb, '{"id":"run-a","status":"failed","steps":[]}'::jsonb, now() + interval '1 hour')`,
      [T],
    );
    const { importRecordsFiles } = await import("../src/records-import.ts");
    await importRecordsFiles();
    assert.equal(pgSyncOne("SELECT status FROM run_records WHERE tenant = $1 AND run_id = 'run-a'", [T]).rows[0].status, "failed");
    assert.equal(await count("run_records"), 3);
  });

  // jsonb cannot hold \u0000: a run that has one fails its insert, before anything is set aside.
  const poisoned = () => {
    const other = ws("other");
    fs.mkdirSync(path.join(other, "runs"), { recursive: true });
    fs.writeFileSync(path.join(other, "AGENTS.md"), "---\nname: other\n---\n");
    fs.writeFileSync(path.join(other, "runs", "run-z.json"), JSON.stringify(run("run-z", "2026-11-01T05:00:00.000Z")));
    fs.writeFileSync(path.join(other, "runs", "run-bad.json"), JSON.stringify({ ...run("run-bad", "2026-11-01T05:30:00.000Z"), summary: "a\u0000b" }));
    fs.writeFileSync(path.join(other, "trigger-log.jsonl"), '{"t":"2026-11-01T05:00:00.000Z","flow":"f","trigger":"webhook","outcome":"started"}\n');
    return other;
  };

  test("a workspace that cannot be moved does NOT stop the boot: its files stay whole, the others are imported, it is named", async () => {
    const other = poisoned();
    const { importRecordsFiles } = await import("../src/records-import.ts");
    const r = await importRecordsFiles();
    assert.deepEqual(r.onFiles, [{ tenant: T, workspace: "other" }]);
    assert.equal(r.counts!.runs, 3, "desk was imported");
    assert.ok(fs.existsSync(path.join(ws("desk"), `trigger-log.jsonl.imported-${day}`)));
    assert.ok(fs.existsSync(path.join(other, "runs", "run-z.json")), "nothing of the failed workspace was set aside");
    assert.ok(fs.existsSync(path.join(other, "runs", "run-bad.json")));
    assert.ok(fs.existsSync(path.join(other, "trigger-log.jsonl")));
  });

  test("a workspace on files is served from its files by core, writes included, and the rest from the table", async () => {
    poisoned();
    const { importRecordsFiles } = await import("../src/records-import.ts");
    const { setWorkspacesOnFiles, pgRecords } = await import("../src/records-pg.ts");
    const { registerPlatform } = await import("../../foldrun-core/src/platform.ts");
    const r = await importRecordsFiles();
    setWorkspacesOnFiles(r.onFiles);
    registerPlatform({ records: pgRecords() });
    const store = await import("../../foldrun-core/src/store.ts");
    const { readTriggerEvents } = await import("../../foldrun-core/src/trigger-log.ts");
    assert.equal(store.readRun(T, "other", "run-z")!.id, "run-z", "read from its file");
    assert.deepEqual(store.listRunSummaries(T, "other").map((x) => x.id).sort(), ["run-bad", "run-z"]);
    assert.equal(readTriggerEvents(T, "other").length, 1);
    store.writeRun(T, "other", run("run-new", "2026-11-02T00:00:00.000Z") as never);
    assert.ok(fs.existsSync(path.join(ws("other"), "runs", "run-new.json")), "a write goes to the file");
    assert.equal(await count("run_records"), 3, "and not to the table");
    assert.equal(store.readRun(T, "desk", "run-a")!.id, "run-a", "an imported workspace reads the table");
    assert.equal(store.listWorkspaces(T).find((w) => w.name === "other")!.runCount, 3);
    assert.equal(store.listWorkspaces(T).find((w) => w.name === "desk")!.runCount, 3);
  });

  test("queue recovery never drops a job of a workspace on files, even when its run cannot be read", async () => {
    poisoned();
    const { importRecordsFiles } = await import("../src/records-import.ts");
    const { setWorkspacesOnFiles, pgRecords } = await import("../src/records-pg.ts");
    const { registerPlatform } = await import("../../foldrun-core/src/platform.ts");
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    const r = await importRecordsFiles();
    setWorkspacesOnFiles(r.onFiles);
    registerPlatform({ records: pgRecords() });
    for (const [ws, id] of [["other", "run-lost"], ["desk", "run-lost2"]]) {
      pgSyncOne(`INSERT INTO queue (run_id, tenant, workspace, seq) VALUES ($1, $2, $3, 1) ON CONFLICT (run_id) DO NOTHING`, [id, T, ws]);
    }
    try {
      const { recoverQueue } = await import("../src/queue.ts");
      const rec = await recoverQueue();
      assert.ok(!rec.dropped.includes("run-lost"), "the files workspace's job is kept");
      assert.ok(rec.dropped.includes("run-lost2"), "a job whose run is truly missing in an imported workspace is still dropped");
      assert.equal(Number(pgSyncOne("SELECT count(*) AS n FROM queue WHERE run_id = 'run-lost'").rows[0].n), 1);
    } finally {
      pgSyncOne("DELETE FROM queue WHERE run_id IN ('run-lost', 'run-lost2')");
    }
  });

  test("the next boot retries it: once the cause is gone it is imported, and a file newer than an old row wins", async () => {
    const other = poisoned();
    const { importRecordsFiles } = await import("../src/records-import.ts");
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    // An earlier attempt left an OLDER row for run-z; the file went on being written while on files.
    pgSyncOne(
      `INSERT INTO run_records (tenant, workspace, run_id, flow, status, live, started_at, summary, record, updated_at) VALUES ($1, 'other', 'run-z', 'publish', 'running', true, '2026-11-01T05:00:00.000Z', '{"id":"run-z","flow":"publish","status":"running","summary":null,"startedAt":"2026-11-01T05:00:00.000Z","finishedAt":null,"awaitingApproval":false,"steps":[]}'::jsonb, '{"id":"run-z","status":"running","steps":[]}'::jsonb, now() - interval '1 hour')`,
      [T],
    );
    assert.equal((await importRecordsFiles()).onFiles.length, 1, "run-bad still fails the workspace");
    assert.equal(pgSyncOne("SELECT status FROM run_records WHERE tenant = $1 AND run_id = 'run-z'", [T]).rows[0].status, "running", "nothing of the failed attempt was written");
    fs.rmSync(path.join(other, "runs", "run-bad.json")); // the cause is fixed
    const r = await importRecordsFiles();
    assert.deepEqual(r.onFiles, []);
    assert.equal(pgSyncOne("SELECT status FROM run_records WHERE tenant = $1 AND run_id = 'run-z'", [T]).rows[0].status, "completed", "the file was newer than the row");
    assert.ok(fs.existsSync(path.join(other, "runs", `run-z.json.imported-${day}`)));
    assert.equal((await importRecordsFiles()).onFiles.length, 0);
  });

  test("a rename that fails after every row is in is a warning: the workspace stays readable from its files and the retry is clean", async () => {
    const other = ws("other");
    fs.mkdirSync(path.join(other, "runs"), { recursive: true });
    fs.writeFileSync(path.join(other, "AGENTS.md"), "---\nname: other\n---\n");
    fs.writeFileSync(path.join(other, "runs", "run-z.json"), JSON.stringify(run("run-z", "2026-11-01T05:00:00.000Z")));
    fs.chmodSync(path.join(other, "runs"), 0o555); // cannot rename inside it
    const { importRecordsFiles } = await import("../src/records-import.ts");
    try {
      const r = await importRecordsFiles();
      assert.deepEqual(r.onFiles, [{ tenant: T, workspace: "other" }], "its file is still there, so it reads from files");
      assert.equal(await count("run_records"), 4);
    } finally {
      fs.chmodSync(path.join(other, "runs"), 0o755);
    }
    assert.deepEqual((await importRecordsFiles()).onFiles, []);
    assert.equal(await count("run_records"), 4);
  });

  test("a run that parses but is not shaped like one is quarantined alone (Codex review)", async () => {
    fs.writeFileSync(path.join(ws("desk"), "runs", "run-odd.json"), JSON.stringify({ id: "run-odd", startedAt: "2026-11-01T06:00:00.000Z", status: "completed", steps: [{}] }));
    fs.writeFileSync(path.join(ws("desk"), "runs", "run-nostatus.json"), JSON.stringify({ id: "run-nostatus", startedAt: "2026-11-01T06:00:00.000Z", steps: [] }));
    const { importRecordsFiles } = await import("../src/records-import.ts");
    const c = (await importRecordsFiles()).counts;
    assert.equal(c!.runs, 3);
    assert.equal(c!.runsSkipped, 3, "the torn one and the two malformed ones");
    assert.ok(fs.existsSync(path.join(ws("desk"), "runs", `run-odd.json.unreadable-${day}`)));
    assert.equal(await count("run_records"), 3);
  });

  test("a boot that crashed after the trigger log committed and before the rename adds nothing the second time (Codex review)", async () => {
    const { importRecordsFiles } = await import("../src/records-import.ts");
    const log = path.join(ws("desk"), "trigger-log.jsonl");
    const copy = fs.readFileSync(log, "utf8");
    await importRecordsFiles();
    assert.equal(await count("trigger_events"), 2);
    fs.writeFileSync(log, copy); // the rename "did not happen"
    await importRecordsFiles();
    assert.equal(await count("trigger_events"), 2, "same events, same rows");
  });
}
