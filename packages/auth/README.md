# `@drefyn/auth`

Identity, sessions, API keys, organizations and seats for Docs, Studio and Status. So far it
holds config parsing, key derivation, credential formats, input validators, the built in
password rules, log redaction, the permission model, the rate limiters, database sessions
with step up, and organizations. Only the limiters, the session files and organizations reach
the database, and only through `@drefyn/db`; nothing here touches the network or the file
system.

## Entry points

- `@drefyn/auth`: server only. Uses `node:crypto`.
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
  half of it. Argon2id parameters stay at or above the OWASP floor, and `crypto.argon2`
  must exist (Node 24.7 or later on OpenSSL 3.2 or later); without it startup fails with
  `AUTH_CONFIG_INVALID` naming `DREFYN_AUTH_PASSWORDS`.
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

## Rate limits

- `rateKeyForIp(ip)` gives the value a per IP bucket is keyed by: `ip4:a.b.c.d`, or the /64 of
  an IPv6 address in one fixed spelling (`ip6:2001:0db8:0001:0002::/64`). An IPv4 mapped
  address reads as its IPv4 address. Anything else, zone ids included, is
  `AUTH_INPUT_INVALID`.
- `createRateLimiter({ db, keys, limits, metrics, logger })` returns `reserve(bucket, value)`.
  The stored key is `HMAC(subkey_rate, bucket, ...value)`. Each call counts one attempt
  against every window of the bucket in a short transaction of its own, committed before it
  returns. Past any limit it throws `AUTH_RATE_LIMITED` with `retryAfterSeconds`, the longest
  wait of the windows that refused; a database failure is `AUTH_UNAVAILABLE`. The first
  refusal in a window of `email_send_address_ceiling` also counts `auth.email_ceiling_hit`
  and logs the bucket and the first 16 hex digits of the key, never the address; later
  refusals in that window record nothing, so strangers cannot flood the log.
- `createApiKeyFailureLimiter({ db, config })` is the API service's: keyed with
  `DREFYN_API_RATE_LIMIT_KEY` through `parseApiAuthConfig`, committed through
  `withApiKeyLimiter`.

The contract for every flow: await `reserve` before the work it limits and outside that
work's transaction. A wrong code or password is thrown from the work and rolls its
transaction back; a count made inside it would go with it, and its row lock would queue every
other request on that key behind the work. The same holds for the per challenge attempt
count: it is incremented and committed before the code is compared. Slow work such as
password hashing holds no connection.

The buckets and defaults are in `RATE_BUCKETS` and the Config section. `email_send_device`
(10 a day) is configured for the known device exemption, which the email sign in flow adds.

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
- `normalizeAddress(value)` returns the address normalised by `normalizeEmailAddress`
  from `@drefyn/address`, or `null` when that refuses it or the value is not a string. The
  rule lives there so email checks recipients with the same one; see its README.
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

## Sessions

```ts
const sessions = createSessions(config, { db, authDb, logger, mailer, passwords });
```

- Token `v1.<user>.<session>.<secret>` in `__Host-drefyn_session` (`HttpOnly; Secure;
SameSite=Lax; Path=/`). With secure cookies off (loopback only) the name is
  `drefyn_session` and `Secure` is dropped; with them on, the bare name is never read.
  `serializeCookie(config, spec)` writes the header; callers choose only name, value and
  `Max-Age`.
- `startSession(browser, { userId, method })` runs after a sign in was proved: it deletes the
  session the browser's cookie proves, whoever it belongs to, inserts a new row with a fresh
  secret (`secret_hash = sha256(secret)`) and database times (30 days absolute by default),
  and clears the pre sign in and OAuth cookies.
- `resolve(cookie)` returns `{ session, touchDue }` or null; `resolveSession(cookie)` returns
  the session or null. The first statement selects only the session row by id; the hash is
  compared with `timingSafeEqual` in process (against a dummy on a miss); idle and absolute
  expiry use database `now()`; any failure rolls back before a second statement. Nothing is
  written. A database failure throws `AUTH_UNAVAILABLE` rather than signing anyone out.
