// Concurrent writers on real Postgres, each its own process (so its own
// connection and bridge, as several pods are): the compare-and-set on the
// row's gen decides, and what the loser does is read again. DB-gated:
// FOLDRUN_TEST_DATABASE_URL=postgres://… npm test

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { takeTurnsOnLiveDb } from "./live-db-lock.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
takeTurnsOnLiveDb(url);

if (!url) {
  test("concurrent vault writers on Postgres (set FOLDRUN_TEST_DATABASE_URL to run)", { skip: "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" }, () => {});
} else {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  process.env.FOLDRUN_SECRET_KEY = "concurrent-install-key";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-vault-conc-"));
  process.env.FOLDRUN_DATA = root;
  const T = "conc";
  const child = path.join(import.meta.dirname, "vault-writer-child.ts");

  const run = (arg: Record<string, unknown>) =>
    new Promise<{ retries: number; won?: boolean }>((resolve, reject) => {
      const p = spawn(process.execPath, [child, JSON.stringify(arg)], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (code) => {
        if (code !== 0) return reject(new Error(`writer exited ${code}: ${err.slice(0, 400)}`));
        try {
          resolve(JSON.parse(out.trim().split("\n").pop()!));
        } catch {
          reject(new Error(`writer said: ${out.slice(0, 200)} ${err.slice(0, 200)}`));
        }
      });
    });

  before(async () => {
    const { migrate } = await import("../src/db.ts");
    await migrate();
  });
  const clear = async () => {
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    pgSyncOne("DELETE FROM vault_scopes WHERE tenant = $1", [T]);
    // The scope's file follows its row (the mirror), and a scope with no row is imported from its file: drop both.
    fs.rmSync(path.join(root, T), { recursive: true, force: true });
  };
  after(async () => {
    await clear();
    const { closePgSync } = await import("../src/pg-sync.ts");
    await closePgSync();
    const { db } = await import("../src/db.ts");
    await db()?.end();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("eight processes writing one scope at once lose nothing: every secret lands, the losers read again", async () => {
    await clear();
    const { pgVaultStore } = await import("../src/vault-pg.ts");
    const s = await import("../../foldrun-core/src/secrets.ts");
    s.setVaultStore(pgVaultStore(() => true));
    const startAt = Date.now() + 2500;
    const writers = Array.from({ length: 8 }, (_, w) => run({ cmd: "write", tenant: T, startAt, names: Array.from({ length: 6 }, (_, i) => `W${w}_N${i}`) }));
    const results = await Promise.all(writers);
    const names = s.listSecrets(T).map((e) => e.name);
    assert.equal(names.length, 48, `every one of 48 secrets landed, got ${names.length}`);
    for (let w = 0; w < 8; w++) for (let i = 0; i < 6; i++) assert.equal(s.getSecret(T, `W${w}_N${i}`)?.value, `value-of-W${w}_N${i}`);
    const retries = results.reduce((n, r) => n + r.retries, 0);
    assert.ok(retries > 0, "the writers did collide (a change ran again after losing the compare-and-set)");
  });

  test("two writers of the same secret at once: one value wins whole, never a mix, and nothing else is disturbed", async () => {
    await clear();
    const { pgVaultStore } = await import("../src/vault-pg.ts");
    const s = await import("../../foldrun-core/src/secrets.ts");
    s.setVaultStore(pgVaultStore(() => true));
    s.setSecret(T, "BYSTANDER_KEY", "untouched");
    const startAt = Date.now() + 2500;
    await Promise.all([run({ cmd: "write", tenant: T, startAt, names: ["SAME_KEY"] }), run({ cmd: "write", tenant: T, startAt, names: ["SAME_KEY"] }), run({ cmd: "write", tenant: T, startAt, names: ["SAME_KEY"] })]);
    assert.equal(s.getSecret(T, "SAME_KEY")?.value, "value-of-SAME_KEY");
    assert.equal(s.getSecret(T, "BYSTANDER_KEY")?.value, "untouched");
    assert.equal(s.listSecrets(T).length, 2);
  });

  test("OAuth refresh rotation across processes: of several refreshes that started from the same token, exactly one replaces it", async () => {
    const { pgVaultStore } = await import("../src/vault-pg.ts");
    const s = await import("../../foldrun-core/src/secrets.ts");
    s.setVaultStore(pgVaultStore(() => true));
    for (let round = 0; round < 3; round++) {
      await clear();
      s.setOAuth2Secret(T, "OA_KEY", { token_url: "https://idp.example.com/token", client_id: "cid", refresh_token: `rt-start-${round}` });
      s.setSecret(T, "OTHER_KEY", "o");
      const used = s.getSecret(T, "OA_KEY")!.value;
      const startAt = Date.now() + 2500;
      const answers = await Promise.all([1, 2, 3, 4, 5].map((n) => run({ cmd: "rotate", tenant: T, name: "OA_KEY", used, next: `rt-next-${round}-${n}`, startAt })));
      const winners = answers.filter((a) => a.won);
      assert.equal(winners.length, 1, `round ${round}: exactly one refresh won, got ${winners.length}`);
      const now = s.getSecret(T, "OA_KEY")!.value;
      const held = JSON.parse(now.slice(now.indexOf("{"))).refresh_token as string;
      assert.match(held, new RegExp(`^rt-next-${round}-[1-5]$`));
      assert.equal(s.getSecret(T, "OTHER_KEY")?.value, "o");
      // a late refresh from the old token loses, whoever it is
      const late = await run({ cmd: "rotate", tenant: T, name: "OA_KEY", used, next: "rt-late", startAt: Date.now() });
      assert.equal(late.won, false);
      assert.equal(JSON.parse(s.getSecret(T, "OA_KEY")!.value.slice(s.getSecret(T, "OA_KEY")!.value.indexOf("{"))).refresh_token, held);
    }
  });
}
