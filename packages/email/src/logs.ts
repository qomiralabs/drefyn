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
function quietly(work: () => void): void {
  try {
    work();
  } catch {
    // Nothing to do: the send result is what matters.
  }
}

export function safeLogger(logger: EmailLogger): EmailLogger {
  return {
    info: (event, fields) => {
      quietly(() => {
        logger.info(event, fields);
      });
    },
    warn: (event, fields) => {
      quietly(() => {
        logger.warn(event, fields);
      });
    },
    error: (event, fields) => {
      quietly(() => {
        logger.error(event, fields);
      });
    },
  };
}

export function safeMetrics(metrics: EmailMetrics): EmailMetrics {
  return {
    counter: (name, value, labels) => {
      quietly(() => {
        metrics.counter(name, value, labels);
      });
    },
    histogram: (name, value, labels) => {
      quietly(() => {
        metrics.histogram(name, value, labels);
      });
    },
    gauge: (name, value, labels) => {
      quietly(() => {
        metrics.gauge(name, value, labels);
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
  // Read lazily: a hosted transport's kind getter is outside our control.
  readonly transport: () => unknown;
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

function read(work: () => unknown): unknown {
  try {
    return work();
  } catch {
    return undefined;
  }
}

// Never throws: every read of caller supplied data is guarded, and so is each port.
export function sendLog(logger: EmailLogger, metrics: EmailMetrics, facts: SendFacts): void {
  quietly(() => {
    const message = facts.message as Loose;
    const tenant = read(() => (facts.options as Loose)?.['tenant']) as Loose;
    const template = pick(() => message?.['template'], TEMPLATES);
    const purpose = template === 'sign_in_code' ? pick(() => message?.['purpose'], PURPOSES) : null;
    const noticeKind =
      template === 'security_notice'
        ? pick(() => (message?.['notice'] as Loose)?.['kind'], NOTICE_KINDS)
        : null;
    const kind = read(facts.transport);
    const outcome = outcomeOf(facts.result);
    const error = facts.result.ok ? null : facts.result.error;
    const fields = {
      template,
      purpose,
      noticeKind,
      outcome,
      errorCode: error?.code ?? null,
      smtpReplyClass: error?.smtpReplyClass ?? null,
      attempts: facts.attempts,
      durationMs: facts.durationMs,
      transport: typeof kind === 'string' ? kind : null,
      organizationId: tenantId(() => tenant?.['organizationId']),
      projectId: tenantId(() => tenant?.['projectId']),
    };
    if (facts.result.ok) logger.info('email.send', fields);
    else logger.warn('email.send', fields);
    const labels = { template: template ?? 'unknown', purpose: purpose ?? noticeKind ?? 'none' };
    metrics.counter('email_sends_total', 1, { ...labels, outcome });
    metrics.histogram('email_send_duration_ms', facts.durationMs, {
      template: labels.template,
      outcome,
    });
  });
}

// Startup lines: what kind of transport runs, never where it points or who it signs in as.
export function logEmailConfig(
  result: Result<EmailConfig, EmailConfigError>,
  logger: EmailLogger,
): void {
  const log = safeLogger(logger);
  if (!result.ok) {
    log.error('email.config_invalid', { key: result.error.key });
    return;
  }
  const config = result.value;
  if (config.kind === 'none') {
    log.warn('email.no_transport', {});
    return;
  }
  log.info('email.transport_configured', {
    kind: config.kind,
    tls: config.smtp.tls,
    port: config.smtp.port,
  });
  if (config.smtp.tls === 'none') log.warn('email.plaintext_smtp', {});
}
