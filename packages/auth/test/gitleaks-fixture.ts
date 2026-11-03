// Writes a freshly generated API key and a printed CLI sign in link into files in the
// directory given, so CI can prove the gitleaks rules catch real ones without one ever
// being committed.
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '@drefyn/db';
import { formatApiKey, formatCliLinkToken } from '../src/tokens.ts';

const dir = process.argv[2];
if (dir === undefined || dir === '') {
  process.stderr.write('usage: gitleaks-fixture.ts <directory>\n');
  process.exit(2);
}
const key = formatApiKey({
  organizationId: newId('org'),
  keyId: newId('key'),
  secret: randomBytes(32),
});
writeFileSync(join(dir, 'config.env'), `DREFYN_API_KEY=${key}\n`);
writeFileSync(
  join(dir, 'terminal.log'),
  `https://app.example.com/sign-in/cli#${formatCliLinkToken(randomBytes(32))}\n`,
);
