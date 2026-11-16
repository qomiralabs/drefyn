import { writeFileSync } from 'node:fs';
import { it } from 'vitest';

it('never gives its thread back', () => {
  writeFileSync(process.env['FIXTURE_READY'] ?? '', 'spinning');
  let turns = 0;
  while (Date.now() > 0) turns += 1;
  return turns;
});
