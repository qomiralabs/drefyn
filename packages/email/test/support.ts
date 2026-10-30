import fc from 'fast-check';
import { organizationId, projectId } from '@drefyn/tenancy';
import {
  LINK_PROVIDERS,
  SECURITY_NOTICE_KINDS,
  SIGN_IN_CODE_PURPOSES,
  parseEmailConfig,
  type EmailConfig,
  type EmailLogger,
  type EmailMetrics,
  type MailMessage,
  type SecurityNoticeMail,
} from '../src/index.ts';

// FC_SEED replays every property under another seed without editing a file. Unset, every
// machine runs the same seed, so a failure reproduces anywhere.
function seedFrom(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const seed = Number(raw);
  if (!/^-?[0-9]+$/.test(raw) || seed !== (seed | 0)) {
    throw new Error('FC_SEED must be a 32 bit integer');
  }
  return seed;
}

export const runs = { seed: seedFrom(process.env['FC_SEED'], 152), numRuns: 150 } as const;

export const ORIGIN = new URL('https://app.drefyn.test');
export const link = (path = '/verify') => new URL(path, ORIGIN);
export const AT = new Date('2026-10-30T14:05:00.000Z');
export const TENANT = {
  organizationId: organizationId('01890a5d-ac96-774b-bcce-b302099a8057'),
  projectId: projectId('01890a5d-ac96-774b-bcce-b302099a8058'),
} as const;

export const signIn = (patch: Partial<{ code: string; link: URL }> = {}): MailMessage => ({
  template: 'sign_in_code',
  purpose: 'sign_in',
  code: patch.code ?? '12345678',
  link: patch.link ?? link(),
  expiresInMinutes: 10,
});

export const invitation = (
  patch: Partial<{ organizationName: string; inviterName: string; link: URL }> = {},
): MailMessage => ({
  template: 'invitation',
  organizationName: patch.organizationName ?? 'Acme',
  inviterName: patch.inviterName ?? 'Ada Lovelace',
  link: patch.link ?? link('/invite'),
  expiresAt: AT,
});

export const notice = (n: SecurityNoticeMail): MailMessage => ({
  template: 'security_notice',
  notice: n,
});

export const smtpEnv = (patch: Record<string, string | undefined> = {}) => ({
  DREFYN_EMAIL_TRANSPORT: 'smtp',
  DREFYN_EMAIL_FROM: 'mail@drefyn.test',
  DREFYN_SMTP_HOST: 'smtp.drefyn.test',
  ...patch,
});

export function smtpConfig(patch: Record<string, string | undefined> = {}): EmailConfig {
  const result = parseEmailConfig(smtpEnv(patch));
  if (!result.ok) throw new Error(`fixture config refused: ${result.error.key}`);
  return result.value;
}

export interface LogLine {
  readonly level: string;
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>>;
}
export interface MetricCall {
  readonly kind: string;
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

export function recorder(): {
  logger: EmailLogger;
  metrics: EmailMetrics;
  lines: LogLine[];
  calls: MetricCall[];
} {
  const lines: LogLine[] = [];
  const calls: MetricCall[] = [];
  const at =
    (level: string) =>
    (event: string, fields: Readonly<Record<string, unknown>> = {}) =>
      lines.push({ level, event, fields });
  const metric =
    (kind: string) =>
    (name: string, value: number, labels: Readonly<Record<string, string>> = {}) =>
      calls.push({ kind, name, labels, value });
  return {
    lines,
    calls,
    logger: { info: at('info'), warn: at('warn'), error: at('error') },
    metrics: { counter: metric('counter'), histogram: metric('histogram'), gauge: metric('gauge') },
  };
}

// Printable text with no control characters, the shape a cleaned display name has.
export const safeName: fc.Arbitrary<string> = fc
  .string({ unit: 'grapheme', minLength: 1, maxLength: 140 })
  .filter((s) => !/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(s) && s.trim() !== '');

// One control character somewhere in an otherwise ordinary name.
export const hostileName: fc.Arbitrary<string> = fc
  .tuple(
    fc.string({ maxLength: 20 }),
    fc.oneof(
      fc.integer({ min: 0, max: 0x1f }),
      fc.integer({ min: 0x7f, max: 0x9f }),
      fc.constantFrom(0x2028, 0x2029),
    ),
    fc.string({ maxLength: 20 }),
  )
  .map(([a, c, b]) => a + String.fromCharCode(c) + b);

const at = fc
  .date({ min: new Date('2000-01-01T00:00:00Z'), max: new Date('2100-01-01T00:00:00Z') })
  .filter((d) => !Number.isNaN(d.getTime()));
// Prefixed, so a path such as //host cannot read as another origin.
const path = fc.webPath().map((p) => new URL(`/p${p}`, ORIGIN));
const code = fc.stringMatching(/^[0-9]{8}$/);
const provider = fc.constantFrom(...LINK_PROVIDERS);

const facts = fc.record(
  { at, method: safeName, device: safeName, sessionsLink: path },
  { requiredKeys: ['at'] },
);

const noticeArb: fc.Arbitrary<SecurityNoticeMail> = fc
  .tuple(fc.constantFrom(...SECURITY_NOTICE_KINDS), facts, provider, safeName, safeName, safeName)
  .map(([kind, f, p, a, b, c]): SecurityNoticeMail => {
    switch (kind) {
      case 'identity_linked':
      case 'identity_unlinked':
        return { ...f, kind, provider: p, account: a };
      case 'email_changed':
        return { ...f, kind, newAddress: 'new.person@example.com' as never };
      case 'api_key_created':
        return { ...f, kind, organizationName: a, keyName: b };
      case 'owner_added':
        return { ...f, kind, organizationName: a, ownerName: c };
      case 'member_removed':
        return { ...f, kind, organizationName: a, memberName: c };
      default:
        return { ...f, kind };
    }
  });

export const validMessage: fc.Arbitrary<MailMessage> = fc.oneof(
  fc
    .tuple(
      fc.constantFrom(...SIGN_IN_CODE_PURPOSES),
      code,
      path,
      fc.integer({ min: 1, max: 1440 }),
      provider,
      safeName,
    )
    .map(([purpose, c, l, minutes, p, account]): MailMessage =>
      purpose === 'link_identity'
        ? {
            template: 'sign_in_code',
            purpose,
            code: c,
            link: l,
            expiresInMinutes: minutes,
            linking: { provider: p, account },
          }
        : { template: 'sign_in_code', purpose, code: c, link: l, expiresInMinutes: minutes },
    ),
  fc
    .tuple(safeName, safeName, path, at)
    .map(([organizationName, inviterName, l, expiresAt]): MailMessage => ({
      template: 'invitation',
      organizationName,
      inviterName,
      link: l,
      expiresAt,
    })),
  noticeArb.map(notice),
);
