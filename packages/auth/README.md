# `@drefyn/auth`

Identity, sessions, API keys, organizations and seats for Docs, Studio and Status. This
first slice holds only pure pieces: config parsing, key derivation, credential formats,
input validators, the built in password rules, log redaction and the permission model.
Nothing here touches a database, the network or the file system.

## Entry points

- `@drefyn/auth`: server only. Uses `node:crypto` and `node:url`.
- `@drefyn/auth/permissions`: pure, safe in client components. It imports types only,
  and `check:packages` refuses any Node built in or runtime package import anywhere in
  its module graph (the `drefyn.pureEntries` field in `package.json`).

Nothing else in `src/` is public.

## Config

```ts
const config = parseAuthConfig(process.env); // dashboard
const api = parseApiAuthConfig(process.env); // API service
```

- `parseAuthConfig(env)` reads every auth key and returns a deeply frozen `AuthConfig`.
  Any problem throws `AuthError` with code `AUTH_CONFIG_INVALID`, a `key` naming the
  setting, and a fixed reason. The value is never repeated, in the message or anywhere
  else on the error. An empty value counts as unset.
- Startup rules: `DREFYN_APP_ORIGIN` is a bare http or https origin and must be https
  while `DREFYN_AUTH_COOKIE_SECURE` is true (the default). Secure cookies may be off
  only for `http://localhost` or `http://127.0.0.1`, and the cookie names then drop the
  `__Host-` prefix. `DREFYN_AUTH_SECRET` is at least 32 bytes in canonical unpadded
  base64url. `DREFYN_AUTH_SECRET_PREVIOUS` follows the same rule and must differ from the
  current secret. OAuth client id and secret come in pairs. Idle days may not exceed
  absolute days. Proxy hops must be 0 for a loopback origin. `DREFYN_CLIENT_IP_HEADER`
  is `cloudfront-viewer-address` or unset, and needs hops of 1 or more. While passwords
  are on, `UV_THREADPOOL_SIZE` must be set above 4 and the hash concurrency must be under
  half of it. Argon2id parameters stay at or above the OWASP floor.
- Rate limits: one `DREFYN_AUTH_RATE_<BUCKET>` key per bucket in `RATE_BUCKETS`. Each
  value is 1 to 3 `count/window` pairs, for example `3/10m,10/1d`, with windows in `s`,
  `m`, `h` or `d` up to `7d`.
- Any other `DREFYN_AUTH_` key is refused, so a typo fails at start.
  `DREFYN_AUTH_DATABASE_URL` and `DREFYN_AUTH_DATABASE_POOL_MAX` belong to `@drefyn/db`
  and are ignored here.
- `parseApiAuthConfig(env)` needs `DREFYN_API_RATE_LIMIT_KEY` and refuses to start when
  any `DREFYN_AUTH_` key other than `DREFYN_AUTH_RATE_API_KEY_FAIL` is set, among them
  the current and previous secrets, the OAuth client secrets and the auth database URL,
  so the API service never holds identity data. `failureKey(parts)` makes the HMAC for
  `api_key_failures`.
- OAuth client secrets are `SecretValue`s: `reveal()` returns the string, while
  `toString`, `toJSON` and `util.inspect` all show `[redacted]`.

## Keys

- `deriveAuthKeys(secret, previous?)` derives one HKDF-SHA256 subkey per purpose in
  `KEY_PURPOSES` (`code`, `rate`, `csrf`). `mac(purpose, parts)` always uses the current
  secret. `verify('code' | 'csrf', parts, expected)` also accepts the previous secret
  during a rotation, and computes both so timing does not say which one matched. Rate
  keys have no verify: after a rotation their windows start fresh. Key material lives in
  closures, so serialising the result shows only `{ "rotating": ... }`.
- `lengthPrefixed(parts)` gives every part a 4 byte big endian length, so
  `("ab", "c")` and `("a", "bc")` never collide.
- `constantTimeEqual(a, b)` and `sha256(data)`.

## Credential formats

All bodies use the lowercase Crockford base32 of the tenancy id codec. A secret is
32 bytes in 52 symbols, with 4 leading zero bits, so each value has one encoding.

