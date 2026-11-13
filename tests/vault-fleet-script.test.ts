// scripts/vault-fleet.ts as an operator runs it: each command a process of
// its own with the database, the data volume and the keys; exit codes; and
// nothing it prints holds a value. DB-gated:
//   FOLDRUN_TEST_DATABASE_URL=postgres://… npm test

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { takeTurnsOnLiveDb } from "./live-db-lock.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
takeTurnsOnLiveDb(url);

if (!url) {
  test("vault-fleet.ts on Postgres (set FOLDRUN_TEST_DATABASE_URL to run)", { skip: "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" }, () => {});
} else {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  process.env.FOLDRUN_SECRET_KEY = "fleet-script-install-key";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-vault-fleet-script-"));
  process.env.FOLDRUN_DATA = root;
  const script = path.join(import.meta.dirname, "..", "scripts", "vault-fleet.ts");
  const T = "fs-acct";
  const C = (n: string) => `canary-fscript-${n}-83d0a1c5e7`;
  const sh = (...args: string[]) => {
    const r = spawnSync(process.execPath, [script, ...args], { env: process.env, encoding: "utf8", timeout: 60_000 });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const fileOf = (ws?: string) => (ws ? path.join(root, T, "workspaces", ws, "secrets.json") : path.join(root, T, "secrets.json"));

  before(async () => {
    const { migrate } = await import("../src/db.ts");
    await migrate();
  });
  after(async () => {
    const { pgSyncOne, closePgSync } = await import("../src/pg-sync.ts");
    pgSyncOne("DELETE FROM vault_scopes WHERE tenant = $1", [T]);
    await closePgSync();
    const { db } = await import("../src/db.ts");
    await db()?.end();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("verify finds what was never imported, import moves it, verify --open is clean, a damaged row fails it, export brings the files up", async () => {
    const s = await import("../../foldrun-core/src/secrets.ts");
    process.env.FOLDRUN_VAULT_WRITE_BOUND = "1";
    s.setSecret(T, "ACC_KEY", C("acc"));
    s.setSecret(T, "DESK_KEY", C("desk"), "desk");

    let r = sh("verify", "--tenant", T);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /only a file \(import it\)\s+fs-acct\/\(account\)/);
    assert.match(r.out, /only a file \(import it\)\s+fs-acct\/desk/);
    assert.match(r.out, /NOT clean/);

    r = sh("import", "--tenant", T);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /imported 2/);

    r = sh("verify", "--open", "--tenant", T);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /equal to their file 2 · only a file 0 · only a row 0 · differ 0 · do not open 0/);
    assert.match(r.out, /\nclean\n?$/);

    // damage a row's ciphertext: --open names it, exit 1
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    pgSyncOne(`UPDATE vault_scopes SET records = jsonb_set(records, '{DESK_KEY,tag}', '"AAAAAAAAAAAAAAAAAAAAAA=="') WHERE tenant = $1 AND workspace = 'desk'`, [T]);
    r = sh("verify", "--open", "--tenant", T);
    assert.equal(r.code, 1);
    assert.match(r.out, /does not open\s+fs-acct\/desk\/DESK_KEY/);
    // the row says one thing, the file another: export makes the file say the row's
    pgSyncOne(`UPDATE vault_scopes SET records = '{}'::jsonb WHERE tenant = $1 AND workspace = 'desk'`, [T]);
    r = sh("export", "--tenant", T);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(JSON.parse(fs.readFileSync(fileOf("desk"), "utf8")), {});
    assert.ok(Object.keys(JSON.parse(fs.readFileSync(fileOf(), "utf8"))).includes("ACC_KEY"));

    // no value in anything it printed
    for (const v of [C("acc"), C("desk")]) assert.ok(!r.out.includes(v));
  });

  test("usage mistakes and a missing database exit 64 and change nothing", () => {
    assert.equal(sh().code, 64);
    assert.equal(sh("verify", "--frobnicate").code, 64);
    assert.equal(sh("import", "--open").code, 64);
    assert.equal(sh("verify", "--tenant").code, 64);
    const r = spawnSync(process.execPath, [script, "verify"], { env: { ...process.env, FOLDRUN_DATABASE_URL: "" }, encoding: "utf8" });
    assert.equal(r.status, 64);
    assert.match(r.stderr, /FOLDRUN_DATABASE_URL is not set/);
  });
}
