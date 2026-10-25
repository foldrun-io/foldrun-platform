// Scheduled runs wait out the model credential's refresh.
//
// The box refreshes its Claude OAuth token at seven past every fourth hour,
// Sydney time, and the old token dies the moment the new one exists — so a
// step mid-turn then gets a 401. A run that has not started cannot be caught
// out: the 08:00 desks start at 08:12 instead, and nothing else moves.
//
//   node --test tests/scheduler-hold.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FlowInfo } from "../../foldrun-core/src/store.ts";

process.env.FOLDRUN_DATA ??= fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-hold-"));
const { scheduleHold, findDueFlows } = await import("../src/scheduler.ts");

const BOX = {
  FOLDRUN_SCHEDULE_HOLD_CRON: "7 0,4,8,12,16,20 * * *",
  FOLDRUN_SCHEDULE_HOLD_TZ: "Australia/Sydney",
} as NodeJS.ProcessEnv;
// 2026-09-23 is AEST, UTC+10: 08:00 Sydney is 22:00 UTC the day before.
const syd = (hhmm: string) => new Date(`2026-09-23T${hhmm}:00+10:00`);

test("a moment inside the window is held until five minutes after the refresh", () => {
  assert.equal(scheduleHold(syd("08:00"), BOX)?.toISOString(), syd("08:12").toISOString());
  assert.equal(scheduleHold(syd("07:50"), BOX)?.toISOString(), syd("08:12").toISOString(), "17 minutes before");
  assert.equal(scheduleHold(syd("08:11"), BOX)?.toISOString(), syd("08:12").toISOString());
  assert.equal(scheduleHold(syd("16:07"), BOX)?.toISOString(), syd("16:12").toISOString());
});

test("outside the window, and with no window configured, nothing is held", () => {
  assert.equal(scheduleHold(syd("07:49"), BOX), null);
  assert.equal(scheduleHold(syd("08:12"), BOX), null);
  assert.equal(scheduleHold(syd("10:00"), BOX), null);
  assert.equal(scheduleHold(syd("08:00"), {}), null, "a host without the setting holds nothing");
  assert.equal(scheduleHold(syd("08:00"), { FOLDRUN_SCHEDULE_HOLD_CRON: "not a cron" }), null);
});

test("the widths are the host's to set", () => {
  const wide = { ...BOX, FOLDRUN_SCHEDULE_HOLD_BEFORE: "30", FOLDRUN_SCHEDULE_HOLD_AFTER: "10" };
  assert.equal(scheduleHold(syd("07:37"), wide)?.toISOString(), syd("08:17").toISOString());
  assert.equal(scheduleHold(syd("08:16"), wide)?.toISOString(), syd("08:17").toISOString());
  assert.equal(scheduleHold(syd("08:17"), wide), null);
});

test("an 08:00 flow is not consumed at 08:00 and starts at 08:12 — even with catchup: none", () => {
  const saved = { ...process.env };
  Object.assign(process.env, BOX);
  try {
    const flow = {
      name: "daily",
      file: "flows/daily.md",
      trigger: "schedule",
      schedule: "0 8 * * *",
      timezone: "Australia/Sydney",
      catchup: "none",
      overlap: null,
      steps: [{ agent: "writer", instruction: "write it" }],
    } as unknown as FlowInfo;
    const source = () => [{ workspace: "desk", flows: [flow] }];
    const state = { lastFired: { "acme/desk/daily": syd("07:00").toISOString() } as Record<string, string> };

    assert.deepEqual(findDueFlows(syd("08:00"), state, ["acme"], undefined, source), [], "held at 08:00");
    assert.equal(state.lastFired["acme/desk/daily"], syd("07:00").toISOString(), "the fire is not consumed while held");
    assert.deepEqual(findDueFlows(syd("08:11"), state, ["acme"], undefined, source), [], "still held at 08:11");

    const due = findDueFlows(syd("08:12"), state, ["acme"], undefined, source);
    assert.equal(due.length, 1, "starts on the first tick after the window, and catchup: none does not drop it");
    assert.equal(state.lastFired["acme/desk/daily"], syd("08:12").toISOString());
    assert.deepEqual(findDueFlows(syd("08:13"), state, ["acme"], undefined, source), [], "and only once");
  } finally {
    for (const k of Object.keys(BOX)) if (!(k in saved)) delete process.env[k];
  }
});

test("a flow due outside the window is untouched", () => {
  const saved = { ...process.env };
  Object.assign(process.env, BOX);
  try {
    const flow = {
      name: "report", file: "flows/report.md", trigger: "schedule", schedule: "0 10 * * *",
      timezone: "Australia/Sydney", catchup: null, overlap: null, steps: [{ agent: "a", instruction: "b" }],
    } as unknown as FlowInfo;
    const state = { lastFired: { "acme/desk/report": syd("09:00").toISOString() } as Record<string, string> };
    assert.equal(findDueFlows(syd("10:00"), state, ["acme"], undefined, () => [{ workspace: "desk", flows: [flow] }]).length, 1);
  } finally {
    for (const k of Object.keys(BOX)) if (!(k in saved)) delete process.env[k];
  }
});
