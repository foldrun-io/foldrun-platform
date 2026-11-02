-- foldrun's models (3 Nov 2026): expand only — two new tables no released
-- code names. account_model_choice is what an account chose to run on (its
-- own key or the platform's, per provider); model_usage is one row per call
-- the model gateway let through on a platform key, the bill for them.
CREATE TABLE "account_model_choice" (
	"tenant" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"provider" text,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant" text NOT NULL,
	"day" text NOT NULL,
	"kind" text NOT NULL,
	"run_id" text,
	"step" integer,
	"job" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(14, 6) NOT NULL,
	"status" text NOT NULL,
	"price_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"settled_key" text
);
--> statement-breakpoint
CREATE INDEX "model_usage_tenant_day_idx" ON "model_usage" USING btree ("tenant","day");--> statement-breakpoint
CREATE INDEX "model_usage_run_idx" ON "model_usage" USING btree ("tenant","run_id");--> statement-breakpoint
CREATE INDEX "model_usage_unsettled_idx" ON "model_usage" USING btree ("settled_key","status");