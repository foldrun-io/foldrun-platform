-- Operator settings (30 Oct 2026, console separation stage 6): what the SaaS
-- operator decides for the whole install — prices, sign-up, limits,
-- retention, mail — as rows the platform reads (src/settings.ts) instead of
-- environment a deploy has to change. Overrides only: an install with no
-- rows behaves as its environment says. `value` NULL is a reset; rows are
-- never deleted, and every write takes the next version, so the poll's
-- sum(version) only grows. The ledger line of a run records the settings
-- version its prices were read at. Expand only: a new table, a sequence and
-- a nullable column — the release before this one never names them.
CREATE SEQUENCE IF NOT EXISTS "public"."platform_settings_version_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb,
	"version" bigint DEFAULT nextval('platform_settings_version_seq') NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The sequence belongs to the column, so dropping the table (a test database
-- reset) takes the sequence with it.
ALTER SEQUENCE "public"."platform_settings_version_seq" OWNED BY "platform_settings"."version";--> statement-breakpoint
ALTER TABLE "ledger" ADD COLUMN "pricing_version" bigint;