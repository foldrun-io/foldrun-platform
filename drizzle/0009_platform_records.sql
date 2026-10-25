CREATE TABLE "flow_state" (
	"tenant" text NOT NULL,
	"workspace" text NOT NULL,
	"flow" text NOT NULL,
	"last_fired_at" timestamp with time zone,
	"watch_checked_at" timestamp with time zone,
	"watch_hash" text,
	"last_run_at" timestamp with time zone,
	"pending" jsonb,
	"quarantined_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flow_state_tenant_workspace_flow_pk" PRIMARY KEY("tenant","workspace","flow")
);
--> statement-breakpoint
CREATE TABLE "notices" (
	"tenant" text NOT NULL,
	"kind" text NOT NULL,
	"scope" text NOT NULL,
	"payload" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notices_tenant_kind_scope_pk" PRIMARY KEY("tenant","kind","scope")
);
--> statement-breakpoint
CREATE TABLE "operator_accounts" (
	"tenant" text PRIMARY KEY NOT NULL,
	"state" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shares" (
	"token" text PRIMARY KEY NOT NULL,
	"tenant" text NOT NULL,
	"workspace" text NOT NULL,
	"path" text NOT NULL,
	"content_type" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by" text,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "shares_workspace_idx" ON "shares" USING btree ("tenant","workspace");