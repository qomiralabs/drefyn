import { readFileSync } from 'node:fs';
import { normalizeEmailAddress, type NormalizedEmailAddress } from '@drefyn/address';
import { z } from 'zod';
import { CONTROL, isHeaderSafe } from './headers.ts';
import { Secret } from './secret.ts';
import type { EmailConfig, Result, SmtpConfig, TlsMode } from './types.ts';

export const EMAIL_CONFIG_KEYS = Object.freeze([
  'DREFYN_EMAIL_TRANSPORT',
  'DREFYN_EMAIL_FROM',
  'DREFYN_EMAIL_FROM_NAME',
  'DREFYN_EMAIL_REPLY_TO',
  'DREFYN_EMAIL_IDEMPOTENCY_HEADER',
  'DREFYN_EMAIL_QUEUE_MAX',
  'DREFYN_SMTP_HOST',
  'DREFYN_SMTP_PORT',
  'DREFYN_SMTP_TLS',
  'DREFYN_SMTP_ALLOW_PLAINTEXT',
  'DREFYN_SMTP_USER',
  'DREFYN_SMTP_PASSWORD',
  'DREFYN_SMTP_PASSWORD_FILE',
  'DREFYN_SMTP_CA_FILE',
  'DREFYN_SMTP_TLS_SERVERNAME',
  'DREFYN_SMTP_TLS_MIN_VERSION',
  'DREFYN_SMTP_EHLO_NAME',
  'DREFYN_SMTP_CONNECT_TIMEOUT_MS',
  'DREFYN_SMTP_GREETING_TIMEOUT_MS',
  'DREFYN_SMTP_SOCKET_TIMEOUT_MS',
  'DREFYN_SMTP_SEND_DEADLINE_MS',
  'DREFYN_SMTP_MAX_CONCURRENT',
] as const);
export type EmailConfigKey = (typeof EMAIL_CONFIG_KEYS)[number];

export interface EmailConfigError {
  readonly code: 'email.config_invalid';
  readonly key: EmailConfigKey;
  // Fixed text written here; never the value, which may be a secret in the wrong key.
  readonly reason: string;
}

export type Env = Readonly<Record<string, string | undefined>>;

// Thrown inside the parser only, and turned into a result at the edge.
class Refusal extends Error {
  readonly refusal: EmailConfigError;

  constructor(refusal: EmailConfigError) {
    super(refusal.reason);
    this.refusal = refusal;
  }
}

function refuse(key: EmailConfigKey, reason: string): never {
  throw new Refusal(Object.freeze({ code: 'email.config_invalid', key, reason }));
}

// Compose passes an unset variable as an empty string.
function read(env: Env, key: EmailConfigKey): string | undefined {
  const value = env[key];
  return value === undefined || value === '' ? undefined : value;
}

// Plain digits only: Number() would also take ' 30', '1e1', '0x1e' and 'Infinity'.
const whole = (min: number, max: number) =>
  z
    .string()
    .regex(/^[0-9]{1,6}$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

function wholeKey(env: Env, key: EmailConfigKey, fallback: number, min: number, max: number) {
  const raw = read(env, key);
  if (raw === undefined) return fallback;
  const parsed = whole(min, max).safeParse(raw);
  if (!parsed.success) refuse(key, `must be a whole number from ${min} to ${max}`);
  return parsed.data;
}

function choice<const T extends readonly [string, ...string[]]>(
  env: Env,
  key: EmailConfigKey,
  values: T,
): T[number] | undefined {
  const raw = read(env, key);
  if (raw === undefined) return undefined;
  const parsed = z.enum(values).safeParse(raw);
  if (!parsed.success) refuse(key, `must be one of ${values.join(', ')}`);
  return parsed.data;
}

function address(env: Env, key: EmailConfigKey): NormalizedEmailAddress | undefined {
  const raw = read(env, key);
  if (raw === undefined) return undefined;
  const result = normalizeEmailAddress(raw);
  if (!result.ok) refuse(key, 'must be a valid email address');
  return result.value;
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const IPV4 =
  /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;

function isHostName(value: string): boolean {
  if (value.length > 253 || IPV4.test(value)) return false;
  const labels = value.split('.');
  // A last label of digits only would read as an address.
  if (/^[0-9]+$/.test(labels.at(-1) ?? '')) return false;
  return labels.every((label) => LABEL.test(label));
}

// The URL parser is the IPv6 grammar the transport's resolver also follows.
function isIpv6(value: string): boolean {
  if (!/^[0-9a-f:.]+$/i.test(value) || !value.includes(':')) return false;
  return URL.parse(`http://[${value}]/`) !== null;
}

function hostKey(env: Env, key: EmailConfigKey, allowIp: boolean): string | undefined {
  const raw = read(env, key);
  if (raw === undefined) return undefined;
  if (isHostName(raw) || (allowIp && (IPV4.test(raw) || isIpv6(raw)))) return raw;
  return refuse(key, allowIp ? 'must be a host name or an IP address' : 'must be a host name');
}

function fileText(key: EmailConfigKey, path: string, readFile: (path: string) => string) {
  try {
    return readFile(path);
  } catch {
    return refuse(key, 'names a file that cannot be read');
  }
}

// Lower case, compared without regard to case.
const HEADERS_WE_SET: ReadonlySet<string> = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'reply-to',
  'sender',
  'subject',
  'date',
  'message-id',
  'auto-submitted',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
  'return-path',
]);

