// A process of its own that writes the vault on real Postgres, for
// vault-concurrent-pg.test.ts: several of these at once are several pods.
// Argument: one JSON object. Answers one JSON line on stdout: {retries, ...}.
//   write   {tenant, workspace?, names: [..], startAt}   set each name once
//   rotate  {tenant, name, workspace?, used, next, startAt}   replaceOAuth2RefreshToken
// startAt is an epoch millisecond everyone waits for, so they collide.
// `retries` counts the changes the store ran again after losing the compare-and-set.

import * as s from "../../foldrun-core/src/secrets.ts";
import { pgVaultStore } from "../src/vault-pg.ts";

const a = JSON.parse(process.argv[2]);
const store = pgVaultStore(() => true);
let runs = 0;
let commits = 0;
s.setVaultStore({
  ...store,
  mutate(tenant, workspace, change) {
    commits++;
    return store.mutate(tenant, workspace, (all) => {
      runs++;
      return change(all);
    });
  },
});

const wait = a.startAt - Date.now();
if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);

let result: Record<string, unknown> = {};
if (a.cmd === "write") {
  for (const name of a.names as string[]) s.setSecret(a.tenant, name, `value-of-${name}`, a.workspace);
} else if (a.cmd === "rotate") {
  result = { won: s.replaceOAuth2RefreshToken(a.tenant, a.name, a.workspace, a.used, a.next) };
}
process.stdout.write(JSON.stringify({ retries: runs - commits, ...result }) + "\n");
process.exit(0);
