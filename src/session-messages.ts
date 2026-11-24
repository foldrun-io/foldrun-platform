// Session messages (19 Nov 2026): one session of a project sends another
// conversation of the same project a message, and it waits there until the
// person in that conversation includes it in a turn.
//
//   send   — a row, waiting (no claim). At most WAITING_MAX wait per
//            conversation; older than KEEP_DAYS are swept on each send.
//   list   — what a conversation was sent: waiting first use, or all.
//   claim  — the turn being made takes the waiting messages its caller
//            named, under a token, atomically: a message is taken by one
//            turn only, however many ask at once. Those it could not take
//            (gone, taken, another conversation's) are named back.
//   bind   — the run was made: the token's claim becomes that run's.
//   free   — the run was not made: its claim goes back to waiting. A claim
//            neither bound nor freed (the process died between) lapses
//            after 10 minutes.
//   take   — a turn on a person's own computer makes no run: it takes the
//            messages it included in one step (claim and close together, by
//            the same atomic rule), and they are used — no longer waiting,
//            never offered again (FOL-236).
//
// Who may send: whoever may start runs in the project (`run:start`) — the
// same right that already lets them join the conversation by its id. What
// a message says is data to the receiving agent, never an instruction
// (core conversation.ts messagesBlock).
//
// Postgres only: the rows are shared by every copy of the web tier and the
// worker. Without a database the routes answer 503.

import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { db } from "./db.ts";
import { contextKey } from "../../foldrun-core/src/conversation.ts";
import { SESSION_MESSAGE_LIMITS, type SessionMessage } from "../../foldrun-core/src/conversation.ts";

/** How many may wait for one conversation at once. */
export const WAITING_MAX = 100;
/** How long a message is kept, waiting or used. */
export const KEEP_DAYS = 30;

export interface SessionMessageRow {
  id: string;
  workspace: string;
  context: string;
  from: string;
  sender: string;
  fromContext?: string;
  text: string;
  at: string;
  /** The run that included it; absent while it waits, and for a turn on a person's computer. */
  run?: string;
  usedAt?: string;
  /** Used by a turn on a person's own computer, which makes no run (FOL-236). */
  usedLocally?: true;
}

/** What claimed_run holds for a message a turn on a person's computer took: no run id is ever this. */
const LOCAL_TURN = "local-turn";

export class SessionMessagesUnavailable extends Error {
  constructor() {
    super("session messages need the platform's database — this install has none");
  }
}

/** Refused because the conversation already has WAITING_MAX waiting. */
export class TooManyWaiting extends Error {}

type Row = {
  id: string;
  workspace: string;
  context_id: string;
  sender: string;
  sender_name: string;
  from_context: string | null;
  text: string;
  created_at: Date;
  claimed_run: string | null;
  claimed_at: Date | null;
};

const rowOf = (r: Row): SessionMessageRow => ({
  id: r.id,
  workspace: r.workspace,
  context: r.context_id,
  from: r.sender_name,
  sender: r.sender,
  ...(r.from_context ? { fromContext: r.from_context } : {}),
  text: r.text,
  at: new Date(r.created_at).toISOString(),
  ...(r.claimed_run && r.claimed_run !== LOCAL_TURN ? { run: r.claimed_run } : {}),
  ...(r.claimed_run === LOCAL_TURN ? { usedLocally: true as const } : {}),
  ...(r.claimed_run && r.claimed_at ? { usedAt: new Date(r.claimed_at).toISOString() } : {}),
});

/** What the run record carries — core's shape. */
export function asRunMessage(r: SessionMessageRow): SessionMessage {
  return { id: r.id, from: r.from, ...(r.fromContext ? { fromContext: r.fromContext } : {}), at: r.at, text: r.text };
}

async function withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const pool = db();
  if (!pool) throw new SessionMessagesUnavailable();
  const c = await pool.connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
}

/** Null when the text may be sent; otherwise why not. */
export function messageTextProblem(text: unknown): string | null {
  if (typeof text !== "string" || !text.trim()) return "text: the message, as a non-empty string";
  if (text.length > SESSION_MESSAGE_LIMITS.textChars) return `text: at most ${SESSION_MESSAGE_LIMITS.textChars.toLocaleString("en")} characters`;
  return null;
}

/** The lock a project's sends share and its delete or rename holds alone. */
const projectLock = (tenant: string, workspace: string) => `session_messages_project:${tenant}:${workspace}`;

