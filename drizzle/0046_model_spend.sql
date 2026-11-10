CREATE TABLE "model_spend" (
	"tenant" text NOT NULL,
	"scope" text NOT NULL,
	"usd" numeric(16, 6) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_spend_tenant_scope_pk" PRIMARY KEY("tenant","scope")
);
