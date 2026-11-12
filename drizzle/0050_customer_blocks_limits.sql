CREATE TABLE "customer_blocks" (
	"tenant" text NOT NULL,
	"customer" text NOT NULL,
	"blocked_by" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_blocks_tenant_customer_pk" PRIMARY KEY("tenant","customer")
);
--> statement-breakpoint
CREATE TABLE "customer_limits" (
	"tenant" text PRIMARY KEY NOT NULL,
	"limits" jsonb NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
