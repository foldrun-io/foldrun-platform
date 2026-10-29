-- FOL-71: a key `foldrun login` mints is marked, so it can be given a lifetime that
-- renews itself (90 days; the CLI rotates it when under 14 are left). The
-- column is nullable with no default: the release before this one never
-- names it, inserts without it, and reads every row it had.
ALTER TABLE "api_keys" ADD COLUMN "origin" text;--> statement-breakpoint
-- The keys `foldrun login` minted before the column existed. Nothing but the
-- label told them apart: cli-login.ts has labelled every one `cli · <host>`
-- and minted it for the signed-in person (created_by set). A person could
-- have typed that label on a key of their own; what it gains then is a
-- 90-day end it did not have and the right to rotate itself — no wider role,
-- no wider scope.
UPDATE "api_keys" SET "origin" = 'cli-login'
WHERE "origin" IS NULL AND "label" LIKE 'cli · %' AND "created_by" IS NOT NULL;--> statement-breakpoint
-- Their one-time end: 90 days from this migration, for the live ones that
-- had none. A key that already ends sooner, or has ended, keeps its end.
UPDATE "api_keys" SET "expires_at" = now() + interval '90 days'
WHERE "origin" = 'cli-login' AND "revoked_at" IS NULL AND "expires_at" IS NULL;
