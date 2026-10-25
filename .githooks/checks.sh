# shellcheck shell=bash
# What pre-push runs in this repo, after the gitleaks scans in pre-push.
# Mirror CI (.github/workflows) and the box deploy gate; keep it read only.
repo_checks() {
  # The pushed commit carries no billing (the worktree's HEAD is that commit).
  step "billing stays out (scripts/billing-guard.mjs)" node scripts/billing-guard.mjs HEAD
  # Migrations added since the deployed platform (../foldrun-infra's newest
  # box version tag) must work with the previous release's code.
  step "migration guard (scripts/migration-guard.mjs)" node scripts/migration-guard.mjs
  step "typecheck (npx tsc --noEmit -p .)" npx --no-install tsc --noEmit -p .
  step "tests (npm test)" npm test
}
