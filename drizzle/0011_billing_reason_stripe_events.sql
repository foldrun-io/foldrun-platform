CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"created" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"tenant" text,
	"status" text NOT NULL,
	"outcome" text,
	"error" text,
	"amount_cents" bigint,
	"currency" text,
	"payload_sha256" text,
	"attempts" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ledger" ADD COLUMN "reason" text;--> statement-breakpoint
CREATE INDEX "stripe_events_received_idx" ON "stripe_events" USING btree ("received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "stripe_events_tenant_idx" ON "stripe_events" USING btree ("tenant","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "stripe_events_type_idx" ON "stripe_events" USING btree ("type","created" DESC NULLS LAST);