- `touchSession({ userId, sessionId, organizationId? })` runs after the response when
  `touchDue` is true. One guarded update, at most once an hour per session, never throws; a
  failure logs `auth.session_touch_failed` with public ids only.
- `signOut`, `signOutEverywhere` (every row and every known device of the user, nothing
  reissued), `listSessions`
  (live rows, current marked, no hashes or IPs) and `revokeSession`.
- `signOutOtherSessions(session, browser)` is "Sign out everywhere else". In one transaction
  it deletes every row of the user, this one included, and gives this browser a new row and
  secret that keep the old `method`, `authenticated_at`, `user_agent` and `expires_at`. A copy
  of this browser's old cookie stops working with the rest. Known devices are forgotten and
  this browser is recorded on a new device cookie, so a copied device cookie loses its
  exemption too. Returns `{ revoked, setCookies }`:
  `revoked` counts the other sessions, and the new session cookie's `Max-Age` is the time left
  on the old row. Needs a sign in within 15 minutes (`AUTH_RECENT_AUTH_REQUIRED`);
  `AUTH_SESSION_INVALID` when the current row is already gone; `AUTH_UNAVAILABLE` on a
  database error. None of them changes a row. Use `signOutEverywhere` where the current
  browser is not trusted. Both log `auth.sessions_revoked` with `scope` (`all` or `others`),
  `revoked` and the public user id.
- A failed `resolve` or `resolveAccess` returns no cookies, so a late request from another
  tab with the old cookie cannot clear the new one.
- `requireRecentAuth(session)` answers `AUTH_RECENT_AUTH_REQUIRED` when the last sign in is
  older than 15 minutes by database time. `stepUpWithPassword` counts `password_fail` and
  `password_fail_ip` before the hash and verifies outside any transaction through the
  `PasswordVerifier` it is given (`AUTH_PASSWORDS_DISABLED` without one). A user with no
  password row is refused whatever the verifier answers.
- `startSession` with `credential: { phc, rehash? }` (password sign in) inserts the row in
  one statement that locks the password row only while it still holds `phc`; otherwise it
  throws `AUTH_CREDENTIALS_INVALID` and writes nothing. `rehash` replaces the hash in the
  same transaction.
  `startStepUpCode` and `verifyStepUpCode` send an 8 digit code bound to the asking session
  (10 minutes, 5 attempts, single use). Both refresh `authenticated_at` on the same row and
  record `step_up_method`.
- `resolveAccess(cookie, slug)` is the guard's one call: `{ kind: 'ok', access, touchDue }`,
  `{ kind: 'signed_out' }` or `{ kind: 'not_member' }`. It runs the same session proof first,
  then, only after a match, one read of the slug, the organization and the person's own
  membership. An unknown slug and a slug of an organization the person is not in give the
  same `not_member`. `AccessContext` is branded, so only this package can build one.

## Email sign in

```ts
const signIn = createEmailSignIn(config, { db, authDb, logger, mailer, sessions, invitations });
const started = await signIn.startEmailSignIn(browser, { email, returnTo });
// set started.value.setCookies, answer, then in after(): await started.value.send()
const result = await signIn.verifyEmailCode(browser, { challenge, code }); // challenge optional
```

- Sign in and sign up are one flow. Every address gets the same response and the same
  cookies (`__Host-drefyn_pre`, 15 minutes); the mail goes out only when `send` runs, and
  `send` never throws. In `invite_only` (without a pending invitation) and `closed`, an
  unknown address gets the same response and no mail.
- Limits, counted before any work: `email_send` on the address and IP or /64,
  `email_send_ip`, then `email_send_device` for a browser whose device cookie is known for
  the address's user, otherwise the shared `email_send_address_ceiling`.
- The code is 8 digits from `crypto.randomInt`, stored as `HMAC(subkey_code, challenge,
purpose, code)`, 10 minutes, 5 attempts, single use. A new challenge replaces only older
  ones from the same browser.
