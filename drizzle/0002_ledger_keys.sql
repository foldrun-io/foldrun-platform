-- The ledger keyed by what it says, not by when it said it.
--
-- The old unique key was (tenant, kind, run_id, at) with NULLS NOT DISTINCT.
-- Two things were wrong with it. A run settled from two worker pods a
-- millisecond apart was two rows, because `at` differed — the file marker
-- that was meant to stop that lives on one pod's disk. And the base fee and
-- the storage accrual for one sweep share a `now` and have no run, so the
-- second of them was silently eaten, as were several lots expiring in one
-- pass. Now a run is unique by (tenant, run_id) alone, and every other
-- once-only fact carries a `key` naming it. The columns the file has had
-- since attribution existed (split, flow, agents, waived, carried_usd)
-- come along, so spend history and rollover read the same on Postgres.
--
-- Written by drizzle-kit from src/schema.ts, then edited by hand: the drop
-- tolerates a database that never had the constraint, the backfill gives
-- every existing row the key the code would derive for it (ledger-db.ts
-- entryKey — the two must agree or the file history imports twice), and a
-- run already charged twice under the old key has its later rows turned
-- into a reversed adjustment so the unique index can be built at all.
ALTER TABLE "ledger" DROP CONSTRAINT IF EXISTS "ledger_tenant_kind_run_id_at_key";--> statement-breakpoint
ALTER TABLE "ledger" ADD COLUMN IF NOT EXISTS "key" text;--> statement-breakpoint
ALTER TABLE "ledger" ADD COLUMN IF NOT EXISTS "split" jsonb;--> statement-breakpoint
ALTER TABLE "ledger" ADD COLUMN IF NOT EXISTS "flow" text;--> statement-breakpoint
ALTER TABLE "ledger" ADD COLUMN IF NOT EXISTS "agents" jsonb;--> statement-breakpoint
ALTER TABLE "ledger" ADD COLUMN IF NOT EXISTS "waived" jsonb;--> statement-breakpoint
ALTER TABLE "ledger" ADD COLUMN IF NOT EXISTS "carried_usd" numeric(14, 6);--> statement-breakpoint
-- A run charged more than once under the old key: the first row stands,
-- each later one is re-kinded as the duplicate it was and reversed by a
-- matching credit, so the balance is corrected on the books rather than
-- by deleting a line of money.
WITH dups AS (
  SELECT id, tenant, run_id, usd, workspace,
         row_number() OVER (PARTITION BY tenant, run_id ORDER BY at, id) AS n
    FROM ledger WHERE kind = 'run' AND run_id IS NOT NULL
), later AS (
  UPDATE ledger l SET kind = 'adjustment',
         note = 'duplicate charge of run ' || l.run_id || ' — settled twice before 0002_ledger_keys, reversed',
         key = 'dup:' || l.id
    FROM dups d WHERE d.id = l.id AND d.n > 1
  RETURNING l.id, l.tenant, l.run_id, l.usd, l.workspace, l.at
)
INSERT INTO ledger (tenant, at, kind, usd, workspace, run_id, note, key)
SELECT tenant, at, 'adjustment', -usd, workspace, run_id,
       'reversal of duplicate charge of run ' || run_id || ' (0002_ledger_keys)', 'reverse:' || id
  FROM later;--> statement-breakpoint
-- The key the code derives for a row that has none (ledger-db.ts entryKey):
-- kind, the instant to the millisecond in ISO form, the run, a digest of
-- the note. Run rows get their real key, so a new settle of an old run is
-- refused by the key index as well as by the run index.
UPDATE ledger SET key = CASE WHEN kind = 'run' AND run_id IS NOT NULL THEN 'run:' || run_id
  ELSE 'row:' || kind || ':' || to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || ':' || coalesce(run_id, '') || ':' || md5(coalesce(note, '')) END
  WHERE key IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ledger_run_once_idx" ON "ledger" USING btree ("tenant","run_id") WHERE "ledger"."kind" = 'run';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ledger_key_idx" ON "ledger" USING btree ("tenant","key") WHERE "ledger"."key" IS NOT NULL;
