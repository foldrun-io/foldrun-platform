// The egress CA in a run pod's system trust store (FOL-144).
//
// A step that holds a secret bound to sites, or browses held to its
// network: list, meets the egress proxy's own certificate on those sites: the
// proxy ends TLS there with a leaf the foldrun egress CA signs. Most programs
// trust it through the bundle the agent's start writes (core network.ts
// egressCaSh: SSL_CERT_FILE, NODE_EXTRA_CA_CERTS, …), Chromium through its
// key, Firefox through its profile — but WebKit (and anything else that reads
// only the system store) trusts nothing but /etc/ssl/certs, which only root
// may write. Tried in the runner image on 8 Nov 2026: SSL_CERT_FILE,
// SSL_CERT_DIR, a p11-kit user anchor and GnuTLS's environment all failed.
//
// Root's start must not read a CA from the job folder: that folder is the
// agent's (owned by it, kept by tar's --no-overwrite-dir), so it would be
// agent-writable input to root. Decided with Codex (8 Nov 2026) instead:
//
//   - the public CA as a platform-owned, immutable ConfigMap named by its
//     key and subject (a rotated key is a new name; nothing edits one in
//     place). Not by its bytes: the CA certificate is signed again in every
//     process (ECDSA signatures are random), so each worker's copy differs
//     while its key and name do not — a trust anchor is matched on those;
//   - an init container from the same image, as root with no capabilities,
//     that checks it is exactly one certificate and a CA, adds it, and copies
//     the whole resulting store into an emptyDir;
//   - that emptyDir mounted at /etc/ssl/certs in the runner, owned by root
//     (directories 755, files 644): the agent cannot write it, and root's
//     apt can still run update-ca-certificates for a runtime: system:
//     package (a read-only mount broke that — Codex review). A regeneration
//     there may drop the egress CA again; web browse reads the real store
//     and says so.
//
// The runner's own start reads nothing new. Only for a step that already
// gets the CA (the worker's FOLDRUN_EGRESS_CA).

import crypto from "node:crypto";

const ns = () => process.env.FOLDRUN_K8S_NAMESPACE ?? "foldrun-runs";

export const EGRESS_CA_APP = "foldrun-egress-ca";
export const CA_VOLUME = "egress-ca";
export const STORE_VOLUME = "system-certs";
/** Where the runner sees the built store. */
export const SYSTEM_CERTS = "/etc/ssl/certs";

/** The init container's work: check, add, copy. Runs as root in its own
 *  filesystem; its only output is the emptyDir. `cp -L` turns the store's
 *  links (into /usr/share/ca-certificates and /usr/local/share, which the
 *  runner's copy does not have for this CA) into files. */
export const CA_TRUST_SCRIPT = [
  "set -eu",
  "f=/foldrun-ca/ca.pem",
  '[ "$(grep -c -- "-----BEGIN CERTIFICATE-----" "$f")" = 1 ] || { echo "egress CA: not exactly one certificate" >&2; exit 1; }',
  'openssl x509 -in "$f" -noout -ext basicConstraints 2>/dev/null | grep -q "CA:TRUE" || { echo "egress CA: not a CA certificate" >&2; exit 1; }',
  "cp \"$f\" /usr/local/share/ca-certificates/foldrun-egress.crt",
  "update-ca-certificates >/dev/null",
  "cp -RL /etc/ssl/certs/. /out/",
  "chmod -R u=rwX,go=rX /out",
].join("\n");

/** The ConfigMap's name for this CA: a hash of its key and subject — what
 *  stays the same across processes (the certificate's own bytes do not), so
 *  every worker finds one object, and a rotated key is a new one. */
export function egressCaConfigMapName(pem: string): string {
  const cert = new crypto.X509Certificate(pem);
  const spki = cert.publicKey.export({ type: "spki", format: "der" });
  return `${EGRESS_CA_APP}-${crypto.createHash("sha256").update(spki).update("\0").update(cert.subject).digest("hex").slice(0, 12)}`;
}

