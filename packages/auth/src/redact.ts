export const REDACTED = '[redacted]';

// Past this depth a log value is replaced whole: removing too much beats a stack overflow
// in the logger or a secret left in a branch nobody walked.
const MAX_DEPTH = 64;

const B = '[0-9a-hjkmnp-tv-z]';
const TEXT_RULES: readonly [RegExp, string][] = [
  // API keys and later drf_ formats, whole or truncated.
  [/drf_[a-z]{2}_[0-9a-z_]+/g, REDACTED],
  // Session tokens (v1. prefix) and invitation tokens share the triple shape.
  [new RegExp(`(?:v1\\.)?${B}{26}\\.${B}{26}\\.${B}{52}`, 'g'), REDACTED],
  // A bare 32 byte secret: pre sign in binding, OAuth state.
  [new RegExp(`${B}{52}`, 'g'), REDACTED],
  [/(Bearer\s+)\S+/g, `$1${REDACTED}`],
  [/((?:__Host-)?drefyn_(?:session|pre|oauth|invite)=)[^;\s]*/g, `$1${REDACTED}`],
  [/([?&#](?:code|state)=)[^&#\s]*/g, `$1${REDACTED}`],
];

export function redactText(text: string): string {
  return TEXT_RULES.reduce(
    (out, [pattern, replacement]) => out.replace(pattern, replacement),
    text,
  );
}

// Keys compared lower case with punctuation removed, so apiKey, api_key and API-KEY match.
const SECRET_PARTS = [
  'password',
  'passphrase',
  'passwd',
  'secret',
  'token',
  'cookie',
  'authorization',
  'apikey',
  'email',
];
const SECRET_NAMES: ReadonlySet<string> = new Set([
  'code',
  'emailcode',
  'oauthcode',
  'authcode',
  'verificationcode',
  'state',
  'oauthstate',
  'otp',
  'pre',
  'invitation',
  'invite',
  'ip',
  'ipaddress',
  'clientip',
  'remoteaddress',
]);

function sensitive(key: string): boolean {
  const name = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SECRET_NAMES.has(name) || SECRET_PARTS.some((part) => name.includes(part));
}

const ERROR_CODE = /^[A-Z][A-Z0-9_]*$/;

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactText(value);
  if (typeof value !== 'object' || value === null) return value;
  if (depth >= MAX_DEPTH) return REDACTED;
  if (value instanceof Date) return value;
  // Bytes in a log context are hashes or secrets; neither belongs there.
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return REDACTED;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const next = (inner: unknown) => walk(inner, depth + 1, seen);
  if (Array.isArray(value)) return value.map(next);
  if (value instanceof Map) {
    return new Map(
      [...value].map(([k, v]: [unknown, unknown]) => [
        k,
        typeof k === 'string' && sensitive(k) ? REDACTED : next(v),
      ]),
    );
  }
  if (value instanceof Set) return new Set([...value].map(next));
  const out: Record<string, unknown> = {};
  if (value instanceof Error) {
    out['name'] = value.name;
    out['message'] = redactText(value.message);
    if (value.stack !== undefined) out['stack'] = redactText(value.stack);
    // Error codes are what logs are for; any other value under code is treated as secret.
    const code = (value as { code?: unknown }).code;
    if (typeof code === 'string' && ERROR_CODE.test(code)) out['code'] = code;
    if (value.cause !== undefined) out['cause'] = next(value.cause);
  }
  for (const [key, inner] of Object.entries(value)) {
    if (key in out) continue;
    out[key] = sensitive(key) ? REDACTED : next(inner);
  }
  return out;
}

// A copy of a structured log value with every secret kind removed, at any depth. The input
// is never changed.
export function redact(value: unknown): unknown {
  return walk(value, 0, new WeakSet());
}
