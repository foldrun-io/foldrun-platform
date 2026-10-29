CREATE TABLE "invites" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant" text NOT NULL,
	"role" text NOT NULL,
	"workspaces" jsonb,
	"email" text,
	"created_by" text NOT NULL,
	"created_by_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by" text,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revoke_reason" text
);
--> statement-breakpoint
CREATE INDEX "invites_pending_expires_idx" ON "invites" USING btree ("tenant","expires_at") WHERE "invites"."used_at" IS NULL AND "invites"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "invites_pending_email_idx" ON "invites" USING btree ("tenant",lower("email")) WHERE "invites"."used_at" IS NULL AND "invites"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "invites_pending_creator_idx" ON "invites" USING btree ("tenant","created_by") WHERE "invites"."used_at" IS NULL AND "invites"."revoked_at" IS NULL;