// What mail each address takes: a row is a choice, no row is "on", a
// workspace row beats the account row, and a required category cannot be
// turned off. Then the whole path: a run alert to someone who unsubscribed
// is not sent, while their password reset still is.
//
//   node --test tests/email-preferences.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-prefs-"));
process.env.FOLDRUN_DATA = root;
process.env.FOLDRUN_SECRET_KEY ??= "prefs-test-key";
process.env.FOLDRUN_RESEND_API_KEY = "re_platform";
delete process.env.FOLDRUN_DATABASE_URL;

await import("../src/index.ts");
const p = await import("../src/email-preferences.ts");
const { sendMail, readUnsubscribeToken, unsubscribeToken } = await import("../../foldrun-core/src/mail.ts");
const { sendPlainNotification } = await import("../../foldrun-core/src/notify.ts");

test("no choice made is on; off account-wide; a workspace row beats it either way", async () => {
  assert.equal(await p.mailAllowed("acme", "me@example.test", "run-alerts", "desk"), true);
  await p.setPreference("acme", "Me@Example.test", "run-alerts", false);
  assert.equal(await p.mailAllowed("acme", "me@example.test", "run-alerts", "desk"), false);
  await p.setPreference("acme", "me@example.test", "run-alerts", true, { workspace: "desk" });
  assert.equal(await p.mailAllowed("acme", "me@example.test", "run-alerts", "desk"), true, "on for desk");
  assert.equal(await p.mailAllowed("acme", "me@example.test", "run-alerts", "other"), false, "still off elsewhere");
  assert.equal(await p.mailAllowed("other-account", "me@example.test", "run-alerts", "desk"), true, "per account");
  // On for the account clears the per-workspace rows: "on" means on.
  await p.setPreference("acme", "me@example.test", "run-alerts", false, { workspace: "other" });
  await p.setPreference("acme", "me@example.test", "run-alerts", true);
  assert.deepEqual((await p.listPreferences("acme", "me@example.test")).filter((r) => r.category === "run-alerts").map((r) => [r.workspace, r.enabled]), [["", true]]);
});

test("a required category cannot be turned off — refused with the reason, 409", async () => {
  for (const c of ["security", "invites", "billing", "account"]) {
    await assert.rejects(p.setPreference("acme", "me@example.test", c, false), (e: Error & { status?: number }) => e.status === 409 && /cannot be turned off/.test(e.message));
    assert.equal(await p.mailAllowed("acme", "me@example.test", c, null), true);
  }
  await p.setPreference("acme", "me@example.test", "security", true); // a no-op, not an error
  await assert.rejects(p.setPreference("acme", "me@example.test", "nonsense", false), /no category/);
  await assert.rejects(p.setPreference("acme", "me@example.test", "low-balance", false, { workspace: "desk" }), /account-wide/);
});

test("the summary is every category, with the required ones locked on", async () => {
  await p.setPreference("acme", "sum@example.test", "approvals", false, { workspace: "desk" });
  await p.setPreference("acme", "sum@example.test", "low-balance", false);
  const s = await p.preferenceSummary("acme", "sum@example.test");
  const by = Object.fromEntries(s.map((c) => [c.category, c]));
  assert.equal(by.security.enabled, true);
  assert.equal(by.security.required, true);
  assert.ok(by.security.why);
  assert.equal(by["low-balance"].enabled, false);
  assert.deepEqual(by.approvals.workspaces, { desk: false });
  assert.equal(by.approvals.enabled, true);
});

test("an unsubscribe token's claim turns off exactly that category for that workspace", async () => {
  const t = unsubscribeToken({ tenant: "acme", email: "inbox@example.test", category: "approvals", workspace: "desk" });
  const r = readUnsubscribeToken(t);
  assert.ok("claim" in r);
  await p.setPreference(r.claim.tenant, r.claim.email, r.claim.category, false, { workspace: r.claim.workspace, source: "unsubscribe" });
  assert.equal(await p.mailAllowed("acme", "inbox@example.test", "approvals", "desk"), false);
  assert.equal(await p.mailAllowed("acme", "inbox@example.test", "approvals", "other"), true);
  assert.equal(await p.mailAllowed("acme", "inbox@example.test", "run-alerts", "desk"), true);
  assert.equal((await p.listPreferences("acme", "inbox@example.test"))[0].source, "unsubscribe");
});

test("honoured at send time: a run alert to an address that opted out is not sent; a reset to it is", async () => {
  const sent: { to: unknown; subject: string }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_u: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    fs.mkdirSync(path.join(root, "acme/workspaces/desk"), { recursive: true });
    fs.writeFileSync(path.join(root, "acme/workspaces/desk/AGENTS.md"), "---\nnotify:\n  email: quiet@example.test\n---\n");
    await p.setPreference("acme", "quiet@example.test", "run-alerts", false, { workspace: "desk" });
    assert.equal(await sendPlainNotification("acme", "desk", { event: "quarantined", headline: "publish switched off", detail: "3 failures" }), true, "not sent is not a failure");
    assert.equal(sent.length, 0);
    const r = await sendMail({ tenant: "acme", mail: { key: "k", from: "f" }, to: "quiet@example.test", subject: "Reset your foldrun password", text: "…", category: "security" });
    assert.equal(r.ok, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].subject, "Reset your foldrun password");
  } finally {
    globalThis.fetch = real;
  }
});
