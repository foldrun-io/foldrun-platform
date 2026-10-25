// alerts: new_host — the sites each agent has reached, and the news of a new one.
//
//   node --test tests/host-watch.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { noteNewHosts } from "../src/host-watch.ts";
import { getNotice } from "../src/notices.ts";
import type { RunRecord } from "../../foldrun-core/src/store.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-hosts-"));
process.env.FOLDRUN_DATA = root;
const ws = path.join(root, "acme/workspaces/desk");
fs.mkdirSync(ws, { recursive: true });

const run = (id: string, lines: string[]) =>
  ({ id, flow: "daily", status: "completed", startedAt: new Date().toISOString(), finishedAt: null,
     steps: [{ agent: "writer", status: "completed", events: lines.map((text) => ({ t: "", type: "info", text })) }] }) as unknown as RunRecord;

const known = async () => (await getNotice<{ hosts: string[] }>("acme", "hosts", "desk/writer"))?.payload?.hosts ?? null;

test("off unless asked; the first run records; a new site with nobody to tell is not forgotten", async () => {
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
  assert.equal(await noteNewHosts("acme", "desk", run("r0", ["egress: CONNECT pypi.org:443 (5ms)"])), 0);
  assert.equal(await known(), null, "without alerts: new_host nothing is kept");

  fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\nalerts:\n  new_host: true\n---\n");
  assert.equal(await noteNewHosts("acme", "desk", run("r1", ["egress: CONNECT pypi.org:443 (5ms)"])), 0, "the first run is not news");
  assert.deepEqual(await known(), ["pypi.org"]);

  assert.equal(await noteNewHosts("acme", "desk", run("r2", ["egress: CONNECT pypi.org:443 (5ms)"])), 0);
  // No notify: is set, so the alert cannot be told — and the site stays new
  // for next time rather than being silently learned.
  assert.equal(await noteNewHosts("acme", "desk", run("r3", ["egress: CONNECT evil.example:443 (5ms)"])), 0);
  assert.deepEqual(await known(), ["pypi.org"]);
});
