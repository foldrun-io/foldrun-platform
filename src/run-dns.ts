// No cluster DNS for a walled run pod (FOL-128).
//
// A step whose `network:` is restricted and enforced runs in a `filtered`
// pod: the egress proxy and nothing else on the network (foldrun-infra
// run-network-policy.yaml). Until FOL-128 that wall still let the pod ask
// the cluster's resolver anything — and a name is a message: a lookup of
// `<data>.attacker.example` reaches attacker.example's nameserver through
// CoreDNS, whatever the site list says. So DNS is a way out too.
//
// The pod has no need of it. Everything it may reach goes through the
// proxy by name: HTTPS_PROXY makes every client send `CONNECT host:port`
// (curl, Python requests/httpx, Node's fetch, Go, git, apt, pip, npm, the
// Claude CLI — tested, it CONNECTs a name it could not resolve), Chromium
// with --proxy-server resolves remotely, and the proxy resolves only a site
// the list allows, after checking it. The one name the pod resolves itself
// is the proxy's own, and that goes in /etc/hosts.
//
// With FOLDRUN_RUN_DNS_WALL=1 (set by foldrun-infra's base manifests beside
// the policy that withholds DNS from a pod labelled foldrun.io/dns=none), a
// filtered pod gets that label, the egress address as a hostAlias, and a
// resolver that is not there (127.0.0.1, one try, one second), so a program
// that looks a name up itself fails at once instead of waiting on packets
// the cluster drops. The worker finds the egress address before the pod is
// made; when it cannot, the step fails — the wall is never quietly left off
// on an install that asked for it. Off the switch (an install whose
// manifests do not carry the policy, docker, the laptop) nothing changes.
//
// What still resolves: the proxy looks up the sites the list allows, so a
// wildcard site (`*.example.com`) lets a lookup of any name under it reach
// that domain's nameserver, and a CONNECT to an allowed host may name any
// port. The list bounds both; this closes the resolver the list never saw.

import dns from "node:dns";
import net from "node:net";

/** The label the cluster keys DNS on: `none` takes the pod out of
 *  foldrun-run-dns (foldrun-infra run-network-policy.yaml). A label of its
 *  own, not `network: filtered`, so the platform and the manifests can
 *  roll out in either order: a pod without it keeps DNS as before. */
export const DNS_LABEL = "foldrun.io/dns";

/** Is the DNS wall on for this install? Its manifests say so when they
 *  carry the policy that holds it. */
export const dnsWallEnabled = (): boolean => process.env.FOLDRUN_RUN_DNS_WALL === "1";

export interface HostAlias {
  ip: string;
  hostnames: string[];
}

/** What a walled pod's spec adds: no cluster resolver, the egress
 *  address in /etc/hosts. Kubernetes keeps localhost and the pod's own name
 *  in /etc/hosts whatever dnsPolicy says. */
export function walledDnsSpec(aliases: HostAlias[]): Record<string, unknown> {
  return {
    dnsPolicy: "None",
    dnsConfig: {
      // Nothing listens there: a lookup is refused at once (no packet
      // leaves the pod), where the cluster's resolver would let it wait
      // out every timeout on packets the policy drops.
      nameservers: ["127.0.0.1"],
      searches: [],
      options: [
        { name: "ndots", value: "1" },
        { name: "attempts", value: "1" },
        { name: "timeout", value: "1" },
      ],
    },
    ...(aliases.length ? { hostAliases: aliases } : {}),
  };
}

type Lookup = (host: string, opts: { all: true }) => Promise<{ address: string; family: number }[]>;
const systemLookup: Lookup = (host, opts) => dns.promises.lookup(host, opts);

/**
 * The egress proxy's address, as /etc/hosts entries for a pod with no
 * resolver: the URL's host looked up on the worker, which has the cluster's
 * DNS. A few tries inside one deadline; throws when it has no answer, and
 * the caller fails the step. An IP literal needs no entry.
 */
export async function egressHostAliases(
  egressUrl: string | null | undefined,
  opts: { lookup?: Lookup; deadlineMs?: number; tries?: number } = {},
): Promise<HostAlias[]> {
  if (!egressUrl) throw new Error("dns: this step's sandbox is walled from DNS, but the install names no egress proxy (FOLDRUN_EGRESS_URL)");
  let host: string;
  try {
    host = new URL(egressUrl).hostname.replace(/^\[|\]$/g, "");
  } catch {
    throw new Error(`dns: the egress proxy's address is not a URL: ${egressUrl}`);
  }
  if (net.isIP(host)) return [];
  const lookup = opts.lookup ?? systemLookup;
  const deadline = Date.now() + (opts.deadlineMs ?? 5_000);
  const tries = opts.tries ?? 3;
  let last = "no answer";
  for (let i = 0; i < tries && Date.now() < deadline; i++) {
    const left = deadline - Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      const got = await Promise.race([
        lookup(host, { all: true }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no answer in ${Math.round(left / 100) / 10}s`)), left);
          timer.unref();
        }),
      ]);
      const ips = [...new Set(got.map((a) => a.address).filter((a) => net.isIP(a)))];
      if (ips.length) return ips.map((ip) => ({ ip, hostnames: [host] }));
      last = "no address";
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }
    if (i + 1 < tries && Date.now() < deadline) await new Promise((r) => setTimeout(r, Math.min(500, Math.max(0, deadline - Date.now()))));
  }
  throw new Error(`dns: could not find the egress proxy's address (${host}: ${last}) — a sandbox walled from DNS needs it in /etc/hosts, so the step is not started`);
}

/** What a walled step's trace says once. */
export const DNS_WALLED_LINE =
  "dns: this sandbox has no resolver of its own — every site is reached through the egress proxy by name, and the proxy looks up only sites on the list; a program that looks a name up itself (dig, an MX check, a client that resolves before it connects) fails here";

/** …and a filtered step's on an install without the wall. */
export const DNS_OPEN_LINE =
  "dns: this sandbox can still look any name up through the cluster's resolver (FOLDRUN_RUN_DNS_WALL is not set on this install) — a lookup is not held to the network: list";

/** What a resumed step's trace says when its pod's DNS is not what this
 *  driver would make now — null when they agree. */
export function resumedDnsLine(podWalled: boolean, wanted: boolean): string | null {
  if (podWalled === wanted) return null;
  return podWalled
    ? "dns: this sandbox was made without a resolver, and keeps that for the rest of the step"
    : "dns: this sandbox was made before DNS was walled — it can still look names up through the cluster's resolver for the rest of this step";
}
