CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"hash" text NOT NULL,
	"prefix" text NOT NULL,
	"label" text NOT NULL,
	"tenant" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"revoked_at" timestamp with time zone,
	"scope" jsonb,
	"role" text,
	"workspaces" jsonb
);
--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_idx" ON "api_keys" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "api_keys_tenant_idx" ON "api_keys" USING btree ("tenant");