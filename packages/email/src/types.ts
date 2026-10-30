import type { NormalizedEmailAddress, Result } from '@drefyn/address';
import type { OrganizationRef, TenantRef } from '@drefyn/tenancy';
import type { Secret } from './secret.ts';

export type { Result };

export const SIGN_IN_CODE_PURPOSES = Object.freeze([
  'sign_in',
  'link_identity',
  'step_up',
  'password_reset',
  'cli_link',
  'email_change',
] as const);
export type SignInCodePurpose = (typeof SIGN_IN_CODE_PURPOSES)[number];

export const LINK_PROVIDERS = Object.freeze(['github', 'google'] as const);
export type LinkProvider = (typeof LINK_PROVIDERS)[number];

export const SECURITY_NOTICE_KINDS = Object.freeze([
  'identity_linked',
  'identity_unlinked',
  'email_changed',
  'password_set',
  'password_changed',
  'password_removed',
  'password_reset',
  'new_device_sign_in',
  'api_key_created',
  'owner_added',
  'member_removed',
] as const);
export type SecurityNoticeKind = (typeof SECURITY_NOTICE_KINDS)[number];

export interface NoticeFacts {
  // Shown in UTC with the zone named, so a reader in any zone can compare it.
  readonly at: Date;
  readonly method?: string;
  readonly device?: string;
  readonly sessionsLink?: URL;
}

export type SecurityNoticeMail =
  | (NoticeFacts & {
      readonly kind: 'identity_linked' | 'identity_unlinked';
      readonly provider: LinkProvider;
      readonly account: string;
    })
  | (NoticeFacts & { readonly kind: 'email_changed'; readonly newAddress: NormalizedEmailAddress })
  | (NoticeFacts & {
      readonly kind:
        | 'password_set'
        | 'password_changed'
        | 'password_removed'
        | 'password_reset'
        | 'new_device_sign_in';
    })
  | (NoticeFacts & {
      readonly kind: 'api_key_created';
      readonly organizationName: string;
      readonly keyName: string;
    })
  | (NoticeFacts & {
      readonly kind: 'owner_added';
      readonly organizationName: string;
      readonly ownerName: string;
    })
  | (NoticeFacts & {
      readonly kind: 'member_removed';
      readonly organizationName: string;
      readonly memberName: string;
    });

interface CodeFields {
  readonly template: 'sign_in_code';
  readonly code: string;
  readonly link: URL;
  readonly expiresInMinutes: number;
}

export interface Linking {
  readonly provider: LinkProvider;
  readonly account: string;
}

// Split by purpose so a link code without the identity it links fails to compile.
export type SignInCodeMail =
  | (CodeFields & { readonly purpose: 'link_identity'; readonly linking: Linking })
  | (CodeFields & {
      readonly purpose: Exclude<SignInCodePurpose, 'link_identity'>;
      readonly linking?: never;
    });

export interface InvitationMail {
  readonly template: 'invitation';
  readonly organizationName: string;
  readonly inviterName: string;
  readonly link: URL;
  readonly expiresAt: Date;
}

export type MailMessage =
  | SignInCodeMail
  | InvitationMail
  | { readonly template: 'security_notice'; readonly notice: SecurityNoticeMail };
export type TemplateId = MailMessage['template'];

export type EmailErrorCode =
  | 'email.not_configured'
  | 'email.input_invalid'
  | 'email.render_failed'
  | 'email.connect_failed'
  | 'email.tls_failed'
  | 'email.auth_failed'
  | 'email.timeout'
  // 4xx after the one retry
  | 'email.deferred'
  // 5xx
  | 'email.rejected'
  // no reply after the final dot, so the message may already be queued
  | 'email.unknown_outcome'
  | 'email.overloaded'
  | 'email.unavailable';

export interface EmailError {
  readonly code: EmailErrorCode;
  // True when the same send may work later; never a signal to retry at once.
  readonly retryable: boolean;
  readonly field?: string;
  readonly smtpReplyClass?: 4 | 5;
}

export interface SendOptions {
  // 1 to 200 printable ASCII characters, no spaces. Never logged.
  readonly idempotencyKey: string;
  // Log context only.
  readonly tenant?: OrganizationRef | TenantRef;
}

