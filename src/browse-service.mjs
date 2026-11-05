#!/usr/bin/env node
// The browse service (FOL-128 phase 2, foldrun-docs/proposals/browse-egress.md):
// the web tool's browse program, run outside the step's sandbox.
//
// One of these runs per browsing step, in a pod of its own on the runner
// image (foldrun-platform browse-service.ts makes it; there is no image of
// its own). Its program arrives in a ConfigMap beside this file — the
// PLATFORM's browse.mjs, the gallery's, never the account's copy — and every
// call runs it once, in a scratch tree that mirrors the step's workspace,
// with an environment this file builds: the step's browse settings and the
// secrets the call names, never a variable that steers Node, Chromium or
// the proxy. The browser it starts goes through the egress proxy's forward
// door under the step's own lease, so the proxy holds the step's network:
// list (or reports it) per connection; the pod's own network reaches the
// proxy and DNS, nothing else.
//
// Who may call: the egress proxy, from its /browse/<lease> door, which
// checked the lease. The pod is the lease's alone — FOLDRUN_BROWSE_LEASE_ID
// is the SHA-256 of that lease, and a call whose x-foldrun-lease does not
// hash to it is refused — and its network policy admits only the proxy.
//
// The wire, one call:
//   POST /call   x-foldrun-lease: <token>   body: JSON
//     { argv: [..], env: {..}, cwd: "agents/<name>", sha: "<sha256 of the
//       step's browse.mjs>", files: [{ path, data (base64) }] }
//   → anything but 200: the call did not start (the step may browse itself)
//   → 200, NDJSON: {t:"start"} · {t:"out"|"err", d} · {t:"file", path, d}
//     · {t:"exit", code}. A stream that ends without "exit" was cut off and
//     may have acted.
//
// Runs on the runner image's Node (22), no packages of its own.

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const PORT = Number(process.env.FOLDRUN_BROWSE_PORT) || 3100;
const LEASE_ID = (process.env.FOLDRUN_BROWSE_LEASE_ID ?? "").trim().toLowerCase();
const PROGRAM = process.env.FOLDRUN_BROWSE_PROGRAM || "/opt/foldrun-browse/browse.mjs";
const EGRESS = process.env.FOLDRUN_BROWSE_EGRESS ?? "";
const SCRATCH = process.env.FOLDRUN_BROWSE_SCRATCH || path.join(os.tmpdir(), "foldrun-browse");
const BODY_MAX = Number(process.env.FOLDRUN_BROWSE_BODY_MAX) || 96 * 1024 * 1024;
const FILES_MAX = Number(process.env.FOLDRUN_BROWSE_FILES_MAX) || 64 * 1024 * 1024;
const OUT_MAX = 8 * 1024 * 1024;
const CALL_MS = Number(process.env.FOLDRUN_BROWSE_CALL_MS) || 15 * 60_000;
const QUEUE_MAX = 4;

/** The browse program's own settings a call may carry (the agent's
 *  web.browse block, as the runtime spells it). Not here, on purpose: the
 *  account's browser pod (WS), the slim-image wiring (POD_*), vendors
 *  (VENDOR*, the old SESSION key), extensions, live sessions and CONFINED —
 *  the service does not serve those, or sets them itself. */
