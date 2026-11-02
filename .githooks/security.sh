#!/usr/bin/env bash
# The security gate every foldrun repo runs in CI — the same file in each,
# synced from foldrun-infra (dev/ci/repo-ci/sync.sh; a test fails on drift).
# GitHub Actions runs it for the public repos, CircleCI for the private ones
# (owner, 2 Nov 2026). Tools are pinned container images: nothing installed
# on the host, nothing to drift.
#
#   bash .githooks/security.sh [BASE]
#     BASE   the commit before the push: secrets are searched in BASE..HEAD
#            as well as the tree (unknown or absent: the tree only)
#
# Stages, each a failure on its own:
#   secrets  gitleaks over the pushed commits and the tree, with the deploy
#            gate's rules (.gitleaks.toml in infra, .githooks/gitleaks.toml
#            elsewhere — the same file)
#   sast     Semgrep CE (typescript, nodejs, secrets rulesets): an
#            ERROR-severity finding fails
#   deps     npm audit, high and above in what ships (--omit=dev), and the
#            registry signatures of every installed package
#   sbom     CycloneDX of the shipped npm dependencies → sbom/<app>.cdx.json
#            (CI keeps them as artifacts)
# npm stages run for every app with a package-lock.json (the root, and any
# first-level folder with its own), and need its node_modules (npm ci).
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 2

GITLEAKS_IMAGE="ghcr.io/gitleaks/gitleaks:v8.30.1"
SEMGREP_IMAGE="semgrep/semgrep:1.171.0"
CYCLONEDX="@cyclonedx/cyclonedx-npm@6.0.1"
BASE="${1:-}"
failed=0
fail() { echo "FAIL: $*" >&2; failed=1; }
uid="$(id -u):$(id -g)"

cfg=.gitleaks.toml
[ -f "$cfg" ] || cfg=.githooks/gitleaks.toml
[ -f "$cfg" ] || { echo "no gitleaks config (.gitleaks.toml or .githooks/gitleaks.toml)" >&2; exit 2; }

# The scanners run in containers that see the repo through a bind mount. A
# mount that shows them nothing (a Docker VM that does not share this path)
# would make every scan pass on an empty folder — refuse instead.
if ! docker run --rm --user "$uid" -v "$PWD:/scan:ro" --entrypoint /bin/sh "$GITLEAKS_IMAGE" -c "test -f /scan/$cfg" >/dev/null 2>&1; then
  echo "the scanners' containers cannot see this repo at $PWD (Docker does not share the path?) — refusing to report clean" >&2
  exit 2
fi

echo "==> secrets (gitleaks)"
gl() { docker run --rm --user "$uid" -v "$PWD:/scan:ro" -w /scan "$GITLEAKS_IMAGE" "$@" --config "/scan/$cfg" --no-banner --redact=100 --exit-code 1; }
if [ -n "$BASE" ] && [ "$BASE" != 0000000000000000000000000000000000000000 ] && git cat-file -e "$BASE^{commit}" 2>/dev/null; then
  gl git /scan --log-opts="$BASE..HEAD" || fail "gitleaks: a secret in the pushed commits ($BASE..HEAD)"
fi
gl dir /scan || fail "gitleaks: a secret in the tree"

echo "==> sast (semgrep)"
docker run --rm --user "$uid" -e HOME=/tmp -v "$PWD:/scan:ro" -w /scan "$SEMGREP_IMAGE" \
  semgrep scan --config p/typescript --config p/nodejs --config p/secrets \
    --severity ERROR --error --metrics=off --quiet \
    --exclude node_modules --exclude .next --exclude dist --exclude .astro \
    --exclude '*.test.ts' --exclude '*.test.mjs' --exclude tests --exclude test-results \
    /scan || fail "semgrep: an ERROR-severity finding"

# Every app in the repo: the root and any first-level folder with its own
# lockfile (foldrun-admin's console/). One SBOM each, in sbom/.
roots=""
[ -f package-lock.json ] && roots="."
for l in */package-lock.json; do
  [ -f "$l" ] || continue
  case "$l" in node_modules/*) continue ;; esac
  roots="$roots ${l%/package-lock.json}"
done
mkdir -p sbom
out="$PWD/sbom"
for root in $roots; do
  name=$( [ "$root" = . ] && basename "$PWD" || echo "$(basename "$PWD")-$root" )
  echo "==> deps ($root: npm audit, signatures)"
  if ! (cd "$root" && npm audit --audit-level=high --omit=dev >/dev/null 2>&1); then
    (cd "$root" && npm audit --audit-level=high --omit=dev 2>&1 | tail -40)
    fail "npm audit: a high or critical vulnerability in what $root ships"
  fi
  if [ -d "$root/node_modules" ]; then
    (cd "$root" && npm audit signatures >/dev/null 2>&1) || { (cd "$root" && npm audit signatures 2>&1 | tail -20); fail "npm audit signatures ($root): a registry signature or provenance does not verify"; }
    echo "==> sbom ($root: CycloneDX)"
    if (cd "$root" && npx --yes "$CYCLONEDX" --omit dev --output-format JSON --output-file "$out/$name.cdx.json" >/dev/null 2>&1); then
      echo "sbom/$name.cdx.json: $(grep -c '"bom-ref"' "$out/$name.cdx.json") components"
    else
      fail "cyclonedx ($root): no SBOM"
    fi
  else
    fail "$root has a lockfile but no node_modules: install it (npm ci) before the gate, or its signatures and SBOM go unchecked"
  fi
done

if [ "$failed" = 0 ]; then echo "security: clean"; else echo "security: FAILED" >&2; exit 1; fi
