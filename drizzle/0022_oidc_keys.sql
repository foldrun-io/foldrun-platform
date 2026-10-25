CREATE TABLE "oidc_keys" (
	"tenant" text NOT NULL,
	"key" text NOT NULL,
	"record" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oidc_keys_tenant_key_pk" PRIMARY KEY("tenant","key")
);
