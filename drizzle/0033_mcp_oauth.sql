-- MCP over OAuth (1 Nov 2026): claude.ai and other AI apps connect to /api/mcp
-- with an OAuth 2.1 sign-in instead of a pasted key. Expand only — three new
-- keyed tables (web server/mcp-oauth.ts) that the release before this one
-- never names: the self-registered clients, the connections people approved,
-- and the codes and tokens (stored by SHA-256, never in the clear).
CREATE TABLE "mcp_oauth_clients" (
	"tenant" text NOT NULL,
	"key" text NOT NULL,
	"record" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_oauth_clients_tenant_key_pk" PRIMARY KEY("tenant","key")
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_grants" (
	"tenant" text NOT NULL,
	"key" text NOT NULL,
	"record" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_oauth_grants_tenant_key_pk" PRIMARY KEY("tenant","key")
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_tokens" (
	"tenant" text NOT NULL,
	"key" text NOT NULL,
	"record" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_oauth_tokens_tenant_key_pk" PRIMARY KEY("tenant","key")
);
