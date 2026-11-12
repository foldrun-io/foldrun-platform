// Built runtimes in the object store (FOL-126): the last thing a run pod
// mounted from the shared volume was its dependency cache — venvs, npm
// prefixes and sealed `runtime: system:` snapshots — at fixed paths. With
// `runs.runtime_store` on, the pod has no volume: those paths are the
// container's own disk, the worker unpacks what the store holds into them
// before the step starts, and packs what the step built back out when it ends.
//
//   head   runtime_archives (tenant, variant, kind, ref) → sha256, bytes
//   bytes  runtimes/<scope>/<sha256>.tgz in the object store
//
// tenant '' is the platform's shared layer (built by warm pods, runtime-warm.ts);
// any other is one account's own, written and read by that account's pods
// only — the boundary the per-account cache directory kept. An archive is
// checked against the row's sha256 before it is unpacked; a system snapshot
// carries the account's seal besides and root verifies it in the pod, as on
// the volume (core runtime.ts systemInstallSh).
//
// Nothing here fails a step: a restore that cannot be had is a fresh install,
// a save that cannot be made is the next step installing again.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { blobStore, downloadToFile, fileSource } from "../../foldrun-core/src/blob-store.ts";
import { opsError } from "../../foldrun-core/src/ops-log.ts";
import { RUNTIME_CACHE, SHARED_RUNTIMES } from "../../foldrun-core/src/run-container.ts";
import { fingerprint, RUNTIME_FROM_STORE, safeTenantSegment, type RuntimeSpec } from "../../foldrun-core/src/runtime.ts";
import { db } from "./db.ts";
import { setting } from "./settings.ts";

/** The shared layer's scope: no account. */
export const SHARED_SCOPE = "";

/** Is the runtime cache kept in the object store? Needs the database. */
export const runtimeStoreOn = (): boolean => setting("runs.runtime_store") === true && Boolean(db());

/** The largest archive kept, compressed. Past it the entry is not saved and
 *  the step says so; the next step installs again. */
export const maxArchiveBytes = (): number => {
  const raw = Number(process.env.FOLDRUN_RUNTIME_ARCHIVE_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 2 * 1024 ** 3;
};

const maxAgeDays = (): number => {
  const raw = Number(process.env.FOLDRUN_RUNTIME_MAX_AGE_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
};

/**
 * What an archive is only good for: the image family it was built in and the
 * machine architecture. A venv names its interpreter by absolute path and
 * holds compiled wheels, so the slim and the full runner, or amd64 and arm64,
 * never share one. The tag is left out on purpose: a release keeps the OS
 * layers (the runner base is pinned by digest), and an entry a new image
 * cannot use fails core's checkEntry, is rebuilt, and replaces the row.
 */
export function variantOf(image: string, arch: string = process.env.FOLDRUN_RUNNER_ARCH ?? process.arch): string {
  const family = image.replace(/@sha256:[0-9a-f]+$/, "").replace(/:[^:/]+$/, "");
  return crypto.createHash("sha256").update(`${family}\n${arch}`).digest("hex").slice(0, 12);
}

/** The row key of a spec's system packages: the sorted set, hashed. */
export function systemRef(spec: RuntimeSpec): string | null {
  const pkgs = [...new Set(spec.system ?? [])].sort();
  return pkgs.length ? crypto.createHash("sha256").update(pkgs.join("\n")).digest("hex").slice(0, 16) : null;
}

const scopeSegment = (tenant: string): string | null => (tenant === SHARED_SCOPE ? "_shared" : safeTenantSegment(tenant));
const blobKey = (scope: string, sha: string) => `runtimes/${scope}/${sha}.tgz`;

type Kind = "env" | "sys";
export interface ArchiveRow { tenant: string; variant: string; kind: Kind; ref: string; sha256: string; bytes: number }

async function rowOf(tenant: string, variant: string, kind: Kind, ref: string): Promise<ArchiveRow | null> {
  const r = await db()!.query<{ sha256: string; bytes: string }>(
    `UPDATE runtime_archives SET used_at = now() WHERE tenant=$1 AND variant=$2 AND kind=$3 AND ref=$4 RETURNING sha256, bytes`,
    [tenant, variant, kind, ref],
  );
  return r.rows[0] ? { tenant, variant, kind, ref, sha256: r.rows[0].sha256, bytes: Number(r.rows[0].bytes) } : null;
}

/** Drop a blob no row of its scope names any more. */
async function dropUnnamed(tenant: string, sha: string): Promise<void> {
  const scope = scopeSegment(tenant);
  if (!scope) return;
  const still = await db()!.query(`SELECT 1 FROM runtime_archives WHERE tenant=$1 AND sha256=$2 LIMIT 1`, [tenant, sha]);
  if (!still.rowCount) await blobStore().delete(blobKey(scope, sha)).catch(() => {});
}

async function putRow(row: ArchiveRow): Promise<void> {
  const c = await db()!.connect();
  let prev: string | undefined;
  try {
    await c.query("BEGIN");
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`runtime_archives:${row.tenant}:${row.variant}:${row.kind}:${row.ref}`]);
    prev = (await c.query<{ sha256: string }>(`SELECT sha256 FROM runtime_archives WHERE tenant=$1 AND variant=$2 AND kind=$3 AND ref=$4`, [row.tenant, row.variant, row.kind, row.ref])).rows[0]?.sha256;
    await c.query(
      `INSERT INTO runtime_archives (tenant, variant, kind, ref, sha256, bytes) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant, variant, kind, ref) DO UPDATE SET sha256 = EXCLUDED.sha256, bytes = EXCLUDED.bytes, created_at = now(), used_at = now()`,
      [row.tenant, row.variant, row.kind, row.ref, row.sha256, row.bytes],
    );
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    c.release();
  }
  if (prev && prev !== row.sha256) await dropUnnamed(row.tenant, prev);
}

