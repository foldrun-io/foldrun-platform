// An account's state beside the account: an audit line for every change, a
// suspension the queue honours, the customer's own pause. (Listing the
// operator audit is the hosted console's: foldrun-admin operator-audit.ts.)

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adminState, updateAdminState, appendAudit, assertAccountActive, AccountSuspended, platformAccount, setPaused, pauseOf, pauseWindows, assertNotPaused, RunsPaused, type AdminState } from "../src/admin.ts";
import { accountPriority, accountConcurrency, accountWeight } from "../src/limits.ts";
import { listTenants } from "../../foldrun-core/src/store.ts";
import { enqueueFlowRun } from "../src/queue.ts";
import { readLedger } from "../src/ledger.ts";

/** The audit lines written without a database, oldest first. */
function auditLines(tenant?: string): { by: string; tenant: string; action: string }[] {
  const file = path.join(process.env.FOLDRUN_DATA!, "operator", "audit.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => !tenant || e.tenant === tenant);
}

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
    await updateAdminState("acme", { apiVersion: "2026-10-01" }, "ops@foldrun.io", "api-version");
    assert.equal((await adminState("acme")).apiVersion, "2026-10-01");
    assert.equal((await adminState("acme")).updatedBy, "ops@foldrun.io");
    const audit = auditLines("acme");
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, "api-version");
    assert.equal(audit[0].by, "ops@foldrun.io");
  }));

test("the admin state directory is never mistaken for a tenant", () =>
  withData(async () => {
    await updateAdminState("acme", { apiVersion: "2026-10-01" }, "ops", "api-version");
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

test("a field this file does not name is kept by every merge", () =>
  withData(async () => {
    // The hosted console keeps fields of its own on the row (notes, a contact).
    await updateAdminState<AdminState & { notes?: string }>("acme", { notes: "theirs" }, "ops", "notes");
    await updateAdminState("acme", { apiVersion: "2026-10-01" }, "ana@acme.io", "api-version");
    await setPaused("acme", null, { pause: { by: "ana@acme.io" } });
    const state = await adminState<AdminState & { notes?: string }>("acme");
    assert.equal(state.notes, "theirs");
    assert.equal(state.apiVersion, "2026-10-01");
    assert.deepEqual(auditLines("acme").map((e) => e.action), ["notes", "api-version"], "one line per audited change, oldest first");
  }));

test("the platform's own account is foldrun unless the install names another", () => {
  const prev = process.env.FOLDRUN_PLATFORM_ACCOUNT;
  delete process.env.FOLDRUN_PLATFORM_ACCOUNT;
  try {
    assert.equal(platformAccount(), "foldrun");
    process.env.FOLDRUN_PLATFORM_ACCOUNT = " ops-account ";
    assert.equal(platformAccount(), "ops-account");
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
    assert.deepEqual(auditLines("acme"), [], "a customer's pause is not an operator action");
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
