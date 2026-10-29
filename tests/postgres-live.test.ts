// The database layer against a real Postgres.
//
// Everything else in this suite runs on the file stores. This is the one
// place the Drizzle queries meet the database they were written for, and it
// runs only when one is offered:
//
//   docker run -d --rm -e POSTGRES_PASSWORD=test -e POSTGRES_USER=foldrun \
//     -e POSTGRES_DB=foldrun -p 55432:5432 postgres:16-alpine
//   FOLDRUN_TEST_DATABASE_URL=postgres://foldrun:test@localhost:55432/foldrun npm test
//
// Without the variable every case is skipped, and says so. The tables are
// truncated at the start, so this is not a database anyone keeps.

import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { takeTurnsOnLiveDb } from "./live-db-lock.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
const opts = { skip: url ? false : "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" };
takeTurnsOnLiveDb(url);

if (url) {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  process.env.FOLDRUN_SECRET_KEY ??= "test-install-key";
}

test("the baseline migrates a fresh database once, and again is a no-op", opts, async () => {
  const { migrate, orm } = await import("../src/db.ts");
  // Every table in the schema, read from the database — not a list kept by
  // hand, which forgot backups and every table after it (0012 onward) and
  // left a reused database failing "relation already exists".
  await orm()!.execute(`DO $$ DECLARE t text; BEGIN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = current_schema() LOOP
      EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', t);
    END LOOP; END $$`);
  const applied = await migrate();
  assert.equal(applied[0], "0000_baseline");
  assert.ok(applied.includes("0002_ledger_keys"), "every file in drizzle/ is applied in name order");
  assert.deepEqual(await migrate(), []);
});

test("the queue: priority first, then round-robin across accounts, a cap that steps over", opts, async () => {
  const q = await import("../src/queue-db.ts");
  const { orm } = await import("../src/db.ts");
  await orm()!.execute("TRUNCATE queue");
  await q.enqueueDb({ tenant: "a", workspace: "w", runId: "r1", tags: ["x"] });
  await q.enqueueDb({ tenant: "a", workspace: "w", runId: "r2" });
  await q.enqueueDb({ tenant: "b", workspace: "w", runId: "r3" });
  await q.enqueueDb({ tenant: "c", workspace: "w", runId: "r4", priority: 10 });
  assert.equal((await q.statsDb()).pending, 4);
  assert.equal((await q.claimNextDb("w1"))?.runId, "r4", "the high lane first");
  const second = await q.claimNextDb("w1");
  assert.equal(second?.runId, "r1", "then a's first");
  assert.deepEqual(second?.tags, ["x"]);
  assert.equal((await q.claimNextDb("w1"))?.runId, "r3", "b's first before a's second");
  assert.equal(await q.claimedCountDb("a", "r1"), 0, "a's other claimed runs, not counting the one asking");
  assert.equal(await q.claimedCountDb("a", "none"), 1);
  await q.releaseDb("r1", "w1");
  assert.equal(await q.hasJobDb("r1"), false);
  await q.releaseDb("r3", "someone-else");
  assert.equal(await q.hasJobDb("r3"), true, "not our claim: kept");
  await orm()!.execute("UPDATE queue SET claimed_at = now() - interval '1 hour' WHERE run_id = 'r3'");
  assert.equal(await q.recoverStaleDb(60_000), 1);
  assert.equal(await q.removeDb("r2"), true);
  assert.equal(await q.removeDb("r2"), false);
  await q.enqueueDb({ tenant: "a", workspace: "w", runId: "r5", accountCap: 1 });
  await q.enqueueDb({ tenant: "a", workspace: "w", runId: "r6", accountCap: 1 });
  assert.equal((await q.claimNextDb("w2"))?.runId, "r3");
  assert.equal((await q.claimNextDb("w2"))?.runId, "r5");
  assert.equal(await q.claimNextDb("w2"), null, "a is at its cap: r6 stepped over");
  await q.enqueueDb({ tenant: "a", workspace: "w2", runId: "r4", notBefore: new Date(Date.now() + 3600_000).toISOString() });
  assert.equal((await q.statsDb()).scheduledAhead, 1, "a re-enqueue is an upsert, and a wait: parks in the queue");
  // A stop takes the job and learns whether a worker held it.
  assert.deepEqual(await q.takeJobDb("r5"), { claimed: true });
  assert.deepEqual(await q.takeJobDb("r6"), { claimed: false });
  assert.equal(await q.takeJobDb("r6"), null);
});

test("the queue: weighted fair share — a fast lane gets more of a contended fleet, never all of it", opts, async () => {
  const q = await import("../src/queue-db.ts");
  const { orm } = await import("../src/db.ts");
  await orm()!.execute("TRUNCATE queue");
  for (const id of ["h1", "h2", "h3", "h4"]) await q.enqueueDb({ tenant: "fast", workspace: "w", runId: id, priority: 10, accountWeight: 3 });
  for (const id of ["n1", "n2"]) await q.enqueueDb({ tenant: "norm", workspace: "w", runId: id, accountWeight: 2 });
  const order: string[] = [];
  for (let i = 0; i < 6; i++) order.push((await q.claimNextDb("w1"))!.runId);
  // Strict priority would have been h1 h2 h3 h4 n1 n2: the normal account
  // waiting behind the whole fast lane. Shares: fast 1/3 per claim, norm 1/2.
  assert.deepEqual(order, ["h1", "n1", "h2", "n2", "h3", "h4"]);
  // a job queued before the weight existed (NULL) is normal
  await orm()!.execute("TRUNCATE queue");
  await q.enqueueDb({ tenant: "old", workspace: "w", runId: "o1" });
  await orm()!.execute("UPDATE queue SET account_weight = NULL");
  assert.equal((await q.claimNextDb("w1"))?.runId, "o1");
});

test("the queue: an account whose run just finished does not outrank another's first on priority", opts, async () => {
  const q = await import("../src/queue-db.ts");
  const { orm } = await import("../src/db.ts");
  await orm()!.execute("TRUNCATE queue");
  for (const id of ["h1", "h2", "h3"]) await q.enqueueDb({ tenant: "fast", workspace: "w", runId: id, priority: 10, accountWeight: 3 });
  await q.enqueueDb({ tenant: "norm", workspace: "w", runId: "n1", accountWeight: 2 });
  // one slot: the fast lane's runs go one at a time
  assert.equal((await q.claimNextDb("w1"))?.runId, "h1");
  await q.releaseDb("h1", "w1");
  // counting only what is claimed, fast was back at nothing and its priority
  // won again — n1 waited behind the whole fast queue
  assert.equal((await q.claimNextDb("w1"))?.runId, "n1", "every account's first before anyone's second");
});

