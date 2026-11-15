// The mirror loop's backoff (15 Nov 2026): staging's assistant failed every
// workspace every 3 s for a day — ~595,000 log lines — because nothing slowed
// a loop whose every pass failed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { nextMirrorDelay, withJitter } from "../src/mirror-backoff.ts";

const BASE = 3000;
const MAX = 60_000;

test("a pass where every workspace failed doubles the wait, up to the cap", () => {
  let d = BASE;
  const seen: number[] = [];
  for (let i = 0; i < 7; i++) {
    d = nextMirrorDelay(d, BASE, MAX, { failed: 20, total: 20 });
    seen.push(d);
  }
  assert.deepEqual(seen, [6000, 12_000, 24_000, 48_000, 60_000, 60_000, 60_000]);
});

test("a pass that threw before it could count backs off the same way", () => {
  assert.equal(nextMirrorDelay(BASE, BASE, MAX, null), 6000);
  assert.equal(nextMirrorDelay(48_000, BASE, MAX, null), MAX);
});

test("one pass that is not all failures goes straight back to the normal pace", () => {
  assert.equal(nextMirrorDelay(MAX, BASE, MAX, { failed: 0, total: 20 }), BASE);
  // Some failures, some healthy workspaces: the healthy ones stay current.
  assert.equal(nextMirrorDelay(BASE, BASE, MAX, { failed: 1, total: 40 }), BASE);
  assert.equal(nextMirrorDelay(24_000, BASE, MAX, { failed: 39, total: 40 }), BASE);
});

test("an account with no workspaces is not a failure", () => {
  assert.equal(nextMirrorDelay(BASE, BASE, MAX, { failed: 0, total: 0 }), BASE);
});

test("jitter keeps the wait between half and all of it", () => {
  assert.equal(withJitter(60_000, () => 0), 30_000);
  assert.equal(withJitter(60_000, () => 0.999999), 60_000);
  for (let i = 0; i < 1000; i++) {
    const j = withJitter(12_000);
    assert.ok(j >= 6000 && j <= 12_000, String(j));
  }
});
