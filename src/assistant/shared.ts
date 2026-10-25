// What the flow draft and the assistant share: the deploy's own checks over
// a workspace as it would be with some files in it, and the model credential
// a one-off call for this workspace runs on. Here, in the platform, so the
// worker that runs the assistant's replies has them as well as the web.

import path from "node:path";
import { workspaceDir, parseFlow } from "../../../foldrun-core/src/store.ts";
import { deployIssues } from "../../../foldrun-core/src/deploy.ts";
import { checkTree } from "../../../foldrun-core/src/workspace-check.ts";
import { TreeTooLarge } from "../../../foldrun-core/src/deploy.ts";
import { lintFlow } from "../../../foldrun-core/src/flow-lint.ts";
import { platformModelEnv } from "../../../foldrun-core/src/runner.ts";
import { accountModelEnv, ModelKeyError } from "../../../foldrun-core/src/model-env.ts";
import type { TranslatorSpec } from "../../../foldrun-core/src/translator.ts";

export interface DraftIssue {
  where: string;
  message: string;
  level: "error" | "warn";
}

export interface DraftFile {
  path: string;
  content: string;
  /** What the workspace has at that path now; null for a new file. */
  before: string | null;
  /** sha256 of `before`, for the save's ifMatch. */
  sha256: string | null;
}

export const FLOW_PATH = /^flows\/([a-z0-9][a-z0-9-]{0,60})\.md$/;
export const AGENT_PATH = /^agents\/([a-z0-9][a-z0-9-]{0,60})\/agent\.md$/;

/** Refusals with an HTTP status the route passes through. */
export function refuse(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

/**
 * The deploy's own checks over the workspace as it would be with `files` in
 * it, narrowed to those files, and the flow lint `foldrun check` runs on any
 * flow among them. What the flow draft and the assistant both answer with.
 */
export function mergedIssues(tenant: string, workspace: string, files: { path: string; content: string }[]): DraftIssue[] {
  let tree;
  try {
    tree = checkTree(workspaceDir(tenant, workspace));
  } catch (err) {
    if (err instanceof TreeTooLarge) return [{ where: "workspace", message: `${err.message}, so these files were not checked`, level: "warn" }];
    throw err;
  }
  const proposed = new Map(files.map((f) => [f.path, f.content]));
  const merged = [...tree.filter((f) => !proposed.has(f.path)), ...files.map((f) => ({ path: f.path, content: f.content }))];
  const issues: DraftIssue[] = [];
  const add = (where: string, message: string, level: DraftIssue["level"] = "error") => {
    if (!issues.some((i) => i.where === where && i.message === message)) issues.push({ where, message, level });
  };

  for (const i of deployIssues(merged)) {
    const at = i.where.split(":")[0];
    if (proposed.has(at)) add(i.where, i.message);
  }

  const agentNames = merged.map((f) => AGENT_PATH.exec(f.path)?.[1]).filter((n): n is string => !!n);
  for (const f of files) {
    if (!FLOW_PATH.test(f.path)) continue;
    try {
      const flow = parseFlow(path.basename(f.path), f.content);
      for (const w of lintFlow(flow, { agents: agentNames })) {
        // The deploy check already said "does not exist" for a missing agent.
        if (/does not exist/.test(w.message) && issues.some((i) => i.where.startsWith(f.path) && /does not exist/.test(i.message))) continue;
        const message = w.detail ? `${w.message.replace(/:\s*$/, "")} — ${w.detail}` : w.message;
        add(`${f.path}${w.line ? `:${w.line}` : ""}`, message, w.level === "error" ? "error" : "warn");
      }
    } catch {
      // parseFlow's own refusal is in deployIssues already
    }
  }
  return issues;
}

/**
 * The model's environment for this workspace: its own `provider:` (resolved
 * the way a run resolves it, secrets from the vault), else the platform's
 * credential where this account may use it. A provider that speaks Chat
 * Completions or Responses comes back with `translator` set; the caller runs
 * through it with core's withModelEnv (FOL-16).
 */
export function draftModelEnv(
  tenant: string,
  workspace: string,
): { env: Record<string, string | undefined>; supply: "provider" | "platform"; translator: TranslatorSpec | null } {
  // One resolution with runs and evals (core model-env.ts): the workspace's
  // provider:, the account's, the account's own key (Settings → Model), and
  // the platform's credential only for the operator's accounts.
  let m: ReturnType<typeof accountModelEnv>;
  try {
    m = accountModelEnv(tenant, workspace, platformModelEnv);
  } catch (err) {
    if (err instanceof ModelKeyError) throw refuse(err.message, err.status);
    throw err;
  }
  return { env: m.env, supply: m.supply, translator: m.translator };
}