test("the queue: a job that has waited long enough goes ahead of fresh first jobs", opts, async () => {
  const q = await import("../src/queue-db.ts");
  const { orm } = await import("../src/db.ts");
  await orm()!.execute("TRUNCATE queue");
  // an account's third job, queued half an hour ago
  for (const id of ["o1", "o2", "o3"]) await q.enqueueDb({ tenant: "old", workspace: "w", runId: id, accountWeight: 2 });
  await orm()!.execute("DELETE FROM queue WHERE run_id IN ('o1', 'o2')");
  await orm()!.execute("UPDATE queue SET enqueued_at = now() - interval '30 minutes' WHERE run_id = 'o3'");
  // against a stream of other accounts' first jobs, just in
  for (const t of ["a", "b", "c"]) await q.enqueueDb({ tenant: t, workspace: "w", runId: `${t}1`, accountWeight: 2 });
  assert.equal((await q.claimNextDb("w1"))?.runId, "o3", "three turns of waiting outweigh its place in the queue");
});

test("the queue: a resume asked for while the run is claimed survives the release", opts, async () => {
  const q = await import("../src/queue-db.ts");
  const { orm } = await import("../src/db.ts");
  await orm()!.execute("TRUNCATE queue");
  assert.equal(await q.lineUpDb({ tenant: "a", workspace: "w", runId: "p1" }), "inserted");
  assert.equal(await q.lineUpDb({ tenant: "a", workspace: "w", runId: "p1" }), "present", "one job per run");
  assert.equal((await q.claimNextDb("w1"))?.runId, "p1");
  // The run parks; the approval lands before the worker lets the claim go.
  assert.equal(await q.lineUpDb({ tenant: "a", workspace: "w", runId: "p1" }), "flagged");
  await q.releaseDb("p1", "w1");
  assert.equal(await q.hasJobDb("p1"), true, "put back, not deleted");
  assert.equal((await q.statsDb()).pending, 1);
  // Claimed again, the flag is spent: a plain release now deletes.
  assert.equal((await q.claimNextDb("w2"))?.runId, "p1");
  await q.releaseDb("p1", "w2");
  assert.equal(await q.hasJobDb("p1"), false);
});

test("the queue: a slot's release cannot take the row another slot of the same worker re-claimed", opts, async () => {
  const q = await import("../src/queue-db.ts");
  const { claimNext } = await import("../src/queue.ts");
  const { orm } = await import("../src/db.ts");
  await orm()!.execute("TRUNCATE queue");
  await q.enqueueDb({ tenant: "a", workspace: "w", runId: "s1" });
  const first = (await claimNext())!;
  // Deferred (overlap:, the cap): handed back, and before the first slot's
  // finally runs, this same worker's next tick claims it again.
  await q.enqueueDb({ tenant: "a", workspace: "w", runId: "s1" });
  const second = (await claimNext())!;
  assert.equal(second.job.runId, "s1");
  await first.release();
  assert.equal(await q.hasJobDb("s1"), true, "the first slot's release is not the second's claim");
  await second.touch();
  await second.release();
  assert.equal(await q.hasJobDb("s1"), false);
});

test("recovery lines up a queued run that has no row, once its record has sat still", opts, async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { writeRun, runFilePath } = await import("../../foldrun-core/src/store.ts");
  const { recoverQueue } = await import("../src/queue.ts");
  const q = await import("../src/queue-db.ts");
  const { orm } = await import("../src/db.ts");
  await orm()!.execute("TRUNCATE queue");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-recover-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    fs.mkdirSync(path.join(root, "acme/workspaces/desk"), { recursive: true });
    fs.writeFileSync(path.join(root, "acme/workspaces/desk/AGENTS.md"), "---\nname: desk\n---\n");
    const run = (id: string) => ({ id, flow: "f", tags: [], status: "queued" as const, startedAt: new Date().toISOString(), finishedAt: null, steps: [] });
    writeRun("acme", "desk", run("run-stranded") as never);
    writeRun("acme", "desk", run("run-young") as never);
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(runFilePath("acme", "desk", "run-stranded"), old, old);
    const { requeued } = await recoverQueue();
    assert.ok(requeued.includes("run-stranded"), "a queued run with no row gets one");
    assert.equal(await q.hasJobDb("run-stranded"), true);
    assert.equal(await q.hasJobDb("run-young"), false, "a record written a moment ago is an enqueue in flight");
    assert.equal((await recoverQueue()).requeued.includes("run-stranded"), false, "and only once");
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the ledger: a run is charged once, money is exact, a transaction sees its own line", opts, async () => {
  const l = await import("../src/ledger-db.ts");
  const { orm, tx } = await import("../src/db.ts");
  await orm()!.execute("TRUNCATE ledger");
  await l.appendDb("t", { t: "2026-09-01T00:00:00.000Z", kind: "topup", usd: 20 });
  const run = { t: "2026-09-02T00:00:00.000Z", kind: "run" as const, usd: -1.234567, cost: 0.5, workspace: "w", runId: "r1", meter: { steps: 2, computeSecs: 3 } };
  await l.appendDb("t", run);
  await l.appendDb("t", run);
  const entries = await l.readLedgerDb("t");
  assert.equal(entries.length, 2);
  assert.equal(entries[1].usd, -1.234567);
  assert.deepEqual(entries[1].meter, { steps: 2, computeSecs: 3 });
  // A transaction sees its own line before it commits. (The balance summed
  // over these lines is billing's: postgres-live-billing.test.ts.)
  const seen = await tx(async (t) => {
    await l.appendDb("t", { t: "2026-09-03T00:00:00.000Z", kind: "adjustment", usd: -0.765433, note: "x" }, t);
    return (await t.execute("SELECT count(*)::int AS n FROM ledger WHERE tenant = 't'")).rows?.[0] as { n: number } | undefined;
  });
  assert.equal(seen?.n, 3, "the transaction reads its own uncommitted line");
  assert.equal((await l.readLedgerDb("t")).length, 3, "and committed with it");
  assert.equal((await l.backfillLedger("t", entries)).inserted, 0, "backfill is idempotent");
});

