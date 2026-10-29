// The tables, as code.
//
// Drizzle's schema is the one description of what Postgres holds. Every
// query in the platform is typed against it, and `drizzle-kit generate`
// turns a change here into the next migration file — so a column added in
// this file cannot be forgotten in a CREATE TABLE somewhere else, and a
// query cannot name a column that does not exist.
//
// Every table here is a RECORD, not a document (docs/paas-adr.md): runs'
// money, jobs, identity and audit — the things that need transactions,
// indexes and concurrent writers. Workspaces, agents and flows stay files.
//
// The column names are the database's (snake_case); the TypeScript names
// are ours. Comments on the columns are the reasons, kept from the SQL
// they replaced, because a reason lost is a decision re-argued.

import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";

const now = () => sql`now()`;

/** Sessions are rows so they can be REVOKED. As signed statements they
 *  could not be: a stolen cookie stayed valid until it expired. */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    tenant: text("tenant").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now()),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().default(now()),
    /** What the person would recognise when deciding which to end. Never a
     *  raw IP beyond this: it is a security surface, not analytics. */
    userAgent: text("user_agent"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** Which surface the session was made for (27 Oct 2026): null is the
     *  customer app; "admin" is the operator console, and only those are
     *  accepted there — a customer session copied across is refused. */
    audience: text("audience"),
    /** When the second factor was completed for this session; null when the
     *  sign-in did not ask for one. The console requires it. */
    mfaAt: timestamp("mfa_at", { withTimezone: true }),
  },
  (t) => [
    index("sessions_user_idx").on(t.userId).where(sql`${t.revokedAt} IS NULL`),
    index("sessions_expiry_idx").on(t.expiresAt),
  ],
);

/** Who did what. The runs directory records what agents did; this records
 *  what PEOPLE did — the half an auditor asks for. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    at: timestamp("at", { withTimezone: true }).notNull().default(now()),
    tenant: text("tenant"),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    subject: text("subject"),
    detail: jsonb("detail").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [index("audit_tenant_at_idx").on(t.tenant, t.at.desc())],
);

/** Money. Append-only, with a balance the database can compute under a
 *  transaction — which is what assertFunds needs and what summing a file
 *  it just read cannot promise. */
export const ledger = pgTable(
  "ledger",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    tenant: text("tenant").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    kind: text("kind").notNull(),
    /** numeric, never float: a balance is the one number nobody accepts
     *  "close enough" on. Comes back as a string; Number() happens once, in
     *  the row mapper. */
    usd: numeric("usd", { precision: 14, scale: 6 }).notNull(),
    cost: numeric("cost", { precision: 14, scale: 6 }),
    workspace: text("workspace"),
    runId: text("run_id"),
    note: text("note"),
    meter: jsonb("meter"),
    /** The once-only handle: `run:<id>`, `accrual:base-fee:<day>`,
     *  `pod:<kind>:<name>:<from>`, `grant:<marker>` — whatever makes two
     *  writes of the same fact the same row. Rows from before the column
     *  carry a key derived from (kind, at, run_id, note) by the migration,
     *  the same derivation the backfill uses, so the file history imports
     *  once however many times a worker boots. */
    key: text("key"),
    /** The charge in the customer's two halves; NULL on lines from before
     *  the split existed. */
    split: jsonb("split"),
    /** The flow this run was, so "what does this desk cost" survives the
     *  run record being pruned. */
    flow: text("flow"),
    /** The charge split across the agents that did the work. */
    agents: jsonb("agents"),
    /** The legs this account does not pay, as the reason for a zero. */
    waived: jsonb("waived"),
    /** On a grant: how much of it rolled over from the last cycle. */
    carriedUsd: numeric("carried_usd", { precision: 14, scale: 6 }),
    /** Why the line exists, finer than `kind` — a refund and a goodwill
     *  credit are both adjustments. NULL on rows from before the column;
     *  `entryReason` derives those from the key and the note. */
    reason: text("reason"),
  },
  (t) => [
    check("ledger_kind_check", sql`${t.kind} IN ('topup','run','adjustment','grant','expire')`),
    // A run is charged ONCE, and the database is what says so: the file
    // marker is a fast path, but across worker pods only a unique index
    // can refuse the second charge. Partial, because every other kind of
    // line has no run — and the old key, which included `at`, let two
    // settles a millisecond apart both land.
    uniqueIndex("ledger_run_once_idx").on(t.tenant, t.runId).where(sql`${t.kind} = 'run'`),
    // Every other once-only fact — an accrual for a day, a pod session, a
    // grant for an invoice — is keyed by name, so the base fee and the
    // storage line for one sweep (same `now`, no run) are two rows, not a
    // conflict that ate the second.
    uniqueIndex("ledger_key_idx").on(t.tenant, t.key).where(sql`${t.key} IS NOT NULL`),
    index("ledger_tenant_at_idx").on(t.tenant, t.at.desc()),
  ],
);

