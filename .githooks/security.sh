#!/usr/bin/env bash
# The security gate every foldrun repo runs in CI — the same file in each,
# synced from foldrun-infra (dev/ci/repo-ci/sync.sh; a test fails on drift).
# GitHub Actions runs it in every repo: on GitHub's runners for the public
# ones, on foldrun's own EC2 runner (label foldrun-ci) for the private ones
# (owner, 2 Nov 2026; CircleCI removed 27 Nov 2026, FOL-404). Tools are
# pinned container images: nothing installed on the host, nothing to drift.
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
# The npm that verifies registry signatures, whatever npm the job's Node
# brought. npm 10.9.x (Node 22's) throws EMISSINGSIGNATUREKEY when the
# registry answers a package's attestations with the keyless provenance
# bundle alone: its check asks for a registry key even though that bundle
# carries its own certificate (npm/pacote#454, fixed in pacote 21.4.0, in
# npm from 11.11.0). Needs Node 20.17+ or 22.9+. It is the verifier itself, so
# its bytes are pinned too: the sha512 the registry publishes for the tarball
# (`npm view npm@<version> dist.integrity`), read once when the pin is raised.
NPM_SIGNATURES="npm@11.21.3"
NPM_SIGNATURES_SHA512="sha512-5Cf+jE+XctbhH/zjOOqXC+ity7eec/Tkk4Ql38tf6w+1htp2wYPHmE4c1R1Es3DY227Ac14+SLrlYJwkBicbTg=="
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
# The pinned npm is fetched once per run into a folder of this run's own,
# checked against its sha512 and run straight from the unpacked tarball (npm
# ships with everything it needs inside). Not `npx npm@…`: npx keeps one
# shared folder per package (~/.npm/_npx) and two jobs on one CI machine
# installing into it at once break each other (ENOTEMPTY, "Cannot find module
# '../lib/cli.js'": admin, site and brand on 28 Nov 2026; npm/cli#8224, fixed
# in npm 11.6.1, which Node 22's npm is not). The download cache under ~/.npm
# is still shared: that one is made for it.
pinned_dir=; PINNED_NPM=; pinned_state=
pinned_npm() { # sets PINNED_NPM; pinned_state = ready | unavailable | tampered. Call it outside $( ).
  [ -n "$pinned_state" ] && return 0
  local base=${TMPDIR:-/tmp} try got
  case "$base" in /*) ;; *) base="$PWD/$base" ;; esac
  pinned_state=unavailable
  pinned_dir=$(mktemp -d "$base/npm-signatures.XXXXXX") || { pinned_dir=; return 0; }
  for try in 1 2 3; do
    (cd "$pinned_dir" && npm pack "$NPM_SIGNATURES" --silent >/dev/null 2>pack.err) && break
    [ "$try" -lt 3 ] && sleep $((try * 10))
  done
  set -- "$pinned_dir"/npm-*.tgz
  [ -f "$1" ] || { tail -5 "$pinned_dir/pack.err" 2>/dev/null; return 0; }
  got=$(node -e 'const c=require("crypto"),f=require("fs");process.stdout.write("sha512-"+c.createHash("sha512").update(f.readFileSync(process.argv[1])).digest("base64"))' "$1") || return 0
  [ "$got" = "$NPM_SIGNATURES_SHA512" ] || { echo "$NPM_SIGNATURES: got $got, pinned $NPM_SIGNATURES_SHA512"; pinned_state=tampered; return 0; }
  tar -xzf "$1" -C "$pinned_dir" && [ -f "$pinned_dir/package/bin/npm-cli.js" ] || return 0
  PINNED_NPM="$pinned_dir/package/bin/npm-cli.js"; pinned_state=ready
}
trap '[ -z "$pinned_dir" ] || rm -rf "$pinned_dir"' EXIT
for root in $roots; do
  name=$( [ "$root" = . ] && basename "$PWD" || echo "$(basename "$PWD")-$root" )
  echo "==> deps ($root: npm audit, signatures)"
  # npm's error-code lines that mean the registry did not answer properly.
  UNAVAILABLE='^npm error code (EMISSINGSIGNATUREKEY|FETCH_ERROR|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|E429|E50[0234])[[:space:]]*$'
  # A finding is npm's list of advisories. A registry that did not answer
  # (seen with four jobs asking at once, 28 Nov 2026) is asked again; any
  # other npm error (a lockfile it cannot read) is said as what it is.
  aud_ok=
  for try in 1 2 3; do
    aud=$(cd "$root" && NO_COLOR=1 FORCE_COLOR=0 npm_config_color=false npm audit --audit-level=high --omit=dev 2>&1) && { aud_ok=1; break; }
    grep -Eq "$UNAVAILABLE" <<<"$aud" || break
    [ "$try" -lt 3 ] && sleep $((try * 10))
  done
  if [ -z "$aud_ok" ]; then
    tail -40 <<<"$aud"
    if grep -Eq "$UNAVAILABLE" <<<"$aud"; then fail "npm audit ($root): unavailable — the registry did not answer in 3 tries; the check did not complete, run the job again"
    elif grep -q '^npm error' <<<"$aud"; then fail "npm audit ($root): npm could not run the check (its error is above); nothing was checked"
    else fail "npm audit: a high or critical vulnerability in what $root ships"; fi
  fi
  if [ -d "$root/node_modules" ]; then
    # Three outcomes, told apart by npm's own error code line:
    #   verified      every package's registry signature and provenance hold
    #   unavailable   the check did not complete, which is not a bad
    #                 signature: a key the registry did not send
    #                 (EMISSINGSIGNATUREKEY), an answer that is not JSON or
    #                 none at all (FETCH_ERROR and the network codes; `200
    #                 text/plain "OK"` from the attestations endpoint was seen
    #                 on 27-28 Nov 2026). Asked again, 4 times in all with a
    #                 longer wait each time
    #   not verified  anything else, at once: a signature or provenance that
    #                 does not verify, a missing signature, an error npm has
    #                 no code for here
    # Every failure stops the gate; the message says which it was. Observed
    # before the pinned npm: tailwindcss@4.3.4 failed 5 of 7 web runs on
    # 16 Nov 2026 and four runs in web and admin on 27-28 Nov, each with an
    # unchanged lockfile that verified minutes later.
    pinned_npm
    if [ "$pinned_state" = tampered ]; then
      fail "npm audit signatures ($root): the verifier ($NPM_SIGNATURES) is not the bytes that were pinned; nothing was verified. Do not run the job again before finding out why"
    elif [ "$pinned_state" != ready ]; then
      fail "npm audit signatures ($root): verification unavailable — could not fetch the verifier ($NPM_SIGNATURES); the check did not run, run the job again"
    else
      sig_ok=; sig_unavailable=
      for try in 1 2 3 4; do
        # No colour: npm styles the word "code" apart from its value, and the
        # escape between them would hide the code from the match below.
        sig=$(cd "$root" && NO_COLOR=1 FORCE_COLOR=0 npm_config_color=false node "$PINNED_NPM" audit signatures 2>&1) && { sig_ok=1; break; }
        sig_unavailable=
        grep -Eq "$UNAVAILABLE" <<<"$sig" || break
        sig_unavailable=1
        [ "$try" -lt 4 ] && { echo "npm audit signatures ($root): the registry did not answer properly (try $try of 4), asking again"; sleep $((try * 20)); }
      done
      if [ -z "$sig_ok" ]; then
        tail -20 <<<"$sig"
        if grep -Eq '^npm error code EMISSINGSIGNATUREKEY[[:space:]]*$' <<<"$sig"; then fail "npm audit signatures ($root): no key for a signature in 4 tries — the registry did not send the key, or a package is signed with a key the registry does not publish. Run the job again; if it fails the same way, look at the package named above before anything ships"
        elif [ -n "$sig_unavailable" ]; then fail "npm audit signatures ($root): verification unavailable — the registry did not answer properly in 4 tries; the check did not complete, run the job again"
        else fail "npm audit signatures ($root): a registry signature or provenance does not verify (npm's own words are above)"; fi
      fi
    fi
    # The SBOM tool runs through the pinned npm too: its `exec` locks the
    # shared folder, Node 22's `npx` does not (same race), so there is no
    # falling back to npx when the pinned npm is missing.
    echo "==> sbom ($root: CycloneDX)"
    if [ "$pinned_state" != ready ]; then
      fail "cyclonedx ($root): no SBOM — it runs through the pinned npm, which is missing (above)"
    elif (cd "$root" && node "$PINNED_NPM" exec --yes -- "$CYCLONEDX" --omit dev --output-format JSON --output-file "$out/$name.cdx.json" >/dev/null 2>&1); then
      echo "sbom/$name.cdx.json: $(grep -c '"bom-ref"' "$out/$name.cdx.json") components"
    else
      fail "cyclonedx ($root): no SBOM"
    fi
  else
    fail "$root has a lockfile but no node_modules: install it (npm ci) before the gate, or its signatures and SBOM go unchecked"
  fi
done

if [ "$failed" = 0 ]; then echo "security: clean"; else echo "security: FAILED" >&2; exit 1; fi
