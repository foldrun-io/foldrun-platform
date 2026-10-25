// A per-account map of named records — the shape oauth-clients.json and
// oauth-connections.json always had — with one store for a database and one
// for files, behind the same five calls.
//
// Both files were read whole, changed and written whole, with no lock, from
// request handlers and from the refresh hook that runs on every OAuth call;
// two changes at once kept one. Here a change to one record is atomic: a
// transaction on its locked row, or, without a database, a per-account chain
// and a tmp-then-rename write.

import fs from "node:fs";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { databaseEnabled, ormRequired, tx } from "./db.ts";
import type { KeyedRecordsTable } from "./schema.ts";

export interface KeyedStore<R> {
  all(tenant: string): Promise<Record<string, R>>;
  get(tenant: string, key: string): Promise<R | undefined>;
  put(tenant: string, key: string, record: R): Promise<void>;
  /** Change one record atomically; `change` returns the new record, or null to leave it. */
  update(tenant: string, key: string, change: (current: R | undefined) => R | null): Promise<R | undefined>;
  remove(tenant: string, key: string): Promise<boolean>;
}

function fileStore<R>(fileOf: (tenant: string) => string): KeyedStore<R> {
  const read = (tenant: string): Record<string, R> => {
    try {
      return JSON.parse(fs.readFileSync(fileOf(tenant), "utf8")) as Record<string, R>;
    } catch {
      return {};
    }
  };
  const write = (tenant: string, all: Record<string, R>) => {
    const file = fileOf(tenant);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  const locks = new Map<string, Promise<unknown>>();
  const locked = <T>(tenant: string, fn: () => T): Promise<T> => {
    const run = (locks.get(tenant) ?? Promise.resolve()).then(fn);
    locks.set(tenant, run.catch(() => undefined));
    return run;
  };
  return {
    async all(tenant) {
      return read(tenant);
    },
    async get(tenant, key) {
      return read(tenant)[key];
    },
    put(tenant, key, record) {
      return locked(tenant, () => {
        const all = read(tenant);
        all[key] = record;
        write(tenant, all);
      });
    },
    update(tenant, key, change) {
      return locked(tenant, () => {
        const all = read(tenant);
        const next = change(all[key] === undefined ? undefined : structuredClone(all[key]));
        if (next === null) return all[key];
        all[key] = next;
        write(tenant, all);
        return next;
      });
    },
    remove(tenant, key) {
      return locked(tenant, () => {
        const all = read(tenant);
        if (!(key in all)) return false;
        delete all[key];
        write(tenant, all);
        return true;
      });
    },
  };
}

function dbStore<R>(table: KeyedRecordsTable): KeyedStore<R> {
  const at = (tenant: string, key: string) => and(eq(table.tenant, tenant), eq(table.key, key));
  return {
    async all(tenant) {
      const rows = await ormRequired().select().from(table).where(eq(table.tenant, tenant)).orderBy(asc(table.key));
      return Object.fromEntries(rows.map((r) => [r.key, r.record as R]));
    },
    async get(tenant, key) {
      const [r] = await ormRequired().select({ record: table.record }).from(table).where(at(tenant, key));
      return r ? (r.record as R) : undefined;
    },
    async put(tenant, key, record) {
      await ormRequired()
        .insert(table)
        .values({ tenant, key, record })
        .onConflictDoUpdate({ target: [table.tenant, table.key], set: { record, updatedAt: new Date() } });
    },
    async update(tenant, key, change) {
      return tx(async (t) => {
        const [r] = await t.select({ record: table.record }).from(table).where(at(tenant, key)).for("update");
        const current = r ? (r.record as R) : undefined;
        const next = change(current === undefined ? undefined : structuredClone(current));
        if (next === null) return current;
        await t
          .insert(table)
          .values({ tenant, key, record: next })
          .onConflictDoUpdate({ target: [table.tenant, table.key], set: { record: next, updatedAt: new Date() } });
        return next;
      });
    },
    async remove(tenant, key) {
      const gone = await ormRequired().delete(table).where(at(tenant, key)).returning({ key: table.key });
      return gone.length === 1;
    },
  };
}

/** The store for a table, or its file when the install has no database. */
export function keyedStore<R>(table: KeyedRecordsTable, fileOf: (tenant: string) => string): KeyedStore<R> {
  const files = fileStore<R>(fileOf);
  const rows = dbStore<R>(table);
  // Decided per call, not at import: tests and boot set the database after.
  const pick = () => (databaseEnabled() ? rows : files);
  return {
    all: (t) => pick().all(t),
    get: (t, k) => pick().get(t, k),
    put: (t, k, r) => pick().put(t, k, r),
    update: (t, k, c) => pick().update(t, k, c),
    remove: (t, k) => pick().remove(t, k),
  };
}

/** A file's records into the table, once. A row already there is kept. */
export async function importKeyedFile<R>(table: KeyedRecordsTable, tenant: string, records: Record<string, R>): Promise<number> {
  const values = Object.entries(records).map(([key, record]) => ({ tenant, key, record }));
  if (!values.length) return 0;
  const got = await ormRequired().insert(table).values(values).onConflictDoNothing().returning({ key: table.key });
  return got.length;
}
