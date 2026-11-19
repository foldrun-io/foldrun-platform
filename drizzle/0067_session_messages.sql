CREATE TABLE "session_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant" text NOT NULL,
	"workspace" text NOT NULL,
	"context_key" text NOT NULL,
	"context_id" text NOT NULL,
	"sender" text NOT NULL,
	"sender_name" text NOT NULL,
	"from_context" text,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claim_token" text,
	"claimed_run" text,
	"claimed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "session_messages_context_idx" ON "session_messages" USING btree ("tenant","workspace","context_key","created_at");--> statement-breakpoint
CREATE INDEX "session_messages_created_idx" ON "session_messages" USING btree ("created_at");