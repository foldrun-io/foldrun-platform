// End customers (FOL-168, 11 Nov 2026): a partner's own users, by the opaque
// id it gives runs and gateway calls (core customer.ts). What the platform
// holds about them, and the checks that make "one bad customer is held
// alone" true:
//
//   · a block list — an account admin's; a blocked customer's runs are
//     refused at start and at every model call of a run already going
//     (egress-proxy.ts), and its gateway calls likewise;
//   · limits per customer, over the defaults below — run starts a minute,
//     gateway calls a minute and at once. Checked BEFORE the shared buckets
//     (the key's, the account's), so a customer refused here never spends
//     the partner's allowance. They apply only when a request names a
//     customer: a request that names none is held to the key's and the
//     account's limits, as it always was.
//
// Postgres holds the block list and the limits (the source of truth); the
// counters are the platform cache's. A block is read from the database with
// a short in-process memory (BLOCK_TTL_MS), so a block reaches runs in
// flight within seconds; a read that fails refuses — an unreadable block
// list never reads as "not blocked".

import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { customerKey, openRunsOfCustomer } from "../../foldrun-core/src/customer.ts";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { databaseEnabled, ormRequired, withNamedLock } from "./db.ts";
import { customerBlocks, customerLimits as customerLimitsTable } from "./schema.ts";
import { rateLimit } from "./cache.ts";

export interface CustomerLimits {
  /** Runs a customer may start in a minute. */
  startsPerMinute: number;
  /** Gateway calls a customer may make in a minute. */
  gatewayRpm: number;
  /** Gateway calls a customer may have open at once. */
  gatewayConcurrency: number;
  /** Runs a customer may have open at once — queued, running or parked at a
   *  gate — across the account. Counted from the run records, under a lock. */
  maxOpenRuns: number;
  /** What a customer's calls on foldrun's models may be CHARGED in a UTC
   *  day, in dollars — held on its own counter with the account's day
   *  (model-usage.ts). Null: no limit of its own. */
  dailyModelUsd: number | null;
}

/** What applies until an admin says otherwise — only to requests that name
 *  a customer. */
export const CUSTOMER_DEFAULTS: CustomerLimits = { startsPerMinute: 30, gatewayRpm: 60, gatewayConcurrency: 4, maxOpenRuns: 10, dailyModelUsd: null };

const LIMIT_MAX = 100_000;
const BLOCK_TTL_MS = 10_000;

/** A refusal the routes answer as it is, with a code a client can act on. */
export class CustomerRefused extends Error {
  readonly status: number;
  readonly code: "customer_blocked" | "customer_rate" | "customer_concurrency" | "customer_open_runs";
  readonly retryAfter?: number;
  constructor(status: number, code: CustomerRefused["code"], message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

// ---------------------------------------------------------------- the file store (no database)

const fileOf = (tenant: string) => path.join(dataRoot(), tenant, ".foldrun", "customers.json");
interface FileState {
  blocks: { customer: string; by: string; reason: string | null; at: string }[];
  limits?: Partial<CustomerLimits>;
}
/** No file is an empty state; a file that cannot be read or parsed throws —
 *  an unreadable block list must never read as "nobody is blocked", and a
 *  write after it must not replace the blocks with nothing (Codex review). */
function readFile(tenant: string): FileState {
  let raw: string;
  try {
    raw = fs.readFileSync(fileOf(tenant), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { blocks: [] };
    throw err;
  }
  const s = JSON.parse(raw) as FileState;
  if (!s || typeof s !== "object" || (s.blocks !== undefined && !Array.isArray(s.blocks))) throw new Error(`${fileOf(tenant)} is not a customers file`);
  return { blocks: s.blocks ?? [], ...(s.limits ? { limits: s.limits } : {}) };
}
function writeFile(tenant: string, state: FileState) {
  const f = fileOf(tenant);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, f);
}

// ---------------------------------------------------------------- limits

/** Why a limits patch is refused, or null. Whole numbers, 1–100,000. */
export function limitsProblem(patch: unknown): string | null {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return "expected { startsPerMinute?, gatewayRpm?, gatewayConcurrency?, maxOpenRuns?, dailyModelUsd? }";
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in CUSTOMER_DEFAULTS)) return `${k} is not a customer limit — they are ${Object.keys(CUSTOMER_DEFAULTS).join(", ")}`;
    if (v === null) continue;
    if (k === "dailyModelUsd") {
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 1_000_000) return "dailyModelUsd is dollars a day, more than 0 and at most 1,000,000 (null: no limit)";
      continue;
    }
    if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > LIMIT_MAX) return `${k} is a whole number from 1 to ${LIMIT_MAX.toLocaleString("en")} (null: the default)`;
  }
  return null;
}

