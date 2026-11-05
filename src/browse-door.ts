// The browse service's names and its door on the egress proxy (FOL-128
// phase 2, foldrun-docs/proposals/browse-egress.md). Pure: the egress proxy
// imports this without the cluster side (browse-service.ts).
//
// A browsing step that is NOT held to its list (an open list, a report-only
// one, an install that does not confine browsing) may have its browse calls
// run outside its sandbox: one pod per step lease, on the runner image,
// running the platform's own browse program (browse-service.mjs). The step
// reaches it only through the egress proxy, at /browse/<lease>; the proxy
// picks the pod from the lease — never from the request — and the pod
// answers only that lease. A step held to its list keeps its browser inside
// its own walled pod (phase 3, accepted by the owner on 5 Nov 2026) and is
// never given the door.
//
//   FOLDRUN_BROWSE_SERVICE=1    on the worker and the egress proxy: the
//                               switch (k8s only). Off by default.

import crypto from "node:crypto";

export const BROWSE_APP = "foldrun-browse";
export const BROWSE_PORT = 3100;
/** The headless Service that gives each pod its DNS name. */
export const BROWSE_SUBDOMAIN = "foldrun-browse";
/** The env var a step's sandbox gets: its door, lease in the path. */
export const BROWSE_SERVICE_ENV = "FOLDRUN_BROWSE_SERVICE";

const ns = () => process.env.FOLDRUN_K8S_NAMESPACE ?? "foldrun-runs";

/** The switch alone, as the egress proxy reads it. */
export const browseServiceSwitch = () => process.env.FOLDRUN_BROWSE_SERVICE === "1";

/** The worker's side: the switch, the k8s tier, and the egress proxy's
 *  forward door — the one way the service's browser reaches anything. */
export function browseServiceOn(): boolean {
  return (
    browseServiceSwitch() &&
    process.env.FOLDRUN_RUN_ISOLATION === "k8s" &&
    !!process.env.FOLDRUN_EGRESS_URL &&
    process.env.FOLDRUN_EGRESS_FORWARD !== "0"
  );
}

/** SHA-256 of a lease token, hex: what the pod knows its lease by. */
export const leaseHash = (token: string) => crypto.createHash("sha256").update(token, "utf8").digest("hex");

/** The pod serving one lease: named from its hash, never the token. */
export const browsePodName = (token: string) => `${BROWSE_APP}-${leaseHash(token).slice(0, 16)}`;

/** Where the proxy sends a lease's calls. FOLDRUN_BROWSE_SERVICE_ADDR
 *  (host:port) overrides it for tests, which run the service on loopback. */
export function browseTarget(token: string): { host: string; port: number } {
  const o = process.env.FOLDRUN_BROWSE_SERVICE_ADDR;
  if (o) {
    const [host, port] = o.split(":");
    return { host: host!, port: Number(port) || BROWSE_PORT };
  }
  return { host: `${browsePodName(token)}.${BROWSE_SUBDOMAIN}.${ns()}.svc.cluster.local`, port: BROWSE_PORT };
}

/** The lease token in a step's FOLDRUN_EGRESS (`<base>/e/<token>`). */
export function leaseTokenOf(egress: string | undefined): string | null {
  const m = String(egress ?? "").match(/\/e\/([A-Za-z0-9_-]{16,})\/?$/);
  return m ? m[1]! : null;
}

/** The step's door: `<proxy>/browse/<token>`, from its FOLDRUN_EGRESS. */
export function browseDoorUrl(egress: string | undefined): string | null {
  const m = String(egress ?? "").match(/^(.*)\/e\/([A-Za-z0-9_-]{16,})\/?$/);
  return m ? `${m[1]}/browse/${m[2]}` : null;
}

/** The proxy's path: /browse/<lease>. */
export function parseBrowsePath(rawUrl: string): { token: string } | null {
  const m = (rawUrl.split("?")[0] ?? "").match(/^\/browse\/([A-Za-z0-9_-]{16,})\/?$/);
  return m ? { token: m[1]! } : null;
}