/** Every Stripe webhook delivery, whatever became of it. The ledger says
 *  what money moved; this says what Stripe TOLD us and what we did about
 *  it — the row a support question starts from ("did the invoice event
 *  arrive?") and the one an operator replays. The payload itself is not
 *  kept (it carries names and addresses); its hash is, so a replay that
 *  re-fetched something different says so. */
export const stripeEvents = pgTable(
  "stripe_events",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    /** When Stripe created the event, not when it reached us. */
    created: timestamp("created", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().default(now()),
    /** The last time it was processed — a redelivery or a replay moves it. */
    processedAt: timestamp("processed_at", { withTimezone: true }),
    tenant: text("tenant"),
    /** ok | skipped | error | ignored */
    status: text("status").notNull(),
    outcome: text("outcome"),
    error: text("error"),
    /** What the event's object was worth, in the smallest unit, when it
     *  carries an amount — an invoice's amount_paid is where subscription
     *  revenue is counted from. */
    amountCents: bigint("amount_cents", { mode: "number" }),
    currency: text("currency"),
    payloadSha256: text("payload_sha256"),
    /** The verified event as it first arrived (28 Oct 2026), for replay
     *  after Stripe's own copy is gone (30 days). Set once, never by a
     *  redelivery; emptied by the hosted daily sweep after 180 days. */
    payload: jsonb("payload"),
    attempts: integer("attempts").notNull().default(1),
  },
  (t) => [
    index("stripe_events_received_idx").on(t.receivedAt.desc()),
    index("stripe_events_tenant_idx").on(t.tenant, t.receivedAt.desc()),
    index("stripe_events_type_idx").on(t.type, t.created.desc()),
  ],
);

/** The queue, in the same database as the records a claim writes, so
 *  claiming a job and marking its run can be one transaction. */
export const queue = pgTable(
  "queue",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    /** One job per run, enforced rather than hoped for. Named as Postgres
     *  named it when the SQL created it, so drizzle-kit never proposes a
     *  rename of a constraint that already exists. */
    runId: text("run_id").notNull(),
    tenant: text("tenant").notNull(),
    workspace: text("workspace").notNull(),
    modelOverride: text("model_override"),
    tags: jsonb("tags").notNull().default(sql`'[]'::jsonb`),
    /** A wait: parks in the queue rather than in a process. */
    notBefore: timestamp("not_before", { withTimezone: true }),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().default(now()),
    /** Position within this ACCOUNT's pending jobs, assigned at insert.
     *  Ordering by (seq, enqueued_at) is round-robin across accounts without
     *  a window function, which FOR UPDATE forbids. */
    seq: bigint("seq", { mode: "number" }).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimedBy: text("claimed_by"),
    /** The account's own parallelism cap; NULL lets the install's default apply. */
    accountCap: integer("account_cap"),
    /** Lane: account priority + flow priority (high 10, low -10). Orders
     *  jobs among accounts whose shares are equal, and an account's own. */
    priority: integer("priority").notNull().default(0),
    /** The account's share of the fleet when it is contended: high 3,
     *  normal 2, low 1 (wallet.ts accountWeight). The claim serves the
     *  account with the fewest claimed jobs per unit of weight first; NULL
     *  — a job queued by a release before 17 Oct 2026 — is normal. */
    accountWeight: integer("account_weight"),
    /** A resume was asked for while a worker held the claim — an approval
     *  landing as the run parked. Releasing the claim then puts the job
     *  back instead of deleting it. */
    resumeRequested: boolean("resume_requested").notNull().default(false),
  },
  (t) => [
    unique("queue_run_id_key").on(t.runId),
    index("queue_ready_idx").on(t.seq, t.enqueuedAt).where(sql`${t.claimedAt} IS NULL`),
    index("queue_claimed_idx").on(t.claimedAt).where(sql`${t.claimedAt} IS NOT NULL`),
    index("queue_tenant_claimed_idx").on(t.tenant).where(sql`${t.claimedAt} IS NOT NULL`),
    index("queue_ready_prio_idx").on(t.priority.desc(), t.seq, t.enqueuedAt).where(sql`${t.claimedAt} IS NULL`),
  ],
);

