// The assistant's conversations: kept, so a person can find one again.
//
// Each belongs to the actor who had it — a person, or an API key — and only
// they list, read or delete it (`owner` is `<kind>:<id>`). A conversation is
// written when a reply finishes, by whoever ran the reply, so it is kept
// even when the browser that asked has gone away.
//
// Postgres when the install has a database; one JSON file per conversation
// under the account otherwise (a laptop, the tests). At most KEEP per
// owner: the oldest go when a new one would pass it.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { accountDir } from "../../../foldrun-core/src/store.ts";
import { databaseEnabled, ormRequired } from "../db.ts";
import { assistantConversations } from "../schema.ts";

export const KEEP = 500;

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  /** Anything the panel draws under a reply: sources, the token line, a proposed workspace. */
  meta?: Record<string, unknown>;
}

export interface StoredFile {
  path: string;
  content: string;
  before: string | null;
  sha256: string | null;
}

export interface Conversation {
  id: string;
  workspace: string;
  owner: string;
  title: string;
  messages: StoredMessage[];
  files: StoredFile[];
  createdAt: string;
  updatedAt: string;
}

export interface ConversationSummary {
  id: string;
  workspace: string;
  title: string;
  updatedAt: string;
  messages: number;
  unsaved: number;
}

export const newConversationId = () => `c_${Date.now().toString(36)}${crypto.randomBytes(5).toString("hex")}`;
const ID = /^c_[a-z0-9]{8,40}$/;
export const isConversationId = (id: string) => ID.test(id);

/** The first question, on one line — what the list shows. */
export function titleOf(messages: StoredMessage[]): string {
  const first = messages.find((m) => m.role === "user")?.content ?? "";
  const line = first.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line || "(empty)";
}

const summaryOf = (c: Conversation): ConversationSummary => ({
  id: c.id,
  workspace: c.workspace,
  title: c.title,
  updatedAt: c.updatedAt,
  messages: c.messages.length,
  unsaved: c.files.length,
});

// ---------------------------------------------------------------- files

const dirOf = (tenant: string) => path.join(accountDir(tenant), "assistant", "conversations");
const fileOf = (tenant: string, id: string) => path.join(dirOf(tenant), `${id}.json`);

function readFileConversation(tenant: string, id: string): Conversation | null {
  try {
    return JSON.parse(fs.readFileSync(fileOf(tenant, id), "utf8")) as Conversation;
  } catch {
    return null;
  }
}

function allFileConversations(tenant: string): Conversation[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dirOf(tenant)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  return names.map((n) => readFileConversation(tenant, n.slice(0, -5))).filter((c): c is Conversation => !!c);
}

// ---------------------------------------------------------------- the store

/** Write a conversation as it now stands; a new id when it has none. */
export async function saveConversation(
  tenant: string,
  input: { id?: string | null; workspace: string; owner: string; messages: StoredMessage[]; files: StoredFile[] },
): Promise<string> {
  const id = input.id && isConversationId(input.id) ? input.id : newConversationId();
  const now = new Date().toISOString();
  const title = titleOf(input.messages);
  if (databaseEnabled()) {
    const q = ormRequired();
    // Upsert, but never across owners: an id someone else holds is left alone.
    await q
      .insert(assistantConversations)
      .values({ id, tenant, workspace: input.workspace, owner: input.owner, title, messages: input.messages, files: input.files, messageCount: input.messages.length })
      .onConflictDoUpdate({
        target: assistantConversations.id,
        set: { workspace: input.workspace, title, messages: input.messages, files: input.files, messageCount: input.messages.length, updatedAt: sql`now()` },
        setWhere: and(eq(assistantConversations.tenant, tenant), eq(assistantConversations.owner, input.owner)),
      });
    await q.execute(sql`
      DELETE FROM assistant_conversations WHERE id IN (
        SELECT id FROM assistant_conversations WHERE tenant = ${tenant} AND owner = ${input.owner}
         ORDER BY updated_at DESC OFFSET ${KEEP})`);
    return id;
  }
  const existing = readFileConversation(tenant, id);
  if (existing && existing.owner !== input.owner) return id;
  const record: Conversation = {
    id,
    workspace: input.workspace,
    owner: input.owner,
    title,
    messages: input.messages,
    files: input.files,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  fs.mkdirSync(dirOf(tenant), { recursive: true });
  const tmp = `${fileOf(tenant, id)}.${process.pid}.${crypto.randomBytes(3).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(tmp, fileOf(tenant, id));
  const mine = allFileConversations(tenant)
    .filter((c) => c.owner === input.owner)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const old of mine.slice(KEEP)) fs.rmSync(fileOf(tenant, old.id), { force: true });
  return id;
}

/** One owner's conversations, newest first; `q` matches the title or any message. */
export async function listConversations(
  tenant: string,
  owner: string,
  opts: { workspace?: string | null; q?: string | null; limit?: number } = {},
): Promise<ConversationSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const q = opts.q?.trim().toLowerCase() ?? "";
  if (databaseEnabled()) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await ormRequired()
      .select({
        id: assistantConversations.id,
        workspace: assistantConversations.workspace,
        title: assistantConversations.title,
        updatedAt: assistantConversations.updatedAt,
        messages: assistantConversations.messageCount,
        unsaved: sql<number>`jsonb_array_length(${assistantConversations.files})`,
      })
      .from(assistantConversations)
      .where(
        and(
          eq(assistantConversations.tenant, tenant),
          eq(assistantConversations.owner, owner),
          opts.workspace ? eq(assistantConversations.workspace, opts.workspace) : undefined,
          q ? sql`(${assistantConversations.title} ILIKE ${like} OR ${assistantConversations.messages}::text ILIKE ${like})` : undefined,
        ),
      )
      .orderBy(desc(assistantConversations.updatedAt))
      .limit(limit);
    return rows.map((r) => ({ ...r, updatedAt: new Date(r.updatedAt).toISOString(), unsaved: Number(r.unsaved) }));
  }
  return allFileConversations(tenant)
    .filter((c) => c.owner === owner && (!opts.workspace || c.workspace === opts.workspace))
    .filter((c) => !q || c.title.toLowerCase().includes(q) || c.messages.some((m) => m.content.toLowerCase().includes(q)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
    .map(summaryOf);
}

/** One conversation, whole — only its owner's. */
export async function getConversation(tenant: string, owner: string, id: string): Promise<Conversation | null> {
  if (!isConversationId(id)) return null;
  if (databaseEnabled()) {
    const [row] = await ormRequired()
      .select()
      .from(assistantConversations)
      .where(and(eq(assistantConversations.tenant, tenant), eq(assistantConversations.owner, owner), eq(assistantConversations.id, id)))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      workspace: row.workspace,
      owner: row.owner,
      title: row.title,
      messages: row.messages as StoredMessage[],
      files: row.files as StoredFile[],
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
  }
  const c = readFileConversation(tenant, id);
  return c && c.owner === owner ? c : null;
}

/** Delete one — only its owner's. True when there was one. */
export async function deleteConversation(tenant: string, owner: string, id: string): Promise<boolean> {
  if (!isConversationId(id)) return false;
  if (databaseEnabled()) {
    const gone = await ormRequired()
      .delete(assistantConversations)
      .where(and(eq(assistantConversations.tenant, tenant), eq(assistantConversations.owner, owner), eq(assistantConversations.id, id)))
      .returning({ id: assistantConversations.id });
    return gone.length > 0;
  }
  const c = readFileConversation(tenant, id);
  if (!c || c.owner !== owner) return false;
  fs.rmSync(fileOf(tenant, id), { force: true });
  return true;
}
