// FOL-58: the daily security rescan. A source is baselined silently the first
// time it is checked; after that only a new finding is news; a source that
// could not be checked keeps what it found; a finding goes away and comes
// back as news; pending findings wait for a delivery, or are dropped when
// the workspace chose not to hear them.
//
//   node --test tests/rescan.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-rescan-"));
delete process.env.FOLDRUN_DATABASE_URL;
const { foldRescan, rescanWorkspace, lastRescan } = await import("../src/rescan.ts");
const { workspaceDir } = await import("../../foldrun-core/src/store.ts");
import type { ScanFinding } from "../../foldrun-core/src/scan.ts";

const f = (rule: string, fp: string, message = "m"): ScanFinding & { source?: string } => ({
  rule,
  level: "warn",
  file: "agents/a/agent.md",
  message,
  fingerprint: fp,
  ...(rule === "supply-chain/known-vulnerability" ? { source: "osv" } : rule === "content/mcp-tool-text" ? { source: `mcp:agents/a/agent.md#${/^mcpServers\.(.+?) tool /.exec(message)?.[1] ?? "?"}` } : {}),
});
const vuln = (fp: string) => f("supply-chain/known-vulnerability", fp);
const secret = (fp: string) => f("secret/hardcoded", fp);
const ok = (...s: string[]) => s.map((source) => ({ source, checked: true }));

test("first check of a source is a silent baseline; later only new findings are fresh", () => {
  const first = foldRescan(null, 1, [secret("s1"), vuln("v1")], ok("checks", "osv"), []);
  assert.deepEqual(first.fresh, []);
  assert.deepEqual(first.notice.baselined.sort(), ["checks", "osv"]);
  const second = foldRescan(first.notice, 2, [secret("s1"), secret("s2"), vuln("v1")], ok("checks", "osv"), []);
  assert.deepEqual(second.fresh.map((x) => x.fingerprint), ["s2"]);
  assert.deepEqual(second.notice.pending.map((x) => x.fingerprint), ["s2"]);
});

test("a source that could not be checked keeps what it found, and its first success is a baseline", () => {
  const a = foldRescan(null, 1, [secret("s1"), vuln("v1")], ok("checks", "osv"), []);
  const down = foldRescan(a.notice, 2, [secret("s1")], [{ source: "checks", checked: true }, { source: "osv", checked: false, problem: "unreachable" }], ["unreachable"]);
  assert.ok(down.notice.findings.some((x) => x.fingerprint === "v1"), "an unreachable OSV does not resolve the vulnerability");
  assert.deepEqual(down.fresh, []);
  const mcpFirst = foldRescan(down.notice, 3, [secret("s1"), vuln("v1"), f("content/mcp-tool-text", "m1", 'mcpServers.shop tool "x": bad')], ok("checks", "osv", "mcp:agents/a/agent.md#shop"), []);
  assert.deepEqual(mcpFirst.fresh, [], "a server reached for the first time is a baseline");
});

test("a finding that goes away and comes back is news again; a pending one that went away is dropped", () => {
  const a = foldRescan(null, 1, [secret("s1")], ok("checks"), []);
  const gone = foldRescan(a.notice, 2, [], ok("checks"), []);
  const back = foldRescan(gone.notice, 3, [secret("s1")], ok("checks"), []);
  assert.deepEqual(back.fresh.map((x) => x.fingerprint), ["s1"]);
  const resolved = foldRescan(back.notice, 4, [], ok("checks"), []);
  assert.deepEqual(resolved.notice.pending, [], "not worth telling once it is gone");
});

test("only security categories, never info, are kept", () => {
  const r = foldRescan(null, 1, [f("config/unknown-field", "c1"), { ...secret("s1"), level: "info" }, secret("s2")], ok("checks"), []);
  assert.deepEqual(r.notice.findings.map((x) => x.fingerprint), ["s2"]);
});

test("a real workspace: the first pass is silent, a new key written in is pending, and with no notify: it is dropped as a choice", async () => {
  const dir = workspaceDir("acme", "desk");
  fs.mkdirSync(path.join(dir, "agents/a"), { recursive: true });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "---\nname: desk\n---\n");
  fs.writeFileSync(path.join(dir, "agents/a/agent.md"), "---\nname: a\ndescription: d\n---\n\nWork.\n");
  const first = await rescanWorkspace("acme", "desk", 1_000);
  assert.deepEqual(first.pending, []);
  assert.ok(first.baselined.includes("checks") && first.baselined.includes("osv"));
  const key = ["sk", "ant", "api03", crypto.randomBytes(30).toString("hex")].join("-");
  fs.writeFileSync(path.join(dir, "agents/a/agent.md"), `---\nname: a\ndescription: d\n---\n\nUse ${key}.\n`);
  const second = await rescanWorkspace("acme", "desk", 2_000);
  assert.ok(second.findings.some((x) => x.rule === "secret/hardcoded"));
  assert.deepEqual(second.pending, [], "no notify: in AGENTS.md — the workspace chose silence; nothing is retried");
  assert.equal((await lastRescan("acme", "desk"))?.checkedAt, 2_000);
});

