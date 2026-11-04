import { createHash } from 'node:crypto';
import { isLinkShaped, normalizeEmailAddress, type NormalizedEmailAddress } from '@drefyn/address';
import {
  parseOrganizationName,
  type AuthConfig,
  type AuthInvitationMailer,
  type AuthMailer,
  type AuthNoticeMailer,
  type AuthSecurityNotice,
  type SessionMethod,
} from '@drefyn/auth';
import type {
  EmailDeps,
  Mailer,
  MailMessage,
  SecurityNoticeMail,
  SendOptions,
} from '@drefyn/email';
import type { OrganizationId } from '@drefyn/tenancy';
import { loadEmail } from './email-runtime.ts';
import { logInfo, logWarn, type LogContext } from './log.ts';
import { firstEmailOff, forgetMailer, heldMailer, holdMailer } from './mail-holder.ts';

const CODE_MINUTES = 10;
const HASH_BYTES = 16;
const UNNAMED_ORGANIZATION = 'Your organization';

export type OrganizationName = (organizationId: OrganizationId) => Promise<string>;

// The mail prints these as given, so the stored words never reach a reader.
const METHOD_WORDS: Readonly<Record<SessionMethod, string>> = {
  email: 'Email code',
  password: 'Password',
  github: 'GitHub',
  google: 'Google',
  cli_link: 'One time link',
};

function address(value: string): NormalizedEmailAddress {
  const normalized = normalizeEmailAddress(value);
  if (!normalized.ok) throw new Error('email.input_invalid');
  return normalized.value;
}

// Auth treats a rejected send as a failed mail and logs it, so a failure is thrown, and the
// message is only the code.
async function deliver(
  mailer: Mailer,
  to: string,
  message: MailMessage,
  options: SendOptions,
): Promise<void> {
  const result = await mailer.send(address(to), message, options);
  if (!result.ok) throw new Error(result.error.code);
}

const digest = (text: string): string =>
  createHash('sha256').update(text).digest().subarray(0, HASH_BYTES).toString('base64url');

function canonical(value: unknown): unknown {
  if (value instanceof URL) return value.href;
  if (typeof value !== 'object' || value === null || value instanceof Date) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]),
  );
}

// Stable across a retry of one notice to one person, and different for any other person or
// event. Auth's ports stay as they are, so the key comes from the notice itself.
function noticeKey(notice: AuthSecurityNotice, to: NormalizedEmailAddress): string {
  const scope = 'organizationId' in notice ? notice.organizationId : 'user';
  return `notice:${scope}:${digest(JSON.stringify(canonical(notice)))}:${digest(to)}`;
}

// Stored names can predate the rule the mail guard enforces, and a notice matters more than
// the name in it.
async function shownOrganization(
  organizationName: OrganizationName,
  organizationId: OrganizationId,
): Promise<string> {
  const stored = parseOrganizationName(await organizationName(organizationId));
  return stored.ok ? stored.value : UNNAMED_ORGANIZATION;
}

// Notices carry ids, since auth never reads a name it does not need; the mail needs the name.
async function noticeMail(
  notice: AuthSecurityNotice,
  organizationName: OrganizationName,
): Promise<SecurityNoticeMail> {
  switch (notice.kind) {
    case 'email_changed':
      return { ...notice, newAddress: address(notice.newAddress) };
    case 'new_device_sign_in':
      return {
        kind: notice.kind,
        at: notice.at,
        sessionsLink: notice.sessionsLink,
        method: METHOD_WORDS[notice.method],
        // The mail guard refuses a link shape such as Node.js. The notice matters more than
        // the name of the browser, so the name is what goes.
        ...(isLinkShaped(notice.device) ? {} : { device: notice.device }),
      };
    case 'api_key_created':
    case 'api_key_revoked':
      return {
        kind: notice.kind,
        at: notice.at,
        organizationName: await shownOrganization(organizationName, notice.organizationId),
        keyName: notice.keyName,
        displaySuffix: notice.displaySuffix,
      };
    case 'member_removed':
    case 'member_keys_revoked':
      return {
        kind: notice.kind,
        at: notice.at,
        organizationName: await shownOrganization(organizationName, notice.organizationId),
        memberName: notice.memberName,
        revokedKeys: notice.revokedKeys,
      };
    case 'owner_added':
      return {
        kind: notice.kind,
        at: notice.at,
        organizationName: await shownOrganization(organizationName, notice.organizationId),
        memberName: notice.memberName,
      };
    default:
      return notice;
  }
}

