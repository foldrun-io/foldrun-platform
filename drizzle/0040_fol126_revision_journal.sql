-- FOL-126 phase 4 (8 Nov 2026): expand only — the revision journal as a table, so
-- it no longer depends on the shared volume. A new table; nothing released reads
-- or writes it, so a rollback leaves it unread (entries on the volume from the
-- earlier journal are still replayed at boot). Follows 0039.
CREATE TABLE "revision_journal" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "revision_journal_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant" text NOT NULL,
	"workspace" text NOT NULL,
	"entry_id" text NOT NULL,
	"entry" jsonb NOT NULL,
	"aside" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "revision_journal_entry_idx" ON "revision_journal" USING btree ("tenant","workspace","entry_id");--> statement-breakpoint
CREATE INDEX "revision_journal_ws_idx" ON "revision_journal" USING btree ("tenant","workspace","seq");