test("a source no longer declared loses its findings; re-adding it makes them news (Codex review)", () => {
  const mcp = (fp: string) => f("content/mcp-tool-text", fp, 'mcpServers.shop tool "x": bad');
  const a = foldRescan(null, 1, [mcp("m1")], ok("checks", "osv", "mcp:agents/a/agent.md#shop"), []);
  const removed = foldRescan(a.notice, 2, [], ok("checks", "osv"), []);
  assert.ok(!removed.notice.findings.some((x) => x.fingerprint === "m1"));
  const back = foldRescan(removed.notice, 3, [mcp("m1")], ok("checks", "osv", "mcp:agents/a/agent.md#shop"), []);
  assert.deepEqual(back.fresh.map((x) => x.fingerprint), ["m1"]);
  const down = foldRescan(back.notice, 4, [], [...ok("checks", "osv"), { source: "mcp:agents/a/agent.md#shop", checked: false, problem: "down" }], []);
  assert.ok(down.notice.findings.some((x) => x.fingerprint === "m1"), "unreachable is not removed");
});

test("a pass retries what it failed to tell without waiting for the next daily scan (Codex review)", async () => {
  const { setNotice } = await import("../src/notices.ts");
  const { rescanPass, lastRescan: last } = await import("../src/rescan.ts");
  const dir = workspaceDir("beta", "desk");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "---\nname: desk\n---\n");
  const pending = { rule: "secret/hardcoded", file: "agents/a/agent.md", message: "m", fingerprint: "p1", source: "checks" };
  await setNotice("beta", "security", "desk", { checkedAt: 10_000, baselined: ["checks"], findings: [pending], pending: [pending], problems: [], sources: [] }, 10_000);
  await rescanPass(10_000 + 60_000);
  const after = await last("beta", "desk");
  assert.equal(after?.checkedAt, 10_000, "not rescanned — not due");
  assert.deepEqual(after?.pending, [], "but the pending finding was handled: this workspace has no notify:, so it is dropped by choice");
});

test("two files naming a server alike are two sources; a partly read source keeps old findings and adds what it read (Codex review)", () => {
  const mcpIn = (file: string, fp: string) => ({ ...f("content/mcp-tool-text", fp, 'mcpServers.shop tool "x": bad'), file, source: `mcp:${file}#shop` });
  const a = foldRescan(null, 1, [mcpIn("agents/a/agent.md", "a1"), mcpIn("agents/b/agent.md", "b1")], ok("checks", "osv", "mcp:agents/a/agent.md#shop", "mcp:agents/b/agent.md#shop"), []);
  const one = foldRescan(a.notice, 2, [mcpIn("agents/a/agent.md", "a1")], [...ok("checks", "osv", "mcp:agents/a/agent.md#shop"), { source: "mcp:agents/b/agent.md#shop", checked: false, problem: "down" }], []);
  assert.ok(one.notice.findings.some((x) => x.fingerprint === "b1"), "b's server being down keeps b's finding though a's was checked");
  const part = foldRescan(one.notice, 3, [vuln("v2")], [...ok("checks", "mcp:agents/a/agent.md#shop", "mcp:agents/b/agent.md#shop"), { source: "osv", checked: false, partial: true, problem: "capped" }], []);
  assert.ok(part.notice.findings.some((x) => x.fingerprint === "v2"), "a partial read's findings count");
  assert.deepEqual(part.fresh.map((x) => x.fingerprint), ["v2"], "osv was baselined on the first pass, so a real finding from a partial read is news");
});

test("a pass that skipped a source for time is due again within the hour, and records when each source was last checked (Codex review)", async () => {
  const { setNotice } = await import("../src/notices.ts");
  const { rescanPass, lastRescan: last } = await import("../src/rescan.ts");
  const r = foldRescan(null, 5, [], [...ok("checks", "osv"), { source: "mcp:agents/a/agent.md#slow", checked: false, skipped: true, problem: "time" }], []);
  assert.equal(r.notice.unfinished, true);
  assert.deepEqual(Object.keys(r.notice.sourceAt ?? {}).sort(), ["checks", "osv"], "a source skipped for time was not tried");
  const dir = workspaceDir("gamma", "desk");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "---\nname: desk\n---\n");
  await setNotice("gamma", "security", "desk", { ...r.notice, checkedAt: 100_000 }, 100_000);
  await rescanPass(100_000 + 3_600_000);
  assert.equal((await last("gamma", "desk"))?.checkedAt, 100_000 + 3_600_000, "rescanned after an hour, not a day");
});

