#!/usr/bin/env bash
# Proves the installer generates the auth and search keys and the parse host token once, in the
# right shape, with the token's hash beside it, and never prints a value, and that upgrade adds
# a missing second factor keyring but never replaces one. Needs
# no Docker: a fake docker on PATH fails every call, so up and upgrade stop at the project
# guard, right after they wrote deploy/.env. Runs in a scratch copy of the checkout, so the
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

KEYS="DREFYN_AUTH_SECRET DREFYN_AUTH_INVITATION_BLOCK_KEY DREFYN_API_RATE_LIMIT_KEY DREFYN_SEARCH_ADMIN_KEY"
TOTP=DREFYN_AUTH_TOTP_KEYS
TOKEN=DREFYN_PARSE_HOST_TOKEN
HASH=DREFYN_PARSE_TOKEN_SHA256

failures=0
pass() { printf 'ok    %s\n' "$1"; }
fail() {
  printf 'FAIL  %s\n' "$1"
  if [ -n "${2:-}" ]; then printf '      %s\n' "$2"; fi
  failures=$((failures + 1))
}

# up or upgrade with only the fake docker. Output goes to a file so every case can search it.
run() {
  local command="$1" out="$2"
  if PATH="$scratch/bin:$PATH" bash "$root/scripts/selfhost.sh" "$command" >"$out" 2>&1; then
    fail "$command stops at the guard when docker fails" "it exited 0"
  fi
}
up() { run up "$1"; }
upgrade() { run upgrade "$1"; }

value_of() { sed -n "s/^$1=//p" "$env_file"; }

# Exactly 32 bytes as canonical unpadded base64url: 43 characters, and the last one carries
# two spare bits that must be zero, so each key has one spelling.
is_key() {
  local v="$1" bytes
  [[ "$v" =~ ^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$ ]] || return 1
  bytes="$(printf '%s=' "$v" | tr -- '-_' '+/' | base64 --decode 2>/dev/null | wc -c | tr -d ' ')"
  [ "$bytes" = 32 ]
}

# One keyring entry: an id the key_id column accepts, a colon, then one key as above.
is_keyring() {
  [[ "$1" =~ ^[a-z0-9]{1,8}:(.*)$ ]] && is_key "${BASH_REMATCH[1]}"
}

# Any generated value in any output fails, whole or as its first 12 characters.
no_value_in() {
  local file="$1" key v leaked=""
  for key in $KEYS $TOTP $TOKEN DREFYN_AUTH_PASSWORD; do
    v="$(value_of "$key")"
    # The keyring's id is not secret; its key starts after the colon.
    v="${v#*:}"
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

v="$(value_of "$TOTP")"
if [ "$(grep -c "^$TOTP=" "$env_file")" = 1 ] && is_keyring "$v"; then
  pass "$TOTP is generated once as one <id>:<key> entry"
else
  fail "$TOTP is generated once as one <id>:<key> entry" "length ${#v}"
fi

distinct="$(
  for key in $KEYS; do value_of "$key"; done
  value_of "$TOTP" | sed 's/^[^:]*://'
)"
if [ "$(sort -u <<<"$distinct" | grep -c . || true)" = 5 ]; then
  pass "the five keys differ from one another"
else
  fail "the five keys differ from one another"
fi

# hash_matches: the hash in the file is the SHA-256 of the token in the file, each written once.
hash_matches() {
  [ "$(grep -c "^$TOKEN=" "$env_file")" = 1 ] && [ "$(grep -c "^$HASH=" "$env_file")" = 1 ] &&
    [ "$(printf '%s' "$(value_of "$TOKEN")" | shasum -a 256 | cut -d' ' -f1)" = "$(value_of "$HASH")" ]
}

if [[ "$(value_of "$TOKEN")" =~ ^[0-9a-f]{64}$ ]] && hash_matches; then
  pass "the parse host token is 32 random bytes in hex, with its SHA-256 beside it"
else
  fail "the parse host token is 32 random bytes in hex, with its SHA-256 beside it"
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
grep -vE "^(DREFYN_AUTH_SECRET|DREFYN_AUTH_INVITATION_BLOCK_KEY|DREFYN_API_RATE_LIMIT_KEY|DREFYN_SEARCH_ADMIN_KEY|$TOTP)=" \
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
if is_keyring "$(value_of "$TOTP")"; then added=$((added + 1)); fi
if [ "$added" = 5 ] && grep -q "added a generated" "$out3"; then
  pass "an older deploy/.env gets the five keys appended, named in the output"
else
  fail "an older deploy/.env gets the five keys appended, named in the output" "$(cat "$out3")"
fi
if leaked="$(no_value_in "$out3")"; then
  pass "appending keys prints no value"