export function egressCaConfigMap(pem: string): object {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: egressCaConfigMapName(pem), namespace: ns(), labels: { app: EGRESS_CA_APP } },
    immutable: true,
    data: { "ca.pem": pem },
  };
}

/** The PEM a step's env carries (base64), when it is one certificate; null
 *  otherwise — the pod is then made as before. */
export function egressCaPemOf(env: Record<string, string | undefined>): string | null {
  const b64 = env.FOLDRUN_EGRESS_CA;
  if (!b64) return null;
  try {
    const pem = Buffer.from(b64, "base64").toString("utf8");
    const cert = new crypto.X509Certificate(pem);
    return cert.ca ? pem : null;
  } catch {
    return null;
  }
}

type Container = { name: string; image?: string; volumeMounts?: object[] } & Record<string, unknown>;
type PodLike = { spec: { volumes?: object[]; initContainers?: object[]; containers: Container[] } };

/** The pod with the CA in its system store: the two volumes, the init
 *  container, and the runner's read-only mount. Pure. */
export function withSystemCaTrust<T extends object>(pod: T, configMapName: string): T {
  const p = structuredClone(pod) as unknown as PodLike;
  const runner = p.spec.containers.find((c) => c.name === "runner") ?? p.spec.containers[0]!;
  p.spec.volumes = [
    ...(p.spec.volumes ?? []),
    { name: CA_VOLUME, configMap: { name: configMapName, items: [{ key: "ca.pem", path: "ca.pem" }] } },
    { name: STORE_VOLUME, emptyDir: { sizeLimit: "16Mi" } },
  ];
  p.spec.initContainers = [
    ...(p.spec.initContainers ?? []),
    {
      name: "egress-ca",
      image: runner.image,
      imagePullPolicy: "IfNotPresent",
      command: ["sh", "-c", CA_TRUST_SCRIPT],
      securityContext: {
        runAsUser: 0,
        allowPrivilegeEscalation: false,
        capabilities: { drop: ["ALL"] },
        seccompProfile: { type: "RuntimeDefault" },
      },
      resources: {
        requests: { cpu: "50m", memory: "32Mi", "ephemeral-storage": "16Mi" },
        limits: { cpu: "500m", memory: "128Mi", "ephemeral-storage": "64Mi" },
      },
      volumeMounts: [
        { name: CA_VOLUME, mountPath: "/foldrun-ca", readOnly: true },
        { name: STORE_VOLUME, mountPath: "/out" },
      ],
    },
  ];
  // Not readOnly: root-owned (the init script's chmod) keeps the agent out,
  // and root's apt may still regenerate it for a runtime: system: package.
  runner.volumeMounts = [...(runner.volumeMounts ?? []), { name: STORE_VOLUME, mountPath: SYSTEM_CERTS }];
  return p as unknown as T;
}

const made = new Set<string>();
/** Make the CA's ConfigMap once per process. Created, never applied over:
 *  another worker's copy of the same CA (same key and subject, other bytes)
 *  may already be there, and an immutable object refuses new data — that one
 *  is as good, so "already exists" is success. True when it is there. */
export async function ensureEgressCaConfigMap(
  pem: string,
  kc: (args: string[], input?: string, timeoutMs?: number) => Promise<{ status: number | null; out: string }>,
): Promise<boolean> {
  const name = egressCaConfigMapName(pem);
  if (made.has(name)) return true;
  const r = await kc(["create", "-f", "-"], JSON.stringify(egressCaConfigMap(pem)), 20_000);
  const ok = r.status === 0 || /AlreadyExists|already exists/.test(r.out);
  if (ok) made.add(name);
  return ok;
}

/** The trace line for a step whose system store holds the CA. */
export const SYSTEM_CA_LINE = "egress CA: in this sandbox's system trust store too (root's, not the agent's to change), so a program that reads only the system store — WebKit among them — trusts the egress proxy's certificate";
