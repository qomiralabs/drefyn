// Loaded with --import into the dashboard servers that have OAuth clients, before Next.
import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EGRESS_LEDGER_URL, routedFetch } from './oauth-egress.ts';

const ledger = fileURLToPath(EGRESS_LEDGER_URL);
mkdirSync(dirname(ledger), { recursive: true });
rmSync(ledger, { force: true });

// Writable, because Next wraps the global fetch in its turn.
Object.defineProperty(globalThis, 'fetch', {
  value: routedFetch(fetch, (host) => {
    appendFileSync(ledger, `${host}\n`);
  }),
  writable: true,
  configurable: true,
});
