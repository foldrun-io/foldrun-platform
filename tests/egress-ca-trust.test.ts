// FOL-144: the egress CA in a run pod's system trust store, for the programs
// that read only that store (WebKit among them). Built by an init container
// from a platform-owned immutable ConfigMap and mounted read-only — root's
// start never reads a CA from the agent's job folder. Pure manifests here;
// the image half (update-ca-certificates, WebKit) was tried in the runner
// image on 8 Nov 2026 and is checked again on dev.
//
//   node --test tests/egress-ca-trust.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CA_TRUST_SCRIPT, egressCaConfigMap, egressCaConfigMapName, egressCaPemOf, ensureEgressCaConfigMap, STORE_VOLUME, SYSTEM_CERTS, withSystemCaTrust } from "../src/egress-ca-trust.ts";
import { egressCaPem, leafFor } from "../src/egress-ca.ts";
import { runPodManifest } from "../src/run-k8s.ts";
import { GALLERY } from "../src/gallery.ts";

process.env.FOLDRUN_SECRET_KEY ??= "egress-ca-trust-test-key";
const b64 = (s: string) => Buffer.from(s).toString("base64");

test("the CA a step's env carries: one CA certificate, or nothing", () => {
  const ca = egressCaPem();
  assert.equal(egressCaPemOf({ FOLDRUN_EGRESS_CA: b64(ca) }), ca);
  assert.equal(egressCaPemOf({}), null, "a step without the CA gets no init container");
  assert.equal(egressCaPemOf({ FOLDRUN_EGRESS_CA: b64(leafFor("api.example.com").cert) }), null, "a leaf is not a CA");
  assert.equal(egressCaPemOf({ FOLDRUN_EGRESS_CA: b64("not a certificate") }), null);
});

test("its ConfigMap: named by the CA's key and subject, immutable, in the run namespace, the PEM alone", () => {
  const ca = egressCaPem();
  const cm = egressCaConfigMap(ca) as { metadata: { name: string; namespace: string; labels: Record<string, string> }; immutable: boolean; data: Record<string, string> };
  assert.match(cm.metadata.name, /^foldrun-egress-ca-[0-9a-f]{12}$/);
  assert.equal(cm.metadata.name, egressCaConfigMapName(ca));
  // The certificate is signed again in every process (random ECDSA
  // signatures): another copy of the same CA must name the same object.
  const again = egressCaPem().replace(/\n+$/, "") + "\n\n";
  assert.equal(egressCaConfigMapName(again), egressCaConfigMapName(ca), "same key and subject, same object");
  assert.notEqual(egressCaConfigMapName(leafFor("other.example.com").cert), egressCaConfigMapName(ca), "another key is another object");
  assert.equal(cm.immutable, true);
  assert.equal(cm.metadata.namespace, "foldrun-runs");
  assert.deepEqual(Object.keys(cm.data), ["ca.pem"]);
  assert.equal(cm.data["ca.pem"], ca);
});

type Pod = {
  spec: {
    volumes?: { name: string; configMap?: { name: string }; emptyDir?: object; persistentVolumeClaim?: object }[];
    initContainers?: { name: string; image: string; command: string[]; securityContext: Record<string, unknown>; volumeMounts: { name: string; mountPath: string; readOnly?: boolean }[] }[];
    containers: { name: string; image: string; volumeMounts?: { name: string; mountPath: string; readOnly?: boolean }[] }[];
  };
};

