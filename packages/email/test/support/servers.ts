// Loopback servers and the Mailpit inbox reader for the SMTP tests. The only file in this
// package that opens sockets itself; src never imports it.
import net from 'node:net';
import tls from 'node:tls';

const HOST = '127.0.0.1';

export interface ServerRecord {
  readonly port: number;
  // Every connection the server accepted, in order.
  readonly connections: number;
  // Connections not yet closed from the server's side of view.
  readonly open: number;
  // Commands as received, one array per connection. AUTH lines are kept, so a test can
  // check which password arrived; the tests make sure it never leaves the test.
  readonly commands: readonly (readonly string[])[];
  // The message data per connection that reached the final dot.
  readonly messages: readonly string[];
  // When each connection opened and closed, by Date.now().
  readonly openedAt: readonly number[];
  readonly closedAt: readonly number[];
  close(): Promise<void>;
}

// What the server answers to one command line. A string is written with CRLF; `stall`
// writes nothing and leaves the connection open; `drop` closes it.
export type Reply = string;
export interface Script {
  greeting?: (connection: number) => Reply;
  reply?: (command: string, connection: number) => Reply | undefined;
  // What the server answers to the final dot.
  afterData?: (connection: number) => Reply;
}

// The tests put this in every reply, so a capture can prove no reply text leaked.
export const REPLY_SENTINEL = 'relay-said-zq9x';

function defaultReply(command: string): Reply {
  const verb = command.split(' ', 1)[0]?.toUpperCase() ?? '';
  switch (verb) {
    case 'EHLO':
      return `250-loopback ${REPLY_SENTINEL}\r\n250-AUTH PLAIN\r\n250 8BITMIME`;
    case 'HELO':
      return '250 loopback';
    case 'AUTH':
      return `235 2.7.0 ok ${REPLY_SENTINEL}`;
    case 'MAIL':
    case 'RCPT':
    case 'RSET':
      return `250 2.1.0 ok ${REPLY_SENTINEL}`;
    case 'DATA':
      return `354 go ahead ${REPLY_SENTINEL}`;
    case 'QUIT':
      return `221 2.0.0 bye ${REPLY_SENTINEL}`;
    default:
      return `502 5.5.2 not here ${REPLY_SENTINEL}`;
  }
}

function send(socket: net.Socket, reply: Reply): void {
  if (reply === 'stall') return;
  if (reply === 'drop') {
    socket.destroy();
    return;
  }
  socket.write(`${reply}\r\n`);
  if (reply.startsWith('221 ')) socket.end();
}

// A scripted SMTP server on loopback. With no script it accepts any mail.
export async function smtpServer(
  script: Script = {},
  secure?: { readonly cert: string; readonly key: string },
): Promise<ServerRecord> {
  let connections = 0;
  const sockets = new Set<net.Socket>();
  const commands: string[][] = [];
  const messages: string[] = [];
  const openedAt: number[] = [];
  const closedAt: number[] = [];

  // Counted on the raw TCP socket, so a TLS handshake that fails still counts.
  const onTcp = (raw: net.Socket) => {
    connections += 1;
    openedAt.push(Date.now());
    sockets.add(raw);
    raw.on('error', () => undefined);
    raw.on('close', () => {
      sockets.delete(raw);
      closedAt.push(Date.now());
    });
  };

  const onConnection = (socket: net.Socket) => {
    const index = commands.length;
    const lines: string[] = [];
    commands.push(lines);
    socket.on('error', () => undefined);
    send(socket, script.greeting?.(index) ?? `220 loopback ESMTP ${REPLY_SENTINEL}`);
    let buffer = '';
    let data: string | null = null;
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('latin1');
      for (let at = buffer.indexOf('\r\n'); at >= 0; at = buffer.indexOf('\r\n')) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (data !== null) {
          if (line === '.') {
            messages.push(data);
            data = null;
            send(socket, script.afterData?.(index) ?? `250 2.0.0 queued ${REPLY_SENTINEL}`);
          } else {
            data += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
          }
          continue;
        }
        lines.push(line);
        const reply = script.reply?.(line, index) ?? defaultReply(line);
        if (/^DATA$/i.test(line) && reply.startsWith('354')) data = '';
        send(socket, reply);
      }
    });
  };

  const server = secure
    ? tls.createServer({ cert: secure.cert, key: secure.key }, onConnection)
    : net.createServer(onConnection);
  server.on('connection', onTcp);
  server.on('tlsClientError', () => undefined);
  await new Promise<void>((resolve) => server.listen(0, HOST, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');

  return {
    port: address.port,
    get connections() {
      return connections;
    },
    get open() {
      return sockets.size;
    },
    commands,
    messages,
    openedAt,
    closedAt,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}

// Accepts the connection and never says a word.
export function stallingServer(): Promise<ServerRecord> {
  return smtpServer({ greeting: () => 'stall' });
}

// A port nothing listens on: bound once, then closed again.
export async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, HOST, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

export interface MailpitMessage {
  readonly ID: string;
  readonly MessageID: string;
  readonly Subject: string;
  readonly From: { readonly Name: string; readonly Address: string };
  readonly To: readonly { readonly Name: string; readonly Address: string }[];
  readonly ReplyTo: readonly { readonly Name: string; readonly Address: string }[];
  readonly HTML: string;
  readonly Text: string;
}

// Reads one Mailpit instance's inbox over its API on loopback.
export function mailpit(apiPort: number) {
  const base = `http://${HOST}:${String(apiPort)}/api/v1`;
  const call = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`mailpit ${path}: HTTP ${String(response.status)}`);
    // DELETE answers with the bare word ok rather than JSON.
    const text = await response.text();
    return response.headers.get('content-type')?.includes('json') === true
      ? (JSON.parse(text) as unknown)
      : text;
  };
  return {
    async clear(): Promise<void> {
      await call('/messages', { method: 'DELETE' });
    },
    async count(): Promise<number> {
      const list = (await call('/messages?limit=1')) as { messages_count: number };
      return list.messages_count;
    },
    // Message-ID as Mailpit stores it, without the angle brackets.
    async byMessageId(messageId: string): Promise<MailpitMessage[]> {
      const id = messageId.replace(/^<|>$/g, '');
      const found = (await call(`/search?query=${encodeURIComponent(`message-id:"${id}"`)}`)) as {
        messages: { ID: string }[];
      };
      return Promise.all(
        found.messages.map(async (m) => (await call(`/message/${m.ID}`)) as MailpitMessage),
      );
    },
    async headers(id: string): Promise<Readonly<Record<string, readonly string[]>>> {
      return (await call(`/message/${id}/headers`)) as Record<string, string[]>;
    },
    async raw(id: string): Promise<string> {
      const response = await fetch(`${base}/message/${id}/raw`, {
        signal: AbortSignal.timeout(5000),
      });
      return response.text();
    },
  };
}
