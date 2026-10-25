// The open engine reaches foldrun's billing and operator tools through one
// door, billing.ts — nothing else in it imports them. That is what lets an
// install be built without them (freeBilling) and what will let those
// modules move to a private repository without the engine noticing.
//
// Billing's modules are listed in billing-boundary-lists.ts (PRIVATE). Since
// stage 2 no file holds both: the engine's half of the ledger, the wallet and
// the operator record live in ledger.ts, limits.ts and admin.ts; the money in
// credits.ts, wallet.ts and operator.ts.
//
//   node --test tests/billing-boundary.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(import.meta.dirname, "..", "src");

import { PRIVATE, importsOf } from "./billing-boundary-lists.ts";


function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}


test("open engine code reaches billing only through billing.ts", () => {
  const breaches: string[] = [];
  for (const file of sources(SRC)) {
    const name = path.relative(SRC, file).replace(/\.ts$/, "");
    if (PRIVATE.has(name)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const imp of importsOf(text)) {
      if (!imp.module.startsWith(".")) continue;
      // Only this repo's own modules: core has files of the same names.
      const resolved = path.resolve(path.dirname(file), imp.module);
      if (path.dirname(resolved) !== SRC && !resolved.startsWith(SRC + path.sep)) continue;
      const target = path.relative(SRC, resolved).replace(/\.ts$/, "");
      if (PRIVATE.has(target)) {
        if (name === "billing" && target === "billing-hosted") continue; // the one wiring
        breaches.push(`${name}.ts imports ${target}.ts`);
        continue;
      }
    }
  }
  assert.deepEqual(breaches, [], `go through billing() in src/billing.ts instead:\n${breaches.join("\n")}`);
});

test("billing's modules are all here or all gone, so the list cannot rot", () => {
  // With foldrun-admin laid over the checkout every module is here; in the
  // public checkout none is, except the stub billing-hosted.ts.
  const present = [...PRIVATE].filter((m) => fs.existsSync(path.join(SRC, `${m}.ts`)));
  const all = [...PRIVATE];
  const publicCheckout = present.length === 1 && present[0] === "billing-hosted";
  assert.ok(publicCheckout || present.length === all.length, `missing: ${all.filter((m) => !present.includes(m)).join(", ")}`);
});

test("the reader sees named, whole, dynamic and bare imports", () => {
  const got = importsOf(`
import { a, type B, c as d } from "./x.ts";
import * as all from "./y.ts";
import def from "./z.ts";
export { e } from "./w.ts";
const m = await import("./v.ts");
import "./u.ts";
`);
  assert.deepEqual(got.find((i) => i.module === "./x.ts")?.names, ["a", "B", "c"]);
  for (const m of ["./y.ts", "./z.ts", "./v.ts", "./u.ts"]) assert.equal(got.find((i) => i.module === m)?.names, "*", m);
  assert.deepEqual(got.find((i) => i.module === "./w.ts")?.names, ["e"]);
});

test("without the hosted wiring, the engine is free: nothing charged, nothing held", async () => {
  const { freeBilling } = await import("../src/billing.ts");
  assert.equal(freeBilling.enabled(), false);
  await freeBilling.assertFunds("acme", { heldUsd: 999, inFlight: 99, expectedUsd: 999, balance: -999 });
  assert.equal(await freeBilling.plan("acme"), null);
  assert.equal(await freeBilling.waive("acme"), null);
  assert.equal(await freeBilling.planStanding("acme"), null);
  assert.equal(await freeBilling.hourly("acme"), "off");
  assert.deepEqual(freeBilling.bootImports(), []);
  assert.equal(freeBilling.trialCredits(), 0);
  assert.equal(await freeBilling.grantTrial("acme"), false);
  assert.equal(await freeBilling.endSupportView("acme", "v1", "op@x.test"), false);
  assert.equal(await freeBilling.liveSupportView("acme", "v1"), null);
  assert.equal(await freeBilling.contactEmail("nobody-here"), null);
});

