// The only file that imports nodemailer. It uses the connection and the MIME composer
// directly rather than createTransport, because only the connection lets us see how far
// a send got and close that one send's socket when the mailer gives up on it.
import { Readable } from 'node:stream';
import MailComposer from 'nodemailer/lib/mail-composer';
import SMTPConnection from 'nodemailer/lib/smtp-connection';
import type {
  Envelope,
  MailTransport,
  RenderedMail,
  Result,
  SmtpConfig,
  TransportError,
  TransportPhase,
  TransportProgress,
} from '../types.ts';
import { abortError, toTransportError } from './errors.ts';
import { connectionOptions } from './options.ts';

type Delivered = Result<{ readonly messageId: string }, TransportError>;
type Socket = Exclude<SMTPConnection['_socket'], false | null>;

// After a sent message the relay gets this long to answer QUIT before the socket is cut.
const QUIT_WAIT_MS = 1000;
const CLOSED: Delivered = { ok: false, error: { code: 'email.connect_failed', phase: 'connect' } };
// Composing runs on input the mailer already checked, so a failure is a bug on our side.
// It is answered like a refusal so that nothing retries it and the relay is not blamed.
const UNCOMPOSABLE: Delivered = { ok: false, error: { code: 'email.rejected', phase: 'envelope' } };

// Addresses go in as name and address pairs, never as joined strings, so the composer
// quotes the display name and never runs its address parser on them.
function compose(envelope: Envelope, mail: RenderedMail): Promise<Buffer> {
  return new MailComposer({
    from: { name: envelope.fromName, address: envelope.from },
    to: { name: '', address: envelope.to },
    ...(envelope.replyTo === undefined ? {} : { replyTo: { name: '', address: envelope.replyTo } }),
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    messageId: envelope.messageId,
    headers: Object.fromEntries(envelope.headers),
    disableFileAccess: true,
    disableUrlAccess: true,
  })
    .compile()
    .build();
}

function whenClosed(socket: Socket, limitMs?: number): Promise<void> {
  if (socket.closed) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = limitMs === undefined ? undefined : setTimeout(resolve, limitMs);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// Resolves only once the socket is gone, so the slot this send holds is never handed
// to another send while the old connection still lives.
async function shut(connection: SMTPConnection | undefined, politely: boolean): Promise<void> {
  if (connection === undefined) return;
  const raw = connection._socket;
  const socket = raw === false || raw === null ? undefined : raw;
  if (politely && socket !== undefined && !socket.destroyed) {
    connection.quit();
    await whenClosed(socket, QUIT_WAIT_MS);
  }
  connection.close();
  if (socket === undefined) return;
  socket.destroy();
  await whenClosed(socket);
}

interface Run {
  readonly done: Promise<Delivered>;
  abort(): void;
}

function run(
  config: SmtpConfig,
  envelope: Envelope,
  mail: RenderedMail,
  signal: AbortSignal,
  progress: TransportProgress | undefined,
): Run {
  let reached: TransportPhase = 'connect';
  let connection: SMTPConnection | undefined;
  let finished = false;
  let settle: (result: Delivered) => void = () => undefined;
  const done = new Promise<Delivered>((resolve) => {
    settle = resolve;
  });

  const step = (phase: TransportPhase) => {
    reached = phase;
    try {
      progress?.(phase);
    } catch {
      // The mailer's callback never throws; a hosted caller's must not stop the send.
    }
  };
  const failed = (error: unknown): Delivered => ({
    ok: false,
    error: toTransportError(error, reached),
  });
  const finish = (result: Delivered, politely = false) => {
    if (finished) return;
    finished = true;
    signal.removeEventListener('abort', abort);
    const answer = () => {
      settle(result);
    };
    shut(connection, politely).then(answer, answer);
  };
  function abort() {
    finish({ ok: false, error: abortError(reached) });
  }
  signal.addEventListener('abort', abort, { once: true });

  const send = (open: SMTPConnection, message: Buffer) => {
    step('envelope');
    let read = false;
    // The relay reads this only after it said yes to DATA, so the first read marks the
    // data phase and the end marks the final dot going out.
    const source = new Readable({
      read() {
        if (read) return;
        read = true;
        step('data');
        this.push(message);
        this.push(null);
      },
    });
    source.once('end', () => {
      step('after_data');
    });
    open.send({ from: envelope.from, to: [envelope.to] }, source, (error) => {
      if (error) {
        finish(failed(error));
        return;
      }
      finish({ ok: true, value: { messageId: envelope.messageId } }, true);
    });
  };

  compose(envelope, mail).then(
    (message) => {
      if (finished) return;
      const open = new SMTPConnection(connectionOptions(config));
      connection = open;
      // Nodemailer emits every session failure here before it closes the connection.
      open.on('error', (error: unknown) => {
        finish(failed(error));
      });
      step('connect');
      open.connect((error) => {
        if (finished) return;
        if (error) {
          finish(failed(error));
          return;
        }
        const auth = config.auth;
        if (auth === undefined) {
          send(open, message);
          return;
        }
        step('auth');
        open.login({ user: auth.user, pass: auth.password.reveal() }, (loginError) => {
          if (finished) return;
          if (loginError) {
            finish(failed(loginError));
            return;
          }
          send(open, message);
        });
      });
    },
    () => {
      finish(UNCOMPOSABLE);
    },
  );

  return { done, abort };
}

// One transport per process, built once from config. Every send opens its own
// connection and closes it, so one stuck relay session never holds up another.
export function createSmtpTransport(config: SmtpConfig): MailTransport {
  const live = new Set<Run>();
  let closed = false;
  return {
    kind: 'smtp',
    deliver(envelope, mail, signal, progress) {
      if (closed) return Promise.resolve(CLOSED);
      if (signal.aborted) return Promise.resolve({ ok: false, error: abortError('connect') });
      const current = run(config, envelope, mail, signal, progress);
      live.add(current);
      return current.done.finally(() => live.delete(current));
    },
    async close() {
      closed = true;
      const runs = [...live];
      for (const current of runs) current.abort();
      await Promise.all(runs.map((current) => current.done));
    },
  };
}
