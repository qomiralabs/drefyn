import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WrapperConfig } from '../../../src/server/client-ip.ts';
import { createWrapper } from '../../../src/server/wrapper.ts';

export interface Echo {
  readonly port: number;
  // The headers each request had when it reached the handler standing in for Next.
  readonly seen: IncomingHttpHeaders[];
  readonly warnings: string[];
  close(): Promise<void>;
}

// The real wrapper on a loopback socket, with a handler in Next's place that answers with
// the headers it was given, so a test sees exactly what Next would see.
export async function startEcho(config: WrapperConfig): Promise<Echo> {
  const seen: IncomingHttpHeaders[] = [];
  const warnings: string[] = [];
  const server = createServer(
    createWrapper({
      config,
      warn: (event) => warnings.push(event),
      handle(req, res) {
        seen.push({ ...req.headers });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(req.headers));
      },
    }),
  );
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    seen,
    warnings,
    close: () =>
      new Promise((done, fail) => {
        server.close((error) => {
          if (error === undefined) done();
          else fail(error);
        });
      }),
  };
}
