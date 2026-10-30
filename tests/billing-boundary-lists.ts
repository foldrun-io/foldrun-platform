// What counts as foldrun's billing, for the boundary tests here and in
// foldrun-web (tests/billing-boundary.test.ts in each). One list, so the two
// repos cannot disagree about where the line is.

/** Billing's own modules: the money, the operator's levers, Stripe — and,
 *  since 30 Oct 2026, the operator console's own (its tables, its flag and
 *  incident writes, its audit listing). Only billing-hosted.ts and
 *  foldrun-admin's web code reach them; no engine file imports one. */
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
  "schema-console",
  "flags-admin",
  "status-admin",
  "operator-audit",
  "settings-admin",
  "settings-hosted",
]);

/** foldrun-admin's shared modules (30 Oct 2026, stage 4): what the hosted
 *  app and the operator console's own application both use — the signed
 *  protocol, the Access check, the admin API contract, the console's
 *  tables — laid into src/admin-shared/ by overlay.sh. Private like
 *  PRIVATE: only foldrun-admin's code reaches them. */
export const PRIVATE_DIR = "admin-shared/";

/** A module (path under src/, no .ts) that is foldrun-admin's. */
export const isPrivate = (name: string): boolean => PRIVATE.has(name) || name.startsWith(PRIVATE_DIR);

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
  "flags-admin.test.ts",
  "status-admin.test.ts",
  "operator-audit.test.ts",
  "settings-admin.test.ts",
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