export async function sendSessionMessage(m: {
  tenant: string;
  workspace: string;
  context: string;
  sender: string;
  senderName: string;
  fromContext?: string;
  text: string;
  /** Is the project still there? Asked under the project's lock, so a send
   *  never lands after a delete swept its messages (Codex, 19 Nov 2026). */
  stillThere?: () => boolean | Promise<boolean>;
}): Promise<SessionMessageRow> {
  const key = contextKey(m.context);
  return withClient(async (c) => {
    await c.query("BEGIN");
    try {
      await c.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))`, [projectLock(m.tenant, m.workspace)]);
      if (m.stillThere && !(await m.stillThere())) throw Object.assign(new Error(`project ${m.workspace} not found`), { status: 404 });
      // One sender at a time per conversation, so the count below holds.
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`session_messages:${m.tenant}:${m.workspace}:${key}`]);
      await c.query(`DELETE FROM session_messages WHERE tenant=$1 AND created_at < now() - make_interval(days => $2)`, [m.tenant, KEEP_DAYS]);
      const waiting = Number(
        (await c.query<{ n: string }>(`SELECT count(*) AS n FROM session_messages WHERE tenant=$1 AND workspace=$2 AND context_key=$3 AND claimed_run IS NULL AND (claim_token IS NULL OR claimed_at < now() - interval '10 minutes')`, [m.tenant, m.workspace, key])).rows[0]?.n ?? 0,
      );
      if (waiting >= WAITING_MAX) throw new TooManyWaiting(`${m.context} already has ${WAITING_MAX} messages waiting — they are used when its person includes them in a turn`);
      const id = `sm-${crypto.randomBytes(9).toString("base64url")}`;
      const r = (
        await c.query<Row>(
          `INSERT INTO session_messages (id, tenant, workspace, context_key, context_id, sender, sender_name, from_context, text)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [id, m.tenant, m.workspace, key, m.context, m.sender, m.senderName, m.fromContext ?? null, m.text],
        )
      ).rows[0]!;
      await c.query("COMMIT");
      return rowOf(r);
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    }
  });
}

/** What a conversation was sent, oldest first: `waiting` only those not
 *  yet in a turn (nor being claimed by one). */
export async function listSessionMessages(tenant: string, workspace: string, context: string, opts: { waiting?: boolean; limit?: number } = {}): Promise<SessionMessageRow[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 200));
  return withClient(async (c) => {
    const where = opts.waiting ? "AND claimed_run IS NULL AND (claim_token IS NULL OR claimed_at < now() - interval '10 minutes')" : "";
    const rows = (
      await c.query<Row>(
        `SELECT * FROM (SELECT * FROM session_messages WHERE tenant=$1 AND workspace=$2 AND context_key=$3 ${where} ORDER BY created_at DESC, id DESC LIMIT $4) newest ORDER BY created_at, id`,
        [tenant, workspace, contextKey(context), limit],
      )
    ).rows;
    return rows.map(rowOf);
  });
}

/**
 * Take the named waiting messages for a turn being made, under `token`.
 * `taken` are the messages now the turn's, in the order sent; `refused` the
 * ids it could not take — not this conversation's, gone, or already in
 * another turn.
 */
export async function claimSessionMessages(tenant: string, workspace: string, context: string, ids: readonly string[], token: string): Promise<{ taken: SessionMessageRow[]; refused: string[] }> {
  const want = [...new Set(ids)];
  if (!want.length) return { taken: [], refused: [] };
  return withClient(async (c) => {
    const rows = (
      await c.query<Row>(
        `UPDATE session_messages SET claim_token=$5, claimed_at=now()
         WHERE tenant=$1 AND workspace=$2 AND context_key=$3 AND id = ANY($4::text[]) AND claimed_run IS NULL AND (claim_token IS NULL OR claimed_at < now() - interval '10 minutes')
         RETURNING *`,
        [tenant, workspace, contextKey(context), want, token],
      )
    ).rows;
    const taken = rows.map(rowOf).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
    const got = new Set(taken.map((t) => t.id));
    return { taken, refused: want.filter((id) => !got.has(id)) };
  });
}

/**
 * A turn on a person's own computer included these messages: they are used,
 * in one step — the same rule as a claim (waiting, this conversation's, not
 * in another turn), so a message is used by one turn only. `refused` names
 * the ids it could not take.
 */
export async function takeSessionMessages(tenant: string, workspace: string, context: string, ids: readonly string[]): Promise<{ taken: SessionMessageRow[]; refused: string[] }> {
  const want = [...new Set(ids)];
  if (!want.length) return { taken: [], refused: [] };
  return withClient(async (c) => {
    const rows = (
      await c.query<Row>(
        `UPDATE session_messages SET claim_token=NULL, claimed_run=$5, claimed_at=now()
         WHERE tenant=$1 AND workspace=$2 AND context_key=$3 AND id = ANY($4::text[]) AND claimed_run IS NULL AND (claim_token IS NULL OR claimed_at < now() - interval '10 minutes')
         RETURNING *`,
        [tenant, workspace, contextKey(context), want, LOCAL_TURN],
      )
    ).rows;
    const taken = rows.map(rowOf).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
    const got = new Set(taken.map((t) => t.id));
    return { taken, refused: want.filter((id) => !got.has(id)) };
  });
}

