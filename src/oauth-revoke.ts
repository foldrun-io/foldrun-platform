// Revoking a connection's tokens at its provider (RFC 7009) when the secret
// that holds them is deleted or replaced, through the SSRF guard. Core does
// the asking (revokeOAuth2Value); this is the platform's network and the one
// rule both routes share: the old copy at exactly that scope, after the
// write, and never a reason to undo it.

import { oauth2ValueAt, revokeOAuth2Value, type OAuthRevokeResult } from "../../foldrun-core/src/secrets.ts";
import { fetchPublic } from "./ssrf.ts";

export type { OAuthRevokeResult };

/** The oauth2 recipe at exactly this scope, read before it is overwritten. */
export function oauthBefore(tenant: string, name: string, workspace?: string): string | null {
  try {
    return oauth2ValueAt(tenant, name, workspace);
  } catch {
    return null;
  }
}

/** Revoke a recipe that is gone (deleted) or replaced. `replacement`: the
 *  app of the recipe now stored — the same app means nothing is revoked
 *  (core revokeOAuth2Value). Undefined when there was nothing to revoke. */
export async function revokeReplaced(
  tenant: string,
  name: string,
  workspace: string | undefined,
  before: string | null,
  replacement?: { token_url: string; client_id: string },
): Promise<OAuthRevokeResult | undefined> {
  if (!before) return undefined;
  try {
    return await revokeOAuth2Value(before, { tenant, name, workspace, ...(replacement ? { replacement } : {}), fetcher: (url, init) => fetchPublic(url, init, { maxBytes: 64 * 1024 }) });
  } catch (err) {
    return { revoked: [], error: err instanceof Error ? err.message : String(err) };
  }
}
