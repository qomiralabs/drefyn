import { lookup } from 'node:dns/promises';
import { connect, type Socket } from 'node:net';

export interface LookupAnswer {
  readonly address: string;
  readonly family: number;
}

// The two places the guard touches the network. Tests swap them to record where a
// connection would go and to answer DNS like an attacker; production uses these.
export interface Runtime {
  lookup(hostname: string): Promise<readonly LookupAnswer[]>;
  /** A plain TCP socket to an address that has already been checked. */
  connect(address: string, port: number): Socket;
  /** Extra trusted certificates, for test fixtures only. */
  readonly ca?: string | Buffer;
}

export const defaultRuntime: Runtime = {
  // The system resolver, so /etc/hosts and the container's DNS behave as they do for
  // every other client on the host. The answer is checked and then used as is.
  lookup: (hostname) => lookup(hostname, { all: true, order: 'verbatim' }),
  // An address, never a name, so Node does no lookup of its own.
  connect: (address, port) => connect({ host: address, port }),
};
