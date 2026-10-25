CREATE TABLE "cli_logins" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"hostname" text NOT NULL,
	"status" text NOT NULL,
	"grant" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_pending" (
	"nonce" text PRIMARY KEY NOT NULL,
	"tenant" text NOT NULL,
	"payload" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "cli_logins_code_idx" ON "cli_logins" USING btree ("code");--> statement-breakpoint
CREATE INDEX "cli_logins_expiry_idx" ON "cli_logins" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_pending_expiry_idx" ON "oauth_pending" USING btree ("expires_at");