export const SETTINGS = new Set([
  "FOLDRUN_BROWSER_ALLOWED_DOMAINS", "FOLDRUN_BROWSER_BOUNDARIES", "FOLDRUN_BROWSER_COOKIES", "FOLDRUN_BROWSER_COOKIE_DOMAIN",
  "FOLDRUN_BROWSER_DENY", "FOLDRUN_BROWSER_DEVICE", "FOLDRUN_BROWSER_ENGINE", "FOLDRUN_BROWSER_HEADLESS",
  "FOLDRUN_BROWSER_IDENTITIES", "FOLDRUN_BROWSER_IGNORE_HTTPS_ERRORS", "FOLDRUN_BROWSER_INIT", "FOLDRUN_BROWSER_LIVE_VIEW",
  "FOLDRUN_BROWSER_LOCALE", "FOLDRUN_BROWSER_STATE", "FOLDRUN_BROWSER_STATE_KEY", "FOLDRUN_BROWSER_STORAGE",
  "FOLDRUN_BROWSER_STORAGE_ORIGIN", "FOLDRUN_BROWSER_TIMEZONE", "FOLDRUN_BROWSER_USER_AGENT", "FOLDRUN_BROWSER_VERSION",
  "FOLDRUN_BROWSER_VIDEO", "FOLDRUN_BROWSER_WEBGPU", "FOLDRUN_AGENT", "FOLDRUN_LANGUAGE", "FOLDRUN_CAPTCHA_API",
]);

/** A secret's name, as browse.mjs reads one (cookies=, auth=, state_key=,
 *  ${NAME} in headers, a login) — and never one that steers a program. */
const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
const RESERVED = /^(FOLDRUN_|NODE_|NPM_|LD_|DYLD_|PLAYWRIGHT|PW_|CHROM|GOOGLE_CHROME|PYTHON|SSL_|XDG_|GIT_|DEBUG|LANG|LC_|TZ$|DISPLAY|HTTPS?_|ALL_PROXY|NO_PROXY|FTP_|UV_|GLIBC|MALLOC|OPENSSL|CURL_|REQUESTS_|DBUS|FONTCONFIG|GTK|QT_|LIBGL|MESA|VK_|GALLIUM|WAYLAND|PULSE|ELECTRON|TEMP$|TMP|HOME$|PATH$|SHELL$|USER$|LOGNAME$|PWD$|OLDPWD$|IFS$|ENV$|BASH|ZDOTDIR|EDITOR|PAGER|BROWSER$|TERM)/;

/** The environment one call runs with: a fixed base, the settings and
 *  secrets the call sent that pass the lists above, then what the service
 *  alone decides — the proxy under the lease, the live-view door, CONFINED
 *  (the browser takes the proxy as launch options and refuses what cannot
 *  go through it) and SERVICE_SIDE. */
export function callEnv(sent, token, opts = {}) {
  const env = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp/home",
    TMPDIR: opts.tmp ?? os.tmpdir(),
    ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
  };
  // The service's own (the runner image's), never the call's: where its
  // browsers and global Playwright are, and the locale.
  for (const k of ["PLAYWRIGHT_BROWSERS_PATH", "NODE_PATH", "LANG", "LC_ALL"]) if (process.env[k]) env[k] = process.env[k];
  const dropped = [];
  for (const [k, v] of Object.entries(sent && typeof sent === "object" ? sent : {})) {
    if (typeof v !== "string" || v.length > 256 * 1024) { dropped.push(k); continue; }
    if (SETTINGS.has(k) || (SECRET_NAME.test(k) && !RESERVED.test(k) && !k.endsWith("_PROXY"))) env[k] = v;
    else dropped.push(k);
  }
  const egress = opts.egress ?? EGRESS;
  const u = new URL(egress);
  const door = `${u.protocol}//foldrun:${token}@${u.host}`;
  Object.assign(env, {
    HTTPS_PROXY: door, HTTP_PROXY: door, https_proxy: door, http_proxy: door,
    // The service's own calls (none, today) and the live-view frames go to
    // the proxy by name; the browser takes the door as launch options.
    NO_PROXY: u.hostname, no_proxy: u.hostname,
    FOLDRUN_EGRESS: `${egress.replace(/\/+$/, "")}/e/${token}`,
    FOLDRUN_BROWSER_CONFINED: "1",
    FOLDRUN_BROWSE_SERVICE_SIDE: "1",
    ...(opts.ca ? { FOLDRUN_EGRESS_CA: opts.ca } : {}),
  });
  return { env, dropped };
}

/** A path inside the mirrored workspace: relative, no `..`, no empty or
 *  dot segments, nothing that Node or a package manager would load. */