/** The limits in force for this account's customers: its own over the defaults. */
export async function customerLimits(tenant: string): Promise<CustomerLimits> {
  let own: Partial<CustomerLimits> = {};
  if (databaseEnabled()) {
    const [r] = await ormRequired().select({ limits: customerLimitsTable.limits }).from(customerLimitsTable).where(eq(customerLimitsTable.tenant, tenant));
    own = (r?.limits as Partial<CustomerLimits> | undefined) ?? {};
  } else {
    own = readFile(tenant).limits ?? {};
  }
  return { ...CUSTOMER_DEFAULTS, ...Object.fromEntries(Object.entries(own).filter(([k, v]) => (k === "dailyModelUsd" ? typeof v === "number" && v > 0 : Number.isInteger(v)))) };
}

/** Change some of the limits (null puts one back to the default). Answers what is in force. */
export async function setCustomerLimits(tenant: string, patch: Partial<Record<keyof CustomerLimits, number | null>>, by: string): Promise<CustomerLimits> {
  if (typeof patch.dailyModelUsd === "number") patch = { ...patch, dailyModelUsd: Math.round(patch.dailyModelUsd * 100) / 100 };
  const problem = limitsProblem(patch);
  if (problem) throw new Error(problem);
  const merge = (cur: Partial<CustomerLimits>) => {
    const next: Partial<Record<keyof CustomerLimits, number | null>> = { ...cur };
    for (const [k, v] of Object.entries(patch) as [keyof CustomerLimits, number | null][]) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    return next;
  };
  if (databaseEnabled()) {
    const db = ormRequired();
    await db.transaction(async (t) => {
      // The row first, so the lock below always has one to hold: two first
      // patches at once would otherwise both merge against nothing and the
      // second would drop the first (Codex review).
      await t.insert(customerLimitsTable).values({ tenant, limits: {}, updatedBy: by }).onConflictDoNothing();
      const [r] = await t.select({ limits: customerLimitsTable.limits }).from(customerLimitsTable).where(eq(customerLimitsTable.tenant, tenant)).for("update");
      const next = merge((r?.limits as Partial<CustomerLimits> | undefined) ?? {});
      await t
        .insert(customerLimitsTable)
        .values({ tenant, limits: next, updatedBy: by })
        .onConflictDoUpdate({ target: customerLimitsTable.tenant, set: { limits: next, updatedBy: by, updatedAt: new Date() } });
    });
  } else {
    const s = readFile(tenant);
    writeFile(tenant, { ...s, limits: merge(s.limits ?? {}) as Partial<CustomerLimits> });
  }
  return customerLimits(tenant);
}

// ---------------------------------------------------------------- the block list

export interface BlockedCustomer {
  customer: string;
  by: string;
  reason: string | null;
  at: string;
}

const blockMemory = new Map<string, { blocked: boolean; at: number }>();

