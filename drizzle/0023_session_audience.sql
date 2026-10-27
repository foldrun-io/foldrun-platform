ALTER TABLE "sessions" ADD COLUMN "audience" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "mfa_at" timestamp with time zone;