export type SendResult = Result<
  { readonly messageId: string; readonly attempts: number },
  EmailError
>;

export interface Mailer {
  readonly configured: boolean;
  // Never throws and never rejects.
  send(to: string, message: MailMessage, options: SendOptions): Promise<SendResult>;
  drain(timeoutMs: number): Promise<{ readonly dropped: number }>;
}

export interface RenderedMail {
  readonly template: TemplateId;
  readonly purpose?: SignInCodePurpose;
  readonly noticeKind?: SecurityNoticeKind;
  readonly subject: string;
  readonly preheader: string;
  readonly html: string;
  readonly text: string;
}

export interface Envelope {
  readonly from: NormalizedEmailAddress;
  readonly fromName: string;
  readonly to: NormalizedEmailAddress;
  readonly replyTo?: NormalizedEmailAddress;
  readonly messageId: string;
  // For transports that hand it to a provider; never logged.
  readonly idempotencyKey: string;
  readonly headers: ReadonlyMap<string, string>;
}

export type TransportPhase = 'connect' | 'tls' | 'auth' | 'envelope' | 'data' | 'after_data';

export interface TransportError {
  readonly code: Exclude<
    EmailErrorCode,
    | 'email.not_configured'
    | 'email.input_invalid'
    | 'email.render_failed'
    | 'email.overloaded'
    | 'email.unavailable'
  >;
  readonly phase: TransportPhase;
  readonly smtpReplyClass?: 4 | 5;
}

export interface MailTransport {
  readonly kind: 'smtp' | 'test' | (string & {});
  deliver(
    envelope: Envelope,
    mail: RenderedMail,
    signal: AbortSignal,
  ): Promise<Result<{ readonly messageId: string }, TransportError>>;
  close(): Promise<void>;
}

export interface SenderConfig {
  readonly from: NormalizedEmailAddress;
  readonly fromName: string;
  readonly replyTo?: NormalizedEmailAddress;
}

export type TlsMode = 'implicit' | 'starttls' | 'none';

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly tls: TlsMode;
  readonly auth?: { readonly user: string; readonly password: Secret };
  // PEM text added to the trusted roots.
  readonly ca?: string;
  readonly servername?: string;
  readonly minTlsVersion: 'TLSv1.2' | 'TLSv1.3';
  readonly ehloName: string;
  readonly timeouts: {
    readonly connectMs: number;
    readonly greetingMs: number;
    readonly socketMs: number;
    readonly deadlineMs: number;
  };
}

export interface SendLimits {
  readonly maxConcurrent: number;
  readonly queueMax: number;
}

export type EmailConfig =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'smtp';
      readonly sender: SenderConfig;
      readonly smtp: SmtpConfig;
      readonly limits: SendLimits;
      readonly idempotencyHeader?: string;
    };

export type EmailLogEvent =
  | 'email.send'
  | 'email.transport_configured'
  | 'email.no_transport'
  | 'email.plaintext_smtp'
  | 'email.config_invalid'
  | 'email.breaker_open'
  | 'email.dropped_on_shutdown';
export type EmailLogFields = Readonly<Record<string, string | number | null>>;

// The same shape as the flags and db ports, so one app adapter serves every package.
export interface EmailLogger {
  info(event: EmailLogEvent, fields?: EmailLogFields): void;
  warn(event: EmailLogEvent, fields?: EmailLogFields): void;
  error(event: EmailLogEvent, fields?: EmailLogFields): void;
}

export type EmailCounter =
  'email_sends_total' | 'email_breaker_open_total' | 'email_dropped_on_shutdown_total';
export type EmailHistogram = 'email_send_duration_ms' | 'email_render_duration_ms';
export type MetricLabels = Readonly<Record<string, string>>;

export interface EmailMetrics {
  counter(name: EmailCounter, value: number, labels?: MetricLabels): void;
  histogram(name: EmailHistogram, value: number, labels?: MetricLabels): void;
  gauge(name: 'email_queue_depth', value: number, labels?: MetricLabels): void;
}

export interface EmailDeps {
  // The app origin; every link in a message must be on it.
  readonly linkOrigin: URL;
  readonly logger: EmailLogger;
  readonly metrics: EmailMetrics;
  readonly transport?: MailTransport;
  readonly clock?: () => number;
}
