// Outbound webhooks that arrive, or say why they did not.
//
// A notify: webhook used to be one POST with a timeout. A receiver that was
// redeploying the minute a run failed never heard about it, and nothing
// anywhere said so — the failure the notification existed to report was
// lost by the notification. Now every send is a DELIVERY:
//
//   · recorded before it is attempted, with an id (X-Foldrun-Delivery) that
//     stays the same across every attempt and redelivery, so a receiver
//     dedupes on it;
//   · attempted at once, then again from the worker's scheduler tick at 1m,
//     5m, 30m, 2h and 6h (core's WEBHOOK_BACKOFF_MS), and given up after the
//     sixth — still in the log, one press from a redelivery;
//   · every attempt written down: the status code, how long it took, the
//     first 500 characters of the answer, the error.
//
// An endpoint that has failed every attempt for FOLDRUN_WEBHOOK_DISABLE_DAYS
// (3) days running is switched off — by the next delivery to give up, never
// by a first attempt or a retry with more to come — and the account's owner
// is emailed once:
// six attempts an event into a URL that has been gone for a week is noise in
// the log and load on somebody else's server. A test or a redelivery that is
// accepted switches it back on; so does changing the URL.
//
//   await deliverWebhook(tenant, ws, { event, body, retry: true });  // core's hook
//   await sweepWebhookDeliveries();                                    // each tick
//   await listDeliveries(tenant, ws, { status, event, limit, offset });
//   await redeliver(tenant, ws, id);
//
// Records, not files: Postgres when the install has one (webhook_deliveries,
// webhook_endpoints); otherwise one JSON file per account under
// <data>/.webhook-deliveries/, written whole through a tmp-then-rename.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, count, desc, eq, inArray, lt, lte, notInArray, sql } from "drizzle-orm";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { attemptWebhook, newDeliveryId, nextAttemptAt, notifyConfig, platformMail, webhookTarget, type WebhookAttempt } from "../../foldrun-core/src/notify.ts";
import type { WebhookDeliveryOutcome } from "../../foldrun-core/src/platform.ts";
import { sendMail } from "../../foldrun-core/src/mail.ts";
import { databaseEnabled, ormRequired } from "./db.ts";
import { webhookDeliveries, webhookEndpoints } from "./schema.ts";

export type DeliveryStatus = "pending" | "delivered" | "failed" | "skipped";

