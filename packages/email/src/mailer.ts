import { isNormalizedEmailAddress, type NormalizedEmailAddress } from '@drefyn/address';
import { Breaker, healthOf } from './breaker.ts';
import { emailError, invalidInput } from './errors.ts';
import { isHeaderSafe } from './headers.ts';
import { sendLog, safeLogger, safeMetrics, type SendFacts } from './logs.ts';
import { messageIdFor } from './message-id.ts';
import { renderMail } from './render.ts';
import { abortError } from './smtp/errors.ts';
import { createSmtpTransport } from './smtp/nodemailer.ts';
import type {
  EmailConfig,
  EmailDeps,
  EmailError,
  EmailErrorCode,
  Envelope,
  Mailer,
  MailMessage,
  MailTransport,
  RenderedMail,
  SendOptions,
  SendResult,
  TransportError,
  TransportPhase,
  TransportProgress,
} from './types.ts';

type SmtpEmailConfig = Extract<EmailConfig, { kind: 'smtp' }>;

const KEY = /^[\x21-\x7e]{1,200}$/;
const RETRY_MIN_MS = 500;
const RETRY_SPREAD_MS = 1000;
const BEFORE_DATA: ReadonlySet<TransportPhase> = new Set(['connect', 'tls', 'auth', 'envelope']);
const TRANSPORT_CODES: ReadonlySet<string> = new Set<TransportError['code']>([
  'email.connect_failed',
  'email.tls_failed',
  'email.auth_failed',
  'email.timeout',
  'email.deferred',
  'email.rejected',
  'email.unknown_outcome',
]);
// In the order a send moves through them.
const PHASE_ORDER: readonly TransportPhase[] = [
  'connect',
  'tls',
  'auth',
  'envelope',
  'data',
  'after_data',
];
const PHASES: ReadonlySet<string> = new Set<TransportPhase>(PHASE_ORDER);
const LOST: TransportError = Object.freeze({ code: 'email.unknown_outcome', phase: 'after_data' });

const failure = (error: EmailError): SendResult => ({ ok: false, error });
const fail = (code: EmailErrorCode): SendResult => failure(emailError(code));

// Only failures where the message cannot have been accepted yet are retried; once the
// final dot is out, a second try could deliver the mail twice.
function retryable(error: TransportError): boolean {
  switch (error.code) {
    case 'email.connect_failed':
    case 'email.timeout':
      return BEFORE_DATA.has(error.phase);
    case 'email.deferred':
      return error.phase === 'connect' || error.phase === 'envelope';
    default:
      return false;
  }
}

function toEmailError(error: TransportError): EmailError {
  if (error.phase === 'after_data') return emailError('email.unknown_outcome');
  const replyClass =
    error.smtpReplyClass ??
    (error.code === 'email.deferred' ? 4 : error.code === 'email.rejected' ? 5 : undefined);
  return emailError(error.code, replyClass === undefined ? {} : { smtpReplyClass: replyClass });
}

