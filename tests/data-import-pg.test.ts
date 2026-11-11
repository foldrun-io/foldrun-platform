// The data importer (foldrun-core/src/data-import.ts) against Postgres: the pg
// revision store and fs blobs. DB-gated.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { takeTurnsOnLiveDb } from "./live-db-lock.ts";
import { fsBlobStore, bounded } from "../../foldrun-core/src/blob-store.ts";
import { dataImportSuite, snapshot } from "../../foldrun-core/tests/data-import-suite.ts";
import { buildSource } from "../../foldrun-core/tests/data-import-fixture.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
takeTurnsOnLiveDb(url);

if (!url) {
  test("data import on Postgres (set FOLDRUN_TEST_DATABASE_URL to run)", { skip: "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" }, () => {});
} else {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  const TENANTS = ["acme", "beta", "gamma"];
  const wipe = async () => {
    const { pgSyncOne } = await import("../src/pg-sync.ts");
    for (const table of ["workspace_files", "workspace_heads", "workspace_ops", "workspace_revisions"]) {
      for (const t of TENANTS) pgSyncOne(`DELETE FROM ${table} WHERE tenant = $1`, [t]);
    }
    for (const t of TENANTS) pgSyncOne("DELETE FROM blob_pins WHERE tenant = $1", [t]);
  };
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

  dataImportSuite("fs + pg", async () => {
    const { pgRevisionStore } = await import("../src/revision-store-pg.ts");
    const { pgBlobPins } = await import("../src/blob-pins.ts");
    await wipe();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-pgimp-"));
    return {
      // with the real pins: a streamed large file is pinned, then the pin is released
      deps: { blobs: bounded(fsBlobStore(path.join(root, "objects")), { backoffMs: 1 }), revisions: pgRevisionStore(), pins: pgBlobPins() },
      cleanup: async () => {
        fs.rmSync(root, { recursive: true, force: true });
        await wipe();
      },
    };
  });

  test("the entry point: dry run writes nothing; import + verify pass; a rerun adds nothing; the source is untouched", async () => {
    const { dataImport } = await import("../src/data-import.ts");
    const { pgRevisionStore } = await import("../src/revision-store-pg.ts");
    const { pgBlobPins } = await import("../src/blob-pins.ts");
    await wipe();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-pgimp-"));
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-pgimp-out-"));
    const src = buildSource();
    const deps = { blobs: bounded(fsBlobStore(path.join(root, "objects")), { backoffMs: 1 }), revisions: pgRevisionStore(), pins: pgBlobPins() };
    const before = snapshot(src);
    try {
      const dry = await dataImport({ source: src, deps, compare: true });
      assert.equal(dry.exitCode, 0);
      assert.match(dry.planText ?? "", /DRY RUN — nothing was written/);
      assert.equal(await deps.revisions.head({ tenant: "acme", workspace: "desk" }), null, "a dry run wrote nothing");

      const done = await dataImport({ source: src, deps, doImport: true, verify: true, deep: true, out, tenants: ["acme", "beta"] });
      assert.equal(done.exitCode, 0, done.verified ? JSON.stringify(done.verified.workspaces.filter((w) => !w.pass)) : "");
      assert.ok(done.reportFiles && fs.existsSync(done.reportFiles.json) && fs.existsSync(done.reportFiles.txt));
      const n = (await deps.revisions.revisions({ tenant: "acme", workspace: "desk" })).length;

      const again = await dataImport({ source: src, deps, doImport: true, verify: true, out, tenants: ["acme", "beta"] });
      assert.equal(again.exitCode, 0);
      assert.equal((await deps.revisions.revisions({ tenant: "acme", workspace: "desk" })).length, n, "a rerun adds no revision");
      assert.deepEqual(again.imported!.results.map((r) => r.status), ["unchanged", "unchanged", "unchanged"]);
      assert.deepEqual(snapshot(src), before, "the source folder is untouched");
      const { pgSyncOne } = await import("../src/pg-sync.ts");
      const held = pgSyncOne("SELECT count(*)::int AS n FROM blob_pins WHERE tenant = $1 AND holder_kind = 'publish'", ["acme"]);
      assert.equal((held.rows[0] as { n: number }).n, 0, "no publish pin is left behind");

      // gamma was not in the selection
      assert.equal(await deps.revisions.head({ tenant: "gamma", workspace: "blank" }), null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(out, { recursive: true, force: true });
      fs.rmSync(src, { recursive: true, force: true });
      await wipe();
    }
  });
}
