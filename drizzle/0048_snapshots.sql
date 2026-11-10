CREATE TABLE "snapshots" (
	"tenant" text NOT NULL,
	"workspace" text NOT NULL,
	"sha256" text NOT NULL,
	"files" integer NOT NULL,
	"bytes" bigint NOT NULL,
	"compressed_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"run_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "snapshots_tenant_workspace_sha256_pk" PRIMARY KEY("tenant","workspace","sha256")
);
--> statement-breakpoint
CREATE INDEX "snapshots_expiry" ON "snapshots" USING btree ("expires_at");