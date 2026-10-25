// Rotate this install's identity-token signing key (oidc-issuer.ts): the new
// key is published now and signs in a day; the old one stays published until
// every token it signed has expired, then leaves the store.
//
//   node --experimental-strip-types foldrun-platform/scripts/rotate-oidc-key.ts
//
// Run where the platform runs (the worker pod), with its environment —
// FOLDRUN_SECRET_KEY and the database — so the key lands where the issuer reads.

import { oidcIssuer, rotateOidcKey, oidcJwks } from "../src/oidc-issuer.ts";

if (!oidcIssuer()) {
  console.error("FOLDRUN_OIDC_ISSUER is not set: this install does not issue identity tokens");
  process.exit(1);
}
const kid = await rotateOidcKey();
console.log(`new key ${kid} published; it signs in 24 hours. Published now: ${(await oidcJwks()).keys.map((k) => k.kid).join(", ")}`);
process.exit(0);
