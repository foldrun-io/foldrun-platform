CREATE TABLE "support_views" (
	"tenant" text NOT NULL,
	"key" text NOT NULL,
	"record" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_views_tenant_key_pk" PRIMARY KEY("tenant","key")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "last_ip" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "expiry_warned_at" timestamp with time zone;