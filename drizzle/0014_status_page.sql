CREATE TABLE "status_incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"impact" text NOT NULL,
	"status" text NOT NULL,
	"components" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_samples" (
	"component" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"detail" text,
	CONSTRAINT "status_samples_component_at_pk" PRIMARY KEY("component","at")
);
--> statement-breakpoint
CREATE INDEX "status_incidents_starts_idx" ON "status_incidents" USING btree ("starts_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "status_samples_at_idx" ON "status_samples" USING btree ("at");