function idempotencyHeader(env: Env): string | undefined {
  const key = 'DREFYN_EMAIL_IDEMPOTENCY_HEADER';
  const raw = read(env, key);
  if (raw === undefined) return undefined;
  const reason = 'must be a header name of letters, digits and hyphens, not one the mailer sets';
  if (!/^[A-Za-z0-9-]{1,76}$/.test(raw) || HEADERS_WE_SET.has(raw.toLowerCase())) {
    refuse(key, reason);
  }
  return raw;
}

function fromName(env: Env): string {
  const key = 'DREFYN_EMAIL_FROM_NAME';
  const raw = read(env, key);
  if (raw === undefined) return 'Drefyn';
  const length = Array.from(raw).length;
  if (length > 64 || raw.trim() === '' || !isHeaderSafe('From', raw)) {
    refuse(key, 'must be 1 to 64 characters with no control characters');
  }
  return raw;
}

function credentials(env: Env, readFile: (path: string) => string): SmtpConfig['auth'] {
  const user = read(env, 'DREFYN_SMTP_USER');
  const inline = read(env, 'DREFYN_SMTP_PASSWORD');
  const file = read(env, 'DREFYN_SMTP_PASSWORD_FILE');
  if (inline !== undefined && file !== undefined) {
    refuse('DREFYN_SMTP_PASSWORD_FILE', 'cannot be set together with DREFYN_SMTP_PASSWORD');
  }
  let password = inline;
  if (file !== undefined) {
    // Docker secrets end with a newline; the password itself never does.
    password = fileText('DREFYN_SMTP_PASSWORD_FILE', file, readFile).replace(/\r?\n$/, '');
    if (password === '') refuse('DREFYN_SMTP_PASSWORD_FILE', 'names an empty file');
  }
  if (user === undefined && password === undefined) return undefined;
  if (user === undefined) refuse('DREFYN_SMTP_USER', 'is required when a password is set');
  if (password === undefined) refuse('DREFYN_SMTP_PASSWORD', 'is required with DREFYN_SMTP_USER');
  if (CONTROL.test(user)) refuse('DREFYN_SMTP_USER', 'must not hold control characters');
  return Object.freeze({ user, password: new Secret(password) });
}

const DEFAULT_PORT: Readonly<Record<TlsMode, number>> = {
  implicit: 465,
  starttls: 587,
  none: 1025,
};

function tlsAndPort(env: Env): { tls: TlsMode; port: number } {
  const tls = choice(env, 'DREFYN_SMTP_TLS', ['implicit', 'starttls', 'none']);
  const portRaw = read(env, 'DREFYN_SMTP_PORT');
  // RFC 8314 prefers implicit TLS, so with nothing set that is what we use.
  const port = wholeKey(env, 'DREFYN_SMTP_PORT', DEFAULT_PORT[tls ?? 'implicit'], 1, 65_535);
  if (tls !== undefined) return { tls, port };
  return { tls: portRaw === undefined || port === 465 ? 'implicit' : 'starttls', port };
}

function readCa(env: Env, readFile: (path: string) => string): string | undefined {
  const path = read(env, 'DREFYN_SMTP_CA_FILE');
  if (path === undefined) return undefined;
  const text = fileText('DREFYN_SMTP_CA_FILE', path, readFile);
  if (!text.includes('-----BEGIN CERTIFICATE-----')) {
    refuse('DREFYN_SMTP_CA_FILE', 'must hold PEM certificates');
  }
  return text;
}

