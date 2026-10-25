// Credential health in Postgres.
//
// Core keeps it in <account>/secret-health.json, a read-modify-write of one
// file per account. With several pods on a shared volume the last writer
// won, so a refusal recorded by one pod could be overwritten by another's
// acceptance a moment later and the page would say a dead key was fine.
// Here each use is one INSERT … ON CONFLICT DO UPDATE, and the counter and
// the last acceptance are computed by the database from the row it holds,
// so concurrent writers compose instead of overwriting.

import { and, eq, sql } from "drizzle-orm";
import { ormRequired, type Db } from "./db.ts";
import { secretHealth } from "./schema.ts";
import {
  outcomeFor,
  readSecretHealthFile,
  type HealthFile,
  type HealthUpdate,
  type SecretHealthStore,
} from "../../foldrun-core/src/secret-health.ts";

async function applyOne(q: Db, tenant: string, { key, use }: HealthUpdate): Promise<void> {
  const outcome = outcomeFor(use.status);
  const at = new Date(use.at);
  await q
    .insert(secretHealth)
    .values({
      tenant,
      key,
      lastAt: at,
      host: use.host,
      status: use.status,
      outcome,
      refusals: outcome === "refused" ? 1 : 0,
      lastAccepted: outcome === "accepted" ? at : null,
    })
    .onConflictDoUpdate({
      target: [secretHealth.tenant, secretHealth.key],
      set: {
        lastAt: sql`excluded.last_at`,
        host: sql`excluded.host`,
        status: sql`excluded.status`,
        outcome: sql`excluded.outcome`,
        // Only a refusal counts against a key; an acceptance clears the run;
        // an error at the far end leaves the count as it was.
        refusals: sql`CASE excluded.outcome WHEN 'refused' THEN ${secretHealth.refusals} + 1 WHEN 'accepted' THEN 0 ELSE ${secretHealth.refusals} END`,
        lastAccepted: sql`CASE WHEN excluded.outcome = 'accepted' THEN excluded.last_at ELSE ${secretHealth.lastAccepted} END`,
      },
    });
}

export const secretHealthDbStore: SecretHealthStore = {
  async apply(tenant, updates) {
    // In order: the file store folds uses in the order they were noted.
    const q = ormRequired();
    for (const u of updates) await applyOne(q, tenant, u);
  },
  async read(tenant) {
    const rows = await ormRequired().select().from(secretHealth).where(eq(secretHealth.tenant, tenant));
    const out: HealthFile = {};
    for (const r of rows) {
      out[r.key] = {
        last: { at: r.lastAt.toISOString(), host: r.host, status: r.status, outcome: r.outcome as HealthFile[string]["last"]["outcome"] },
        refusals: r.refusals,
        lastAccepted: r.lastAccepted ? r.lastAccepted.toISOString() : null,
      };
    }
    return out;
  },
  async forget(tenant, key) {
    await ormRequired().delete(secretHealth).where(and(eq(secretHealth.tenant, tenant), eq(secretHealth.key, key)));
  },
};

/**
 * An account's secret-health.json into rows, once. A row already there is
 * newer than the file (the database is authoritative once it has it), so the
 * import only fills keys the table lacks. Returns how many were added.
 */
export async function importSecretHealthFile(tenant: string, on?: Db): Promise<number> {
  const data = readSecretHealthFile(tenant);
  const rows = Object.entries(data).map(([key, r]) => ({
    tenant,
    key,
    lastAt: new Date(r.last.at),
    host: r.last.host,
    status: r.last.status,
    outcome: r.last.outcome,
    refusals: r.refusals,
    lastAccepted: r.lastAccepted ? new Date(r.lastAccepted) : null,
  }));
  if (!rows.length) return 0;
  const got = await (on ?? ormRequired())
    .insert(secretHealth)
    .values(rows)
    .onConflictDoNothing({ target: [secretHealth.tenant, secretHealth.key] })
    .returning({ key: secretHealth.key });
  return got.length;
}
