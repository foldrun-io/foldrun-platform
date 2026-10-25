CREATE TABLE "feature_flags" (
	"flag" text NOT NULL,
	"tenant" text DEFAULT '' NOT NULL,
	"enabled" boolean,
	"rollout" integer,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_flags_flag_tenant_pk" PRIMARY KEY("flag","tenant")
);
--> statement-breakpoint
CREATE INDEX "feature_flags_tenant_idx" ON "feature_flags" USING btree ("tenant");