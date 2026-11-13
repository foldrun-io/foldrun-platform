// Retiring the file mirror (FOL-126 phase 6) on Postgres: the fleet check that
// says every scope moved and opens, the import of scopes nobody used, the
// mirror switch, the way back (export), and the guard that keeps the rows
// serving while the files are stale. DB-gated:
//   FOLDRUN_TEST_DATABASE_URL=postgres://… npm test

import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { takeTurnsOnLiveDb } from "./live-db-lock.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
takeTurnsOnLiveDb(url);

if (!url) {
  test("vault fleet on Postgres (set FOLDRUN_TEST_DATABASE_URL to run)", { skip: "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" }, () => {});
} else {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  const C = (n: string) => `canary-fleet-${n}-4b7e90c1d2`;

  let root: string;
  let T: string;
  let n = 0;
  let mirror = true;
  let serving = true;
  const fileOf = (ws?: string) => (ws ? path.join(root, T, "workspaces", ws, "secrets.json") : path.join(root, T, "secrets.json"));
  const mods = async () => ({
    s: await import("../../foldrun-core/src/secrets.ts"),
    fleet: await import("../src/vault-fleet.ts"),
    pgv: await import("../src/vault-pg.ts"),
    pg: await import("../src/pg-sync.ts"),
  });

  before(async () => {
    const { migrate } = await import("../src/db.ts");
    await migrate();
  });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-vault-fleet-"));
    process.env.FOLDRUN_DATA = root;
    process.env.FOLDRUN_SECRET_KEY = "fleet-install-key";
    process.env.FOLDRUN_VAULT_WRITE_BOUND = "1";
    T = `fl${Date.now().toString(36)}${n++}`;
    mirror = true;
    serving = true;
  });
  afterEach(async () => {
    const { s, pg } = await mods();
    s.setVaultStore(null);
    pg.pgSyncOne("DELETE FROM vault_scopes WHERE tenant = $1", [T]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  after(async () => {
    const { closePgSync } = await import("../src/pg-sync.ts");
    await closePgSync();
    const { db } = await import("../src/db.ts");
    await db()?.end();
  });

  const useStore = async () => {
    const { s, pgv } = await mods();
    const store = pgv.pgVaultStore(() => serving, () => mirror);
    s.setVaultStore(store);
    return store;
  };
  /** Files first (no store), as an install before the switch has them. */
  const seedFiles = async () => {
    const { s } = await mods();
    s.setSecret(T, "ACC_KEY", C("acc"));
    s.setSecret(T, "DESK_KEY", C("desk"), "desk");
    s.setSecret(T, "LAB_KEY", C("lab"), "lab");
    s.setOAuth2Secret(T, "OA_KEY", { token_url: "https://idp.example.com/token", client_id: "cid", refresh_token: C("rt") });
  };

  test("verify names what is only a file, what is only a row, what differs and what does not open — never a value", async () => {
    const { s, fleet, pg } = await mods();
    await seedFiles();
    await useStore();
    // used since the switch: moved. `lab` never used: still only a file.
    assert.equal(s.getSecret(T, "ACC_KEY")?.value, C("acc"));
    assert.equal(s.getSecret(T, "DESK_KEY", "desk")?.value, C("desk"));
    let r = fleet.verifyFleet({ tenants: [T], open: true });
    assert.deepEqual([r.equal, r.fileOnly, r.rowOnly, r.differs, r.unreadable, r.clean], [2, [`${T}/lab`], [], [], [], false]);
    // the file moves on behind the row (an older pod): differs
    const rec = JSON.parse(fs.readFileSync(fileOf("desk"), "utf8"));
    fs.writeFileSync(fileOf("desk"), JSON.stringify({ ...rec, DESK_KEY: { ...rec.DESK_KEY, updatedAt: "2020-01-01T00:00:00.000Z" } }));
    // a row that will not open: its ciphertext damaged
    pg.pgSyncOne(`UPDATE vault_scopes SET records = jsonb_set(records, '{ACC_KEY,tag}', '"AAAAAAAAAAAAAAAAAAAAAA=="') WHERE tenant = $1 AND workspace = ''`, [T]);
    r = fleet.verifyFleet({ tenants: [T], open: true });
    assert.deepEqual(r.differs, [`${T}/(account)`, `${T}/desk`], "the file moved on / the row was damaged");
    assert.deepEqual(r.unreadable, [`${T}/(account)/ACC_KEY`], "the damaged record is named");
    assert.equal(r.clean, false);
    const report = JSON.stringify(r);
    for (const v of ["acc", "desk", "lab", "rt"].map(C)) assert.ok(!report.includes(v), "no value in a report");
    // without --open nothing is opened
    assert.deepEqual(fleet.verifyFleet({ tenants: [T] }).unreadable, []);
  });

  test("import moves every file-only scope, replaces no row, and can be run again", async () => {
    const { s, fleet, pg } = await mods();
    await seedFiles();
    await useStore();
    s.getSecret(T, "ACC_KEY"); // moved
    // the row is newer than the file: the file must not win
    s.setSecret(T, "ACC_KEY", C("acc-newer"));
    const stale = JSON.parse(fs.readFileSync(fileOf(), "utf8"));
    fs.writeFileSync(fileOf(), JSON.stringify({ ...stale, ACC_KEY: { ...stale.ACC_KEY, updatedAt: "2019-01-01T00:00:00.000Z" } }));
    let r = fleet.importFileOnly({ tenants: [T] });
    assert.deepEqual(r.imported.sort(), [`${T}/desk`, `${T}/lab`]);
    assert.deepEqual(r.failed, []);
    assert.equal(s.getSecret(T, "ACC_KEY")?.value, C("acc-newer"), "an existing row is never replaced by a file");
    assert.equal(s.getSecret(T, "LAB_KEY", "lab")?.value, C("lab"));
    assert.deepEqual(fleet.importFileOnly({ tenants: [T] }), { imported: [], failed: [] }, "nothing left to import");
    assert.equal(pg.pgSyncOne(`SELECT count(*)::int AS n FROM vault_scopes WHERE tenant = $1`, [T]).rows[0].n, 3);
    r = fleet.importFileOnly({ tenants: [T] });
    assert.deepEqual(r, { imported: [], failed: [] });
  });

  test("with the mirror off a commit writes the row and leaves the file alone; verify then expects differing files", async () => {
    const { s, fleet } = await mods();
    await seedFiles();
    await useStore();
    fleet.importFileOnly({ tenants: [T] });
    assert.equal(fleet.verifyFleet({ tenants: [T], open: true }).clean, true, "everything moved and equal: the gate before the mirror goes off");
    const before = fs.readFileSync(fileOf(), "utf8");
    mirror = false;
    s.setSecret(T, "NEW_KEY", C("new"));
    s.deleteSecret(T, "ACC_KEY");
    assert.equal(fs.readFileSync(fileOf(), "utf8"), before, "the file is not written");
    assert.ok(!fs.existsSync(fileOf("fresh")));
    s.setSecret(T, "FRESH_KEY", C("fresh"), "fresh");
    assert.ok(!fs.existsSync(fileOf("fresh")), "a scope created now has a row and no file");
    assert.equal(s.getSecret(T, "NEW_KEY")?.value, C("new"));
    assert.equal(s.getSecret(T, "ACC_KEY"), null);
    const strict = fleet.verifyFleet({ tenants: [T] });
    assert.equal(strict.clean, false);
    assert.deepEqual(strict.differs, [`${T}/(account)`]);
    assert.deepEqual(strict.rowOnly, [`${T}/fresh`]);
    const rows = fleet.verifyFleet({ tenants: [T], open: true, rowsAuthoritative: true });
    assert.equal(rows.clean, true, "stale files are expected once the rows are the record");
    // …but a file that never reached a row is not
    fs.mkdirSync(path.join(root, T, "workspaces", "orphan"), { recursive: true });
    fs.writeFileSync(fileOf("orphan"), JSON.stringify({ X_KEY: JSON.parse(before).ACC_KEY }));
    assert.deepEqual(fleet.verifyFleet({ tenants: [T], rowsAuthoritative: true }).fileOnly, [`${T}/orphan`]);
  });

  test("export is the way back: every row written into its file, then verify is clean and the files read current secrets", async () => {
    const { s, fleet } = await mods();
    await seedFiles();
    await useStore();
    fleet.importFileOnly({ tenants: [T] });
    mirror = false;
    s.setSecret(T, "NEW_KEY", C("new"));
    s.setSecret(T, "DESK_KEY", C("desk-2"), "desk");
    fs.mkdirSync(path.join(root, T, "workspaces", "fresh"), { recursive: true }); // a workspace made after the mirror went off
    s.setSecret(T, "FRESH_KEY", C("fresh"), "fresh");
    fs.rmSync(path.join(root, T, "workspaces", "lab"), { recursive: true }); // a workspace whose folder is gone
    const r = fleet.exportFleet({ tenants: [T] });
    assert.deepEqual(r, { written: 3, skipped: [`${T}/lab`], failed: [] }, "account, desk and fresh written; lab has no folder to write into");
    assert.ok(!fs.existsSync(path.dirname(fileOf("lab"))), "no folder brought back");
    mirror = true;
    assert.deepEqual(fleet.verifyFleet({ tenants: [T] }).differs, []);
    assert.deepEqual(fleet.verifyFleet({ tenants: [T] }).rowOnly, [`${T}/lab`], "the one the folder was gone for is still only a row, and said so");
    // the files alone now say what the rows say
    s.setVaultStore(null);
    assert.equal(s.getSecret(T, "NEW_KEY")?.value, C("new"));
    assert.equal(s.getSecret(T, "DESK_KEY", "desk")?.value, C("desk-2"));
    assert.equal(s.getSecret(T, "FRESH_KEY", "fresh")?.value, C("fresh"));
  });

  test("secrets.store off with the mirror off keeps the rows serving; with the mirror on, or no rows, it does not", async () => {
    const { s, fleet, pg } = await mods();
    await seedFiles();
    const store = await useStore();
    fleet.importFileOnly({ tenants: [T] });
    mirror = false;
    s.setSecret(T, "ONLY_ROW", C("only-row"));
    serving = false;
    assert.equal(store.on(T), true, "off + mirror off + rows: the rows still serve");
    assert.equal(s.getSecret(T, "ONLY_ROW")?.value, C("only-row"), "a read is not sent back to a stale file");
    s.setSecret(T, "LATER_KEY", C("later"));
    assert.equal(s.getSecret(T, "LATER_KEY")?.value, C("later"));
    assert.ok(!JSON.parse(fs.readFileSync(fileOf(), "utf8")).LATER_KEY, "and not written to one");
    // mirror back on: the guard lets go (the operator exported first)
    mirror = true;
    const store2 = await useStore();
    assert.equal(store2.on(T), false);
    // no rows at all and the mirror off: nothing for the files to be staler than
    pg.pgSyncOne("DELETE FROM vault_scopes");
    mirror = false;
    const store3 = await useStore();
    assert.equal(store3.on(T), false);
  });
}
