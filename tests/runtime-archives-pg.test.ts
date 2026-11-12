// The runtime cache in the object store (src/runtime-archives.ts) against a
// real database, the file blob store, and a kubectl that runs the pod's
// shell here, in temp directories standing for the pod's fixed paths.
//
//   FOLDRUN_TEST_DATABASE_URL=postgres://foldrun@localhost:55432/foldrun npm test

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { takeTurnsOnLiveDb } from "./live-db-lock.ts";

const url = process.env.FOLDRUN_TEST_DATABASE_URL;
takeTurnsOnLiveDb(url);

if (!url) {
  test("runtime archives (set FOLDRUN_TEST_DATABASE_URL to run)", { skip: "set FOLDRUN_TEST_DATABASE_URL to run against Postgres" }, () => {});
} else {
  const u = new URL(url);
  process.env.FOLDRUN_DATABASE_URL = `${u.protocol}//${u.username}@${u.host}${u.pathname}`;
  process.env.FOLDRUN_DATABASE_PASSWORD = u.password;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-rta-"));
  process.env.FOLDRUN_DATA = path.join(root, "data");
  // kubectl exec [-i] -n ns pod -- sh -c CMD → run CMD here.
  const stub = path.join(root, "kubectl");
  fs.writeFileSync(stub, `#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done; shift; exec "$@"\n`, { mode: 0o755 });
  process.env.FOLDRUN_KUBECTL = stub;

  before(async () => {
    const { migrate } = await import("../src/db.ts");
    await migrate();
  });
  after(async () => {
    const { db } = await import("../src/db.ts");
    await db()?.end();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const mod = () => import("../src/runtime-archives.ts");
  const IMAGE = "ghcr.io/foldrun-io/runner-slim:v1";
  const spec = (pkgs: string[], system?: string[]) => ({ packages: pkgs, npm: [] as string[], ...(system ? { system } : {}) });
  let n = 0;
  const tenant = () => `rta${Date.now().toString(36)}${(n++).toString(36)}`;
  /** A "pod": its own cache and shared directories. */
  const pod = () => {
    const dir = fs.mkdtempSync(path.join(root, "pod-"));
    const place = { ns: "x", pod: "p", cacheDir: path.join(dir, "cache"), sharedDir: path.join(dir, "shared"), asAgent: "", systemStatus: path.join(dir, "system-install.json") };
    fs.mkdirSync(place.cacheDir, { recursive: true });
    fs.mkdirSync(place.sharedDir, { recursive: true });
    return place;
  };
  const build = (dir: string, fp: string, body: string) => {
    const e = path.join(dir, fp);
    fs.mkdirSync(path.join(e, "venv", "bin"), { recursive: true });
    fs.writeFileSync(path.join(e, "venv", "bin", "python"), body);
    fs.symlinkSync("python", path.join(e, "venv", "bin", "python3"));
    fs.writeFileSync(path.join(e, ".ready"), "");
    return e;
  };
  const rows = async (t: string) => {
    const { db } = await import("../src/db.ts");
    return (await db()!.query(`SELECT kind, ref, sha256 FROM runtime_archives WHERE tenant=$1 ORDER BY kind, ref`, [t])).rows as { kind: string; ref: string; sha256: string }[];
  };

  test("an entry a step built is kept, and unpacked into the next pod as it was", async () => {
    const m = await mod();
    const { fingerprint } = await import("../../foldrun-core/src/runtime.ts");
    const T = tenant();
    const s = spec(["requests"]);
    const fp = fingerprint(s);
    const a = pod();
    const st = await m.restoreRuntime({ tenant: T, spec: s, image: IMAGE, place: a });
    assert.equal(st.env, null);
    assert.equal(st.fp, fp);
    build(a.cacheDir, fp, "one");
    const kept = await m.saveRuntime({ tenant: T, spec: s, state: st, place: a });
    assert.match(kept.join("\n"), /kept for the next step/);
    assert.equal((await rows(T)).length, 1);

    const b = pod();
    const st2 = await m.restoreRuntime({ tenant: T, spec: s, image: IMAGE, place: b });
    assert.equal(st2.env, "account");
    assert.equal(fs.readFileSync(path.join(b.cacheDir, fp, "venv/bin/python"), "utf8"), "one");
    assert.equal(fs.readlinkSync(path.join(b.cacheDir, fp, "venv/bin/python3")), "python");
    assert.ok(fs.existsSync(path.join(b.cacheDir, fp, ".ready")));
    assert.equal(fs.readFileSync(path.join(b.cacheDir, fp, ".from-store"), "utf8"), (await rows(T))[0]!.sha256);
    // Used as it was: nothing is packed again.
    assert.deepEqual(await m.saveRuntime({ tenant: T, spec: s, state: st2, place: b }), []);
  });

  test("a rebuild replaces the archive and the old bytes go", async () => {
    const m = await mod();
    const { fingerprint } = await import("../../foldrun-core/src/runtime.ts");
    const { blobStore } = await import("../../foldrun-core/src/blob-store.ts");
    const T = tenant();
    const s = spec(["pandas"]);
    const fp = fingerprint(s);
    const a = pod();
    const st = await m.restoreRuntime({ tenant: T, spec: s, image: IMAGE, place: a });
    build(a.cacheDir, fp, "old");
    await m.saveRuntime({ tenant: T, spec: s, state: st, place: a });
    const first = (await rows(T))[0]!.sha256;
    const b = pod();
    const st2 = await m.restoreRuntime({ tenant: T, spec: s, image: IMAGE, place: b });
    // core's rebuild: the leftovers go, the marker with them.
    fs.rmSync(path.join(b.cacheDir, fp), { recursive: true });
    build(b.cacheDir, fp, "new");
    assert.match((await m.saveRuntime({ tenant: T, spec: s, state: st2, place: b })).join("\n"), /kept/);
    const second = (await rows(T))[0]!.sha256;
    assert.notEqual(second, first);
    assert.equal(await blobStore().head(`runtimes/${T}/${first}.tgz`), null);
    assert.ok(await blobStore().head(`runtimes/${T}/${second}.tgz`));
  });

  test("one account never gets another's; a different image family or arch gets none", async () => {
    const m = await mod();
    const { fingerprint } = await import("../../foldrun-core/src/runtime.ts");
    const A = tenant(), B = tenant();
    const s = spec(["numpy"]);
    const a = pod();
    const st = await m.restoreRuntime({ tenant: A, spec: s, image: IMAGE, place: a });
    build(a.cacheDir, fingerprint(s), "a");
    await m.saveRuntime({ tenant: A, spec: s, state: st, place: a });
    assert.equal((await m.restoreRuntime({ tenant: B, spec: s, image: IMAGE, place: pod() })).env, null);
    assert.equal((await m.restoreRuntime({ tenant: A, spec: s, image: "ghcr.io/foldrun-io/runner-full:v1", place: pod() })).env, null);
    // A new tag of the same family is the same variant.
    assert.equal((await m.restoreRuntime({ tenant: A, spec: s, image: "ghcr.io/foldrun-io/runner-slim:v2", place: pod() })).env, "account");
    assert.equal(m.variantOf("r/x:v1", "x64"), m.variantOf("r/x@sha256:" + "a".repeat(64), "x64"));
    assert.notEqual(m.variantOf("r/x:v1", "x64"), m.variantOf("r/x:v1", "arm64"));
    assert.equal(m.variantOf("host:5000/r/x", "x64"), m.variantOf("host:5000/r/x:v9", "x64"));
  });

  test("the shared layer: a warm build serves every account, root-owned beside the account's own", async () => {
    const m = await mod();
    const { fingerprint } = await import("../../foldrun-core/src/runtime.ts");
    const s = spec([`shared-${Date.now().toString(36)}`]);
    const fp = fingerprint(s);
    const T = tenant();
    const warm = pod();
    build(warm.sharedDir, fp, "shared");
    const kept = await m.saveRuntime({ tenant: T, scope: m.SHARED_SCOPE, spec: s, state: { variant: m.variantOf(IMAGE), fp, env: null, sysGens: [], lines: [] }, place: warm });
    assert.match(kept.join("\n"), /kept/);
    assert.equal(await m.archivedEnv(tenant(), IMAGE, fp), true);
    const other = tenant();
    const b = pod();
    const st = await m.restoreRuntime({ tenant: other, spec: s, image: IMAGE, place: b });
    assert.equal(st.env, "shared");
    assert.equal(fs.readFileSync(path.join(b.sharedDir, fp, "venv/bin/python"), "utf8"), "shared");
    assert.ok(!fs.existsSync(path.join(b.cacheDir, fp)));
    // The shared layer switched off: the pod would not read it, so it is not unpacked.
    assert.equal((await m.restoreRuntime({ tenant: other, spec: s, image: IMAGE, place: pod(), shared: false })).env, null);
    // The shared entry did not pass in the pod and the account built its own:
    // its own is kept and the shared row goes.
    build(b.cacheDir, fp, "own");
    assert.match((await m.saveRuntime({ tenant: other, spec: s, state: st, place: b })).join("\n"), /kept/);
    const c = pod();
    assert.equal((await m.restoreRuntime({ tenant: other, spec: s, image: IMAGE, place: c })).env, "account");
    assert.equal((await rows("")).filter((r) => r.ref === fp).length, 0);
  });

  test("bytes that do not match the row are never unpacked", async () => {
    const m = await mod();
    const { fingerprint } = await import("../../foldrun-core/src/runtime.ts");
    const T = tenant();
    const s = spec(["scipy"]);
    const fp = fingerprint(s);
    const a = pod();
    const st = await m.restoreRuntime({ tenant: T, spec: s, image: IMAGE, place: a });
    build(a.cacheDir, fp, "good");
    await m.saveRuntime({ tenant: T, spec: s, state: st, place: a });
    // Point the row at another archive's bytes: same store, wrong hash.
    const sha = (await rows(T))[0]!.sha256;
    const objects = path.join(process.env.FOLDRUN_DATA!, ".objects");
    const found: string[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (f.includes(sha)) found.push(f); } };
    walk(objects);
    assert.equal(found.length, 1);
    fs.writeFileSync(found[0]!, "not the archive");
    const b = pod();
    assert.equal((await m.restoreRuntime({ tenant: T, spec: s, image: IMAGE, place: b })).env, null);
    assert.ok(!fs.existsSync(path.join(b.cacheDir, fp)));
  });

  test("a sealed system snapshot the start-up made is kept under its package set, once", async () => {
    const m = await mod();
    const T = tenant();
    const s = spec([], ["ffmpeg", "libcairo2-dev"]);
    const a = pod();
    const st = await m.restoreRuntime({ tenant: T, spec: s, image: IMAGE, place: a });
    assert.equal(st.fp, null);
    assert.deepEqual(st.sysGens, []);
    const key = "v5-" + "1".repeat(16), gen = "2".repeat(16);
    const g = path.join(a.cacheDir, ".system-snapshots", key, gen);
    fs.mkdirSync(g, { recursive: true });
    fs.writeFileSync(path.join(g, "snap.tar"), "tar bytes");
    fs.writeFileSync(path.join(g, "seal"), "v5 1 abc mac\n");
    fs.writeFileSync(path.join(g, "base"), "base\n");
    // Another key's generation (an install mid-step) is not this spec's.
    const other = path.join(a.cacheDir, ".system-snapshots", "v5-" + "9".repeat(16), "3".repeat(16));
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, "seal"), "x");
    fs.writeFileSync(a.systemStatus, JSON.stringify({ ok: true, mode: "apt", key }));
    assert.match((await m.saveRuntime({ tenant: T, spec: s, state: st, place: a })).join("\n"), /system packages kept/);
    assert.deepEqual((await rows(T)).map((r) => r.kind), ["sys"]);

    const b = pod();
    const st2 = await m.restoreRuntime({ tenant: T, spec: s, image: IMAGE, place: b });
    assert.deepEqual(st2.sysGens, [`${key}/${gen}`]);
    assert.equal(fs.readFileSync(path.join(b.cacheDir, ".system-snapshots", key, gen, "snap.tar"), "utf8"), "tar bytes");
    assert.ok(!fs.existsSync(path.join(b.cacheDir, ".system-snapshots", "v5-" + "9".repeat(16))));
    // Restored from the snapshot: nothing new to keep.
    fs.writeFileSync(b.systemStatus, JSON.stringify({ ok: true, mode: "snapshot", key }));
    assert.deepEqual(await m.saveRuntime({ tenant: T, spec: s, state: st2, place: b }), []);
    // A status file the step rewrote names no path of ours.
    fs.writeFileSync(b.systemStatus, JSON.stringify({ ok: true, mode: "apt", key: "../../etc" }));
    assert.deepEqual(await m.saveRuntime({ tenant: T, spec: s, state: { ...st2, sysGens: [] }, place: b }), []);
  });

  test("an archive over the limit is not kept, and the step is told", async () => {
    const m = await mod();
    const { fingerprint } = await import("../../foldrun-core/src/runtime.ts");
    const T = tenant();
    const s = spec(["torch"]);
    const a = pod();
    const st = await m.restoreRuntime({ tenant: T, spec: s, image: IMAGE, place: a });
    build(a.cacheDir, fingerprint(s), "x".repeat(4096));
    process.env.FOLDRUN_RUNTIME_ARCHIVE_MAX_BYTES = "20";
    try {
      assert.match((await m.saveRuntime({ tenant: T, spec: s, state: st, place: a })).join("\n"), /not kept \(larger than/);
    } finally {
      delete process.env.FOLDRUN_RUNTIME_ARCHIVE_MAX_BYTES;
    }
    assert.equal((await rows(T)).length, 0);
  });

  test("a kubectl that is not there is a save not made, not a crash", async () => {
    const m = await mod();
    const { fingerprint } = await import("../../foldrun-core/src/runtime.ts");
    const T = tenant();
    const s = spec(["httpx"]);
    const a = pod();
    const st = await m.restoreRuntime({ tenant: T, spec: s, image: IMAGE, place: a });
    build(a.cacheDir, fingerprint(s), "x");
    process.env.FOLDRUN_KUBECTL = path.join(root, "no-such-kubectl");
    try {
      assert.deepEqual(await m.saveRuntime({ tenant: T, spec: s, state: st, place: a }), []);
      assert.equal((await m.restoreRuntime({ tenant: T, spec: s, image: IMAGE, place: pod() })).env, null);
    } finally {
      process.env.FOLDRUN_KUBECTL = stub;
    }
  });

  test("a deleted account's archives go; unused ones expire", async () => {
    const m = await mod();
    const { fingerprint } = await import("../../foldrun-core/src/runtime.ts");
    const { blobStore } = await import("../../foldrun-core/src/blob-store.ts");
    const { db } = await import("../src/db.ts");
    const T = tenant(), U = tenant();
    const s = spec(["flask"]);
    for (const t of [T, U]) {
      const a = pod();
      const st = await m.restoreRuntime({ tenant: t, spec: s, image: IMAGE, place: a });
      build(a.cacheDir, fingerprint(s), t);
      await m.saveRuntime({ tenant: t, spec: s, state: st, place: a });
    }
    const shaT = (await rows(T))[0]!.sha256, shaU = (await rows(U))[0]!.sha256;
    assert.equal(await m.deleteTenantRuntimeArchives(T), 1);
    assert.equal(await blobStore().head(`runtimes/${T}/${shaT}.tgz`), null);
    await db()!.query(`UPDATE runtime_archives SET used_at = now() - interval '40 days' WHERE tenant=$1`, [U]);
    assert.ok((await m.expireRuntimeArchives()) >= 1);
    assert.equal((await rows(U)).length, 0);
    assert.equal(await blobStore().head(`runtimes/${U}/${shaU}.tgz`), null);
  });

  test("with the store on, a run pod and a warm pod mount no volume", async () => {
    process.env.FOLDRUN_RUN_RUNTIME_STORE = "1";
    process.env.FOLDRUN_RUNTIME_CACHE_PVC = "foldrun-runtime-cache";
    try {
      const m = await mod();
      assert.equal(m.runtimeStoreOn(), true);
      const { runPodManifest } = await import("../src/run-k8s.ts");
      const { warmPodManifest, WARM_EXIT } = await import("../src/runtime-warm.ts");
      type P = { spec: { volumes?: unknown[]; containers: { volumeMounts?: unknown[]; env?: { name: string }[]; command: string[] }[] } };
      const run = runPodManifest("p", IMAGE, "run-1", "small", 60, "acme") as P;
      assert.equal(run.spec.volumes, undefined);
      assert.equal(run.spec.containers[0]!.volumeMounts, undefined);
      assert.ok(run.spec.containers[0]!.env?.some((e) => e.name === "FOLDRUN_RUNTIME_SHARED"));
      const warm = warmPodManifest("w", IMAGE, "acme", { packages: ["requests"], npm: [] }) as P;
      assert.equal(warm.spec.volumes, undefined);
      assert.equal(warm.spec.containers[0]!.volumeMounts, undefined);
      assert.ok(warm.spec.containers[0]!.command.join(" ").includes(WARM_EXIT));
    } finally {
      delete process.env.FOLDRUN_RUN_RUNTIME_STORE;
      delete process.env.FOLDRUN_RUNTIME_CACHE_PVC;
    }
  });
}