export interface DeliveryRow {
  id: string;
  tenant: string;
  workspace: string;
  event: string;
  status: DeliveryStatus;
  body: string;
  destination: string | null;
  attempts: number;
  attemptLog: WebhookAttempt[];
  lastStatusCode: number | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EndpointRow {
  urlHash: string;
  failingSince: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  disabledAt: string | null;
  disabledReason: string | null;
}

/** How long an attempt may hold a delivery before another tick may take it:
 *  past the attempt's own timeout (core notify.ts, FOLDRUN_WEBHOOK_TIMEOUT_MS,
 *  8s by default), so a slow receiver is not hit twice. */
const claimMs = () => Math.max(2 * 60_000, 2 * (Number(process.env.FOLDRUN_WEBHOOK_TIMEOUT_MS) || 8000));
/** Attempts kept on a row: the six of the schedule and a few redeliveries. */
const LOG_CAP = 12;
export const disableAfterDays = () => {
  const n = Number(process.env.FOLDRUN_WEBHOOK_DISABLE_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 3;
};
const keepDays = () => Number(process.env.FOLDRUN_WEBHOOK_LOG_DAYS) || 30;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const urlHash = (raw: string) => crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);

// ------------------------------------------------------------------ files

interface TenantFile {
  deliveries: Record<string, DeliveryRow>;
  endpoints: Record<string, EndpointRow>;
}

const dir = () => path.join(dataRoot(), ".webhook-deliveries");
const fileOf = (tenant: string) => path.join(dir(), `${tenant.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`);

function readFile(tenant: string): TenantFile {
  try {
    const f = JSON.parse(fs.readFileSync(fileOf(tenant), "utf8")) as Partial<TenantFile>;
    return { deliveries: f.deliveries ?? {}, endpoints: f.endpoints ?? {} };
  } catch {
    return { deliveries: {}, endpoints: {} };
  }
}

function writeFile(tenant: string, f: TenantFile): void {
  fs.mkdirSync(dir(), { recursive: true });
  const tmp = `${fileOf(tenant)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(f), { mode: 0o600 });
  fs.renameSync(tmp, fileOf(tenant));
}

const locks = new Map<string, Promise<unknown>>();
function locked<T>(tenant: string, fn: (f: TenantFile) => T): Promise<T> {
  const run = (locks.get(tenant) ?? Promise.resolve()).then(() => {
    const f = readFile(tenant);
    const out = fn(f);
    writeFile(tenant, f);
    return out;
  });
  locks.set(tenant, run.catch(() => undefined));
  return run;
}

function fileTenants(): string[] {
  try {
    return fs.readdirSync(dir()).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- the rows

type DbRow = typeof webhookDeliveries.$inferSelect;
const fromDb = (r: DbRow): DeliveryRow => ({
  id: r.id,
  tenant: r.tenant,
  workspace: r.workspace,
  event: r.event,
  status: r.status as DeliveryStatus,
  body: r.body,
  destination: r.destination,
  attempts: r.attempts,
  attemptLog: ((r.attemptLog as WebhookAttempt[]) ?? []).slice(-LOG_CAP),
  lastStatusCode: r.lastStatusCode,
  lastError: r.lastError,
  nextAttemptAt: iso(r.nextAttemptAt),
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

async function insertDelivery(row: DeliveryRow): Promise<void> {
  if (!databaseEnabled()) {
    await locked(row.tenant, (f) => {
      f.deliveries[row.id] = row;
    });
    return;
  }
  await ormRequired().insert(webhookDeliveries).values({
    id: row.id,
    tenant: row.tenant,
    workspace: row.workspace,
    event: row.event,
    status: row.status,
    body: row.body,
    destination: row.destination,
    attempts: row.attempts,
    attemptLog: row.attemptLog,
    lastStatusCode: row.lastStatusCode,
    lastError: row.lastError,
    nextAttemptAt: row.nextAttemptAt ? new Date(row.nextAttemptAt) : null,
  });
}

/** One attempt's outcome onto its row. */
async function recordAttempt(
  tenant: string,
  id: string,
  a: WebhookAttempt,
  next: { status: DeliveryStatus; nextAttemptAt: number | null },
): Promise<void> {
  const at = new Date();
  if (!databaseEnabled()) {
    await locked(tenant, (f) => {
      const r = f.deliveries[id];
      if (!r) return;
      r.attempts = Math.max(r.attempts, a.n);
      r.attemptLog = [...r.attemptLog, a].slice(-LOG_CAP);
      r.status = next.status;
      r.nextAttemptAt = next.nextAttemptAt ? new Date(next.nextAttemptAt).toISOString() : null;
      r.lastStatusCode = a.statusCode;
      r.lastError = a.error;
      r.updatedAt = at.toISOString();
    });
    return;
  }
  await ormRequired()
    .update(webhookDeliveries)
    .set({
      attempts: sql`greatest(${webhookDeliveries.attempts}, ${a.n})`,
      // Appended in SQL and capped there too: the last LOG_CAP kept, as the
      // file store keeps them.
      attemptLog: sql`(
        select coalesce(jsonb_agg(t.e order by t.i), '[]'::jsonb)
        from jsonb_array_elements(coalesce(${webhookDeliveries.attemptLog}, '[]'::jsonb) || ${JSON.stringify([a])}::jsonb) with ordinality as t(e, i)
        where t.i > jsonb_array_length(coalesce(${webhookDeliveries.attemptLog}, '[]'::jsonb)) + 1 - ${LOG_CAP}
      )`,
      status: next.status,
      nextAttemptAt: next.nextAttemptAt ? new Date(next.nextAttemptAt) : null,
      lastStatusCode: a.statusCode,
      lastError: a.error,
      updatedAt: at,
    })
    .where(eq(webhookDeliveries.id, id));
}

export async function getDelivery(tenant: string, workspace: string, id: string): Promise<DeliveryRow | null> {
  if (!databaseEnabled()) {
    const r = readFile(tenant).deliveries[id];
    return r && r.workspace === workspace ? r : null;
  }
  const [r] = await ormRequired()
    .select()
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.id, id), eq(webhookDeliveries.tenant, tenant), eq(webhookDeliveries.workspace, workspace)))
    .limit(1);
  return r ? fromDb(r) : null;
}

/**
 * A row as a reader sees it: the body with every approve/reject link
 * replaced. A gate's webhook carries links that decide without a login
 * (core's approvalLinks — the receiver is the reader, like a mail's); the
 * log is readable by every role, viewers and read-only keys included, and
 * handing them those links handed them the gate. The receiver still gets
 * the links, on the first send and on a redelivery; only the log is blank.
 */
export function redactDelivery(r: DeliveryRow): DeliveryRow {
  let body: unknown;
  try {
    body = JSON.parse(r.body);
  } catch {
    return { ...r, body: r.body.replace(/(\/api\/approve\/[^\s"']*?[?&]token=)[^\s"'&]+/g, "$1[redacted]") };
  }
  const scrub = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(scrub);
    if (!v || typeof v !== "object") return v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /^(approve|reject)Url$/.test(k) && typeof x === "string" ? "[redacted]" : scrub(x)]));
  };
  return { ...r, body: JSON.stringify(scrub(body)) };
}

/** Newest first, narrowed by status and event; `total` is the count the
 *  filter matches, for paging. */
export async function listDeliveries(
  tenant: string,
  workspace: string,
  opts: { status?: string; event?: string; limit?: number; offset?: number } = {},
): Promise<{ deliveries: DeliveryRow[]; total: number }> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);
  if (!databaseEnabled()) {
    const all = Object.values(readFile(tenant).deliveries)
      .filter((r) => r.workspace === workspace && (!opts.status || r.status === opts.status) && (!opts.event || r.event === opts.event))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return { deliveries: all.slice(offset, offset + limit).map(redactDelivery), total: all.length };
  }
  const where = and(
    eq(webhookDeliveries.tenant, tenant),
    eq(webhookDeliveries.workspace, workspace),
    opts.status ? eq(webhookDeliveries.status, opts.status) : undefined,
    opts.event ? eq(webhookDeliveries.event, opts.event) : undefined,
  );
  const q = ormRequired();
  const [rows, [{ n }]] = await Promise.all([
    q.select().from(webhookDeliveries).where(where).orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id)).limit(limit).offset(offset),
    q.select({ n: count() }).from(webhookDeliveries).where(where),
  ]);
  return { deliveries: rows.map((r) => redactDelivery(fromDb(r))), total: Number(n) };
}

// --------------------------------------------------------------- endpoints

export async function endpointState(tenant: string, workspace: string): Promise<EndpointRow | null> {
  if (!databaseEnabled()) return readFile(tenant).endpoints[workspace] ?? null;
  const [r] = await ormRequired()
    .select()
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.tenant, tenant), eq(webhookEndpoints.workspace, workspace)))
    .limit(1);
  return r
    ? {
        urlHash: r.urlHash,
        failingSince: iso(r.failingSince),
        lastSuccessAt: iso(r.lastSuccessAt),
        lastFailureAt: iso(r.lastFailureAt),
        disabledAt: iso(r.disabledAt),
        disabledReason: r.disabledReason,
      }
    : null;
}

async function saveEndpoint(tenant: string, workspace: string, e: EndpointRow): Promise<void> {
  if (!databaseEnabled()) {
    await locked(tenant, (f) => {
      f.endpoints[workspace] = e;
    });
    return;
  }
  const values = {
    urlHash: e.urlHash,
    failingSince: e.failingSince ? new Date(e.failingSince) : null,
    lastSuccessAt: e.lastSuccessAt ? new Date(e.lastSuccessAt) : null,
    lastFailureAt: e.lastFailureAt ? new Date(e.lastFailureAt) : null,
    disabledAt: e.disabledAt ? new Date(e.disabledAt) : null,
    disabledReason: e.disabledReason,
    updatedAt: new Date(),
  };
  await ormRequired()
    .insert(webhookEndpoints)
    .values({ tenant, workspace, ...values })
    .onConflictDoUpdate({ target: [webhookEndpoints.tenant, webhookEndpoints.workspace], set: values });
}

/** The endpoint as it stands for the URL notify: names now — a state kept
 *  for a different URL is a fresh start. */
async function currentEndpoint(tenant: string, workspace: string): Promise<EndpointRow> {
  const hash = urlHash(notifyConfig(tenant, workspace)?.url ?? "");
  const e = await endpointState(tenant, workspace);
  if (e && e.urlHash === hash) return e;
  return { urlHash: hash, failingSince: null, lastSuccessAt: null, lastFailureAt: null, disabledAt: null, disabledReason: null };
}

/** Is this workspace's webhook switched off? The reason when it is. */
export async function endpointDisabled(tenant: string, workspace: string): Promise<string | null> {
  const e = await currentEndpoint(tenant, workspace);
  return e.disabledAt ? e.disabledReason ?? `switched off ${e.disabledAt}` : null;
}

/**
 * An attempt's verdict onto the endpoint. A success ends the failing run
 * and switches a disabled endpoint back on (only a manual attempt reaches
 * a disabled one). A scheduled failure starts or extends the run; past the
 * limit, the failure of a delivery that has GIVEN UP (`gaveUp`: its last
 * scheduled attempt) switches the endpoint off and mails the owner. A first
 * attempt or a retry with more to come does not: on a quiet workspace the
 * last failure may be days old, and one blip on the next event switched
 * the endpoint off before its own retry a minute later could land. A
 * manual failure is not counted — a person pressing redeliver on a dead
 * URL is not evidence it has been dead longer.
 */
export async function noteEndpointResult(
  tenant: string,
  workspace: string,
  ok: boolean,
  at: number,
  manual = false,
  gaveUp = true,
): Promise<"disabled" | "enabled" | null> {
  const e = await currentEndpoint(tenant, workspace);
  const when = new Date(at).toISOString();
  let change: "disabled" | "enabled" | null = null;
  if (ok) {
    if (e.disabledAt) change = "enabled";
    Object.assign(e, { failingSince: null, lastSuccessAt: when, disabledAt: null, disabledReason: null });
  } else {
    e.lastFailureAt = when;
    if (!manual) {
      e.failingSince ??= when;
      const days = disableAfterDays();
      if (!e.disabledAt && gaveUp && at - Date.parse(e.failingSince) >= days * 86400_000) {
        e.disabledAt = when;
        e.disabledReason = `every delivery failed for ${days} day${days === 1 ? "" : "s"} running (since ${e.failingSince.slice(0, 16).replace("T", " ")} UTC)`;
        change = "disabled";
      }
    }
  }
  await saveEndpoint(tenant, workspace, e);
  if (change === "disabled") {
    await mailDisabled(tenant, workspace, e).catch((err) =>
      console.error(`[webhooks] ${tenant}/${workspace}: the switched-off mail failed:`, err instanceof Error ? err.message : err),
    );
  }
  return change;
}

/** The owner's address: the account's owner by login, else its billing
 *  address. Read from wherever people are kept on this install. */
export async function ownerEmail(tenant: string): Promise<string | null> {
  try {
    const { ownerOf } = await import("./ownership.ts");
    let people: { id: string; email: string; tenant: string; createdAt: string; owner?: boolean }[];
    if (databaseEnabled()) {
      const { allUsersDb } = await import("./users-db.ts");
      people = await allUsersDb();
    } else {
      people = JSON.parse(fs.readFileSync(path.join(dataRoot(), "users.json"), "utf8"));
    }
    const owner = ownerOf(people, tenant);
    if (owner?.email) return owner.email;
  } catch {
    // no people file on this install
  }
  const { billing } = await import("./billing.ts");
  return billing().contactEmail(tenant);
}

async function mailDisabled(tenant: string, workspace: string, e: EndpointRow): Promise<void> {
  const to = await ownerEmail(tenant);
  const mail = platformMail(tenant);
  if (!to || !mail) {
    console.error(`[webhooks] ${tenant}/${workspace}: notify webhook switched off — no ${to ? "mail credential" : "owner address"} to tell`);
    return;
  }
  const base = (process.env.FOLDRUN_PUBLIC_URL ?? "").replace(/\/+$/, "");
  const shown = webhookTarget(tenant, workspace).shown;
  await sendMail({
    tenant,
    mail,
    to,
    category: "account",
    workspace,
    subject: `foldrun switched off ${workspace}'s notification webhook`,
    text:
      `The notify: webhook for the workspace "${workspace}" (${shown}) has been switched off: ${e.disabledReason}.\n\n` +
      `Until it is back on, run failures and approval requests from ${workspace} are recorded but not sent there.\n\n` +
      `To turn it back on, fix the receiver and then either press Redeliver on any delivery, or send a test notification ` +
      `(Workspace settings → Notifications, or \`foldrun notify test --to ${workspace}\`). An accepted delivery switches it on again. ` +
      `Changing the URL in notify: starts it fresh.\n` +
      (base ? `\nThe deliveries: ${base}/dashboard/${workspace}/triggers#deliveries\n` : ""),
  });
}

