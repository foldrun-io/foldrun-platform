-- foldrun's models (3 Nov 2026): expand only — when a call was claimed for its
-- ledger line, so the recovery pass for a claim whose line never landed counts
-- from the claim, not the call's own age (Codex review).
ALTER TABLE "model_usage" ADD COLUMN "settled_at" timestamp with time zone;