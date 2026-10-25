CREATE TABLE "backups" (
	"id" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"archive" text NOT NULL,
	"bytes" bigint,
	"sha256" text,
	"files" integer,
	"runs" integer,
	"kinds" jsonb NOT NULL,
	"accounts" jsonb NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"offsite" text,
	"keep_days" integer
);
--> statement-breakpoint
CREATE TABLE "restore_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant" text NOT NULL,
	"workspace" text,
	"target" text NOT NULL,
	"backup_id" text,
	"what" text NOT NULL,
	"note" text,
	"by" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"notified" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "prefs" jsonb;--> statement-breakpoint
CREATE INDEX "backups_at_idx" ON "backups" USING btree ("at");--> statement-breakpoint
CREATE INDEX "restore_requests_tenant_idx" ON "restore_requests" USING btree ("tenant","at");