export async function listBlocked(tenant: string): Promise<BlockedCustomer[]> {
  if (!databaseEnabled()) return readFile(tenant).blocks.sort((a, b) => b.at.localeCompare(a.at));
  const rows = await ormRequired().select().from(customerBlocks).where(eq(customerBlocks.tenant, tenant));
  return rows
    .map((r) => ({ customer: r.customer, by: r.blockedBy, reason: r.reason ?? null, at: r.createdAt.toISOString() }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** Block a customer. Idempotent: a second block keeps the first one's who and when. */
export async function blockCustomer(tenant: string, customer: string, by: string, reason?: string | null): Promise<void> {
  const why = reason?.trim().slice(0, 500) || null;
  if (databaseEnabled()) {
    await ormRequired().insert(customerBlocks).values({ tenant, customer, blockedBy: by, reason: why }).onConflictDoNothing();
  } else {
    const s = readFile(tenant);
    if (!s.blocks.some((b) => b.customer === customer)) writeFile(tenant, { ...s, blocks: [...s.blocks, { customer, by, reason: why, at: new Date().toISOString() }] });
  }
  blockMemory.set(`${tenant}\u0000${customer}`, { blocked: true, at: Date.now() });
}

/** Unblock one; false when it was not blocked. */
export async function unblockCustomer(tenant: string, customer: string): Promise<boolean> {
  let had: boolean;
  if (databaseEnabled()) {
    const gone = await ormRequired().delete(customerBlocks).where(and(eq(customerBlocks.tenant, tenant), eq(customerBlocks.customer, customer))).returning({ c: customerBlocks.customer });
    had = gone.length > 0;
  } else {
    const s = readFile(tenant);
    had = s.blocks.some((b) => b.customer === customer);
    if (had) writeFile(tenant, { ...s, blocks: s.blocks.filter((b) => b.customer !== customer) });
  }
  blockMemory.set(`${tenant}\u0000${customer}`, { blocked: false, at: Date.now() });
  return had;
}

/** Is this customer blocked by the account? Read from the database, kept in
 *  memory for a few seconds; a failed read throws — the caller refuses. */
export async function isBlocked(tenant: string, customer: string): Promise<boolean> {
  const k = `${tenant}\u0000${customer}`;
  const kept = blockMemory.get(k);
  if (kept && Date.now() - kept.at < BLOCK_TTL_MS) return kept.blocked;
  let blocked: boolean;
  if (databaseEnabled()) {
    const [r] = await ormRequired().select({ c: customerBlocks.customer }).from(customerBlocks).where(and(eq(customerBlocks.tenant, tenant), eq(customerBlocks.customer, customer)));
    blocked = Boolean(r);
  } else {
    blocked = readFile(tenant).blocks.some((b) => b.customer === customer);
  }
  if (blockMemory.size > 10_000) blockMemory.clear();
  blockMemory.set(k, { blocked, at: Date.now() });
  return blocked;
}

const blockedRefusal = (customer: string) => new CustomerRefused(403, "customer_blocked", `customer ${customer} is blocked by this account — nothing was started (an admin unblocks it in Settings → API keys → Customers)`);

// ---------------------------------------------------------------- the checks

/** A run start that names a customer: refused when it is blocked or past its
 *  starts a minute. Throws CustomerRefused. */
export async function admitCustomerStart(tenant: string, customer: string): Promise<void> {
  if (await isBlocked(tenant, customer)) throw blockedRefusal(customer);
  const { startsPerMinute } = await customerLimits(tenant);
  const rate = await rateLimit(`cust-start:${customerKey(tenant, customer)}`, startsPerMinute, 60);
  if (!rate.allowed) {
    throw new CustomerRefused(429, "customer_rate", `customer ${customer} has started ${startsPerMinute} runs this minute, its most — try again in ${rate.retryAfter}s`, rate.retryAfter);
  }
}

/** A gateway call that names a customer, before the key's own buckets:
 *  blocked, its calls a minute, its calls at once. Answers the slot to
 *  release when the call ends. Throws CustomerRefused. */
export async function admitCustomerCall(
  tenant: string,
  customer: string,
  takeSlot: (key: string, limit: number) => Promise<{ ok: boolean; release: () => Promise<void> }>,
): Promise<{ release: () => Promise<void> }> {
  if (await isBlocked(tenant, customer)) throw new CustomerRefused(403, "customer_blocked", `customer ${customer} is blocked by this account`);
  const limits = await customerLimits(tenant);
  const k = customerKey(tenant, customer);
  const rate = await rateLimit(`cust-gw:${k}`, limits.gatewayRpm, 60);
  if (!rate.allowed) throw new CustomerRefused(429, "customer_rate", `customer ${customer} has made ${limits.gatewayRpm} calls this minute, its most`, rate.retryAfter);
  const slot = await takeSlot(`cust-${k}`, limits.gatewayConcurrency);
  if (!slot.ok) throw new CustomerRefused(429, "customer_concurrency", `customer ${customer} has ${limits.gatewayConcurrency} calls open at once already`, 2);
  return { release: slot.release };
}

/**
 * Create a run for this customer only while it has room: its open runs are
 * counted from the run records and the run is made under one lock per
 * (account, customer) — across pods with a database — so two starts at once
 * cannot both take the last slot. Throws CustomerRefused (429
 * customer_open_runs) when it is full. Durable: no counter to lose.
 */
export async function withinOpenRuns<T>(tenant: string, customer: string, create: () => Promise<T>): Promise<T> {
  const key = `customer-open:${customerKey(tenant, customer)}`;
  const go = async () => {
    const { maxOpenRuns } = await customerLimits(tenant);
    const open = openRunsOfCustomer(tenant, customer);
    if (open >= maxOpenRuns) {
      throw new CustomerRefused(429, "customer_open_runs", `customer ${customer} has ${open} runs open, its most (${maxOpenRuns}) — one must finish first`);
    }
    return create();
  };
  // This process's queue per key, then the advisory lock across pods.
  const prev = openQueue.get(key) ?? Promise.resolve();
  const turn = prev.catch(() => undefined).then(() => (databaseEnabled() ? withNamedLock(key, go, 15_000) : go()));
  openQueue.set(key, turn);
  try {
    return await turn;
  } finally {
    if (openQueue.get(key) === turn) openQueue.delete(key);
  }
}
const openQueue = new Map<string, Promise<unknown>>();

/** For a test: forget what was kept in memory. */
export function forgetBlocks(): void {
  blockMemory.clear();
}
