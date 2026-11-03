// foldrun's models: the platform's own key for each provider — set by an
// operator in the console (op settings.model-key), never in the environment,
// a manifest or a Secret (owner, 3 Nov 2026: "the api keys should be set by
// admin, we can't hard code it").
//
// Sealed at rest: AES-256-GCM under the supply seal key (egress-keys.ts,
// HKDF of the install key), bound to its provider as AAD, so a row copied
// onto another provider does not open. What anyone sees after the write is
// the last four characters (`hint`); the value is never read back to the
// console, the API or a log.
//
// Every pod keeps the rows (sealed) in memory, reloaded every
// SETTINGS_POLL_MS and at once after a write here, because the gateway asks
// synchronously. Only the egress proxy opens one (supplyKey), per call, so a
// key replaced or removed in the console stops being sent within a poll. The
// worker and web ask only whether one is set (supplyKeySet).
//
// Postgres when there is one; otherwise a file under the data root (a laptop
// or a test), sealed the same way.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { dataRoot } from "../../foldrun-core/src/paths.ts";
import { SUPPLY_PROVIDERS, isSupplyProvider, type SupplyProviderName } from "../../foldrun-core/src/model-supply.ts";
import { databaseEnabled, ormRequired, tx, type Db } from "./db.ts";
import { platformModelKeys } from "./schema.ts";
import { SETTINGS_POLL_MS } from "./settings.ts";
import { supplySealKey } from "./egress-keys.ts";

