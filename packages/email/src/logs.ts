import type { EmailConfigError } from './config.ts';
import {
  SECURITY_NOTICE_KINDS,
  SIGN_IN_CODE_PURPOSES,
  type EmailConfig,
  type EmailLogger,
  type EmailMetrics,
  type Result,
  type SendResult,
} from './types.ts';

const TEMPLATES: ReadonlySet<unknown> = new Set(['sign_in_code', 'invitation', 'security_notice']);
const PURPOSES: ReadonlySet<unknown> = new Set(SIGN_IN_CODE_PURPOSES);
const NOTICE_KINDS: ReadonlySet<unknown> = new Set(SECURITY_NOTICE_KINDS);
// Tenant ids are UUIDs. Anything else a caller passes is dropped, since it could be
// an address or a name.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Logging and metrics must never be the reason a send fails, so a port that throws is
// ignored.
export function safeLogger(logger: EmailLogger): EmailLogger {
  return {
    log(level, event, fields) {
      try {
        logger.log(level, event, fields);
      } catch {
        // Nothing to do: the send result is what matters.
      }
    },
  };
}

export function safeMetrics(metrics: EmailMetrics): EmailMetrics {
  const guard = (work: () => void) => {
    try {
      work();
    } catch {
      // As for the logger.
    }
  };
  return {
    count: (name, labels, value) => {
      guard(() => {
        metrics.count(name, labels, value);
      });
    },
    observe: (name, labels, value) => {
      guard(() => {
        metrics.observe(name, labels, value);
      });
    },
    gauge: (name, value) => {
      guard(() => {
        metrics.gauge(name, value);
      });
    },
  };
}

export interface SendFacts {
  readonly message: unknown;
  readonly options: unknown;
  readonly result: SendResult;
  readonly attempts: number;
  readonly durationMs: number;
  readonly transport: string;
}

// Reads only fields whose values come from closed lists, never free text, and survives
// a message that throws when read.
function pick(read: () => unknown, allowed: ReadonlySet<unknown>): string | null {
  try {
    const value = read();
    return allowed.has(value) ? (value as string) : null;
  } catch {
    return null;
  }
}

function tenantId(read: () => unknown): string | null {
  try {
    const value = read();
    return typeof value === 'string' && UUID.test(value) ? value : null;
  } catch {
    return null;
  }
}

type Loose = Record<string, unknown> | null | undefined;

function outcomeOf(result: SendResult): string {
  if (result.ok) return 'sent';
  switch (result.error.code) {
    case 'email.timeout':
    case 'email.unknown_outcome':
    case 'email.overloaded':
    case 'email.unavailable':
    case 'email.input_invalid':
    case 'email.render_failed':
      return result.error.code.slice('email.'.length);
    default:
      return 'failed';
  }
}

export function sendLog(logger: EmailLogger, metrics: EmailMetrics, facts: SendFacts): void {
  const message = facts.message as Loose;
  const tenant = (facts.options as Loose)?.['tenant'] as Loose;
  const template = pick(() => message?.['template'], TEMPLATES);
  const purpose = template === 'sign_in_code' ? pick(() => message?.['purpose'], PURPOSES) : null;
  const noticeKind =
    template === 'security_notice'
      ? pick(() => (message?.['notice'] as Loose)?.['kind'], NOTICE_KINDS)
      : null;
  const outcome = outcomeOf(facts.result);
  const error = facts.result.ok ? null : facts.result.error;
  logger.log(facts.result.ok ? 'info' : 'warn', 'email.send', {
    template,
    purpose,
    noticeKind,
    outcome,
    errorCode: error?.code ?? null,
    smtpReplyClass: error?.smtpReplyClass ?? null,
    attempts: facts.attempts,
    durationMs: facts.durationMs,
    transport: facts.transport,
    organizationId: tenantId(() => tenant?.['organizationId']),
    projectId: tenantId(() => tenant?.['projectId']),
  });
  const labels = { template: template ?? 'unknown', purpose: purpose ?? noticeKind ?? 'none' };
  metrics.count('email_sends_total', { ...labels, outcome });
  metrics.observe(
    'email_send_duration_ms',
    { template: labels.template, outcome },
    facts.durationMs,
  );
}

// Startup lines: what kind of transport runs, never where it points or who it signs in as.
export function logEmailConfig(
  result: Result<EmailConfig, EmailConfigError>,
  logger: EmailLogger,
): void {
  const log = safeLogger(logger);
  if (!result.ok) {
    log.log('error', 'email.config_invalid', { key: result.error.key });
    return;
  }
  const config = result.value;
  if (config.kind === 'none') {
    log.log('warn', 'email.no_transport', {});
    return;
  }
  log.log('info', 'email.transport_configured', {
    kind: config.kind,
    tls: config.smtp.tls,
    port: config.smtp.port,
  });
  if (config.smtp.tls === 'none') log.log('warn', 'email.plaintext_smtp', {});
}
