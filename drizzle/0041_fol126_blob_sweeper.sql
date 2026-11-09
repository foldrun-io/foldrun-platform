-- FOL-126 (8 Nov 2026): expand only — the blob sweeper's memory (when an object or a
-- workspace's leftover history was first seen unreferenced) and its run log, and an
-- index so "revisions made since T" is a range scan. New tables and an index;
-- nothing released reads or writes them, so a rollback leaves them unread.
-- Follows 0040.
CREATE TABLE "blob_sweep_marks" (
	"tenant" text NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"size" bigint DEFAULT 0 NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blob_sweep_marks_tenant_kind_ref_pk" PRIMARY KEY("tenant","kind","ref"),
	CONSTRAINT "blob_sweep_marks_kind_chk" CHECK ("blob_sweep_marks"."kind" IN ('blob', 'manifest', 'workspace'))
);
--> statement-breakpoint
CREATE TABLE "blob_sweep_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "blob_sweep_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"report" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "workspace_revisions_created_idx" ON "workspace_revisions" USING btree ("tenant","created_at");