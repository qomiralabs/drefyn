# `@drefyn/email`

Typed product mail, server only. A message is a closed union keyed by `template`. The
package checks it, renders an HTML part and a plain text part from one block model, and
hands both to a transport through a `Mailer` whose `send` never throws.

This package does not depend on `@drefyn/auth`. The app adapts auth's mailer interface to
this one.

## Public API

```ts
const config = parseEmailConfig(process.env);
logEmailConfig(config, logger);
if (!config.ok) process.exit(1);

const mailer = createMailer(config.value, { linkOrigin, logger, metrics, transport });
const result = await mailer.send(
  address,
  { template: 'sign_in_code', purpose: 'sign_in', code, link, expiresInMinutes: 10 },
  { idempotencyKey: `code:${challengeId}` },
);
if (!result.ok) result.error.code; // 'email.timeout', 'email.input_invalid', ...

await mailer.drain(10_000); // on SIGTERM, returns { dropped }
```

- `parseEmailConfig(env, readFile?)` reads every `DREFYN_EMAIL_*` and `DREFYN_SMTP_*` key
  once into a frozen config. Unset or `none` gives `{ kind: 'none' }`. A refusal is
  `{ code: 'email.config_invalid', key, reason }` and never holds the value. The SMTP
  password is a `Secret` that prints, logs and serialises as `[redacted]`.
- `createMailer(config, deps)`: with `kind: 'none'` it reports `configured: false` and
  every send returns `email.not_configured`. With SMTP config it needs `deps.transport`
  until the SMTP transport lands.
- `renderMail(message, { linkOrigin })` returns the subject, preheader, HTML and text, or
  `email.input_invalid` naming the field. It never throws.
- `isHeaderSafe(name, value)` is the check every header value passes.
- `logEmailConfig(result, logger)` writes the startup lines.
- `@drefyn/email/testing` exports `createTestTransport()`, which captures every send
  (template, purpose or notice kind, both parts, the code and the links read back from the
  text part) and can `failNext(code, phase?)` or `hangNext()`.

## Guards

- Subjects and preheaders are fixed per template and purpose. They never hold a name or
  the code.
- Header values refuse C0 and C1 controls, U+2028 and U+2029, and anything over 998 bytes
  on the line once encoded.
- Names (organization, inviter, device, account, key, owner and member) refuse control and
  bidi override characters, naming the field, and are cut at a grapheme boundary with an
  ellipsis: 100 code points, 120 for a device and 254 for an account.
- Links must be https on the link origin, or http only when that origin is loopback, with
  no user or password.
- A code is exactly 8 ASCII digits.
- Recipient, sender and reply to addresses must pass `isNormalizedEmailAddress`.

## Sending

- At most `DREFYN_SMTP_MAX_CONCURRENT` (4) sends at once and `DREFYN_EMAIL_QUEUE_MAX`
  (100) waiting; past that `send` returns `email.overloaded` at once.
- One retry after 500 to 1500 ms, only for connect failures, timeouts before DATA, and a
  4xx at the greeting or to MAIL or RCPT. Never after the final dot (`email.unknown_outcome`),
  and never for 5xx, TLS or auth failures.
- One deadline (`DREFYN_SMTP_SEND_DEADLINE_MS`, 15 s) covers every attempt. When it fires
  the transport's signal aborts and the send returns `email.timeout`.
- After 5 consecutive relay failures the breaker fails sends with `email.unavailable` for
  30 s, then lets one trial send decide.
- The `Message-ID` is derived from the idempotency key and the sender domain, so a retry
  carries the same id. The configured `DREFYN_EMAIL_IDEMPOTENCY_HEADER` carries the key.
- A transport that throws or answers in an unexpected shape counts as a lost reply.

## Logs and metrics

`email.send` carries only `template`, `purpose`, `noticeKind`, `outcome`, `errorCode`,
`smtpReplyClass`, `attempts`, `durationMs`, `transport`, `organizationId` and `projectId`.
Never an address, domain, name, code, link, subject, body, reply text or the idempotency
key. Startup lines are `email.transport_configured` (kind, TLS mode, port),
`email.no_transport`, `email.plaintext_smtp` and `email.config_invalid` (key only).

Metrics: `email_sends_total{template,purpose,outcome}`,
`email_send_duration_ms{template,outcome}`, `email_render_duration_ms{template}`,
`email_queue_depth`, `email_breaker_open_total` and `email_dropped_on_shutdown_total`.

## Not here yet

The SMTP transport and the designed templates come next. Until then one plain placeholder
template renders every message.