async function dropRow(tenant: string, variant: string, kind: Kind, ref: string): Promise<void> {
  const r = await db()!.query<{ sha256: string }>(`DELETE FROM runtime_archives WHERE tenant=$1 AND variant=$2 AND kind=$3 AND ref=$4 RETURNING sha256`, [tenant, variant, kind, ref]);
  for (const x of r.rows) await dropUnnamed(tenant, x.sha256);
}

// ---------------------------------------------------------------- the pod's side

const kubectl = () => process.env.FOLDRUN_KUBECTL ?? "kubectl";

/** Where things are in the pod, and who the step runs as. A test points these
 *  at a temp directory and runs the shell here. */
export interface PodPlace {
  ns: string;
  pod: string;
  cacheDir?: string;
  sharedDir?: string;
  /** The prefix that makes a command the agent user's. */
  asAgent?: string;
  /** The start-up's status file for `runtime: system:`. */
  systemStatus?: string;
}
const cacheOf = (p: PodPlace) => p.cacheDir ?? RUNTIME_CACHE;
const sharedOf = (p: PodPlace) => p.sharedDir ?? SHARED_RUNTIMES;
const agentOf = (p: PodPlace) => p.asAgent ?? "runuser -u agent --";
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const execArgs = (p: PodPlace, sh: string, stdin: boolean) => ["exec", ...(stdin ? ["-i"] : []), "-n", p.ns, p.pod, "--", "sh", "-c", sh];

const TRANSFER_MS = 10 * 60_000;

function podSh(p: PodPlace, sh: string): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(kubectl(), execArgs(p, sh, false), { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (out += c.toString()));
    child.on("error", (err) => { clearTimeout(timer); resolve({ status: null, out: String(err) }); });
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, out }); });
  });
}

/** A local file into a command's stdin in the pod. */
function fileIntoPod(p: PodPlace, file: string, sh: string): Promise<{ status: number | null; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(kubectl(), execArgs(p, sh, true), { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), TRANSFER_MS);
    child.stderr.on("data", (c: Buffer) => (err = (err + c.toString()).slice(-2000)));
    child.on("error", (e) => { clearTimeout(timer); resolve({ status: null, err: String(e) }); });
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, err }); });
    // The pod may stop reading (a full disk, a killed exec): that is the
    // close's status to report, not an unhandled EPIPE.
    child.stdin.on("error", () => {});
    fs.createReadStream(file).on("error", () => child.kill("SIGKILL")).pipe(child.stdin);
  });
}

