CREATE TABLE "browse_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant" text NOT NULL,
	"key_id" text,
	"invocation" text,
	"input" jsonb NOT NULL,
	"state" text NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"worker" text,
	"pod_name" text,
	"result" jsonb,
	"error" text,
	"deadline" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "browse_jobs_state_idx" ON "browse_jobs" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "browse_jobs_tenant_idx" ON "browse_jobs" USING btree ("tenant","state");--> statement-breakpoint
CREATE UNIQUE INDEX "browse_jobs_invocation_idx" ON "browse_jobs" USING btree ("tenant","invocation");