test("the ledger: once is the index's decision — a run twice a millisecond apart, two accruals in one instant", opts, async () => {
  const l = await import("../src/ledger-db.ts");
  const { orm } = await import("../src/db.ts");
  await orm()!.execute("TRUNCATE ledger");
  // Two settles of one run from two pods: different `at`, one row. Under
  // the old key (which included `at`) both landed.
  assert.equal(await l.appendDb("t", { t: "2026-09-02T00:00:00.000Z", kind: "run", usd: -1, workspace: "w", runId: "r1" }), true);
  assert.equal(await l.appendDb("t", { t: "2026-09-02T00:00:00.001Z", kind: "run", usd: -1, workspace: "w", runId: "r1" }), false);
  // The base fee and the storage accrual for one sweep: same instant, no
  // run, two keys — two rows. Under the old key the second was eaten.
  const now = "2026-09-02T01:00:00.000Z";
  assert.equal(await l.appendDb("t", { t: now, kind: "adjustment", usd: -1, note: "base fee 2026-09-02", key: "accrual:base-fee:2026-09-02" }), true);
  assert.equal(await l.appendDb("t", { t: now, kind: "adjustment", usd: -0.5, note: "storage 1.00GB 2026-09-02", key: "accrual:storage:2026-09-02" }), true);
  assert.equal(await l.appendDb("t", { t: "2026-09-02T02:00:00.000Z", kind: "adjustment", usd: -1, note: "base fee 2026-09-02", key: "accrual:base-fee:2026-09-02" }), false, "the same day's fee again is refused whatever the instant");
  // Several lots expiring in one pass, each its own key.
  for (const lot of ["2025-01-01T00:00:00.000Z", "2025-02-01T00:00:00.000Z"]) {
    assert.equal(await l.appendDb("t", { t: now, kind: "expire", usd: -1, note: `expired purchased ${lot}`, key: `expire:purchased ${lot}` }), true);
  }
  assert.equal((await l.readLedgerDb("t")).length, 5);
  assert.equal(await l.runChargedDb("t", "r1"), true);
  assert.equal(await l.runChargedDb("t", "r2"), false);
});

test("the ledger: attribution columns round-trip, so spend history and rollover read the same on Postgres", opts, async () => {
  const l = await import("../src/ledger-db.ts");
  const { orm } = await import("../src/db.ts");
  await orm()!.execute("TRUNCATE ledger");
  const run = {
    t: "2026-09-02T00:00:00.000Z", kind: "run" as const, usd: -2, cost: 1, workspace: "w", runId: "r1", flow: "nightly",
    split: { modelUsd: 1.5, computeUsd: 0.5, networkUsd: 0 }, agents: { writer: 1.5, editor: 0.5 }, waived: ["network" as const],
  };
  await l.appendDb("t", run);
  await l.appendDb("t", { t: "2026-09-03T00:00:00.000Z", kind: "grant", usd: 30, note: "plan:starter · inv_1", carriedUsd: 1, key: "grant:inv_1" });
  const [charge, grant] = await l.readLedgerDb("t");
  assert.equal(charge.flow, "nightly");
  assert.deepEqual(charge.split, run.split);
  assert.deepEqual(charge.agents, run.agents);
  assert.deepEqual(charge.waived, ["network"]);
  assert.equal(charge.key, "run:r1");
  assert.equal(grant.carriedUsd, 1);
  assert.equal(grant.key, "grant:inv_1");
  // A line from before keys existed backfills under the derived key and
  // is refused the second time — the migration derives the same key.
  const legacy = { t: "2026-01-01T00:00:00.000Z", kind: "adjustment" as const, usd: -1, note: "base fee 2026-01-01" };
  assert.equal((await l.backfillLedger("t", [legacy])).inserted, 1);
  assert.equal((await l.backfillLedger("t", [legacy])).inserted, 0);
  const [{ key }] = await orm()!.execute<{ key: string }>(
    "SELECT 'row:' || kind || ':' || to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') || ':' || coalesce(run_id, '') || ':' || md5(coalesce(note, '')) AS key FROM ledger WHERE note = 'base fee 2026-01-01'",
  ).then((r) => r.rows);
  assert.equal(key, l.entryKey(legacy), "SQL and code derive the same key for a legacy row");
});

test("users: upsert by id, import leaves existing rows alone, email is unique whatever its case", opts, async () => {
  const u = await import("../src/users-db.ts");
  const { orm } = await import("../src/db.ts");
  await orm()!.execute("TRUNCATE users");
  const base = { id: "u1", email: "A@x.com", tenant: "t", salt: "s", createdAt: "2026-01-01T00:00:00.000Z" };
  await u.upsertUserDb({ ...base, hash: "h", owner: true, workspaces: ["w"] });
  await u.upsertUserDb({ ...base, hash: "h2", owner: true, workspaces: null, mfaBackup: ["abc"] });
  const rows = await u.allUsersDb();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hash, "h2");
  assert.equal(rows[0].workspaces, undefined);
  assert.deepEqual(rows[0].mfaBackup, ["abc"]);
  assert.equal(await u.importUsersToDatabase([{ ...base, hash: "OLD" }, { id: "u2", email: "b@x.com", tenant: "t", salt: "s", hash: "h", createdAt: "2026-01-02T00:00:00.000Z" }]), 1);
  assert.equal((await u.allUsersDb()).find((x) => x.id === "u1")?.hash, "h2", "an import never reverts a password");
  await assert.rejects(u.upsertUserDb({ id: "u3", email: "a@X.COM", tenant: "t", salt: "s", hash: "h", createdAt: "2026-01-03T00:00:00.000Z" }), (e: { cause?: { code?: string } }) => e.cause?.code === "23505");
  await u.deleteUserDb("u2");
  assert.equal((await u.allUsersDb()).length, 1);
});

test("tenant keys: minted once across replicas, loaded at boot, destroyed exactly once", opts, async () => {
  const k = await import("../src/tenant-keys.ts");
  const { orm } = await import("../src/db.ts");
  await orm()!.execute("TRUNCATE tenant_keys");
  assert.equal(await k.ensureTenantKey("t"), true);
  assert.equal(await k.ensureTenantKey("t"), false);
  assert.equal(await k.loadTenantKeys(), 1);
  assert.equal(await k.destroyTenantKey("t"), true);
  assert.equal(await k.destroyTenantKey("t"), false);
});

