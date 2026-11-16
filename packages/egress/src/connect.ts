import type { Socket } from 'node:net';
import { checkServerIdentity, connect as tlsConnect } from 'node:tls';
import { Deadline } from './deadline.ts';
import { checkPolicy } from './policy.ts';
import { resolveHost } from './resolve.ts';
import type { Runtime } from './runtime.ts';
import { checkBareHost } from './target.ts';
import type { CheckedAddress, EgressError, EgressPolicy, Result } from './types.ts';

export interface TlsName {
  /** Sent as SNI; absent for an address literal, which RFC 6066 does not allow there. */
  readonly servername: string | undefined;
  /** What the certificate must be valid for: the name from the URL, never the address dialled. */
  readonly identity: string;
}

export interface Connection {
  readonly socket: Socket;
  readonly address: CheckedAddress;
}

const ignore = () => undefined;

type Attempt = Result<Connection, EgressError> & { readonly final?: boolean };

const causeOf = (error: unknown): string | undefined => {
  const code: unknown =
    typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
  return typeof code === 'string' ? code : undefined;
};

export function networkFailed(error: unknown, hop: number): EgressError {
  const cause = causeOf(error);
  return { code: 'egress.network_failed', hop, ...(cause === undefined ? {} : { cause }) };
}

function attempt(
  runtime: Runtime,
  address: CheckedAddress,
  port: number,
  tls: TlsName | undefined,
  policy: EgressPolicy,
  deadline: Deadline,
  hop: number,
): Promise<Attempt> {
  return new Promise((resolve) => {
    const tcp = runtime.connect(address.address, port);
    let current: Socket = tcp;
    let done = false;
    const onTcpError = (error: unknown) => {
      finish({ ok: false, error: networkFailed(error, hop) });
    };
    const onTlsError = (error: unknown) => {
      // A certificate or handshake failure is about the server, not the route, so another
      // address of the same name gets no second try.
      finish({ ok: false, error: networkFailed(error, hop), final: true });
    };
    const timer = setTimeout(() => {
      finish({ ok: false, error: { code: 'egress.connect_timeout', hop } });
    }, policy.connectTimeoutMs);
    const unwatch = deadline.watch(() => {
      finish({ ok: false, error: { code: deadline.code, hop }, final: true });
    });
    function finish(result: Attempt): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unwatch();
      tcp.off('error', onTcpError);
      current.off('error', onTlsError);
      if (!result.ok) {
        // A socket being torn down can still report an error; nobody is left to hear it.
        current.on('error', ignore);
        tcp.on('error', ignore);
        current.destroy();
        tcp.destroy();
      }
      resolve(result);
    }
    tcp.once('error', onTcpError);
    tcp.once('connect', () => {
      if (tls === undefined) {
        finish({ ok: true, value: { socket: tcp, address } });
        return;
      }
      const secure = tlsConnect({
        socket: tcp,
        ...(tls.servername === undefined ? {} : { servername: tls.servername }),
        ...(runtime.ca === undefined ? {} : { ca: runtime.ca }),
        ALPNProtocols: ['http/1.1'],
        checkServerIdentity: (_host, cert) => checkServerIdentity(tls.identity, cert),
      });
      current = secure;
      secure.once('error', onTlsError);
      secure.once('secureConnect', () => {
        finish({ ok: true, value: { socket: secure, address } });
      });
    });
  });
}

/** Tries each checked address in order, and never any other. */
export async function dial(
  runtime: Runtime,
  addresses: readonly CheckedAddress[],
  port: number,
  tls: TlsName | undefined,
  policy: EgressPolicy,
  deadline: Deadline,
  hop: number,
): Promise<Result<Connection, EgressError>> {
  let last: Attempt = { ok: false, error: { code: 'egress.connect_timeout', hop } };
  for (const address of addresses) {
    last = await attempt(runtime, address, port, tls, policy, deadline, hop);
    if (last.ok || last.final === true) break;
  }
  if (last.ok) return last;
  return { ok: false, error: last.error };
}

const isPort = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65_535;

export async function guardedConnectWith(
  runtime: Runtime,
  host: string,
  port: number,
  policy: EgressPolicy,
): Promise<Result<Socket, EgressError>> {
  checkPolicy(policy);
  const checked = checkBareHost(host, policy);
  if (!checked.ok) return checked;
  if (!isPort(port) || (policy.ports !== 'any' && !policy.ports.includes(port))) {
    return { ok: false, error: { code: 'egress.port_denied', hop: 0 } };
  }
  const deadline = new Deadline(policy.totalTimeoutMs);
  try {
    const addresses = await resolveHost(runtime, checked.value, policy, deadline, 0);
    if (!addresses.ok) return addresses;
    const connection = await dial(runtime, addresses.value, port, undefined, policy, deadline, 0);
    return connection.ok ? { ok: true, value: connection.value.socket } : connection;
  } finally {
    deadline.dispose();
  }
}
