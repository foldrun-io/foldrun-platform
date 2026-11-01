// The platform's early refusal for a URL a tenant chose (a remotes: card, a
// provider base URL): installPlatform binds core's checkUntrustedUrl to
// refuseInternalUrl, then core's https rule — so a card at a private,
// loopback or cluster address is refused host-side before anything is sent,
// not only by the egress proxy.
//
//   FOLDRUN_DATA=$(mktemp -d) node --test tests/check-untrusted-url.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.FOLDRUN_DATA ??= fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-check-url-"));
delete process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE;

const { installPlatform } = await import("../src/index.ts");
const { platform } = await import("../../foldrun-core/src/platform.ts");
installPlatform();

test("an internal or private card address is refused before anything is sent", async () => {
  for (const url of [
    "https://localhost/.well-known/agent-card.json",
    "https://127.0.0.1:3000/.well-known/agent-card.json",
    "https://169.254.169.254/latest/meta-data/",
    "https://[::ffff:7f00:1]/.well-known/agent-card.json",
    "https://10.43.0.1/.well-known/agent-card.json",
    "https://foldrun-web.foldrun.svc.cluster.local:3000/.well-known/agent-card.json",
    "https://foldrun-postgres/.well-known/agent-card.json",
  ]) {
    assert.match((await platform.checkUntrustedUrl(url)) ?? "", /private or internal address|internal name/, url);
  }
});

test("plain http is still refused; a public https card is fine", async () => {
  assert.match((await platform.checkUntrustedUrl("http://agents.example.com/.well-known/agent-card.json")) ?? "", /is not https/);
  assert.equal(await platform.checkUntrustedUrl("https://agents.example.com/.well-known/agent-card.json"), null);
});

test("FOLDRUN_EGRESS_ALLOW_PRIVATE=1 lifts it, as it lifts the guard", async () => {
  process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE = "1";
  try {
    assert.equal(await platform.checkUntrustedUrl("https://127.0.0.1:3000/.well-known/agent-card.json"), null);
  } finally {
    delete process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE;
  }
});
