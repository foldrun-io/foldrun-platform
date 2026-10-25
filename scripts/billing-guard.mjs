#!/usr/bin/env node
// Billing stays out of this public repository.
//
//   node scripts/billing-guard.mjs --staged       what is about to be committed (pre-commit)
//   node scripts/billing-guard.mjs [<rev>]        a commit, default HEAD (pre-push, CI)
//
// Refuses a tracked path that is billing's — a module in PRIVATE or a test in
// BILLING_TESTS (tests/billing-boundary-lists.ts) — and a src/billing-hosted.ts
// that is not exactly HOSTED_STUB. A hosted checkout has foldrun-admin laid
// over it (overlay.sh): those files are .gitignore'd and billing-hosted.ts is
// skip-worktree there, but neither is a guard; this is.

import { execFileSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const { PRIVATE, BILLING_TESTS, HOSTED_STUB } = await import(path.join(root, "tests/billing-boundary-lists.ts"));
const git = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8", maxBuffer: 64 << 20 });

const staged = process.argv.includes("--staged");
const rev = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "HEAD";
const files = (staged ? git("ls-files", "-z") : git("ls-tree", "-r", "-z", "--name-only", rev)).split("\0").filter(Boolean);
const where = staged ? "staged" : rev;

const billing = files.filter((f) => {
  const m = /^src\/([^/]+)\.ts$/.exec(f);
  if (m && PRIVATE.has(m[1]) && m[1] !== "billing-hosted") return true;
  const t = /^tests\/([^/]+)$/.exec(f);
  return Boolean(t && BILLING_TESTS.has(t[1]));
});
const problems = billing.map((f) => `${f} is billing's (foldrun-admin), not this repository's`);
let stub = null;
try {
  stub = git("show", `${staged ? "" : rev}:src/billing-hosted.ts`);
} catch {
  problems.push("src/billing-hosted.ts is missing");
}
if (stub !== null && stub !== HOSTED_STUB) problems.push("src/billing-hosted.ts is not the public stub — the hosted wiring belongs to foldrun-admin");

if (problems.length) {
  console.error(`billing-guard (${where}):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`billing-guard (${where}): no billing among ${files.length} files`);
