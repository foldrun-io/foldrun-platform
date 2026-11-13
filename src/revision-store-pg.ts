// RevisionStore on Postgres: the hosted implementation (FOL-126, phase 1).
//
// Interface and semantics are foldrun-core/src/revision-store.ts; the contract
// suite (core tests/revision-contract.ts) runs against this and against the
// local store, so they cannot drift. No caller uses it yet.
//
// The commit is one transaction:
//
//   1. an op id that already committed -> `duplicate`, nothing written;
//   2. compare-and-set the head row (UPDATE … WHERE revision_id = base, or
//      INSERT … ON CONFLICT DO NOTHING for the first) -> 0 rows = `stale`;
//   3. insert the revision (seq from the head row, so it is gapless) and the
//      operation record.
//
// The (tenant, workspace, op_id) key of workspace_ops is the backstop for step 1:
// two commits of one op id racing past the check cannot both insert.
//
// TWO HEADS: every query carries the ref's scope (workspace | state). The head
// row, the revision seqs and the op ids are per scope, so a state checkpoint
// and a source save never contend. The storage/ file index is workspace-wide.
//
// PINS: the commit also pins the revision's two manifests (blob_pins, holder
// `revision:<id>`, no lease), in the same transaction — a sweeper that sees the
// revision sees its pin, and one that does not see the pin cannot see the
// revision either.
//
// SCHEMA: drizzle/0039_fol126_records.sql, mirrored in schema.ts.

import type { Pool, PoolClient } from "pg";
import type { CommitInput, CommitResult, IndexedFile, OperationRecord, Revision, RevisionStore, WorkspaceRef } from "../../foldrun-core/src/revision-store.ts";
import { assertOpId, newRevisionId, OpIdReused } from "../../foldrun-core/src/revision-store.ts";
import { scopeOf } from "../../foldrun-core/src/revision-store.ts";
import { EMPTY_MANIFEST_ID } from "../../foldrun-core/src/manifest.ts";
import { assertFilePath } from "../../foldrun-core/src/storage.ts";
import { assertSafeName } from "../../foldrun-core/src/store.ts";
import { db } from "./db.ts";

interface RevRow {
  id: string;
  scope: "workspace" | "state";
  seq: number;
  parent_id: string | null;
  authored: string;
  state: string;
  by: string;
  message: string;
  op_id: string;
  restored_from: string | null;
  conflicts: string[] | null;
  created_at: Date;
}

const COLS = "id, scope, seq, parent_id, authored, state, by, message, op_id, restored_from, conflicts, created_at";

const toRevision = (r: RevRow): Revision => ({
  id: r.id,
  scope: r.scope,
  seq: r.seq,
  parent: r.parent_id,
  authored: r.authored,
  state: r.state,
  by: r.by,
  message: r.message,
  at: r.created_at.toISOString(),
  opId: r.op_id,
  ...(r.restored_from ? { restoredFrom: r.restored_from } : {}),
  ...(r.conflicts?.length ? { conflicts: r.conflicts } : {}),
});

/** The workspace lock, as Postgres advisory locks scoped to a transaction
 *  (FOL-126): a commit holds it SHARED (any number of commits, on any pod, at
 *  once), a delete or a rename holds it EXCLUSIVE, so the two never overlap and
 *  a commit that gets the lock after a delete asks its guard whether the folder
 *  is still there. Keys: the account (taken shared by every commit, exclusive
 *  by an account delete) and the workspace; always in that order. A hash
 *  collision only makes two workspaces wait for each other. */
const lockKey = (kind: "tn" | "ws", tenant: string, workspace?: string) => `${kind}:${tenant}${workspace === undefined ? "" : `:${workspace}`}`;
async function lock(c: PoolClient, mode: "shared" | "exclusive", kind: "tn" | "ws", tenant: string, workspace?: string) {
  await c.query(`SELECT pg_advisory_xact_lock${mode === "shared" ? "_shared" : ""}(hashtext($1)::bigint)`, [lockKey(kind, tenant, workspace)]);
}

