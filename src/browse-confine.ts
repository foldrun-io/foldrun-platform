// Hosted enforcement of `network:` for browsing (FOL-110 phase 3,
// foldrun-docs/proposals/browse-egress.md).
//
// On the k8s tier a step whose `network:` is restricted and enforced runs in
// a `filtered` run pod: foldrun-infra's run-network-policy.yaml gives it the
// egress proxy (TCP 8090) and DNS and nothing else — no other address, port
// or protocol, IPv4 or IPv6 — and no account pod admits it. That pod is the
// step's own (one per step attempt, nothing shared with another step), so a
// browser launched inside it is confined by the same wall: whatever proxy a
// client gives it, the only way out is the authenticated egress proxy, which
// holds the step's list per connection.
//
// FOLDRUN_BROWSE_ENFORCE=1 puts browsing under that wall. Core's runner then
// gives a browsing step the forward proxy like any other (so its pod is
// filtered), the web tool hands its browser the proxy as launch options, and
// the account's browser pod — which has the world and is not walled — is not
// used for that step (run-k8s.ts accountServiceEnv). Unset, a browsing step
// browses exactly as before phase 3, said in its trace as not enforced.
//
//   FOLDRUN_BROWSE_ENFORCE=1    hold browsing steps to their list (k8s only)

/** The install's switch. */
export const browseEnforceOn = () => process.env.FOLDRUN_BROWSE_ENFORCE === "1";

/** Platform.confinesBrowsing: only the k8s executor walls a step's network,
 *  only when that is the isolation this install runs, and only with the
 *  egress proxy's forward door (FOLDRUN_EGRESS_URL, FOLDRUN_EGRESS_FORWARD not
 *  0) — the one way out a walled pod has. The runner needs the step's lease to
 *  name the door too; the dashboard, which has no lease, asks this alone. */
export function confinesBrowsing(kind: string): boolean {
  return browseEnforceOn() && wallsRestrictedSteps(kind);
}

/** Does this install wall a step whose list is restricted and enforced (a
 *  `filtered` pod: the egress proxy and nothing else)? The k8s executor,
 *  with the forward door — whatever the browse switch says. Such a step's
 *  web search goes through the proxy's search door (FOL-128). */
export function wallsRestrictedSteps(kind: string): boolean {
  return kind === "k8s" && process.env.FOLDRUN_RUN_ISOLATION === "k8s" && !!process.env.FOLDRUN_EGRESS_URL && process.env.FOLDRUN_EGRESS_FORWARD !== "0";
}
