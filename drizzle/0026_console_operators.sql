CREATE TABLE "console_operators" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"disabled_at" timestamp with time zone,
	"disabled_by" text,
	"totp_sealed" text,
	"totp_enabled_at" timestamp with time zone,
	"totp_last_step" bigint,
	"backup_hashes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enrol_code_hash" text,
	"enrol_code_until" timestamp with time zone,
	"totp_pending_sealed" text,
	"totp_pending_ceremony" text,
	"totp_pending_until" timestamp with time zone,
	"failed_codes" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"factor_generation" integer DEFAULT 0 NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "console_operators_role_check" CHECK ("console_operators"."role" IN ('owner','operator'))
);
--> statement-breakpoint
CREATE TABLE "console_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"operator_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"user_agent" text,
	"access_sub" text NOT NULL,
	"factor" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "console_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "console_sessions" ADD CONSTRAINT "console_sessions_operator_id_console_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."console_operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "console_operators_email_idx" ON "console_operators" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "console_sessions_operator_idx" ON "console_sessions" USING btree ("operator_id") WHERE "console_sessions"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "console_sessions_expiry_idx" ON "console_sessions" USING btree ("expires_at");