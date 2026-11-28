CREATE TABLE "memberships" (
	"user_id" text NOT NULL,
	"tenant" text NOT NULL,
	"role" text,
	"workspaces" jsonb,
	"owner" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_user_id_tenant_pk" PRIMARY KEY("user_id","tenant")
);
--> statement-breakpoint
CREATE INDEX "memberships_tenant_idx" ON "memberships" USING btree ("tenant");