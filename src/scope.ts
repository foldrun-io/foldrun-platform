// Which workspaces a member may open: all of them, or a named few.
//
// Stored on the member as a list, or nothing for "all". Carried inside an
// invite as text, so the person who accepts it gets exactly the access the
// inviter chose. Workspace names are kebab-case, so "+" is a safe joiner
// and "*" a safe word for everything.

export type Scope = string[] | null;

/** "*" for all, else names joined by "+". */
export function formatScope(scope: Scope): string {
  if (scope === null) return "*";
  return scope.length === 0 ? "-" : scope.join("+");
}

/** The inverse of formatScope; an unreadable scope is "nothing", never "all". */
export function parseScope(text: string): Scope {
  if (text === "*") return null;
  if (text === "-" || text === "") return [];
  const names = text.split("+").filter((n) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(n));
  return names;
}

export function scopeAllows(scope: Scope, workspace: string): boolean {
  return scope === null || scope.includes(workspace);
}

/** For a person: "all workspaces", "leads", "leads and 2 more". */
export function describeScope(scope: Scope): string {
  if (scope === null) return "all workspaces";
  if (scope.length === 0) return "no workspaces";
  if (scope.length === 1) return scope[0];
  if (scope.length === 2) return `${scope[0]} and ${scope[1]}`;
  return `${scope[0]} and ${scope.length - 1} more`;
}
