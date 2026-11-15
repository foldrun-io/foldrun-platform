// The small state that was files on the shared volume before it became rows
// (FOL-126, M7), copied into the database once, before the volume goes. Same
// rules as run-files-backfill.ts: a DRY RUN unless asked to write, idempotent
// (what a row already says is left), never deletes, and one account at a time.
//
// Nothing copied these files when the switches went on: every reader looks at
// the rows AND the file and keeps the newer, so nothing was lost while the
// volume stayed — and everything written before the switch is lost with it.
// What is copied, and where it lived:
//
//   platform_marks   unsettled/<run>.json (a charge still owed), .accrued,
//                    .paused-notices.json, .runtime-status.json
//   workspace_docs   hooks.json (webhook generations), evals/.results/<eval>.json,
//                    evals/.results/grades/<eval>.state.json, ../.<ws>.deployed
//   workspace_logs   hook-deliveries.jsonl, evals/.results/history.jsonl,
//                    evals/.results/grades/<eval>.jsonl
//   run_step_state   runs/<id>/sandbox/<ref>[.base].json, runs/<id>/storage-baseline.json
//                    — only for a run still open: a finished run never reads them
//
// NOT copied, on purpose: avatars (importAvatarFiles, in run-files-backfill),
// the audit-prune day (install-wide, redone once), assistant end events
// (minutes of life), diverted test-mode files (bytes, not state), and the
// legacy captured-call rows (their own backfill).
//
// A workspace whose records are still files (routing) is skipped and named:
// its readers do not look at rows, so a row would help nobody yet.
//
// Safe by construction: names come from the folder listing and are checked
// again; every file is opened without following a link and read up to a
// limit (a larger one is named, not loaded); a log is streamed, never held.
// A log is copied only when the rows it already has are all lines of the
// file (a first pass, or one that stopped half way): rows written since the
// switch would end up before the older lines, and the readers' order, the
// refusal fold and the newest-N trim all go by row order. Those logs are
// named, with how many lines are missing, and left to a person.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { accountDir, assertSafeName, listTenants, listWorkspaces, readRun, workspaceDir } from "../../foldrun-core/src/store.ts";
import { records } from "../../foldrun-core/src/records.ts";
import type { DocsPort } from "../../foldrun-core/src/records.ts";
import { markGet, markInsert, marksInDatabase, type MarkKind } from "./marks.ts";

export interface Tally {
  copied: number;
  present: number;
  skipped: number;
  failed: number;
}

export interface StateBackfillReport {
  write: boolean;
  /** Per kind, e.g. "marks:unsettled", "docs:hook", "logs:hook-delivery", "steps:base". */
  kinds: Record<string, Tally>;
  /** Why something was left, by name (the first 200). */
  notes: string[];
  notesDropped: number;
  failures: string[];
}

const MAX_SMALL = 1024 * 1024; // a state file is tiny; a bigger one is named, not loaded
const MAX_LOG_FILE = 256 * 1024 * 1024;
const MAX_LINE = 256 * 1024;
const TEN_YEARS_MS = 315_360_000_000;
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/; // core's SAFE_NAME
const STEP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/; // step-state.ts
const MARK_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,200}$/;

// What the readers in core use. Kept in step by tests/state-backfill-pg.test.ts,
// which reads every copied thing back through core's own readers.
const KEEP_DELIVERIES = 500;
const KEEP_EVAL_HISTORY = 5000;
const ALL_GRADE_ROWS = 100_000;

type Plain = Record<string, unknown>;
const isObj = (v: unknown): v is Plain => !!v && typeof v === "object" && !Array.isArray(v);

/** JSON with sorted keys: a stored jsonb and the file's text compare equal. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}
const fingerprint = (v: unknown): string => crypto.createHash("sha1").update(canon(v)).digest("hex").slice(0, 16);

/** A regular file opened without following a link: its descriptor, null when
 *  it is not there, or the reason it was not taken. */
function openPlain(file: string, max: number): { fd: number; size: number } | null | { skip: string } {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    return { skip: `unreadable (${(err as Error).message})` };
  }
  if (!st.isFile()) return { skip: "not a regular file (a link or a folder)" };
  if (st.size > max) return { skip: `larger than ${Math.round(max / 1048576)} MiB` };
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const real = fs.fstatSync(fd);
    if (!real.isFile() || real.size > max) {
      fs.closeSync(fd);
      return { skip: "changed while it was opened" };
    }
    return { fd, size: real.size };
  } catch (err) {
    return { skip: `unreadable (${(err as Error).message})` };
  }
}

