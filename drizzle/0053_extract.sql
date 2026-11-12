CREATE TABLE "extract_artifacts" (
	"tenant" text NOT NULL,
	"sha256" text NOT NULL,
	"options_key" text NOT NULL,
	"engine_spec" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extract_artifacts_tenant_sha256_options_key_pk" PRIMARY KEY("tenant","sha256","options_key")
);
--> statement-breakpoint
CREATE TABLE "extract_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant" text NOT NULL,
	"workspace" text,
	"actor" text NOT NULL,
	"status" text NOT NULL,
	"options" jsonb NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"write_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"lease_until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "extract_jobs_tenant_status_idx" ON "extract_jobs" USING btree ("tenant","status");--> statement-breakpoint
CREATE INDEX "extract_jobs_created_idx" ON "extract_jobs" USING btree ("created_at");