- Verify checks the binding first: without the asking browser's pre cookie it answers
  `AUTH_CHALLENGE_BINDING` and spends no attempt. Then `code_verify` on the address and
  browser, then one guarded update that counts the attempt, then the `timingSafeEqual`
  compare. `AUTH_SIGNUP_CLOSED` comes only after a right code. Typed spaces, tabs and no
  break spaces are dropped. Without a challenge id the browser's newest open challenge is used.
- `verifyLinkCode(browser, session | null, { challenge, code })` is for the link page: a
  step up code goes to `verifyStepUpCode` of that session, an email change code to
  `completeEmailChange` (when `emailChange` is wired), and neither ever signs anyone in.
- A sign in records the browser in `known_devices` (at most 20 per user, the one seen
  longest ago goes) and sets `__Host-drefyn_device` for 400 days when it had none. The cookie
  is never an authenticator. `createCodeIssuer` is the shared issuer for every mail purpose
  (`sign_in`, `link_identity` with the provider and account, `step_up`, `password_reset`,
  `email_change`). `src/testing.ts` holds the test mailer.
- Logs: `auth.email_code_refused` with the outcome code and the first 16 hex digits of the
  `code_verify` key, `auth.sign_in_mail_failed` with the purpose, `auth.device_record_failed`
  with the public user id. Never an address, code, challenge id or cookie.

## Password sign in

```ts
const hasher = createPasswordHasher({
  params: config.passwords.argon2,
  concurrency: config.passwords.hashConcurrency,
  queueMax: config.passwords.hashQueueMax,
});
// One hasher per process, given to both, so one gate bounds every hash.
const sessions = createSessions(config, { db, authDb, logger, mailer, passwords: hasher });
const passwords = createPasswordSignIn(config, { db, authDb, logger, sessions, hasher, botCheck });
const form = passwords.passwordForm(browser); // GET: set form.setCookies, render form.csrf
const input = readPasswordSignInForm(body); // POST: 8 KiB body, 4 KiB password, one of each field
const result = await passwords.signInWithPassword(browser, input);
await passwords.setPassword(session, { newPassword }); // a first password, after a recent sign in
```

- Argon2id from `node:crypto`, stored as a PHC string. `parsePhc` takes `argon2id` v19
  only, with parameters from `ARGON2_FLOOR` (m=19456, t=2, p=1) up to m=262144, t=10, p=4.
- Three steps. A short auth transaction reads the user and hash in one statement, after
  `password_fail` (address, counted for unknown addresses too) and `password_fail_ip` are
  reserved. The hash runs outside any transaction. The session step creates the row only
  while the hash read is still stored, and swaps in a rehash when the parameters moved. A
  changed hash gets one fresh read and check; a reset between the steps leaves no session.
- One answer, `AUTH_CREDENTIALS_INVALID`, for an unknown address, a user with no password, a
  wrong password and an unreadable hash, in every sign up mode. Each pays one full hash at
  the current parameters (a dummy where there is no real hash), and a miss against an older,
  cheaper hash waits out the difference to the measured current cost.
- The hash gate runs `hashConcurrency` at once, queues `hashQueueMax` (64) for up to 2 s,
  and refuses past that with `AUTH_UNAVAILABLE` and `retryAfterSeconds: 1`.
- The form binding: `__Host-drefyn_pre` plus a hidden `csrf` field, `HMAC(subkey_csrf,
pre)`. Without both the post is `AUTH_ORIGIN_REFUSED` and nothing is counted. The Origin
  check belongs to the dashboard's action wrappers.
- Passwords are NFKC; 4 KiB raw and 1,024 bytes after NFKC, refused as `AUTH_INPUT_INVALID`.
  New ones are 15 to 128 characters and pass the common password rules, else
  `AUTH_PASSWORD_WEAK` with `rules`. `setPassword` never replaces a set password
  (`AUTH_FORBIDDEN`).
- `BotCheck` is optional. Set, it runs after the counts and before any read; a refusal, an
  error or no answer in 3 s is `AUTH_BOT_CHECK_REQUIRED`. Unset with `DREFYN_AUTH_SIGNUP=open`,
  building the flow logs `auth.signup_open_without_bot_check` once.