// ---------------------------------------------------------------- delivery

/** The hook core calls: record it, try it now, line up the rest. */
export async function deliverWebhook(
  tenant: string,
  workspace: string,
  d: { event: string; body: string; retry: boolean },
  now = Date.now(),
): Promise<WebhookDeliveryOutcome> {
  const id = newDeliveryId();
  const manual = !d.retry;
  const destination = webhookTarget(tenant, workspace).shown;
  const disabled = manual ? null : await endpointDisabled(tenant, workspace);
  const row: DeliveryRow = {
    id,
    tenant,
    workspace,
    event: d.event,
    status: disabled ? "skipped" : "pending",
    body: d.body,
    destination,
    attempts: 0,
    attemptLog: [],
    lastStatusCode: null,
    lastError: disabled ? `not attempted: the endpoint is switched off — ${disabled}` : null,
    // Claimed by this attempt: if the process dies inside it, a tick takes
    // it over when the claim runs out.
    nextAttemptAt: disabled ? null : new Date(now + claimMs()).toISOString(),
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
  await insertDelivery(row);
  if (disabled) return { ok: false, deliveryId: id, statusCode: null, detail: row.lastError! };
  const a = await attemptWebhook(tenant, workspace, { id, event: d.event, body: d.body, attempt: 1, manual });
  const next = a.ok || !d.retry ? null : nextAttemptAt(1, Date.now());
  await recordAttempt(tenant, id, a, { status: a.ok ? "delivered" : next ? "pending" : "failed", nextAttemptAt: next });
  await noteEndpointResult(tenant, workspace, a.ok, Date.now(), manual, next === null);
  return { ok: a.ok, deliveryId: id, statusCode: a.statusCode, detail: a.error ?? a.response ?? "", retrying: next !== null };
}

/** Deliveries whose next attempt is due, claimed for this caller: no other
 *  tick will take them until the claim runs out. */
async function claimDue(now: number, limit: number, exclude: ReadonlySet<string> = new Set()): Promise<DeliveryRow[]> {
  if (!databaseEnabled()) {
    const out: DeliveryRow[] = [];
    for (const tenant of fileTenants()) {
      if (out.length >= limit) break;
      const claimed = await locked(tenant, (f) => {
        const due = Object.values(f.deliveries)
          .filter((r) => r.status === "pending" && r.nextAttemptAt && Date.parse(r.nextAttemptAt) <= now && !exclude.has(r.id))
          .slice(0, limit - out.length);
        for (const r of due) r.nextAttemptAt = new Date(now + claimMs()).toISOString();
        return due.map((r) => ({ ...r }));
      });
      out.push(...claimed);
    }
    return out;
  }
  const q = ormRequired();
  const due = q
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.status, "pending"),
        lte(webhookDeliveries.nextAttemptAt, new Date(now)),
        exclude.size ? notInArray(webhookDeliveries.id, [...exclude]) : undefined,
      ),
    )
    .orderBy(webhookDeliveries.nextAttemptAt)
    .limit(limit)
    .for("update", { skipLocked: true });
  const rows = await q
    .update(webhookDeliveries)
    .set({ nextAttemptAt: new Date(now + claimMs()) })
    .where(inArray(webhookDeliveries.id, due))
    .returning();
  return rows.map(fromDb);
}