export function safeRel(p) {
  if (typeof p !== "string" || !p || p.length > 512 || p.includes("\0") || p.includes("\\")) return null;
  if (path.posix.isAbsolute(p)) return null;
  const parts = p.split("/");
  if (parts.some((s) => !s || s === "." || s === ".." || s === "node_modules" || s === ".npmrc" || s === "package.json")) return null;
  return parts.join("/");
}

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

function leaseMatches(token) {
  if (!LEASE_ID || typeof token !== "string" || !/^[A-Za-z0-9_-]{16,}$/.test(token)) return false;
  const a = Buffer.from(sha256(token), "hex");
  const b = Buffer.from(LEASE_ID, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Every regular file under `dir`, relative, symlinks skipped (never followed). */
function walk(dir, base = dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) walk(abs, base, out);
    else if (e.isFile()) out.push(path.relative(base, abs).split(path.sep).join("/"));
  }
  return out;
}

/** Lay the call's files down under `root`; null when one is refused. */
export function layDown(root, files) {
  const hashes = new Map();
  let total = 0;
  for (const f of Array.isArray(files) ? files : []) {
    const rel = safeRel(f?.path);
    if (!rel || typeof f.data !== "string") return { error: `browse service: refused a file path (${String(f?.path).slice(0, 80)})` };
    const buf = Buffer.from(f.data, "base64");
    total += buf.length;
    if (total > FILES_MAX) return { error: `browse service: the call's files are over ${FILES_MAX} bytes` };
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf, { mode: 0o600 });
    hashes.set(rel, sha256(buf));
  }
  return { hashes };
}

let queue = Promise.resolve();
let waiting = 0;

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > BODY_MAX) throw Object.assign(new Error(`a call is at most ${BODY_MAX} bytes`), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function refuse(res, status, message) {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { type: "browse", message } }));
}

async function call(req, res) {
  const token = String(req.headers["x-foldrun-lease"] ?? "");
  if (!leaseMatches(token)) return refuse(res, 403, "browse service: this pod serves another step's lease");
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    return refuse(res, err.status ?? 400, `browse service: ${err.status ? err.message : "the body is JSON {argv, env, cwd, sha, files}"}`);
  }
  const argv = body?.argv;
  if (!Array.isArray(argv) || argv.length > 400 || !argv.every((a) => typeof a === "string") || argv.join("").length > 2 * 1024 * 1024) {
    return refuse(res, 400, "browse service: argv is a list of strings");
  }
  const cwdRel = body.cwd === "" ? "" : safeRel(body.cwd);
  if (cwdRel === null) return refuse(res, 400, "browse service: cwd is a path inside the workspace");
  let program;
  try { program = fs.readFileSync(PROGRAM); } catch { return refuse(res, 503, "browse service: its browse program is not mounted"); }
  // The step's copy of the tool is not the platform's (an account edited it,
  // or a deploy is half way): the step runs its own, as before the service.
  if (body.sha !== sha256(program)) return refuse(res, 409, "browse service: this step's browse program differs from the platform's");
  if (waiting >= QUEUE_MAX) return refuse(res, 429, "browse service: too many calls waiting");
  waiting++;
  // A caller that left while its call waited: the call never starts.
  const gone = { yes: false };
  res.on("close", () => { if (!res.writableEnded) gone.yes = true; });
  const turn = queue.then(() => (gone.yes || res.destroyed ? undefined : run(req, res, { argv, cwdRel, body, token, gone })));
  queue = turn.catch(() => undefined).finally(() => { waiting--; });
  await turn;
}