/** A run's expected share of its account's money and caps, held from the
 *  moment it is admitted until it settles. The caps and the funds gate were
 *  read-then-admit: ten webhook runs in one second all read $4.99 against
 *  a $5/day cap and all passed. A reservation is what the next admission
 *  reads, and it is taken in the same transaction as the check, under a
 *  per-tenant lock, so two workers cannot both admit past the line. Keyed
 *  by its own id because the run id is minted after the gate; bound to the
 *  run once the record exists, released when the run's charge lands. */
export const reservations = pgTable(
  "reservations",
  {
    id: text("id").primaryKey(),
    tenant: text("tenant").notNull(),
    workspace: text("workspace").notNull(),
    flow: text("flow"),
    runId: text("run_id"),
    usd: numeric("usd", { precision: 14, scale: 6 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now()),
  },
  (t) => [
    uniqueIndex("reservations_run_idx").on(t.runId).where(sql`${t.runId} IS NOT NULL`),
    index("reservations_tenant_idx").on(t.tenant),
  ],
);

/** Envelope encryption: one data key per account, wrapped by the install
 *  key. The wrapped key lives here while the secrets it opens live on the
 *  data volume; a stolen backup of either half is not a compromise. */
export const tenantKeys = pgTable("tenant_keys", {
  tenant: text("tenant").primaryKey(),
  /** The account's data key, wrapped by the root-key provider named in its
   *  prefix: `env:` (AES-256-GCM under FOLDRUN_SECRET_KEY) or `kms:` (a KMS
   *  ciphertext bound to the account by its encryption context). */
  wrapped: text("wrapped").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now()),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
});

/** People. Email is unique per install (one person, one sign-in); an
 *  invite to a second account is a membership, not a second person. */
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    tenant: text("tenant").notNull(),
    salt: text("salt").notNull(),
    hash: text("hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now()),
    timezone: text("timezone"),
    owner: boolean("owner").notNull().default(false),
    role: text("role"),
    /** NULL means every workspace in the account; a JSON array narrows it. */
    workspaces: jsonb("workspaces"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now()),
    /** A verified address is what makes a reset link safe to send. */
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    /** Sealed with the install key before it lands here. */
    mfaSecret: text("mfa_secret"),
    /** sha256 hex of each unused backup code, stored hashed like passwords. */
    mfaBackup: jsonb("mfa_backup"),
    mfaEnabledAt: timestamp("mfa_enabled_at", { withTimezone: true }),
    /** A person's own small settings — the onboarding card dismissed, and
     *  the like. A JSON object; NULL means every default. */
    prefs: jsonb("prefs"),
  },
  (t) => [uniqueIndex("users_email_idx").on(sql`lower(${t.email})`), index("users_tenant_idx").on(t.tenant)],
);

/** A team invite (29 Oct 2026). The link carries only its id, expiry and a
 *  MAC; the row holds what it grants — role, workspaces, the address it is
 *  for — and its life: accepted once (`used_at`, by one UPDATE … WHERE
 *  used_at IS NULL in the transaction that creates the member), or revoked.
 *  Before this an invite was a signed statement stored nowhere, so it could
 *  be used any number of times and nobody could take it back. */
export const invites = pgTable(
  "invites",
  {
    id: text("id").primaryKey(),
    tenant: text("tenant").notNull(),
    role: text("role").notNull(),
    /** NULL means every workspace in the account; a JSON array narrows it. */
    workspaces: jsonb("workspaces"),
    /** The one address that may accept it; NULL for a link anyone may use, once. */
    email: text("email"),
    /** The member who made it (user id) — their standing is checked again
     *  when it is accepted. The email is for the list, not for the check. */
    createdBy: text("created_by").notNull(),
    createdByEmail: text("created_by_email").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now()),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    usedBy: text("used_by"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by"),
    revokeReason: text("revoke_reason"),
  },
  (t) => [
    index("invites_pending_expires_idx").on(t.tenant, t.expiresAt).where(sql`${t.usedAt} IS NULL AND ${t.revokedAt} IS NULL`),
    index("invites_pending_email_idx").on(t.tenant, sql`lower(${t.email})`).where(sql`${t.usedAt} IS NULL AND ${t.revokedAt} IS NULL`),
    index("invites_pending_creator_idx").on(t.tenant, t.createdBy).where(sql`${t.usedAt} IS NULL AND ${t.revokedAt} IS NULL`),
  ],
);

