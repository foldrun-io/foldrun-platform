// keyedStore.claim: insert only if absent, and exactly one winner among
// callers that race — the use-once marker behind a client assertion's jti
// (foldrun-web server/mcp-oauth.ts). The file store here; the database's is
// INSERT … ON CONFLICT DO NOTHING RETURNING, one row for one winner.
//
//   node --test tests/keyed-store-claim.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-claim-"));
delete process.env.FOLDRUN_DATABASE_URL;
const { keyedStore } = await import("../src/keyed-store.ts");
const { mcpOauthTokens } = await import("../src/schema.ts");

test("claim: one winner of twenty racing callers; a second claim of the same key loses; put and get still see it", async () => {
  const file = path.join(process.env.FOLDRUN_DATA!, "claims.json");
  const store = keyedStore<{ n: number }>(mcpOauthTokens, () => file);
  const results = await Promise.all(Array.from({ length: 20 }, (_, n) => store.claim("t", "jti-1", { n })));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await store.claim("t", "jti-1", { n: 99 }), false);
  const won = results.indexOf(true);
  assert.deepEqual(await store.get("t", "jti-1"), { n: won }, "the winner's record, not overwritten");
  assert.equal(await store.claim("t", "jti-2", { n: 1 }), true, "another key is its own claim");
});
