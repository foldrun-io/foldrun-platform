#!/usr/bin/env node
// video — motion graphics and video as React code, rendered with Remotion
// (13 Nov 2026). The project is the author's (the agent writes src/); this
// program only scaffolds one, installs it, bundles it and renders it.
//
// Node API, checked against remotion.dev/docs/ssr-node on 13 Nov 2026:
//   bundle({ entryPoint })                          @remotion/bundler
//   ensureBrowser(), getCompositions(serveUrl),     @remotion/renderer
//   selectComposition(), renderStill(), renderMedia()
// Every package is loaded from the PROJECT's node_modules, so a project
// pins its own Remotion version and this file never imports one itself.
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { existsSync, mkdirSync, writeFileSync, statSync, realpathSync, lstatSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute, sep, extname, basename } from "node:path";
import { cpus } from "node:os";

/** The Remotion release the template pins — every @remotion/* package of a
 *  project must be the same version. */
const REMOTION = "4.0.543";
const CODECS = { h264: "mp4", h265: "mp4", vp8: "webm", vp9: "webm", gif: "gif", prores: "mov" };

class Fail extends Error {}

const { values } = parseArgs({
  options: {
    action: { type: "string" },
    project: { type: "string" },
    composition: { type: "string" },
    props: { type: "string" },
    frame: { type: "string" },
    frames: { type: "string" },
    codec: { type: "string" },
    out: { type: "string" },
    scale: { type: "string" },
    concurrency: { type: "string" },
  },
  strict: true,
  allowPositionals: false,
});

const action = (values.action ?? "").trim().toLowerCase();
const cwd = process.cwd();
// The workspace root: the agent runs in agents/<name>/, two levels down.
const workspaceRoot = resolve(cwd, "..", "..");

/** A path the agent wrote — `workspace/storage/…` or relative to its own
 *  folder — inside the workspace, or refused. */
function inside(rel, what) {
  const spelled = rel.replace(/^\.\//, "");
  const abs = spelled.startsWith("workspace/") ? resolve(workspaceRoot, spelled.slice("workspace/".length)) : resolve(cwd, spelled);
  const back = relative(workspaceRoot, abs);
  if (back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back)) throw new Fail(`${what} ${rel} is outside the workspace`);
  return confined(abs, workspaceRoot, `${what} ${rel}`);
}

/** The real path of `abs`, symlinks resolved, refused unless it is inside
 *  `root`. A part that does not exist yet is taken as written below its
 *  deepest existing parent; a link that leads nowhere is refused, because
 *  writing through it would land wherever it points (Codex review). */
function confined(abs, root, what) {
  const realRoot = realpathSync(root);
  const rest = [];
  let probe = abs;
  for (;;) {
    try { lstatSync(probe); break; } catch {}
    const up = dirname(probe);
    if (up === probe) break;
    rest.unshift(basename(probe));
    probe = up;
  }
  let base;
  try { base = realpathSync(probe); } catch { throw new Fail(`${what} goes through a link that leads nowhere`); }
  const real = rest.length ? join(base, ...rest) : base;
  const back = relative(realRoot, real);
  if (back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back)) throw new Fail(`${what} is outside the workspace`);
  return real;
}


/** How a path reads back to the agent: `workspace/…` when it is under the
 *  workspace, the way it is written everywhere else. */
const shown = (abs) => {
  const back = relative(realpathSync(workspaceRoot), abs).split(sep).join("/");
  return back.startsWith("..") ? abs : `workspace/${back}`;
};

const project = inside(values.project?.trim() || "workspace/storage/video", "project=");

function props() {
  if (!values.props) return {};
  try {
    const p = JSON.parse(values.props);
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("not an object");
    return p;
  } catch (err) {
    throw new Fail(`props= is not a JSON object (${err instanceof Error ? err.message : err}) — e.g. {"title":"Salam"}`);
  }
}

function run(cmd, args, where) {
  return new Promise((ok, no) => {
    // Its output is progress, not the answer: stderr, where the trail shows it.
    const child = spawn(cmd, args, { cwd: where, stdio: ["ignore", process.stderr, process.stderr], env: process.env });
    child.on("error", (err) => no(new Fail(`${cmd} could not start: ${err.message}`)));
    child.on("exit", (code) => (code === 0 ? ok() : no(new Fail(`${cmd} ${args.join(" ")} failed (exit ${code}) — its output is above`))));
  });
}

