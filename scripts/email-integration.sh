#!/usr/bin/env bash
# Runs the @drefyn/email integration tests against four Mailpit containers on loopback.
# The certificates and the AUTH password are made fresh for each run and removed after,
# so no key or password is ever committed.
set -euo pipefail

top="$(git rev-parse --show-toplevel)"
cd "$top"
compose_file=scripts/email-integration/compose.yaml
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-drefyn-email-it}"

certs="$(mktemp -d "${TMPDIR:-/tmp}/drefyn-email-it.XXXXXX")"
export DREFYN_EMAIL_IT_CERTS="$certs"
compose() { docker compose -f "$compose_file" --profile test "$@"; }
cleanup() {
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$certs"
}
trap cleanup EXIT

# A throwaway CA, a server certificate it signs for localhost and 127.0.0.1, and a self
# signed certificate. Two days is far longer than any run.
key() { openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$1" 2>/dev/null; }
key "$certs/ca.key"
openssl req -x509 -new -key "$certs/ca.key" -out "$certs/ca.pem" -days 2 -subj "/CN=drefyn email test ca" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign"
key "$certs/server.key"
openssl req -new -key "$certs/server.key" -out "$certs/server.csr" -subj "/CN=localhost"
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' >"$certs/server.ext"
openssl x509 -req -in "$certs/server.csr" -CA "$certs/ca.pem" -CAkey "$certs/ca.key" -CAcreateserial \
  -out "$certs/server.pem" -days 2 -extfile "$certs/server.ext" 2>/dev/null
key "$certs/self.key"
openssl req -x509 -new -key "$certs/self.key" -out "$certs/self.pem" -days 2 -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
printf 'drefyn-test:%s\n' "$(openssl rand -hex 16)" >"$certs/auth.txt"
# Mailpit runs as its own user inside the container and reads these through the mount.
chmod 755 "$certs"
chmod 644 "$certs"/*

compose up -d --wait --wait-timeout 90
if ! pnpm --filter @drefyn/email test:integration; then
  compose logs --no-color --timestamps
  exit 1
fi
