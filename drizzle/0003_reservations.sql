-- A run's expected share, held from admission to settle.
--
-- The caps and the funds gate were read-then-admit: ten webhook runs in one
-- second all read $4.99 against a $5/day cap and all passed. A reservation
-- is what the next admission reads, taken in the same transaction as the
-- check under a per-tenant advisory lock (reservations.ts), so two workers
-- cannot both admit past the line. Keyed by its own id because the run id is
-- minted after the gate; bound to the run once the record exists; released
-- when the charge lands or the hourly pass finds the run over.
--
-- Written by drizzle-kit from src/schema.ts; IF NOT EXISTS added by hand,
-- as every file here tolerates being applied to a database that has it.
CREATE TABLE IF NOT EXISTS "reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant" text NOT NULL,
	"workspace" text NOT NULL,
	"flow" text,
	"run_id" text,
	"usd" numeric(14, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reservations_run_idx" ON "reservations" USING btree ("run_id") WHERE "reservations"."run_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reservations_tenant_idx" ON "reservations" USING btree ("tenant");