/** The operator console's people (29 Oct 2026): who may use an operator
 *  console, by the email their identity provider vouches for, and their own
 *  second factor. Read and written only by the console's code, never by the
 *  customer app; nothing here is an app account. */
export const consoleOperators = pgTable(
  "console_operators",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name"),
    /** owner manages operators; operator uses the console. */
    role: text("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now()),
    createdBy: text("created_by").notNull(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledBy: text("disabled_by"),
    /** The TOTP secret, sealed under the install key — never the base32. */
    totpSealed: text("totp_sealed"),
    totpEnabledAt: timestamp("totp_enabled_at", { withTimezone: true }),
    /** The 30-second step of the last code accepted: a code is good once. */
    totpLastStep: bigint("totp_last_step", { mode: "number" }),
    /** sha256 of each unused backup code. */
    backupHashes: jsonb("backup_hashes").notNull().default(sql`'[]'::jsonb`),
    /** A one-time enrolment code (sha256) and until when it works: the
     *  second factor is set up with it, never on the identity alone. */
    enrolCodeHash: text("enrol_code_hash"),
    enrolCodeUntil: timestamp("enrol_code_until", { withTimezone: true }),
    /** An enrolment in progress: the secret shown, sealed, and the
     *  ceremony it belongs to (sha256 of a token the browser holds). */
    totpPendingSealed: text("totp_pending_sealed"),
    totpPendingCeremony: text("totp_pending_ceremony"),
    totpPendingUntil: timestamp("totp_pending_until", { withTimezone: true }),
    /** Wrong codes in a row, and the lock they earn. */
    failedCodes: integer("failed_codes").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    /** Bumped whenever the second factor is set up or reset. */
    factorGeneration: integer("factor_generation").notNull().default(0),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("console_operators_email_idx").on(sql`lower(${t.email})`),
    check("console_operators_role_check", sql`${t.role} IN ('owner','operator')`),
  ],
);

/** A console session: the row is keyed by sha256 of the cookie, so the
 *  database never holds a usable token. Short: eight hours at most, an hour
 *  idle, and bound to the identity-provider subject it was made under. */
export const consoleSessions = pgTable(
  "console_sessions",
  {
    id: text("id").primaryKey(),
    operatorId: text("operator_id")
      .notNull()
      .references(() => consoleOperators.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now()),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().default(now()),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    userAgent: text("user_agent"),
    accessSub: text("access_sub").notNull(),
    /** How the second factor was given: totp or backup. */
    factor: text("factor").notNull(),
  },
  (t) => [
    index("console_sessions_operator_idx").on(t.operatorId).where(sql`${t.revokedAt} IS NULL`),
    index("console_sessions_expiry_idx").on(t.expiresAt),
  ],
);

/** The console's own switches, by name (e.g. whether the old shared
 *  sign-in is still accepted). */
export const consoleSettings = pgTable("console_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now()),
  updatedBy: text("updated_by").notNull(),
});

/** Which migrations have run, by file name. The runner's own table; here so
 *  drizzle-kit does not try to drop it as unknown. */
/** A `foldrun login` request, from the terminal asking to the key being
 *  collected: ten minutes at most. It was a file every web pod rewrote whole;
 *  as rows, the key is handed over by one DELETE … RETURNING, so two polls
 *  can never both collect it. `grant` holds the minted key encrypted. */
export const cliLogins = pgTable(
  "cli_logins",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull(),
    hostname: text("hostname").notNull(),
    status: text("status").notNull(),
    grant: jsonb("grant"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now()),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("cli_logins_code_idx").on(t.code), index("cli_logins_expiry_idx").on(t.expiresAt)],
);

/** An OAuth consent between "Connect" and the provider's callback. The
 *  client secret inside `payload` is encrypted; the row is taken once, by
 *  DELETE … RETURNING, before any network call. */
export const oauthPending = pgTable(
  "oauth_pending",
  {
    nonce: text("nonce").primaryKey(),
    tenant: text("tenant").notNull(),
    payload: jsonb("payload").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("oauth_pending_expiry_idx").on(t.expiresAt)],
);

