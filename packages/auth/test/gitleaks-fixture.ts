// Writes a freshly generated API key into a file in the directory given, so CI can prove the
// gitleaks rule catches a real key without one ever being committed.
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '@drefyn/db';
import { formatApiKey } from '../src/tokens.ts';

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
