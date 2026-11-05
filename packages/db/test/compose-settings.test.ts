import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
// One line, so the check survives however the formatter wraps the list.
const compose = readFileSync(join(repoRoot, 'deploy', 'compose.yaml'), 'utf8').replace(/\s+/g, ' ');

describe('the compose Postgres settings', () => {
  // Filter row lists stay in budget under writes only with room for the covering key in
  // memory and checkpoints far enough apart.
  it.each(['shared_buffers=256MB', 'max_wal_size=2GB'])('sets %s', (setting) => {
    expect(compose).toMatch(new RegExp(`\\[postgres,[^\\]]* -c, ${setting}[,\\]]`));
  });
});