export function createAuthMailer(
  mailer: Mailer,
  organizationName: OrganizationName,
): AuthMailer & AuthNoticeMailer & AuthInvitationMailer {
  return {
    async sendSignInCode(to, code, link, purpose, challengeId, linking) {
      const fields = {
        template: 'sign_in_code',
        code,
        link,
        expiresInMinutes: CODE_MINUTES,
      } as const;
      // Auth always names the account on a link code. A mail that names none would ask the
      // person to approve something they cannot see, so it is refused rather than guessed.
      if (purpose === 'link_identity' && linking === undefined) {
        throw new Error('email.input_invalid');
      }
      const message: MailMessage =
        purpose === 'link_identity' && linking !== undefined
          ? { ...fields, purpose, linking }
          : { ...fields, purpose: purpose as Exclude<typeof purpose, 'link_identity'> };
      await deliver(mailer, to, message, { idempotencyKey: `code:${challengeId}` });
    },
    async sendSecurityNotice(to, notice) {
      const message: MailMessage = {
        template: 'security_notice',
        notice: await noticeMail(notice, organizationName),
      };
      await deliver(mailer, to, message, {
        idempotencyKey: noticeKey(notice, address(to)),
        ...('organizationId' in notice
          ? { tenant: { organizationId: notice.organizationId } }
          : {}),
      });
    },
    async sendInvitation(to, invitation) {
      const { organizationId, invitationId, sendCount } = invitation;
      await deliver(
        mailer,
        to,
        {
          template: 'invitation',
          organizationName: invitation.organizationName,
          inviterName: invitation.inviterName,
          link: invitation.link,
          blockLink: invitation.blockLink,
          expiresAt: invitation.expiresAt,
        },
        {
          idempotencyKey: `invite:${organizationId}:${invitationId}:${String(sendCount)}`,
          tenant: { organizationId },
        },
      );
    },
  };
}

// Sends refuse, as a transport with nothing configured does, and no mail code is loaded.
const NO_MAILER: Mailer = {
  configured: false,
  send: () =>
    Promise.resolve({ ok: false, error: { code: 'email.not_configured', retryable: false } }),
  drain: () => Promise.resolve({ dropped: 0 }),
};

const plain = (fields: Readonly<Record<string, unknown>> | undefined): LogContext => {
  const kept: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (['string', 'number', 'boolean'].includes(typeof value)) {
      kept[key] = value as string | number | boolean;
    }
  }
  return kept;
};

const emailLogger: EmailDeps['logger'] = {
  info: (event, fields) => {
    logInfo(event, plain(fields));
  },
  warn: (event, fields) => {
    logWarn(event, plain(fields));
  },
  error: (event, fields) => {
    logWarn(event, plain(fields));
  },
};

const noMetrics: EmailDeps['metrics'] = {
  counter: () => undefined,
  histogram: () => undefined,
  gauge: () => undefined,
};

interface MailerDeps {
  readonly linkOrigin: URL;
  readonly enabled: () => Promise<boolean>;
}

async function openMailer({ linkOrigin, enabled }: MailerDeps): Promise<Mailer | null> {
  if (!(await enabled().catch(() => false))) return null;
  const { createMailer, parseEmailConfig } = await loadEmail();
  const config = parseEmailConfig(process.env);
  if (!config.ok) throw new Error('email config refused');
  const mailer = createMailer(config.value, {
    linkOrigin,
    logger: emailLogger,
    metrics: noMetrics,
  });
  if (mailer.configured) logInfo('dashboard.email_ready');
  return mailer;
}

// One mailer per process, whichever layer asks first. A failed load is forgotten, so a later
// compose tries again, and is logged with no detail: its message can hold a path.
export function warmMailer(deps: MailerDeps): Promise<Mailer | null> {
  const held = heldMailer();
  if (held !== undefined) return held;
  const opening = openMailer(deps).catch(() => {
    logWarn('dashboard.email_load_failed');
    forgetMailer();
    return null;
  });
  holdMailer(opening);
  return opening;
}

export interface DashboardMail {
  readonly auth: AuthMailer & AuthNoticeMailer & AuthInvitationMailer;
  // False with the flag off, no transport, or a failed load.
  readonly configured: boolean;
}

// Never rejects: mail failing to load must leave OAuth, passwords and CLI links working.
export async function dashboardMail(deps: {
  readonly linkOrigin: URL;
  readonly organizationName: OrganizationName;
  readonly enabled: () => Promise<boolean>;
}): Promise<DashboardMail> {
  const mailer = (await warmMailer(deps)) ?? NO_MAILER;
  return {
    auth: createAuthMailer(mailer, deps.organizationName),
    configured: mailer.configured,
  };
}

// Once per process, however many layers compose.
export function noteEmailOff(mail: DashboardMail, email: AuthConfig['email']): void {
  if (mail.configured || email === 'off' || !firstEmailOff()) return;
  logWarn('dashboard.email_off');
}
