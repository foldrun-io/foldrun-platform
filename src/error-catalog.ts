// One catalog of refusals (FOL-402, 27 Nov 2026; agreed with Codex): what a
// program shows a person when foldrun says no. Owner: "every error says what
// is going on and a command to handle it."
//
// The body stays Anthropic's shape exactly — status, error.type,
// error.message, request_id — because every client already parses it, and
// Claude Code shows error.message as it is. So the message alone must be
// enough: what to do first, then what happened. Beside Anthropic's fields,
// error.foldrun carries the same for a program to use:
//
//   { code, fix, command?, command_kind?: "diagnose" | "repair", docs? }
//
// A command is a fixed template of a command the CLI has, written here —
// never text from a request or a setting, and never a shell line. Used by
// the gateway door (gateway-door.ts fail) and the web API's error body
// (foldrun-web server/error-shape.ts) for the codes listed here; a code not
// listed keeps its message as it was.

export type CommandKind = "diagnose" | "repair";

export interface CatalogEntry {
  /** One line: what to do, action first, no full stop. */
  fix: string;
  /** An existing CLI command that diagnoses or repairs it. */
  command?: string;
  command_kind?: CommandKind;
  /** Where it is explained. */
  docs?: string;
}

export interface FoldrunError extends CatalogEntry {
  code: string;
}

const DOCS = "https://docs.foldrun.io/api#errors";

const signIn: CatalogEntry = { fix: "Sign in again, or use a current key", command: "foldrun login", command_kind: "repair", docs: DOCS };

/** Every code with a fix. Keep each fix short: it leads the message. */
export const ERROR_CATALOG: Readonly<Record<string, CatalogEntry>> = {
  // Who is calling
  no_key: { fix: "Send your foldrun key as x-api-key or Authorization: Bearer", command: "foldrun login", command_kind: "repair", docs: DOCS },
  key_unknown: signIn,
  key_revoked: signIn,
  key_expired: signIn,
  unauthorized: signIn,
  no_model_grant: { fix: "Use a key with model access", command: "foldrun keys ls", command_kind: "diagnose", docs: DOCS },
  not_gateway_key: { fix: "Use a key made for model calls", command: "foldrun keys ls", command_kind: "diagnose", docs: DOCS },
  // Money: the plan, then the wallet
  subscription_required: { fix: "Choose a plan (Pro or Max) to use this key", command: "foldrun billing plans", command_kind: "repair", docs: DOCS },
  allowance_used: { fix: "Upgrade your plan, or turn on extra usage to carry on from the wallet", command: "foldrun billing plans", command_kind: "diagnose", docs: DOCS },
  model_not_in_plan: { fix: "Pick a model your plan includes, or turn on extra usage", command: "foldrun billing plans", command_kind: "diagnose", docs: DOCS },
  extra_usage_unfunded: { fix: "Top up the wallet, or raise the extra-usage limit", command: "foldrun billing", command_kind: "diagnose", docs: DOCS },
  login_share: { fix: "Wait for the plan's window to reset, or upgrade", command: "foldrun billing plans", command_kind: "diagnose", docs: DOCS },
  payment_required: { fix: "Check your plan and wallet", command: "foldrun billing", command_kind: "diagnose", docs: DOCS },
  // How fast
  rate_limited: { fix: "Slow down and retry after the Retry-After seconds", docs: DOCS },
  too_many_open: { fix: "Wait for a call to finish, then retry", docs: DOCS },
  // What was asked
  too_large: { fix: "Send a smaller request (compact the conversation, or attach less)", docs: DOCS },
  model_unavailable: { fix: "Pick a model foldrun offers", command: "foldrun account model prices", command_kind: "diagnose", docs: DOCS },
  no_supply_key: { fix: "Pick a model from another provider for now", command: "foldrun account model prices", command_kind: "diagnose", docs: DOCS },
  // foldrun's side
  unavailable: { fix: "Retry in a few seconds; if it goes on, check the connection", command: "foldrun doctor", command_kind: "diagnose", docs: DOCS },
  billing_unreadable: { fix: "Retry in a few seconds", command: "foldrun doctor", command_kind: "diagnose", docs: DOCS },
};

/** The default code for a status, when the refusal names none. */
const BY_STATUS: Record<number, string> = { 401: "unauthorized", 402: "payment_required", 413: "too_large", 429: "rate_limited", 503: "unavailable" };

/** The catalog's entry for a refusal, or null when it has none. */
export function foldrunError(code: string | undefined, status?: number): FoldrunError | null {
  const c = code && ERROR_CATALOG[code] ? code : !code && status !== undefined ? BY_STATUS[status] : undefined;
  const e = c ? ERROR_CATALOG[c] : undefined;
  return c && e ? { code: c, ...e } : null;
}

/** The message, action first: "<fix> (run `<command>`): <what happened>",
 *  what happened kept word for word after the colon. Unchanged when there
 *  is no entry. */
export function actionFirst(message: string, e: FoldrunError | null): string {
  if (!e) return message;
  const what = message.trim();
  const fix = `${e.fix}${e.command ? ` (run \`${e.command}\`)` : ""}`;
  return what ? `${fix}: ${what}` : fix;
}

/** Anthropic's `error` object for a refusal, with the catalog's fields. */
export function catalogError(type: string, message: string, code: string | undefined, status: number): Record<string, unknown> {
  const e = foldrunError(code, status);
  return { type, message: actionFirst(message, e), ...(code ? { code } : {}), ...(e ? { foldrun: e } : {}) };
}
