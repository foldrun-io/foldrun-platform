---
name: cloudhost-deploy
description: Deploy a website or app to cloudhost (cloudhost.ir) — where it goes, how to configure it (cloudhost.toml, bindings, build), how a preview becomes production, and how to give it a SQL database, cache, bucket, secrets or a domain through cloudhost's MCP tools. Use whenever the workspace deploys to cloudhost or the person asks to put a site on cloudhost.
license: FSL-1.1-ALv2
metadata:
  maintainer: foldrun
  checked: "2026-11-13"
---

# Deploying to cloudhost

cloudhost is a serverless platform inside Iran: apps and functions at the
edge, with its own SQL database, cache, storage (buckets), secrets, queues
and flags, on one project. Your sandbox is outside Iran; the site you
deploy runs inside it. Read `references/config.md` before writing a
`cloudhost.toml`.

## What you deploy with

The workspace grants a **cloudhost MCP tool** (a remote MCP server holding
one project's key; the key never enters your sandbox). Everything below is
a call on it. At the start of a run:

1. Read its resources — the project's current config, recent versions, the
   runtime and API reference — before changing anything. They are the
   source of truth; this skill is the map.
2. List what the project has (`list_apps`, `list_environments`, and the
   resource lists) so you build on it instead of beside it.

The key reaches **one project**. Do not ask for another project's key, and
do not try to reach the API any other way.

## Where it goes

| | |
|---|---|
| A site or web app (Astro, Next.js, static) | an **app** (`deploy_app`) |
| An API or a small backend with no pages | a **function** (`deploy_function`) |
| Data | the project's **SQL database** (`create_database`), **cache** (`create_cache`), **bucket** (`create_bucket`), **secrets** (`set_secret`), **queue**, **flags** — bound to the app, never a connection string in code |
| Sign-in, email, SMS | not cloudhost products: write them into the app with the person's own provider, and ask which one |

Frameworks: **Astro** (prerendered pages are files, on-demand pages,
endpoints, middleware and actions are one function; bindings on
`Astro.locals`) and **Next.js** (static pages, SSR, route handlers,
middleware). Static output of any framework deploys as files. On Next.js,
ISR, the data cache and `next/image` optimisation may not be available on
the project yet — check the runtime reference; until they are, set
`images: { unoptimized: true }` and size images at build time.

## Previews first, production only when the person says

- **Every change goes to a preview.** A branch's deploy gets its own
  address (`<branch>--<app>`), its own database branch, cache and preview
  bucket. Nothing in a preview touches production data.
- **Production is the person's decision.** Deploying to production, adding
  a custom domain, a paid resource (a larger size, anything outside the
  plan's included use) or a top-up stops for their approval — say what
  changes since the live version and what it costs, then wait.
- Destructive changes (deleting a resource, a table, a branch, a domain)
  always ask, every time.

## The deploy loop

1. Build locally first: `npm ci && npm run build` must pass in your
   sandbox. A build that fails here fails there.
2. Deploy the preview (`deploy_app`, or the Git route the project uses).
3. Follow the build: `list_builds`, then `get_build_checks` — the build
   checks secrets in the code, writes an SBOM, and explains a failed build
   (a type error with file and line, a missing package or variable, out of
   memory). Fix and redeploy; never ask the person to fix a build.
4. Open the preview address with `web action=browse`: every page, phone
   and desktop width, console clean, nothing loaded from another host.
5. Report the preview address and what you checked. Production waits for
   the approval.

## Rules of the platform that shape the code

- **Packages come from cloudhost's mirror inside Iran.** Only dependencies
  from npm, pinned by a committed lockfile; no Git URLs, no install scripts
  that download from GitHub or a CDN. The internet outside Iran may not be
  reachable from the site's visitors either: **every font, script, icon and
  image is bundled** (the `modern-website` skill's rule 5).
- **Bindings, not connection strings.** Code reads `env.DB`, `env.CACHE`,
  `env.BUCKET` (on Astro, through `Astro.locals`), or the standard variables
  `DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`,
  `S3_SECRET_ACCESS_KEY`, `S3_BUCKET` — wired per environment at deploy, so
  the same code reaches a preview's copies and production's.
- **Secrets** are set with `set_secret`, never written in a file or in
  `cloudhost.toml`.
- **Database changes** go in migrations the build runs (`[build] release =`
  in `cloudhost.toml`), so deploying carries the schema, never preview data.
- **Memory**: a framework server gets 512 MB; heavy work (image processing,
  PDF generation) belongs at build time or in a queue consumer, not in a
  request.
- **Web standards first**: functions are `fetch(request, env, ctx)`
  handlers; Node built-ins are available through a compatibility layer, but
  prefer `fetch`, Web Crypto and streams.

## Talking to the person

cloudhost's customers see cloudhost only. In anything you say to them, use
cloudhost's product words — app, function, SQL database, cache, storage,
bucket, secrets, queue, flag — and never name the software underneath, the
vendors, or the model and platform you run on. In Persian, use the terms in
the workspace's glossary when it has one; do not invent a technical term.
