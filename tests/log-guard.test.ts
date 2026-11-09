// FOL-121: no account content in a platform log line — platform's server
// code under core's log guard (foldrun-core/scripts/log-guard.mjs). A raw
// console call prints literals only; what a line says about a run, a
// workspace or a failure goes through opsLog/opsError (core src/ops-log.ts).
//
//   node --test tests/log-guard.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// @ts-expect-error — a plain .mjs script, no declarations
import { scanSource, compareBaseline, format } from "../../foldrun-core/scripts/log-guard.mjs";
import fs from "node:fs";

type Found = { file: string; line: number; fp: string; why: string; text: string };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Not platform log lines, so not scanned. */
const SKIP: Record<string, string> = {
  // foldrun-admin's overlay of the hosted billing (skip-worktree): its copy
  // here is not this repository's, and the boundary covers it at run time.
  "src/billing-hosted.ts": "laid over by foldrun-admin",
};

/** Calls that were there on 5 Nov 2026 and print to a person's terminal,
 *  not to a pod's log: fingerprint → why. Only ever shrinks. */
const BASELINE: Record<string, Record<string, string>> = {
  "src/egress-keys.ts": { cf2b01a8d793: "`--print` writes the derived keys to the operator's own terminal; never run in a pod" },
};

/** The repository's own source files: what CI sees, not the admin overlay
 *  (its files are .gitignore'd here). */
function trackedSources(): string[] {
  const out = execFileSync("git", ["ls-files", "src"], { cwd: root, encoding: "utf8" });
  return out.split("\n").filter((f) => /\.(ts|mts|mjs|js)$/.test(f) && !/\.d\.ts$/.test(f) && !SKIP[f] && fs.existsSync(path.join(root, f)));
}

// Which files are the repository's own needs git. The check scripts'
// scratch copies (without-billing-check.sh, foldrun-admin check.sh) carry no
// .git; there it is skipped, saying so — CI and the git hooks run it in a
// checkout.
const inGit = (() => {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("platform's server code: no raw console call prints a value, every ops event is a literal", { skip: !inGit && "not a git checkout (a check script's scratch copy)" }, () => {
  const found: Found[] = trackedSources().flatMap((f) => scanSource(fs.readFileSync(path.join(root, f), "utf8"), f));
  const baseline = Object.fromEntries(Object.entries(BASELINE).map(([f, fps]) => [f, Object.keys(fps)]));
  const { fresh, stale } = compareBaseline(found, baseline);
  assert.equal(fresh.length, 0, `print these through opsLog/opsError (foldrun-core/src/ops-log.ts):\n${format(fresh)}`);
  assert.deepEqual(stale, [], "gone from the source: remove from BASELINE");
});

test("every hosted entry point imports the log boundary first", () => {
  for (const entry of ["src/worker.ts", "src/egress.ts", "src/assistant-worker.ts"]) {
    const src = fs.readFileSync(path.join(root, entry), "utf8");
    const first = /^import\s[^;]*?;|^import\s+"[^"]+";/m.exec(src);
    assert.equal(first?.[0], 'import "./ops-boot.ts";', `${entry}: the first import must be ./ops-boot.ts`);
  }
  const boot = fs.readFileSync(path.join(root, "src/ops-boot.ts"), "utf8");
  for (const name of ["worker.ts", "egress.ts", "assistant-worker.ts"]) assert.ok(boot.includes(`"${name}"`), `ops-boot.ts installs for ${name}`);
});

test("metrics carry numbers under fixed names and label values — nothing an account wrote", async () => {
  const { roomMetricsText } = await import("../src/room-metrics.ts");
  const { billingMetricsText } = await import("../src/billing-metrics.ts");
  const lines = [...roomMetricsText(), ...(await billingMetricsText())];
  assert.ok(lines.length > 0);
  for (const l of lines) {
    if (l.startsWith("# ")) {
      assert.match(l, /^# (HELP|TYPE) foldrun_[a-z_]+ /, l);
      continue;
    }
    assert.match(l, /^foldrun_[a-z_]+(\{level="(run|workspace|account|node|turn)"\})? -?\d+(\.\d+)?(e[-+]?\d+)?$/, l);
  }
});
