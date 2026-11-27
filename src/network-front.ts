// The API's front for callers in Iran, and the one notice the API answers
// them (FOL-398, FOL-402 — 27 Nov 2026).
//
// Iran's filter freezes a connection to a little-known foreign name once it
// has carried ~20–30 KB, while *.cloudfront.net passes. The same API is
// served under a CloudFront name; a caller in Iran is told that name
// wherever the platform tells a program where to call, and is told what is
// going on in one notice the operator sets in the console
// (network.iran_api_url, network.iran_notice*, settings.ts) — so moving to a
// new front when one is blocked is one change, no deploy. The environment
// (FOLDRUN_IRAN_API_URL) still answers when no row says.
//
// Who is in Iran: Cloudflare's country for the caller (only behind
// Cloudflare with the edge stamp, FOLDRUN_TRUST_PROXY=cloudflare), or the
// front's own stamp — the front sets `x-foldrun-front: ir` on every request
// it carries, whose country Cloudflare sees as CloudFront's. Either may be
// claimed by anyone; it only picks between addresses of the same API and
// shows a notice, so a false claim gains nothing.
//
// Used by the web (/v1/version, /v1/me, key mint, the dashboard banner)
// and by the gateway (the X-Foldrun-Notice header on its answers).

import crypto from "node:crypto";
import { setting } from "./settings.ts";

/** The header the Iran front stamps on what it carries. */
export const FRONT_HEADER = "x-foldrun-front";

/** A front: a CloudFront distribution's own name over https, nothing else. */
const FRONT_HOST = /^[a-z0-9]{1,40}\.cloudfront\.net$/;

/** One setting as text, or "" (a registry without it reads nothing). */
function text(key: string): string {
  try {
    const v = setting(key);
    return typeof v === "string" ? v.trim() : "";
  } catch {
    return "";
  }
}

/** Every front the operator named, in order, each an https origin of a
 *  CloudFront name (anything else is dropped, whatever the source). */
export function iranFronts(): string[] {
  const out: string[] = [];
  for (const part of text("network.iran_api_url").split(",")) {
    const v = part.trim();
    if (!v) continue;
    try {
      const u = new URL(v);
      if (u.protocol !== "https:" || u.port || u.username || u.password || !FRONT_HOST.test(u.hostname)) continue;
      if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) continue;
      if (!out.includes(u.origin)) out.push(u.origin);
    } catch {
      /* not a URL: dropped */
    }
    if (out.length >= 4) break;
  }
  return out;
}

/** The front answered to a caller in Iran, else null. */
export function iranFrontUrl(): string | null {
  return iranFronts()[0] ?? null;
}

type HeaderSource = { get(name: string): string | null | undefined } | Record<string, string | string[] | undefined>;

function header(h: HeaderSource, name: string): string {
  const v = typeof (h as { get?: unknown }).get === "function" ? (h as { get(n: string): string | null | undefined }).get(name) : (h as Record<string, string | string[] | undefined>)[name];
  return (Array.isArray(v) ? v[0] : v ?? "").trim();
}

/** Whether a request (Fetch Headers or Node's header object) is from a
 *  caller the front is for. */
export function fromIranHeaders(h: HeaderSource): boolean {
  if (header(h, FRONT_HEADER).toLowerCase() === "ir") return true;
  if (process.env.FOLDRUN_TRUST_PROXY !== "cloudflare") return false;
  return header(h, "cf-ipcountry").toUpperCase() === "IR";
}

/** The fixed command each notice action names: never text from a row. */
export const NOTICE_ACTIONS = {
  restart_claude_code: { label: "restart Claude Code", command: null },
  run_doctor: { label: "check the connection", command: "foldrun doctor" },
  sign_in_again: { label: "sign in again", command: "foldrun login" },
} as const;

export type NoticeAction = keyof typeof NOTICE_ACTIONS;

export interface Notice {
  /** Changes whenever the message, action or end changes: what a client
   *  compares to say "new" once. */
  id: string;
  message: string;
  action: NoticeAction | null;
  command: string | null;
  /** ISO, or null: until it is cleared. */
  expires: string | null;
}

/** The notice in force, or null: none set, or it has ended. */
export function iranNotice(now: number = Date.now()): Notice | null {
  // Control characters are refused on a write and stripped here too: the
  // environment is not checked, and the text reaches terminals and headers.
  let message = text("network.iran_notice")
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿<>]/g, "")
    .trim();
  // At most 400 characters, never half of one (a lone surrogate would make
  // encodeURIComponent throw), and well-formed whatever the source.
  message = Array.from(message).slice(0, 400).join("").replace(/[\ud800-\udfff]/g, (c, i, all) => (/[\ud800-\udbff]/.test(c) ? (/[\udc00-\udfff]/.test(all[i + 1] ?? "") ? c : "") : /[\ud800-\udbff]/.test(all[i - 1] ?? "") ? c : "")).trim();
  if (!message) return null;
  const end = text("network.iran_notice_expires");
  let expires: string | null = null;
  if (end) {
    const t = Date.parse(/T/.test(end) ? end : `${end}T00:00:00Z`);
    if (!Number.isFinite(t)) return null; // an end that does not read is not "for ever"
    if (t <= now) return null;
    expires = new Date(t).toISOString();
  }
  const a = text("network.iran_notice_action");
  const action = a in NOTICE_ACTIONS ? (a as NoticeAction) : null;
  const id = crypto.createHash("sha256").update(`${message}\n${action ?? ""}\n${expires ?? ""}`).digest("hex").slice(0, 12);
  return { id, message, action, command: action ? NOTICE_ACTIONS[action].command : null, expires };
}

/** The notice for this caller: only for a caller in Iran. */
export function noticeFor(h: HeaderSource | undefined, now: number = Date.now()): Notice | null {
  return h && fromIranHeaders(h) ? iranNotice(now) : null;
}

/** The notice as two header values (ASCII only: the message is
 *  percent-encoded), for X-Foldrun-Notice and X-Foldrun-Notice-Id. */
export function noticeHeaders(n: Notice | null): Record<string, string> {
  if (!n) return {};
  return { "x-foldrun-notice": encodeURIComponent(n.message), "x-foldrun-notice-id": n.id };
}