| Format                             | Shape                                  | Length |
| ---------------------------------- | -------------------------------------- | ------ |
| Session token                      | `v1.<user>.<session>.<secret>`         | 109    |
| API key                            | `drf_ak_<organization>_<key>_<secret>` | 113    |
| Invitation token                   | `<organization>.<invitation>.<secret>` | 106    |
| Email code                         | 8 digits                               | 8      |
| Verify link fragment               | `<challenge>.<code>`                   | 35     |
| Pre sign in and OAuth state cookie | `<secret>`                             | 52     |

Each `parse*` function returns `null` for anything but the canonical form, and each has
a matching `format*`. `parseBearer(header)` reads exactly `Bearer <key>` and refuses
headers over 512 bytes. The scheme is case sensitive on purpose for now, so `bearer`
is refused; accepting it later is additive. Ids carry their tenancy brands: `UserId`,
`IdOf<'ses'>`, `IdOf<'inv'>`, `OrganizationId` and `IdOf<'key'>`. Email challenges
have no id kind, so the challenge id comes back as a canonical UUID string.
`cookieNames(secure)` gives the four cookie names.

## Validators

- `safeReturnTo(value, appOrigin)` returns a same origin path. It refuses anything that
  does not start with exactly one `/`, contains `\` or a control character, or stops
  being a same origin path after parsing (for example `/.//evil.test`). The fallback is
  `/`.
- `normalizeAddress(value)` returns the trimmed, lower case address with an ASCII domain,
  or `null`. The local part must be a dot atom: no quoted strings, comments, spaces,
  escapes or second `@`. CR and LF are refused anywhere. The domain needs two or more
  hostname labels and a non numeric top label. The limits are 254 characters in total
  and 64 in the local part. Dots and plus tags are left alone.
- `checkCommonPassword(password, context?)` lists the built in rules that refuse a
  password, in `PASSWORD_RULES` order, after NFKC and lower casing:
  - `repeated_character`: one character repeated.
  - `sequence`: 6 or more ascending or descending letters or digits.
  - `keyboard_walk`: 6 or more adjacent keys along a row in `KEYBOARD_ROWS` (QWERTY,
    AZERTY, QWERTZ), either way.
  - `repeated_unit`: a unit of 4 characters or fewer repeated to make the whole.
  - `context`: contains "drefyn", the address local part, the first label of its domain,
    or the organization name or slug. Spaces and punctuation are ignored, and terms under
    3 characters are skipped.

  Length and the breached list are checked by the passwords code, not here.

## Redaction

`redact(value)` returns a copy of a structured log value with secrets removed at any
depth. It replaces values under secret or personal keys: password, secret, token,
cookie, authorization, API key, email, code, state, OTP, pre, invitation and IP.
Session tokens, invitation tokens, API keys, verify link fragments, bare secrets, bearer
values and Drefyn cookie values are removed from any string, and so is the value of a
`code=` or `state=` parameter in any case at the start, after `?`, `&`, `#`, `;` or
whitespace. Binary values, functions (an own `toJSON` included), values whose getter or
Proxy trap throws, and anything past 64 levels deep become `[redacted]`, and cycles
become `[circular]`, so a log call never throws. Errors keep their name, an upper case error `code` and redacted message
and stack. `redactText(text)` applies the string rules alone.

## Permissions

`permissionsFor(role, productReach)` returns the frozen list of `Permission`s in
`PERMISSIONS` order:

- member: `org.read`;
- admin: adds members, API keys, settings and `project.create`;
- owner: adds billing and `org.delete`.

A product read permission (`docs.read`, `studio.read`, `status.read`) is granted for
each product in `productReach`. `canAssign(actor, target)` lets owners assign any role,
lets admins assign admin and member, and lets members assign nothing. `ORG_ROLES` and
`PROJECT_ROLES` are frozen lists.

## Errors

`AuthError` carries `code` (`AuthErrorCode`), plus `key` for config errors and
`retryAfterSeconds` for rate limits. Messages are fixed text per code.
