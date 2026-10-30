// OAuth connections — which saved client each oauth2 secret came from, and
// whether it still works. The point is the reconnect: a grant LinkedIn has
// revoked used to mean finding the app's client id and secret again, in a
// console nobody had open, to type into a prompt. The client was already in
// the vault inside the secret; this file remembers it as a reusable client
// the moment a secret is connected, so reconnecting is one click (dashboard)
// or no prompts (`foldrun connect NAME`).
//
//   data/<tenant>/oauth-connections.json   keyed "<workspace|@account>/<NAME>"
//
// Health is written by the refresh itself (core's materializeSecrets calls
// platform.noteOAuthRefresh): the last failure, when it was emailed, and when
// the refresh token runs out if the provider said (LinkedIn does, ~365 days).

import path from "node:path";
import { accountDir, listWorkspaces } from "../../foldrun-core/src/store.ts";
import { listSecrets, getSecret, isOAuth2Value, type OAuth2Config } from "../../foldrun-core/src/secrets.ts";
import { keyedStore } from "./keyed-store.ts";
import { oauthConnections } from "./schema.ts";
import { OAUTH_PRESETS } from "../../foldrun-core/src/oauth-presets.ts";
import { sendPlainNotification } from "../../foldrun-core/src/notify.ts";
import { saveOAuthClient, listOAuthClients, getOAuthClient } from "./oauth-clients.ts";

export interface ConnectionRecord {
  name: string;
  workspace?: string;
  /** The saved OAuth client a reconnect runs; null when none could be made
   *  (a custom provider whose authorize URL was never given). */
  client: string | null;
  /** The scopes this connection was granted with. One saved client serves
   *  many connections at different scopes; a reconnect asks for these, not
   *  the client's default. Absent on records from before 22 Oct 2026. */
  scopes?: string;
  connectedAt?: string;
  refreshExpiresAt?: string;
  lastError?: string;
  lastErrorAt?: string;
  notifiedAt?: string;
  lastOkAt?: string;
  /** Connected by a caller who may not change the account's saved clients
   *  (rememberConnection's keepSavedClients): a later migration links it to
   *  a matching saved client and never lifts its own config into one. */
  linkOnly?: true;
}

export type ConnectionState = "ok" | "expiring" | "expired" | "failed" | "no-client";

export interface ConnectionStatus extends ConnectionRecord {
  status: ConnectionState;
  daysLeft: number | null;
  reconnectUrl: string;
}

const DAY = 86_400_000;
/** "expires in N days" turns amber, and is emailed, inside this window. */
export const EXPIRY_WARN_DAYS = 14;

// A row per connection in `oauth_connections` with a database; the
// account's oauth-connections.json (0600) without one.
export const oauthConnectionFile = (tenant: string) => path.join(accountDir(tenant), "oauth-connections.json");
const keyOf = (name: string, workspace?: string) => `${workspace ?? "@account"}/${name}`;
const store = keyedStore<ConnectionRecord>(oauthConnections, oauthConnectionFile);

/** Which preset a token URL belongs to — how an old secret finds its authorize URL. */
export function providerOf(tokenUrl: string): string | null {
  for (const [name, p] of Object.entries(OAUTH_PRESETS)) if (p.token_url === tokenUrl) return name;
  return null;
}

/** Where the one click lands: the settings page, opened on this secret. */
export function reconnectUrl(name: string, workspace?: string): string {
  const base = (process.env.FOLDRUN_PUBLIC_URL ?? "").replace(/\/+$/, "");
  const q = new URLSearchParams({ reconnect: name, ...(workspace ? { workspace } : {}) });
  return `${base}${workspace ? `/dashboard/${workspace}/settings` : "/dashboard/settings"}?${q}`;
}

export interface ConnectInput {
  token_url: string;
  client_id: string;
  /** Empty or absent for a public (PKCE) app. */
  client_secret?: string;
  scopes?: string;
  authorize_url?: string;
  authorize_extra?: Record<string, string>;
  /** PKCE off (an app that refuses it) and the pinned issuer travel with the
   *  app; a saved app shared by others keeps its own. */
  pkce?: boolean;
  issuer?: string;
}

/**
 * A secret was just connected (consent callback, CLI, or a PUT with an oauth2
 * recipe): keep its client as a saved one — reusing an identical saved client
 * rather than duplicating it — and start the connection's record afresh.
 * Returns the client name, or null when no authorize URL is known.
 */
