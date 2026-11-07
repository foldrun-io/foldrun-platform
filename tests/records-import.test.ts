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
    const c = await importRecordsFiles();
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
    assert.equal(await importRecordsFiles(), null);
    assert.equal(await count("run_records"), 3);
    assert.equal(await count("trigger_events"), 2);
  });

  test("two pods booting at once move each file once", async () => {
    const { importRecordsFiles } = await import("../src/records-import.ts");
    const [a, b] = await Promise.all([importRecordsFiles(), importRecordsFiles()]);
    const moved = [a, b].filter(Boolean);
    assert.equal(moved.length, 1, "one of them did the work; the other found it done");
    assert.equal(await count("run_records"), 3);
    assert.equal(await count("trigger_events"), 2, "the trigger log has no natural key: it must not double");
    assert.equal(await count("workspace_files"), 2);
  });

  test("a row already in the table is kept: a record written after the cutover is newer than the file", async () => {
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    pgSyncOne(
      `INSERT INTO run_records (tenant, workspace, run_id, flow, status, live, started_at, summary, record) VALUES ($1, 'desk', 'run-a', 'publish', 'failed', false, '2026-11-01T01:00:00.000Z', '{"id":"run-a","flow":"publish","status":"failed","summary":null,"startedAt":"2026-11-01T01:00:00.000Z","finishedAt":null,"awaitingApproval":false,"steps":[]}'::jsonb, '{"id":"run-a","status":"failed","steps":[]}'::jsonb)`,
      [T],
    );
    const { importRecordsFiles } = await import("../src/records-import.ts");
    await importRecordsFiles();
    assert.equal(pgSyncOne("SELECT status FROM run_records WHERE tenant = $1 AND run_id = 'run-a'", [T]).rows[0].status, "failed");
    assert.equal(await count("run_records"), 3);
  });

  test("a workspace that cannot be imported fails the boot after the others are done, and the next boot finishes it (Codex review)", async () => {
    const other = ws("other");
    fs.mkdirSync(path.join(other, "runs"), { recursive: true });
    fs.writeFileSync(path.join(other, "AGENTS.md"), "---\nname: other\n---\n");
    fs.writeFileSync(path.join(other, "runs", "run-z.json"), JSON.stringify(run("run-z", "2026-11-01T05:00:00.000Z")));
    fs.chmodSync(path.join(other, "runs"), 0o555); // cannot rename inside it
    const { importRecordsFiles } = await import("../src/records-import.ts");
    try {
      await assert.rejects(() => importRecordsFiles(), /could not be moved into the database/);
      assert.equal(await count("run_records"), 4, "the other workspace's rows landed, and so did the one whose rename failed");
      assert.ok(fs.existsSync(path.join(ws("desk"), `trigger-log.jsonl.imported-${day}`)), "the healthy workspace was finished");
    } finally {
      fs.chmodSync(path.join(other, "runs"), 0o755);
    }
    await importRecordsFiles(); // now the rename works; the rows are already there
    assert.equal(await count("run_records"), 4);
    assert.ok(fs.existsSync(path.join(other, "runs", `run-z.json.imported-${day}`)));
  });

  test("a run that parses but is not shaped like one is quarantined alone (Codex review)", async () => {
    fs.writeFileSync(path.join(ws("desk"), "runs", "run-odd.json"), JSON.stringify({ id: "run-odd", startedAt: "2026-11-01T06:00:00.000Z", status: "completed", steps: [{}] }));
    fs.writeFileSync(path.join(ws("desk"), "runs", "run-nostatus.json"), JSON.stringify({ id: "run-nostatus", startedAt: "2026-11-01T06:00:00.000Z", steps: [] }));
    const { importRecordsFiles } = await import("../src/records-import.ts");
    const c = await importRecordsFiles();
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
