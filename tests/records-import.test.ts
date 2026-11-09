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
  // Short waits, so a barrier that is not acknowledged gives up within a test.
  process.env.FOLDRUN_RECORDS_ACK_WAIT_MS = "1500";
  process.env.FOLDRUN_RECORDS_MOVING_WAIT_MS = "300";
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
    // The routing is the install's: every test starts from an install that
    // has moved nothing, with no other process about.
    pgSyncOne("DELETE FROM records_routing");
    pgSyncOne("DELETE FROM records_routing_pods");
    const { resetRoutingForTest } = await import("../src/records-routing.ts");
    resetRoutingForTest();
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
    for (const d of [path.join(ws("other"), "runs"), path.join(root, T, "storage")]) fs.existsSync(d) && fs.chmodSync(d, 0o755);
    const { resetPlatform } = await import("../../foldrun-core/src/platform.ts");
    resetPlatform();
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.FOLDRUN_DATA;
  });

  const count = async (table: string) => {
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    return Number(pgSyncOne(`SELECT count(*) AS n FROM ${table} WHERE tenant = $1`, [T]).rows[0].n);
  };

  const routeRow = async (workspace: string) => {
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    return (pgSyncOne("SELECT state FROM records_routing WHERE tenant = $1 AND workspace = $2", [T, workspace]).rows[0]?.state as string | undefined) ?? null;
  };
  const defaultRow = async () => {
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    return (pgSyncOne("SELECT state FROM records_routing WHERE tenant = '*' AND workspace = '*'").rows[0]?.state as string | undefined) ?? null;
  };
  const livePort = async () => {
    const { pgRecords } = await import("../src/records-pg.ts");
    const { registerPlatform } = await import("../../foldrun-core/src/platform.ts");
    registerPlatform({ records: pgRecords() });
  };

  test("runs, trigger log and storage index move; the files are set aside; the unreadable one is set aside by name", async () => {
    const { importRecordsFiles } = await import("../src/records-import.ts");
    const c = (await importRecordsFiles()).counts;
    assert.deepEqual(c, { runs: 3, runsSkipped: 1, triggerEvents: 2, storageFiles: 2, strays: 0 });
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
    assert.equal(await routeRow("desk"), "database", "the routing every process reads says so");
    assert.equal(await defaultRow(), "database", "and a workspace made from now on starts in the database");
  });

  test("what moved reads back through core, in the order the file kept", async () => {
    const { importRecordsFiles } = await import("../src/records-import.ts");
    await importRecordsFiles();
    await livePort();
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

  const olderRow = async (workspace: string, id: string, status: string, offset: string) => {
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    pgSyncOne(
      `INSERT INTO run_records (tenant, workspace, run_id, flow, status, live, started_at, summary, record, updated_at) VALUES ($1, $2, $3, 'publish', $4, false, '2026-11-01T01:00:00.000Z', jsonb_build_object('id', $3::text, 'flow', 'publish', 'status', $4::text, 'summary', null, 'startedAt', '2026-11-01T01:00:00.000Z', 'finishedAt', null, 'awaitingApproval', false, 'steps', '[]'::jsonb), jsonb_build_object('id', $3::text, 'status', $4::text, 'steps', '[]'::jsonb), now() + $5::interval)`,
      [T, workspace, id, status, offset],
    );
  };
  const statusOf = async (id: string) => {
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    return pgSyncOne("SELECT status FROM run_records WHERE tenant = $1 AND run_id = $2", [T, id]).rows[0]?.status as string | undefined;
  };

  test("a workspace on files: its files are the records, so they replace any row an earlier attempt left — even a newer-looking one (FOL-152)", async () => {
    const { seedRouting } = await import("../src/records-import.ts");
    await seedRouting(); // an earlier attempt of this release: the routing was already seeded
    await olderRow("desk", "run-a", "failed", "1 hour");
    await olderRow("desk", "run-gone", "running", "1 hour"); // a draft whose run was deleted while on files
    const { importRecordsFiles } = await import("../src/records-import.ts");
    await importRecordsFiles();
    assert.equal(await statusOf("run-a"), "completed", "the file");
    assert.equal(await statusOf("run-gone"), undefined, "no file, no run");
    assert.equal(await count("run_records"), 3);
  });

  test("a workspace an earlier release already moved keeps the rows it wrote since: a newer row stays, a row with no file stays", async () => {
    fs.writeFileSync(path.join(ws("desk"), "runs", `run-old.json.imported-2026-11-08`), "{}"); // what FOL-126's boot import left
    await olderRow("desk", "run-a", "failed", "1 hour");
    await olderRow("desk", "run-new", "completed", "1 hour");
    const { importRecordsFiles } = await import("../src/records-import.ts");
    await importRecordsFiles();
    assert.equal(await statusOf("run-a"), "failed", "the row is newer than the file");
    assert.equal(await statusOf("run-new"), "completed");
    assert.equal(await count("run_records"), 4);
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

  test("a workspace that cannot be moved does NOT stop the boot: its files stay whole, the others are imported, it is named, and the routing keeps it on files", async () => {
    const other = poisoned();
    const { importRecordsFiles } = await import("../src/records-import.ts");
    const r = await importRecordsFiles();
    assert.deepEqual(r.onFiles, [{ tenant: T, workspace: "other" }]);
    assert.equal(r.counts!.runs, 3, "desk was imported");
    assert.ok(fs.existsSync(path.join(ws("desk"), `trigger-log.jsonl.imported-${day}`)));
    assert.ok(fs.existsSync(path.join(other, "runs", "run-z.json")), "nothing of the failed workspace was set aside");
    assert.ok(fs.existsSync(path.join(other, "runs", "run-bad.json")));
    assert.ok(fs.existsSync(path.join(other, "trigger-log.jsonl")));
    assert.equal(await routeRow("other"), "files");
    assert.equal(await routeRow("desk"), "database");
  });

  test("a workspace on files is served from its files by core, writes included, and the rest from the table — for every process, by the routing", async () => {
    poisoned();
    const { importRecordsFiles } = await import("../src/records-import.ts");
    await importRecordsFiles();
    await livePort();
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
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    await importRecordsFiles();
    await livePort();
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

  test("the next boot retries it: once the cause is gone it is imported whole", async () => {
    const other = poisoned();
    const { importRecordsFiles } = await import("../src/records-import.ts");
    assert.equal((await importRecordsFiles()).onFiles.length, 1, "run-bad still fails the workspace");
    fs.rmSync(path.join(other, "runs", "run-bad.json")); // the cause is fixed
    const r = await importRecordsFiles();
    assert.deepEqual(r.onFiles, []);
    assert.equal(await statusOf("run-z"), "completed");
    assert.equal(await statusOf("run-bad"), undefined);
    assert.ok(fs.existsSync(path.join(other, "runs", `run-z.json.imported-${day}`)));
    assert.equal((await importRecordsFiles()).onFiles.length, 0);
  });

  test("a rename that fails after the flip changes nothing a reader sees: the rows are the records, and the retry sets the file aside as imported (FOL-152)", async () => {
    // The storage index cannot be renamed, the runs can: the half-renamed
    // workspace that FOL-126 sent back to files whole, its runs out of sight.
    fs.chmodSync(path.join(root, T, "storage", "desk"), 0o555);
    const { importRecordsFiles } = await import("../src/records-import.ts");
    const r = await importRecordsFiles();
    assert.deepEqual(r.onFiles, [], "nothing is on files");
    assert.ok(fs.existsSync(path.join(root, T, "storage", "desk", "index.json")), "the index is still there");
    await livePort();
    const store = await import("../../foldrun-core/src/store.ts");
    assert.deepEqual(store.listRunSummaries(T, "desk").map((x) => x.id), ["run-c", "run-b", "run-a"], "the runs are read from their rows");
    fs.chmodSync(path.join(root, T, "storage", "desk"), 0o755);
    const again = await importRecordsFiles();
    assert.equal(again.counts?.strays ?? 0, 0, "it says what the rows say: not a stray");
    assert.ok(fs.existsSync(path.join(root, T, "storage", "desk", `index.json.imported-${day}`)));
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

  test("the trigger log copied twice (the copy, then the settle; or a crashed boot) adds nothing the second time (Codex review)", async () => {
    const { importRecordsFiles } = await import("../src/records-import.ts");
    const log = path.join(ws("desk"), "trigger-log.jsonl");
    const copy = fs.readFileSync(log, "utf8");
    await importRecordsFiles();
    assert.equal(await count("trigger_events"), 2);
    fs.writeFileSync(log, copy); // the rename "did not happen"
    const again = await importRecordsFiles();
    assert.equal(await count("trigger_events"), 2, "same events, same rows");
    assert.equal(again.counts?.strays ?? 0, 0, "and the leftover is set aside as imported");
    assert.ok(fs.existsSync(path.join(ws("desk"), `trigger-log.jsonl.imported-${day}-2`)));
  });

  // ---- FOL-152: the barrier, the shared routing, strays

  const fakePod = async (pod: string, gen: number, ago = "0 seconds") => {
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    pgSyncOne(`INSERT INTO records_routing_pods (pod, gen, beat_at) VALUES ($1, $2, now() - $3::interval) ON CONFLICT (pod) DO UPDATE SET gen = EXCLUDED.gen, beat_at = EXCLUDED.beat_at`, [pod, gen, ago]);
  };
  const currentGen = async () => {
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    return Number(pgSyncOne("SELECT gen FROM records_routing WHERE tenant = '*' AND workspace = '*'").rows[0]?.gen ?? 0);
  };

  test("a process that does not acknowledge the hold stops the move: nothing is flipped, nothing set aside, the files stand (FOL-152)", async () => {
    await fakePod("files-mode-pod", 0); // alive, still routing by generation 0
    const { importRecordsFiles } = await import("../src/records-import.ts");
    const r = await importRecordsFiles();
    assert.deepEqual(r.onFiles, [{ tenant: T, workspace: "desk" }]);
    assert.equal(await routeRow("desk"), "files");
    assert.notEqual(await defaultRow(), "database");
    assert.ok(fs.existsSync(path.join(ws("desk"), "runs", "run-a.json")), "its files are where they were");
    // One that went quiet longer ago than the window is not waited for (its
    // lease ran out long before: it refuses record calls).
    await fakePod("files-mode-pod", 0, "10 minutes");
    assert.deepEqual((await importRecordsFiles()).onFiles, []);
    assert.equal(await routeRow("desk"), "database");
  });

  test("what a files-mode process writes before it acknowledges is in the rows: a changed run, a new one, a deleted one (FOL-152)", async () => {
    await fakePod("files-mode-pod", 0);
    const runs = path.join(ws("desk"), "runs");
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    // The other process: it sees the hold only at its next beat, and until
    // then goes on writing the files — then acknowledges.
    const other = (async () => {
      for (let i = 0; i < 100; i++) {
        if (pgSyncOne("SELECT 1 FROM records_routing WHERE tenant = $1 AND workspace = 'desk' AND state = 'moving'", [T]).rows.length) break;
        await new Promise((res) => setTimeout(res, 20));
      }
      const b = run("run-b", "2026-11-01T02:00:00.000Z", "completed"); // run-b finished
      fs.writeFileSync(path.join(runs, "run-b.json.tmp"), JSON.stringify(b));
      fs.renameSync(path.join(runs, "run-b.json.tmp"), path.join(runs, "run-b.json"));
      fs.writeFileSync(path.join(runs, "run-d.json"), JSON.stringify(run("run-d", "2026-11-01T04:00:00.000Z", "running"))); // a new run
      fs.rmSync(path.join(runs, "run-c.json")); // a deleted one
      fs.appendFileSync(path.join(ws("desk"), "trigger-log.jsonl"), '{"t":"2026-11-01T04:00:00.000Z","flow":"f","trigger":"webhook","outcome":"started","runId":"run-d"}\n');
      await fakePod("files-mode-pod", await currentGen());
    })();
    const { importRecordsFiles } = await import("../src/records-import.ts");
    const r = await importRecordsFiles();
    await other;
    assert.deepEqual(r.onFiles, []);
    assert.equal(await statusOf("run-b"), "completed", "the write made during the copy");
    assert.equal(await statusOf("run-d"), "running", "the run made during the copy");
    assert.equal(await statusOf("run-c"), undefined, "the run deleted during the copy");
    assert.equal(await count("trigger_events"), 3);
    assert.equal(r.counts!.strays, 0);
  });

  test("a process that cut nothing over itself follows the move another made: its 'files' answer is re-read, never kept (FOL-152)", async () => {
    poisoned();
    const { importRecordsFiles } = await import("../src/records-import.ts");
    const { routeOf, routingBeat } = await import("../src/records-routing.ts");
    await importRecordsFiles();
    assert.equal(routeOf(T, "other"), "files");
    // Another pod fixes and moves it; this one is told nothing directly.
    fs.rmSync(path.join(ws("other"), "runs", "run-bad.json"));
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    pgSyncOne("UPDATE records_routing SET state = 'database' WHERE tenant = $1 AND workspace = 'other'", [T]);
    pgSyncOne("UPDATE records_routing SET gen = gen + 1 WHERE tenant = '*' AND workspace = '*'");
    await routingBeat();
    assert.equal(routeOf(T, "other"), "database", "the next beat has it");
    await livePort();
    const store = await import("../../foldrun-core/src/store.ts");
    assert.ok(fs.existsSync(path.join(ws("other"), "runs", "run-z.json")));
    assert.equal(store.readRun(T, "other", "run-z"), null, "read from the rows now, not from the file still there");
  });

  test("while a workspace is moving, a record call waits a moment and is then refused as busy; lifecycle changes are refused too (FOL-152)", async () => {
    const { importRecordsFiles } = await import("../src/records-import.ts");
    await importRecordsFiles();
    await livePort();
    const store = await import("../../foldrun-core/src/store.ts");
    const { RecordsBusy, noteRoutingChanged } = await import("../src/records-routing.ts");
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    fs.mkdirSync(path.join(ws("fresh"), "runs"), { recursive: true });
    fs.writeFileSync(path.join(ws("fresh"), "AGENTS.md"), "---\nname: fresh\n---\n");
    pgSyncOne("INSERT INTO records_routing (tenant, workspace, state, moving_until) VALUES ($1, 'fresh', 'moving', now() + interval '1 minute')", [T]);
    pgSyncOne("UPDATE records_routing SET gen = gen + 1 WHERE tenant = '*' AND workspace = '*'");
    noteRoutingChanged();
    const began = Date.now();
    assert.throws(() => store.readRun(T, "fresh", "run-x"), RecordsBusy);
    assert.ok(Date.now() - began >= 250, "it waited first");
    assert.throws(() => store.readRun(T, "fresh", "run-x"), RecordsBusy, "and the next is refused at once");
    const renameAt = Date.now();
    assert.throws(() => store.renameWorkspace(T, "fresh", "renamed"), RecordsBusy);
    assert.ok(Date.now() - renameAt < 250, "a rename is refused at once: it never waits on (and so never acknowledges) a move half way through (Codex review)");
    assert.ok(fs.existsSync(ws("fresh")) && !fs.existsSync(ws("renamed")), "the folder was put back");
    assert.throws(() => store.deleteWorkspace(T, "fresh"), RecordsBusy);
    assert.ok(fs.existsSync(ws("fresh")), "nothing was deleted");
    assert.equal(store.readRun(T, "desk", "run-a")?.id, "run-a", "other workspaces are not held");
    pgSyncOne("UPDATE records_routing SET state = 'database', moving_until = NULL WHERE tenant = $1 AND workspace = 'fresh'", [T]);
    pgSyncOne("UPDATE records_routing SET gen = gen + 1 WHERE tenant = '*' AND workspace = '*'");
    noteRoutingChanged();
    assert.equal(store.readRun(T, "fresh", "run-x"), null, "the move ended: rows");
  });

  test("a move whose importer died is given up on: the next import puts it back to files and moves it again (FOL-152)", async () => {
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    pgSyncOne("INSERT INTO records_routing (tenant, workspace, state, moving_until) VALUES ($1, 'desk', 'moving', now() - interval '1 hour')", [T]);
    const { routeOf, noteRoutingChanged } = await import("../src/records-routing.ts");
    noteRoutingChanged();
    assert.equal(routeOf(T, "desk"), "files", "long past its deadline: the files stand");
    const { importRecordsFiles } = await import("../src/records-import.ts");
    const r = await importRecordsFiles();
    assert.deepEqual(r.onFiles, []);
    assert.equal(await routeRow("desk"), "database");
    assert.equal(await count("run_records"), 3);
  });

  test("a record file written into a workspace already in the database is set aside as a stray, never merged; an identical leftover is just imported (FOL-152)", async () => {
    const { importRecordsFiles } = await import("../src/records-import.ts");
    await importRecordsFiles();
    const runs = path.join(ws("desk"), "runs");
    // A process of an older release (or a write that hung past the barrier):
    fs.writeFileSync(path.join(runs, "run-a.json"), JSON.stringify(run("run-a", "2026-11-01T01:00:00.000Z", "failed")));
    fs.writeFileSync(path.join(runs, "run-e.json"), JSON.stringify(run("run-e", "2026-11-01T07:00:00.000Z")));
    // And a leftover that says what the row says:
    fs.copyFileSync(path.join(runs, `run-c.json.imported-${day}`), path.join(runs, "run-c.json"));
    const r = await importRecordsFiles();
    assert.equal(r.counts!.strays, 2);
    assert.ok(fs.existsSync(path.join(runs, `run-a.json.stray-${day}`)));
    assert.ok(fs.existsSync(path.join(runs, `run-e.json.stray-${day}`)));
    assert.ok(fs.existsSync(path.join(runs, `run-c.json.imported-${day}-2`)));
    assert.equal(await statusOf("run-a"), "completed", "the row is kept");
    assert.equal(await statusOf("run-e"), undefined, "nothing merged in");
  });

  test("a workspace made after the move starts in the database; a rename across the routing is refused where it would hide files (FOL-152)", async () => {
    poisoned();
    const { importRecordsFiles } = await import("../src/records-import.ts");
    await importRecordsFiles();
    await livePort();
    const store = await import("../../foldrun-core/src/store.ts");
    fs.mkdirSync(path.join(ws("later"), "runs"), { recursive: true });
    fs.writeFileSync(path.join(ws("later"), "AGENTS.md"), "---\nname: later\n---\n");
    store.writeRun(T, "later", run("run-l", "2026-11-03T00:00:00.000Z") as never);
    assert.ok(!fs.existsSync(path.join(ws("later"), "runs", "run-l.json")), "a row, not a file");
    assert.equal(store.readRun(T, "later", "run-l")?.id, "run-l");
    assert.throws(() => store.renameWorkspace(T, "other", "elsewhere"), /still on files/);
    assert.ok(fs.existsSync(ws("other")), "the folder went back");
    store.renameWorkspace(T, "later", "later2");
    assert.equal(store.readRun(T, "later2", "run-l")?.id, "run-l", "a database workspace renames as before");
  });

  test("the import runs with the routed port in place, as at boot: holding its own workspaces does not stall its listing of them (Codex review)", async () => {
    await livePort();
    poisoned();
    const { importRecordsFiles } = await import("../src/records-import.ts");
    const began = Date.now();
    const r = await importRecordsFiles();
    assert.deepEqual(r.onFiles, [{ tenant: T, workspace: "other" }]);
    assert.equal(await routeRow("desk"), "database");
    assert.equal(await defaultRow(), "database", "the default moved too: the listing was not refused");
    assert.ok(Date.now() - began < 3000, "and nothing waited out a hold");
  });

  test("first contact: a workspace the release before this one already moved starts in the database, in either mode; one it left on files does not (Codex review)", async () => {
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    // desk as FOL-126's boot import left it: rows in, every file set aside.
    const { importRecordsFiles, seedRouting } = await import("../src/records-import.ts");
    await importRecordsFiles();
    pgSyncOne("DELETE FROM records_routing");
    const { resetRoutingForTest, routeOf } = await import("../src/records-routing.ts");
    resetRoutingForTest();
    poisoned(); // other: files, never moved
    fs.writeFileSync(path.join(ws("other"), "runs", "run-y.json.imported-2026-11-08"), "{}"); // touched, but files remain
    await seedRouting();
    assert.equal(await routeRow("desk"), "database");
    assert.equal(await routeRow("other"), "files", "still on files, marked as touched before");
    assert.equal(pgSyncOne("SELECT legacy FROM records_routing WHERE tenant = $1 AND workspace = 'other'", [T]).rows[0].legacy, true);
    assert.equal(routeOf(T, "desk"), "database");
    await livePort();
    const store = await import("../../foldrun-core/src/store.ts");
    assert.deepEqual(store.listRunSummaries(T, "desk").map((x) => x.id), ["run-c", "run-b", "run-a"], "its rows, not its missing files");
    pgSyncOne("DELETE FROM records_routing WHERE tenant = $1 AND workspace = 'desk'", [T]);
    await seedRouting();
    assert.equal(await routeRow("desk"), null, "once only");
  });

  test("first contact: a workspace that release made in the database (rows, never a file) starts there; one with rows AND files keeps every row through the move (Codex review)", async () => {
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    const { seedRouting, importRecordsFiles } = await import("../src/records-import.ts");
    // native: made after that release's import, its runs only ever rows.
    fs.mkdirSync(path.join(ws("native"), "runs"), { recursive: true });
    fs.writeFileSync(path.join(ws("native"), "AGENTS.md"), "---\nname: native\n---\n");
    await olderRow("native", "run-n", "completed", "0 seconds");
    // desk: rows that release wrote (run-row) beside files a files-mode process went on writing.
    await olderRow("desk", "run-row", "completed", "0 seconds");
    await seedRouting();
    assert.equal(await routeRow("native"), "database");
    assert.equal(await routeRow("desk"), "files");
    assert.equal(pgSyncOne("SELECT legacy FROM records_routing WHERE tenant = $1 AND workspace = 'desk'", [T]).rows[0].legacy, true);
    await importRecordsFiles();
    assert.equal(await routeRow("desk"), "database");
    assert.equal(await statusOf("run-row"), "completed", "a row with no file is kept: it may be a run only the database had");
    assert.equal(await statusOf("run-n"), "completed");
    assert.equal(await count("run_records"), 5);
  });

  test("a workspace marked as holding an earlier release's rows keeps that mark through a rename, so the move still deletes none of them (Codex review)", async () => {
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    const { seedRouting, importRecordsFiles } = await import("../src/records-import.ts");
    await olderRow("desk", "run-row", "completed", "0 seconds");
    await seedRouting();
    await livePort();
    const store = await import("../../foldrun-core/src/store.ts");
    store.renameWorkspace(T, "desk", "desk2");
    assert.equal(pgSyncOne("SELECT legacy FROM records_routing WHERE tenant = $1 AND workspace = 'desk2'", [T]).rows[0]?.legacy, true);
    await importRecordsFiles();
    assert.equal(await routeRow("desk2"), "database");
    assert.equal(pgSyncOne("SELECT workspace FROM run_records WHERE tenant = $1 AND run_id = 'run-row'", [T]).rows[0]?.workspace, "desk2", "kept, under its new name");
  });

  test("a process kept busy in record calls acknowledges every time it re-reads the routing, so the barrier never stops waiting for it while it may write files (Codex review)", async () => {
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    const { startRoutingWatch, stopRoutingWatch, routingBeat, routingPod, routeOf } = await import("../src/records-routing.ts");
    startRoutingWatch();
    try {
      await routingBeat();
      // Its last beat long ago, as if its event loop had been busy since.
      pgSyncOne("UPDATE records_routing_pods SET beat_at = now() - interval '1 hour', gen = -1 WHERE pod = $1", [routingPod()]);
      process.env.FOLDRUN_RECORDS_ROUTING_LEASE_MS = "20";
      const pause = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(pause, 0, 0, 40); // the lease runs out with the thread never yielding
      assert.equal(routeOf(T, "desk"), "files", "re-read synchronously");
      const row = pgSyncOne("SELECT gen, beat_at > now() - interval '5 seconds' AS fresh FROM records_routing_pods WHERE pod = $1", [routingPod()]).rows[0];
      assert.equal(row.fresh, true, "and acknowledged in the same breath");
      assert.ok(Number(row.gen) >= 0);
    } finally {
      delete process.env.FOLDRUN_RECORDS_ROUTING_LEASE_MS;
      await stopRoutingWatch();
    }
  });

  test("a process whose acknowledgements fail does not renew its lease, though it can still read the routing (Codex review)", async () => {
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    const { startRoutingWatch, stopRoutingWatch, routingBeat, routingPod, routeOf, resetRoutingForTest, RoutingUnavailable } = await import("../src/records-routing.ts");
    startRoutingWatch();
    pgSyncOne(`ALTER TABLE records_routing_pods ADD CONSTRAINT test_no_acks CHECK (pod <> '${routingPod()}') NOT VALID`);
    try {
      resetRoutingForTest();
      await routingBeat(); // reads, fails to acknowledge
      process.env.FOLDRUN_RECORDS_ROUTING_LEASE_MS = "60000";
      assert.throws(() => routeOf(T, "desk"), RoutingUnavailable, "no lease came of an unacknowledged read");
    } finally {
      pgSyncOne("ALTER TABLE records_routing_pods DROP CONSTRAINT test_no_acks");
      delete process.env.FOLDRUN_RECORDS_ROUTING_LEASE_MS;
      await stopRoutingWatch();
      resetRoutingForTest();
    }
  });

  test("an acknowledgement held up by a hold renews no lease on the routing read before it (Codex review)", async () => {
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    const r = await import("../src/records-routing.ts");
    process.env.FOLDRUN_RECORDS_ROUTING_BEAT_MS = "600000"; // beats by hand only
    pgSyncOne("INSERT INTO records_routing (tenant, workspace, state, gen) VALUES ('*', '*', 'files', 1)");
    r.startRoutingWatch();
    const { Client } = await import("pg");
    const { connectionConfig } = await import("../src/db.ts");
    const hold = new Client(connectionConfig());
    await hold.connect();
    try {
      await r.routingBeat();
      assert.equal(r.routingLeaseFreshForTest(), true);
      r.invalidateRouting();
      // A hold, as the import makes one: acknowledgements locked out, a new generation.
      await hold.query("BEGIN");
      await hold.query("LOCK TABLE records_routing_pods IN SHARE MODE");
      await hold.query("UPDATE records_routing SET gen = gen + 1 WHERE tenant = '*' AND workspace = '*'");
      const beat = r.routingBeat(); // reads the old generation, then waits to acknowledge it
      await new Promise((res) => setTimeout(res, 150));
      await hold.query("COMMIT");
      await beat;
      assert.equal(r.routingLeaseFreshForTest(), false, "its read predates the hold: no lease came of it");
      await r.routingBeat();
      assert.equal(r.routingLeaseFreshForTest(), true, "the next beat reads the hold and renews");
    } finally {
      await hold.end();
      delete process.env.FOLDRUN_RECORDS_ROUTING_BEAT_MS;
      await r.stopRoutingWatch();
      r.resetRoutingForTest();
    }
  });

  test("an account that cannot be listed leaves the routing unseeded, and no move starts (Codex review)", async () => {
    const wsRoot = path.join(root, T, "workspaces");
    fs.chmodSync(wsRoot, 0o000);
    const { importRecordsFiles } = await import("../src/records-import.ts");
    try {
      const r = await importRecordsFiles();
      assert.equal(r.counts, null);
      assert.equal(await defaultRow(), null, "not marked seeded, not marked begun");
    } finally {
      fs.chmodSync(wsRoot, 0o755);
    }
    assert.ok(fs.existsSync(path.join(ws("desk"), "runs", "run-a.json")), "nothing moved");
    assert.deepEqual((await importRecordsFiles()).onFiles, [], "once it can be listed, it moves");
  });

  test("a run folder that cannot be listed fails its workspace's move — it is never read as 'every run was deleted' (Codex review)", async () => {
    const { importRecordsFiles } = await import("../src/records-import.ts");
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    const runs = path.join(ws("desk"), "runs");
    await fakePod("files-mode-pod", 0);
    // Readable for the copy; unreadable by the settle (a volume error in between).
    const other = (async () => {
      for (let i = 0; i < 100; i++) {
        if (pgSyncOne("SELECT 1 FROM records_routing WHERE tenant = $1 AND workspace = 'desk' AND state = 'moving'", [T]).rows.length) break;
        await new Promise((res) => setTimeout(res, 20));
      }
      fs.chmodSync(runs, 0o000);
      await fakePod("files-mode-pod", await currentGen());
    })();
    try {
      const r = await importRecordsFiles();
      await other;
      assert.ok(r.onFiles.some((w) => w.workspace === "desk"), "desk stays on files");
      assert.equal(await routeRow("desk"), "files");
      assert.equal(await count("run_records"), 3, "the rows the copy made are all still there");
    } finally {
      fs.chmodSync(runs, 0o755);
    }
    await fakePod("files-mode-pod", 0, "10 minutes"); // gone since
    assert.deepEqual((await importRecordsFiles()).onFiles, []);
  });

  test("a move that overruns its budget is not flipped: the database's clock at the flip decides, and the files stand (Codex review)", async () => {
    const { withFileLock } = await import("../../foldrun-core/src/storage.ts");
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    const { importRecordsFiles } = await import("../src/records-import.ts");
    process.env.FOLDRUN_RECORDS_SETTLE_MS = "300";
    process.env.FOLDRUN_RECORDS_ACK_WAIT_MS = "200";
    // An upload holding desk's storage lock: the settle waits for it, past the budget.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const lock = withFileLock(path.join(root, T, "storage", ".desk.lock"), () => held);
    const other = (async () => {
      for (let i = 0; i < 200; i++) {
        if (pgSyncOne("SELECT 1 FROM records_routing WHERE tenant = $1 AND workspace = 'desk' AND state = 'moving'", [T]).rows.length) break;
        await new Promise((res) => setTimeout(res, 10));
      }
      await new Promise((res) => setTimeout(res, 900));
      release();
    })();
    try {
      const r = await importRecordsFiles();
      await other;
      await lock;
      assert.deepEqual(r.onFiles, [{ tenant: T, workspace: "desk" }]);
      assert.equal(await routeRow("desk"), "files");
      assert.ok(fs.existsSync(path.join(ws("desk"), "runs", "run-a.json")), "nothing set aside");
    } finally {
      release();
      process.env.FOLDRUN_RECORDS_ACK_WAIT_MS = "1500";
      delete process.env.FOLDRUN_RECORDS_SETTLE_MS;
    }
    assert.deepEqual((await importRecordsFiles()).onFiles, [], "the next one, in time, moves it");
  });

  test("a process whose routing is too old and cannot be read again refuses record calls instead of trusting 'files' (FOL-152)", async () => {
    const { routeOf, resetRoutingForTest, RoutingUnavailable } = await import("../src/records-routing.ts");
    const { wedgeForTest, pgSyncOne } = await import("../src/pg-sync.ts");
    pgSyncOne("SELECT 1");
    resetRoutingForTest();
    wedgeForTest(5000);
    assert.throws(() => routeOf(T, "desk"), RoutingUnavailable);
    assert.throws(() => routeOf(T, "desk"), RoutingUnavailable, "fails fast right after");
  });
}