async function run(req, res, { argv, cwdRel, body, token, gone }) {
  fs.mkdirSync(SCRATCH, { recursive: true, mode: 0o700 });
  const scratch = fs.mkdtempSync(path.join(SCRATCH, "call-"));
  const root = path.join(scratch, "w");
  const tmp = path.join(scratch, "tmp");
  try {
    fs.mkdirSync(tmp, { recursive: true });
    fs.mkdirSync(root, { recursive: true });
    const laid = layDown(root, body.files);
    if (laid.error) return refuse(res, 400, laid.error);
    // The workspace root as browse.mjs finds it: the nearest AGENTS.md.
    if (!fs.existsSync(path.join(root, "AGENTS.md"))) fs.writeFileSync(path.join(root, "AGENTS.md"), "");
    const cwd = path.join(root, cwdRel);
    fs.mkdirSync(cwd, { recursive: true });
    const ca = typeof req.headers["x-foldrun-egress-ca"] === "string" ? req.headers["x-foldrun-egress-ca"] : undefined;
    const { env, dropped } = callEnv(body.env, token, { tmp, ca });
    if (gone.yes || res.destroyed) return;
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    const send = (o) => { if (!res.destroyed) res.write(JSON.stringify(o) + "\n"); };
    send({ t: "start", ...(dropped.length ? { dropped } : {}) });
    const child = spawn(process.execPath, [PROGRAM, ...argv], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = 0;
    const pass = (t) => (d) => {
      out += d.length;
      if (out <= OUT_MAX) send({ t, d: d.toString("base64") });
    };
    child.stdout.on("data", pass("out"));
    child.stderr.on("data", pass("err"));
    // The caller gone (the step stopped, the proxy dropped it) or out of
    // time: the call's whole process group goes — browse.mjs leaves through
    // its exit handlers on SIGTERM and Playwright closes what it launched.
    const kill = () => {
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 3_000);
    };
    const timer = setTimeout(kill, CALL_MS);
    res.on("close", () => { if (child.exitCode === null && child.signalCode === null) kill(); });
    if (gone.yes) kill();
    const code = await new Promise((ok) => child.on("close", (c, sig) => ok(c ?? (sig ? 1 : 0))));
    clearTimeout(timer);
    if (out > OUT_MAX) send({ t: "err", d: Buffer.from(`\nbrowse service: output past ${OUT_MAX} bytes was dropped\n`).toString("base64") });
    // What the call wrote or changed, back to the step, inside the tree.
    let sent = 0;
    for (const rel of walk(root)) {
      if (rel.startsWith(`${cwdRel ? `${cwdRel}/` : ""}outputs/.browser/.video-tmp/`)) continue;
      const buf = fs.readFileSync(path.join(root, rel));
      if (laid.hashes.get(rel) === sha256(buf)) continue;
      if (rel === "AGENTS.md" && !laid.hashes.has(rel) && !buf.length) continue;
      sent += buf.length;
      if (sent > FILES_MAX) { send({ t: "err", d: Buffer.from(`browse service: ${rel} and later files not returned — over ${FILES_MAX} bytes\n`).toString("base64") }); break; }
      send({ t: "file", path: rel, d: buf.toString("base64") });
    }
    // Gone before the caller hears the end: nothing of the call outlives it.
    fs.rmSync(scratch, { recursive: true, force: true });
    send({ t: "exit", code });
    res.end();
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export function startBrowseService(port = PORT) {
  const server = http.createServer((req, res) => {
    const url = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && url === "/healthz") { res.writeHead(200).end("ok"); return; }
    if (req.method !== "POST" || url !== "/call") return refuse(res, 404, "browse service: POST /call");
    call(req, res).catch((err) => {
      if (!res.headersSent) refuse(res, 500, `browse service: ${err?.message ?? err}`);
      else res.end();
    });
  });
  return new Promise((ok) => server.listen(port, "0.0.0.0", () => ok(server)));
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  if (!LEASE_ID || !EGRESS) {
    console.error("browse service: FOLDRUN_BROWSE_LEASE_ID and FOLDRUN_BROWSE_EGRESS are required");
    process.exit(1);
  }
  const s = await startBrowseService();
  console.error("browse service: listening");
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => s.close(() => process.exit(0)));
}
