import { createSocket, type Socket } from 'node:dgram';

// A tiny authoritative DNS server on 127.0.0.1 for the rebinding tests. Each A query for
// a name gets the next address from that name's list, wrapping around, with a TTL of 0,
// which is exactly what a rebinding attacker serves. AAAA and other types get an empty
// answer so a resolver falls back to the A records.

export interface DnsFixture {
  readonly port: number;
  /** Queries seen per name, so a test can prove how often a name was resolved. */
  readonly queries: Map<string, number>;
  close(): Promise<void>;
}

const TYPE_A = 1;

function readName(msg: Buffer, start: number): { name: string; end: number } {
  const labels: string[] = [];
  let at = start;
  while (at < msg.length) {
    const len = msg[at] ?? 0;
    at += 1;
    if (len === 0) break;
    labels.push(msg.subarray(at, at + len).toString('latin1'));
    at += len;
  }
  return { name: labels.join('.').toLowerCase(), end: at };
}

function answer(query: Buffer, addresses: readonly string[] | undefined, next: () => string) {
  const { end } = readName(query, 12);
  const qtype = query.readUInt16BE(end);
  const question = query.subarray(12, end + 4);
  const header = Buffer.alloc(12);
  query.copy(header, 0, 0, 2);
  // Response, authoritative, recursion available; NXDOMAIN for unknown names.
  header.writeUInt16BE(addresses === undefined ? 0x8583 : 0x8580, 2);
  header.writeUInt16BE(1, 4);
  if (addresses === undefined || qtype !== TYPE_A) return Buffer.concat([header, question]);
  header.writeUInt16BE(1, 6);
  const record = Buffer.alloc(16);
  record.writeUInt16BE(0xc00c, 0);
  record.writeUInt16BE(TYPE_A, 2);
  record.writeUInt16BE(1, 4);
  record.writeUInt32BE(0, 6);
  record.writeUInt16BE(4, 10);
  next()
    .split('.')
    .forEach((octet, i) => record.writeUInt8(Number(octet), 12 + i));
  return Buffer.concat([header, question, record]);
}

export async function startDnsFixture(
  zone: Readonly<Record<string, readonly string[]>>,
): Promise<DnsFixture> {
  const socket: Socket = createSocket('udp4');
  const queries = new Map<string, number>();
  const turns = new Map<string, number>();
  socket.on('message', (msg, peer) => {
    const { name, end } = readName(msg, 12);
    const addresses = zone[name];
    if (msg.readUInt16BE(end) === TYPE_A) queries.set(name, (queries.get(name) ?? 0) + 1);
    const reply = answer(msg, addresses, () => {
      const turn = turns.get(name) ?? 0;
      turns.set(name, turn + 1);
      return addresses?.[turn % addresses.length] ?? '0.0.0.0';
    });
    socket.send(reply, peer.port, peer.address);
  });
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return {
    port: socket.address().port,
    queries,
    close: () =>
      new Promise<void>((resolve) =>
        socket.close(() => {
          resolve();
        }),
      ),
  };
}