/** A command's stdout in the pod into a local file, hashed on the way, and cut off past `max`. */
function podIntoFile(p: PodPlace, sh: string, dest: string, max: number): Promise<{ ok: boolean; bytes: number; sha256: string; why: string }> {
  return new Promise((resolve) => {
    const child = spawn(kubectl(), execArgs(p, sh, false), { stdio: ["ignore", "pipe", "pipe"] });
    const out = fs.createWriteStream(dest);
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    let err = "";
    let over = false;
    let failed = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), TRANSFER_MS);
    // The worker's disk filling is a save that was not made, never a crash.
    out.on("error", (e) => {
      failed = `could not be spooled: ${e.message.slice(0, 120)}`;
      child.kill("SIGKILL");
    });
    child.stdout.on("data", (c: Buffer) => {
      if (failed) return;
      bytes += c.length;
      if (bytes > max) { over = true; child.kill("SIGKILL"); return; }
      hash.update(c);
      if (!out.write(c)) { child.stdout.pause(); out.once("drain", () => child.stdout.resume()); }
    });
    child.stderr.on("data", (c: Buffer) => (err = (err + c.toString()).slice(-2000)));
    let finished = false;
    const done = (status: number | null, why: string) => {
      // A spawn that fails says so twice (error, then close), and a hash is
      // read once.
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (failed) {
        out.destroy();
        resolve({ ok: false, bytes, sha256: "", why: failed });
        return;
      }
      out.end(() => resolve({ ok: status === 0 && !over && bytes > 0, bytes, sha256: hash.digest("hex"), why: over ? `larger than ${Math.round(max / 1024 ** 2)} MiB` : why }));
    };
    child.on("error", (e) => done(null, String(e)));
    child.on("close", (status) => done(status, err.trim().slice(-300) || `exit ${status}`));
  });
}

const spool = () => fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-rt-"));

/** Fetch an archive to a local file, checked against the row's hash. */
async function fetchArchive(row: ArchiveRow, dir: string): Promise<string | null> {
  const scope = scopeSegment(row.tenant);
  if (!scope) return null;
  const file = path.join(dir, `${row.kind}-${row.sha256.slice(0, 16)}.tgz`);
  await downloadToFile(blobStore(), blobKey(scope, row.sha256), file, { sha256: row.sha256 });
  return file;
}

/** What a restore did, which the save after the step needs to know. */
export interface RestoreState {
  variant: string;
  fp: string | null;
  env: "shared" | "account" | null;
  /** `<key>/<generation>` of every system snapshot unpacked. */
  sysGens: string[];
  lines: string[];
}

const SAFE_FP = /^[0-9a-f]{16}$/;
const SAFE_GEN = /^v5-[0-9a-f]{16}\/[0-9a-f]{16}$/;

/**
 * Before the step starts: unpack what the store holds for this step's runtime
 * into the pod. The shared layer's entry if there is one, else the account's
 * own; and the account's sealed system snapshot for its package set.
 */