let lastPrune = 0;

/**
 * One pass: every delivery whose next attempt is due, attempted. From the
 * scheduler's tick, on the pod holding the scheduler lease; the claim makes
 * a second pod (a handover) harmless. Returns how many were attempted.
 */
export async function sweepWebhookDeliveries(now = Date.now(), limit = 50): Promise<number> {
  // One claim per attempt, taken just before it: a claim of the whole
  // batch at the start ran out two minutes in, while fifty attempts of up
  // to eight seconds each were still going, and a pod taking over the
  // scheduler sent the rest a second time.
  // Each delivery at most once a sweep, however far ahead `now` is.
  const started = Date.now();
  const done = new Set<string>();
  for (; done.size < limit; ) {
    const [r] = await claimDue(now + (Date.now() - started), 1, done);
    if (!r) break;
    done.add(r.id);
    try {
      const disabled = await endpointDisabled(r.tenant, r.workspace);
      if (disabled) {
        await recordAttempt(
          r.tenant,
          r.id,
          { n: r.attempts, at: new Date().toISOString(), statusCode: null, durationMs: 0, response: null, error: `not attempted: the endpoint is switched off — ${disabled}` },
          { status: "skipped", nextAttemptAt: null },
        );
        continue;
      }
      const n = r.attempts + 1;
      const a = await attemptWebhook(r.tenant, r.workspace, { id: r.id, event: r.event, body: r.body, attempt: n });
      // The schedule counts scheduled attempts only: a redelivery is
      // `manual`, not part of the backoff, and counting it skipped a retry.
      const scheduled = n - r.attemptLog.filter((x) => x.manual).length;
      const next = a.ok ? null : nextAttemptAt(scheduled, Date.now());
      await recordAttempt(r.tenant, r.id, a, { status: a.ok ? "delivered" : next ? "pending" : "failed", nextAttemptAt: next });
      await noteEndpointResult(r.tenant, r.workspace, a.ok, Date.now(), false, next === null);
    } catch (err) {
      console.error(`[webhooks] ${r.tenant}/${r.workspace} ${r.id}:`, err instanceof Error ? err.message : err);
    }
  }
  if (now - lastPrune > 3600_000) {
    lastPrune = now;
    await pruneDeliveries(now).catch((err) => console.error("[webhooks] prune failed:", err));
  }
  return done.size;
}

