// Cron across daylight saving: a time the clocks skip fires once, after the
// gap; a time they repeat fires once, the first time (Vixie cron's rules).
// Australia/Sydney: back an hour at 03:00 on 5 April 2026, forward an hour
// at 02:00 on 4 October 2026.
//
//   node --test tests/scheduler-dst.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { cronMatches, lastFireIn, nextFire, parseCron } from "../src/scheduler.ts";

const TZ = "Australia/Sydney";

/** Every fire the scheduler makes between two instants, ticking each minute
 *  the way findDueFlows consumes lastFireIn: a fire moves the cursor. */
function fires(expr: string, from: string, to: string): string[] {
  const cron = parseCron(expr)!;
  let last = new Date(from);
  const out: string[] = [];
  for (let t = last.getTime() + 60_000; t <= new Date(to).getTime(); t += 60_000) {
    const now = new Date(t);
    const hit = lastFireIn(cron, last, now, TZ);
    if (hit) {
      out.push(hit.toISOString());
      last = now;
    }
  }
  return out;
}

test("the repeated hour fires once, at its first occurrence (5 April 2026)", () => {
  // 02:30 happens at 15:30Z (AEDT) and again at 16:30Z (AEST).
  assert.deepEqual(fires("30 2 * * *", "2026-04-04T12:00:00Z", "2026-04-05T12:00:00Z"), ["2026-04-04T15:30:00.000Z"]);
  assert.deepEqual(fires("0 2 * * *", "2026-04-04T12:00:00Z", "2026-04-05T12:00:00Z"), ["2026-04-04T15:00:00.000Z"]);
  // An hour outside the fold is untouched: 03:30 AEST.
  assert.deepEqual(fires("30 3 * * *", "2026-04-04T12:00:00Z", "2026-04-05T12:00:00Z"), ["2026-04-04T17:30:00.000Z"]);
  // And the preview agrees: the next 02:30 after the first is the next day's.
  assert.equal(nextFire(parseCron("30 2 * * *")!, new Date("2026-04-04T15:31:00Z"), TZ)?.toISOString(), "2026-04-05T16:30:00.000Z");
});

test("the skipped hour fires once, at the first instant after the gap (4 October 2026)", () => {
  // 02:00–02:59 never happens: 01:59 AEST is followed by 03:00 AEDT (16:00Z).
  assert.deepEqual(fires("30 2 * * *", "2026-10-03T12:00:00Z", "2026-10-04T12:00:00Z"), ["2026-10-03T16:00:00.000Z"]);
  assert.deepEqual(fires("15,45 2 * * *", "2026-10-03T12:00:00Z", "2026-10-04T12:00:00Z"), ["2026-10-03T16:00:00.000Z"], "several skipped times are one fire");
  assert.equal(nextFire(parseCron("30 2 * * *")!, new Date("2026-10-03T12:00:00Z"), TZ)?.toISOString(), "2026-10-03T16:00:00.000Z");
  // 03:00 itself is real, and fires once.
  assert.deepEqual(fires("0 3 * * *", "2026-10-03T12:00:00Z", "2026-10-04T12:00:00Z"), ["2026-10-03T16:00:00.000Z"]);
  // The day after, 02:30 is back at its usual instant.
  assert.deepEqual(fires("30 2 * * *", "2026-10-04T12:00:00Z", "2026-10-05T12:00:00Z"), ["2026-10-04T15:30:00.000Z"]);
});

test("a wildcard job follows the clock as it is, through both changes", () => {
  // Every half hour: the repeated hour's two real half hours both run...
  const back = fires("*/30 * * * *", "2026-04-04T14:59:00Z", "2026-04-04T17:00:00Z");
  assert.deepEqual(back, ["2026-04-04T15:00:00.000Z", "2026-04-04T15:30:00.000Z", "2026-04-04T16:00:00.000Z", "2026-04-04T16:30:00.000Z", "2026-04-04T17:00:00.000Z"]);
  // ...and the skipped hour's are simply not there.
  assert.equal(cronMatches(parseCron("30 * * * *")!, new Date("2026-10-03T16:00:00Z"), TZ), false);
});

test("an ordinary day and an ordinary zone are unchanged", () => {
  assert.deepEqual(fires("30 2 * * *", "2026-06-01T00:00:00Z", "2026-06-02T00:00:00Z"), ["2026-06-01T16:30:00.000Z"]);
  const utc = parseCron("0 9 * * 1")!;
  assert.equal(nextFire(utc, new Date("2026-09-30T00:00:00Z"), "UTC")?.toISOString(), "2026-10-05T09:00:00.000Z");
});