- A sign in records the known device as email sign in does. Logs: `auth.password_refused`
  (outcome and the first 16 hex digits of the `password_fail` key), `auth.password_set` and
  `auth.password_hash_unreadable` (public user id). Never a password, address or cookie.

## Email change

```ts
const change = createEmailChange(config, { db, authDb, logger, mailer }); // mailer also has sendSecurityNotice
const started = await change.startEmailChange(browser, session, { newEmail });
// set started.value.setCookies, answer, then in after(): await started.value.send()
const done = await change.completeEmailChange(browser, session, { challenge, code });
// answer, then in after(): await done.value.send() mails the notice to the old address
```

- Both calls need a sign in within 15 minutes (`AUTH_RECENT_AUTH_REQUIRED`).
- Start counts `email_send`, `email_send_ip` and `email_send_address_ceiling` on the new
  address. A taken address gets the same response, cookies and statements, no mail, and a
  stored MAC no code can match.
- The code goes to the new address, bound to the browser (pre cookie) and to the user
  (`user_id`): another user's session cannot complete it, and its attempt is not spent.
- A right code runs one `withAuth` transaction: the update of `users` guarded on the user
  id and the old address, then a delete of every open challenge of the user or for the old
  address. A moved old address or a unique violation (a sign up won the race) answers
  `AUTH_CODE_INVALID`, like a wrong code, and changes nothing.
- Then every other session of the user is deleted. If that delete fails the change stands
  and `auth.email_change_sessions_kept` is logged.
- Only sign up and this flow write `users.email_normalized`; `test/address-writes.test.ts`
  checks the source.
- Logs: `auth.email_change_started`, `auth.email_change_refused` (outcome),
  `auth.email_changed` (count of sessions ended), `auth.email_change_notice_failed`, each with
  public user and session ids. Never an address or code.

## GitHub and Google

```ts
const oauth = createOAuth(config, { db, authDb, logger, mailer, sessions, invitations }); // mailer also has sendSecurityNotice
const started = await oauth.startOAuth(browser, { provider, purpose, returnTo, session }); // purpose: sign_in, link or step_up
// set started.value.setCookies, then 302 to started.value.redirectTo
const done = await oauth.completeOAuth(browser, { provider, query }); // the callback's query only
// done.value.kind: signed_in, stepped_up, linked (run send() in after()) or link_pending (run send() in after())
const removed = await oauth.unlinkIdentity(session, { provider }); // then in after(): await removed.value.send()
```

- A provider is on only when both of its `DREFYN_AUTH_<PROVIDER>_CLIENT_ID` and
  `_CLIENT_SECRET` are set; otherwise `AUTH_OAUTH_DISABLED`. Secrets come from the
  environment only and stay in a `SecretValue`.
- Start counts `oauth_start` on the IP or /64, stores a row in `oauth_states` keyed by
  `sha256(state)` with the provider, purpose, PKCE verifier, Google nonce, the browser's
  pre cookie hash, the safe `returnTo` and, for link and step up, the user, for 10 minutes.
  It sets `__Host-drefyn_oauth` to the state. PKCE S256 is always sent. `redirect_uri` is
  `DREFYN_APP_ORIGIN` plus `/auth/oauth/<provider>/callback`; nothing from the request
  reaches it. Endpoints are fixed in code, never discovered.
- The callback needs the query `state` equal to the cookie (constant time), deletes the
  row (single use, even when it refuses), and needs the same provider, browser and an
  unexpired row; otherwise `AUTH_OAUTH_STATE_INVALID`. openid-client then checks the
  state, PKCE and, for Google, the ID token: issuer, audience, nonce, expiry and the
  signature through Google's JWKS (`enableNonRepudiationChecks`).
- GitHub's subject is the numeric `id`, never `login`, and its address is the primary
  verified entry of `GET /user/emails`. Google's is `sub` and a verified `email`. Provider
  tokens never leave the provider module: nothing stores or logs them.
