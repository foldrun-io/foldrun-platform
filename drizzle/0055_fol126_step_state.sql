-- FOL-126 phase 7, step 1 (10 Nov 2026): expand only — what a step was handed and started
-- from, per run (core step-state.ts). A new table; nothing released reads or writes it, so
-- a rollback leaves it unread and the runs' folders keep working.
CREATE TABLE "run_step_state" (
	"tenant" text NOT NULL,
	"workspace" text NOT NULL,
	"run_id" text NOT NULL,
	"kind" text NOT NULL,
	"ref" text DEFAULT '' NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_step_state_tenant_workspace_run_id_kind_ref_pk" PRIMARY KEY("tenant","workspace","run_id","kind","ref")
);
