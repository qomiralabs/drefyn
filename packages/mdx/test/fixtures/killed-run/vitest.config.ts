import { mergeConfig } from 'vitest/config';
import { sharedConfig } from '../../../../../vitest.shared.ts';

export default mergeConfig(sharedConfig, {
  cacheDir: process.env['FIXTURE_CACHE'] ?? '',
  test: { include: ['run.fixture.ts'] },
});
