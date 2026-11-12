-- FOL-126 (12 Nov 2026): expand only. Built runtime environments as archives in the object
-- store, one head row each (src/runtime-archives.ts). A new table; nothing released reads or
-- writes it, so a rollback leaves it unread and the runtime cache volume keeps working.
CREATE TABLE "runtime_archives" (
	"tenant" text DEFAULT '' NOT NULL,
	"variant" text NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"sha256" text NOT NULL,
	"bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_archives_tenant_variant_kind_ref_pk" PRIMARY KEY("tenant","variant","kind","ref")
);
--> statement-breakpoint
CREATE INDEX "runtime_archives_used_idx" ON "runtime_archives" USING btree ("used_at");