test("a server name with a space keeps its findings; a failing server moves to the back (Codex review)", () => {
  const spaced = { ...f("content/mcp-tool-text", "s1", 'mcpServers.my server tool "x": bad'), source: "mcp:agents/a/agent.md#my server" };
  const r = foldRescan(null, 1, [spaced], ok("checks", "osv", "mcp:agents/a/agent.md#my server"), []);
  assert.ok(r.notice.findings.some((x) => x.fingerprint === "s1"));
  const failed = foldRescan(r.notice, 2, [], [...ok("checks", "osv"), { source: "mcp:agents/a/agent.md#my server", checked: false, problem: "down" }], []);
  assert.equal(failed.notice.sourceAt?.["mcp:agents/a/agent.md#my server"], 2, "a failed attempt counts as tried");
});

test("a scan that started and never finished (the process died) is skipped for a day, not retried on every restart", async () => {
  const { setNotice, getNotice } = await import("../src/notices.ts");
  const { rescanPass, lastRescan: last } = await import("../src/rescan.ts");
  const dir = workspaceDir("delta", "desk");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "---\nname: desk\n---\n");
  const t0 = 50_000_000;
  await setNotice("delta", "rescan-attempt", "desk", { at: t0 }, t0); // what a crashed pass leaves behind
  await rescanPass(t0 + 60_000);
  assert.equal(await last("delta", "desk"), null, "not scanned again straight after the crash");
  await rescanPass(t0 + 24 * 3600_000);
  const after = await last("delta", "desk");
  assert.equal(after?.checkedAt, t0 + 24 * 3600_000, "a day on, it is tried again");
  assert.ok(((await getNotice<{ at: number }>("delta", "rescan-attempt", "desk"))?.payload.at ?? 0) <= after!.checkedAt, "a finished scan does not look unfinished");
});

test("the rescan leaves out a state/ file over the checks' limit, names it, and keeps what it found there before (Codex review)", async () => {
  const { setNotice } = await import("../src/notices.ts");
  const { CHECK_LIMITS } = await import("../../foldrun-core/src/workspace-check.ts");
  const dir = workspaceDir("epsilon", "desk");
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "---\nname: desk\n---\n");
  const key = ["sk", "ant", "api03", crypto.randomBytes(30).toString("hex")].join("-");
  fs.writeFileSync(path.join(dir, "state/index.jsonl"), `${key}\n`);
  const first = await rescanWorkspace("epsilon", "desk", 3_000);
  const old = first.findings.find((x) => x.file === "state/index.jsonl");
  assert.ok(old, "read and flagged while it is small");
  const big = Buffer.alloc(CHECK_LIMITS.maxDataFileBytes + 1, "x");
  big.write(`${key}\n`);
  fs.writeFileSync(path.join(dir, "state/index.jsonl"), big);
  const second = await rescanWorkspace("epsilon", "desk", 4_000);
  assert.ok(second.problems.some((p) => p.includes("state/index.jsonl") && p.includes("not read")), "the problem names it");
  assert.ok(second.findings.some((x) => x.fingerprint === old.fingerprint), "unread is not resolved");
});

test("a workspace whose definitions are over the budget is not read at all, and keeps what it found before", async () => {
  const { setNotice } = await import("../src/notices.ts");
  const { CHECK_LIMITS } = await import("../../foldrun-core/src/workspace-check.ts");
  const dir = workspaceDir("zeta", "desk");
  fs.mkdirSync(path.join(dir, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "---\nname: desk\n---\n");
  const kept = { rule: "secret/hardcoded", file: "agents/a/agent.md", message: "m", fingerprint: "z1", source: "checks" };
  await setNotice("zeta", "security", "desk", { checkedAt: 1, baselined: ["checks"], findings: [kept], pending: [], problems: [], sources: [] }, 1);
  fs.writeFileSync(path.join(dir, "knowledge/huge.md"), Buffer.alloc(CHECK_LIMITS.maxSourceBytes + 1, "x"));
  const n = await rescanWorkspace("zeta", "desk", 5_000);
  assert.deepEqual(n.findings.map((x) => x.fingerprint), ["z1"]);
  assert.match(n.problems[0] ?? "", /not read/);
  fs.rmSync(path.join(dir, "knowledge/huge.md"));
});

test("a workspace held off after a scan that did not finish still has its waiting findings sent (Codex review)", async () => {
  const { setNotice } = await import("../src/notices.ts");
  const { rescanPass, lastRescan: last } = await import("../src/rescan.ts");
  const dir = workspaceDir("eta", "desk");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "---\nname: desk\n---\n");
  const t0 = 90_000_000;
  const pending = { rule: "secret/hardcoded", file: "agents/a/agent.md", message: "m", fingerprint: "e1", source: "checks" };
  await setNotice("eta", "security", "desk", { checkedAt: t0 - 2 * 86_400_000, baselined: ["checks"], findings: [pending], pending: [pending], problems: [], sources: [] }, t0);
  await setNotice("eta", "rescan-attempt", "desk", { at: t0 }, t0);
  await rescanPass(t0 + 60_000);
  const after = await last("eta", "desk");
  assert.equal(after?.checkedAt, t0 - 2 * 86_400_000, "not rescanned while held off");
  assert.deepEqual(after?.pending, [], "but its pending finding was handled (no notify: here, so dropped by choice)");
});

