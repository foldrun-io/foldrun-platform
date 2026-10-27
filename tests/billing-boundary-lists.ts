// What counts as foldrun's billing, for the boundary tests here and in
// foldrun-web (tests/billing-boundary.test.ts in each). One list, so the two
// repos cannot disagree about where the line is.

/** Billing's own modules: the money, the operator's levers, Stripe. Only
 *  billing-hosted.ts wires them in; no engine file imports one. */
export const PRIVATE = new Set([
  "billing-hosted",
  "plans",
  "subscriptions",
  "dunning",
  "stripe-api",
  "stripe-events",
  "stripe-log",
  "billing-details",
  "top-up",
  "wallet-db",
  "support-views",
  "credits",
  "operator-levers",
  "wallet",
  "pricing",
  "stripe-sync",
]);

/** Billing's tests in tests/ (foldrun-admin's platform/tests). */
export const BILLING_TESTS = new Set([
  "admin-billing.test.ts",
  "billing-details.test.ts",
  "billing-hosted.test.ts",
  "billing-money.test.ts",
  "dunning.test.ts",
  "ledger-billing.test.ts",
  "plans.test.ts",
  "pod-session-billing.test.ts",
  "postgres-live-billing.test.ts",
  "reservations-billing.test.ts",
  "settle-billing.test.ts",
  "stripe-events.test.ts",
  "stripe-sync.test.ts",
  "wallet.test.ts",
]);

/** src/billing-hosted.ts as the public repository has it: no billing. The
 *  hosted build lays foldrun-admin's wiring over it (overlay.sh). */
export const HOSTED_STUB = `// foldrun's billing is not part of this checkout: the engine runs free.
// The hosted image replaces this file with the real wiring (foldrun-admin).

import type { Billing } from "./billing.ts";

export const hosted: Billing | null = null;
`;

/** Every module a file names, with the names it takes from each. */
export function importsOf(text: string): { module: string; names: string[] | "*" }[] {
  const found: { module: string; names: string[] | "*" }[] = [];
  const named = /(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
  for (const m of text.matchAll(named)) {
    const names = m[1].split(",").map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]).filter(Boolean);
    found.push({ module: m[2], names });
  }
  const whole = /(?:import|export)\s+(?:type\s+)?(?:\*\s+as\s+\w+|\*|\w+)\s+from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;
  for (const m of text.matchAll(whole)) found.push({ module: m[1] ?? m[2] ?? m[3], names: "*" });
  return found;
}

