import { execFile } from 'node:child_process';

export interface Reply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

// curl, because it sends the Host and forwarding headers exactly as given; fetch replaces
// Host with the URL's own.
export function curl(
  port: number,
  path: string,
  headers: readonly string[],
  // Sent as the request line as is, which the URL could not express.
  requestTarget?: string,
  maxSeconds = 10,
): Promise<Reply> {
  const seconds = String(maxSeconds);
  const args = ['--silent', '--show-error', '--http1.1', '--include', '--max-time', seconds];
  args.push('--noproxy', '*');
  for (const header of headers) args.push('--header', header);
  if (requestTarget !== undefined) args.push('--request-target', requestTarget);
  args.push('--path-as-is', `http://127.0.0.1:${String(port)}${path}`);
  return new Promise((done, fail) => {
    execFile('curl', args, { encoding: 'utf8' }, (error, stdout) => {
      if (error !== null) {
        fail(new Error(`curl failed: ${error.message}`, { cause: error }));
        return;
      }
      const split = stdout.indexOf('\r\n\r\n');
      const head = split < 0 ? stdout : stdout.slice(0, split);
      const [statusLine = '', ...lines] = head.split('\r\n');
      const parsed: Record<string, string> = {};
      for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon > 0) parsed[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
      }
      done({
        status: Number(statusLine.split(' ')[1]),
        headers: parsed,
        body: split < 0 ? '' : stdout.slice(split + 4),
      });
    });
  });
}
