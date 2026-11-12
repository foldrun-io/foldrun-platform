-- FOL-126 (13 Nov 2026): expand only — the platform's own small bookkeeping per account,
-- which were files on the shared volume (src/marks.ts). A new table; a release without it
-- keeps its files, and the new one still reads them.
CREATE TABLE "platform_marks" (
	"tenant" text NOT NULL,
	"kind" text NOT NULL,
	"key" text DEFAULT '' NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_marks_tenant_kind_key_pk" PRIMARY KEY("tenant","kind","key")
);
--> statement-breakpoint
CREATE INDEX "platform_marks_kind_idx" ON "platform_marks" USING btree ("kind");