// 27 Oct 2026: a run waiting an hour for room to start is told to its
// workspace's notify: once — whether it waits in a driver or in the queue.
//
//   node --test tests/room-watchdog.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-room-"));
delete process.env.FOLDRUN_DATABASE_URL;
const { sweepGatesAndSlas } = await import("../src/watchdog.ts");
const { getNotice } = await import("../src/notices.ts");
const { workspaceDir, writeRun } = await import("../../foldrun-core/src/store.ts");
import type { RunRecord } from "../../foldrun-core/src/store.ts";

const NOW = Date.now();
const iso = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();

test("an hour waiting for room is told once; a shorter wait is not; a failed send is not remembered", async () => {
  const dir = workspaceDir("acme", "desk");
  fs.mkdirSync(path.join(dir, "agents", "a"), { recursive: true });
  const got: { status: string; summary: string; runId: string }[] = [];
  let up = false;
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      if (up) got.push(JSON.parse(b));
      res.writeHead(up ? 200 : 500).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  fs.writeFileSync(path.join(dir, "AGENTS.md"), `---\nname: desk\nnotify: http://127.0.0.1:${port}/hook\n---\n`);
  const run = (id: string, status: RunRecord["status"], stepStatus: string, waitedMins: number): RunRecord =>
    ({
      id, flow: "daily", status, startedAt: iso(waitedMins + 1), finishedAt: null,
      ...(status === "queued" ? { parkedAt: iso(1) } : {}),
      steps: [{
        agent: "a", instruction: "", group: 1, optional: false, status: stepStatus, events: [], result: null, costUsd: 0,
        roomWait: { since: iso(waitedMins), why: "the account's pool is full", cpus: 2, memGiB: 4 },
      }],
    }) as unknown as RunRecord;
  writeRun("acme", "desk", run("run-parked", "queued", "pending", 70));
  writeRun("acme", "desk", run("run-driver", "running", "running", 65));
  writeRun("acme", "desk", run("run-short", "queued", "pending", 20));
  try {
    const down = await sweepGatesAndSlas(NOW);
    assert.equal(down.roomWaits, 0, "the webhook refused: nothing remembered as told");
    up = true;
    const first = await sweepGatesAndSlas(NOW);
    assert.equal(first.roomWaits, 2, "the parked run and the one waiting in its driver");
    assert.deepEqual(got.map((g) => g.runId).sort(), ["run-driver", "run-parked"]);
    assert.ok(got.every((g) => g.status === "room" && /has waited \d+ minutes — the account's pool is full/.test(g.summary)));
    assert.ok(await getNotice("acme", "room", "desk/run-parked"));
    const again = await sweepGatesAndSlas(NOW + 60_000);
    assert.equal(again.roomWaits, 0, "once per run");
  } finally {
    server.close();
  }
});