/** Does each credential still work? The last use, what the other end said,
 *  consecutive refusals and the last acceptance — never the value. It was
 *  secret-health.json, rewritten whole by every pod (last writer won); each
 *  use is now one upsert whose counters are computed by the database. */
export const secretHealth = pgTable(
  "secret_health",
  {
    tenant: text("tenant").notNull(),
    key: text("key").notNull(),
    lastAt: timestamp("last_at", { withTimezone: true }).notNull(),
    host: text("host").notNull(),
    status: integer("status"),
    outcome: text("outcome").notNull(),
    refusals: integer("refusals").notNull().default(0),
    lastAccepted: timestamp("last_accepted", { withTimezone: true }),
  },
  (t) => [uniqueIndex("secret_health_pk").on(t.tenant, t.key)],
);

/** API keys. Only the SHA-256 of a key is stored, never the key. It was
 *  keys.json at the data root, rewritten whole on every create and revoke
 *  and read in full on every authenticated request; now a lookup by the
 *  hash's unique index. `workspaces` null means every workspace; `role`
 *  null is a key from before roles, read as admin. */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    hash: text("hash").notNull(),
    prefix: text("prefix").notNull(),
    label: text("label").notNull(),
    tenant: text("tenant").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now()),
    createdBy: text("created_by"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    scope: jsonb("scope"),
    role: text("role"),
    workspaces: jsonb("workspaces"),
    /** When the key stops working; null never. Chosen at mint (30/90/365
     *  days or never), and shortened to the grace when it is rotated. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** When the key last authenticated, written at most once a minute. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /** Where from, coarsely: an IPv4 /24 or an IPv6 /48, never the address. */
    lastIp: text("last_ip"),
    /** When the owner was told it expires within a week — so they are told once. */
    expiryWarnedAt: timestamp("expiry_warned_at", { withTimezone: true }),
    /** The id of the key that replaced this one when it was rotated; null
     *  until then. Set once: a key already replaced is not rotated again. */
    replacedBy: text("replaced_by"),
  },
  (t) => [uniqueIndex("api_keys_hash_idx").on(t.hash), index("api_keys_tenant_idx").on(t.tenant)],
);

/** An account's wallet settings: saved card's Stripe customer, auto top-up,
 *  warning address, the plan, and the markers that stop a dip being charged
 *  twice. It was billing.json, written by unlocked read-modify-writes from
 *  a dozen places; every write is now one transaction on the locked row.
 *  The Stripe customer is a column of its own, unique, so a webhook finds
 *  its account by index instead of reading every account's file. */