- Sign in: a known identity signs in its user. An unknown identity with a verified address
  matching no user creates one (subject to `DREFYN_AUTH_SIGNUP`). An unverified address is
  `AUTH_OAUTH_EMAIL_UNVERIFIED`. A verified address matching an existing user is never
  linked by itself: the answer is `link_pending`, and a `link_identity` code naming the
  provider and account goes to that address (counted like a sign in mail). Proving it in
  the same browser through `verifyLinkCode` or `verifyEmailCode` links the identity and
  signs in with the provider as the method. Sign ins record the browser as a known device.
- Link needs a session proved within 15 minutes, at start and at the callback; an
  identity held by someone else, or a second one of a provider, is `AUTH_FORBIDDEN`.
- Step up refuses an identity not linked to the session's user
  (`AUTH_STEP_UP_IDENTITY_MISMATCH`). Google sends `prompt=login` and `max_age=0` and needs
  an `auth_time` within 5 minutes (`AUTH_RECENT_AUTH_REQUIRED`). GitHub cannot force a new
  sign in, so it is refused (`AUTH_FORBIDDEN`) while the user has another way to step up
  (email not off, a password, or Google) and is recorded as `github_session` otherwise.
- Unlink needs a recent sign in and refuses to remove the last way to sign in when email is
  off. Link and unlink each send a security notice.
- `src/oauth/fetch.ts` is the only file allowed to call the global `fetch`, and only
  directly (a scoped egress entry). Each provider reaches its own two hosts over https,
  with `redirect: 'error'`, any 3xx refused, 5 s and 1 MiB per call. It turns a GitHub token
  answer of HTTP 200 with an `error` into a 400 with the same bytes, so one mapper reads
  `ResponseBodyError`: `bad_verification_code` and `expired_token` are
  `AUTH_OAUTH_STATE_INVALID`; everything else is `AUTH_OAUTH_PROVIDER_ERROR`.
  `oauthTransport` is for tests only and runs after the host checks.
- Logs: `auth.oauth_refused` (provider and outcome), `auth.oauth_fetch_refused` (provider and
  one of `host`, `scheme`, `redirect`, `timeout`, `size`), `auth.oauth_misconfigured`
  (provider and code, for a wrong client secret, redirect URI or a suspended app),
  `auth.identity_linked`, `auth.identity_unlinked`, `auth.identity_notice_failed`. Never an
  address, code, state, token or provider body.

## Organizations

```ts
const orgs = createOrganizations(config, { db, authDb, logger, initialTier: 'self_hosted' });
```

- `initialTier` is `self_hosted` for the self host bootstrap and `free` for hosted signup; the
  caller sets it, never a request. Anything else fails at construction with
  `AUTH_CONFIG_INVALID`. The database holds the install's own tier in `app.install_tier()`
  (`self_hosted` in this repository; the hosted build replaces it with `free`) and refuses an
  organization at any other tier, or one that starts read only, so a mismatch fails every
  create with `AUTH_UNAVAILABLE` over `DB_RLS_VIOLATION` and logs
  `auth.organization_create_failed` with ids only.
- A plain insert can only make the first owner, in the transaction that made the
  organization. Any other member needs a source the database can check, such as an
  accepted invitation once invitations land.
- `createOrganization(session, { name, slug })` checks the name and slug, counts `org_create`
  (3 a day per person), then writes the organization, its slug and the owner membership in
  one organization transaction. `AUTH_INPUT_INVALID` for a name with `://`, `www.` or a
  domain like string (checked after NFKC, which is also the stored form), `AUTH_SLUG_INVALID`
  outside `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$` or on `RESERVED_SLUGS`,
  `AUTH_SLUG_TAKEN` when another organization holds it, `AUTH_RATE_LIMITED` past the cap.
  Logs carry public ids only (`auth.organization_created` at info, when the logger has it).
- `listMyOrganizations(session)` reads under the person's own context: only organizations
  they belong to, with slug, role, tier and read only state.
- `pnpm --filter @drefyn/auth test:integration` runs the session tests against the compose
  stack named by `COMPOSE_PROJECT_NAME`, on databases of their own.
