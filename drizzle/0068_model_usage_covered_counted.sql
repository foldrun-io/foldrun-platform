-- FOL-208: when settlement moved a covered call into the plan's sums.
-- The constant default (no rewrite, no scan) reads as counted: every row
-- already settled was counted by its settlement, and rows an older release
-- writes during a rollout are counted by that release's own settlement.
-- This release writes NULL (pending) for each covered call it admits.
ALTER TABLE "model_usage" ADD COLUMN "covered_counted_at" timestamp with time zone DEFAULT '1970-01-01 00:00:00+00';--> statement-breakpoint
-- Covered calls not yet settled are not in the sums yet: pending. A few
-- rows at most (the sweep settles every minute), found by the unsettled
-- index.
UPDATE "model_usage" SET "covered_counted_at" = NULL WHERE "settled_key" IS NULL AND "covered" = true;--> statement-breakpoint
CREATE INDEX "model_usage_pending_covered_idx" ON "model_usage" USING btree ("tenant") WHERE "model_usage"."covered" = true AND "model_usage"."covered_counted_at" IS NULL;