export const wallets = pgTable(
  "wallets",
  {
    tenant: text("tenant").primaryKey(),
    config: jsonb("config").notNull(),
    stripeCustomerId: text("stripe_customer_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now()),
  },
  (t) => [uniqueIndex("wallets_stripe_customer_idx").on(t.stripeCustomerId).where(sql`${t.stripeCustomerId} IS NOT NULL`)],
);

/** A per-account map of named records, one row per record: what an
 *  `<account>/<name>.json` file of `{ key: record }` was, minus the whole-file
 *  rewrite on every change. Records keep their JSON shape; the key is the
 *  map's key. */
const keyedRecords = (name: string) =>
  pgTable(
    name,
    {
      tenant: text("tenant").notNull(),
      key: text("key").notNull(),
      record: jsonb("record").notNull(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now()),
    },
    (t) => [primaryKey({ columns: [t.tenant, t.key] })],
  );

/** Saved OAuth clients, by name. `client_secret` inside the record is
 *  encrypted under the account's key, as it was in oauth-clients.json. */
export const oauthClients = keyedRecords("oauth_clients");
/** One per oauth2 secret, keyed `<workspace|@account>/<NAME>`: which client
 *  connected it, when, and whether its refresh still works. */
export const oauthConnections = keyedRecords("oauth_connections");
/** The install's identity-token signing keys (oidc-issuer.ts), under the
 *  reserved tenant "@install": one row per key, the private key sealed. */
export const oidcKeys = keyedRecords("oidc_keys");
/** Support's read-only views of a customer account, by grant id: who, why,
 *  until when, and when it was ended. The session token names the grant;
 *  the row decides whether it is still live. */
export const supportViews = keyedRecords("support_views");
export type KeyedRecordsTable = ReturnType<typeof keyedRecords>;

/** What the platform remembers about one customer flow, on the customer's
 *  behalf: when its cron last fired (so a restart does not replay it), what
 *  its watched URL last hashed to, when a trigger last started a run (the
 *  throttle's floor), the burst a debounce is holding, and when it was
 *  switched off by disable_after. The flow itself is a file in the
 *  workspace and stays one; this row is the platform's cursor on it. A
 *  `once` flow's key carries its instant: `<flow>@<at>`. */
export const flowState = pgTable(
  "flow_state",
  {
    tenant: text("tenant").notNull(),
    workspace: text("workspace").notNull(),
    flow: text("flow").notNull(),
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    watchCheckedAt: timestamp("watch_checked_at", { withTimezone: true }),
    watchHash: text("watch_hash"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    /** The debounced burst waiting to fire: { firesAt, body, tag, count }.
     *  Here and not in Redis because a burst lost is a customer's event
     *  lost, which is more than Redis is allowed to hold. */
    pending: jsonb("pending"),
    quarantinedAt: timestamp("quarantined_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now()),
  },
  (t) => [primaryKey({ columns: [t.tenant, t.workspace, t.flow] })],
);

/** "Already said this": the watchdog's memory of what it has warned about,
 *  so an alarm fires once per occurrence and not once per tick. `kind` is
 *  budget | sla | provider; `scope` is the workspace, the run id, or '' for
 *  the account; `payload` is whatever that kind keeps. */
export const notices = pgTable(
  "notices",
  {
    tenant: text("tenant").notNull(),
    kind: text("kind").notNull(),
    scope: text("scope").notNull(),
    payload: jsonb("payload").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().default(now()),
  },
  (t) => [primaryKey({ columns: [t.tenant, t.kind, t.scope] })],
);

/** A public link to one file a workspace produced. The token is the whole
 *  credential. Revocation is a column, never a delete, so a revoked token
 *  can never be re-issued to another file by chance. */
export const shares = pgTable(
  "shares",
  {
    token: text("token").primaryKey(),
    tenant: text("tenant").notNull(),
    workspace: text("workspace").notNull(),
    path: text("path").notNull(),
    contentType: text("content_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdBy: text("created_by"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("shares_workspace_idx").on(t.tenant, t.workspace)],
);

/** What the OPERATOR records about an account — plan, suspension,
 *  overdraft, waiver, notes. Not the customer's: it does not travel with an
 *  export and is not theirs to edit. The audit of each change is in
 *  audit_log, as `operator.*`, where it outlives the account. */
export const operatorAccounts = pgTable("operator_accounts", {
  tenant: text("tenant").primaryKey(),
  state: jsonb("state").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now()),
});

/** One nightly backup, as the backup job recorded it once the archive was
 *  verified (foldrun-infra dev/backup.sh). The archive is the whole data
 *  volume plus the database, so `accounts` names every account it holds —
 *  what lets an account's Backups page list the snapshots it is in. */
export const backups = pgTable(
  "backups",
  {
    id: text("id").primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    archive: text("archive").notNull(),
    bytes: bigint("bytes", { mode: "number" }),
    sha256: text("sha256"),
    files: integer("files"),
    runs: integer("runs"),
    /** What the archive holds: "files" (the data volume), "database" (a
     *  pg_dump), "keys" (the install env, sealed). */
    kinds: jsonb("kinds").notNull(),
    accounts: jsonb("accounts").notNull(),
    verified: boolean("verified").notNull().default(false),
    /** Where the off-box copy went ("r2"), or NULL when it stayed on the box. */
    offsite: text("offsite"),
    keepDays: integer("keep_days"),
    /** Sealed with age before it left the box: the archive (data volume and
     *  database dump), its manifest and the env all go to the operator's
     *  public key, so the off-box copy is unreadable without the private key,
     *  which is not on the server. FALSE for archives taken before that. */
    encrypted: boolean("encrypted").notNull().default(false),
    /** Which key it was sealed to: "sha256:" and the first 16 hex of the
     *  SHA-256 of the age recipient (a public key). NULL when not encrypted. */
    recipient: text("recipient"),
  },
  (t) => [index("backups_at_idx").on(t.at)],
);

/** A customer asking the operator to restore platform data (runs, state,
 *  storage, the database) from a backup — the part they cannot restore
 *  themselves. A record of the ask; the restore is an operator's job. */
export const restoreRequests = pgTable(
  "restore_requests",
  {
    id: text("id").primaryKey(),
    tenant: text("tenant").notNull(),
    workspace: text("workspace"),
    /** The point in time asked for, as the customer gave it. */
    target: text("target").notNull(),
    backupId: text("backup_id"),
    what: text("what").notNull(),
    note: text("note"),
    by: text("by").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().default(now()),
    status: text("status").notNull().default("requested"),
    notified: boolean("notified").notNull().default(false),
  },
  (t) => [index("restore_requests_tenant_idx").on(t.tenant, t.at)],
);

export const schemaMigrations = pgTable("schema_migrations", {
  name: text("name").primaryKey(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().default(now()),
});

export type Session = typeof sessions.$inferSelect;
export type AuditRow = typeof auditLog.$inferSelect;
export type LedgerRow = typeof ledger.$inferSelect;
export type ReservationRow = typeof reservations.$inferSelect;
export type QueueRow = typeof queue.$inferSelect;
export type TenantKeyRow = typeof tenantKeys.$inferSelect;
export type UserDbRow = typeof users.$inferSelect;
export type InviteDbRow = typeof invites.$inferSelect;

/** The status page's memory: one row per component per five-minute sample,
 *  written by the scheduler's tick, kept ninety days. The bucket is the
 *  primary key, so a second writer in the same five minutes overwrites
 *  rather than double-counts. */
export const statusSamples = pgTable(
  "status_samples",
  {
    component: text("component").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    status: text("status").notNull(),
    detail: text("detail"),
  },
  (t) => [primaryKey({ columns: [t.component, t.at] }), index("status_samples_at_idx").on(t.at)],
);

/** What the operator tells customers: an incident with its updates, or a
 *  scheduled maintenance window. Updates are an append-only list on the
 *  row — a handful per incident, always read together. */
export const statusIncidents = pgTable(
  "status_incidents",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    impact: text("impact").notNull(),
    status: text("status").notNull(),
    components: jsonb("components").notNull().default(sql`'[]'::jsonb`),
    updates: jsonb("updates").notNull().default(sql`'[]'::jsonb`),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now()),
    createdBy: text("created_by").notNull(),
  },
  (t) => [index("status_incidents_starts_idx").on(t.startsAt.desc())],
);

/** One outbound notify: webhook — a run failed, a gate is waiting — and
 *  every attempt at delivering it. The id is the X-Foldrun-Delivery header,
 *  the same on every attempt and every redelivery, so a receiver dedupes on
 *  it. The body is kept as sent, so a redelivery is the same bytes; the URL
 *  is not — it is read from notify: at each attempt, and a Slack hook URL is
 *  a credential that has no business in a table. `attempt_log` is the list
 *  of attempts (status, duration, the first 500 characters of the answer,
 *  the error), at most a dozen per row. */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    tenant: text("tenant").notNull(),
    workspace: text("workspace").notNull(),
    event: text("event").notNull(),
    /** pending (an attempt is due) | delivered | failed (gave up) | skipped (the endpoint was switched off) */
    status: text("status").notNull(),
    body: text("body").notNull(),
    destination: text("destination"),
    attempts: integer("attempts").notNull().default(0),
    attemptLog: jsonb("attempt_log").notNull().default(sql`'[]'::jsonb`),
    lastStatusCode: integer("last_status_code"),
    lastError: text("last_error"),
    /** When the next attempt is due; while one is in flight, the claim's expiry. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now()),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now()),
  },
  (t) => [
    index("webhook_deliveries_ws_idx").on(t.tenant, t.workspace, t.createdAt.desc()),
    index("webhook_deliveries_due_idx").on(t.nextAttemptAt),
  ],
);

/** The health of one workspace's notify: URL: when its current run of
 *  failures began, and whether it was switched off for lasting too long.
 *  Keyed to a hash of the URL as written, so changing the URL starts it
 *  fresh. */
export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    tenant: text("tenant").notNull(),
    workspace: text("workspace").notNull(),
    urlHash: text("url_hash").notNull(),
    failingSince: timestamp("failing_since", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledReason: text("disabled_reason"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now()),
  },
  (t) => [primaryKey({ columns: [t.tenant, t.workspace] })],
);

/** What mail one address takes. A row is a choice someone made — in
 *  Profile → Notifications or by an unsubscribe link; no row is the
 *  default, which is on. `workspace` is '' for the whole account; a row for
 *  one workspace wins over it. Keyed by address rather than by user, because
 *  a notify: email need not belong to anyone with a login, and the person
 *  behind it is owed an unsubscribe all the same. */
export const emailPreferences = pgTable(
  "email_preferences",
  {
    tenant: text("tenant").notNull(),
    email: text("email").notNull(),
    category: text("category").notNull(),
    workspace: text("workspace").notNull().default(""),
    enabled: boolean("enabled").notNull(),
    /** settings | unsubscribe | api */
    source: text("source").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now()),
  },
  (t) => [primaryKey({ columns: [t.tenant, t.email, t.category, t.workspace] })],
);

/** A super admin's setting for one feature flag. The flags themselves —
 *  name, owner, default, rollout — are code (flags.ts), like the plans;
 *  a row is only a decision that differs from the code. `tenant` is '' for
 *  the install-wide row, which may set `enabled` (on/off for everyone not
 *  overridden) and/or `rollout` (0–100, the percentage of accounts the
 *  flag reaches by a stable hash); an account's row sets `enabled` alone
 *  and wins over both. No row: the registry's answer. Every change is on
 *  audit_log as `operator.flag.*`. */
export const featureFlags = pgTable(
  "feature_flags",
  {
    flag: text("flag").notNull(),
    tenant: text("tenant").notNull().default(""),
    enabled: boolean("enabled"),
    rollout: integer("rollout"),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now()),
  },
  (t) => [primaryKey({ columns: [t.flag, t.tenant] }), index("feature_flags_tenant_idx").on(t.tenant)],
);