/** Finished deliveries older than the keep window (30 days) go. */
export async function pruneDeliveries(now = Date.now()): Promise<number> {
  const cutoff = now - keepDays() * 86400_000;
  if (!databaseEnabled()) {
    let gone = 0;
    for (const tenant of fileTenants()) {
      gone += await locked(tenant, (f) => {
        let n = 0;
        for (const [id, r] of Object.entries(f.deliveries)) {
          if (r.status !== "pending" && Date.parse(r.createdAt) < cutoff) {
            delete f.deliveries[id];
            n++;
          }
        }
        return n;
      });
    }
    return gone;
  }
  const rows = await ormRequired()
    .delete(webhookDeliveries)
    .where(and(lt(webhookDeliveries.createdAt, new Date(cutoff)), inArray(webhookDeliveries.status, ["delivered", "failed", "skipped"])))
    .returning({ id: webhookDeliveries.id });
  return rows.length;
}

/**
 * Send one delivery again, now, by a person: the same id and the same body,
 * signed afresh. It does not rejoin the backoff — a pending delivery keeps
 * its schedule unless this attempt lands. An accepted redelivery switches a
 * disabled endpoint back on.
 */
export async function redeliver(tenant: string, workspace: string, id: string): Promise<DeliveryRow | null> {
  const r = await getDelivery(tenant, workspace, id);
  if (!r) return null;
  const n = r.attempts + 1;
  const a = await attemptWebhook(tenant, workspace, { id: r.id, event: r.event, body: r.body, attempt: n, manual: true });
  const status: DeliveryStatus = a.ok ? "delivered" : r.status === "pending" ? "pending" : "failed";
  await recordAttempt(tenant, id, a, { status, nextAttemptAt: a.ok ? null : r.status === "pending" && r.nextAttemptAt ? Date.parse(r.nextAttemptAt) : null });
  await noteEndpointResult(tenant, workspace, a.ok, Date.now(), true);
  const after = await getDelivery(tenant, workspace, id);
  return after ? redactDelivery(after) : null;
}

/** An account's rows, for tenant-delete. */
export async function deleteTenantDeliveries(tenant: string): Promise<void> {
  if (!databaseEnabled()) {
    fs.rmSync(fileOf(tenant), { force: true });
    return;
  }
  await ormRequired().delete(webhookDeliveries).where(eq(webhookDeliveries.tenant, tenant));
  await ormRequired().delete(webhookEndpoints).where(eq(webhookEndpoints.tenant, tenant));
}