test("reservations: two admissions for one account are serialised by the database, and the second reads the first's hold", opts, async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { orm } = await import("../src/db.ts");
  const l = await import("../src/ledger-db.ts");
  const r = await import("../src/reservations.ts");
  await orm()!.execute("TRUNCATE ledger, reservations");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-pg-reserve-"));
  const prev = { FOLDRUN_DATA: process.env.FOLDRUN_DATA, FOLDRUN_BILLING: process.env.FOLDRUN_BILLING, FOLDRUN_MAX_RUN_EXPOSURE: process.env.FOLDRUN_MAX_RUN_EXPOSURE };
  process.env.FOLDRUN_DATA = root;
  process.env.FOLDRUN_BILLING = "1";
  process.env.FOLDRUN_MAX_RUN_EXPOSURE = "0.5";
  try {
    fs.mkdirSync(path.join(root, "t/workspaces/w"), { recursive: true });
    fs.writeFileSync(path.join(root, "t/workspaces/w/AGENTS.md"), "---\nname: w\nbudget: 5/day\n---\n");
    // Credit enough that only the $5/day cap can refuse: with a $1 top-up the
    // balance was -$3.99 and the funds gate refused all six before the cap
    // was ever asked, so this case tested the wrong gate and failed.
    await l.appendDb("t", { t: new Date().toISOString(), kind: "topup", usd: 10 });
    await l.appendDb("t", { t: new Date().toISOString(), kind: "run", usd: -4.99, workspace: "w", runId: "earlier" });
    const burst = await Promise.allSettled(Array.from({ length: 6 }, () => r.reserveAdmission("t", "w", "hook")));
    assert.equal(burst.filter((x) => x.status === "fulfilled").length, 1, "the budget: $4.99 spent, and the first hold puts the rest over");
    assert.equal(burst.filter((x) => x.status === "rejected" && (x.reason as { status?: number }).status === 402).length, 5);
    assert.equal((await r.heldUsd("t")).usd, 0.5);
    // The hold is the run's once it exists, and goes when its cost lands.
    // (The funds gate's own burst is billing's: postgres-live-billing.)
    const [id] = burst.filter((x) => x.status === "fulfilled").map((x) => (x as PromiseFulfilledResult<string>).value);
    await r.bindReservation("t", id, "run-1");
    assert.equal((await r.reservationTotals()).usd, 0.5);
    await r.releaseReservation("t", "run-1");
    assert.equal((await r.heldUsd("t")).count, 0);
  } finally {
    for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// cli_logins and oauth_pending: "used once" holds under a race, and the
// secrets they carry are never stored in the clear.
async function freshShortLived() {
  const { migrate, orm } = await import("../src/db.ts");
  await migrate();
  await orm()!.execute("TRUNCATE cli_logins, oauth_pending");
  return orm()!;
}

test("a decided cli login is collected exactly once, even by two polls at the same moment", opts, async () => {
  await freshShortLived();
  const s = await import("../src/short-lived-db.ts");
  const expiresAt = new Date(Date.now() + 60_000);
  const base = { hostname: "laptop", status: "pending" as const, createdAt: new Date(), expiresAt };
  assert.equal(await s.insertCliLoginDb({ ...base, id: "id-1", code: "ABCD-EFGH" }), true);
  assert.equal(await s.insertCliLoginDb({ ...base, id: "id-2", code: "ABCD-EFGH" }), false, "a taken code is refused, not duplicated");
  assert.deepEqual(await s.pollCliLoginDb("id-1"), { state: "pending" });
  assert.equal((await s.findCliLoginByCodeDb("ABCD-EFGH"))?.hostname, "laptop");
  assert.equal(await s.decideCliLoginDb("ABCD-EFGH", "approved", { key: "sealed", tenant: "a" }), true);
  assert.equal(await s.decideCliLoginDb("ABCD-EFGH", "denied", null), false, "decided once");
  const [a, b] = await Promise.all([s.pollCliLoginDb("id-1"), s.pollCliLoginDb("id-1")]);
  const decided = [a, b].filter((x) => x.state === "decided");
  assert.equal(decided.length, 1, "exactly one poll gets the key");
  assert.deepEqual(await s.pollCliLoginDb("id-1"), { state: "expired" }, "and it is gone after");
});

// FOL-94: a person wins the request BEFORE a key exists, so two approvals
// at once mint one key; a claimed request is still pending to the CLI.
test("an approval claims the cli login first: one of two claims wins, and the poll waits for the key", opts, async () => {
  await freshShortLived();
  const s = await import("../src/short-lived-db.ts");
  const base = { hostname: "laptop", status: "pending" as const, createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) };
  assert.equal(await s.insertCliLoginDb({ ...base, id: "id-c", code: "CLAI-MMED" }), true);
  const wins = await Promise.all([s.claimCliLoginDb("CLAI-MMED"), s.claimCliLoginDb("CLAI-MMED")]);
  assert.deepEqual(wins.filter(Boolean).length, 1, "exactly one approval goes on to mint");
  assert.deepEqual(await s.pollCliLoginDb("id-c"), { state: "pending" }, "claimed, not yet decided");
  assert.equal(await s.decideCliLoginDb("CLAI-MMED", "denied", null), false, "a claimed request is not denied under the claimer");
  await s.unclaimCliLoginDb("CLAI-MMED");
  assert.equal((await s.findCliLoginByCodeDb("CLAI-MMED"))?.status, "pending", "a failed mint gives the claim back");
  assert.equal(await s.claimCliLoginDb("CLAI-MMED"), true);
  assert.equal(await s.decideCliLoginDb("CLAI-MMED", "approved", { key: "sealed", tenant: "a" }), true);
  const got = await s.pollCliLoginDb("id-c");
  assert.equal(got.state, "decided");
});

test("expired cli logins are swept and never found", opts, async () => {
  const q = await freshShortLived();
  const s = await import("../src/short-lived-db.ts");
  await s.insertCliLoginDb({ id: "old", code: "OLDD-CODE", hostname: "h", status: "pending", createdAt: new Date(), expiresAt: new Date(Date.now() - 1000) });
  assert.equal(await s.findCliLoginByCodeDb("OLDD-CODE"), null);
  assert.equal(await s.decideCliLoginDb("OLDD-CODE", "approved", {}), false);
  assert.equal(await s.sweepCliLoginsDb(), 0);
  const rows = await q.execute("SELECT count(*)::int AS n FROM cli_logins");
  assert.equal((rows.rows[0] as { n: number }).n, 0);
});

test("an oauth consent is parked with its client secret encrypted and taken once", opts, async () => {
  const q = await freshShortLived();
  const { startOAuthConnect, completeOAuthConnect } = await import("../src/oauth-connect.ts");
  const config = { authorize_url: "https://p.test/auth", token_url: "https://127.0.0.1:9/token", client_id: "cid", client_secret: "TOP-SECRET-VALUE", scopes: "" };
  const { nonce } = await startOAuthConnect("acme", "ADS_TOKEN", config, "https://dash/cb");
  const stored = await q.execute(`SELECT payload::text AS p FROM oauth_pending WHERE nonce = '${nonce}'`);
  const text = (stored.rows[0] as { p: string }).p;
  assert.ok(!text.includes("TOP-SECRET-VALUE"), "the client secret is not in the row in the clear");
  const s = await import("../src/short-lived-db.ts");
  const [a, b] = await Promise.all([s.takeOAuthPendingDb(nonce), s.takeOAuthPendingDb(nonce)]);
  assert.equal([a, b].filter(Boolean).length, 1, "two callbacks with one nonce: exactly one wins");
  await assert.rejects(completeOAuthConnect(nonce, "code", "https://dash/cb"), /expired or was already used/);
});

test("secret health: concurrent writers all count, an acceptance clears, the import keeps newer rows", opts, async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { migrate, orm } = await import("../src/db.ts");
  await migrate();
  await orm()!.execute("TRUNCATE secret_health");
  const { secretHealthDbStore: s, importSecretHealthFile } = await import("../src/secret-health-db.ts");
  const t0 = Date.now();
  const use = (status: number, i: number) => ({ key: "account:K", use: { host: "api.x", status, at: new Date(t0 + i).toISOString() } });
  // Twenty refusals from twenty writers at once — the file store lost these.
  await Promise.all(Array.from({ length: 20 }, (_, i) => s.apply("acme", [use(401, i)])));
  assert.equal((await s.read("acme"))["account:K"].refusals, 20);
  await s.apply("acme", [use(200, 100)]);
  const ok = (await s.read("acme"))["account:K"];
  assert.equal(ok.refusals, 0, "an acceptance clears the run");
  assert.equal(ok.lastAccepted, new Date(t0 + 100).toISOString());
  await s.apply("acme", [use(500, 200)]);
  assert.equal((await s.read("acme"))["account:K"].lastAccepted, new Date(t0 + 100).toISOString(), "an error keeps the last success");
  // The import fills what the table lacks and never reverts a row.
  // Its own data root, like the other cases here: FOLDRUN_DATA is set by
  // `npm test` but not by `node --test tests/postgres-live.test.ts`.
  const os = await import("node:os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-secret-health-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    const dir = path.join(root, "acme");
    fs.mkdirSync(dir, { recursive: true });
    const old = { last: { at: "2026-01-01T00:00:00.000Z", host: "old", status: 401, outcome: "refused" }, refusals: 9, lastAccepted: null };
    fs.writeFileSync(path.join(dir, "secret-health.json"), JSON.stringify({ "account:K": old, "account:OTHER": old }));
    assert.equal(await importSecretHealthFile("acme"), 1, "only the key the table lacked");
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal((await s.read("acme"))["account:K"].refusals, 0, "the newer row was kept");
  await s.forget("acme", "account:OTHER");
  assert.equal((await s.read("acme"))["account:OTHER"], undefined);
});

test("api keys: found by hash, revoked for their own account only, and an import never un-revokes", opts, async () => {
  const { migrate, orm } = await import("../src/db.ts");
  await migrate();
  await orm()!.execute("TRUNCATE api_keys");
  const k = await import("../src/api-keys-db.ts");
  const row = (id: string, tenant: string, hash: string) => ({ id, hash, prefix: "mda_" + id, label: "ci", tenant, createdAt: new Date().toISOString(), revokedAt: null, role: "editor" as const, workspaces: ["blog"] });
  await k.insertApiKeyDb(row("a1", "acme", "h1"));
  await k.insertApiKeyDb(row("b1", "beta", "h2"));
  await assert.rejects(k.insertApiKeyDb(row("a2", "acme", "h1")), "a hash is unique across every account");
  assert.deepEqual((await k.findApiKeyByHashDb("h1"))?.workspaces, ["blog"]);
  assert.equal(await k.findApiKeyByHashDb("nope"), null);
  assert.equal(await k.revokeApiKeyDb("beta", "a1"), false, "another account cannot revoke it");
  assert.equal(await k.hasActiveKeysDb("acme"), true);
  assert.equal(await k.revokeApiKeyDb("acme", "a1"), true);
  assert.equal(await k.hasActiveKeysDb("acme"), false);
  // keys.json still holds a1 unrevoked, plus one new key: the import adds the new one only.
  const added = await k.importApiKeysDb([row("a1", "acme", "h1"), row("a3", "acme", "h3")]);
  assert.equal(added, 1);
  assert.ok((await k.findApiKeyByHashDb("h1"))?.revokedAt, "still revoked");
  assert.deepEqual((await k.listApiKeysDb("acme")).map((r) => r.id).sort(), ["a1", "a3"]);
});

test("oauth: clients round-trip sealed, and a dead grant hit by many steps at once is announced once", opts, async () => {
  const { migrate, orm } = await import("../src/db.ts");
  await migrate();
  await orm()!.execute("TRUNCATE oauth_clients, oauth_connections");
  const c = await import("../src/oauth-clients.ts");
  const cfg = { authorize_url: "https://p.test/auth", token_url: "https://p.test/token", client_id: "cid", client_secret: "TOP-SECRET", scopes: "" };
  await c.saveOAuthClient("acme", "prov", cfg);
  const raw = await orm()!.execute("SELECT record::text AS r FROM oauth_clients WHERE key = 'prov'");
  assert.ok(!(raw.rows[0] as { r: string }).r.includes("TOP-SECRET"), "the client secret is stored encrypted");
  assert.equal((await c.getOAuthClient("acme", "prov"))?.client_secret, "TOP-SECRET");
  assert.deepEqual((await c.listOAuthClients("acme")).map((x) => x.name), ["prov"]);

  // Many failing steps at once: exactly one of them is "the first" and notifies.
  const { keyedStore } = await import("../src/keyed-store.ts");
  const { oauthConnections } = await import("../src/schema.ts");
  const store = keyedStore<Record<string, unknown>>(oauthConnections, () => "/nonexistent");
  await store.put("acme", "@account/LI", { name: "LI", client: "prov", connectedAt: "2026-01-01T00:00:00.000Z" });
  let firsts = 0;
  await Promise.all(Array.from({ length: 10 }, () =>
    store.update("acme", "@account/LI", (r) => {
      if (r!.notifiedAt) return { ...r!, lastError: "invalid_grant" };
      firsts++;
      return { ...r!, lastError: "invalid_grant", notifiedAt: new Date().toISOString() };
    }),
  ));
  assert.equal(firsts, 1, "decided under the row's lock");
  assert.equal(await c.deleteOAuthClient("acme", "prov"), true);
  assert.equal(await c.deleteOAuthClient("acme", "prov"), false);
});

// Against local-kms too (the box runs it; AWS runs the real thing):
//   docker run -d --rm -p 58080:8080 -e KMS_SEED_PATH=/init/seed.yaml -v <dir>:/init nsmithuk/local-kms
//   FOLDRUN_TEST_KMS_URL=http://localhost:58080 FOLDRUN_TEST_KMS_KEY=alias/foldrun-test
const kmsUrl = process.env.FOLDRUN_TEST_KMS_URL;
test("kms: env-sealed account keys move to KMS, open without the install key, and cannot be swapped between accounts", { skip: url && kmsUrl ? false : "set FOLDRUN_TEST_DATABASE_URL and FOLDRUN_TEST_KMS_URL" }, async () => {
  const { migrate, orm } = await import("../src/db.ts");
  await migrate();
  await orm()!.execute("TRUNCATE tenant_keys");
  const k = await import("../src/tenant-keys.ts");
  const saved = { root: process.env.FOLDRUN_ROOT_KEY, id: process.env.FOLDRUN_KMS_KEY_ID, ep: process.env.AWS_ENDPOINT_URL_KMS, region: process.env.AWS_REGION, ak: process.env.AWS_ACCESS_KEY_ID, sk: process.env.AWS_SECRET_ACCESS_KEY, key: process.env.FOLDRUN_SECRET_KEY };
  try {
    k.forgetTenantKeys();
    process.env.FOLDRUN_ROOT_KEY = "env";
    assert.equal(await k.ensureTenantKey("acme"), true);
    assert.equal(await k.ensureTenantKey("beta"), true);
    const acmeKey = k.tenantKey("acme")!;
    const read = async (t: string) => ((await orm()!.execute(`SELECT wrapped FROM tenant_keys WHERE tenant = '${t}'`)).rows[0] as { wrapped: string }).wrapped;
    assert.ok((await read("acme")).startsWith("env:"));

    Object.assign(process.env, { FOLDRUN_ROOT_KEY: "kms", FOLDRUN_KMS_KEY_ID: process.env.FOLDRUN_TEST_KMS_KEY ?? "alias/foldrun-test", AWS_ENDPOINT_URL_KMS: kmsUrl, AWS_REGION: "ap-southeast-2", AWS_ACCESS_KEY_ID: "local", AWS_SECRET_ACCESS_KEY: "local" });
    assert.deepEqual(await k.rewrapTenantKeys(), { moved: 2, unreadable: [] });
    assert.ok((await read("acme")).startsWith("kms:"));
    assert.deepEqual(await k.rewrapTenantKeys(), { moved: 0, unreadable: [] }, "idempotent");

    // The install key is no longer needed to open the account keys.
    delete process.env.FOLDRUN_SECRET_KEY;
    k.forgetTenantKeys();
    assert.equal(await k.loadTenantKeys(), 2);
    assert.ok(k.tenantKey("acme")!.equals(acmeKey), "the same data key, now sealed by KMS");

    // acme's sealed key pasted onto beta's row: KMS refuses it under beta's name.
    await orm()!.execute(`UPDATE tenant_keys SET wrapped = (SELECT wrapped FROM tenant_keys WHERE tenant = 'acme') WHERE tenant = 'beta'`);
    k.forgetTenantKeys();
    assert.equal(await k.loadTenantKeys(), 1, "beta's swapped key does not open");
    assert.equal(k.tenantKey("beta"), null);

    assert.equal(await k.ensureTenantKey("gamma"), true);
    assert.ok((await read("gamma")).startsWith("kms:"), "new accounts are sealed by KMS from the start");
  } finally {
    for (const [name, v] of Object.entries({ FOLDRUN_ROOT_KEY: saved.root, FOLDRUN_KMS_KEY_ID: saved.id, AWS_ENDPOINT_URL_KMS: saved.ep, AWS_REGION: saved.region, AWS_ACCESS_KEY_ID: saved.ak, AWS_SECRET_ACCESS_KEY: saved.sk, FOLDRUN_SECRET_KEY: saved.key })) v === undefined ? delete process.env[name] : (process.env[name] = v);
    k.forgetTenantKeys();
  }
});

test("platform records: flow cursors, notices, shares and operator state are rows, imported once from the files", opts, async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { orm } = await import("../src/db.ts");
  await orm()!.execute("TRUNCATE flow_state, notices, shares, operator_accounts, audit_log");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-records-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "storage"), { recursive: true });
    fs.writeFileSync(path.join(ws, "storage", "cover.jpg"), "IMG");

    // The files a box left behind, in their old shapes.
    fs.writeFileSync(path.join(root, "schedule.json"), JSON.stringify({ lastFired: { "acme/desk/nightly": "2026-09-20T01:00:00.000Z" }, watches: { "acme/desk/watch": { checkedAt: "2026-09-20T02:00:00.000Z", hash: "h1" } } }));
    fs.writeFileSync(path.join(root, "triggers.json"), JSON.stringify({ lastRun: { "acme/desk/nightly": 1000 }, pending: { "acme/desk/hook": { firesAt: 5000, body: "b", tag: "t", count: 2 } }, quarantined: { "acme/desk/broken": 2000 } }));
    fs.writeFileSync(path.join(root, "watchdog.json"), JSON.stringify({ budget: { "acme/desk": { month: "2026-09", mark: 0.8 } }, sla: { "acme/desk/run-1": 3000 }, providers: { acme: { checkedAt: 4000, results: [], reported: [] } } }));
    fs.writeFileSync(path.join(root, "shares.json"), JSON.stringify([{ token: "tok1", tenant: "acme", workspace: "desk", path: "storage/cover.jpg", contentType: "image/jpeg", createdAt: "2026-09-20T00:00:00.000Z", expiresAt: null, createdBy: null, revokedAt: null }]));
    fs.mkdirSync(path.join(root, "operator/accounts"), { recursive: true });
    fs.writeFileSync(path.join(root, "operator/accounts/acme.json"), JSON.stringify({ notes: "pilot", updatedAt: "2026-09-20T00:00:00.000Z", updatedBy: "ops" }));
    fs.writeFileSync(path.join(root, "operator/audit.jsonl"), JSON.stringify({ t: "2026-09-20T00:00:00.000Z", by: "ops", tenant: "acme", action: "notes" }) + "\n");

    const { importFlowStateFiles, loadScheduleState, getCursor, heldBursts, quarantinedFlows } = await import("../src/flow-state.ts");
    const { importWatchdogFile, getNotice } = await import("../src/notices.ts");
    const { importSharesFile, resolveShare, createShare, listShares, revokeShare } = await import("../src/shares.ts");
    const { importOperatorFiles, adminState, updateAdminState } = await import("../src/admin.ts");
    const { auditLog } = await import("../src/schema.ts");
    const { and, desc, eq, like } = await import("drizzle-orm");
    // Newest first, without the prefix: what the hosted console lists.
    const readAudit = async (tenant: string) =>
      (await orm()!.select().from(auditLog).where(and(eq(auditLog.tenant, tenant), like(auditLog.action, "operator.%"))).orderBy(desc(auditLog.at), desc(auditLog.id))).map((r) => ({ action: r.action.replace(/^operator\./, "") }));

    assert.equal(await importFlowStateFiles(), 5);
    assert.equal(await importWatchdogFile(), 3);
    assert.equal(await importSharesFile(), 1);
    assert.deepEqual(await importOperatorFiles(), { accounts: 1, audit: 1 });
    for (const f of ["schedule.json", "triggers.json", "watchdog.json", "shares.json", "operator"]) {
      assert.ok(!fs.existsSync(path.join(root, f)), `${f} is renamed after import`);
    }
    // Again is a no-op: the files are gone and nothing is doubled.
    assert.equal(await importFlowStateFiles(), 0);
    assert.deepEqual(await importOperatorFiles(), { accounts: 0, audit: 0 });

    const sched = await loadScheduleState();
    assert.equal(sched.lastFired["acme/desk/nightly"], "2026-09-20T01:00:00.000Z");
    assert.deepEqual(sched.watches?.["acme/desk/watch"], { checkedAt: "2026-09-20T02:00:00.000Z", hash: "h1" });
    assert.deepEqual(await getCursor("acme", "desk", "nightly"), { lastRunAt: 1000 });
    assert.equal((await heldBursts())[0]?.pending.count, 2);
    assert.equal((await quarantinedFlows())[0]?.flow, "broken");
    assert.deepEqual((await getNotice("acme", "budget", "desk"))?.payload, { month: "2026-09", mark: 0.8 });
    assert.equal((await getNotice("acme", "sla", "desk/run-1"))?.payload, 3000);
    assert.ok(await resolveShare("tok1"), "the imported link still resolves");
    assert.equal((await adminState<{ notes?: string }>("acme")).notes, "pilot", "a field the console keeps survives the import");
    assert.deepEqual((await readAudit("acme")).map((e) => e.action), ["notes"]);

    // And the live paths: a share minted and revoked as rows; an operator
    // change and its audit line in one transaction; undefined lifts a field.
    const minted = await createShare("acme", "desk", "storage/cover.jpg");
    assert.equal((await listShares("acme", "desk")).length, 2);
    assert.equal(await revokeShare("acme", minted.token), true);
    assert.equal(await revokeShare("acme", minted.token), false);
    assert.equal(await resolveShare(minted.token), null);
    await updateAdminState("acme", { suspended: { at: "2026-09-21T00:00:00Z", by: "ops", reason: "chargeback" } }, "ops", "suspend");
    assert.equal((await adminState("acme")).suspended?.reason, "chargeback");
    await updateAdminState("acme", { suspended: undefined }, "ops", "restore");
    assert.equal((await adminState("acme")).suspended, undefined, "undefined lifts the suspension in jsonb too");
    assert.deepEqual((await readAudit("acme")).map((e) => e.action), ["restore", "suspend", "notes"]);
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("webhooks and mail choices: deliveries are claimed once, attempts append, endpoints and preferences are rows", opts, async () => {
  const wd = await import("../src/webhook-deliveries.ts");
  const p = await import("../src/email-preferences.ts");
  const { orm } = await import("../src/db.ts");
  const { webhookDeliveries } = await import("../src/schema.ts");
  const tenant = `hooks-${Date.now()}`;
  const now = Date.now();
  const row = (id: string, due: number | null) => ({
    id, tenant, workspace: "desk", event: "failed", status: "pending", body: "{}", destination: "x", attempts: 1,
    attemptLog: [{ n: 1, at: new Date(now).toISOString(), statusCode: 500, durationMs: 3, response: "down", error: "HTTP 500" }],
    nextAttemptAt: due === null ? null : new Date(due),
  });
  await orm()!.insert(webhookDeliveries).values([row(`${tenant}-a`, now - 1000), row(`${tenant}-b`, now + 3600_000)]);
  // Two sweeps at once: the due row is claimed by exactly one. The receiver
  // is unset (no notify: for this tenant), so the attempt fails with a reason.
  const [x, y] = await Promise.all([wd.sweepWebhookDeliveries(now), wd.sweepWebhookDeliveries(now)]);
  assert.equal(x + y, 1, "claimed once");
  const a = (await wd.getDelivery(tenant, "desk", `${tenant}-a`))!;
  assert.equal(a.attempts, 2);
  assert.deepEqual(a.attemptLog.map((l) => l.n), [1, 2], "appended in SQL, not overwritten");
  assert.equal(a.status, "pending");
  assert.ok(a.nextAttemptAt && Date.parse(a.nextAttemptAt) > now + 4 * 60_000, "five minutes on");
  const page = await wd.listDeliveries(tenant, "desk", { status: "pending", limit: 1 });
  assert.equal(page.total, 2);
  assert.equal(page.deliveries.length, 1);

  assert.equal(await wd.noteEndpointResult(tenant, "ep", false, now - 4 * 86400_000), null);
  assert.equal(await wd.noteEndpointResult(tenant, "ep", false, now), "disabled");
  assert.ok(await wd.endpointDisabled(tenant, "ep"));
  assert.equal(await wd.noteEndpointResult(tenant, "ep", true, now, true), "enabled");

  await p.setPreference(tenant, "Me@Example.test", "run-alerts", false);
  await p.setPreference(tenant, "me@example.test", "run-alerts", true, { workspace: "desk" });
  assert.equal(await p.mailAllowed(tenant, "me@example.test", "run-alerts", "desk"), true);
  assert.equal(await p.mailAllowed(tenant, "me@example.test", "run-alerts", "other"), false);
  await assert.rejects(p.setPreference(tenant, "me@example.test", "billing", false), /cannot be turned off/);
  await p.setPreference(tenant, "me@example.test", "run-alerts", true);
  assert.equal((await p.listPreferences(tenant, "me@example.test")).length, 1, "on for the account clears the workspace rows");

  await wd.deleteTenantDeliveries(tenant);
  await p.deleteTenantPreferences(tenant);
  assert.equal((await wd.listDeliveries(tenant, "desk")).total, 0);
});