/** How an account meets the dated API: requests per day, by the version that
 *  answered them, and — for a route on its way out (web DEPRECATIONS) — by
 *  the route and the credential that called it, so the owner can be told
 *  which key or script to move before the sunset. `route` and `credential`
 *  are '' on the ordinary rows. Counted in memory by each web pod and added
 *  here about once a minute (api-usage.ts). */
export const apiUsage = pgTable(
  "api_usage",
  {
    tenant: text("tenant").notNull(),
    /** UTC day, YYYY-MM-DD. */
    day: text("day").notNull(),
    version: text("version").notNull(),
    route: text("route").notNull().default(""),
    credential: text("credential").notNull().default(""),
    requests: integer("requests").notNull().default(0),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().default(now()),
  },
  (t) => [
    primaryKey({ columns: [t.tenant, t.day, t.version, t.route, t.credential] }),
    index("api_usage_route_day_idx").on(t.route, t.day),
  ],
);

/** Each deprecation warning mailed: one row per account, route and step
 *  (seen, 90d, 30d, 7d), so a step is mailed once however many web pods run
 *  the hourly pass. */
export const apiDeprecationNotices = pgTable(
  "api_deprecation_notices",
  {
    tenant: text("tenant").notNull(),
    route: text("route").notNull(),
    step: text("step").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().default(now()),
  },
  (t) => [primaryKey({ columns: [t.tenant, t.route, t.step] })],
);

