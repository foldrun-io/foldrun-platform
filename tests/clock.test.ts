// The date an agent is told it is, and the timezone it is told in.
//
// Containers run UTC. A Sydney desk publishing at 9am local was told it was
// still yesterday, and an article stamped with the real date was refused as
// "one day in the future". `timezone:` in AGENTS.md is how a workspace says
// which calendar it lives on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCron, cronMatches } from "../src/scheduler.ts";
import { resolveTimezone, localDate } from "../../foldrun-core/src/runner.ts";

// 2026-08-31T23:30Z is already 1 September in Sydney (UTC+10).
const late = new Date("2026-08-31T23:30:00Z");

test("localDate is the calendar date in the zone, not UTC", () => {
  assert.equal(localDate("UTC", late), "2026-08-31");
  assert.equal(localDate("Australia/Sydney", late), "2026-09-01");
  assert.equal(localDate("America/Los_Angeles", late), "2026-08-31");
});

test("timezone: in AGENTS.md wins; unset is UTC; an unknown name falls back to UTC", () => {
  const prior = process.env.FOLDRUN_TIMEZONE;
  delete process.env.FOLDRUN_TIMEZONE;
  try {
    assert.equal(resolveTimezone({ timezone: "Australia/Sydney" }), "Australia/Sydney");
    assert.equal(resolveTimezone({ timezone: "  Europe/London " }), "Europe/London");
    assert.equal(resolveTimezone({}), "UTC");
    assert.equal(resolveTimezone({ timezone: 42 }), "UTC");
    assert.equal(resolveTimezone({ timezone: "Mars/Olympus_Mons" }), "UTC");
    process.env.FOLDRUN_TIMEZONE = "Asia/Tokyo";
    assert.equal(resolveTimezone({}), "Asia/Tokyo", "the platform default applies when the workspace says nothing");
    assert.equal(resolveTimezone({ timezone: "Australia/Perth" }), "Australia/Perth", "but a workspace's own choice still wins");
  } finally {
    if (prior === undefined) delete process.env.FOLDRUN_TIMEZONE;
    else process.env.FOLDRUN_TIMEZONE = prior;
  }
});

test("the zone formatter is reused, so a long cron walk stays cheap", () => {
  // The settings page previews the next fire by walking forty days a minute
  // at a time. `zoned` built a fresh Intl.DateTimeFormat for every one of
  // those 57,600 minutes — and formatter construction, not formatting, is
  // what costs. Eight scheduled flows took tens of seconds of blocked event
  // loop, long enough for a pooled database connection to time out
  // underneath the render, which is how a settings page 500s.
  const cron = parseCron("0 7 * * 2,4,6")!;
  const start = Date.UTC(2026, 8, 1);
  // Count formatters made during the walk instead of timing it: a timing
  // bar measured the machine (632ms on a hosted CI runner, under 100 on a
  // laptop). With the cache it is at most one, for the zone's first use.
  const Real = Intl.DateTimeFormat;
  let made = 0;
  (Intl as { DateTimeFormat: unknown }).DateTimeFormat = new Proxy(Real, {
    construct(target, args) {
      made++;
      return Reflect.construct(target, args);
    },
    apply(target, self, args) {
      made++;
      return Reflect.apply(target, self, args);
    },
  });
  let hits = 0;
  try {
    for (let i = 0; i < 60 * 24 * 40; i++) {
      if (cronMatches(cron, new Date(start + i * 60_000), "Australia/Sydney")) hits++;
    }
  } finally {
    (Intl as { DateTimeFormat: unknown }).DateTimeFormat = Real;
  }
  assert.equal(hits, 17, "three mornings a week over forty days");
  assert.ok(made <= 1, `${made} formatters made for one zone over 57,600 minutes — is the formatter cache gone?`);
});
