-- Two pots of credit and a counter of finished runs (7 Nov 2026, FOL-125, FOL-115; renumbered 0039 → 0061 on 14 Nov when it merged): expand only.
--   ledger.bucket       which pot a credit line fills, plan or bought. Nullable: debits
--                       carry none, and older credit lines are read by rule (ledger.ts
--                       entryBucket), so no backfill and nothing the previous release reads.
--   run_finish_counts   how many runs ended, by outcome and error class, for
--                       foldrun_runs_finished_total on /api/metrics. It starts from the
--                       finished runs run_events still holds, which are then marked counted.
CREATE TABLE "run_finish_counts" (
	"outcome" text NOT NULL,
	"error_class" text NOT NULL,
	"n" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "run_finish_counts_pkey" PRIMARY KEY("outcome","error_class")
);
--> statement-breakpoint
ALTER TABLE "ledger" ADD COLUMN "bucket" text;--> statement-breakpoint
ALTER TABLE "run_events" ADD COLUMN "counted" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
INSERT INTO "run_finish_counts" ("outcome", "error_class", "n")
SELECT CASE WHEN "status" = 'completed' THEN 'completed' ELSE 'failed' END,
       CASE WHEN "status" = 'completed' THEN 'none' ELSE COALESCE("error_class", 'platform_error') END,
       count(*)
FROM "run_events" WHERE "finished_at" IS NOT NULL AND NOT "test" AND "status" IN ('completed', 'failed')
GROUP BY 1, 2;
--> statement-breakpoint
UPDATE "run_events" SET "counted" = true WHERE "finished_at" IS NOT NULL AND "status" IN ('completed', 'failed');
