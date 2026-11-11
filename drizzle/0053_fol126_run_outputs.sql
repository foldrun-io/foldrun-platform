CREATE TABLE "run_outputs" (
	"tenant" text NOT NULL,
	"workspace" text NOT NULL,
	"run_id" text NOT NULL,
	"agent" text NOT NULL,
	"manifest" text NOT NULL,
	"files" integer NOT NULL,
	"bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_outputs_tenant_workspace_run_id_agent_pk" PRIMARY KEY("tenant","workspace","run_id","agent")
);
--> statement-breakpoint
CREATE INDEX "run_outputs_workspace_idx" ON "run_outputs" USING btree ("tenant","workspace");