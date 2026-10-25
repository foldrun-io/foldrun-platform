CREATE TABLE "oauth_clients" (
	"tenant" text NOT NULL,
	"key" text NOT NULL,
	"record" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_clients_tenant_key_pk" PRIMARY KEY("tenant","key")
);
--> statement-breakpoint
CREATE TABLE "oauth_connections" (
	"tenant" text NOT NULL,
	"key" text NOT NULL,
	"record" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_connections_tenant_key_pk" PRIMARY KEY("tenant","key")
);
