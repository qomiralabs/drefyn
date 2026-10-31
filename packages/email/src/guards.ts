import { isNormalizedEmailAddress } from '@drefyn/address';
import { z } from 'zod';
import { invalidInput } from './errors.ts';
import { CONTROL } from './headers.ts';
import {
  LINK_PROVIDERS,
  SIGN_IN_CODE_PURPOSES,
  type EmailError,
  type MailMessage,
  type Result,
} from './types.ts';

// Bidi marks, embeddings, overrides and isolates can make a name read as something
// else in the rendered mail, which is all a phishing name needs.
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const ELLIPSIS = '\u2026';
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

// Limits are in code points, which bounds the bytes too; graphemes alone would not,
// since one can carry any number of combining marks.
export function cutName(value: string, limit: number): string {
  if (Array.from(value).length <= limit) return value;
  let out = '';
  let used = 0;
  for (const { segment } of segmenter.segment(value)) {
    const size = Array.from(segment).length;
    if (used + size > limit - 1) break;
    out += segment;
    used += size;
  }
  return out + ELLIPSIS;
}

// A long user agent or organization name is cut rather than refused, so it can never
// block a security notice. Control characters are refused: nothing a person types
// should hold one, and they are how text breaks out of a line.
const name = (limit: number) =>
  z.string().transform((value, ctx) => {
    const trimmed = value.trim();
    if (trimmed === '' || CONTROL.test(value) || BIDI.test(value)) {
      ctx.addIssue({ code: 'custom', message: 'name' });
      return z.NEVER;
    }
    return cutName(trimmed, limit);
  });

// A copy is checked and rendered, never the caller's object: rendering awaits, so the
// caller could edit the original after the check, and a subclass could lie about its
// origin. The copy is a plain URL built from the serialised form.
const url = z.instanceof(URL).transform((value) => new URL(value.href));
const date = z.instanceof(Date).refine((d) => !Number.isNaN(d.getTime()));
const provider = z.enum(LINK_PROVIDERS);

const facts = {
  at: date,
  method: name(100).optional(),
  device: name(120).optional(),
  sessionsLink: url.optional(),
};

const notice = z.discriminatedUnion('kind', [
  z.object({
    ...facts,
    kind: z.enum(['identity_linked', 'identity_unlinked']),
    provider,
    account: name(254),
  }),
  z.object({
    ...facts,
    kind: z.literal('email_changed'),
    newAddress: z.string().refine((value) => isNormalizedEmailAddress(value)),
  }),
  z.object({
    ...facts,
    kind: z.enum([
      'password_set',
      'password_changed',
      'password_removed',
      'password_reset',
      'new_device_sign_in',
    ]),
  }),
  z.object({
    ...facts,
    kind: z.literal('api_key_created'),
    organizationName: name(100),
    keyName: name(100),
  }),
  z.object({
    ...facts,
    kind: z.literal('owner_added'),
    organizationName: name(100),
    ownerName: name(100),
  }),
  z.object({
    ...facts,
    kind: z.literal('member_removed'),
    organizationName: name(100),
    memberName: name(100),
  }),
]);

const message = z.discriminatedUnion('template', [
  z
    .object({
      template: z.literal('sign_in_code'),
      purpose: z.enum(SIGN_IN_CODE_PURPOSES),
      code: z.string().regex(/^[0-9]{8}$/),
      link: url,
      expiresInMinutes: z.number().int().min(1).max(1440),
      linking: z.object({ provider, account: name(254) }).optional(),
    })
    .superRefine((value, ctx) => {
      // The type rules this out; this catches callers that skip the type.
      if ((value.purpose === 'link_identity') !== (value.linking !== undefined)) {
        ctx.addIssue({ code: 'custom', path: ['linking'], message: 'linking' });
      }
    }),
  z.object({
    template: z.literal('invitation'),
    organizationName: name(100),
    inviterName: name(100),
    link: url,
    expiresAt: date,
  }),
  z.object({ template: z.literal('security_notice'), notice }),
]);

// Unions report a bad discriminator at the union itself.
function fieldOf(path: readonly PropertyKey[]): string {
  if (path.length === 0) return 'template';
  const joined = path.map(String).join('.');
  return joined === 'notice' ? 'notice.kind' : joined;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

// Links go only to our own app, so a bug upstream cannot turn a sign in mail into a
// carrier for someone else's link.
function linkAllowed(link: URL, origin: URL): boolean {
  if (link.username !== '' || link.password !== '') return false;
  if (link.origin !== origin.origin) return false;
  if (link.protocol === 'https:') return true;
  return link.protocol === 'http:' && LOOPBACK.has(origin.hostname);
}

// Names come back trimmed and cut to length. Everything else is as given.
export function checkMessage(input: unknown, linkOrigin: URL): Result<MailMessage, EmailError> {
  const parsed = message.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: invalidInput(fieldOf(parsed.error.issues[0]?.path ?? [])) };
  }
  const value = parsed.data as MailMessage;
  if (value.template !== 'security_notice' && !linkAllowed(value.link, linkOrigin)) {
    return { ok: false, error: invalidInput('link') };
  }
  if (value.template === 'security_notice') {
    const sessions = value.notice.sessionsLink;
    if (sessions !== undefined && !linkAllowed(sessions, linkOrigin)) {
      return { ok: false, error: invalidInput('notice.sessionsLink') };
    }
  }
  return { ok: true, value };
}
