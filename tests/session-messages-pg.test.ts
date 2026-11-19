// Session messages on Postgres (session-messages.ts): send, list, claim by
// one turn only, bind, free, a lapsed claim, the waiting cap, deletes.
// Runs only when a database is offered:
//
//   FOLDRUN_TEST_DATABASE_URL=postgres://foldrun:test@localhost:55432/foldrun npm test
//
// The table comes from the migrations (drizzle/0067).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { takeTurnsOnLiveDb } from "./live-db-lock.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
takeTurnsOnLiveDb(url);

if (!url) {
  test("pg session messages (set FOLDRUN_TEST_DATABASE_URL to run)", { skip: "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" }, () => {});
} else {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  const T = `sm-${Date.now().toString(36)}`;
  before(async () => {
    const { migrate } = await import("../src/db.ts");
    await migrate();
  });
  after(async () => {
    const { deleteTenantSessionMessages } = await import("../src/session-messages.ts");
    await deleteTenantSessionMessages(T);
    await deleteTenantSessionMessages(`${T}-b`);
    const { db } = await import("../src/db.ts");
    await db()?.end();
  });
  const sm = () => import("../src/session-messages.ts");
  const send = async (context: string, text: string, workspace = "desk", tenant = T) =>
    (await sm()).sendSessionMessage({ tenant, workspace, context, sender: "user:ana", senderName: "Ana", fromContext: "code-a", text });

  test("a message waits for its conversation only; listed oldest first", async () => {
    const a = await send("code-b", "first");
    const b = await send("code-b", "second");
    await send("code-c", "not yours");
    await send("code-b", "other project", "desk2");
    await send("code-b", "other account", "desk", `${T}-b`);
    const { listSessionMessages } = await sm();
    const waiting = await listSessionMessages(T, "desk", "code-b", { waiting: true });
    assert.deepEqual(waiting.map((m) => m.id), [a.id, b.id]);
    assert.equal(waiting[0]!.from, "Ana");
    assert.equal(waiting[0]!.fromContext, "code-a");
    assert.equal(waiting[0]!.run, undefined);
  });

  test("claim: one turn takes a message; a second claim of it is refused; bind makes it the run's; free puts it back", async () => {
    const { claimSessionMessages, bindSessionMessages, freeSessionMessages, listSessionMessages } = await sm();
    const m1 = await send("code-d", "one");
    const m2 = await send("code-d", "two");
    const other = await send("code-e", "elsewhere");
    const [x, y] = await Promise.all([
      claimSessionMessages(T, "desk", "code-d", [m1.id, m2.id, other.id, "sm-nope"], "tok-x"),
      claimSessionMessages(T, "desk", "code-d", [m1.id], "tok-y"),
    ]);
    const takenTotal = x.taken.length + y.taken.length;
    assert.equal(takenTotal, 2, "each message is taken once, by one turn");
    assert.ok(x.refused.includes(other.id), "another conversation's message is refused");
    assert.ok(x.refused.includes("sm-nope"));
    assert.deepEqual(await listSessionMessages(T, "desk", "code-d", { waiting: true }), [], "claimed ones do not wait");
    await bindSessionMessages(T, "tok-x", "run-x");
    await freeSessionMessages(T, "tok-y");
    const all = await listSessionMessages(T, "desk", "code-d");
    for (const m of all) {
      if (x.taken.some((t) => t.id === m.id)) {
        assert.equal(m.run, "run-x");
        assert.ok(m.usedAt);
      }
    }
    // A freed claim (tok-y's, if it took m1) waits again; a bound one never is freed.
    await freeSessionMessages(T, "tok-x");
    const waitingAgain = await listSessionMessages(T, "desk", "code-d", { waiting: true });
    assert.deepEqual(waitingAgain.map((m) => m.id), y.taken.map((m) => m.id));
  });

  test("free by ids puts back only those; a bound claim is freed only with bound (its run was undone); claimedRunOf names the run", async () => {
    const { claimSessionMessages, bindSessionMessages, freeSessionMessages, listSessionMessages, claimedRunOf } = await sm();
    const a = await send("code-i", "a");
    const b = await send("code-i", "b");
    await claimSessionMessages(T, "desk", "code-i", [a.id, b.id], "tok-i");
    await freeSessionMessages(T, "tok-i", { ids: [b.id] });
    assert.deepEqual((await listSessionMessages(T, "desk", "code-i", { waiting: true })).map((m) => m.id), [b.id], "only the one that did not fit waits again");
    assert.equal(await claimedRunOf(T, "tok-i"), null);
    await bindSessionMessages(T, "tok-i", "run-i");
    assert.equal(await claimedRunOf(T, "tok-i"), "run-i");
    await freeSessionMessages(T, "tok-i");
    assert.equal((await listSessionMessages(T, "desk", "code-i", { waiting: true })).length, 1, "bound: a plain free leaves it the run's");
    await freeSessionMessages(T, "tok-i", { bound: true });
    assert.deepEqual((await listSessionMessages(T, "desk", "code-i", { waiting: true })).map((m) => m.id), [a.id, b.id], "the run was undone: both wait again");
  });

  test("bind refuses when a lapsed claim lost a message to another turn", async () => {
    const { claimSessionMessages, bindSessionMessages, ClaimLost } = await sm();
    const { db } = await import("../src/db.ts");
    const a = await send("code-j", "a");
    const b = await send("code-j", "b");
    await claimSessionMessages(T, "desk", "code-j", [a.id, b.id], "tok-slow");
    await db()!.query(`UPDATE session_messages SET claimed_at = now() - interval '11 minutes' WHERE id=$1`, [b.id]);
    const other = await claimSessionMessages(T, "desk", "code-j", [b.id], "tok-fast");
    assert.deepEqual(other.taken.map((m) => m.id), [b.id]);
    await assert.rejects(bindSessionMessages(T, "tok-slow", "run-slow", 2), ClaimLost);
  });

  test("a claim neither bound nor freed lapses after 10 minutes", async () => {
    const { claimSessionMessages, listSessionMessages } = await sm();
    const { db } = await import("../src/db.ts");
    const m = await send("code-f", "stuck");
    await claimSessionMessages(T, "desk", "code-f", [m.id], "tok-dead");
    assert.equal((await listSessionMessages(T, "desk", "code-f", { waiting: true })).length, 0);
    await db()!.query(`UPDATE session_messages SET claimed_at = now() - interval '11 minutes' WHERE id=$1`, [m.id]);
    assert.deepEqual((await listSessionMessages(T, "desk", "code-f", { waiting: true })).map((x) => x.id), [m.id]);
    const again = await claimSessionMessages(T, "desk", "code-f", [m.id], "tok-live");
    assert.deepEqual(again.taken.map((x) => x.id), [m.id]);
  });

  test("at most WAITING_MAX wait for one conversation; text is checked", async () => {
    const { WAITING_MAX, TooManyWaiting, messageTextProblem } = await sm();
    const { db } = await import("../src/db.ts");
    // Fill to the cap in one statement, then one more is refused.
    await db()!.query(
      `INSERT INTO session_messages (id, tenant, workspace, context_key, context_id, sender, sender_name, text)
       SELECT 'sm-fill-' || g, $1, 'desk', $2, 'code-g', 'user:ana', 'Ana', 'x' FROM generate_series(1, $3) g`,
      [T, (await import("../../foldrun-core/src/conversation.ts")).contextKey("code-g"), WAITING_MAX],
    );
    await assert.rejects(send("code-g", "one too many"), TooManyWaiting);
    assert.match(messageTextProblem("") ?? "", /non-empty/);
    assert.match(messageTextProblem("x".repeat(5000)) ?? "", /at most/);
    assert.equal(messageTextProblem("fine"), null);
  });

  test("deleting a project deletes its messages; renaming one moves them", async () => {
    const { deleteWorkspaceSessionMessages, listSessionMessages } = await sm();
    await send("code-h", "to go", "gone");
    await deleteWorkspaceSessionMessages(T, "gone");
    assert.deepEqual(await listSessionMessages(T, "gone", "code-h"), []);
    // A send checks the project under the lock a delete holds: gone, refused.
    await assert.rejects(
      (await sm()).sendSessionMessage({ tenant: T, workspace: "gone", context: "code-h", sender: "user:ana", senderName: "Ana", text: "late", stillThere: () => false }),
      (e: Error & { status?: number }) => e.status === 404,
    );
    assert.deepEqual(await listSessionMessages(T, "gone", "code-h"), []);
    const { renameWorkspaceSessionMessages } = await sm();
    await send("code-h", "moves", "old-name");
    await renameWorkspaceSessionMessages(T, "old-name", "new-name");
    assert.deepEqual(await listSessionMessages(T, "old-name", "code-h"), []);
    assert.deepEqual((await listSessionMessages(T, "new-name", "code-h")).map((m) => m.text), ["moves"]);
    // The folder's own change failing rolls the messages back.
    await assert.rejects(renameWorkspaceSessionMessages(T, "new-name", "third", async () => { throw new Error("folder would not move"); }), /would not move/);
    assert.deepEqual((await listSessionMessages(T, "new-name", "code-h")).map((m) => m.text), ["moves"], "still under the name the folder kept");
    const { deleteWorkspaceSessionMessages: del } = await sm();
    await assert.rejects(del(T, "new-name", async () => { throw new Error("store down"); }), /store down/);
    assert.equal((await listSessionMessages(T, "new-name", "code-h")).length, 0, "messages go before the folder: a delete that then fails has still removed them");
  });
}
