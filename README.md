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
