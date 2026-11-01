#!/usr/bin/env bash
# The OAuth conformance suite (tests/e2e-oauth-keycloak.test.ts) against a
# throwaway Keycloak: start it on loopback, wait until it answers, run the
# suite, remove the container whatever happened. Needs Docker. Run on the box
# CI runner before a promotion (foldrun-infra .github/workflows/
# oauth-conformance.yml), or by hand:
#
#   bash scripts/oauth-conformance.sh
#
# The image is pinned to a version and digest; move both together.
set -euo pipefail

IMAGE="quay.io/keycloak/keycloak:26.8.1-0@sha256:79c623a22abacf3fe6c00a5fb30f5b7843d717b234033b80995891c06116d244"
NAME="foldrun-oauth-conformance-$$"
PORT="${KEYCLOAK_PORT:-18181}"
PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
here="$(cd "$(dirname "$0")/.." && pwd)"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$NAME" -p "127.0.0.1:${PORT}:8080" \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD="$PASSWORD" \
  "$IMAGE" start-dev >/dev/null

for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:${PORT}/realms/master/.well-known/openid-configuration" >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -fsS "http://127.0.0.1:${PORT}/realms/master/.well-known/openid-configuration" >/dev/null || { docker logs "$NAME" | tail -40; echo "Keycloak did not start" >&2; exit 1; }

cd "$here"
KEYCLOAK_URL="http://127.0.0.1:${PORT}" KEYCLOAK_ADMIN_PASSWORD="$PASSWORD" \
  node --test --test-reporter=spec tests/e2e-oauth-keycloak.test.ts
