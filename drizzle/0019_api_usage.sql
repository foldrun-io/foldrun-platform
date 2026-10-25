CREATE TABLE "api_deprecation_notices" (
	"tenant" text NOT NULL,
	"route" text NOT NULL,
	"step" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_deprecation_notices_tenant_route_step_pk" PRIMARY KEY("tenant","route","step")
);
--> statement-breakpoint
CREATE TABLE "api_usage" (
	"tenant" text NOT NULL,
	"day" text NOT NULL,
	"version" text NOT NULL,
	"route" text DEFAULT '' NOT NULL,
	"credential" text DEFAULT '' NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_usage_tenant_day_version_route_credential_pk" PRIMARY KEY("tenant","day","version","route","credential")
);
--> statement-breakpoint
CREATE INDEX "api_usage_route_day_idx" ON "api_usage" USING btree ("route","day");