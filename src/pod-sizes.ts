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
// One table feeds BOTH the manifests (the requests they ask Kubernetes for)
// and the bill, so the two cannot drift; tests/pod-sizes.test.ts holds them
// together.

export type ServicePodKind = "search" | "browser" | "browse";

/** What the platform sets aside for a pod: vCPU, GiB of memory, GiB of disk. */
export interface PodSize {
  vcpu: number;
  memGiB: number;
  diskGiB: number;
}

/** The three service pods. `browse` is the per-step browse pod (the
 *  browser-pool pod `browser` is the same Chromium image, same figures). */
export const SERVICE_POD_SIZES: Record<ServicePodKind, PodSize> = {
  search: { vcpu: 1, memGiB: 0.75, diskGiB: 0 },
  browser: { vcpu: 2, memGiB: 3, diskGiB: 4 },
  browse: { vcpu: 2, memGiB: 3, diskGiB: 4 },
};

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
export function serviceRequests(kind: ServicePodKind): { cpu: string; memory: string } {
  const s = SERVICE_POD_SIZES[kind];
  return { cpu: cpuQuantity(s.vcpu), memory: memQuantity(s.memGiB) };
}

/** The figure the ledger line and the bill carry for a session: seconds ×
 *  size, in the meter's own units (core-seconds, GiB-seconds). */
export function podHold(size: PodSize, secs: number): { coreSecs: number; gibSecs: number; diskGibSecs: number } {
  return { coreSecs: secs * size.vcpu, gibSecs: secs * size.memGiB, diskGibSecs: secs * size.diskGiB };
}