async function ensureInstalled() {
  if (!existsSync(join(project, "package.json"))) {
    throw new Fail(`${shown(project)} has no package.json — start one with video action=new project=${shown(project)}`);
  }
  const has = (pkg) => existsSync(join(project, "node_modules", ...pkg.split("/"), "package.json"));
  if (!has("@remotion/renderer") || !has("@remotion/bundler") || !has("remotion")) {
    console.error(`video: installing ${shown(project)}'s packages (first call only)…`);
    const lock = existsSync(join(project, "package-lock.json"));
    await run("npm", [lock ? "ci" : "install", "--no-audit", "--no-fund", "--loglevel=error"], project);
  }
  const req = createRequire(join(project, "package.json"));
  const load = async (name) => import(pathToFileURL(req.resolve(name)).href);
  const [bundler, renderer] = [await load("@remotion/bundler"), await load("@remotion/renderer")];
  return { bundler, renderer };
}

function entryPoint() {
  for (const f of ["src/index.ts", "src/index.tsx", "src/index.js", "src/index.jsx"]) {
    if (existsSync(join(project, f))) return join(project, f);
  }
  throw new Fail(`${shown(project)} has no src/index.ts — the file that calls registerRoot()`);
}

async function prepare() {
  const { bundler, renderer } = await ensureInstalled();
  // Chrome Headless Shell, Remotion's own build: downloaded once into the
  // project's node_modules, reused after.
  await renderer.ensureBrowser({ onBrowserDownload: () => { console.error("video: downloading Remotion's browser (first call only)…"); return { version: null, onProgress: () => {} }; } });
  console.error("video: bundling…");
  // Under node_modules, which a sandbox never copies back to the workspace:
  // the bundle is rebuilt from src/ on every call, and is megabytes.
  const serveUrl = await bundler.bundle({ entryPoint: entryPoint(), outDir: join(project, "node_modules", ".cache", "foldrun-video-bundle"), onProgress: () => {} });
  return { renderer, serveUrl };
}

async function pickComposition(renderer, serveUrl, inputProps) {
  const id = values.composition?.trim();
  if (id) {
    try {
      return await renderer.selectComposition({ serveUrl, id, inputProps, logLevel: "error" });
    } catch (err) {
      const all = await renderer.getCompositions(serveUrl, { inputProps, logLevel: "error" }).catch(() => []);
      throw new Fail(`no composition "${id}"${all.length ? ` — the project has ${all.map((c) => c.id).join(", ")}` : ""} (${err instanceof Error ? err.message.split("\n")[0] : err})`);
    }
  }
  const all = await renderer.getCompositions(serveUrl, { inputProps, logLevel: "error" });
  if (all.length === 1) return renderer.selectComposition({ serveUrl, id: all[0].id, inputProps, logLevel: "error" });
  if (!all.length) throw new Fail("the project registers no <Composition> — add one in src/Root.tsx");
  throw new Fail(`the project has ${all.length} compositions — say which with composition=: ${all.map((c) => c.id).join(", ")}`);
}

function scale() {
  if (values.scale === undefined) return 1;
  const s = Number(values.scale);
  if (!(s > 0 && s <= 4)) throw new Fail("scale= is a number above 0, at most 4 (0.5 = half size)");
  return s;
}

function outFile(fallback) {
  const abs = values.out ? inside(values.out, "out=") : confined(join(project, "out", fallback), workspaceRoot, "the project's out/");
  mkdirSync(dirname(abs), { recursive: true });
  return abs;
}

