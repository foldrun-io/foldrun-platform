-- Baseline: the eight migrations the platform shipped with, concatenated.
--
-- Every statement is IF NOT EXISTS / ADD COLUMN IF NOT EXISTS, so this file
-- is safe on a fresh database and a no-op on one that already ran them
-- under their old names (0001_identity … 0008_users_security, still recorded
-- in schema_migrations). From here on, `npm run db:generate` writes the next
-- file from src/schema.ts and the runner applies it in name order.
--
-- drizzle-kit would render this file from the schema as plain CREATE TABLE;
-- it was replaced by hand with the idempotent history, and the snapshot in
-- meta/ is what drizzle-kit diffs the next change against.

-- ---- 0001_identity
-- Sessions become rows so they can be REVOKED. As signed statements they
-- could not be: a stolen cookie stayed valid until it expired, and the
-- only kill switch was rotating the install key, which signs out
-- everybody. "Sign out my other devices" is table stakes and it needs a
-- row to delete.
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  tenant       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- What the person would recognise when deciding which to end. Never a
  -- raw IP beyond this: it is a security surface, not analytics.
  user_agent   TEXT,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

-- Who did what. The runs directory already records what agents did; this
-- records what PEOPLE did, which is the half an auditor asks for and the
-- half that was nowhere.
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant     TEXT,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  subject    TEXT,
  detail     JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS audit_tenant_at_idx ON audit_log (tenant, at DESC);

-- ---- 0002_ledger
-- Money. Append-only, exactly as the JSONL was, but with a balance the
-- database can compute under a transaction — which is what assertFunds
-- needs and what summing a file it just read cannot promise: two runs
-- admitted at once could each be judged against the same untouched
-- balance and both pass.
CREATE TABLE IF NOT EXISTS ledger (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant     TEXT NOT NULL,
  at         TIMESTAMPTZ NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('topup','run','adjustment')),
  -- numeric, never float: money summed in binary floating point drifts,
  -- and a balance is the one number nobody accepts "close enough" on.
  usd        NUMERIC(14,6) NOT NULL,
  cost       NUMERIC(14,6),
  workspace  TEXT,
  run_id     TEXT,
  note       TEXT,
  meter      JSONB,
  -- A run is charged ONCE. The file could not enforce that; a partial
  -- unique index can, and it makes the backfill idempotent for free.
  UNIQUE NULLS NOT DISTINCT (tenant, kind, run_id, at)
);
CREATE INDEX IF NOT EXISTS ledger_tenant_at_idx ON ledger (tenant, at DESC);

-- ---- 0003_queue
-- The queue, in the same database as the records a claim writes, so
-- claiming a job and marking its run can be one transaction. That is the
-- property no external broker offers without distributed-transaction
-- pain, and it is why this is not Redis.
CREATE TABLE IF NOT EXISTS queue (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- One job per run, enforced rather than hoped for. The file queue
  -- overwrote a pending file of the same name to get this; a unique
  -- index says it, and makes re-enqueue an explicit upsert.
  run_id      TEXT NOT NULL UNIQUE,
  tenant      TEXT NOT NULL,
  workspace   TEXT NOT NULL,
  model_override TEXT,
  tags        JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- A wait: parks in the queue rather than in a process, so a restart
  -- resumes the same deadline.
  not_before  TIMESTAMPTZ,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Position within this ACCOUNT's pending jobs, assigned at insert.
  -- Ordering by (seq, enqueued_at) is round-robin across accounts and
  -- FIFO within one, without a window function — which matters because
  -- FOR UPDATE cannot be combined with one, and SKIP LOCKED is the whole
  -- reason to be here.
  seq         BIGINT NOT NULL,
  claimed_at  TIMESTAMPTZ,
  claimed_by  TEXT
);
CREATE INDEX IF NOT EXISTS queue_ready_idx
  ON queue (seq, enqueued_at) WHERE claimed_at IS NULL;
CREATE INDEX IF NOT EXISTS queue_claimed_idx
  ON queue (claimed_at) WHERE claimed_at IS NOT NULL;

-- ---- 0004_tenant_keys
-- Envelope encryption. One data key per account, itself encrypted with
-- the install key, so a leaked install key is no longer every account's
-- secrets at once — it is one more step, per account, and rotating for
-- one customer stops meaning signing out all of them.
--
-- The wrapped key lives HERE while the secrets it opens live on the data
-- volume. Reading one without the other is useless, which is the point:
-- a stolen backup of either half is not a compromise.
CREATE TABLE IF NOT EXISTS tenant_keys (
  tenant     TEXT PRIMARY KEY,
  -- base64 of iv|tag|ciphertext, AES-256-GCM under the install key.
  wrapped    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at TIMESTAMPTZ
);

-- ---- 0005_queue_account_cap
-- The account's parallelism, carried on the job so the claim itself
-- can honour it: a worker steps over a row whose account already has
-- account_cap runs claimed, instead of claiming, counting run files
-- and handing the job back. NULL is "no cap of its own" — the
-- install's default applies. Written at enqueue; a cap that changes
-- reaches the next enqueue, and the exact check at run start still
-- stands behind it.
ALTER TABLE queue ADD COLUMN IF NOT EXISTS account_cap INTEGER;
CREATE INDEX IF NOT EXISTS queue_tenant_claimed_idx
  ON queue (tenant) WHERE claimed_at IS NOT NULL;

-- ---- 0006_queue_priority
-- Where a job stands against every other account's: the account's
-- lane plus the flow's own, as a number (high 10, low -10). Claimed
-- highest first, then the round-robin as before. The account cap
-- (0005) bounds how much of the fleet a high lane can hold.
ALTER TABLE queue ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS queue_ready_prio_idx
  ON queue (priority DESC, seq, enqueued_at) WHERE claimed_at IS NULL;

-- ---- 0007_users
-- People become rows. users.json was the last store still a file: the
-- one a second worker cannot share, the one no operator could correct,
-- and the one with no way back for a forgotten password. Email is
-- unique per install (one person, one sign-in), not per account — an
-- invite to a second account is a membership, not a second person, and
-- that is a later table. Everything the file held, held the same way.
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  tenant      TEXT NOT NULL,
  salt        TEXT NOT NULL,
  hash        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  timezone    TEXT,
  owner       BOOLEAN NOT NULL DEFAULT false,
  role        TEXT,
  -- NULL means every workspace in the account; a JSON array narrows it.
  workspaces  JSONB,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (lower(email));
CREATE INDEX IF NOT EXISTS users_tenant_idx ON users (tenant);

-- ---- 0008_users_security
-- What a sign-in needs beyond a password. A verified address is what
-- makes a reset link safe to send; an MFA secret is sealed with the
-- install key before it lands here (a dump of this table must not be a
-- dump of everyone's second factor); backup codes are stored hashed,
-- like passwords, for the same reason.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret        TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_backup        JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled_at    TIMESTAMPTZ;

