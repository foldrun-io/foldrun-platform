// Deleting an account, and meaning it.
//
// "Delete my data" is easy to claim and hard to honour, because backups exist.
// Fourteen nightly archives and a bucket hold copies nobody can reach into and
// scrub one account out of — and refusing to keep backups is not an answer
// either.
//
// Crypto-shredding is the answer that actually holds. Every secret an account
// had is ciphertext under one key that exists in one place; destroy the key and
// every copy of that ciphertext, everywhere, is permanently unreadable. The
// archives can stay exactly as they are.
//
// Deliberately NOT a dashboard button. This is irreversible in the strongest
// sense — there is no second copy of the key to recover from — so it lives
// behind a script an operator runs on purpose, with the account named twice.

import fs from "node:fs";
import path from "node:path";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { orm, databaseEnabled } from "./db.ts";
import { auditLog, ledger, queue, sessions } from "./schema.ts";
import { deleteFlowState } from "./flow-state.ts";
import { deleteNotices } from "./notices.ts";
import { deleteShares } from "./shares.ts";
import { deleteAdminState } from "./admin.ts";
import { and, eq, isNull, sql } from "drizzle-orm";
import { destroyTenantKey } from "./tenant-keys.ts";
import { assertSafeName } from "../../foldrun-core/src/store.ts";
import { deleteSearchPod, perAccountSearchEnabled } from "./search-k8s.ts";
import { deleteBrowserPod, perAccountBrowserEnabled } from "./browser-k8s.ts";
import { deleteTenantDeliveries } from "./webhook-deliveries.ts";
import { deleteTenantPreferences } from "./email-preferences.ts";
import { deleteTenantFlags } from "./flags.ts";
import { deleteApiUsageFor } from "./api-usage.ts";
import { billing } from "./billing.ts";

export interface DeletionReport {
  tenant: string;
  keyDestroyed: boolean;
  queueJobsRemoved: number;
  sessionsRevoked: number;
  filesRemoved: boolean;
  ledgerKept: number;
}

/**
 * Remove an account.
 *
 * The ledger is KEPT, on purpose. It is the record of money that moved, it
 * holds no secret — amounts, dates and run ids — and deleting the financial
 * history of a customer who has paid you is the kind of erasure that makes an
 * accountant, and in most places a regulator, unhappy. Everything that could
 * identify them is either shredded with the key or removed with their files.
 */
export async function deleteTenant(
  tenant: string,
  opts: { confirm: string; by: string },
): Promise<DeletionReport> {
  assertSafeName(tenant, "tenant");
  if (opts.confirm !== tenant) {
    // Naming it twice is the whole safety mechanism. A flag can be pasted from
    // a runbook; the account's own name has to be typed while looking at it.
    throw new Error(`refusing to delete: confirm must be exactly "${tenant}"`);
  }

  // The account's search and browser pods, if it has them right now. Best
  // effort and first: they hold nothing of theirs, but they are running
  // processes with their name on them, and the reaper would otherwise bill
  // a deleted account.
  if (perAccountSearchEnabled()) await deleteSearchPod(tenant).catch(() => {});
  if (perAccountBrowserEnabled()) await deleteBrowserPod(tenant).catch(() => {});

  const report: DeletionReport = {
    tenant,
    keyDestroyed: false,
    queueJobsRemoved: 0,
    sessionsRevoked: 0,
    filesRemoved: false,
    ledgerKept: 0,
  };

  const q = orm();
  if (databaseEnabled() && q) {
    // Audited BEFORE anything is destroyed, so the record of who did this
    // survives even if a later step fails halfway.
    await q.insert(auditLog).values({ tenant, actor: opts.by, action: "tenant.deleted", subject: tenant, detail: {} });

    report.queueJobsRemoved = (await q.delete(queue).where(eq(queue.tenant, tenant)).returning({ id: queue.id })).length;

    report.sessionsRevoked = (
      await q
        .update(sessions)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(sessions.tenant, tenant), isNull(sessions.revokedAt)))
        .returning({ id: sessions.id })
    ).length;

    // The platform's records about the account: its flows' cursors, the
    // notices sent, the links it minted, what the operator set. The audit
    // of the operator's actions stays, as every audit does.
    await deleteFlowState(tenant);
    await deleteNotices(tenant);
    await deleteShares(tenant);
    await deleteAdminState(tenant);

    const [l] = await q.select({ c: sql<string>`count(*)::text` }).from(ledger).where(eq(ledger.tenant, tenant));
    report.ledgerKept = Number(l.c);

    // The shred, last of the database work: once this is gone, anything of
    // theirs that survives anywhere is noise.
    report.keyDestroyed = await destroyTenantKey(tenant);
  }

  // Its outbound webhook log, the mail choices made in it and the feature
  // flags set for it alone — rows with a database, files without one.
  await deleteTenantDeliveries(tenant).catch(() => {});
  await deleteTenantPreferences(tenant).catch(() => {});
  await deleteTenantFlags(tenant).catch(() => {});
  await deleteApiUsageFor(tenant).catch(() => {});
  // What billing keeps that names a person (kept Stripe events, hosted).
  await billing().accountDeleted(tenant).catch((err) => console.error(`[foldrun] delete ${tenant}: billing's records: ${err instanceof Error ? err.message : err}`));

  const dir = path.join(dataRoot(), tenant);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    report.filesRemoved = true;
  }
  return report;
}
