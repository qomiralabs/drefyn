// Runs in the Playwright container after the tests. The hosts file is what stops a real
// provider even if everything else here is wrong; the ledger is what a server tried anyway.
import { existsSync, readFileSync } from 'node:fs';
import { EGRESS_LEDGER_URL, egressProblems, PROVIDER_COUNT } from './oauth-egress.ts';

const ledger = existsSync(EGRESS_LEDGER_URL) ? readFileSync(EGRESS_LEDGER_URL, 'utf8') : '';
const problems = egressProblems(readFileSync('/etc/hosts', 'utf8'), ledger);
for (const problem of problems) console.error(`egress check: ${problem}`);
if (problems.length > 0) process.exit(1);
console.log(`egress check: ${String(PROVIDER_COUNT)} provider hosts blocked, no strays`);
