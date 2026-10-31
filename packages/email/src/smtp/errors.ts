import type { TransportError, TransportPhase } from '../types.ts';

// Node and OpenSSL name certificate and handshake failures with these. Nodemailer
// reports a failed certificate check as a socket error and keeps Node's code aside.
const TLS_CODE =
  /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|HOSTNAME_MISMATCH$|INVALID_CA$|INVALID_PURPOSE$|PATH_LENGTH_EXCEEDED$|CRL_)/;

const DATA_STARTED: ReadonlySet<TransportPhase> = new Set(['data', 'after_data']);
const LOST: TransportError = Object.freeze({ code: 'email.unknown_outcome', phase: 'after_data' });

interface Fields {
  readonly code: unknown;
  readonly originalCode: unknown;
  readonly responseCode: unknown;
  readonly command: unknown;
}

// Only these four fields are ever read. The message is not: it holds addresses and the
// relay's reply text.
function fieldsOf(error: unknown): Fields | null {
  if (typeof error !== 'object' || error === null) return null;
  try {
    const e = error as Record<string, unknown>;
    return {
      code: e['code'],
      originalCode: e['originalCode'],
      responseCode: e['responseCode'],
      command: e['command'],
    };
  } catch {
    return null;
  }
}

function replyClass(responseCode: unknown): 4 | 5 | undefined {
  if (typeof responseCode !== 'number' || !Number.isInteger(responseCode)) return undefined;
  if (responseCode >= 400 && responseCode < 500) return 4;
  if (responseCode >= 500 && responseCode < 600) return 5;
  return undefined;
}

function withClass(
  code: TransportError['code'],
  phase: TransportPhase,
  smtpReplyClass: 4 | 5 | undefined,
): TransportError {
  return smtpReplyClass === undefined ? { code, phase } : { code, phase, smtpReplyClass };
}

// What the deadline means for a send cut off at this phase. Once DATA started the relay
// may already hold the message, so sending again could deliver it twice.
export function abortError(reached: TransportPhase): TransportError {
  return DATA_STARTED.has(reached) ? LOST : { code: 'email.timeout', phase: reached };
}

// Maps a Nodemailer error to ours, by its code, Node's code and the reply code, and by
// how far the send got.
export function toTransportError(error: unknown, reached: TransportPhase): TransportError {
  const fields = fieldsOf(error);
  if (fields === null)
    return DATA_STARTED.has(reached) ? LOST : { code: 'email.connect_failed', phase: reached };
  const { code, originalCode, responseCode, command } = fields;
  const cls = replyClass(responseCode);

  if (DATA_STARTED.has(reached)) {
    // A reply to the final dot was read, so the answer is known.
    if (code === 'EMESSAGE' && command === 'DATA' && cls !== undefined) {
      return withClass(cls === 4 ? 'email.deferred' : 'email.rejected', 'data', cls);
    }
    return LOST;
  }
  if (code === 'ETLS' || (typeof originalCode === 'string' && TLS_CODE.test(originalCode))) {
    return { code: 'email.tls_failed', phase: 'tls' };
  }
  if (code === 'EAUTH' || code === 'ENOAUTH') return withClass('email.auth_failed', 'auth', cls);
  if (code === 'ETIMEDOUT') return { code: 'email.timeout', phase: reached };
  // A 421 is the relay closing for now, with the greeting or at any later command.
  if (responseCode === 421) return withClass('email.deferred', reached, 4);
  if (code === 'EENVELOPE' || code === 'EMESSAGE') {
    return withClass(cls === 4 ? 'email.deferred' : 'email.rejected', 'envelope', cls);
  }
  return { code: 'email.connect_failed', phase: reached };
}
