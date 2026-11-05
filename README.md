# foldrun-platform

The engine that runs foldrun workspaces on a server: the run queue and its
worker, the scheduler, a sandbox per step (a pod on a cluster, or a container
on one machine), the egress proxy, accounts and roles, the vault, OAuth,
issues, graders and share links. The dashboard and HTTP API that drive it
are [foldrun-web](https://github.com/foldrun-io/foldrun-web); the format, the
runner and the checks are [`@foldrun/core`](https://www.npmjs.com/package/@foldrun/core).
To run all of it on one machine, see `foldrun-web/self-hosting`.

Source-available under the [Functional Source License 1.1, Apache 2.0 future
licence](LICENSE) — free for your own and your organisation's use, not for
offering foldrun to others as a service; [LICENSING.md](LICENSING.md) says
what is allowed. foldrun's hosted billing is not here: the engine reaches it
only through `src/billing.ts`, and without it nothing is charged.

| Module | What |
|---|---|
| `queue`, `queue-db`, `cache` | the run queue, its worker loop, Redis leases |
| `ledger`, `ledger-db`, `usage`, `limits` | what each run used and cost; spend budgets, queue lanes and concurrency |
| `settle`, `reservations`, `billing-metrics` | a run's cost recorded, retried if the write fails; a run's share of a budget held from admission to settle; the two gauges for the scrape |
| `billing` | the one door to foldrun's hosted billing (`billing()`); without it, `freeBilling` |
| `housekeeping` | the chores' lease — reapers, sweeps, the hourly accrual — separate from the scheduler's |
| `run-k8s` | a pod per step on a cluster |
| `account-pod`, `search-k8s`, `browser-k8s` | a service pod per account — search engine, browser — started on first use, reaped when idle |
| `db`, `tenant-keys`, `tenant-delete` | Postgres; per-account encryption keys; account deletion |
| `scheduler` | the cron loop and watches |
| `preview`, `shares`, `mirror` | branch previews, public share links, git mirrors |
| `permissions`, `ownership`, `scope`, `signup`, `avatars`, `gallery`, `demo-workspace`, `oauth-*`, `observe` | tenancy, roles, onboarding, OAuth, metrics |

It imports core by sibling path (`../foldrun-core/src/…`) — the repos sit side
by side, the layout is the wiring — and plugs in through core's
`src/platform.ts`. `src/index.ts` is the one call a platform process makes at
boot; core never imports this package.

```sh
npm ci
npm test          # 200+ tests, no cluster needed
npm run typecheck
npm run k8s       # the k8s executor end to end — on the box
```

### Tests that need Postgres, Redis or KMS

The database layer, the queue, the ledger, key minting, webhooks and the
egress proxy's Redis store are tested against the real thing when one is
offered, and skipped (saying so) when not. CI offers all of them on every
push and pull request (`.github/workflows/ci.yml`: Postgres 17 and Redis 7,
the images dev runs, plus local-kms and Playwright). On a laptop:

```sh
docker run -d --rm --name t-pg -e POSTGRES_USER=foldrun -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=foldrun -p 55432:5432 postgres:17-alpine
docker run -d --rm --name t-redis -p 56379:6379 redis:7-alpine
FOLDRUN_TEST_DATABASE_URL=postgres://foldrun:test@localhost:55432/foldrun \
FOLDRUN_TEST_REDIS_URL=redis://localhost:56379 npm test
FOLDRUN_REDIS_URL=redis://localhost:56379 node --test tests/delegate.test.ts tests/egress-role.test.ts
docker rm -f t-pg t-redis   # nothing is kept: the tests drop and truncate
```

| Variable | Runs |
|---|---|
| `FOLDRUN_TEST_DATABASE_URL` | migrations, queue fairness, the ledger, keys, users, webhooks, flags, status rows, the worker's boot |
| `FOLDRUN_TEST_REDIS_URL` | egress leases and OAuth rotation across replicas, the assistant's streams, the gallery sync lock |
| `FOLDRUN_TEST_KMS_URL` (+ `FOLDRUN_TEST_KMS_KEY`, default `alias/foldrun-test`) | account keys moved under KMS — `nsmithuk/local-kms` with that alias (the CI step makes it) |
| `FOLDRUN_REDIS_URL` | `delegate` and `egress-role` run whole on Redis instead of memory |
| `FOLDRUN_TEST_PLAYWRIGHT` | a folder with `playwright@1.63.0` and Chromium installed: the browser-pod drop test |

Files that use the database take turns (`tests/live-db-lock.ts`): one of
them drops every table, so a new one calls `takeTurnsOnLiveDb(url)` before
its first query. A database you keep is never the one to point these at.

CI also re-runs against core's main: foldrun-core's ci dispatches
`core-main` here when its main passes, and a nightly run catches a missed
one (Actions → ci → Run workflow takes a core ref).

## Git hooks

Problems are caught before the push, not in CI or the deploy. `.githooks/` is
versioned here and `npm install` (its `prepare` runs `sh .githooks/install.sh`) points `core.hooksPath` at it.

- **pre-commit** (seconds, staged files only): gitleaks with the deploy gate's
  config (`../foldrun-infra/.gitleaks.toml`), `node --check` on `.mjs`,
  `bash -n` + `shellcheck -S error` on `.sh`, YAML parse.
- **pre-push** (what CI and the deploy gate run): gitleaks over the commits being
  pushed and the pushed tree, then `npx tsc --noEmit -p .` and `npm test`. The checks run on a
  detached worktree of the pushed commit beside this checkout (sharing its
  `node_modules`), so uncommitted work here neither hides a failure nor
  causes one.

Hooks only read; they never format, stash or reset. Emergency bypass:
`SKIP_HOOKS=1 git push` (or `--no-verify`) — and say why in the commit or PR.
