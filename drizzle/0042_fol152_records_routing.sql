-- FOL-152 (9 Nov 2026): expand only — where each workspace's records live
-- while they move off the data volume, and each process's acknowledgement of
-- the routing it follows. New tables; nothing released reads or writes them,
-- so a rollback leaves them unread. Follows 0041.
--   records_routing       files | moving | database per workspace, ('*','*')
--                         the install's default and the change counter
--   records_routing_pods  the routing generation each running process follows
CREATE TABLE "records_routing" (
	"tenant" text NOT NULL,
	"workspace" text NOT NULL,
	"state" text NOT NULL,
	"gen" bigint DEFAULT 0 NOT NULL,
	"moving_until" timestamp with time zone,
	"legacy" boolean DEFAULT false NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "records_routing_tenant_workspace_pk" PRIMARY KEY("tenant","workspace"),
	CONSTRAINT "records_routing_state_chk" CHECK ("records_routing"."state" IN ('files', 'moving', 'database'))
);
--> statement-breakpoint
CREATE TABLE "records_routing_pods" (
	"pod" text PRIMARY KEY NOT NULL,
	"gen" bigint DEFAULT 0 NOT NULL,
	"beat_at" timestamp with time zone DEFAULT now() NOT NULL
);
