// One login, several accounts (FOL-464, 28 Nov 2026).
//
// A person is stored once, with their first account on the record (tenant,
// owner, role, workspaces) and every further account they joined in `also`.
// The code that decides who may do what was written for one record per
// member of an account, and reads `u.tenant === tenant && u.id === id`
// everywhere. So the store hands it exactly that: `expandPeople` turns each
// stored person into one record per account they are in, and
// `collapsePeople` turns the edited list back. A record for a joined account
// carries `joined` (when), and its `createdAt` is that moment, so "the
// earliest member" of an account is never someone who came later.
//
// What belongs to the membership: tenant, owner, role, workspaces, createdAt,
// joined, and the door they came in by (`admission`: a joined account is
// always "invite", so what the person's own sign-up earned, a trial, is never
// read as earned by an account they joined). Everything else (address, password, second factor, settings) is
// the person's, the same on every one of their records.
//
// Pure: no store, no clock. The tests are tests/people.test.ts.

export interface Membership {
  tenant: string;
  role?: string;
  workspaces?: string[] | null;
  owner?: boolean;
  /** When they joined this account (ISO). */
  createdAt: string;
}

export interface PersonLike {
  id: string;
  tenant: string;
  createdAt: string;
  owner?: boolean;
  role?: string;
  workspaces?: string[] | null;
  admission?: string;
  /** Set on a record for an account the person joined after their first: when. */
  joined?: string;
}

export type Stored<T extends PersonLike> = T & { also?: Membership[] };

const OF_MEMBERSHIP = new Set(["tenant", "owner", "role", "workspaces", "createdAt", "joined", "also", "admission"]);

const keyOf = (u: { id: string; tenant: string }) => `${u.id}\u0000${u.tenant}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** One record per account each person is in: their first account's, then
 *  the joined ones in the order they joined. */
export function expandPeople<T extends PersonLike>(people: Stored<T>[]): T[] {
  const out: T[] = [];
  for (const p of people) {
    const { also, ...rest } = p;
    const home = rest as unknown as T;
    delete home.joined; // never stored on the person; a file edited by hand must not make one
    out.push(home);
    for (const m of [...(also ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.tenant.localeCompare(b.tenant))) {
      if (m.tenant === home.tenant || out.some((v) => v.id === home.id && v.tenant === m.tenant)) continue; // once per account
      const v = { ...home, tenant: m.tenant, createdAt: m.createdAt, joined: m.createdAt, admission: "invite" } as T;
      delete v.owner;
      delete v.role;
      delete v.workspaces;
      if (m.owner) v.owner = true;
      if (m.role) v.role = m.role;
      if (m.workspaces !== undefined && m.workspaces !== null) v.workspaces = m.workspaces;
      out.push(v);
    }
  }
  return out;
}

/** The records as they were handed out, to tell afterwards what was changed. */
export function snapshotPeople<T extends PersonLike>(views: T[]): Map<string, T> {
  return new Map(views.map((v) => [keyOf(v), structuredClone(v)]));
}

/**
 * The edited records, back as stored people.
 *
 * - A record spliced out ends that membership. When it was the person's
 *   first account and they are in others, the one they joined earliest
 *   becomes their first; when it was their only one, the person is gone.
 * - A record pushed for a person who is already there must say `joined`.
 * - Something of the person's (a password, a setting) changed on a joined
 *   record is the person's: it is kept, unless their first record changed
 *   the same thing, which wins.
 *
 * Throws on a list no caller should produce: a person twice in one account,
 * or two first accounts.
 */
export function collapsePeople<T extends PersonLike>(views: T[], before: Map<string, T> = new Map()): Stored<T>[] {
  const groups = new Map<string, T[]>();
  for (const v of views) {
    const g = groups.get(v.id);
    if (g) g.push(v);
    else groups.set(v.id, [v]);
  }
  const out: Stored<T>[] = [];
  for (const [id, group] of groups) {
    const tenants = new Set<string>();
    for (const v of group) {
      if (tenants.has(v.tenant)) throw new Error(`person ${id} is in account ${v.tenant} twice`);
      tenants.add(v.tenant);
    }
    const homes = group.filter((v) => !v.joined);
    if (homes.length > 1) throw new Error(`person ${id} has two first accounts (${homes.map((h) => h.tenant).join(", ")}): a joined account's record says when it was joined`);
    const joined = group.filter((v) => v.joined).sort((a, b) => a.joined!.localeCompare(b.joined!) || a.tenant.localeCompare(b.tenant));
    const promoted = homes.length === 0;
    const home = homes[0] ?? joined.shift()!;
    const person = { ...home } as Record<string, unknown>;
    delete person.joined;
    delete person.also;
    // The person's own fields, changed on a joined record.
    const homeWas = before.get(keyOf(home)) as Record<string, unknown> | undefined;
    for (const v of joined) {
      const was = before.get(keyOf(v)) as Record<string, unknown> | undefined;
      if (!was) continue; // new this time: it was copied from the person as they are
      const now = v as unknown as Record<string, unknown>;
      for (const k of new Set([...Object.keys(now), ...Object.keys(was)])) {
        if (OF_MEMBERSHIP.has(k) || same(now[k], was[k])) continue;
        if (!promoted && homeWas && !same((home as unknown as Record<string, unknown>)[k], homeWas[k])) continue;
        if (now[k] === undefined) delete person[k];
        else person[k] = now[k];
      }
    }
    const also: Membership[] = joined.map((v) => ({
      tenant: v.tenant,
      ...(v.role ? { role: v.role } : {}),
      ...(v.workspaces !== undefined && v.workspaces !== null ? { workspaces: v.workspaces } : {}),
      ...(v.owner ? { owner: true } : {}),
      createdAt: v.joined!,
    }));
    out.push({ ...(person as unknown as T), ...(also.length ? { also } : {}) });
  }
  return out;
}
