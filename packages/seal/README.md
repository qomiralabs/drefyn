# `@drefyn/seal`

AES-256-GCM sealing for small secrets kept in Postgres: second factor secrets in
`@drefyn/auth` today, customer model keys next. A leaf package with no workspace
dependencies, so the AI keyring can use it without depending on auth.

Each caller passes its own labels and the values a row is bound to. The labels are part of
the stored format: changing one strands every value sealed under it, so they are versioned
rather than edited, and every caller pins them with known value tests.

## Public API

- `aesGcmSealer(keys, labels, configKey)` builds a frozen `Sealer` from a keyring. The first
  key seals; every listed key opens, so a rotation prepends a key. Each key is turned into
  an AES key with HKDF-SHA256 under `labels.hkdfSalt` and `labels.hkdfInfo`.
  - `seal(plain, bound)` returns `{ keyId, nonce, sealed }`: a random 96 bit nonce and the
    cipher text with its 16 byte tag appended.
  - `open(row, bound)` returns the plain bytes. Associated data is
    `lengthPrefixed([labels.aadVersion, ...bound, keyId])`, so a row moved to another owner,
    re-labelled with another key id, or read under other labels does not open.
- `SealLabels`: `hkdfSalt`, `hkdfInfo`, `aadVersion`. None may be empty.
- `SealingKey`: `{ id, material }`. `SEAL_KEY_ID` is the id pattern (1 to 8 lowercase
  letters or digits), `MAX_SEAL_KEYS` is 8 and `MIN_SEAL_KEY_BYTES` is 32.
- `lengthPrefixed(parts)` puts a 4 byte big endian length before each UTF-8 part, so
  `("ab", "c")` and `("a", "bc")` never encode the same.
- `SealError` has a `code`:
  - `SEAL_CONFIG_INVALID`: the keyring or labels are unusable. It carries `configKey` (the
    name the caller passed, such as `DREFYN_AUTH_TOTP_KEYS`) and a `reason` that names a
    key by position, never by id or material.
  - `SEAL_UNREADABLE`: one error for an unknown key id, a wrong length, a changed byte, wrong
    bound values or wrong labels, so a caller cannot tell them apart.
  - `SEAL_UNBOUND`: `seal` or `open` was called with no bound values. An unbound row could
    be copied to any owner.

No error carries a cause, plain bytes, key material or bound values, and nothing logs.

## Performance

`pnpm --filter @drefyn/seal bench` times seal and open of a 100 byte secret. The budget is
under 0.1 ms per open. HKDF runs once per key when the sealer is built, not per call.
