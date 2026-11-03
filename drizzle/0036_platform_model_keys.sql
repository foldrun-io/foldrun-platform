-- foldrun's models (3 Nov 2026): expand only — the platform's own provider
-- keys, set in the operator console and sealed under a key derived from the
-- install key, instead of the environment.
CREATE TABLE "platform_model_keys" (
	"provider" text PRIMARY KEY NOT NULL,
	"sealed" text NOT NULL,
	"hint" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