/** A small JSON file: the value, null when absent, or the reason it was left. */
function readJson(file: string): { value: unknown } | null | { skip: string } {
  const o = openPlain(file, MAX_SMALL);
  if (!o || "skip" in o) return o;
  try {
    const buf = Buffer.alloc(o.size);
    let got = 0;
    while (got < o.size) {
      const n = fs.readSync(o.fd, buf, got, o.size - got, got);
      if (n === 0) break;
      got += n;
    }
    return { value: JSON.parse(buf.subarray(0, got).toString("utf8")) };
  } catch {
    return { skip: "not valid JSON" };
  } finally {
    fs.closeSync(o.fd);
  }
}

/** A text file's lines, one at a time (never the whole file). A line past
 *  MAX_LINE comes out as null: it is counted, not loaded. */
async function* lineStream(fd: number): AsyncGenerator<string | null> {
  const chunk = Buffer.alloc(64 * 1024);
  let acc: Buffer[] = [];
  let accLen = 0;
  let over = false;
  let pos = 0;
  for (;;) {
    const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
    if (n === 0) break;
    pos += n;
    let from = 0;
    for (let i = 0; i < n; i++) {
      if (chunk[i] !== 0x0a) continue;
      const part = chunk.subarray(from, i);
      if (!over && accLen + part.length <= MAX_LINE) {
        yield Buffer.concat([...acc, part]).toString("utf8");
      } else yield null;
      acc = [];
      accLen = 0;
      over = false;
      from = i + 1;
    }
    const rest = chunk.subarray(from, n);
    if (!over) {
      accLen += rest.length;
      if (accLen > MAX_LINE) {
        over = true;
        acc = [];
      } else acc.push(Buffer.from(rest));
    }
  }
  if (over) yield null;
  else if (accLen) yield Buffer.concat(acc).toString("utf8");
}