export async function rememberConnection(
  tenant: string,
  name: string,
  workspace: string | undefined,
  input: ConnectInput,
  opts: {
    refreshExpiresIn?: number;
    connectedAt?: string;
    /** The caller may not change the account's saved clients (one scoped to
     *  some workspaces: saved clients are every workspace's). The connection
     *  links to a saved client with the same token URL and client id when
     *  there is one, and saves or rewrites none — else a scoped admin could
     *  point the account's Google app at its own consent page (30 Oct 2026). */
    keepSavedClients?: boolean;
  } = {},
): Promise<string | null> {
  const provider = providerOf(input.token_url);
  const preset = provider ? OAUTH_PRESETS[provider] : undefined;
  const authorize = input.authorize_url ?? preset?.authorize_url;

  let client: string | null = null;
  if (authorize && opts.keepSavedClients) {
    const saved = await listOAuthClients(tenant);
    client = saved.find((c) => c.token_url === input.token_url && c.client_id === input.client_id)?.name ?? null;
  } else if (authorize) {
    const saved = await listOAuthClients(tenant);
    const same = saved.find((c) => c.token_url === input.token_url && c.client_id === input.client_id);
    const base = provider ?? (new URL(input.token_url).hostname.split(".").slice(-2, -1)[0] ?? "oauth").toLowerCase().replace(/[^a-z0-9]+/g, "-");
    client = same?.name
      ?? (saved.some((c) => c.name === base) ? `${base}-${input.client_id.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "app"}` : base);
    await saveOAuthClient(tenant, client, {
      authorize_url: authorize,
      token_url: input.token_url,
      client_id: input.client_id,
      client_secret: input.client_secret ?? "",
      // A saved client shared by other connections keeps its own default
      // scopes: this connection's scopes go on its record below. Overwriting
      // them made every other connection's reconnect ask for these.
      scopes: same ? same.scopes : input.scopes ?? preset?.scopes_example ?? "",
      ...(input.authorize_extra ?? preset?.authorize_extra ? { authorize_extra: input.authorize_extra ?? preset?.authorize_extra } : {}),
      ...((same ? same.pkce : input.pkce) === false ? { pkce: false } : {}),
      ...((same ? same.issuer : input.issuer) ? { issuer: same ? same.issuer : input.issuer } : {}),
    });
  }

  const now = opts.connectedAt ?? new Date().toISOString();
  await store.put(tenant, keyOf(name, workspace), {
    name,
    ...(workspace ? { workspace } : {}),
    client,
    // Kept even when empty: a connection made with no scopes reconnects with
    // none, not with the app's default (Codex review).
    ...(typeof input.scopes === "string" ? { scopes: input.scopes.trim() } : {}),
    // Kept on the record: migration reads the secret back and would
    // otherwise save the scoped caller's app and consent page for the
    // whole account the next time anything lists connections (Codex, 30 Oct 2026).
    ...(opts.keepSavedClients ? { linkOnly: true as const } : {}),
    connectedAt: now,
    ...(opts.refreshExpiresIn ? { refreshExpiresAt: new Date(Date.parse(now) + opts.refreshExpiresIn * 1000).toISOString() } : {}),
  });
  return client;
}

/** Every oauth2 secret, each at the scope it is actually stored at. */
function oauth2Secrets(tenant: string): { name: string; workspace?: string; updatedAt: string }[] {
  const out: { name: string; workspace?: string; updatedAt: string }[] = [];
  for (const s of listSecrets(tenant)) if (s.kind === "oauth2") out.push({ name: s.name, updatedAt: s.updatedAt });
  for (const w of listWorkspaces(tenant)) {
    for (const s of listSecrets(tenant, w.name)) {
      if (s.kind === "oauth2" && s.scope === "workspace") out.push({ name: s.name, workspace: w.name, updatedAt: s.updatedAt });
    }
  }
  return out;
}

/**
 * Secrets connected before connections were kept carry their client inside
 * the recipe. Lift it out once, so they get a Reconnect button too.
 * Idempotent: a secret with a record and a client is left alone.
 */
