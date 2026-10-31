import type {
  Envelope,
  MailTransport,
  RenderedMail,
  Result,
  SecurityNoticeKind,
  SignInCodePurpose,
  TemplateId,
  TransportError,
  TransportPhase,
  TransportProgress,
} from './types.ts';

export interface CapturedMail {
  readonly to: string;
  readonly idempotencyKey: string;
  readonly messageId: string;
  readonly template: TemplateId;
  readonly purpose?: SignInCodePurpose;
  readonly noticeKind?: SecurityNoticeKind;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly code?: string;
  readonly links: readonly URL[];
}

export interface TestTransport extends MailTransport {
  readonly sent: readonly CapturedMail[];
  failNext(code: TransportError['code'], phase?: TransportError['phase']): void;
  // Never answers until the signal aborts, like a relay that stalls. With a phase, it
  // reports progress up to that phase first, so a test can stall a send after DATA.
  hangNext(after?: TransportPhase): void;
  clear(): void;
}

type Plan =
  | { readonly kind: 'fail'; readonly error: TransportError }
  | { readonly kind: 'hang'; readonly after?: TransportPhase };
type Delivered = Result<{ readonly messageId: string }, TransportError>;

// Where each failure usually happens, so a test can name only the code.
const DEFAULT_PHASE: Readonly<Record<TransportError['code'], TransportError['phase']>> = {
  'email.connect_failed': 'connect',
  'email.tls_failed': 'tls',
  'email.auth_failed': 'auth',
  'email.timeout': 'connect',
  'email.deferred': 'envelope',
  'email.rejected': 'envelope',
  'email.unknown_outcome': 'after_data',
};

const CODE_LINE = /^[0-9]{8}$/m;
const LINK_LINE = /^https?:\/\/\S+$/gm;

// Read back from the text part, so a test that finds the code here also proves the
// person can read it without HTML.
function capture(envelope: Envelope, mail: RenderedMail): CapturedMail {
  const code = CODE_LINE.exec(mail.text)?.[0];
  const links = [...new Set(mail.text.match(LINK_LINE) ?? [])].map((href) => new URL(href));
  return Object.freeze({
    to: envelope.to,
    idempotencyKey: envelope.idempotencyKey,
    messageId: envelope.messageId,
    template: mail.template,
    ...(mail.purpose === undefined ? {} : { purpose: mail.purpose }),
    ...(mail.noticeKind === undefined ? {} : { noticeKind: mail.noticeKind }),
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    ...(code === undefined ? {} : { code }),
    links,
  });
}

// The phases a send through an authenticating relay reports, in order.
const STEPS: readonly TransportPhase[] = ['connect', 'auth', 'envelope', 'data', 'after_data'];
const SENT_STEPS: readonly TransportPhase[] = ['connect', 'envelope', 'data', 'after_data'];

function hang(
  signal: AbortSignal,
  after: TransportPhase | undefined,
  progress: TransportProgress | undefined,
): Promise<Delivered> {
  let reached: TransportPhase = 'connect';
  if (after !== undefined) {
    for (const step of STEPS.slice(0, STEPS.indexOf(after) + 1)) {
      reached = step;
      progress?.(step);
    }
  }
  const error: TransportError =
    reached === 'data' || reached === 'after_data'
      ? { code: 'email.unknown_outcome', phase: 'after_data' }
      : { code: 'email.timeout', phase: reached };
  const stalled: Delivered = { ok: false, error };
  if (signal.aborted) return Promise.resolve(stalled);
  return new Promise((resolve) => {
    signal.addEventListener(
      'abort',
      () => {
        resolve(stalled);
      },
      { once: true },
    );
  });
}

export function createTestTransport(): TestTransport {
  const sent: CapturedMail[] = [];
  const plans: Plan[] = [];
  return {
    kind: 'test',
    get sent() {
      return [...sent];
    },
    failNext(code, phase = DEFAULT_PHASE[code]) {
      const smtpReplyClass =
        code === 'email.deferred' ? 4 : code === 'email.rejected' ? 5 : undefined;
      plans.push({
        kind: 'fail',
        error: smtpReplyClass === undefined ? { code, phase } : { code, phase, smtpReplyClass },
      });
    },
    hangNext(after) {
      plans.push(after === undefined ? { kind: 'hang' } : { kind: 'hang', after });
    },
    clear() {
      sent.length = 0;
      plans.length = 0;
    },
    deliver(envelope, mail, signal, progress) {
      const plan = plans.shift();
      if (plan?.kind === 'hang') return hang(signal, plan.after, progress);
      if (plan?.kind === 'fail') return Promise.resolve({ ok: false, error: plan.error });
      for (const step of SENT_STEPS) progress?.(step);
      sent.push(capture(envelope, mail));
      return Promise.resolve({ ok: true, value: { messageId: envelope.messageId } });
    },
    close: () => Promise.resolve(),
  };
}
