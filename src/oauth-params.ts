// What a browser OAuth consent may and may not be told, shared by the saved
// apps (oauth-clients.ts) and the flow (oauth-connect.ts) without either
// importing the other.

import { tokenAuthProblem } from "../../foldrun-core/src/oauth-token.ts";

/** Authorize-URL parameters the flow owns: an `authorize_extra` or a query
 *  string in the authorize URL cannot override them (Codex debate). */
export const RESERVED_PARAMS = ["client_id", "redirect_uri", "response_type", "scope", "state", "code_challenge", "code_challenge_method"] as const;

/** Whether a client config is usable for a browser consent: a secret, or PKCE. */
export function clientConfigProblem(config: { client_secret?: string; pkce?: boolean; authorize_extra?: Record<string, string>; token_auth?: unknown; client_assertion_key?: string; client_assertion_alg?: unknown; client_assertion_cert?: string }): string | null {
  // A signing key is a confidential client's proof too, like a secret —
  // but only when the app signs in with it (an unused key proves nothing).
  const signs = config.token_auth === "private_key_jwt" && !!config.client_assertion_key?.trim();
  if (!config.client_secret?.trim() && !signs && config.pkce === false) return "an app with no client secret is a public client and needs PKCE — leave PKCE on";
  const auth = tokenAuthProblem(config);
  if (auth) return auth;
  for (const k of Object.keys(config.authorize_extra ?? {})) {
    if ((RESERVED_PARAMS as readonly string[]).includes(k)) return `authorize_extra cannot set ${k} — the flow sets it`;
  }
  return null;
}

