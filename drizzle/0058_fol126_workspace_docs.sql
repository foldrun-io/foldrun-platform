-- FOL-126, the last files on the volume (13 Nov 2026): expand only — a workspace's small
-- state that was files in its folder (core DocsPort: webhook generations, eval results,
-- grader cursors, the deployed commit, captured calls; and the logs beside them). New
-- tables; nothing released reads or writes them, so a rollback leaves them unread and the
-- files keep working. Written only while `records.docs_store` is on.
CREATE TABLE "workspace_docs" (
	"tenant" text NOT NULL,
	"workspace" text NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_docs_tenant_workspace_kind_key_pk" PRIMARY KEY("tenant","workspace","kind","key")
);
--> statement-breakpoint
CREATE TABLE "workspace_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant" text NOT NULL,
	"workspace" text NOT NULL,
	"kind" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "workspace_logs_scope_idx" ON "workspace_logs" USING btree ("tenant","workspace","kind","id");