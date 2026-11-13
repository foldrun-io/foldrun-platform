-- Tools on demand (14 Nov 2026): expand only — a new table, the leases callers hold on an
-- account's Whisper pod (src/tool-pod.ts). A release without it simply never uses it.
CREATE TABLE "tool_leases" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant" text NOT NULL,
	"tool" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "tool_leases_until_idx" ON "tool_leases" USING btree ("lease_until");--> statement-breakpoint
CREATE INDEX "tool_leases_tenant_tool_idx" ON "tool_leases" USING btree ("tenant","tool");