// A transport is our code or a hosted one; either way its answer is checked, and a
// throw or a malformed answer counts as a lost reply, which is never retried.
async function callTransport(
  transport: MailTransport,
  envelope: Envelope,
  mail: RenderedMail,
  signal: AbortSignal,
  progress: TransportProgress,
): Promise<TransportError | null> {
  try {
    const result: unknown = await transport.deliver(envelope, mail, signal, progress);
    if (typeof result !== 'object' || result === null) return LOST;
    const { ok, error } = result as { ok?: unknown; error?: Partial<TransportError> };
    if (ok === true) return null;
    if (
      ok === false &&
      typeof error?.code === 'string' &&
      TRANSPORT_CODES.has(error.code) &&
      typeof error.phase === 'string' &&
      PHASES.has(error.phase)
    ) {
      const { code, phase, smtpReplyClass } = error;
      return smtpReplyClass === 4 || smtpReplyClass === 5
        ? { code, phase, smtpReplyClass }
        : { code, phase };
    }
    return LOST;
  } catch {
    return LOST;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

interface Entry {
  done: boolean;
  grant?: (granted: boolean) => void;
  finish(result: SendResult, attempts: number): void;
}

interface Outcome {
  readonly result: SendResult;
  readonly attempts: number;
}
const early = (result: SendResult): Outcome => ({ result, attempts: 0 });

interface Delivery {
  readonly error: TransportError | null;
  readonly attempts: number;
}

interface Running {
  // The caller's answer, at the latest when the deadline fires.
  readonly answer: Promise<Delivery>;
  // When the transport let go of its connection, which can be after the answer.
  readonly settled: Promise<void>;
}

// The clock is injected for tests. One that throws or returns nonsense falls back to
// wall time rather than leaving a send unsettled.
function safeClock(clock: (() => number) | undefined): () => number {
  if (clock === undefined) return Date.now;
  return () => {
    try {
      const value = clock();
      return Number.isFinite(value) ? value : Date.now();
    } catch {
      return Date.now();
    }
  };
}

// A getter that throws is a bad key, like any other bad key.
function readKey(options: unknown): unknown {
  try {
    return (options as Partial<SendOptions> | null | undefined)?.idempotencyKey;
  } catch {
    return undefined;
  }
}

function notConfigured(deps: EmailDeps): Mailer {
  const logger = safeLogger(deps.logger);
  const metrics = safeMetrics(deps.metrics);
  return {
    configured: false,
    send(_to, message, options) {
      const result = fail('email.not_configured');
      sendLog(logger, metrics, {
        message,
        options,
        result,
        attempts: 0,
        durationMs: 0,
        transport: () => 'none',
      });
      return Promise.resolve(result);
    },
    drain: () => Promise.resolve({ dropped: 0 }),
  };
}

export function createMailer(config: EmailConfig, deps: EmailDeps): Mailer {
  if (config.kind === 'none') return notConfigured(deps);
  return smtpMailer(config, deps, deps.transport ?? createSmtpTransport(config.smtp));
}

function smtpMailer(config: SmtpEmailConfig, deps: EmailDeps, transport: MailTransport): Mailer {
  const clock = safeClock(deps.clock);
  const logger = safeLogger(deps.logger);
  const metrics = safeMetrics(deps.metrics);
  const { maxConcurrent, queueMax } = config.limits;
  const { deadlineMs } = config.smtp.timeouts;
  const { sender } = config;
  const senderDomain = sender.from.slice(sender.from.lastIndexOf('@') + 1);
  const breaker = new Breaker();

  // Admitted sends that have not reached the relay: rendering or waiting for a slot.
  const admitted = new Set<Entry>();
  const waiting: Entry[] = [];
  const active = new Set<Promise<void>>();
  let inFlight = 0;
  let closed = false;

  const depth = () => {
    metrics.gauge('email_queue_depth', waiting.length);
  };

  // A slot is counted the moment it is granted, so sends that finish rendering in the
  // same tick cannot all see a free slot.
  function slot(entry: Entry): Promise<boolean> {
    if (inFlight < maxConcurrent && waiting.length === 0) {
      inFlight += 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      entry.grant = resolve;
      waiting.push(entry);
      depth();
    });
  }

  function release() {
    inFlight -= 1;
    let next = waiting.shift();
    while (next?.done === true) next = waiting.shift();
    depth();
    if (next === undefined) return;
    inFlight += 1;
    next.grant?.(true);
  }

  // One deadline over every attempt. When it fires the transport is told through its
  // signal, and the caller gets its answer whether or not the transport listens. The
  // answer depends on how far the transport said it got: once DATA started, the relay
  // may hold the message, so the outcome is unknown rather than a timeout.
  function deliver(envelope: Envelope, mail: RenderedMail): Running {
    const controller = new AbortController();
    let attempts = 0;
    let reached = 0;
    const progress: TransportProgress = (phase) => {
      const at = PHASE_ORDER.indexOf(phase);
      if (at > reached) reached = at;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<Delivery>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ error: abortError(PHASE_ORDER[reached] ?? 'connect'), attempts });
      }, deadlineMs);
    });
    const work = (async (): Promise<Delivery> => {
      for (;;) {
        attempts += 1;
        reached = 0;
        const error = await callTransport(transport, envelope, mail, controller.signal, progress);
        if (error === null || attempts >= 2 || !retryable(error)) return { error, attempts };
        await sleep(RETRY_MIN_MS + Math.random() * RETRY_SPREAD_MS, controller.signal);
        if (controller.signal.aborted) return { error, attempts };
      }
    })();
    const answer = Promise.race([work, deadline]).finally(() => {
      clearTimeout(timer);
    });
    return { answer, settled: work.then(() => undefined) };
  }

  function envelopeFor(to: NormalizedEmailAddress, key: string): Envelope {
    const headers = new Map([['Auto-Submitted', 'auto-generated']]);
    if (config.idempotencyHeader !== undefined) headers.set(config.idempotencyHeader, key);
    return {
      from: sender.from,
      fromName: sender.fromName,
      to,
      ...(sender.replyTo === undefined ? {} : { replyTo: sender.replyTo }),
      messageId: messageIdFor(key, senderDomain),
      idempotencyKey: key,
      headers,
    };
  }

  // Every value bound for a header is checked here, after the template ran, so a
  // template change cannot slip one through.
  function unsafeHeader(envelope: Envelope, mail: RenderedMail): string | null {
    if (!isHeaderSafe('Subject', mail.subject)) return 'subject';
    for (const [name, value] of envelope.headers) {
      if (!isHeaderSafe(name, value)) return name;
    }
    return null;
  }

  // Resolves to null when drain already answered for this send.
  async function pipeline(
    entry: Entry,
    to: unknown,
    message: unknown,
    options: unknown,
  ): Promise<Outcome | null> {
    const key = readKey(options);
    if (closed) return early(fail('email.unavailable'));
    if (typeof key !== 'string' || !KEY.test(key)) {
      return early(failure(invalidInput('idempotencyKey')));
    }
    if (typeof to !== 'string' || !isNormalizedEmailAddress(to)) {
      return early(failure(invalidInput('to')));
    }
    if (admitted.size + inFlight >= maxConcurrent + queueMax) {
      return early(fail('email.overloaded'));
    }
    if (breaker.check(clock()) === 'refuse') return early(fail('email.unavailable'));

    admitted.add(entry);
    const renderStart = clock();
    const rendered = await renderMail(message as MailMessage, { linkOrigin: deps.linkOrigin });
    if (rendered.ok) {
      metrics.histogram('email_render_duration_ms', clock() - renderStart, {
        template: rendered.value.template,
      });
    }
    if (entry.done) return null;
    if (!rendered.ok) return early(failure(rendered.error));
    const envelope = envelopeFor(to, key);
    const unsafe = unsafeHeader(envelope, rendered.value);
    if (unsafe !== null) return early(failure(invalidInput(unsafe)));

    if (!(await slot(entry))) return null;
    admitted.delete(entry);
    const gate = breaker.acquire(clock());
    if (gate === 'refuse') {
      release();
      return early(fail('email.unavailable'));
    }
    const { answer, settled } = deliver(envelope, rendered.value);
    // The slot is held until the transport has closed its connection, so a relay that
    // stalls past the deadline can never have more live connections than the limit.
    active.add(settled);
    void settled.then(() => {
      active.delete(settled);
      release();
    });
    const { error, attempts } = await answer;
    if (breaker.record(healthOf(error), gate === 'trial', clock())) {
      logger.warn('email.breaker_open', {});
      metrics.counter('email_breaker_open_total', 1);
    }
    if (error === null) {
      return { result: { ok: true, value: { messageId: envelope.messageId, attempts } }, attempts };
    }
    return { result: failure(toEmailError(error)), attempts };
  }

  return {
    configured: true,
    send(to, message, options) {
      const started = clock();
      return new Promise<SendResult>((resolve) => {
        const entry: Entry = {
          done: false,
          finish(result, attempts) {
            if (entry.done) return;
            entry.done = true;
            try {
              admitted.delete(entry);
              const facts: SendFacts = {
                message,
                options,
                result,
                attempts,
                durationMs: clock() - started,
                transport: () => transport.kind,
              };
              sendLog(logger, metrics, facts);
            } finally {
              resolve(result);
            }
          },
        };
        pipeline(entry, to, message, options).then(
          (outcome) => {
            if (outcome !== null) entry.finish(outcome.result, outcome.attempts);
          },
          () => {
            entry.finish(fail('email.unknown_outcome'), 0);
          },
        );
      });
    },

    async drain(timeoutMs) {
      if (closed) return { dropped: 0 };
      closed = true;
      const dropped = [...admitted];
      for (const entry of dropped) {
        entry.finish(fail('email.unavailable'), 0);
        entry.grant?.(false);
      }
      waiting.length = 0;
      depth();
      if (dropped.length > 0) {
        logger.warn('email.dropped_on_shutdown', { dropped: dropped.length });
        metrics.counter('email_dropped_on_shutdown_total', dropped.length);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(active),
        new Promise((resolve) => (timer = setTimeout(resolve, timeoutMs))),
      ]);
      clearTimeout(timer);
      try {
        await transport.close();
      } catch {
        // Shutting down either way; a failed close leaves nothing to undo.
      }
      return { dropped: dropped.length };
    },
  };
}