test("the pod: an init container builds the store, the runner mounts it at /etc/ssl/certs, root's to change", () => {
  const base = runPodManifest("run-x", "ghcr.io/foldrun-io/runner@sha256:abc", "run-1", "large", undefined, "acme") as Pod;
  const before = JSON.stringify(base);
  const pod = withSystemCaTrust(base, "foldrun-egress-ca-0123456789ab") as Pod;
  assert.equal(JSON.stringify(base), before, "pure: the pod it was given is unchanged");

  const cmVol = pod.spec.volumes!.find((v) => v.configMap);
  assert.equal(cmVol?.configMap?.name, "foldrun-egress-ca-0123456789ab");
  assert.ok(pod.spec.volumes!.find((v) => v.name === STORE_VOLUME && v.emptyDir));

  const init = pod.spec.initContainers!.find((c) => c.name === "egress-ca")!;
  assert.equal(init.image, "ghcr.io/foldrun-io/runner@sha256:abc", "the same image: its own update-ca-certificates and system store");
  assert.deepEqual(init.command, ["sh", "-c", CA_TRUST_SCRIPT]);
  assert.equal(init.securityContext.runAsUser, 0);
  assert.equal(init.securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(init.securityContext.capabilities, { drop: ["ALL"] }, "root with no capabilities: it writes only root-owned files and the emptyDir");
  assert.ok(init.volumeMounts.find((m) => m.mountPath === "/foldrun-ca" && m.readOnly));

  const runner = pod.spec.containers.find((c) => c.name === "runner")!;
  const mount = runner.volumeMounts!.find((m) => m.mountPath === SYSTEM_CERTS)!;
  assert.equal(mount.name, STORE_VOLUME);
  // Root-owned, not a read-only mount: the agent cannot write it (the init
  // script's chmod), and root's apt can still regenerate it (Codex review).
  assert.notEqual(mount.readOnly, true);
});

test("the pod keeps what it had: the runtime cache volume and mounts stay", () => {
  const prev = process.env.FOLDRUN_RUNTIME_CACHE_PVC;
  process.env.FOLDRUN_RUNTIME_CACHE_PVC = "foldrun-runtimes";
  try {
    const base = runPodManifest("run-y", "img", "run-2", "large", undefined, "acme") as Pod;
    assert.ok(base.spec.volumes?.length, "the cache volume is there to keep");
    const pod = withSystemCaTrust(base, "foldrun-egress-ca-0123456789ab") as Pod;
    for (const v of base.spec.volumes!) assert.ok(pod.spec.volumes!.find((w) => w.name === v.name), `${v.name} kept`);
    const mounts = pod.spec.containers[0]!.volumeMounts!;
    for (const m of base.spec.containers[0]!.volumeMounts!) assert.ok(mounts.find((n) => n.mountPath === m.mountPath), `${m.mountPath} kept`);
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_RUNTIME_CACHE_PVC; else process.env.FOLDRUN_RUNTIME_CACHE_PVC = prev;
  }
});

test("the init script: exactly one certificate, a CA, then the whole store copied as files", () => {
  assert.match(CA_TRUST_SCRIPT, /^set -eu$/m);
  assert.match(CA_TRUST_SCRIPT, /grep -c -- "-----BEGIN CERTIFICATE-----" "\$f"\)" = 1 \]/);
  assert.match(CA_TRUST_SCRIPT, /openssl x509 -in "\$f" -noout -ext basicConstraints .*grep -q "CA:TRUE"/);
  assert.match(CA_TRUST_SCRIPT, /update-ca-certificates/);
  assert.match(CA_TRUST_SCRIPT, /cp -RL \/etc\/ssl\/certs\/\. \/out\//, "links followed: the runner has no copy of the CA's own file");
  assert.match(CA_TRUST_SCRIPT, /chmod -R u=rwX,go=rX \/out/, "root may write it, the agent may only read it");
});

test("the ConfigMap is created once per process; another worker's copy counts; a failure is not cached", async () => {
  const calls: string[][] = [];
  let answer = { status: 1 as number | null, out: "error: connection refused" };
  const kc = async (args: string[]) => { calls.push(args); return answer; };
  const pem = leafFor(`ca-${Math.random().toString(36).slice(2)}.example.com`).cert; // a name no other test made
  assert.equal(await ensureEgressCaConfigMap(pem, kc), false);
  answer = { status: 1, out: 'Error from server (AlreadyExists): configmaps "foldrun-egress-ca-x" already exists' };
  assert.equal(await ensureEgressCaConfigMap(pem, kc), true, "already there (another worker's copy of the same CA) is as good");
  assert.equal(await ensureEgressCaConfigMap(pem, kc), true);
  assert.equal(calls.length, 2, "tried again after a failure, then remembered");
  assert.deepEqual(calls[0], ["create", "-f", "-"], "created, never applied over an immutable object");
});

test("run-k8s builds the pod through it, only for a step that gets the CA, and says so", () => {
  const src = fs.readFileSync(new URL("../src/run-k8s.ts", import.meta.url), "utf8");
  assert.match(src, /const caPem = egressCaPemOf\(args\.env\);/);
  assert.match(src, /pod = withSystemCaTrust\(pod, egressCaConfigMapName\(caPem\)\);/);
  assert.match(src, /applied = await applyRetrying\(kc, JSON\.stringify\(pod\)/);
});

test("web browse: a held WebKit trusts the CA when the system store holds it — read from the store", () => {
  const src = GALLERY.find((t) => t.name === "web")!.extra!.find((f) => f.file === "web/browse.mjs")!.content;
  assert.match(src, /const webkitTrustsCa = CONFINED && values\.browser !== "firefox" && !isChromium && process\.env\.FOLDRUN_EGRESS_CA \? systemStoreHoldsEgressCa\(\) : false;/);
  assert.match(src, /fs\.readFileSync\("\/etc\/ssl\/certs\/ca-certificates\.crt", "utf8"\)/);
  const m = src.match(/function systemStoreHoldsEgressCa\(\) \{[\s\S]*?\n\}\n/);
  assert.ok(m);
});