export async function backfillState(opts: { write: boolean; tenants?: string[] }): Promise<StateBackfillReport> {
  const r: StateBackfillReport = { write: opts.write, kinds: {}, notes: [], notesDropped: 0, failures: [] };
  const tally = (k: string): Tally => (r.kinds[k] ??= { copied: 0, present: 0, skipped: 0, failed: 0 });
  const note = (k: string, why: string, n = 1) => {
    tally(k).skipped += n;
    if (r.notes.length < 200) r.notes.push(`${k}: ${why}`);
    else r.notesDropped++;
  };
  const fail = (k: string, where: string, err: unknown) => {
    tally(k).failed++;
    if (r.failures.length < 200) r.failures.push(`${k} ${where}: ${err instanceof Error ? err.message : String(err)}`);
  };
  if (!marksInDatabase()) throw new Error("this needs the database: nothing would be copied");

  // ---- a mark: set where there is none; a row already there is the newer word
  const mark = (tenant: string, kind: MarkKind, key: string, data: unknown, where: string) => {
    const k = `marks:${kind}`;
    try {
      if (markGet(tenant, kind, key) !== undefined) return void tally(k).present++;
      if (opts.write && !markInsert(tenant, kind, key, data)) return void tally(k).present++; // made meanwhile
      tally(k).copied++;
    } catch (err) {
      fail(k, where, err);
    }
  };

  const accountMarks = (tenant: string) => {
    const acct = accountDir(tenant);
    // Charges still owed: the only mark that is money.
    const udir = path.join(acct, "unsettled");
    let names: string[] = [];
    try {
      names = fs.readdirSync(udir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") fail("marks:unsettled", `${tenant}/unsettled`, err);
    }
    for (const name of names) {
      const id = name.replace(/\.json$/, "");
      const where = `${tenant}/unsettled/${name}`;
      if (!name.endsWith(".json") || !STEP_ID.test(id)) {
        note("marks:unsettled", `${where}: not a run marker name`);
        continue;
      }
      const f = readJson(path.join(udir, name));
      if (!f || "skip" in f) {
        // A torn marker is still re-driven by name while the volume is there; it cannot be a row.
        note("marks:unsettled", `${where}: ${f ? f.skip : "gone"}`);
        continue;
      }
      const v = f.value;
      if (!isObj(v) || (v.tenant !== undefined && v.tenant !== tenant) || (v.runId !== undefined && v.runId !== id)) {
        note("marks:unsettled", `${where}: names another account or run`);
        continue;
      }
      mark(tenant, "unsettled", id, v, where);
    }
    // The day the daily lines were last written.
    const day = openPlain(path.join(acct, ".accrued"), 64);
    if (day && "skip" in day) note("marks:accrued", `${tenant}/.accrued: ${day.skip}`);
    else if (day) {
      try {
        const text = fs.readFileSync(day.fd, "utf8").trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(text)) mark(tenant, "accrued", "", { day: text }, `${tenant}/.accrued`);
        else note("marks:accrued", `${tenant}/.accrued: not a day`);
      } finally {
        fs.closeSync(day.fd);
      }
    }
    // Pause notices told: one per flow.
    for (const [file, kind, keyOk] of [
      [".paused-notices.json", "pause-notice", (k: string, v: unknown) => /^[a-z0-9-]+\/[a-z0-9-]+$/.test(k) && typeof v === "string"],
      [".runtime-status.json", "runtime-status", (k: string, v: unknown) => MARK_KEY.test(k) && isObj(v)],
    ] as const) {
      const f = readJson(path.join(acct, file));
      if (!f) continue;
      if ("skip" in f) {
        note(`marks:${kind}`, `${tenant}/${file}: ${f.skip}`);
        continue;
      }
      if (!isObj(f.value)) {
        note(`marks:${kind}`, `${tenant}/${file}: not an object`);
        continue;
      }
      for (const [k, v] of Object.entries(f.value)) {
        if (!keyOk(k, v)) note(`marks:${kind}`, `${tenant}/${file}: entry "${k.slice(0, 60)}" is not one this release writes`);
        else mark(tenant, kind, k, kind === "pause-notice" ? { runId: v } : v, `${tenant}/${file}`);
      }
    }
  };

  // ---- a document: set where there is none; where there is, only forward
  const doc = (port: DocsPort, tenant: string, ws: string, kind: string, key: string, value: Plain, newer: (row: Plain) => (() => void) | null) => {
    const k = `docs:${kind}`;
    const where = `${tenant}/${ws}/${key}`;
    try {
      const row = port.get(tenant, ws, kind, key);
      if (row === undefined) {
        // claim, with a stale time no row ever reaches: takes the key only while it is empty.
        if (opts.write && !port.claim(tenant, ws, kind, key, value, TEN_YEARS_MS)) return void tally(k).present++;
        return void tally(k).copied++;
      }
      if (canon(row) === canon(value) || !isObj(row)) return void tally(k).present++;
      const move = newer(row);
      if (!move) return void tally(k).present++;
      if (opts.write) move();
      tally(k).copied++;
    } catch (err) {
      fail(k, where, err);
    }
  };

  const readDoc = (k: string, file: string, where: string): Plain | null => {
    const f = readJson(file);
    if (!f) return null;
    if ("skip" in f) return void note(k, `${where}: ${f.skip}`), null;
    if (!isObj(f.value)) return void note(k, `${where}: not an object`), null;
    return f.value;
  };

  // ---- a log: appended in file order, only onto an empty or file-made log
  const log = async (port: DocsPort, tenant: string, ws: string, kind: string, file: string, keep: number) => {
    const k = `logs:${kind.replace(/:.*/, "")}`;
    const where = `${tenant}/${ws}/${path.basename(file)}`;
    const cap = keep > 0 ? keep : ALL_GRADE_ROWS;
    const o = openPlain(file, MAX_LOG_FILE);
    if (!o) return;
    if ("skip" in o) return note(k, `${where}: ${o.skip}`);
    try {
      // Pass 1: which lines the file has (a 64-bit fingerprint each).
      const fileSet = new Set<string>();
      let total = 0;
      for await (const line of lineStream(o.fd)) {
        if (line === null) {
          note(k, `${where}: a line over ${MAX_LINE / 1024} KiB was left`);
          continue;
        }
        if (!line.trim()) continue;
        try {
          fileSet.add(fingerprint(JSON.parse(line)));
          total++;
        } catch {
          note(k, `${where}: a torn line was left`);
        }
      }
      const rowSet = new Set(port.tail(tenant, ws, kind, cap).map((x) => fingerprint(x.data)));
      const foreign = [...rowSet].filter((h) => !fileSet.has(h)).length;
      if (foreign) {
        note(k, `${where}: ${rowSet.size} row(s) already there, ${foreign} not in the file (written since the switch) — a log is never copied under newer rows`, [...fileSet].filter((h) => !rowSet.has(h)).length || 1);
        return;
      }
      // Pass 2: the newest `cap` lines, in file order, those the rows lack.
      let seen = 0;
      for await (const line of lineStream(o.fd)) {
        if (line === null || !line.trim()) continue;
        let v: unknown;
        try {
          v = JSON.parse(line);
        } catch {
          continue;
        }
        if (seen++ < total - cap) continue;
        if (rowSet.has(fingerprint(v))) {
          tally(k).present++;
          continue;
        }
        // keep 0: the trim to the newest N belongs to the next ordinary write.
        if (opts.write) port.append(tenant, ws, kind, v, 0);
        tally(k).copied++;
      }
    } catch (err) {
      fail(k, where, err);
    } finally {
      fs.closeSync(o.fd);
    }
  };

  const workspaceState = async (tenant: string, ws: string) => {
    const port = records(tenant, ws);
    const docs = port?.docs;
    if (!port || !docs) return void note("workspaces", `${tenant}/${ws}: its records are still files; nothing to copy yet`);
    const root = workspaceDir(tenant, ws);
    const results = path.join(root, "evals", ".results");

    // Webhook generations: forward only (a lower one would let an old URL back in).
    const hooks = readDoc("docs:hook", path.join(root, "hooks.json"), `${tenant}/${ws}/hooks.json`);
    for (const [flow, v] of Object.entries(hooks ?? {})) {
      if (!NAME.test(flow) || !isObj(v) || !Number.isInteger(v.gen) || (v.gen as number) < 0) {
        note("docs:hook", `${tenant}/${ws}/hooks.json: entry "${flow.slice(0, 60)}" is not one this release writes`);
        continue;
      }
      doc(docs, tenant, ws, "hook", flow, v, (row) => ((v.gen as number) > Number(row.gen ?? 0) ? () => void docs.raise(tenant, ws, "hook", flow, "gen", v.gen as number, typeof v.rotatedAt === "string" ? { rotatedAt: v.rotatedAt } : {}) : null));
    }

    // The deployed commit: the later deploy is the one running.
    const dep = readDoc("docs:deployed", path.join(root, "..", `.${ws}.deployed`), `${tenant}/.${ws}.deployed`);
    if (dep && typeof dep.commit === "string" && typeof dep.at === "string") {
      doc(docs, tenant, ws, "deployed", "commit", dep, (row) => (String(dep.at) > String(row.at) ? () => docs.put(tenant, ws, "deployed", "commit", dep) : null));
    } else if (dep) note("docs:deployed", `${tenant}/.${ws}.deployed: not a commit and a time`);

    // Eval results, grader cursors; the names are the folder's.
    let names: string[] = [];
    try {
      names = fs.readdirSync(results);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" && (err as NodeJS.ErrnoException).code !== "ENOTDIR") fail("docs:eval-result", `${tenant}/${ws}/evals/.results`, err);
    }
    for (const n of names) {
      const m = /^(.+)\.json$/.exec(n);
      if (!m || !NAME.test(m[1])) continue; // history.jsonl, grades/, .evaluating: not a result
      const v = readDoc("docs:eval-result", path.join(results, n), `${tenant}/${ws}/evals/.results/${n}`);
      if (!v) continue;
      if (typeof v.finishedAt !== "string") {
        note("docs:eval-result", `${tenant}/${ws}/${n}: no finish time`);
        continue;
      }
      doc(docs, tenant, ws, "eval-result", m[1], v, (row) => (String(v.finishedAt) > String(row.finishedAt) ? () => docs.put(tenant, ws, "eval-result", m[1], v) : null));
    }
    await log(docs, tenant, ws, "eval-history", path.join(results, "history.jsonl"), KEEP_EVAL_HISTORY);
    await log(docs, tenant, ws, "hook-delivery", path.join(root, "hook-deliveries.jsonl"), KEEP_DELIVERIES);

    const gdir = path.join(results, "grades");
    let gnames: string[] = [];
    try {
      gnames = fs.readdirSync(gdir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" && (err as NodeJS.ErrnoException).code !== "ENOTDIR") fail("logs:grades", `${tenant}/${ws}/grades`, err);
    }
    for (const n of gnames) {
      const m = /^(.+?)(\.state\.json|\.jsonl)$/.exec(n);
      if (!m || !NAME.test(m[1])) continue;
      if (m[2] === ".jsonl") {
        await log(docs, tenant, ws, `grades:${m[1]}`, path.join(gdir, n), 0);
        continue;
      }
      const v = readDoc("docs:grader", path.join(gdir, n), `${tenant}/${ws}/grades/${n}`);
      if (!v) continue;
      // The earliest first sight and the latest serving, as graderState reads them.
      doc(docs, tenant, ws, "grader", m[1], v, (row) => {
        const patch: Plain = {};
        if (typeof v.since === "string" && (typeof row.since !== "string" || v.since < row.since)) patch.since = v.since;
        if (typeof v.lastServed === "string" && (typeof row.lastServed !== "string" || v.lastServed > row.lastServed)) patch.lastServed = v.lastServed;
        return Object.keys(patch).length ? () => docs.merge(tenant, ws, "grader", m[1], patch) : null;
      });
    }

    // Step state of the runs still open.
    const a = port.async;
    if (!a?.stepGet || !a.stepPut) return;
    const runsDir = path.join(root, "runs");
    let ids: string[] = [];
    try {
      ids = fs.readdirSync(runsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") fail("steps", `${tenant}/${ws}/runs`, err);
    }
    for (const id of ids) {
      if (!STEP_ID.test(id)) continue;
      const rdir = path.join(runsDir, id);
      try {
        if (!fs.lstatSync(rdir).isDirectory()) continue;
      } catch {
        continue;
      }
      const items: { kind: "handed-in" | "base" | "storage"; ref: string; file: string }[] = [];
      try {
        for (const n of fs.readdirSync(path.join(rdir, "sandbox"))) {
          const m = /^(.+?)(\.base)?\.json$/.exec(n);
          if (m && STEP_ID.test(m[1])) items.push({ kind: m[2] ? "base" : "handed-in", ref: m[1], file: path.join(rdir, "sandbox", n) });
        }
      } catch {
        /* no sandbox folder */
      }
      items.push({ kind: "storage", ref: "", file: path.join(rdir, "storage-baseline.json") });
      let open: boolean | null = null; // asked once, and only when there is something to copy
      for (const it of items) {
        const k = `steps:${it.kind}`;
        const where = `${tenant}/${ws}/${id}/${it.ref || "storage-baseline"}`;
        const f = readJson(it.file);
        if (!f) continue;
        if ("skip" in f) {
          note(k, `${where}: ${f.skip}`);
          continue;
        }
        const ok = it.kind === "base" ? isObj(f.value) && (f.value.workspace === null || typeof f.value.workspace === "string") && (f.value.state === null || typeof f.value.state === "string") : isObj(f.value) && Object.values(f.value).every((x) => typeof x === "string");
        if (!ok) {
          note(k, `${where}: not the shape this release writes`);
          continue;
        }
        try {
          open ??= ["queued", "running", "awaiting-approval"].includes(readRun(tenant, ws, id)?.status ?? "");
          if (!open) {
            note(k, `${where}: the run is finished or has no record; it never reads this`);
            continue;
          }
          const row = await a.stepGet(tenant, ws, id, it.kind, it.ref);
          if (row !== undefined) {
            if (canon(row) !== canon(f.value)) note(k, `${where}: a row already says something else; the row is read first, so it is kept`);
            else tally(k).present++;
            continue;
          }
          if (opts.write) await a.stepPut(tenant, ws, id, it.kind, it.ref, f.value);
          tally(k).copied++;
        } catch (err) {
          fail(k, where, err);
        }
      }
    }
  };

  for (const tenant of opts.tenants ?? listTenants()) {
    try {
      assertSafeName(tenant, "tenant");
      accountMarks(tenant);
      for (const ws of listWorkspaces(tenant)) {
        try {
          await workspaceState(tenant, ws.name);
        } catch (err) {
          fail("workspaces", `${tenant}/${ws.name}`, err);
        }
      }
    } catch (err) {
      fail("accounts", tenant, err);
    }
  }
  return r;
}
