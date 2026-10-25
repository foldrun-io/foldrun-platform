CREATE TABLE "secret_health" (
	"tenant" text NOT NULL,
	"key" text NOT NULL,
	"last_at" timestamp with time zone NOT NULL,
	"host" text NOT NULL,
	"status" integer,
	"outcome" text NOT NULL,
	"refusals" integer DEFAULT 0 NOT NULL,
	"last_accepted" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "secret_health_pk" ON "secret_health" USING btree ("tenant","key");