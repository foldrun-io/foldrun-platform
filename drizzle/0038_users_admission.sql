-- 7 Nov 2026 (sign-up switches): expand only — the door an account came in by
-- (signup.ts Admission). Nullable: people from before it read as NULL, and a
-- release that does not know the column leaves it as it is.
ALTER TABLE "users" ADD COLUMN "admission" text;
