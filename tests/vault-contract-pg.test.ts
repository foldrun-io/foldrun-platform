// The vault contract (foldrun-core tests/vault-contract.ts) against the
// Postgres store (src/vault-pg.ts), plus what only a shared database can
// show: the import from a file, two writers at once, the file kept current,
// and switching off and on again. Runs only when a database is offered:
//
//   FOLDRUN_TEST_DATABASE_URL=postgres://foldrun@localhost:55432/foldrun npm test

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { takeTurnsOnLiveDb } from "./live-db-lock.ts";
import { vaultContract } from "../../foldrun-core/tests/vault-contract.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
takeTurnsOnLiveDb(url);

if (!url) {
  test("pg vault (set FOLDRUN_TEST_DATABASE_URL to run)", { skip: "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" }, () => {});
} else {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
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
  const store = async (on: () => boolean = () => true) => (await import("../src/vault-pg.ts")).pgVaultStore(on);
  // This store keeps each scope's file current on purpose (mirrors).
  vaultContract("pg", () => store(), { mirrors: true });

  const fresh = async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-vault-pg-"));
    process.env.FOLDRUN_DATA = data;
    process.env.FOLDRUN_SECRET_KEY = "contract-install-key";
    const s = await import("../../foldrun-core/src/secrets.ts");
    const T = `vpg${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    return { data, s, T };
  };

  test("pg vault: a scope is imported from its file the first time it is used, once, and the file then follows the row", async () => {
    const { data, s, T } = await fresh();
    try {
      s.setSecret(T, "OLD_KEY", "from-the-file");
      s.setSecret(T, "WS_KEY", "desk-file", "desk");
      const st = await store();
      s.setVaultStore(st);
      assert.equal(s.getSecret(T, "OLD_KEY")?.value, "from-the-file", "imported, same sealed record");
      assert.equal(s.getSecret(T, "WS_KEY", "desk")?.value, "desk-file");
      assert.deepEqual(st.workspaces(T), ["desk"]);
      // The file changes behind the store's back (an older pod): not read again.
      s.setVaultStore(null);
      s.setSecret(T, "OLD_KEY", "late-file-write");
      s.setVaultStore(st);
      assert.equal(s.getSecret(T, "OLD_KEY")?.value, "from-the-file", "one place: the row");
      // A write through the store lands in the row AND the file.
      s.setSecret(T, "NEW_KEY", "new");
      const onDisk = JSON.parse(fs.readFileSync(path.join(data, T, "secrets.json"), "utf8"));
      assert.deepEqual(Object.keys(onDisk).sort(), ["NEW_KEY", "OLD_KEY"]);
      assert.ok(!JSON.stringify(onDisk).includes("\"new\""), "still sealed on disk");
      s.setVaultStore(null);
      assert.equal(s.getSecret(T, "NEW_KEY")?.value, "new", "switched off: the file is current");
    } finally {
      s.setVaultStore(null);
      fs.rmSync(data, { recursive: true, force: true });
    }
  });

  test("pg vault: switched off, a file write drops the row; switched on again, the file as it is then is imported", async () => {
    const { data, s, T } = await fresh();
    let on = true;
    try {
      const st = await store(() => on);
      s.setVaultStore(st);
      s.setSecret(T, "API_KEY", "v1");
      on = false;
      s.setSecret(T, "API_KEY", "v2-on-file");
      on = true;
      assert.equal(s.getSecret(T, "API_KEY")?.value, "v2-on-file", "not the stale v1 row");
    } finally {
      s.setVaultStore(null);
      fs.rmSync(data, { recursive: true, force: true });
    }
  });

  test("pg vault: two writers at once both land (compare-and-set, retried), and a reader never sees half", async () => {
    const { data, s, T } = await fresh();
    try {
      const st = await store();
      s.setVaultStore(st);
      s.setSecret(T, "BASE_KEY", "b");
      // A second writer gets in between this writer's read and its write.
      let interleaved = false;
      st.mutate(T, undefined, (all) => {
        if (!interleaved) {
          interleaved = true;
          s.setSecret(T, "OTHER_KEY", "other");
        }
        return { ...all, MARKER_KEY: all.BASE_KEY };
      });
      assert.deepEqual(Object.keys(st.read(T)).sort(), ["BASE_KEY", "MARKER_KEY", "OTHER_KEY"], "neither write lost");
      // …and the file ends equal to the row, whichever writer mirrored last.
      assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(data, T, "secrets.json"), "utf8"))).sort(), ["BASE_KEY", "MARKER_KEY", "OTHER_KEY"]);
    } finally {
      s.setVaultStore(null);
      fs.rmSync(data, { recursive: true, force: true });
    }
  });

  test("pg vault: a deleted or renamed workspace's scope follows it; a deleted account's rows go", async () => {
    const { data, s, T } = await fresh();
    try {
      const st = await store();
      s.setVaultStore(st);
      s.setSecret(T, "WS_KEY", "v", "desk");
      s.setSecret(T, "ACC_KEY", "v");
      const { pgRecords, deleteTenantRecords } = await import("../src/records-pg.ts");
      const rec = pgRecords();
      rec.workspaceMove(T, "desk", "bureau");
      assert.deepEqual(st.workspaces(T), ["bureau"]);
      assert.equal(s.getSecret(T, "WS_KEY", "bureau")?.value, "v", "the same sealed record opens under the new name");
      rec.workspaceDrop(T, "bureau");
      assert.deepEqual(st.workspaces(T), []);
      // An account delete removes its folder too (the mirror file with it).
      fs.rmSync(path.join(data, T), { recursive: true, force: true });
      await deleteTenantRecords(T);
      assert.deepEqual(st.read(T), {}, "the account's row is gone");
    } finally {
      s.setVaultStore(null);
      fs.rmSync(data, { recursive: true, force: true });
    }
  });
}