else
  fail "appending keys prints no value" "found:$leaked"
fi

# A deploy/.env from before the parse host: both lines are appended, the hash matching.
grep -vE "^($TOKEN|$HASH)=" "$env_file" >"$old"
cp "$old" "$env_file"
chmod 600 "$env_file"
out5="$scratch/parse.out"
up "$out5"
if [ "$(head -n "$(wc -l <"$old")" "$env_file" | cksum)" = "$(cksum <"$old")" ] &&
  [[ "$(value_of "$TOKEN")" =~ ^[0-9a-f]{64}$ ]] && hash_matches &&
  grep -q "added a generated.*$TOKEN $HASH" "$out5"; then
  pass "an older deploy/.env gets the parse host token and its hash appended"
else
  fail "an older deploy/.env gets the parse host token and its hash appended" "$(cat "$out5")"
fi
if leaked="$(no_value_in "$out5")"; then
  pass "appending the parse host token prints no value"
else
  fail "appending the parse host token prints no value" "found:$leaked"
fi

# An operator's own token with no hash yet gets the hash of that token, and the token stays.
own_token="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
grep -vE "^($TOKEN|$HASH)=" "$env_file" >"$old"
printf '%s=%s\n' "$TOKEN" "$own_token" >>"$old"
cp "$old" "$env_file"
up "$scratch/parse-own.out"
if [ "$(value_of "$TOKEN")" = "$own_token" ] && hash_matches; then
  pass "an operator's own parse host token is kept and gets its hash"
else
  fail "an operator's own parse host token is kept and gets its hash"
fi

# A hash with no token means the token lives elsewhere: nothing is generated beside it.
grep -v "^$TOKEN=" "$env_file" >"$old"
cp "$old" "$env_file"
up "$scratch/parse-hash-only.out"
if [ "$(cksum <"$env_file")" = "$(cksum <"$old")" ]; then
  pass "a hash with no token is left alone"
else
  fail "a hash with no token is left alone" "$(diff "$old" "$env_file" | sed 's/=.*/=.../')"
fi

# The block key is never replaced once written: rotating it lifts every invitation block.
block="$(value_of DREFYN_AUTH_INVITATION_BLOCK_KEY)"
up "$scratch/again.out"
if [ "$(value_of DREFYN_AUTH_INVITATION_BLOCK_KEY)" = "$block" ]; then
  pass "an existing block key is never regenerated"
else
  fail "an existing block key is never regenerated"
fi

# upgrade on a deploy/.env from before the keyring: the keyring is appended and nothing else
# moves. Then upgrade again, which must leave the keyring exactly as it was.
grep -v "^$TOTP=" "$env_file" >"$old"
cp "$old" "$env_file"
chmod 600 "$env_file"
out4="$scratch/upgrade.out"
upgrade "$out4"
if [ "$(head -n "$(wc -l <"$old")" "$env_file" | cksum)" = "$(cksum <"$old")" ] &&
  is_keyring "$(value_of "$TOTP")" && grep -q "added a generated $TOTP" "$out4"; then
  pass "upgrade appends a missing $TOTP and keeps every other line"
else
  fail "upgrade appends a missing $TOTP and keeps every other line" "$(cat "$out4")"
fi
if leaked="$(no_value_in "$out4")"; then
  pass "upgrade prints no value"
else
  fail "upgrade prints no value" "found:$leaked"
fi
keyring="$(value_of "$TOTP")"
before="$(cksum <"$env_file")"
upgrade "$scratch/upgrade-again.out"
if [ "$(value_of "$TOTP")" = "$keyring" ] && [ "$(cksum <"$env_file")" = "$before" ]; then
  pass "upgrade keeps an existing $TOTP unchanged"
else
  fail "upgrade keeps an existing $TOTP unchanged"
fi

# An operator's own keyring, rotated to two entries, is never touched either.
own="$(value_of "$TOTP" | sed 's/^[^:]*:/new:/'),$keyring"
grep -v "^$TOTP=" "$env_file" >"$old"
printf '%s=%s\n' "$TOTP" "$own" >>"$old"
cp "$old" "$env_file"
upgrade "$scratch/upgrade-own.out"
up "$scratch/up-own.out"
if [ "$(value_of "$TOTP")" = "$own" ] && [ "$(cksum <"$env_file")" = "$(cksum <"$old")" ]; then
  pass "up and upgrade keep an operator's rotated $TOTP as written"
else
  fail "up and upgrade keep an operator's rotated $TOTP as written"
fi

if [ "$failures" -gt 0 ]; then
  echo "env test: $failures failed"
  exit 1
fi
echo "env test: all passed"
