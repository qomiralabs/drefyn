import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { TransportPhase } from '../src/index.ts';
import { abortError, toTransportError } from '../src/smtp/errors.ts';
import { runs } from './support.ts';

// The shape Nodemailer gives its errors: its own code, Node's code when it wrapped one,
// the SMTP reply code and the command in flight. The message is never read.
function smtpError(fields: {
  code?: string;
  originalCode?: string;
  responseCode?: number;
  command?: string;
}): Error {
  return Object.assign(new Error('Invalid recipient "person@example.com": 550 no'), fields);
}

const BEFORE_DATA: readonly TransportPhase[] = ['connect', 'tls', 'auth', 'envelope'];

describe('SMTP error mapping', () => {
  it('maps a missing STARTTLS and every certificate failure to tls_failed', () => {
    expect(
      toTransportError(
        smtpError({ code: 'ETLS', responseCode: 502, command: 'STARTTLS' }),
        'connect',
      ),
    ).toEqual({ code: 'email.tls_failed', phase: 'tls' });
    for (const originalCode of [
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'CERT_HAS_EXPIRED',
      'CERT_NOT_YET_VALID',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'ERR_SSL_WRONG_VERSION_NUMBER',
      'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION',
      'HOSTNAME_MISMATCH',
    ]) {
      expect(
        toTransportError(smtpError({ code: 'ESOCKET', originalCode, command: 'CONN' }), 'connect'),
        originalCode,
      ).toEqual({ code: 'email.tls_failed', phase: 'tls' });
    }
  });

  it('maps refused or missing credentials to auth_failed', () => {
    expect(
      toTransportError(
        smtpError({ code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN' }),
        'auth',
      ),
    ).toEqual({ code: 'email.auth_failed', phase: 'auth', smtpReplyClass: 5 });
    expect(toTransportError(smtpError({ code: 'ENOAUTH' }), 'auth')).toEqual({
      code: 'email.auth_failed',
      phase: 'auth',
    });
  });

  it('maps a 421 from the relay to deferred where it happened', () => {
    expect(
      toTransportError(
        smtpError({ code: 'ECONNECTION', responseCode: 421, command: 'CONN' }),
        'connect',
      ),
    ).toEqual({ code: 'email.deferred', phase: 'connect', smtpReplyClass: 4 });
    expect(
      toTransportError(
        smtpError({ code: 'ECONNECTION', responseCode: 421, command: 'EHLO' }),
        'connect',
      ),
    ).toEqual({ code: 'email.deferred', phase: 'connect', smtpReplyClass: 4 });
    expect(
      toTransportError(
        smtpError({ code: 'ECONNECTION', responseCode: 421, command: 'CONN' }),
        'envelope',
      ),
    ).toEqual({ code: 'email.deferred', phase: 'envelope', smtpReplyClass: 4 });
  });

  it('maps envelope replies by class', () => {
    expect(
      toTransportError(
        smtpError({ code: 'EENVELOPE', responseCode: 451, command: 'MAIL FROM' }),
        'envelope',
      ),
    ).toEqual({ code: 'email.deferred', phase: 'envelope', smtpReplyClass: 4 });
    expect(
      toTransportError(
        smtpError({ code: 'EENVELOPE', responseCode: 550, command: 'RCPT TO' }),
        'envelope',
      ),
    ).toEqual({ code: 'email.rejected', phase: 'envelope', smtpReplyClass: 5 });
    expect(
      toTransportError(
        smtpError({ code: 'EENVELOPE', responseCode: 554, command: 'DATA' }),
        'envelope',
      ),
    ).toEqual({ code: 'email.rejected', phase: 'envelope', smtpReplyClass: 5 });
    // Refused before it reached the relay, so there is no reply class to report.
    expect(toTransportError(smtpError({ code: 'EENVELOPE', command: 'API' }), 'envelope')).toEqual({
      code: 'email.rejected',
      phase: 'envelope',
    });
  });

  it('treats a final reply read after the data as a known answer', () => {
    expect(
      toTransportError(
        smtpError({ code: 'EMESSAGE', responseCode: 552, command: 'DATA' }),
        'after_data',
      ),
    ).toEqual({ code: 'email.rejected', phase: 'data', smtpReplyClass: 5 });
    expect(
      toTransportError(
        smtpError({ code: 'EMESSAGE', responseCode: 451, command: 'DATA' }),
        'after_data',
      ),
    ).toEqual({ code: 'email.deferred', phase: 'data', smtpReplyClass: 4 });
  });

  it('maps any ending without a final reply once DATA started to unknown_outcome', () => {
    for (const reached of ['data', 'after_data'] as const) {
      for (const code of [
        'ETIMEDOUT',
        'ECONNECTION',
        'ESOCKET',
        'ESTREAM',
        'EPROTOCOL',
        undefined,
      ]) {
        expect(
          toTransportError(smtpError(code === undefined ? {} : { code, command: 'CONN' }), reached),
          `${reached} ${code ?? 'none'}`,
        ).toEqual({ code: 'email.unknown_outcome', phase: 'after_data' });
      }
    }
  });

  it('maps a timeout before DATA to timeout at the phase it reached', () => {
    for (const reached of BEFORE_DATA) {
      expect(toTransportError(smtpError({ code: 'ETIMEDOUT', command: 'CONN' }), reached)).toEqual({
        code: 'email.timeout',
        phase: reached,
      });
    }
  });

  it('maps lost connections and DNS failures before DATA to connect_failed', () => {
    for (const code of ['ECONNECTION', 'ESOCKET', 'EDNS', 'EPROTOCOL', 'EPROXY']) {
      expect(
        toTransportError(smtpError({ code, originalCode: 'ECONNREFUSED' }), 'connect'),
      ).toEqual({
        code: 'email.connect_failed',
        phase: 'connect',
      });
    }
    expect(toTransportError(smtpError({ code: 'ECONNECTION' }), 'envelope')).toEqual({
      code: 'email.connect_failed',
      phase: 'envelope',
    });
  });

  it('reads a reply class only from 4xx and 5xx codes', () => {
    expect(toTransportError(smtpError({ code: 'EAUTH', responseCode: 334 }), 'auth')).toEqual({
      code: 'email.auth_failed',
      phase: 'auth',
    });
    expect(toTransportError(smtpError({ code: 'EAUTH', responseCode: 454 }), 'auth')).toEqual({
      code: 'email.auth_failed',
      phase: 'auth',
      smtpReplyClass: 4,
    });
  });

  it('maps the abort at the deadline by how far the send got', () => {
    expect(abortError('connect')).toEqual({ code: 'email.timeout', phase: 'connect' });
    expect(abortError('envelope')).toEqual({ code: 'email.timeout', phase: 'envelope' });
    expect(abortError('data')).toEqual({ code: 'email.unknown_outcome', phase: 'after_data' });
    expect(abortError('after_data')).toEqual({
      code: 'email.unknown_outcome',
      phase: 'after_data',
    });
  });

  it('never throws and only ever answers with its own fields, for anything thrown', () => {
    const phase = fc.constantFrom<TransportPhase>(
      'connect',
      'tls',
      'auth',
      'envelope',
      'data',
      'after_data',
    );
    fc.assert(
      fc.property(fc.anything(), phase, (thrown, reached) => {
        const error = toTransportError(thrown, reached);
        expect(
          Object.keys(error).every((k) => ['code', 'phase', 'smtpReplyClass'].includes(k)),
        ).toBe(true);
        expect(error.code).toMatch(/^email\./);
      }),
      runs,
    );
  });

  it('survives an error whose fields throw when read', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
      },
    );
    expect(toTransportError(hostile, 'connect')).toEqual({
      code: 'email.connect_failed',
      phase: 'connect',
    });
    expect(toTransportError(hostile, 'data')).toEqual({
      code: 'email.unknown_outcome',
      phase: 'after_data',
    });
  });
});
