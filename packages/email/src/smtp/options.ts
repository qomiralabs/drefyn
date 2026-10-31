import type { SmtpConfig } from '../types.ts';

// The subset of Nodemailer's connection options we set, as plain data so it can be
// tested without opening a connection. AUTH is passed at login and never lives here.
export interface ConnectionOptions {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly requireTLS: boolean;
  readonly ignoreTLS: boolean;
  readonly opportunisticTLS: false;
  readonly servername?: string;
  readonly name: string;
  readonly connectionTimeout: number;
  readonly dnsTimeout: number;
  readonly greetingTimeout: number;
  readonly socketTimeout: number;
  readonly logger: false;
  readonly debug: false;
  readonly transactionLog: false;
  readonly tls: {
    // There is no key that sets this to anything else.
    readonly rejectUnauthorized: true;
    readonly minVersion: 'TLSv1.2' | 'TLSv1.3';
    readonly servername?: string;
    readonly ca?: string;
  };
}

// An IP literal is checked against the certificate's IP entries; sending it as SNI is
// not allowed by RFC 6066, so only a host name or the configured server name is sent.
function nameToCheck(config: SmtpConfig): string | undefined {
  if (config.servername !== undefined) return config.servername;
  return /^[0-9.]+$/.test(config.host) || config.host.includes(':') ? undefined : config.host;
}

export function connectionOptions(config: SmtpConfig): ConnectionOptions {
  const servername = nameToCheck(config);
  const { connectMs, greetingMs, socketMs } = config.timeouts;
  return {
    host: config.host,
    port: config.port,
    secure: config.tls === 'implicit',
    // A relay that does not offer STARTTLS fails the send instead of going plaintext.
    requireTLS: config.tls === 'starttls',
    // Plaintext is an explicit opt in, so an offered STARTTLS is not taken half way.
    ignoreTLS: config.tls === 'none',
    opportunisticTLS: false,
    ...(servername === undefined ? {} : { servername }),
    name: config.ehloName,
    connectionTimeout: connectMs,
    dnsTimeout: connectMs,
    greetingTimeout: greetingMs,
    socketTimeout: socketMs,
    logger: false,
    debug: false,
    transactionLog: false,
    tls: {
      rejectUnauthorized: true,
      minVersion: config.minTlsVersion,
      ...(servername === undefined ? {} : { servername }),
      ...(config.ca === undefined ? {} : { ca: config.ca }),
    },
  };
}