test("the fold keeps an unread file's findings: a pending one stays pending, a delivered one is not told again, and readable again it is not news (Codex review)", () => {
  const a = foldRescan(null, 1, [secret("s1")], ok("checks"), []);
  const withPending = { ...a.notice, pending: a.notice.findings };
  const unreadPending = foldRescan(withPending, 2, [], ok("checks"), [], ["agents/a/agent.md"]);
  assert.deepEqual(unreadPending.notice.findings.map((x) => x.fingerprint), ["s1"]);
  assert.deepEqual(unreadPending.notice.pending.map((x) => x.fingerprint), ["s1"], "still waiting to be told");
  const unreadDelivered = foldRescan(a.notice, 2, [], ok("checks"), [], ["agents/a/agent.md"]);
  assert.deepEqual(unreadDelivered.notice.pending, [], "told once, not again");
  const readAgain = foldRescan(unreadDelivered.notice, 3, [secret("s1")], ok("checks"), []);
  assert.deepEqual(readAgain.fresh, []);
});

test("a rule past PER_FILE_RULE in a file does not resolve what it did not list there, and the finding is not news when it is listed again (Codex review)", async () => {
  const { scanFiles, PER_FILE_RULE } = await import("../../foldrun-core/src/scan.ts");
  const scan = (content: string) => scanFiles([{ path: "knowledge/n.md", content }]);
  const old = "old line\u200b";
  const one = scan(old);
  const a = foldRescan(null, 1, one, ok("checks"), []);
  const pendingNotice = { ...a.notice, pending: a.notice.findings };
  const flood = Array.from({ length: PER_FILE_RULE }, (_, i) => `flood ${i}\u200b`).join("\n");
  const crowded = foldRescan(pendingNotice, 2, scan(`${flood}\n${old}`), ok("checks"), []);
  const oldFp = one[0]!.fingerprint;
  assert.ok(crowded.notice.findings.some((x) => x.fingerprint === oldFp), "crowded out of the list, not resolved");
  assert.ok(crowded.notice.pending.some((x) => x.fingerprint === oldFp), "and still waiting to be told");
  const back = foldRescan(crowded.notice, 3, one, ok("checks"), []);
  assert.ok(!back.fresh.some((x) => x.fingerprint === oldFp), "listed again, it is not news");
});

test("a file that stays past PER_FILE_RULE keeps one count, the latest; the old ones and their pending go (Codex review)", async () => {
  const { scanFiles, PER_FILE_RULE } = await import("../../foldrun-core/src/scan.ts");
  const scan = (content: string) => scanFiles([{ path: "knowledge/n.md", content }]);
  const first = Array.from({ length: PER_FILE_RULE }, (_, i) => `flood ${i}\u200b`).join("\n");
  const old = "old line\u200b";
  const a = foldRescan(null, 1, scan(old), ok("checks"), []);
  const oldFp = a.notice.findings[0]!.fingerprint;
  let notice = { ...a.notice, pending: a.notice.findings };
  for (let n = 2; n <= 4; n++) {
    notice = foldRescan(notice, n, scan(`${first}\n${old}\nextra ${n}\u200b`), ok("checks"), []).notice;
  }
  const counts = notice.findings.filter((x) => x.truncated);
  assert.equal(counts.length, 1, "one count, not one per scan");
  assert.ok(notice.pending.filter((x) => x.truncated).length <= 1, "the old counts' pending went with them");
  assert.ok(notice.findings.some((x) => x.fingerprint === oldFp) && notice.pending.some((x) => x.fingerprint === oldFp), "the crowded-out finding stays, and still waits to be told");
});
