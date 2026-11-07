-- FOL-126 phase 2 (7 Nov 2026): expand only — the storage refactor's pointers
-- and the records that left the data volume. Every table is new; nothing
-- released reads or writes any of them, so a rollback leaves them unread.
-- (Numbered 0039: 0038 is users.admission, merged first.)
--   workspace_heads/revisions/ops  two heads per workspace (workspace, state)
--   workspace_files                the storage/ file index
--   blob_pins                      what a blob sweeper must never delete
--   run_records                    runs, whole, plus the columns a list needs
--   trigger_events                 why a trigger did or did not become a run
--   lock_fences                    fencing tokens for short named locks
CREATE TABLE "blob_pins" (
	"tenant" text NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"holder_kind" text NOT NULL,
	"holder_id" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blob_pins_tenant_kind_ref_holder_kind_holder_id_pk" PRIMARY KEY("tenant","kind","ref","holder_kind","holder_id"),
	CONSTRAINT "blob_pins_kind_chk" CHECK ("blob_pins"."kind" IN ('blob', 'manifest')),
	CONSTRAINT "blob_pins_holder_chk" CHECK ("blob_pins"."holder_kind" IN ('publish', 'revision', 'run'))
);
--> statement-breakpoint
CREATE TABLE "lock_fences" (
	"name" text PRIMARY KEY NOT NULL,
	"token" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_records" (
	"tenant" text NOT NULL,
	"workspace" text NOT NULL,
	"run_id" text NOT NULL,
	"flow" text,
	"status" text NOT NULL,
	"live" boolean DEFAULT false NOT NULL,
	"started_at" text NOT NULL,
	"finished_at" text,
	"summary" jsonb NOT NULL,
	"record" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_records_tenant_workspace_run_id_pk" PRIMARY KEY("tenant","workspace","run_id")
);
--> statement-breakpoint
CREATE TABLE "trigger_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "trigger_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant" text NOT NULL,
	"workspace" text NOT NULL,
	"t" text NOT NULL,
	"flow" text NOT NULL,
	"trigger" text NOT NULL,
	"outcome" text NOT NULL,
	"detail" text,
	"run_id" text
);
--> statement-breakpoint
CREATE TABLE "workspace_files" (
	"tenant" text NOT NULL,
	"workspace" text NOT NULL,
	"path" text NOT NULL,
	"sha" text NOT NULL,
	"size" bigint NOT NULL,
	"mime" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"by" text NOT NULL,
	CONSTRAINT "workspace_files_tenant_workspace_path_pk" PRIMARY KEY("tenant","workspace","path")
);
--> statement-breakpoint
CREATE TABLE "workspace_heads" (
	"tenant" text NOT NULL,
	"workspace" text NOT NULL,
	"scope" text DEFAULT 'workspace' NOT NULL,
	"revision_id" text NOT NULL,
	"seq" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_heads_tenant_workspace_scope_pk" PRIMARY KEY("tenant","workspace","scope"),
	CONSTRAINT "workspace_heads_scope_chk" CHECK ("workspace_heads"."scope" IN ('workspace', 'state'))
);
--> statement-breakpoint
CREATE TABLE "workspace_ops" (
	"tenant" text NOT NULL,
	"workspace" text NOT NULL,
	"scope" text DEFAULT 'workspace' NOT NULL,
	"op_id" text NOT NULL,
	"digest" text NOT NULL,
	"outcome" text NOT NULL,
	"revision_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_ops_tenant_workspace_scope_op_id_pk" PRIMARY KEY("tenant","workspace","scope","op_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant" text NOT NULL,
	"workspace" text NOT NULL,
	"scope" text DEFAULT 'workspace' NOT NULL,
	"seq" integer NOT NULL,
	"parent_id" text,
	"authored" text NOT NULL,
	"state" text NOT NULL,
	"by" text NOT NULL,
	"message" text NOT NULL,
	"op_id" text NOT NULL,
	"restored_from" text,
	"conflicts" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "blob_pins_holder_idx" ON "blob_pins" USING btree ("tenant","holder_kind","holder_id");--> statement-breakpoint
CREATE INDEX "blob_pins_expiry_idx" ON "blob_pins" USING btree ("expires_at") WHERE "blob_pins"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "run_records_list_idx" ON "run_records" USING btree ("tenant","workspace","started_at");--> statement-breakpoint
CREATE INDEX "run_records_live_idx" ON "run_records" USING btree ("tenant","workspace") WHERE "run_records"."live";--> statement-breakpoint
CREATE INDEX "run_records_updated_idx" ON "run_records" USING btree ("updated_at") WHERE "run_records"."live";--> statement-breakpoint
CREATE INDEX "trigger_events_ws_idx" ON "trigger_events" USING btree ("tenant","workspace","id");--> statement-breakpoint
CREATE INDEX "workspace_files_sha_idx" ON "workspace_files" USING btree ("tenant","sha");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_revisions_seq_idx" ON "workspace_revisions" USING btree ("tenant","workspace","scope","seq");