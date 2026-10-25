ALTER TABLE "backups" ADD COLUMN "encrypted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN "recipient" text;