export async function restoreRuntime(opts: { tenant: string; spec: RuntimeSpec | null | undefined; image: string; place: PodPlace; /** false: the shared layer is off, the pod would not read it. */ shared?: boolean }): Promise<RestoreState> {
  const { tenant, spec, place } = opts;
  const variant = variantOf(opts.image);
  const wantsEnv = Boolean(spec && (spec.python || spec.packages.length || spec.node || spec.npm.length));
  const state: RestoreState = { variant, fp: spec && wantsEnv ? fingerprint(spec) : null, env: null, sysGens: [], lines: [] };
  if (!spec || !safeTenantSegment(tenant)) return state;
  const dir = spool();
  try {
    if (state.fp) {
      const fp = state.fp;
      const shared = opts.shared === false ? null : await rowOf(SHARED_SCOPE, variant, "env", fp);
      const own = shared ? null : await rowOf(tenant, variant, "env", fp);
      const row = shared ?? own;
      if (row) {
        const t0 = Date.now();
        const file = await fetchArchive(row, dir);
        const dest = `${shared ? sharedOf(place) : cacheOf(place)}/${fp}`;
        // The shared entry is unpacked by root and owned by root; the
        // account's own by the agent user, so nothing in an archive an
        // account's step made is ever written with more than that step had.
        const unpack = `rm -rf ${q(dest)} && mkdir -p ${q(dest)} && gzip -dc | tar x --no-same-owner -C ${q(dest)} && printf %s ${q(row.sha256)} > ${q(`${dest}/${RUNTIME_FROM_STORE}`)}`;
        const sh = shared ? unpack : `${agentOf(place)} sh -c ${q(unpack)}`;
        const put = file ? await fileIntoPod(place, file, sh) : { status: 1, err: "no scope" };
        if (put.status === 0) {
          state.env = shared ? "shared" : "account";
          state.lines.push(`runtime ${fp}: unpacked from the store (${Math.round(row.bytes / 1024 ** 2)} MiB, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
        } else {
          // Half an entry must not look like one.
          await podSh(place, `rm -rf ${q(dest)}`);
          opsError("runtime_store.restore_failed", new Error(put.err.slice(-300) || "unpack failed"), { tenant, fingerprint: fp }, "warn");
        }
        if (file) fs.rmSync(file, { force: true });
      }
    }
    const sref = systemRef(spec);
    if (sref) {
      const row = await rowOf(tenant, variant, "sys", sref);
      const file = row ? await fetchArchive(row, dir) : null;
      if (row && file) {
        const snaps = `${cacheOf(place)}/.system-snapshots`;
        const unpack = `mkdir -p ${q(snaps)} && gzip -dc | tar x --no-same-owner -C ${q(snaps)}`;
        const put = await fileIntoPod(place, file, `${agentOf(place)} sh -c ${q(unpack)}`);
        if (put.status === 0) {
          const listed = await podSh(place, `cd ${q(snaps)} 2>/dev/null && for d in */*/; do [ -f "$d/seal" ] && echo "$d"; done; true`);
          state.sysGens = listed.out.split("\n").map((l) => l.trim().replace(/\/$/, "")).filter((l) => SAFE_GEN.test(l));
        } else {
          opsError("runtime_store.restore_failed", new Error(put.err.slice(-300) || "unpack failed"), { tenant, fingerprint: sref }, "warn");
        }
      }
    }
  } catch (err) {
    opsError("runtime_store.restore_failed", err, { tenant }, "warn");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return state;
}

/** Pack one directory of the pod into the store and point the row at it. */
async function saveDir(row: Omit<ArchiveRow, "sha256" | "bytes">, place: PodPlace, sh: string, dir: string): Promise<{ bytes: number } | { skipped: string }> {
  const scope = scopeSegment(row.tenant);
  if (!scope) return { skipped: "no scope" };
  const file = path.join(dir, `${row.kind}-out.tgz`);
  const got = await podIntoFile(place, sh, file, maxArchiveBytes());
  if (!got.ok) return { skipped: got.why };
  await blobStore().putSourceIfAbsent(blobKey(scope, got.sha256), fileSource(file), { sha256: got.sha256, contentType: "application/gzip" });
  await putRow({ ...row, sha256: got.sha256, bytes: got.bytes });
  fs.rmSync(file, { force: true });
  return { bytes: got.bytes };
}

/**
 * After the step (or a warm build): keep what was built here. An entry that
 * came from the store and was used as it was is left alone — the marker a
 * restore leaves is still there; a rebuild removes it (core runtime.ts).
 * `scope` is the account for a step, SHARED_SCOPE for a warm pod's entry.
 */
export async function saveRuntime(opts: { tenant: string; scope?: string; spec: RuntimeSpec | null | undefined; state: RestoreState; place: PodPlace }): Promise<string[]> {
  const { tenant, spec, state, place } = opts;
  const scope = opts.scope ?? tenant;
  const lines: string[] = [];
  if (!spec || !safeTenantSegment(tenant)) return lines;
  const dir = spool();
  try {
    if (state.fp && SAFE_FP.test(state.fp)) {
      const fp = state.fp;
      const entry = `${scope === SHARED_SCOPE ? sharedOf(place) : cacheOf(place)}/${fp}`;
      const built = await podSh(place, `[ -f ${q(`${entry}/.ready`)} ] && [ ! -e ${q(`${entry}/${RUNTIME_FROM_STORE}`)} ] && echo built; true`);
      if (/^built$/m.test(built.out)) {
        const pack = `tar c -C ${q(entry)} --exclude=./.building --exclude=./.failed . | gzip -1`;
        const saved = await saveDir({ tenant: scope, variant: state.variant, kind: "env", ref: fp }, place, scope === SHARED_SCOPE ? pack : `${agentOf(place)} sh -c ${q(pack)}`, dir);
        if ("bytes" in saved) {
          lines.push(`runtime ${fp}: kept for the next step (${Math.round(saved.bytes / 1024 ** 2)} MiB)`);
          // The account built its own although the shared layer had this
          // fingerprint: that entry did not pass the check in the pod. Drop
          // its row, so the next step unpacks the account's and a warm
          // build makes a new shared one.
          if (scope !== SHARED_SCOPE && state.env === "shared") await dropRow(SHARED_SCOPE, state.variant, "env", fp);
        } else {
          lines.push(`runtime ${fp}: not kept (${saved.skipped}) — the next step installs again`);
        }
      }
    }
    const sref = scope === SHARED_SCOPE ? null : systemRef(spec);
    if (sref) {
      const snaps = `${cacheOf(place)}/.system-snapshots`;
      const status = place.systemStatus ?? "/opt/runner/job/system-install.json";
      // The start-up says which key it installed under; the newest generation
      // of that key that was not unpacked from the store is the one made here.
      const said = await podSh(place, `head -c 2000 ${q(status)} 2>/dev/null; echo; cd ${q(snaps)} 2>/dev/null && ls -dt */*/ 2>/dev/null; true`);
      const [first, ...rest] = said.out.split("\n");
      let key = "";
      try {
        const st = JSON.parse(first || "{}") as { ok?: boolean; mode?: string; key?: string };
        if (st.ok === true && st.mode === "apt" && typeof st.key === "string" && /^v5-[0-9a-f]{16}$/.test(st.key)) key = st.key;
      } catch {
        key = "";
      }
      const gen = key ? rest.map((l) => l.trim().replace(/\/$/, "")).find((g) => SAFE_GEN.test(g) && g.startsWith(`${key}/`) && !state.sysGens.includes(g)) : undefined;
      if (gen) {
        const pack = `tar c -C ${q(snaps)} ${q(gen)} | gzip -1`;
        const saved = await saveDir({ tenant: scope, variant: state.variant, kind: "sys", ref: sref }, place, `${agentOf(place)} sh -c ${q(pack)}`, dir);
        lines.push("bytes" in saved ? `runtime: system packages kept for the next step (${Math.round(saved.bytes / 1024 ** 2)} MiB)` : `runtime: system packages not kept (${saved.skipped})`);
      }
    }
  } catch (err) {
    opsError("runtime_store.save_failed", err, { tenant }, "warn");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return lines;
}

/** Does the store hold this fingerprint for the shared layer or the account? */
export async function archivedEnv(tenant: string, image: string, fp: string): Promise<boolean> {
  const r = await db()!.query(`SELECT 1 FROM runtime_archives WHERE tenant = ANY($1) AND variant=$2 AND kind='env' AND ref=$3 LIMIT 1`, [[SHARED_SCOPE, tenant], variantOf(image), fp]);
  return Boolean(r.rowCount);
}

/** Archives nobody unpacked for the max age (30 days) go, rows and bytes. */
export async function expireRuntimeArchives(): Promise<number> {
  if (!db()) return 0;
  const r = await db()!.query<{ tenant: string; sha256: string }>(`DELETE FROM runtime_archives WHERE used_at < now() - make_interval(days => $1) RETURNING tenant, sha256`, [maxAgeDays()]);
  for (const x of r.rows) await dropUnnamed(x.tenant, x.sha256);
  return r.rowCount ?? 0;
}

/** An account is deleted: its archives and their rows go. */
export async function deleteTenantRuntimeArchives(tenant: string): Promise<number> {
  if (!db() || tenant === SHARED_SCOPE) return 0;
  const r = await db()!.query<{ sha256: string }>(`DELETE FROM runtime_archives WHERE tenant=$1 RETURNING sha256`, [tenant]);
  const scope = scopeSegment(tenant);
  if (scope) for (const x of r.rows) await blobStore().delete(blobKey(scope, x.sha256)).catch(() => {});
  return r.rowCount ?? 0;
}
