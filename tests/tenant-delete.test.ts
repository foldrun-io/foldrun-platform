// Deleting an account.
//
// Without a database these prove the file half and the guard; the shred itself
// needs Postgres and is verified on the box.
//
//   node --test tests/tenant-delete.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deleteTenant } from "../src/tenant-delete.ts";

function withAccounts(body: (root: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-del-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  for (const t of ["acme", "other"]) {
    fs.mkdirSync(path.join(root, t, "workspaces", "w"), { recursive: true });
    fs.writeFileSync(path.join(root, t, "secrets.json"), "{}");
  }
  return body(root).finally(() => {
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
  });
}

test("the account must be named twice, or nothing happens", async () => {
  await withAccounts(async (root) => {
    await assert.rejects(
      () => deleteTenant("acme", { confirm: "yes", by: "test" }),
      /confirm must be exactly "acme"/,
    );
    assert.ok(fs.existsSync(path.join(root, "acme")), "a refused delete leaves it alone");
  });
});

test("deleting one account leaves the others untouched", async () => {
  await withAccounts(async (root) => {
    const r = await deleteTenant("acme", { confirm: "acme", by: "test" });
    assert.equal(r.filesRemoved, true);
    assert.ok(!fs.existsSync(path.join(root, "acme")));
    assert.ok(fs.existsSync(path.join(root, "other")), "the other account survives");
  });
});

test("a path that is not an account name is refused before anything runs", async () => {
  await withAccounts(async () => {
    await assert.rejects(() => deleteTenant("../etc", { confirm: "../etc", by: "test" }));
  });
});