const size = (abs) => {
  const b = statSync(abs).size;
  return b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.ceil(b / 1e3)} KB`;
};

async function main() {
  if (action === "new") return scaffold();
  if (!["compositions", "still", "render"].includes(action)) {
    throw new Fail(`video needs action=: new, compositions, still or render (got "${values.action ?? ""}")`);
  }
  const inputProps = props();
  const { renderer, serveUrl } = await prepare();

  if (action === "compositions") {
    const all = await renderer.getCompositions(serveUrl, { inputProps, logLevel: "error" });
    if (!all.length) { console.log("The project registers no <Composition> — add one in src/Root.tsx."); return; }
    console.log(`Compositions in ${shown(project)}:\n\n${all.map((c) => `- ${c.id} — ${c.width}x${c.height}, ${c.fps} fps, ${c.durationInFrames} frames (${(c.durationInFrames / c.fps).toFixed(1)} s)`).join("\n")}`);
    return;
  }

  const composition = await pickComposition(renderer, serveUrl, inputProps);

  if (action === "still") {
    const frame = values.frame === undefined ? 0 : Number(values.frame);
    if (!Number.isInteger(frame) || frame < 0 || frame >= composition.durationInFrames) {
      throw new Fail(`frame= is a whole number from 0 to ${composition.durationInFrames - 1}`);
    }
    const output = outFile(`${composition.id}-${frame}.png`);
    await renderer.renderStill({ composition, serveUrl, output, frame, inputProps, scale: scale(), logLevel: "error" });
    console.log(`Frame ${frame} of ${composition.id} → ${shown(output)} (${size(output)}). Read it with the Read tool to look at it.`);
    return;
  }

  // render
  const codec = (values.codec ?? "h264").trim().toLowerCase();
  if (!CODECS[codec]) throw new Fail(`codec= is one of ${Object.keys(CODECS).join(", ")}`);
  let frameRange = null;
  if (values.frames) {
    const m = values.frames.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) throw new Fail("frames= is a range like 0-89, or one frame");
    frameRange = m[2] === undefined ? Number(m[1]) : [Number(m[1]), Number(m[2])];
    const last = Array.isArray(frameRange) ? frameRange[1] : frameRange;
    if (last >= composition.durationInFrames || (Array.isArray(frameRange) && frameRange[0] > frameRange[1])) {
      throw new Fail(`frames= must fall within 0-${composition.durationInFrames - 1}`);
    }
  }
  let concurrency = null;
  if (values.concurrency !== undefined) {
    concurrency = Number(values.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > Math.max(1, cpus().length * 2)) {
      throw new Fail(`concurrency= is a whole number from 1 to ${Math.max(1, cpus().length * 2)}`);
    }
  }
  const output = outFile(`${composition.id}.${CODECS[codec]}`);
  if (values.out && extname(output).slice(1) !== CODECS[codec]) {
    console.error(`video: note — codec ${codec} is usually saved as .${CODECS[codec]}, not ${extname(output) || "no extension"}`);
  }
  let lastTenth = -1;
  const started = Date.now();
  await renderer.renderMedia({
    composition, serveUrl, codec, outputLocation: output, inputProps, scale: scale(),
    ...(frameRange !== null ? { frameRange } : {}),
    ...(concurrency ? { concurrency } : {}),
    logLevel: "error",
    onProgress: ({ progress }) => {
      const tenth = Math.floor(progress * 10);
      if (tenth > lastTenth) { lastTenth = tenth; console.error(`video: ${tenth * 10}%`); }
    },
  });
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`Rendered ${composition.id} (${composition.width}x${composition.height}, ${composition.fps} fps, ${codec}) → ${shown(output)} (${size(output)}) in ${secs} s.`);
}

// ------------------------------------------------------------- new
//
// The template: one composition, a title card with a logo reveal, written
// to be read and changed. Persian text uses Vazirmatn from npm (bundled, never
// fetched from a font CDN at render time).

function scaffold() {
  if (existsSync(join(project, "package.json"))) {
    throw new Fail(`${shown(project)} already has a project — edit it, or pick another project=`);
  }
  const name = project.split(sep).pop().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "video";
  const files = {
    "package.json": JSON.stringify({
      name, private: true, type: "module",
      scripts: { studio: "remotion studio", render: "remotion render" },
      dependencies: {
        remotion: REMOTION, "@remotion/cli": REMOTION, "@remotion/bundler": REMOTION, "@remotion/renderer": REMOTION,
        react: "19.3.1", "react-dom": "19.3.1", "@fontsource-variable/vazirmatn": "5.3.0",
      },
      devDependencies: { typescript: "5.9.3", "@types/react": "19.3.0" },
    }, null, 2) + "\n",
    "tsconfig.json": JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx", strict: true, skipLibCheck: true, esModuleInterop: true, noEmit: true },
      include: ["src"],
    }, null, 2) + "\n",
    "remotion.config.ts": `import { Config } from "@remotion/cli/config";\n\n// Used by \`npx remotion studio\` / \`render\` on a laptop; the video tool sets\n// the same things itself.\nConfig.setVideoImageFormat("jpeg");\nConfig.setOverwriteOutput(true);\n`,
    ".gitignore": "node_modules/\nout/\n",
    "public/.keep": "",
    "src/index.ts": `import { registerRoot } from "remotion";\nimport { Root } from "./Root";\n\nregisterRoot(Root);\n`,
    "src/Root.tsx": `import "@fontsource-variable/vazirmatn";\nimport { Composition } from "remotion";\nimport { Intro, introSchema } from "./Intro";\n\n// Every video this project renders is one <Composition>. Its id is what\n// \`video action=render composition=…\` names; defaultProps are what\n// props= overrides.\nexport const Root = () => (\n  <Composition\n    id="intro"\n    component={Intro}\n    durationInFrames={150}\n    fps={30}\n    width={1920}\n    height={1080}\n    defaultProps={introSchema}\n  />\n);\n`,
    "src/Intro.tsx": `import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig, Sequence } from "remotion";\n\n// The input this composition takes — \`props={"title":"…"}\` on a render.\nexport const introSchema = {\n  title: "Build something beautiful",\n  subtitle: "چیزی زیبا بسازید",\n  accent: "#7c5cff",\n  background: "#0b0b12",\n};\n\nexport const Intro = ({ title, subtitle, accent, background }: typeof introSchema) => {\n  const frame = useCurrentFrame();\n  const { fps, durationInFrames } = useVideoConfig();\n\n  // Everything moves from the frame number: the same frame always draws the\n  // same picture, which is what lets frames render in parallel.\n  const pop = spring({ frame, fps, config: { damping: 14, mass: 0.8 } });\n  const rise = interpolate(frame, [10, 40], [40, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });\n  const fadeIn = interpolate(frame, [10, 40], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });\n  const fadeOut = interpolate(frame, [durationInFrames - 20, durationInFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });\n\n  return (\n    <AbsoluteFill style={{ background, alignItems: "center", justifyContent: "center", opacity: fadeOut, fontFamily: "'Vazirmatn Variable', system-ui, sans-serif" }}>\n      <div\n        style={{\n          width: 180, height: 180, borderRadius: 48, background: accent,\n          transform: \`scale(\${pop}) rotate(\${(1 - pop) * -90}deg)\`,\n          boxShadow: \`0 30px 120px \${accent}88\`,\n        }}\n      />\n      <h1 style={{ color: "white", fontSize: 96, fontWeight: 800, margin: "64px 0 0", letterSpacing: -2, transform: \`translateY(\${rise}px)\`, opacity: fadeIn }}>\n        {title}\n      </h1>\n      <Sequence from={30} layout="none">\n        <p dir="rtl" style={{ color: "#ffffffb3", fontSize: 52, margin: "24px 0 0", opacity: interpolate(frame, [30, 60], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>\n          {subtitle}\n        </p>\n      </Sequence>\n    </AbsoluteFill>\n  );\n};\n`,
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = confined(join(project, rel), workspaceRoot, `project= ${rel}`);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  console.log(
    `Started a video project in ${shown(project)} (Remotion ${REMOTION}):\n` +
      Object.keys(files).map((f) => `- ${f}`).join("\n") +
      `\n\nOne composition, "intro" — 1920x1080, 30 fps, 5 s. Edit src/Intro.tsx, then\n` +
      `video action=still project=${shown(project)} frame=45 to look at a frame, and\n` +
      `video action=render project=${shown(project)} for the video. Packages install on the first of those.`,
  );
}

main().catch((err) => {
  console.error(err instanceof Fail ? `video: ${err.message}` : `video: ${err?.stack ?? err}`);
  process.exit(1);
});
