// Times the wrapper's own work per request, the step between the socket and Next: Host
// check, address resolution and header rewrite. Next itself is a no op here. Budget: p99
// under 0.2 ms. Run with `pnpm --filter @drefyn/dashboard bench:wrapper`.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseWrapperConfig } from '../src/server/client-ip.ts';
import { createWrapper } from '../src/server/wrapper.ts';

const SAMPLES = 200_000;
const WARMUP = 20_000;
const BUDGET_MS = 0.2;

const config = parseWrapperConfig({
  DREFYN_APP_ORIGIN: 'https://app.drefyn.test',
  DREFYN_TRUSTED_PROXY_HOPS: '1',
});
const serve = createWrapper({ config, handle: () => undefined, warn: () => undefined });
const res = { statusCode: 200, setHeader: () => undefined, end: () => undefined };

// A browser sized header set with a spoofed prefix, rebuilt each time because the wrapper
// rewrites it in place.
const request = () =>
  ({
    url: '/acme/docs/handbook?tab=pages',
    method: 'GET',
    socket: { remoteAddress: '10.0.0.2' },
    headers: {
      host: 'app.drefyn.test',
      'x-forwarded-for': '6.6.6.6, 198.51.100.7',
      'x-forwarded-proto': 'http',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Bench/1.0',
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'en-GB,en;q=0.9',
      cookie: '__Host-drefyn_session=v1.x',
    },
  }) as unknown as IncomingMessage;

const times = new Float64Array(SAMPLES);
for (let i = 0; i < WARMUP + SAMPLES; i += 1) {
  const req = request();
  const start = process.hrtime.bigint();
  serve(req, res as unknown as ServerResponse);
  const took = Number(process.hrtime.bigint() - start) / 1e6;
  if (i >= WARMUP) times[i - WARMUP] = took;
}
times.sort();
const at = (q: number) => times[Math.min(SAMPLES - 1, Math.floor(q * SAMPLES))] ?? 0;
const line = (label: string, ms: number) => `${label} ${ms.toFixed(4)} ms`;
process.stdout.write(
  `${[`wrapper step, ${String(SAMPLES)} samples, Node ${process.version}`, line('p50', at(0.5)), line('p99', at(0.99)), line('max', at(1 - 1e-9))].join('\n')}\n`,
);
if (at(0.99) >= BUDGET_MS) {
  process.stdout.write(`p99 is over the ${String(BUDGET_MS)} ms budget\n`);
  process.exitCode = 1;
}
