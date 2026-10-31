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

const mailer = createMailer(config.value, { linkOrigin, logger, metrics });
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
  every send returns `email.not_configured`. With SMTP config it builds the SMTP transport
  from config, unless `deps.transport` overrides it. It never throws for a config
  `parseEmailConfig` returned.
- `createSmtpTransport(smtpConfig)` is that transport, for a caller that wraps it.
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
- Names (organization, inviter, device, account, key, owner and member) refuse control
  characters and bidi marks, embeddings, overrides and isolates, naming the field, and are cut at a grapheme boundary with an
  ellipsis: 100 code points, 120 for a device and 254 for an account.
- Links must be https on the link origin, or http only when that origin is loopback, with
  no user or password. Each link is copied before the check and only the copy is
  rendered, so editing the URL after `send` or a URL subclass cannot change where it
  points.
- A code is exactly 8 ASCII digits.
- Recipient, sender and reply to addresses must pass `isNormalizedEmailAddress`.

## Sending

- At most `DREFYN_SMTP_MAX_CONCURRENT` (4) sends at once and `DREFYN_EMAIL_QUEUE_MAX`
  (100) waiting; past that `send` returns `email.overloaded` at once.
- One retry after 500 to 1500 ms, only for connect failures, timeouts before DATA, and a
  4xx at the greeting or to MAIL or RCPT. Never after the final dot (`email.unknown_outcome`),
  and never for 5xx, TLS or auth failures.
- One deadline (`DREFYN_SMTP_SEND_DEADLINE_MS`, 15 s) covers every attempt. When it fires
  the transport's signal aborts. The send returns `email.timeout` if the transport had not
  reached DATA, and `email.unknown_outcome` if it had, since the relay may hold the mail.
- A transport reports how far it got through the `progress` argument of `deliver`
  (`connect`, `auth`, `envelope`, `data`, `after_data`). The slot a send holds is freed
  only when `deliver` settles, which for SMTP is once its socket has closed.
- After 5 consecutive relay failures the breaker fails sends with `email.unavailable` for
  30 s, then lets one trial send decide.
- The `Message-ID` is derived from the idempotency key and the sender domain, so a retry
  carries the same id. The configured `DREFYN_EMAIL_IDEMPOTENCY_HEADER` carries the key.
- A transport that throws or answers in an unexpected shape counts as a lost reply.

## Logs and metrics

The ports match the flags and db packages: `logger.info`, `warn` and `error(event,
fields)`, and `metrics.counter`, `histogram` and `gauge(name, value, labels?)`. A port
that throws is ignored, and `send` settles whatever a caller, a port or the clock does.

`email.send` carries only `template`, `purpose`, `noticeKind`, `outcome`, `errorCode`,
`smtpReplyClass`, `attempts`, `durationMs`, `transport`, `organizationId` and `projectId`.
Never an address, domain, name, code, link, subject, body, reply text or the idempotency
key. Startup lines are `email.transport_configured` (kind, TLS mode, port),
`email.no_transport`, `email.plaintext_smtp` and `email.config_invalid` (key only).

Metrics: `email_sends_total{template,purpose,outcome}`,
`email_send_duration_ms{template,outcome}`, `email_render_duration_ms{template}`,
`email_queue_depth`, `email_breaker_open_total` and `email_dropped_on_shutdown_total`.

## SMTP

- Nodemailer 10.2.1, pinned exactly, imported only by `src/smtp/nodemailer.ts`. Each send
  opens its own connection, sends one message with an explicit envelope and quits.
- `implicit` TLS (the default on 465) or `starttls` with STARTTLS required (any other
  port). Certificates are always checked; there is no key that turns that off. A private
  CA goes in `DREFYN_SMTP_CA_FILE`, an IP literal host takes `DREFYN_SMTP_TLS_SERVERNAME`.
  A TLS failure is `email.tls_failed` and is never retried in plaintext.
- Plaintext only with `DREFYN_SMTP_TLS=none`, `DREFYN_SMTP_ALLOW_PLAINTEXT=true` and no
  credentials.
- Errors are mapped from Nodemailer's codes and the reply code only. The message is never
  read, because it holds addresses and the relay's reply text.
- From goes in as a name and an address, so the display name is quoted.

Integration tests: `bash scripts/email-integration.sh` makes throwaway certificates and an
AUTH password, starts four Mailpit containers on loopback, runs `test:integration` and
removes everything.

## Not here yet

The designed templates come next. Until then one plain placeholder
template renders every message.
