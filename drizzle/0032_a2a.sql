-- A2A (1 Nov 2026): outside agents call published flows over the Agent2Agent
-- protocol. Expand only — the release before this one never names either
-- api_keys column (both nullable, no default: it inserts without them and
-- reads every row it had) and never reads the new table.
--
-- api_keys.purpose: "a2a" for an outside agent's key, which opens /a2a/…
-- only; null for every API key. api_keys.a2a: that key's grant —
-- { workspace, flows, principal, maxTasks }.
ALTER TABLE "api_keys" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "a2a" jsonb;--> statement-breakpoint
-- One row per A2A task, written before its run is enqueued: the unique index
-- on (account, workspace, flow, caller, messageId) is the dedupe, so a
-- retried message finds its task and starts nothing.
CREATE TABLE "a2a_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant" text NOT NULL,
	"workspace" text NOT NULL,
	"flow" text NOT NULL,
	"run_id" text,
	"context_id" text NOT NULL,
	"caller_key_id" text NOT NULL,
	"message_id" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message" jsonb
);
--> statement-breakpoint
CREATE UNIQUE INDEX "a2a_tasks_message_idx" ON "a2a_tasks" USING btree ("tenant","workspace","flow","caller_key_id","message_id");--> statement-breakpoint
CREATE INDEX "a2a_tasks_caller_idx" ON "a2a_tasks" USING btree ("tenant","workspace","caller_key_id","updated_at");--> statement-breakpoint
CREATE INDEX "a2a_tasks_run_idx" ON "a2a_tasks" USING btree ("tenant","run_id");
