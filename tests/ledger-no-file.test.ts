// With a database the ledger table is the ledger: ledger.jsonl is not written
// or read, the once-only markers are not made, and an old file is imported once
// and set aside (FOL-126 phase 2). DB-gated.
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { takeTurnsOnLiveDb } from "./live-db-lock.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
takeTurnsOnLiveDb(url);

if (!url) {
  test("ledger without a file (set FOLDRUN_TEST_DATABASE_URL to run)", { skip: "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" }, () => {});
} else {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  let root: string;
  let T: string;
  const day = new Date().toISOString().slice(0, 10);

  before(async () => {
    const { migrate } = await import("../src/db.ts");
    await migrate();
  });
  after(async () => {
    const { db } = await import("../src/db.ts");
    await db()?.end();
  });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-ledger-"));
    process.env.FOLDRUN_DATA = root;
    T = `led${Date.now()}${Math.floor(Math.random() * 1e4)}`;
    fs.mkdirSync(path.join(root, T), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.FOLDRUN_DATA;
  });

  test("appending writes the table and no file; reading comes from the table; once-only holds without markers", async () => {
    const l = await import("../src/ledger.ts");
    assert.equal(await l.append(T, { t: "2026-11-01T00:00:00.000Z", kind: "grant", usd: 10, note: "plan", key: "grant:one" }), true);
    assert.equal(await l.append(T, { t: "2026-11-01T00:00:01.000Z", kind: "grant", usd: 10, note: "plan", key: "grant:one" }), false, "the key index refuses the second");
    assert.equal(await l.appendAll(T, [{ t: "2026-11-01T00:00:02.000Z", kind: "grant", usd: 1, note: "a", key: "grant:two" }]), true);
    assert.equal(await l.appendAll(T, [{ t: "2026-11-01T00:00:03.000Z", kind: "grant", usd: 1, note: "b", key: "grant:one" }]), false);
    l.appendLedgerFile(T, [{ t: "2026-11-01T00:00:04.000Z", kind: "grant", usd: 1, note: "mirror" }]);
    assert.deepEqual((await l.readLedger(T)).map((e) => e.key), ["grant:one", "grant:two"]);
    assert.equal(fs.existsSync(path.join(root, T, "ledger.jsonl")), false, "no ledger.jsonl");
    assert.equal(l.claimOnce(T, "k"), true);
    assert.equal(l.claimOnce(T, "k"), true, "a marker would only disagree with another pod's: the index decides");
    assert.equal(fs.existsSync(path.join(root, T, "once")), false, "no once/ marker");
    assert.equal(await l.claimKeyed(T, "k"), true);
  });

  test("a run is charged once without a billed/ or once/ marker", async () => {
    const l = await import("../src/ledger.ts");
    const entry = { t: "2026-11-01T00:00:00.000Z", kind: "run" as const, usd: -0.5, cost: 0.5, runId: "run-1", workspace: "desk" };
    assert.equal(await l.append(T, entry), true);
    assert.equal(await l.append(T, { ...entry, t: "2026-11-01T00:00:09.000Z" }), false);
    assert.equal((await l.readLedger(T)).filter((e) => e.runId === "run-1").length, 1);
    assert.equal(fs.existsSync(path.join(root, T, "once")), false);
    assert.equal(fs.existsSync(path.join(root, T, "billed")), false);
  });

  test("an old file is imported once: its lines land, it and the markers are set aside, a second boot does nothing", async () => {
    const l = await import("../src/ledger.ts");
    const lines = [
      { t: "2026-09-01T00:00:00.000Z", kind: "topup", usd: 20, note: "first" },
      { t: "2026-09-02T00:00:00.000Z", kind: "run", usd: -1, cost: 1, runId: "run-old", workspace: "desk" },
    ];
    fs.writeFileSync(path.join(root, T, "ledger.jsonl"), lines.map((e) => JSON.stringify(e)).join("\n") + "\n{torn");
    fs.mkdirSync(path.join(root, T, "once"));
    fs.writeFileSync(path.join(root, T, "once", "abc"), "run:run-old");
    fs.mkdirSync(path.join(root, T, "billed"));
    fs.writeFileSync(path.join(root, T, "billed", "run-old"), "");
    assert.equal(await l.importLedgerToDatabase(T), 2);
    assert.equal((await l.readLedger(T)).length, 2);
    assert.equal(fs.existsSync(path.join(root, T, "ledger.jsonl")), false);
    assert.ok(fs.existsSync(path.join(root, T, `ledger.jsonl.imported-${day}`)));
    assert.ok(fs.existsSync(path.join(root, T, `once.imported-${day}`, "abc")));
    assert.ok(fs.existsSync(path.join(root, T, `billed.imported-${day}`, "run-old")));
    assert.equal(await l.importLedgerToDatabase(T), 0);
    // The old run's charge is not taken again: its row is in the table.
    assert.equal(await l.append(T, { t: "2026-11-01T00:00:00.000Z", kind: "run", usd: -1, cost: 1, runId: "run-old", workspace: "desk" }), false);
  });

  test("two boots importing at once leave one copy of each line", async () => {
    const l = await import("../src/ledger.ts");
    fs.writeFileSync(path.join(root, T, "ledger.jsonl"), JSON.stringify({ t: "2026-09-01T00:00:00.000Z", kind: "topup", usd: 5, note: "x" }) + "\n");
    await Promise.all([l.importLedgerToDatabase(T), l.importLedgerToDatabase(T)]);
    assert.equal((await l.readLedger(T)).length, 1);
    assert.ok(fs.existsSync(path.join(root, T, `ledger.jsonl.imported-${day}`)));
  });
}
