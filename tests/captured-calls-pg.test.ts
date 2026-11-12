// Captured calls on the real tables (FOL-126 phase 7, step 2): the row in run_step_state, the pin in
// blob_pins, the sweeper keeping and then collecting the blob, and the run / workspace / account going.
// DB-gated.
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { takeTurnsOnLiveDb } from "./live-db-lock.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
takeTurnsOnLiveDb(url);

if (!url) {
  test("captured calls on Postgres (set FOLDRUN_TEST_DATABASE_URL to run)", { skip: "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" }, () => {});
} else {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  const T = `cal${Date.now().toString(36)}`;
  let root: string;
  let n = 0;
  let W: string;
  let on = true;
  type M = {
    sweeper: typeof import("../../foldrun-core/src/blob-sweeper.ts");
    blob: typeof import("../../foldrun-core/src/blob-store.ts");
    manifest: typeof import("../../foldrun-core/src/manifest.ts");
    wr: typeof import("../../foldrun-core/src/workspace-revisions.ts");
    store: typeof import("../../foldrun-core/src/store.ts");
    calls: typeof import("../../foldrun-core/src/captured-calls.ts");
    capture: typeof import("../../foldrun-core/src/capture.ts");
    platform: typeof import("../../foldrun-core/src/platform.ts");
    rev: typeof import("../src/revision-store-pg.ts");
    pins: typeof import("../src/blob-pins.ts");
    marks: typeof import("../src/sweep-marks-pg.ts");
    recs: typeof import("../src/records-pg.ts");
    db: typeof import("../src/db.ts");
  };
  let m: M;
  before(async () => {
    m = {
      sweeper: await import("../../foldrun-core/src/blob-sweeper.ts"),
      blob: await import("../../foldrun-core/src/blob-store.ts"),
      manifest: await import("../../foldrun-core/src/manifest.ts"),
      wr: await import("../../foldrun-core/src/workspace-revisions.ts"),
      store: await import("../../foldrun-core/src/store.ts"),
      calls: await import("../../foldrun-core/src/captured-calls.ts"),
      capture: await import("../../foldrun-core/src/capture.ts"),
      platform: await import("../../foldrun-core/src/platform.ts"),
      rev: await import("../src/revision-store-pg.ts"),
      pins: await import("../src/blob-pins.ts"),
      marks: await import("../src/sweep-marks-pg.ts"),
      recs: await import("../src/records-pg.ts"),
      db: await import("../src/db.ts"),
    };
    await m.db.migrate();
  });
  after(async () => {
    const { closePgSync } = await import("../src/pg-sync.ts");
    await m.recs.closeRecordsReads();
    await closePgSync();
    await m.db.db()?.end();
  });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-calpg-"));
    process.env.FOLDRUN_DATA = root;
    W = `desk${++n}`;
    on = true;
    fs.mkdirSync(path.join(m.store.workspaceDir(T, W), "runs"), { recursive: true });
    fs.writeFileSync(path.join(m.store.workspaceDir(T, W), "AGENTS.md"), `---\nname: ${W}\n---\n`);
    m.platform.registerPlatform({ records: m.recs.pgRecords({ routed: false, stepStateOn: () => true, callsStoreOn: () => on }) });
    m.wr.setRevisionBackend(deps(), { journal: () => false, read: () => false });
  });
  afterEach(async () => {
    await m.wr.settleLifecycle();
    m.wr.setRevisionBackend(null);
    m.wr.resetJournalForTests();
    m.platform.resetPlatform();
    await m.rev.pgRevisionStore().drop({ tenant: T });
    await m.db.db()!.query(`DELETE FROM run_step_state WHERE tenant=$1`, [T]);
    await m.db.db()!.query(`DELETE FROM run_records WHERE tenant=$1`, [T]);
    await m.db.db()!.query(`DELETE FROM blob_sweep_marks WHERE tenant=$1`, [T]);
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.FOLDRUN_DATA;
  });

  const blobs = () => m.blob.fsBlobStore(path.join(root, ".objects"));
  const deps = () => ({ blobs: blobs(), revisions: m.rev.pgRevisionStore(), pins: m.pins.pgBlobPins() });
  const ws = () => m.store.workspaceDir(T, W);
  const pinCount = async (holder?: string) =>
    Number((await m.db.db()!.query(`SELECT count(*) FROM blob_pins WHERE tenant=$1 AND holder_kind='run' ${holder ? "AND holder_id=$2" : ""}`, holder ? [T, holder] : [T])).rows[0].count);
  const rowCount = async (run?: string) => Number((await m.db.db()!.query(`SELECT count(*) FROM run_step_state WHERE tenant=$1 AND kind='call' ${run ? "AND run_id=$2" : ""}`, run ? [T, run] : [T])).rows[0].count);
  const record = (id: string) => ({ id, flow: "adhoc:writer", status: "completed", startedAt: new Date().toISOString(), steps: [] }) as never;
  async function call(runId: string, id: string, input: string, output: string) {
    const port = m.recs.pgRecords({ routed: false });
    port.runPut(T, W, record(runId), { id: runId } as never, false);
    const step = {};
    m.capture.recordCallIo(ws(), runId, id, "Bash", { input, output }, (s) => s, m.calls.callSink(step, { tenant: T, workspace: W, runId, workspaceRoot: ws() }));
    await m.calls.flushCalls(step);
  }
  const tick = () => new Promise((r) => setTimeout(r, 15));
  const opts = () => ({ dryRun: false, delayMs: 0, minAgeMs: 0, maxDeletes: 1000, tenants: [T], allowEmpty: true });

  test("a call is a row, a pin and a blob; nothing is written under the run", async () => {
    await call("run-1", "c1", "ls", "a.txt");
    assert.equal(await rowCount("run-1"), 1);
    assert.equal(await pinCount("calls:run-1"), 1);
    assert.equal(fs.existsSync(path.join(ws(), "runs", "run-1")), false);
    assert.equal((await m.calls.readCapturedCallAsync(T, W, "run-1", "c1"))!.output, "a.txt");
  });

  test("the sweeper keeps a pinned call's blob, and collects it once its run is deleted", async () => {
    await call("run-1", "c1", "ls", "a.txt");
    const d = deps();
    const marks = m.marks.pgSweepMarks();
    const key = (await d.pins.live(T)).blobs[0]!;
    await m.sweeper.sweepBlobs(d, marks, opts());
    await tick();
    await m.sweeper.sweepBlobs(d, marks, opts());
    assert.ok(await d.blobs.head(m.manifest.blobObjectKey(T, key)), "kept while the run exists");
    assert.ok(m.store.deleteRun(T, W, "run-1"));
    await m.wr.settleLifecycle();
    assert.equal(await pinCount(), 0);
    await m.sweeper.sweepBlobs(d, marks, opts());
    await tick();
    await m.sweeper.sweepBlobs(d, marks, opts());
    assert.equal(await d.blobs.head(m.manifest.blobObjectKey(T, key)), null, "collected after");
  });

  test("two runs with the same call share the blob: deleting one keeps it for the other", async () => {
    await call("run-1", "c1", "ls", "a.txt");
    await call("run-2", "c1", "ls", "a.txt");
    assert.equal(await pinCount(), 2);
    m.store.deleteRun(T, W, "run-1");
    await m.wr.settleLifecycle();
    const d = deps();
    const marks = m.marks.pgSweepMarks();
    await m.sweeper.sweepBlobs(d, marks, opts());
    await tick();
    await m.sweeper.sweepBlobs(d, marks, opts());
    assert.equal((await m.calls.readCapturedCallAsync(T, W, "run-2", "c1"))!.output, "a.txt");
  });

  test("deleting a workspace releases the pins and the rows; a workspace of the same name starts clean", async () => {
    await call("run-1", "c1", "ls", "a.txt");
    await call("run-1", "c2", "pwd", "/w");
    await m.store.deleteWorkspaceAsync(T, W);
    assert.equal(await pinCount(), 0);
    assert.equal(await rowCount(), 0);
  });

  test("deleting the account removes every pin and row", async () => {
    await call("run-1", "c1", "ls", "a.txt");
    await m.wr.dropTenantRevisions(T);
    await m.recs.deleteTenantRecords(T);
    assert.equal(await pinCount(), 0);
    assert.equal(await rowCount(), 0);
  });

  test("switched off: the volume; the stored call is still read", async () => {
    await call("run-1", "c1", "ls", "a.txt");
    on = false;
    await call("run-2", "c2", "pwd", "/w");
    assert.ok(fs.existsSync(path.join(ws(), "runs", "run-2", "calls", "c2.json")));
    assert.equal(await rowCount("run-2"), 0);
    assert.equal((await m.calls.readCapturedCallAsync(T, W, "run-1", "c1"))!.output, "a.txt");
    assert.equal((await m.calls.readCapturedCallAsync(T, W, "run-2", "c2"))!.output, "/w");
  });
}
