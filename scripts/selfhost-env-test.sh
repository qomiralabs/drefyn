#!/usr/bin/env bash
# Proves the installer generates the auth keys once, in the right shape, and never prints a
# value. Needs no Docker: a fake docker on PATH fails every call, so up stops at the project
# guard, right after it wrote deploy/.env. Runs in a scratch copy of the checkout, so the
# real deploy/.env is never read or written.
set -euo pipefail

src="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
root="$scratch/checkout"
mkdir -p "$root" "$scratch/bin"
cp -R "$src/scripts" "$src/deploy" "$root/"
rm -f "$root/deploy/.env"
env_file="$root/deploy/.env"
printf '#!/bin/sh\necho "fake docker: not available in this test" >&2\nexit 1\n' >"$scratch/bin/docker"
chmod +x "$scratch/bin/docker"

KEYS="DREFYN_AUTH_SECRET DREFYN_AUTH_INVITATION_BLOCK_KEY DREFYN_API_RATE_LIMIT_KEY"

failures=0
pass() { printf 'ok    %s\n' "$1"; }
fail() {
  printf 'FAIL  %s\n' "$1"
  if [ -n "${2:-}" ]; then printf '      %s\n' "$2"; fi
  failures=$((failures + 1))
}

# up with only the fake docker. Output goes to a file so every case can search it.
up() {
  local out="$1"
  if PATH="$scratch/bin:$PATH" bash "$root/scripts/selfhost.sh" up >"$out" 2>&1; then
    fail "up stops at the guard when docker fails" "it exited 0"
  fi
}

value_of() { sed -n "s/^$1=//p" "$env_file"; }

# Exactly 32 bytes as canonical unpadded base64url: 43 characters, and the last one carries
# two spare bits that must be zero, so each key has one spelling.
is_key() {
  local v="$1" bytes
  [[ "$v" =~ ^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$ ]] || return 1
  bytes="$(printf '%s=' "$v" | tr -- '-_' '+/' | base64 --decode 2>/dev/null | wc -c | tr -d ' ')"
  [ "$bytes" = 32 ]
}

# Any generated value in any output fails, whole or as its first 12 characters.
no_value_in() {
  local file="$1" key v leaked=""
  for key in $KEYS DREFYN_AUTH_PASSWORD; do
    v="$(value_of "$key")"
    if [ -n "$v" ] && grep -qF -- "${v:0:12}" "$file"; then leaked+=" $key"; fi
  done
  [ -z "$leaked" ] || {
    echo "$leaked"
    return 1
  }
}

out1="$scratch/first.out"
up "$out1"
if [ -f "$env_file" ] && [ -n "$(find "$env_file" -prune -perm 600)" ]; then
  pass "a first up writes deploy/.env with mode 600"
else
  fail "a first up writes deploy/.env with mode 600" "$(ls -l "$env_file" 2>&1)"
fi

for key in $KEYS; do
  v="$(value_of "$key")"
  if [ "$(grep -c "^$key=" "$env_file")" = 1 ] && is_key "$v"; then
    pass "$key is generated once as 32 random bytes in unpadded base64url"
  else
    fail "$key is generated once as 32 random bytes in unpadded base64url" "length ${#v}"
  fi
done

distinct="$(for key in $KEYS; do value_of "$key"; done | sort -u | grep -c . || true)"
if [ "$distinct" = 3 ]; then
  pass "the three keys differ from one another"
else
  fail "the three keys differ from one another"
fi

if leaked="$(no_value_in "$out1")"; then
  pass "up prints no generated value"
else
  fail "up prints no generated value" "found:$leaked"
fi

before="$(cksum <"$env_file")"
out2="$scratch/second.out"
up "$out2"
if [ "$(cksum <"$env_file")" = "$before" ]; then
  pass "a second up leaves every key as the first wrote it"
else
  fail "a second up leaves every key as the first wrote it"
fi

# A deploy/.env from before these keys existed: up appends them and changes nothing else.
old="$scratch/old.env"
grep -vE "^(DREFYN_AUTH_SECRET|DREFYN_AUTH_INVITATION_BLOCK_KEY|DREFYN_API_RATE_LIMIT_KEY)=" \
  "$env_file" >"$old"
cp "$old" "$env_file"
chmod 600 "$env_file"
out3="$scratch/older.out"
up "$out3"
if [ "$(head -n "$(wc -l <"$old")" "$env_file" | cksum)" = "$(cksum <"$old")" ]; then
  pass "an older deploy/.env keeps every line it had"
else
  fail "an older deploy/.env keeps every line it had"
fi
added=0
for key in $KEYS; do
  if is_key "$(value_of "$key")"; then added=$((added + 1)); fi
done
if [ "$added" = 3 ] && grep -q "added a generated" "$out3"; then
  pass "an older deploy/.env gets the three keys appended, named in the output"
else
  fail "an older deploy/.env gets the three keys appended, named in the output" "$(cat "$out3")"
fi
if leaked="$(no_value_in "$out3")"; then
  pass "appending keys prints no value"
else
  fail "appending keys prints no value" "found:$leaked"
fi

# The block key is never replaced once written: rotating it lifts every invitation block.
block="$(value_of DREFYN_AUTH_INVITATION_BLOCK_KEY)"
up "$scratch/again.out"
if [ "$(value_of DREFYN_AUTH_INVITATION_BLOCK_KEY)" = "$block" ]; then
  pass "an existing block key is never regenerated"
else
  fail "an existing block key is never regenerated"
fi

if [ "$failures" -gt 0 ]; then
  echo "env test: $failures failed"
  exit 1
fi
echo "env test: all passed"