/** A workspace's name, or "@library" — the account shelf's scope (core
 *  workspace-revisions.ts), as the local store allows it (revision-store.ts).
 *  Until 13 Nov 2026 this refused "@library", so no install on Postgres ever
 *  published or read an account's AGENTS.md and library/ as revisions. */
function assertScopeName(name: string): void {
  if (name !== "@library") assertSafeName(name, "workspace");
}

export function pgRevisionStore(pool: () => Pool | null = db): RevisionStore {
  const p = (): Pool => {
    const x = pool();
    if (!x) throw new Error("the pg revision store needs FOLDRUN_DATABASE_URL");
    return x;
  };
  const key = (ws: WorkspaceRef) => {
    assertSafeName(ws.tenant, "tenant");
    assertScopeName(ws.workspace);
    return [ws.tenant, ws.workspace, scopeOf(ws)] as const;
  };
  const opRecord = async (c: Pool | PoolClient, ws: WorkspaceRef, opId: string): Promise<OperationRecord | null> => {
    const r = await c.query<{ digest: string; outcome: "committed" | "unchanged"; revision_id: string | null }>(
      `SELECT digest, outcome, revision_id FROM workspace_ops WHERE tenant=$1 AND workspace=$2 AND scope=$3 AND op_id=$4`,
      [...key(ws), opId],
    );
    const row = r.rows[0];
    if (!row) return null;
    let revision: Revision | null = null;
    if (row.revision_id) {
      const rr = await c.query<RevRow>(`SELECT ${COLS} FROM workspace_revisions WHERE tenant=$1 AND workspace=$2 AND scope=$3 AND id=$4`, [...key(ws), row.revision_id]);
      revision = rr.rows[0] ? toRevision(rr.rows[0]) : null;
    }
    return { opId, digest: row.digest, outcome: row.outcome, revision };
  };
  const headOf = async (c: Pool | PoolClient, ws: WorkspaceRef) => {
    const r = await c.query<RevRow>(
      `SELECT ${COLS.split(", ").map((x) => "r." + x).join(", ")} FROM workspace_heads h JOIN workspace_revisions r ON r.id = h.revision_id WHERE h.tenant=$1 AND h.workspace=$2 AND h.scope=$3`,
      [...key(ws)],
    );
    return r.rows[0] ? toRevision(r.rows[0]) : null;
  };

  return {
    kind: "pg",
    head: (ws) => headOf(p(), ws),
    async allHeads() {
      const r = await p().query<{ tenant: string; workspace: string; ws: string | null; st: string | null }>(
        `SELECT tenant, workspace,
                max(revision_id) FILTER (WHERE scope = 'workspace') AS ws,
                max(revision_id) FILTER (WHERE scope = 'state') AS st
           FROM workspace_heads GROUP BY tenant, workspace ORDER BY tenant, workspace`,
      );
      return r.rows.map((x) => ({ tenant: x.tenant, workspace: x.workspace, workspaceHead: x.ws, stateHead: x.st }));
    },
    async revision(ws, id) {
      const r = await p().query<RevRow>(`SELECT ${COLS} FROM workspace_revisions WHERE tenant=$1 AND workspace=$2 AND scope=$3 AND id=$4`, [...key(ws), id]);
      return r.rows[0] ? toRevision(r.rows[0]) : null;
    },
    async revisions(ws, opts = {}) {
      const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
      const r = await p().query<RevRow>(
        `SELECT ${COLS} FROM workspace_revisions WHERE tenant=$1 AND workspace=$2 AND scope=$3 AND ($4::int IS NULL OR seq < $4) ORDER BY seq DESC LIMIT $5`,
        [...key(ws), opts.before ?? null, limit],
      );
      return r.rows.map(toRevision);
    },
    async operation(ws, opId) {
      assertOpId(opId);
      return opRecord(p(), ws, opId);
    },
    async recordNoop(ws, opId, digest) {
      assertOpId(opId);
      const [tenant, workspace, scope] = key(ws);
      const head = await headOf(p(), ws);
      await p().query(
        `INSERT INTO workspace_ops (tenant, workspace, scope, op_id, digest, outcome, revision_id) VALUES ($1,$2,$3,$4,$5,'unchanged',$6) ON CONFLICT DO NOTHING`,
        [tenant, workspace, scope, opId, digest, head?.id ?? null],
      );
      const rec = (await opRecord(p(), ws, opId))!;
      if (rec.digest !== digest) throw new OpIdReused(opId);
      return rec;
    },
    async commit(ws, input: CommitInput): Promise<CommitResult> {
      assertOpId(input.opId);
      const [tenant, workspace, scope] = key(ws);
      const c = await p().connect();
      try {
        await c.query("BEGIN");
        await lock(c, "shared", "tn", tenant);
        await lock(c, "shared", "ws", tenant, workspace);
        if (input.guard && !(await input.guard())) {
          await c.query("ROLLBACK");
          return { status: "gone" };
        }
        const done = await opRecord(c, ws, input.opId);
        if (done) {
          await c.query("ROLLBACK");
          if (done.digest !== input.digest) throw new OpIdReused(input.opId);
          if (done.outcome === "committed" && done.revision) return { status: "duplicate", revision: done.revision };
          throw new OpIdReused(input.opId); // it finished as "unchanged"; a commit is a different outcome
        }
        const id = newRevisionId();
        let seq: number;
        if (input.base === null) {
          const ins = await c.query<{ seq: number }>(
            `INSERT INTO workspace_heads (tenant, workspace, scope, revision_id, seq) VALUES ($1,$2,$4,$3,1) ON CONFLICT (tenant, workspace, scope) DO NOTHING RETURNING seq`,
            [tenant, workspace, id, scope],
          );
          if (!ins.rows[0]) {
            const head = await headOf(c, ws);
            await c.query("ROLLBACK");
            return { status: "stale", head };
          }
          seq = ins.rows[0].seq;
        } else {
          const upd = await c.query<{ seq: number }>(
            `UPDATE workspace_heads SET revision_id=$3, seq=seq+1, updated_at=now() WHERE tenant=$1 AND workspace=$2 AND scope=$5 AND revision_id=$4 RETURNING seq`,
            [tenant, workspace, id, input.base, scope],
          );
          if (!upd.rows[0]) {
            const head = await headOf(c, ws);
            await c.query("ROLLBACK");
            return { status: "stale", head };
          }
          seq = upd.rows[0].seq;
        }
        // The head row now points at an id that is not in workspace_revisions
        // until the next statement; both are in this transaction, and the
        // JOIN in headOf only sees committed state.
        const ins = await c.query<RevRow>(
          `INSERT INTO workspace_revisions (id, tenant, workspace, scope, seq, parent_id, authored, state, by, message, op_id, restored_from, conflicts)
           VALUES ($1,$2,$3,$13,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${COLS}`,
          [id, tenant, workspace, seq, input.base, input.authored, input.state, input.by, input.message, input.opId, input.restoredFrom ?? null, input.conflicts?.length ? input.conflicts : null, scope],
        );
        await c.query(
          `INSERT INTO workspace_ops (tenant, workspace, scope, op_id, digest, outcome, revision_id) VALUES ($1,$2,$3,$4,$5,'committed',$6)`,
          [tenant, workspace, scope, input.opId, input.digest, id],
        );
        // The revision pins the manifests it names, in this transaction: a
        // sweeper that can see the revision can see the pin (core blob-pins.ts).
        const named = [...new Set([input.authored, input.state])].filter((m) => m !== EMPTY_MANIFEST_ID);
        if (named.length) {
          await c.query(
            `INSERT INTO blob_pins (tenant, kind, ref, holder_kind, holder_id) SELECT $1, 'manifest', m, 'revision', $3 FROM unnest($2::text[]) AS m ON CONFLICT DO NOTHING`,
            [tenant, named, id],
          );
        }
        await c.query("COMMIT");
        return { status: "committed", revision: toRevision(ins.rows[0]) };
      } catch (err) {
        await c.query("ROLLBACK").catch(() => {});
        // The op key: a twin of this very op won the race to insert.
        if ((err as { code?: string }).code === "23505") {
          const twin = await opRecord(p(), ws, input.opId);
          if (twin?.revision && twin.outcome === "committed") {
            if (twin.digest !== input.digest) throw new OpIdReused(input.opId);
            return { status: "duplicate", revision: twin.revision };
          }
          return { status: "stale", head: await headOf(p(), ws) };
        }
        throw err;
      } finally {
        c.release();
      }
    },
    async files(ws) {
      const r = await p().query(`SELECT path, sha, size, mime, updated_at, by FROM workspace_files WHERE tenant=$1 AND workspace=$2 ORDER BY path`, key(ws).slice(0, 2));
      return r.rows.map((x): IndexedFile => ({ path: x.path, sha: x.sha, size: Number(x.size), mime: x.mime, updatedAt: new Date(x.updated_at).toISOString(), by: x.by }));
    },
    async putFile(ws, f, expectSha) {
      assertFilePath(f.path);
      const [tenant, workspace] = key(ws);
      const vals = [tenant, workspace, f.path, f.sha, f.size, f.mime, f.updatedAt, f.by];
      if (expectSha === undefined) {
        await p().query(
          `INSERT INTO workspace_files (tenant, workspace, path, sha, size, mime, updated_at, by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (tenant, workspace, path) DO UPDATE SET sha=EXCLUDED.sha, size=EXCLUDED.size, mime=EXCLUDED.mime, updated_at=EXCLUDED.updated_at, by=EXCLUDED.by`,
          vals,
        );
        return true;
      }
      if (expectSha === null) {
        const r = await p().query(
          `INSERT INTO workspace_files (tenant, workspace, path, sha, size, mime, updated_at, by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
          vals,
        );
        return (r.rowCount ?? 0) > 0;
      }
      const r = await p().query(
        `UPDATE workspace_files SET sha=$4, size=$5, mime=$6, updated_at=$7, by=$8 WHERE tenant=$1 AND workspace=$2 AND path=$3 AND sha=$9`,
        [...vals, expectSha],
      );
      return (r.rowCount ?? 0) > 0;
    },
    async deleteFile(ws, rel, expectSha) {
      const [tenant, workspace] = key(ws);
      // null ("only if there is no row") can never delete a row.
      if (expectSha === null) return false;
      const r =
        expectSha === undefined
          ? await p().query(`DELETE FROM workspace_files WHERE tenant=$1 AND workspace=$2 AND path=$3`, [tenant, workspace, rel])
          : await p().query(`DELETE FROM workspace_files WHERE tenant=$1 AND workspace=$2 AND path=$3 AND sha=$4`, [tenant, workspace, rel, expectSha]);
      return (r.rowCount ?? 0) > 0;
    },
    async drop(target) {
      assertSafeName(target.tenant, "tenant");
      if (target.workspace !== undefined) assertScopeName(target.workspace);
      return inTx(p(), async (c) => {
        if (target.workspace === undefined) await lock(c, "exclusive", "tn", target.tenant);
        else await lock(c, "exclusive", "ws", target.tenant, target.workspace);
        return dropRows(c, target.tenant, target.workspace);
      });
    },
    async move(tenant, from, to) {
      assertSafeName(tenant, "tenant");
      assertSafeName(from, "workspace");
      assertSafeName(to, "workspace");
      if (from === to) return;
      await inTx(p(), async (c) => {
        // Both names, in a fixed order, so two crossing renames cannot wait on each other.
        for (const n of [from, to].sort()) await lock(c, "exclusive", "ws", tenant, n);
        // Whatever the new name holds is a workspace that no longer exists.
        await dropRows(c, tenant, to, { keepFiles: true });
        // Revision ids do not change, so the pins on their manifests stay valid.
        await c.query(`UPDATE workspace_heads SET workspace=$3 WHERE tenant=$1 AND workspace=$2`, [tenant, from, to]);
        await c.query(`UPDATE workspace_revisions SET workspace=$3 WHERE tenant=$1 AND workspace=$2`, [tenant, from, to]);
        await c.query(`UPDATE workspace_ops SET workspace=$3 WHERE tenant=$1 AND workspace=$2`, [tenant, from, to]);
      });
    },
    async manifestIds(tenant, opts = {}) {
      assertSafeName(tenant, "tenant");
      const r = await p().query<{ m: string }>(
        `SELECT authored AS m FROM workspace_revisions WHERE tenant=$1 AND ($2::timestamptz IS NULL OR created_at >= $2)
         UNION SELECT state FROM workspace_revisions WHERE tenant=$1 AND ($2::timestamptz IS NULL OR created_at >= $2)`,
        [tenant, opts.since ?? null],
      );
      return r.rows.map((x) => x.m);
    },
    async anyRevisions() {
      const r = await p().query(`SELECT 1 FROM workspace_revisions LIMIT 1`);
      return (r.rowCount ?? 0) > 0;
    },
    async workspaces() {
      const r = await p().query<{ tenant: string; workspace: string }>(
        `SELECT tenant, workspace FROM workspace_heads UNION SELECT tenant, workspace FROM workspace_revisions`,
      );
      return r.rows;
    },
    async prune(ws, ids) {
      if (!ids.length) return 0;
      const [tenant, workspace, scope] = key(ws);
      return inTx(p(), async (c) => {
        // Lock the head row: a commit moves it with a compare-and-set on the
        // same row, so the head we exclude is the head that stays.
        const h = await c.query<{ revision_id: string }>(`SELECT revision_id FROM workspace_heads WHERE tenant=$1 AND workspace=$2 AND scope=$3 FOR UPDATE`, [tenant, workspace, scope]);
        const head = h.rows[0]?.revision_id ?? null;
        const gone = await c.query<{ id: string }>(
          `DELETE FROM workspace_revisions WHERE tenant=$1 AND workspace=$2 AND scope=$3 AND id = ANY($4::text[]) AND ($5::text IS NULL OR id <> $5) RETURNING id`,
          [tenant, workspace, scope, ids, head],
        );
        if (gone.rows.length) {
          // The manifests those revisions pinned are no longer theirs to hold;
          // another revision's pin on the same manifest stays.
          await c.query(`DELETE FROM blob_pins WHERE tenant=$1 AND holder_kind='revision' AND holder_id = ANY($2::text[])`, [tenant, gone.rows.map((x) => x.id)]);
        }
        return gone.rows.length;
      });
    },
  };
}

async function inTx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

/** Every row of one workspace (or of the whole account), and the pins its
 *  revisions held, in the caller's transaction. Returns the revisions removed. */
async function dropRows(c: PoolClient, tenant: string, workspace: string | undefined, opts: { keepFiles?: boolean } = {}): Promise<number> {
  const w = workspace ?? null;
  const ids = await c.query<{ id: string }>(`SELECT id FROM workspace_revisions WHERE tenant=$1 AND ($2::text IS NULL OR workspace=$2)`, [tenant, w]);
  await c.query(`DELETE FROM workspace_heads WHERE tenant=$1 AND ($2::text IS NULL OR workspace=$2)`, [tenant, w]);
  await c.query(`DELETE FROM workspace_ops WHERE tenant=$1 AND ($2::text IS NULL OR workspace=$2)`, [tenant, w]);
  await c.query(`DELETE FROM workspace_revisions WHERE tenant=$1 AND ($2::text IS NULL OR workspace=$2)`, [tenant, w]);
  if (!opts.keepFiles) await c.query(`DELETE FROM workspace_files WHERE tenant=$1 AND ($2::text IS NULL OR workspace=$2)`, [tenant, w]);
  // An account that is gone holds nothing; a workspace that is gone releases the pins of its revisions.
  if (workspace === undefined) await c.query(`DELETE FROM blob_pins WHERE tenant=$1`, [tenant]);
  else if (ids.rows.length) await c.query(`DELETE FROM blob_pins WHERE tenant=$1 AND holder_kind='revision' AND holder_id = ANY($2::text[])`, [tenant, ids.rows.map((x) => x.id)]);
  return ids.rows.length;
}