/** The dashboard assistant's conversations, one row each, private to the
 *  person (or key) who had them: what they asked, what it answered, and the
 *  files it proposed that were not saved yet. `owner` is `<kind>:<id>` of the
 *  actor. Searched by title and text, listed newest first. */
export const assistantConversations = pgTable(
  "assistant_conversations",
  {
    id: text("id").primaryKey(),
    tenant: text("tenant").notNull(),
    workspace: text("workspace").notNull(),
    owner: text("owner").notNull(),
    title: text("title").notNull(),
    messages: jsonb("messages").notNull(),
    files: jsonb("files").notNull().default(sql`'[]'::jsonb`),
    messageCount: integer("message_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now()),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now()),
  },
  (t) => [index("assistant_conversations_owner_idx").on(t.tenant, t.owner, t.updatedAt.desc())],
);

/** Assistant replies waiting for, or held by, a worker. A row lives only
 *  while the reply is queued or running: the reply's events and its result
 *  are written beside the account's files, and the row goes when it ends.
 *  `heartbeat_at` is how a reply whose worker died is told from a slow one. */
export const assistantJobs = pgTable(
  "assistant_jobs",
  {
    id: text("id").primaryKey(),
    tenant: text("tenant").notNull(),
    workspace: text("workspace").notNull(),
    payload: jsonb("payload").notNull(),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().default(now()),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimedBy: text("claimed_by"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
  },
  (t) => [index("assistant_jobs_pending_idx").on(t.claimedAt, t.enqueuedAt), index("assistant_jobs_tenant_idx").on(t.tenant)],
);