/** The turn was made: the token's messages are that run's. */
export class ClaimLost extends Error {
  status = 409;
}

/**
 * The claim's messages are the run's. Every one must still carry this
 * claim — one a lapsed claim lost to another turn refuses the run
 * (Codex, 19 Nov 2026). The token stays, so a run then not made frees them.
 */
export async function bindSessionMessages(tenant: string, token: string, runId: string, expected?: number): Promise<void> {
  const r = await withClient((c) => c.query(`UPDATE session_messages SET claimed_run=$3, claimed_at=now() WHERE tenant=$1 AND claim_token=$2 AND claimed_run IS NULL`, [tenant, token, runId]));
  if (expected !== undefined && (r.rowCount ?? 0) !== expected) {
    throw new ClaimLost("a message was taken by another turn while this one waited to start — read them again; nothing was started");
  }
}

/**
 * The turn was not made, or some of its messages did not fit in it: they
 * wait again. `ids` frees only those; `bound` frees them even when bound to
 * a run — only for a run that does not exist (it was undone).
 */
export async function freeSessionMessages(tenant: string, token: string, opts: { ids?: string[]; bound?: boolean } = {}): Promise<void> {
  const ids = opts.ids;
  if (ids && !ids.length) return;
  await withClient((c) =>
    c.query(
      `UPDATE session_messages SET claim_token=NULL, claimed_at=NULL, claimed_run=NULL
        WHERE tenant=$1 AND claim_token=$2 AND (claimed_run IS NULL OR $3::boolean)${ids ? " AND id = ANY($4::text[])" : ""}`,
      ids ? [tenant, token, opts.bound === true, ids] : [tenant, token, opts.bound === true],
    ),
  );
}

/** The run a claim was bound to, if any. */
export async function claimedRunOf(tenant: string, token: string): Promise<string | null> {
  const r = await withClient((c) => c.query(`SELECT claimed_run FROM session_messages WHERE tenant=$1 AND claim_token=$2 AND claimed_run IS NOT NULL LIMIT 1`, [tenant, token]));
  return (r.rows[0]?.claimed_run as string | undefined) ?? null;
}

/**
 * fn runs under the project's lock, in one transaction with `sql`: sends
 * wait, and none passes its folder check after; `during` (the folder's own
 * change) failing rolls the messages back. Without a database, only during.
 */
async function underProjectLock(tenant: string, workspace: string, sql: (c: PoolClient) => Promise<unknown>, during?: () => Promise<void>): Promise<void> {
  if (!db()) {
    await during?.();
    return;
  }
  await withClient(async (c) => {
    await c.query("BEGIN");
    try {
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [projectLock(tenant, workspace)]);
      await sql(c);
      await during?.();
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    }
  });
}

/**
 * A project is renamed: its conversations' messages move with it, in the
 * same step as the folder (`during`) — one fails, neither moved.
 */
export async function renameWorkspaceSessionMessages(tenant: string, from: string, to: string, during?: () => Promise<void>): Promise<void> {
  await underProjectLock(tenant, from, (c) => c.query(`UPDATE session_messages SET workspace=$3 WHERE tenant=$1 AND workspace=$2`, [tenant, from, to]), during);
}

/**
 * A project is deleted: its messages go first, then the folder (`during`),
 * the project's lock held throughout so no send lands between. A crash in
 * between loses messages of a project being deleted; it never leaves them
 * for a new project of the name (Codex, 19 Nov 2026). A session lock, not a
 * transaction's: the delete is committed before the folder goes.
 */
export async function deleteWorkspaceSessionMessages(tenant: string, workspace: string, during?: () => Promise<void>): Promise<void> {
  if (!db()) {
    await during?.();
    return;
  }
  await withClient(async (c) => {
    const key = projectLock(tenant, workspace);
    await c.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [key]);
    try {
      await c.query(`DELETE FROM session_messages WHERE tenant=$1 AND workspace=$2`, [tenant, workspace]);
      await during?.();
    } finally {
      await c.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [key]).catch(() => {});
    }
  });
}

/** An account was deleted. */
export async function deleteTenantSessionMessages(tenant: string): Promise<void> {
  if (!db()) return;
  await withClient((c) => c.query(`DELETE FROM session_messages WHERE tenant=$1`, [tenant]));
}