test("webhooks: the stored attempt log keeps the last twelve, as the file store does", opts, async () => {
  const wd = await import("../src/webhook-deliveries.ts");
  const { orm } = await import("../src/db.ts");
  const { webhookDeliveries } = await import("../src/schema.ts");
  const { eq } = await import("drizzle-orm");
  const tenant = `hooklog-${Date.now()}`;
  const now = Date.now();
  const id = `${tenant}-a`;
  const log = Array.from({ length: 12 }, (_, i) => ({ n: i + 1, at: new Date(now - (12 - i) * 60_000).toISOString(), statusCode: 500, durationMs: 3, response: "down", error: "HTTP 500" }));
  await orm()!.insert(webhookDeliveries).values({
    id, tenant, workspace: "desk", event: "failed", status: "pending", body: "{}", destination: "x", attempts: 12, attemptLog: log, nextAttemptAt: new Date(now - 1000),
  });
  assert.equal(await wd.sweepWebhookDeliveries(now), 1);
  const [stored] = await orm()!.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id));
  const ns = (stored.attemptLog as { n: number }[]).map((a) => a.n);
  assert.deepEqual(ns, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], "the oldest dropped in SQL, the newest kept");
  await wd.deleteTenantDeliveries(tenant);
});

test("feature flags: rows decide in order, tenant-delete takes an account's", opts, async () => {
  // Writing a decision is the hosted console's (foldrun-admin flags-admin.ts);
  // here the rows are put in place directly and read back.
  const f = await import("../src/flags.ts");
  const { orm } = await import("../src/db.ts");
  const { featureFlags } = await import("../src/schema.ts");
  const { eq } = await import("drizzle-orm");
  await orm()!.delete(featureFlags).where(eq(featureFlags.flag, "example-flag"));
  f.resetFlagCache();
  const tenant = `flags-${Date.now()}`;
  const put = async (t: string, enabled: boolean | null, rollout: number | null) => {
    await orm()!.insert(featureFlags).values({ flag: "example-flag", tenant: t, enabled, rollout, updatedBy: "root@test", updatedAt: new Date() })
      .onConflictDoUpdate({ target: [featureFlags.flag, featureFlags.tenant], set: { enabled, rollout } });
    f.resetFlagCache();
  };
  assert.equal(await f.flagOn(tenant, "example-flag"), false, "the default");
  await put("", null, 100);
  assert.equal(await f.flagOn(tenant, "example-flag"), true, "the rollout");
  await put("", false, 100);
  assert.equal(await f.flagOn(tenant, "example-flag"), false, "install-wide off");
  await put(tenant, true, null);
  assert.equal(await f.flagOn(tenant, "example-flag"), true, "the account's own");
  await f.deleteTenantFlags(tenant);
  assert.equal(await f.flagOn(tenant, "example-flag"), false, "back to the install-wide off");
  await orm()!.delete(featureFlags).where(eq(featureFlags.flag, "example-flag"));
  f.resetFlagCache();
});