function parseSmtp(env: Env, readFile: (path: string) => string): EmailConfig {
  const from = address(env, 'DREFYN_EMAIL_FROM');
  if (from === undefined)
    refuse('DREFYN_EMAIL_FROM', 'is required with DREFYN_EMAIL_TRANSPORT=smtp');
  const replyTo = address(env, 'DREFYN_EMAIL_REPLY_TO');
  const sender = Object.freeze({
    from,
    fromName: fromName(env),
    ...(replyTo === undefined ? {} : { replyTo }),
  });
  const header = idempotencyHeader(env);
  const queueMax = wholeKey(env, 'DREFYN_EMAIL_QUEUE_MAX', 100, 1, 1000);

  const host = hostKey(env, 'DREFYN_SMTP_HOST', true);
  if (host === undefined)
    refuse('DREFYN_SMTP_HOST', 'is required with DREFYN_EMAIL_TRANSPORT=smtp');
  const { tls, port } = tlsAndPort(env);
  const allowPlaintext = choice(env, 'DREFYN_SMTP_ALLOW_PLAINTEXT', ['true', 'false']) === 'true';
  const auth = credentials(env, readFile);
  if (tls === 'none' && !allowPlaintext) {
    refuse('DREFYN_SMTP_ALLOW_PLAINTEXT', 'must be true to send without TLS');
  }
  // AUTH over a plain connection hands the password to anyone on the path.
  if (tls === 'none' && auth !== undefined) {
    refuse('DREFYN_SMTP_TLS', 'cannot be none when credentials are set');
  }
  const ca = readCa(env, readFile);
  const servername = hostKey(env, 'DREFYN_SMTP_TLS_SERVERNAME', false);
  const minTlsVersion =
    choice(env, 'DREFYN_SMTP_TLS_MIN_VERSION', ['TLSv1.2', 'TLSv1.3']) ?? 'TLSv1.2';
  const ehloName =
    hostKey(env, 'DREFYN_SMTP_EHLO_NAME', false) ?? from.slice(from.lastIndexOf('@') + 1);

  const connectMs = wholeKey(env, 'DREFYN_SMTP_CONNECT_TIMEOUT_MS', 5000, 1000, 30_000);
  const greetingMs = wholeKey(env, 'DREFYN_SMTP_GREETING_TIMEOUT_MS', 5000, 1000, 30_000);
  const socketMs = wholeKey(env, 'DREFYN_SMTP_SOCKET_TIMEOUT_MS', 10_000, 1000, 60_000);
  const deadlineMs = wholeKey(env, 'DREFYN_SMTP_SEND_DEADLINE_MS', 15_000, 2000, 60_000);
  if (deadlineMs < connectMs) {
    refuse('DREFYN_SMTP_SEND_DEADLINE_MS', 'must be at least DREFYN_SMTP_CONNECT_TIMEOUT_MS');
  }
  const maxConcurrent = wholeKey(env, 'DREFYN_SMTP_MAX_CONCURRENT', 4, 1, 32);

  const smtp: SmtpConfig = Object.freeze({
    host,
    port,
    tls,
    ...(auth === undefined ? {} : { auth }),
    ...(ca === undefined ? {} : { ca }),
    ...(servername === undefined ? {} : { servername }),
    minTlsVersion,
    ehloName,
    timeouts: Object.freeze({ connectMs, greetingMs, socketMs, deadlineMs }),
  });
  return Object.freeze({
    kind: 'smtp',
    sender,
    smtp,
    limits: Object.freeze({ maxConcurrent, queueMax }),
    ...(header === undefined ? {} : { idempotencyHeader: header }),
  });
}

const NONE: EmailConfig = Object.freeze({ kind: 'none' });

// Parsed once at startup. Unset or none means no transport, and auth turns email sign
// in off rather than failing to start.
export function parseEmailConfig(
  env: Env,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): Result<EmailConfig, EmailConfigError> {
  try {
    const transport = choice(env, 'DREFYN_EMAIL_TRANSPORT', ['smtp', 'none']) ?? 'none';
    if (transport === 'none') return { ok: true, value: NONE };
    return { ok: true, value: parseSmtp(env, readFile) };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, error: error.refusal };
    throw error;
  }
}
