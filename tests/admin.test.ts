// The super admin's side of an account: state beside the accounts, an audit
// line for every change, a suspension the queue honours, a plan the wallet
// prefers over the account's own frontmatter.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adminState, updateAdminState, appendAudit, readAudit, assertAccountActive, AccountSuspended, isSuperAdmin, platformAccount, setPaused, pauseOf, pauseWindows, assertNotPaused, RunsPaused } from "../src/admin.ts";
import { accountPriority, accountConcurrency, accountWeight } from "../src/limits.ts";
import { listTenants } from "../../foldrun-core/src/store.ts";
import { enqueueFlowRun } from "../src/queue.ts";
import { readLedger } from "../src/ledger.ts";

function withData(body: () => void | Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-operator-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  const ws = path.join(root, "acme/workspaces/desk");
  fs.mkdirSync(path.join(ws, "agents/writer"), { recursive: true });
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
  fs.writeFileSync(path.join(root, "acme/AGENTS.md"), "---\npriority: high\nconcurrency: 7\n---\n");
  return Promise.resolve(body()).finally(() => {
    process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
}

test("a change and its audit line are one write", () =>
  withData(async () => {
    await updateAdminState("acme", { notes: "called 9/8, wants a bigger lane" }, "ops@foldrun.io", "notes");
    assert.equal((await adminState("acme")).notes, "called 9/8, wants a bigger lane");
    assert.equal((await adminState("acme")).updatedBy, "ops@foldrun.io");
    const audit = await readAudit({ tenant: "acme" });
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, "notes");
    assert.equal(audit[0].by, "ops@foldrun.io");
  }));

test("the admin state directory is never mistaken for a tenant", () =>
  withData(async () => {
    await updateAdminState("acme", { notes: "x" }, "ops", "notes");
    await appendAudit({ t: new Date().toISOString(), by: "ops", tenant: "acme", action: "looked" });
    assert.ok(fs.existsSync(path.join(process.env.FOLDRUN_DATA!, "operator")));
    assert.deepEqual(listTenants(), ["acme"]);
  }));

test("a suspended account starts no runs, and says why", () =>
  withData(async () => {
    await updateAdminState("acme", { suspended: { at: "2026-09-08T00:00:00Z", by: "ops", reason: "chargeback" } }, "ops", "suspend");
    await assert.rejects(() => assertAccountActive("acme"), (e: unknown) => e instanceof AccountSuspended && (e as AccountSuspended).status === 423 && /chargeback/.test((e as Error).message));
    await assert.rejects(
      enqueueFlowRun("acme", "desk", [{ agent: "writer", instruction: "", group: 1, optional: false }], "one"),
      /suspended: chargeback/,
    );
    await updateAdminState("acme", { suspended: undefined }, "ops", "restore");
    await assert.doesNotReject(() => assertAccountActive("acme"));
  }));

test("the audit reads newest first and narrows by account", () =>
  withData(async () => {
    await appendAudit({ t: "2026-09-08T00:00:01Z", by: "a", tenant: "acme", action: "first" });
    await appendAudit({ t: "2026-09-08T00:00:02Z", by: "a", tenant: "other", action: "elsewhere" });
    await appendAudit({ t: "2026-09-08T00:00:03Z", by: "b", tenant: "acme", action: "second" });
    assert.deepEqual((await readAudit({ tenant: "acme" })).map((e) => e.action), ["second", "first"]);
    assert.equal((await readAudit()).length, 3);
    assert.equal((await readAudit({ limit: 1 }))[0].action, "second");
  }));

test("the super admin is the owner of the platform account, and only that", () => {
  const prev = process.env.FOLDRUN_PLATFORM_ACCOUNT;
  delete process.env.FOLDRUN_PLATFORM_ACCOUNT;
  try {
    assert.equal(platformAccount(), "foldrun");
    assert.equal(isSuperAdmin({ tenant: "foldrun", owner: true }), true);
    // An admin of the platform account is still not the platform's owner.
    assert.equal(isSuperAdmin({ tenant: "foldrun", owner: false }), false);
    // The owner of any other account owns their account, not the platform.
    assert.equal(isSuperAdmin({ tenant: "acme", owner: true }), false);
    assert.equal(isSuperAdmin(null), false);
    process.env.FOLDRUN_PLATFORM_ACCOUNT = "ops-account";
    assert.equal(isSuperAdmin({ tenant: "foldrun", owner: true }), false);
    assert.equal(isSuperAdmin({ tenant: "ops-account", owner: true }), true);
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_PLATFORM_ACCOUNT;
    else process.env.FOLDRUN_PLATFORM_ACCOUNT = prev;
  }
});


const oneStep = [{ agent: "writer", instruction: "", group: 1, optional: false }];

test("a paused workspace starts no runs; its neighbours and a resume do", () =>
  withData(async () => {
    fs.mkdirSync(path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/other/agents/writer"), { recursive: true });
    await setPaused("acme", "desk", { pause: { by: "ana@acme.io", reason: "a bad prompt is posting" } });
    await assert.rejects(
      enqueueFlowRun("acme", "desk", oneStep, "one"),
      (e: unknown) => e instanceof RunsPaused && (e as RunsPaused).status === 423 && /workspace desk is paused .*ana@acme\.io.*a bad prompt is posting/.test((e as Error).message),
    );
    await assert.doesNotReject(() => assertNotPaused("acme", "other"));
    assert.deepEqual(await readAudit({ tenant: "acme" }), [], "a customer's pause is not an operator action");
    await setPaused("acme", "desk", { resume: { by: "ana@acme.io" } });
    await assert.doesNotReject(() => assertNotPaused("acme", "desk"));
    const [w] = pauseWindows(await adminState("acme"), "desk");
    assert.ok(w.to !== null && w.to >= w.from, "the window is kept after a resume");
  }));

test("an account pause holds every workspace, and pausing twice keeps when it began", () =>
  withData(async () => {
    await setPaused("acme", null, { pause: { by: "cto@acme.io" } });
    const first = (await adminState("acme")).paused!.account!.at;
    await setPaused("acme", null, { pause: { by: "someone-else" } });
    assert.equal((await adminState("acme")).paused!.account!.at, first);
    assert.equal(pauseOf(await adminState("acme"), "desk")?.scope, "account");
    await assert.rejects(enqueueFlowRun("acme", "desk", oneStep, "one"), RunsPaused);
    await setPaused("acme", null, { resume: { by: "cto@acme.io" } });
    assert.equal(pauseOf(await adminState("acme"), "desk"), null);
  }));

test("a resume never lifts an operator's suspension", () =>
  withData(async () => {
    await updateAdminState("acme", { suspended: { at: "2026-10-21T00:00:00Z", by: "ops", reason: "chargeback" } }, "ops", "suspend");
    await setPaused("acme", null, { pause: { by: "owner" } });
    await setPaused("acme", null, { resume: { by: "owner" } });
    await assert.rejects(() => assertAccountActive("acme"), AccountSuspended);
  }));

test("pause, resume, pause again: the first window is still a pause window", () =>
  withData(async () => {
    await setPaused("acme", "desk", { pause: { by: "a" } });
    await setPaused("acme", "desk", { resume: { by: "a" } });
    await setPaused("acme", "desk", { pause: { by: "b" } });
    const windows = pauseWindows(await adminState("acme"), "desk");
    assert.equal(windows.length, 2, "the earlier window is kept beside the open one");
    assert.ok(windows[0].to !== null);
    assert.equal(windows[1].to, null);
  }));

test("a workspace named like an Object property is paused only when someone paused it", () =>
  withData(async () => {
    await setPaused("acme", "desk", { pause: { by: "a" } });
    await assert.doesNotReject(() => assertNotPaused("acme", "constructor"));
    await setPaused("acme", "constructor", { pause: { by: "a" } });
    await assert.rejects(() => assertNotPaused("acme", "constructor"), RunsPaused);
  }));