test("API usage: pods' sums add up in one row, the window and a route's callers read back, warnings mark once, tenant-delete takes them", opts, async () => {
  const u = await import("../src/api-usage.ts");
  const tenant = `usage-${Date.now()}`;
  const now = new Date();
  u.resetApiUsageForTests();
  u.recordApiCall({ tenant, version: "2026-10-01", at: now });
  await u.flushApiUsage();
  // A second pod's flush of the same row adds, it does not replace.
  u.recordApiCall({ tenant, version: "2026-10-01", at: now });
  u.recordApiCall({ tenant, version: "2026-10-01", at: now });
  u.recordApiCall({ tenant, version: "2026-10-01", route: "DELETE /api/old", credential: 'key "ci" (fr_x…)', at: now });
  await u.flushApiUsage();
  const usage = await u.apiUsageFor(tenant, 30, now);
  assert.equal(usage.versions[0].requests, 4);
  assert.deepEqual(usage.deprecated.map((d) => [d.route, d.requests, d.callers[0].credential]), [["DELETE /api/old", 1, 'key "ci" (fr_x…)']]);
  assert.ok((await u.callersOf("DELETE /api/old", 30, now)).has(tenant));
  await u.markNoticesSent(tenant, "DELETE /api/old", ["seen", "90d"]);
  await u.markNoticesSent(tenant, "DELETE /api/old", ["90d"]);
  assert.deepEqual([...(await u.noticesSent(tenant, "DELETE /api/old"))].sort(), ["90d", "seen"]);
  await u.deleteApiUsageFor(tenant);
  assert.equal((await u.apiUsageFor(tenant, 30, now)).versions.length, 0);
  assert.equal((await u.noticesSent(tenant, "DELETE /api/old")).size, 0);
});

