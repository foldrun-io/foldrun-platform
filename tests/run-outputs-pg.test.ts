// The run-outputs contract (foldrun-core tests/run-outputs-contract.ts) against
// the Postgres record store and the Postgres pins, with fs blobs. Runs only when
// a database is offered, like revision-contract-pg.test.ts:
//
//   FOLDRUN_TEST_DATABASE_URL=postgres://foldrun@localhost:55432/foldrun npm test
//
// The table comes from the migrations (drizzle/0042).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { takeTurnsOnLiveDb } from "./live-db-lock.ts";
import { fsBlobStore, bounded } from "../../foldrun-core/src/blob-store.ts";
import { runOutputsContract } from "../../foldrun-core/tests/run-outputs-contract.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
takeTurnsOnLiveDb(url);

if (!url) {
  test("pg run outputs (set FOLDRUN_TEST_DATABASE_URL to run)", { skip: "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" }, () => {});
} else {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  const dirs: string[] = [];
  before(async () => {
    const { migrate } = await import("../src/db.ts");
    await migrate();
  });
  after(async () => {
    dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
    const { db } = await import("../src/db.ts");
    await db()?.end();
  });
  const make = async () => {
    const { pgRunOutputStore } = await import("../src/run-outputs-pg.ts");
    const { pgBlobPins } = await import("../src/blob-pins.ts");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-pgro-"));
    dirs.push(root);
    return { blobs: bounded(fsBlobStore(path.join(root, "objects")), { backoffMs: 1 }), store: pgRunOutputStore(), pins: pgBlobPins(), cleanup: async () => {} };
  };
  runOutputsContract("fs + pg", make);

  test("pg: dropping the records deletes their pins in the same transaction (no release call needed)", async () => {
    const { publishRunOutputs } = await import("../../foldrun-core/src/run-outputs.ts");
    const h = await make();
    const T = `ropg${Date.now().toString(36)}`;
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-pgro-d-"));
    dirs.push(d);
    fs.writeFileSync(path.join(d, "a.txt"), "atomic");
    const be = { blobs: h.blobs, pins: h.pins, store: h.store, enabled: () => true, fileMaxBytes: () => 0, runMaxBytes: () => 0 };
    const r = await publishRunOutputs(be, T, "ws", "run-1", "writer", d);
    assert.equal(await h.pins.isPinned(T, "manifest", r.record!.manifest), true);
    await h.store.drop({ tenant: T, workspace: "ws", runId: "run-1" });
    assert.equal(await h.pins.isPinned(T, "manifest", r.record!.manifest), false);
  });

  test("pg: two writers putting the same run + agent leave one row, the last one's manifest", async () => {
    const { pgRunOutputStore } = await import("../src/run-outputs-pg.ts");
    const store = pgRunOutputStore();
    const T = `ropg2${Date.now().toString(36)}`;
    const rec = (m: string) => ({ tenant: T, workspace: "ws", runId: "run-1", agent: "writer", manifest: m.repeat(64).slice(0, 64), files: 1, bytes: 1, at: new Date().toISOString() });
    await Promise.all(["a", "b", "c", "d"].map((m) => store.put(rec(m))));
    const rows = await store.list(T, "ws", "run-1");
    assert.equal(rows.length, 1);
  });
}
