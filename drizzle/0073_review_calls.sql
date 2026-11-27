CREATE TABLE "review_calls" (
	"tenant" text NOT NULL,
	"invocation" text NOT NULL,
	"input_hash" text NOT NULL,
	"owner" text NOT NULL,
	"state" text NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_calls_tenant_invocation_pk" PRIMARY KEY("tenant","invocation")
);
--> statement-breakpoint
CREATE INDEX "review_calls_created_idx" ON "review_calls" USING btree ("created_at");