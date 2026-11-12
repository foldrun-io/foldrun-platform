CREATE TABLE "vault_scopes" (
	"tenant" text NOT NULL,
	"workspace" text DEFAULT '' NOT NULL,
	"gen" bigint DEFAULT 0 NOT NULL,
	"records" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vault_scopes_tenant_workspace_pk" PRIMARY KEY("tenant","workspace")
);
