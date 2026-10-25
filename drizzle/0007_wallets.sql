CREATE TABLE "wallets" (
	"tenant" text PRIMARY KEY NOT NULL,
	"config" jsonb NOT NULL,
	"stripe_customer_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_stripe_customer_idx" ON "wallets" USING btree ("stripe_customer_id") WHERE "wallets"."stripe_customer_id" IS NOT NULL;