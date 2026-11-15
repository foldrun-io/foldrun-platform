CREATE TABLE "login_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"binding" text NOT NULL,
	"digest" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"wrong" integer DEFAULT 0 NOT NULL,
	"sent" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "method" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "code_failed_run" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "code_locked_until" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "login_codes_user_binding_idx" ON "login_codes" USING btree ("user_id","binding");--> statement-breakpoint
CREATE INDEX "login_codes_expiry_idx" ON "login_codes" USING btree ("expires_at");