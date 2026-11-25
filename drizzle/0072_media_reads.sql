CREATE TABLE "media_reads" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant" text NOT NULL,
	"actor" text NOT NULL,
	"name" text NOT NULL,
	"data" text,
	"state" text NOT NULL,
	"text" text,
	"error" text,
	"worker" text,
	"deadline" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "media_reads_state_idx" ON "media_reads" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "media_reads_tenant_idx" ON "media_reads" USING btree ("tenant","state");