export async function migrateConnections(tenant: string): Promise<number> {
  const all = await store.all(tenant);
  let moved = 0;
  for (const s of oauth2Secrets(tenant)) {
    const existing = all[keyOf(s.name, s.workspace)];
    if (existing?.client && (await getOAuthClient(tenant, existing.client))) continue;
    const hit = getSecret(tenant, s.name, s.workspace);
    if (!hit || !isOAuth2Value(hit.value)) continue;
    let cfg: OAuth2Config;
    try {
      cfg = JSON.parse(hit.value.slice("@oauth2 ".length));
    } catch {
      continue;
    }
    if (cfg.grant_type === "client_credentials") continue; // no consent to redo
    // A connection a scoped caller made links to a matching saved client or
    // stays unlinked: its secret's config (its own app, its own consent
    // page) is not the account's to save (Codex, 30 Oct 2026).
    if (existing?.linkOnly) {
      const linked = (await listOAuthClients(tenant)).find((c) => c.token_url === cfg.token_url && c.client_id === cfg.client_id)?.name ?? null;
      if (linked !== existing.client) {
        await store.put(tenant, keyOf(s.name, s.workspace), { ...existing, client: linked });
        moved++;
      }
      continue;
    }
    // Nothing to lift: an unknown provider with no authorize URL stays as it is.
    if (existing && !existing.client && !providerOf(cfg.token_url)) continue;
    const client = await rememberConnection(tenant, s.name, s.workspace, cfg, { connectedAt: s.updatedAt });
    if (existing) {
      // Keep what the old record knew about health; only the client is new.
      await store.put(tenant, keyOf(s.name, s.workspace), { ...existing, client });
    }
    moved++;
  }
  return moved;
}

/** Days until the refresh token runs out, rounded up; null when unknown. */
export function daysLeft(rec: ConnectionRecord, now = Date.now()): number | null {
  if (!rec.refreshExpiresAt) return null;
  return Math.ceil((Date.parse(rec.refreshExpiresAt) - now) / DAY);
}

export function stateOf(rec: ConnectionRecord, now = Date.now()): ConnectionState {
  const failedSinceConnect =
    rec.lastError && (!rec.connectedAt || Date.parse(rec.lastErrorAt ?? "") >= Date.parse(rec.connectedAt));
  if (failedSinceConnect) return "failed";
  const d = daysLeft(rec, now);
  if (d !== null && d <= 0) return "expired";
  if (d !== null && d <= EXPIRY_WARN_DAYS) return "expiring";
  if (!rec.client) return "no-client";
  return "ok";
}

/** One row per oauth2 secret, for the dashboard and `foldrun secrets status`. */
export async function connectionStatus(tenant: string, now = Date.now()): Promise<ConnectionStatus[]> {
  await migrateConnections(tenant);
  const all = await store.all(tenant);
  // An OAuth consent that returned no refresh token (GitHub) is stored as a
  // plain secret; its record still says which saved app made it, so it is
  // listed too and keeps its Reconnect (Codex review, 22 Oct 2026).
  const seen = new Set(oauth2Secrets(tenant).map((s) => keyOf(s.name, s.workspace)));
  const statics = Object.values(all)
    .filter((r) => r.client && !seen.has(keyOf(r.name, r.workspace)))
    .filter((r) => listSecrets(tenant, r.workspace).some((s) => s.name === r.name && (r.workspace ? s.scope === "workspace" : s.scope !== "workspace")))
    .map((r) => ({ name: r.name, ...(r.workspace ? { workspace: r.workspace } : {}), updatedAt: r.connectedAt ?? "" }));
  return [...oauth2Secrets(tenant), ...statics].map((s) => {
    const rec = all[keyOf(s.name, s.workspace)] ?? { name: s.name, workspace: s.workspace, client: null };
    return { ...rec, status: stateOf(rec, now), daysLeft: daysLeft(rec, now), reconnectUrl: reconnectUrl(s.name, s.workspace) };
  });
}

/** The saved client to run for a secret: its own, else one for the named provider. */
export async function clientForSecret(tenant: string, name: string, workspace?: string, provider?: string): Promise<string | null> {
  await migrateConnections(tenant);
  const rec = await store.get(tenant, keyOf(name, workspace));
  if (rec?.client && (await getOAuthClient(tenant, rec.client))) return rec.client;
  if (provider) {
    const saved = await listOAuthClients(tenant);
    const hit = saved.find((c) => c.name === provider) ?? saved.find((c) => c.name.startsWith(`${provider}-`));
    if (hit) return hit.name;
  }
  return null;
}

/** The scopes a secret was connected with, when its record says. */
export async function scopesForSecret(tenant: string, name: string, workspace?: string): Promise<string | null> {
  await migrateConnections(tenant);
  return (await store.get(tenant, keyOf(name, workspace)))?.scopes ?? null;
}

