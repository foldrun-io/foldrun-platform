// How many bytes an account stores, for the storage meter (FOL-125, 8 Nov 2026).
//
// ONE question with ONE answer, so the Usage page, the daily storage line on
// the ledger and the plan-allowance check can never disagree: `measureStorage`.
//
// Today the answer is read off the filesystem, the way the Usage page always
// counted it: every workspace's source, its file store, and its run history.
// (Run history counts toward the allowance because it sits on the same disk
// and grows for as long as it is kept; retention.ts is what bounds it. Say so
// to the owners — it is a decision that can flip here, in one place.)
//
// FOL-126 moves stored files to Postgres + S3, where an account's size is the
// sum of its live revisions, not a directory walk. That change is a
// `setStorageMeasurer(...)` call at boot with a function that returns
// `{ bytes, basis: "revisions" }`; nothing that reads the measure changes.

export type StorageBasis = "filesystem" | "revisions";

export interface StorageMeasure {
  /** Bytes stored by the account. */
  bytes: number;
  /** Where the figure came from; shown beside the storage meter. */
  basis: StorageBasis;
}

/** What the filesystem walk found, for a measurer that wants it as a fallback. */
export type StorageMeasurer = (tenant: string, filesystemBytes: number) => StorageMeasure | Promise<StorageMeasure>;

const filesystem: StorageMeasurer = (_tenant, bytes) => ({ bytes, basis: "filesystem" });

let measurer: StorageMeasurer = filesystem;

/** Replace the measure (FOL-126's revisions). Returns the previous one, so a
 *  test can put it back. */
export function setStorageMeasurer(next: StorageMeasurer | null): StorageMeasurer {
  const prev = measurer;
  measurer = next ?? filesystem;
  return prev;
}

/** The account's stored bytes. `filesystemBytes` is the directory walk the
 *  caller already did (usage.ts); the default measure is exactly that. */
export async function measureStorage(tenant: string, filesystemBytes: number): Promise<StorageMeasure> {
  const m = await measurer(tenant, filesystemBytes);
  return { bytes: Number.isFinite(m.bytes) && m.bytes > 0 ? Math.round(m.bytes) : 0, basis: m.basis };
}
