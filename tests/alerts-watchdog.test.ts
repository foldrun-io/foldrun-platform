// FOL-72 step 7: the watchdog tells a workspace's notify: when an `alerts:`
// threshold is crossed — once a day per rule, once per slow run.
//
//   node --test tests/alerts-watchdog.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-alerts-"));
delete process.env.FOLDRUN_DATABASE_URL;
const { sweepGatesAndSlas } = await import("../src/watchdog.ts");
const { getNotice } = await import("../src/notices.ts");
const { workspaceDir, writeRun } = await import("../../foldrun-core/src/store.ts");
import type { RunRecord } from "../../foldrun-core/src/store.ts";
import http from "node:http";

const NOW = Date.now();
const iso = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();

test("a failure rate over the threshold alerts once a day; a run past run_minutes once", async () => {
  const dir = workspaceDir("acme", "desk");
  fs.mkdirSync(path.join(dir, "agents", "a"), { recursive: true });
  // A webhook that takes what it is sent — down at first, so a failed send
  // is not remembered as told (Codex review).
  const got: string[] = [];
  let up = false;
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      if (up) got.push(JSON.parse(b).status);
      res.writeHead(up ? 200 : 500).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  fs.writeFileSync(path.join(dir, "AGENTS.md"), `---\nname: desk\nnotify: http://127.0.0.1:${port}/hook\nalerts:\n  failure_rate: 50%\n  min_runs: 2\n  run_minutes: 30\n---\n`);
  const run = (id: string, status: RunRecord["status"], minsAgo: number): RunRecord =>
    ({ id, flow: "daily", status, startedAt: iso(minsAgo), finishedAt: status === "running" ? null : iso(minsAgo - 1), steps: [{ agent: "a", instruction: "", group: 1, optional: false, status: status === "running" ? "running" : status, events: [], result: null, costUsd: 0 }] }) as unknown as RunRecord;
  writeRun("acme", "desk", run("run-f1", "failed", 120));
  writeRun("acme", "desk", run("run-f2", "failed", 90));
  writeRun("acme", "desk", run("run-ok", "completed", 60));
  writeRun("acme", "desk", run("run-slow", "running", 45));

  const down = await sweepGatesAndSlas(NOW);
  assert.equal(down.alerted, 0, "the webhook refused: nothing remembered as told");
  assert.equal(await getNotice("acme", "alert", "desk/failure_rate"), null);
  up = true;
  const first = await sweepGatesAndSlas(NOW);
  assert.equal(first.alerted, 2, "the rate (2 of 3 failed) and the slow run");
  assert.deepEqual(got.sort(), ["alert", "alert"]);
  assert.ok((await getNotice("acme", "alert", "desk/failure_rate"))?.payload);
  assert.ok((await getNotice("acme", "alert", "desk/run_minutes/run-slow"))?.payload);
  const again = await sweepGatesAndSlas(NOW + 60_000);
  assert.equal(again.alerted, 0, "not again the same day");
  const tomorrow = await sweepGatesAndSlas(NOW + 25 * 3_600_000);
  assert.equal(tomorrow.alerted, 0, "the next day the runs are older than 24h, and the slow run was told once");
  server.close();
});