// 27 Oct 2026: FoldrunQueueStuck reads how long the least recently renewed
// claim has gone unrenewed — the driver's heartbeat resets it, so a long,
// healthy run never ages it, and an unrenewed one does.
test("the queue: the oldest claim's age is time since its last renewal", opts, async () => {
  const q = await import("../src/queue-db.ts");
  const { orm } = await import("../src/db.ts");
  await orm()!.execute(`TRUNCATE queue`);
  assert.equal((await q.statsDb()).oldestClaimSecs, null, "no claim, no age");
  await q.lineUpDb({ tenant: "a", workspace: "w", runId: "s1" });
  await q.lineUpDb({ tenant: "b", workspace: "w", runId: "s2" });
  assert.equal((await q.claimNextDb("w1"))?.runId, "s1");
  assert.equal((await q.claimNextDb("w1"))?.runId, "s2");
  await orm()!.execute(`UPDATE queue SET claimed_at = now() - interval '25 minutes' WHERE run_id = 's1'`);
  await orm()!.execute(`UPDATE queue SET claimed_at = now() - interval '3 minutes' WHERE run_id = 's2'`);
  const aged = (await q.statsDb()).oldestClaimSecs!;
  assert.ok(aged >= 1499 && aged <= 1510, `the least recently renewed claim: ${aged}`);
  await q.touchClaimDb("s1", "w1");
  const renewed = (await q.statsDb()).oldestClaimSecs!;
  assert.ok(renewed >= 179 && renewed <= 190, `s1 renewed, s2's three minutes are the oldest now: ${renewed}`);
  await q.releaseDb("s1", "w1");
  await q.releaseDb("s2", "w1");
});

