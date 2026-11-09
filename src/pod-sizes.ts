// What an account's service pods are billed at (FOL-125, 8 Nov 2026).
//
// Until now a search or browser pod's life was charged at one flat
// per-second rate that ignored its size, so a 100m / 256Mi search engine
// cost what a whole step does. A pod is now metered like a step: its seconds
// times the vCPU and GiB it holds (and the disk it is allowed), priced at the
// same per-vCPU and per-GiB rates, plus the bytes it moved.
//
// WHICH figure is billed: the pod's REQUESTS, and a service pod's requests
// EQUAL its limits (owner decision, 8 Nov 2026), so what it is billed for is
// exactly what the platform reserves for it: no burst above the bill and no
// reservation below it. The exception is the warm-build
// pod, which is a run pod of the "small" class and is billed exactly as a
// small step would be (its class figures, run-k8s.ts), because it does the
// work a step would otherwise do.
//
// The sizes are registered settings (owner decision, 8 Nov 2026), and one
// function feeds BOTH the manifests (requests = limits) and the bill, so the
// two cannot drift; tests/pod-sizes.test.ts holds them together.

import { setting } from "./settings.ts";

export type ServicePodKind = "search" | "browser" | "browse";

/** What the platform sets aside for a pod: vCPU, GiB of memory, GiB of disk. */
export interface PodSize {
  vcpu: number;
  memGiB: number;
  diskGiB: number;
}

/** The size a kind of service pod is made with: the operator's settings
 *  (pods.browser_* / pods.search_*, registered in settings.ts), else their
 *  defaults: browser 1 vCPU / 3 GiB / 4 GiB disk, search 0.25 vCPU / 0.75
 *  GiB. `browse` (the per-step pod) shares the browser's. Read when a pod is
 *  made, and stamped on it (SIZE), so a pod is billed at the size it held. */
export function servicePodSize(kind: ServicePodKind): PodSize {
  const n = (key: string) => Number(setting(key));
  if (kind === "search") return { vcpu: n("pods.search_vcpu"), memGiB: n("pods.search_memory_gib"), diskGiB: 0 };
  return { vcpu: n("pods.browser_vcpu"), memGiB: n("pods.browser_memory_gib"), diskGiB: n("pods.browser_disk_gib") };
}

/** The annotation a pod carries: the size it was made with, as JSON. */
export const SIZE = "foldrun.io/size";

/** A pod manifest with its size stamped on it. */
export function stampSize(manifest: object, size: PodSize): object {
  const m = manifest as { metadata?: { annotations?: Record<string, string> } };
  return { ...m, metadata: { ...(m.metadata ?? {}), annotations: { ...(m.metadata?.annotations ?? {}), [SIZE]: JSON.stringify(size) } } };
}

/** The size read back off a pod; the kind's current one for a pod made
 *  before the stamp (or one whose annotation does not read). */
export function sizeOf(text: string | undefined, kind: ServicePodKind): PodSize {
  try {
    const o = JSON.parse(text ?? "") as Partial<PodSize>;
    if ([o.vcpu, o.memGiB, o.diskGiB].every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0)) return { vcpu: o.vcpu!, memGiB: o.memGiB!, diskGiB: o.diskGiB! };
  } catch {
    /* no stamp */
  }
  return servicePodSize(kind);
}

/** A vCPU figure as a Kubernetes quantity: 0.1 → "100m", 2 → "2". */
export function cpuQuantity(vcpu: number): string {
  return Number.isInteger(vcpu) ? String(vcpu) : `${Math.round(vcpu * 1000)}m`;
}

/** A GiB figure as a Kubernetes quantity: 0.25 → "256Mi", 3 → "3Gi". */
export function memQuantity(gib: number): string {
  return Number.isInteger(gib) ? `${gib}Gi` : `${Math.round(gib * 1024)}Mi`;
}

/** The `resources.requests` AND `limits` a service pod gets, from the table
 *  (the two are equal). Disk (ephemeral-storage) is added by the caller where
 *  the pod has any. */
export function serviceRequests(kind: ServicePodKind, s: PodSize = servicePodSize(kind)): { cpu: string; memory: string } {
  return { cpu: cpuQuantity(s.vcpu), memory: memQuantity(s.memGiB) };
}

/** The figure the ledger line and the bill carry for a session: seconds ×
 *  size, in the meter's own units (core-seconds, GiB-seconds). */
export function podHold(size: PodSize, secs: number): { coreSecs: number; gibSecs: number; diskGibSecs: number } {
  return { coreSecs: secs * size.vcpu, gibSecs: secs * size.memGiB, diskGibSecs: secs * size.diskGiB };
}
