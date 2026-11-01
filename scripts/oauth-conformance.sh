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
TLS_PORT="${KEYCLOAK_TLS_PORT:-18443}"
PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
here="$(cd "$(dirname "$0")/.." && pwd)"

CERTS="$(mktemp -d)"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$CERTS"; }
trap cleanup EXIT

# Mutual TLS (RFC 8705): a throwaway CA, Keycloak's https certificate for
# 127.0.0.1, and a client certificate it signs. Keycloak asks for client
# certificates on its https port and trusts this CA; the suite trusts it too.
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 -subj "/CN=foldrun-conformance-ca" \
  -keyout "$CERTS/ca.key" -out "$CERTS/ca.crt" 2>/dev/null
for who in server client; do
  cn=$([ "$who" = server ] && echo 127.0.0.1 || echo foldrun-client)
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=$cn" -keyout "$CERTS/$who.key" -out "$CERTS/$who.csr" 2>/dev/null
  printf 'subjectAltName=IP:127.0.0.1,DNS:localhost\n' > "$CERTS/$who.ext"
  openssl x509 -req -in "$CERTS/$who.csr" -CA "$CERTS/ca.crt" -CAkey "$CERTS/ca.key" -CAcreateserial -days 1 -extfile "$CERTS/$who.ext" -out "$CERTS/$who.crt" 2>/dev/null
done
# Keycloak runs as its own user: the folder must be traversable too.
chmod 755 "$CERTS"
chmod 644 "$CERTS"/*

docker run -d --name "$NAME" -p "127.0.0.1:${PORT}:8080" -p "127.0.0.1:${TLS_PORT}:8443" -v "$CERTS:/certs:ro" \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD="$PASSWORD" \
  "$IMAGE" start-dev --https-certificate-file=/certs/server.crt --https-certificate-key-file=/certs/server.key \
  --https-client-auth=request --truststore-paths=/certs/ca.crt >/dev/null

for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:${PORT}/realms/master/.well-known/openid-configuration" >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -fsS "http://127.0.0.1:${PORT}/realms/master/.well-known/openid-configuration" >/dev/null || { docker logs "$NAME" | tail -40; echo "Keycloak did not start" >&2; exit 1; }

cd "$here"
KEYCLOAK_URL="http://127.0.0.1:${PORT}" KEYCLOAK_ADMIN_PASSWORD="$PASSWORD" \
  KEYCLOAK_MTLS_URL="https://127.0.0.1:${TLS_PORT}" KEYCLOAK_CLIENT_CERT="$CERTS/client.crt" KEYCLOAK_CLIENT_KEY="$CERTS/client.key" \
  NODE_EXTRA_CA_CERTS="$CERTS/ca.crt" \
  node --test --test-reporter=spec tests/e2e-oauth-keycloak.test.ts
