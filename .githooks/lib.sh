# shellcheck shell=bash
# Shared by pre-commit and pre-push. The same file is in every foldrun repo;
# what differs per repo is .githooks/checks.sh.
#
# The rule for everything here: read only. A hook never formats, stashes,
# resets or writes a tracked file — other sessions may be working in the
# same checkout, and their uncommitted work is theirs.

ROOT=$(git rev-parse --show-toplevel)
REPO=$(basename "$ROOT")
HOOK=$(basename "$0")
PARENT=$(dirname "$ROOT")
FAILED=0
RESULTS=""
T0=$(date +%s)

say() { printf '[%s %s] %s\n' "$REPO" "$HOOK" "$*" >&2; }

# SKIP_HOOKS=1 git push  /  git push --no-verify — for emergencies, and say why.
if [ "${SKIP_HOOKS:-}" = 1 ]; then
  say "SKIP_HOOKS=1: every check SKIPPED. Say why in the commit message or PR."
  exit 0
fi

has() { command -v "$1" >/dev/null 2>&1; }

# The one gitleaks config the box's deploy gate uses (dev/ci/scan.sh).
gitleaks_config() {
  if [ -f "$ROOT/.gitleaks.toml" ]; then echo "$ROOT/.gitleaks.toml"   # foldrun-infra itself
  else echo "$PARENT/foldrun-infra/.gitleaks.toml"; fi
}

# Has this repo got a dev dependency installed? (eslint, prettier, …)
has_dep() {
  [ -x "$ROOT/node_modules/.bin/$1" ] && grep -q "\"$1\"" "$ROOT/package.json" 2>/dev/null
}

# step "name" command... — runs it, times it, keeps the tail of its output.
step() {
  local name=$1 s log rc; shift
  s=$(date +%s); log=$(mktemp)
  ( cd "$ROOT" && "$@" ) </dev/null >"$log" 2>&1; rc=$?
  local dt=$(( $(date +%s) - s ))
  if [ $rc = 0 ]; then
    RESULTS="$RESULTS
  ok    $name (${dt}s)"
  else
    FAILED=1
    RESULTS="$RESULTS
  FAIL  $name (${dt}s)"
    {
      echo "---- $name failed (exit $rc), last lines:"
      tail -n 60 "$log"
      echo "----"
    } >&2
  fi
  rm -f "$log"
}

# advisory "name" command... — reported, never blocks.
advisory() {
  local name=$1 s log rc; shift
  s=$(date +%s); log=$(mktemp)
  ( cd "$ROOT" && "$@" ) </dev/null >"$log" 2>&1; rc=$?
  local dt=$(( $(date +%s) - s ))
  if [ $rc = 0 ]; then RESULTS="$RESULTS
  ok    $name (${dt}s, advisory)"
  else RESULTS="$RESULTS
  warn  $name (${dt}s, advisory — not blocking; run it to see why)"; fi
  rm -f "$log"
}

skipped() { RESULTS="$RESULTS
  skip  $1 — $2"; }

finish() {
  {
    echo "[$REPO $HOOK] $(( $(date +%s) - T0 ))s$RESULTS"
    if [ $FAILED = 1 ]; then
      echo "[$REPO $HOOK] BLOCKED. Fix the failure above. Emergency only: SKIP_HOOKS=1 (or --no-verify), and say why."
    fi
  } >&2
  exit $FAILED
}

# ---- checks over the content of a blob (staged or committed), not the
# working tree, so a half-staged file is checked as it will be committed.

# blob_to_tmp <path> [ext] — the staged content of path, in a temp file.
blob_to_tmp() {
  local t; t=$(mktemp "${TMPDIR:-/tmp}/hook.XXXXXX")
  if [ -n "${2:-}" ]; then mv "$t" "$t.$2"; t="$t.$2"; fi
  git show ":$1" >"$t" 2>/dev/null
  echo "$t"
}

check_mjs() {   # node --check, each staged .mjs
  local f t out rc=0
  for f in "$@"; do
    t=$(blob_to_tmp "$f" mjs)
    out=$(node --check "$t" 2>&1) || { rc=1; echo "${out//$t/$f}"; }
    rm -f "$t"
  done
  return $rc
}

check_sh() {    # bash -n, and shellcheck at error severity when installed
  local f t out rc=0
  for f in "$@"; do
    t=$(blob_to_tmp "$f" sh)
    out=$(bash -n "$t" 2>&1) || { rc=1; echo "${out//$t/$f}"; }
    if has shellcheck; then
      out=$(shellcheck -S error "$t" 2>&1) || { rc=1; echo "${out//$t/$f}"; }
    fi
    rm -f "$t"
  done
  return $rc
}

check_yaml() {  # parses, every document in the file
  local f t out rc=0
  for f in "$@"; do
    t=$(blob_to_tmp "$f")
    out=$(python3 -c 'import sys,yaml; list(yaml.safe_load_all(open(sys.argv[1])))' "$t" 2>&1) \
      || { rc=1; echo "$f:"; echo "${out//$t/$f}"; }
    rm -f "$t"
  done
  return $rc
}

# eslint on staged files. A file with no unstaged edits is linted in place
# (one process for all of them); a half-staged one goes through stdin as
# staged. Errors fail, warnings print — the same bar as `npm run lint`.
check_eslint() {
  local f rc=0 whole=()
  for f in "$@"; do
    if git diff --quiet -- "$f"; then whole+=("$f")
    else git show ":$f" | npx --no-install eslint --no-warn-ignored --stdin --stdin-filename "$f" || rc=1
    fi
  done
  if [ ${#whole[@]} -gt 0 ]; then
    npx --no-install eslint --no-warn-ignored "${whole[@]}" || rc=1
  fi
  return $rc
}
