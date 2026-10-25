CREATE TABLE "email_preferences" (
	"tenant" text NOT NULL,
	"email" text NOT NULL,
	"category" text NOT NULL,
	"workspace" text DEFAULT '' NOT NULL,
	"enabled" boolean NOT NULL,
	"source" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_preferences_tenant_email_category_workspace_pk" PRIMARY KEY("tenant","email","category","workspace")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant" text NOT NULL,
	"workspace" text NOT NULL,
	"event" text NOT NULL,
	"status" text NOT NULL,
	"body" text NOT NULL,
	"destination" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"attempt_log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_status_code" integer,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"tenant" text NOT NULL,
	"workspace" text NOT NULL,
	"url_hash" text NOT NULL,
	"failing_since" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"disabled_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_endpoints_tenant_workspace_pk" PRIMARY KEY("tenant","workspace")
);
--> statement-breakpoint
CREATE INDEX "webhook_deliveries_ws_idx" ON "webhook_deliveries" USING btree ("tenant","workspace","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("next_attempt_at");