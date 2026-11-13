# cloudhost.toml and the build

As in cloudhost's runtime reference on 13 Nov 2026. The MCP server's
runtime resource is newer than this file: when they disagree, it wins.

## Detection first, config only to change it

A build reads the repository and writes a build plan; `cloudhost.toml`
changes any field of it. Usually an Astro or Next.js app needs no file:

| Step | Looks at | Decides |
|---|---|---|
| Root | `root` in `cloudhost.toml`, else the repo root; `pnpm-workspace.yaml`, `turbo.json`, `nx.json` | which folder is the app |
| Framework | `next` + `next.config.*` → Next.js; `astro` + `astro.config.*` → Astro; Vite, Hugo or a plain `index.html` → static; a module exporting `fetch` → a function | adapter and output |
| Package manager | the lockfile (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`), `packageManager` | install command |
| Versions | `.nvmrc`, `.node-version`, `engines` | Node version |
| Commands | `scripts.build` in `package.json` | build command |
| Test and release | only from `cloudhost.toml` | whether they run |

So: commit the lockfile, set `engines.node` (or `.nvmrc`), and keep a
`build` script.

## A cloudhost.toml

```toml
name = "shop"
runtime_date = "2026-11-01"   # pins runtime behaviour; move it forward on purpose

[vars]                        # plain configuration — never secrets
CURRENCY = "IRR"

[[db]]                        # the project's SQL database, as env.DB
binding = "DB"
database = "shop"

[triggers]
crons = ["0 3 * * *"]         # runs scheduled(); production only

[delivery]                    # optional; each has a default
compression = "auto"
frame = "sameorigin"          # or "deny", "off"

[build]
test = "npm test"                   # optional; a failure stops the deploy
release = "npx drizzle-kit migrate" # optional; runs before traffic moves
```

- A name in a binding is a resource of this project; another project's is
  `<project>/<name>` and needs a connection the person sets up.
- Bindings that exist: `vars`, `secrets` (read by name), `crons`, `db`,
  `cache`, `bucket`, `assets`, `services` (another app or function of the
  project), `queues` (producers and a `queue()` consumer), `flags`. One the
  project cannot have yet fails the deploy with a message naming it.
- `[delivery]` sets compression and the security headers every response
  carries (HSTS, nosniff, referrer policy, frame policy; `csp` here too).
  A header the app sets itself, or a `_headers` rule, wins.

## Static files, the app's function, and routing

For each request the edge looks for a file at that path first; if there is
one, it is served and no function runs. Otherwise the app's function runs
(Astro's on-demand pages, Next.js's server), else the SPA fallback or 404.
Order: `_redirects`, file, SPA page load, function, 404. `_headers` and
`_redirects` in the output set headers and redirects. A static app with
`/index.html` and no `/404.html` is a single-page app.

## Environments

| | Production | Preview (per branch) |
|---|---|---|
| App | the production version | `<branch>--<app>` |
| SQL database | the production branch | its own branch, from the seed branch |
| Cache | the cache | its own, empty |
| Bucket | the bucket | the shared preview bucket |
| Crons and schedules | run | do not run |
| Secrets, flags | production values | preview values |

Code never names an environment: bindings and the standard variables
follow it.
