CREATE TABLE "assistant_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant" text NOT NULL,
	"workspace" text NOT NULL,
	"owner" text NOT NULL,
	"title" text NOT NULL,
	"messages" jsonb NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant" text NOT NULL,
	"workspace" text NOT NULL,
	"payload" jsonb NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"heartbeat_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "assistant_conversations_owner_idx" ON "assistant_conversations" USING btree ("tenant","owner","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "assistant_jobs_pending_idx" ON "assistant_jobs" USING btree ("claimed_at","enqueued_at");--> statement-breakpoint
CREATE INDEX "assistant_jobs_tenant_idx" ON "assistant_jobs" USING btree ("tenant");