interface Row {
  sealed: string;
  hint: string;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

/** What the console is shown about a provider's key: never the key. */
export interface ModelKeyStatus {
  provider: SupplyProviderName;
  set: boolean;
  /** "…abcd" */
  hint: string | null;
  version: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

const GCM = { authTagLength: 16 } as const;
const aadOf = (provider: string) => Buffer.from(`foldrun model supply key v1\0${provider}`, "utf8");

let snap: Map<SupplyProviderName, Row> | null = null;
let loadsStarted = 0;
let loadApplied = 0;
let poll: NodeJS.Timeout | null = null;
/** Opened values, by provider and sealed text: a poll that brings the same
 *  row back costs no decrypt; a replaced row is a different key. The
 *  provider is in the cache key as it is in the AAD — a row copied onto
 *  another provider must not open from the cache either. */
const opened = new Map<string, string | null>();

const cacheKey = (provider: string, sealed: string) => `${provider}\0${sealed}`;

const file = () => path.join(dataRoot(), ".model-keys.json");

function readFile(): Record<string, Row> {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8")) as Record<string, Row>;
  } catch {
    return {};
  }
}

function writeFile(all: Record<string, Row>): void {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
  fs.renameSync(tmp, file());
}

function seal(provider: SupplyProviderName, value: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", supplySealKey(), iv, GCM);
  c.setAAD(aadOf(provider));
  const enc = Buffer.concat([c.update(value, "utf8"), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64")}`;
}

function open(provider: SupplyProviderName, sealed: string): string | null {
  try {
    if (!sealed.startsWith("v1:")) return null;
    const raw = Buffer.from(sealed.slice(3), "base64");
    if (raw.length < 29) return null;
    const d = crypto.createDecipheriv("aes-256-gcm", supplySealKey(), raw.subarray(0, 12), GCM);
    d.setAAD(aadOf(provider));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

async function readAll(): Promise<Map<SupplyProviderName, Row>> {
  const out = new Map<SupplyProviderName, Row>();
  if (!databaseEnabled()) {
    for (const [p, r] of Object.entries(readFile())) if (isSupplyProvider(p)) out.set(p, r);
    return out;
  }
  for (const r of await ormRequired().select().from(platformModelKeys)) {
    if (!isSupplyProvider(r.provider)) continue;
    out.set(r.provider, { sealed: r.sealed, hint: r.hint, version: r.version, updatedBy: r.updatedBy, updatedAt: r.updatedAt.toISOString() });
  }
  return out;
}

/** Read every key (sealed) into this process; keep the last on failure. A
 *  read that started before one already applied is dropped. */
export async function loadModelKeys(): Promise<void> {
  const gen = ++loadsStarted;
  try {
    const read = await readAll();
    if (gen < loadApplied) return;
    loadApplied = gen;
    snap = read;
    for (const k of [...opened.keys()]) if (![...read].some(([p, r]) => cacheKey(p, r.sealed) === k)) opened.delete(k);
  } catch (err) {
    console.error("[model-keys] could not read the platform's model keys; keeping the last:", err instanceof Error ? err.message : err);
  }
}

export async function startModelKeys(): Promise<void> {
  await loadModelKeys();
  if (poll) return;
  poll = setInterval(() => void loadModelKeys(), SETTINGS_POLL_MS);
  poll.unref?.();
}

function rowOf(provider: SupplyProviderName): Row | undefined {
  // Without a database the file is the store: read it each time (a test or
  // a laptop writes it from another process too).
  if (!databaseEnabled()) return readFile()[provider];
  return snap?.get(provider);
}

/** Whether the platform holds a key for the provider (no decrypt). A row
 *  with no sealed value is a removed key, kept so its version never goes
 *  back (a stale form must not match a key set again later). */
export function supplyKeySet(provider: SupplyProviderName): boolean {
  return !!rowOf(provider)?.sealed;
}

/** The platform's key for a provider, opened — for the egress proxy's fill
 *  alone. Null when none is set, or it will not open (the seal key differs:
 *  refused, never sent as garbage). */
export function supplyKey(provider: SupplyProviderName): string | null {
  const row = rowOf(provider);
  if (!row?.sealed) return null;
  const ck = cacheKey(provider, row.sealed);
  if (opened.has(ck)) return opened.get(ck)!;
  let value: string | null = null;
  try {
    value = open(provider, row.sealed);
  } catch {
    value = null;
  }
  if (value === null) console.error(`[model-keys] the ${provider} key will not open here (another install key, or no supply seal key on this pod)`);
  if (opened.size > 16) opened.clear();
  opened.set(ck, value);
  return value;
}

/** Every provider's status, for the console. */
export function modelKeyStatuses(): ModelKeyStatus[] {
  return (Object.keys(SUPPLY_PROVIDERS) as SupplyProviderName[]).map((provider) => {
    const r = rowOf(provider);
    return {
      provider,
      set: !!r?.sealed,
      hint: r?.sealed ? r.hint : null,
      version: r?.version ?? 0,
      updatedBy: r?.updatedBy ?? null,
      updatedAt: r?.updatedAt ?? null,
    };
  });
}

/** Every provider's status from the store itself, not this pod's last
 *  poll: what the console shows is what was decided. */
export async function readModelKeyStatuses(): Promise<ModelKeyStatus[]> {
  await loadModelKeys();
  return modelKeyStatuses();
}

/** What a provider key must look like before it is sealed: one token, no
 *  spaces or control characters (it goes into one header), a sane length. */
export function modelKeyProblem(value: string): string | null {
  if (value.length < 20) return "too short to be a provider key";
  if (value.length > 512) return "too long to be a provider key";
  if (!/^[\x21-\x7e]+$/.test(value)) return "a provider key is one line of printable characters, no spaces";
  return null;
}

export class ModelKeyConflict extends Error {}

/** What a write did, for its audit line: never the value. */
export interface ModelKeyChange {
  provider: SupplyProviderName;
  removed: boolean;
  hint: string | null;
  version: number;
  previousVersion: number | null;
}

/**
 * Set (value) or remove (null) the platform's key for a provider. `ifVersion`,
 * when given, must be the version read (0: none set), or ModelKeyConflict.
 * `audit` is written in the same transaction as the key (with a database), so
 * a change without its audit line cannot exist. Returns the new status; the
 * value is not in it.
 */
export async function setModelKey(
  provider: string,
  value: string | null,
  by: string,
  ifVersion?: number,
  audit?: (change: ModelKeyChange, t: Db | null) => Promise<void>,
): Promise<ModelKeyStatus> {
  if (!isSupplyProvider(provider)) throw new Error(`provider is one of ${Object.keys(SUPPLY_PROVIDERS).join(", ")}`);
  if (value !== null) {
    const bad = modelKeyProblem(value);
    if (bad) throw new Error(bad);
  }
  const at = new Date();
  const sealed = value === null ? null : seal(provider, value);
  const hint = value === null ? null : `…${value.slice(-4)}`;
  const conflict = () => new ModelKeyConflict(`the ${provider} key was changed since you read it — reload and decide again`);
  if (databaseEnabled()) {
    await tx(async (t) => {
      // One writer per provider at a time; the version is what was read.
      await t.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`model-key:${provider}`}))`);
      const cur = (await t.execute(sql`SELECT version, sealed FROM platform_model_keys WHERE provider = ${provider}`)).rows[0] as { version: number; sealed: string } | undefined;
      const before = cur ? Number(cur.version) : 0;
      if (ifVersion !== undefined && before !== ifVersion) throw conflict();
      // Nothing to remove: no change, no audit line.
      if (sealed === null && !cur?.sealed) return;
      // A removal keeps the row, empty, so the version only goes up.
      const version = before + 1;
      await t.execute(sql`
        INSERT INTO platform_model_keys (provider, sealed, hint, version, updated_by, updated_at)
        VALUES (${provider}, ${sealed ?? ""}, ${hint ?? ""}, ${version}, ${by}, ${at})
        ON CONFLICT (provider) DO UPDATE SET sealed = EXCLUDED.sealed, hint = EXCLUDED.hint,
          version = EXCLUDED.version, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`);
      await audit?.({ provider, removed: sealed === null, hint, version, previousVersion: cur ? before : null }, t);
    });
    await loadModelKeys();
  } else {
    const all = readFile();
    const cur = all[provider];
    const before = cur?.version ?? 0;
    if (ifVersion !== undefined && before !== ifVersion) throw conflict();
    if (sealed === null && !cur?.sealed) return modelKeyStatuses().find((s) => s.provider === provider)!;
    all[provider] = { sealed: sealed ?? "", hint: hint ?? "", version: before + 1, updatedBy: by, updatedAt: at.toISOString() };
    writeFile(all);
    await audit?.({ provider, removed: sealed === null, hint, version: before + 1, previousVersion: cur ? before : null }, null);
  }
  return modelKeyStatuses().find((s) => s.provider === provider)!;
}

/** For tests: forget everything this process holds, and the file. */
export function resetModelKeysForTests(): void {
  snap = null;
  opened.clear();
  try {
    fs.rmSync(file(), { force: true });
  } catch {}
}