test("a named lock: one holder at a time across connections, the pool free inside it, a stuck holder times the next out", opts, async () => {
  const { withNamedLock, tx } = await import("../src/db.ts");
  const order: string[] = [];
  const hold = (who: string, ms: number) =>
    withNamedLock("live-test-lock", async () => {
      order.push(`${who}:in`);
      // The pool is usable while the lock is held (it is not on a pooled connection).
      await tx(async (t) => t.execute(sql`SELECT 1`));
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${who}:out`);
    });
  await Promise.all([hold("a", 300), new Promise((r) => setTimeout(r, 50)).then(() => hold("b", 10))]);
  assert.deepEqual(order, ["a:in", "a:out", "b:in", "b:out"], "b waited for a");
  // Another name is not held up.
  await withNamedLock("live-test-lock", async () => {
    await withNamedLock("live-test-other", async () => undefined);
    await assert.rejects(withNamedLock("live-test-lock", async () => undefined, 300), /lock timeout/, "the same name times out instead of hanging");
  });
});

test("appendAll: every entry lands, or none does when one's key is already there", opts, async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const { appendAll, readLedger } = await import("../src/ledger.ts");
  process.env.FOLDRUN_DATA = fs.mkdtempSync(`${os.tmpdir()}/foldrun-appendall-`);
  fs.mkdirSync(`${process.env.FOLDRUN_DATA}/appendall/workspaces`, { recursive: true });
  const at = new Date().toISOString();
  const line = (key: string, usd: number) => ({ t: at, kind: "adjustment" as const, usd, note: key, key });
  assert.equal(await appendAll("appendall", [line("aa-1", 1), line("aa-2", 2)]), true);
  assert.equal(await appendAll("appendall", [line("aa-3", 3), line("aa-1", 1)]), false, "aa-1 is there: the set is refused");
  const keys = (await readLedger("appendall")).map((e) => e.key).sort();
  assert.deepEqual(keys, ["aa-1", "aa-2"], "aa-3 did not land without aa-1");
});