/** Which scope holds `name` for a step in `workspace`. */
function scopeOfSecret(tenant: string, name: string, workspace?: string): string | undefined {
  if (workspace && listSecrets(tenant, workspace).some((s) => s.name === name && s.scope === "workspace")) return workspace;
  if (listSecrets(tenant).some((s) => s.name === name)) return undefined;
  return oauth2Secrets(tenant).find((s) => s.name === name)?.workspace;
}

// A healthy refresh happens on every API call; writing a file each time
// would be the cost of the feature. Remember in memory what is already known
// fine, and touch disk only when the state changes or once an hour.
const knownOk = new Map<string, number>();
const HOUR = 3_600_000;

const DEAD = /invalid_grant|revoked|expired|\((400|401)\)/i;

export async function noteOAuthRefresh(
  ctx: { tenant: string; workspace?: string },
  name: string,
  error: string | null,
): Promise<string | undefined> {
  const scope = scopeOfSecret(ctx.tenant, name, ctx.workspace);
  const key = `${ctx.tenant}:${keyOf(name, scope)}`;
  if (!error) {
    const seen = knownOk.get(key);
    if (seen && Date.now() - seen < HOUR) return undefined;
    knownOk.set(key, Date.now());
    const rec = await store.update(ctx.tenant, keyOf(name, scope), (r) => {
      if (!r) return null;
      delete r.lastError;
      delete r.lastErrorAt;
      delete r.notifiedAt;
      r.lastOkAt = new Date().toISOString();
      return r;
    });
    if (!rec) return undefined;
    await warnIfExpiring(ctx.tenant, rec, ctx.workspace);
    return undefined;
  }

  knownOk.delete(key);
  const now = new Date().toISOString();
  const link = reconnectUrl(name, scope);
  const dead = DEAD.test(error);
  // Once per breakage: a dead grant fails every step that uses it, and an
  // email per step would be the thing that gets filtered. Decided under the
  // record's lock, so two failing steps at once cannot both be the first.
  let alreadyTold = true;
  const rec = (await store.update(ctx.tenant, keyOf(name, scope), (r) => {
    const next = r ?? { name, ...(scope ? { workspace: scope } : {}), client: null };
    next.lastError = error.slice(0, 300);
    next.lastErrorAt = now;
    alreadyTold = Boolean(next.notifiedAt && (!next.connectedAt || next.notifiedAt >= next.connectedAt));
    if (dead && !alreadyTold) next.notifiedAt = now;
    return next;
  }))!;
  if (dead && !alreadyTold) {
    const notifyIn = scope ?? ctx.workspace ?? listWorkspaces(ctx.tenant)[0]?.name;
    if (notifyIn) {
      await sendPlainNotification(ctx.tenant, notifyIn, {
        event: "failed",
        headline: `${name} needs reconnecting`,
        detail: `The provider refused to refresh ${name}: ${rec.lastError}. Every step that uses it fails until it is reconnected. Reconnect in one click (no client id needed): ${link}`,
      }).catch(() => false);
    }
  }
  return dead ? link : undefined;
}

async function warnIfExpiring(tenant: string, rec: ConnectionRecord, workspace?: string) {
  const d = daysLeft(rec);
  if (d === null || d > EXPIRY_WARN_DAYS) return;
  if (rec.notifiedAt && Date.now() - Date.parse(rec.notifiedAt) < 7 * DAY) return;
  // Claimed under the lock: only one caller sends this week's warning.
  let claimed = false;
  await store.update(tenant, keyOf(rec.name, rec.workspace), (r) => {
    if (!r || (r.notifiedAt && Date.now() - Date.parse(r.notifiedAt) < 7 * DAY)) return null;
    claimed = true;
    return { ...r, notifiedAt: new Date().toISOString() };
  });
  if (!claimed) return;
  const notifyIn = rec.workspace ?? workspace ?? listWorkspaces(tenant)[0]?.name;
  if (!notifyIn) return;
  await sendPlainNotification(tenant, notifyIn, {
    event: "failed",
    headline: `${rec.name} expires in ${Math.max(0, d)} days`,
    detail: `Its refresh token runs out on ${rec.refreshExpiresAt?.slice(0, 10)}. Reconnect before then in one click: ${reconnectUrl(rec.name, rec.workspace)}`,
  }).catch(() => false);
}
